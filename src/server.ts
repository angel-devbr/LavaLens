import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Config } from './config.js';
import { extractBearer, isAuthorized } from './auth.js';
import { errorBody, LavaLensError } from './errors.js';
import type { EventBus } from './event-bus.js';
import type { Metrics } from './metrics.js';
import type { PlayerStore } from './player-store.js';
import type { ProviderRegistry } from './providers/registry.js';
import type { VoiceManager } from './discord/voice.js';
import { WebSocketHub } from './websocket.js';

function json(reply: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  reply.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS'
  });
  reply.end(payload);
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<any> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new LavaLensError('BODY_TOO_LARGE', 'Corpo da requisição muito grande.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LavaLensError('INVALID_JSON', 'JSON inválido.', 400); }
}

export class ApiServer {
  readonly server;
  readonly ws;
  #sseClients = new Set<ServerResponse>();
  constructor(
    private readonly config: Config,
    private readonly store: PlayerStore,
    private readonly providers: ProviderRegistry,
    private readonly voice: VoiceManager,
    private readonly events: EventBus,
    private readonly metrics: Metrics
  ) {
    this.ws = new WebSocketHub(events);
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Socket, head));
  }

  authorized(req: IncomingMessage, url: URL): boolean {
    return isAuthorized(this.config.token, extractBearer(req.headers.authorization) ?? url.searchParams.get('token'));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (url.pathname === '/health') return json(res, 200, { ok: true, name: 'LavaLens Native', version: '0.1.0-alpha.2' });
    if (!this.authorized(req, url)) return json(res, 401, { code: 'UNAUTHORIZED', message: 'Bearer token inválido.' });

    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        return json(res, 200, {
          node: this.metrics.snapshot(this.config.nodeId, this.store.activeCount(), this.store.totalCount()),
          providers: this.providers.providers.map((p) => p.name),
          events: { subscribers: this.events.subscriberCount }
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/guilds') {
        this.voice.syncAllPositions();
        return json(res, 200, { data: this.store.list() });
      }
      if (req.method === 'GET' && url.pathname === '/v1/events') return this.sse(req, res, url);

      const playerMatch = /^\/v1\/guilds\/([^/]+)\/player$/.exec(url.pathname);
      if (playerMatch) {
        const guildId = playerMatch[1]!;
        if (req.method === 'GET') {
          this.voice.syncPosition(guildId);
          return json(res, 200, this.store.require(guildId));
        }
        if (req.method === 'PUT') return json(res, 200, this.store.update(guildId, await readBody(req, this.config.maxBodyBytes)));
        if (req.method === 'DELETE') { this.voice.disconnect(guildId); return json(res, 200, { destroyed: this.store.destroy(guildId) }); }
      }

      const loadMatch = /^\/v1\/guilds\/([^/]+)\/load$/.exec(url.pathname);
      if (req.method === 'POST' && loadMatch) {
        const body = await readBody(req, this.config.maxBodyBytes);
        if (typeof body.query !== 'string' || !body.query.trim()) throw new LavaLensError('QUERY_REQUIRED', 'query é obrigatório.');
        const result = await this.providers.resolve(body.query.trim(), body.requestedBy);
        return json(res, 200, result);
      }

      const queueMatch = /^\/v1\/guilds\/([^/]+)\/queue$/.exec(url.pathname);
      if (req.method === 'POST' && queueMatch) {
        const body = await readBody(req, this.config.maxBodyBytes);
        if (!Array.isArray(body.tracks)) throw new LavaLensError('TRACKS_REQUIRED', 'tracks deve ser um array.');
        return json(res, 200, this.store.enqueue(queueMatch[1]!, body.tracks));
      }

      const playMatch = /^\/v1\/guilds\/([^/]+)\/play$/.exec(url.pathname);
      if (req.method === 'POST' && playMatch) {
        const guildId = playMatch[1]!; const body = await readBody(req, this.config.maxBodyBytes);
        let track = body.track;
        if (!track && typeof body.query === 'string') {
          const result = await this.providers.resolve(body.query, body.requestedBy);
          track = result.tracks[0];
          if (result.tracks.length > 1) this.store.enqueue(guildId, result.tracks.slice(1));
          if (result.playlist) this.store.update(guildId, { playlist: result.playlist });
        }
        if (!track) throw new LavaLensError('TRACK_REQUIRED', 'Forneça track ou query.');
        await this.voice.play(guildId, track, Number(body.positionMs ?? 0));
        return json(res, 202, this.store.require(guildId));
      }

      const connectMatch = /^\/v1\/guilds\/([^/]+)\/voice\/connect$/.exec(url.pathname);
      if (req.method === 'POST' && connectMatch) {
        const body = await readBody(req, this.config.maxBodyBytes);
        if (typeof body.channelId !== 'string') throw new LavaLensError('CHANNEL_REQUIRED', 'channelId é obrigatório.');
        await this.voice.connect(connectMatch[1]!, body.channelId, Number(body.shardId ?? 0), body.selfDeaf !== false);
        return json(res, 202, { accepted: true });
      }

      const updateMatch = /^\/v1\/guilds\/([^/]+)\/voice\/update$/.exec(url.pathname);
      if (req.method === 'POST' && updateMatch) {
        const body = await readBody(req, this.config.maxBodyBytes);
        if (!['server', 'state'].includes(body.type)) throw new LavaLensError('VOICE_UPDATE_TYPE', 'type deve ser server ou state.');
        this.voice.ingestUpdate(updateMatch[1]!, body.type, body.payload);
        return json(res, 202, { accepted: true });
      }

      const commandMatch = /^\/v1\/guilds\/([^/]+)\/commands$/.exec(url.pathname);
      if (req.method === 'POST' && commandMatch) {
        const guildId = commandMatch[1]!; const body = await readBody(req, this.config.maxBodyBytes);
        const name = body.name; const args = body.args ?? {};
        if (name === 'pause') this.voice.pause(guildId);
        else if (name === 'resume') this.voice.resume(guildId);
        else if (name === 'stop') this.voice.stop(guildId);
        else if (name === 'seek') await this.voice.seek(guildId, Number(args.positionMs));
        else if (name === 'disconnect') this.voice.disconnect(guildId);
        else if (name === 'setVolume') this.voice.setVolume(guildId, Number(args.volume));
        else if (name === 'setRepeat') {
          if (!['off', 'track', 'queue'].includes(String(args.mode))) {
            throw new LavaLensError('INVALID_REPEAT_MODE', 'mode deve ser off, track ou queue.', 400);
          }
          this.store.update(guildId, {
            queue: { ...this.store.require(guildId).queue, loopMode: args.mode }
          }, 'QueueChanged');
        }
        else if (name === 'setAutoplay') {
          if (typeof args.enabled !== 'boolean') {
            throw new LavaLensError('INVALID_AUTOPLAY', 'enabled deve ser boolean.', 400);
          }
          this.store.update(guildId, {
            queue: { ...this.store.require(guildId).queue, autoplay: args.enabled }
          }, 'QueueChanged');
        }
        else throw new LavaLensError('UNKNOWN_COMMAND', `Comando desconhecido: ${name}`);
        this.events.emit('CommandExecuted', { name, args }, guildId);
        return json(res, 200, this.store.get(guildId, true));
      }

      throw new LavaLensError('NOT_FOUND', 'Endpoint não encontrado.', 404);
    } catch (error) {
      const mapped = errorBody(error); json(res, mapped.status, mapped.body);
    }
  }

  sse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': '*'
    });
    const after = Number(url.searchParams.get('after') ?? 0);
    for (const event of this.events.history(after)) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    this.#sseClients.add(res);
    const unsubscribe = this.events.subscribe((event) => {
      if (!res.destroyed && !res.writableEnded) res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
    }, 20_000);
    heartbeat.unref();
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.#sseClients.delete(res);
    });
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/v1/ws' || !this.authorized(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    this.ws.upgrade(req, socket, head);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => resolve());
    });
  }
  async close(): Promise<void> {
    this.ws.close();
    for (const client of this.#sseClients) client.end();
    this.#sseClients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
