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
import { NAME, VERSION } from './version.js';
import {
  asObject, requireBoolean, requireFiniteNumber, requireLoopMode, requireSnowflake,
  requireString, sanitizePlayerPatch, sanitizeTrack, sanitizeTrackList
} from './validation.js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'access-control-max-age': '600'
} as const;

function json(reply: ServerResponse, status: number, body: unknown): void {
  if (reply.writableEnded) return;
  const payload = JSON.stringify(body);
  reply.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...CORS_HEADERS
  });
  reply.end(payload);
}

function noContent(reply: ServerResponse): void {
  // 204 não pode ter corpo nem content-length (RFC 9110).
  reply.writeHead(204, CORS_HEADERS);
  reply.end();
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new LavaLensError('BODY_TOO_LARGE', 'Corpo da requisição muito grande.', 413);
    chunks.push(chunk as Buffer);
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
    this.server.headersTimeout = 20_000;
    this.server.requestTimeout = 60_000;
  }

  authorized(req: IncomingMessage, url: URL): boolean {
    return isAuthorized(this.config.token, extractBearer(req.headers.authorization) ?? url.searchParams.get('token'));
  }

  private guildFrom(match: RegExpExecArray): string {
    return requireSnowflake(decodeURIComponent(match[1]!), 'guildId');
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
    catch { return json(res, 400, { code: 'INVALID_URL', message: 'URL inválida.' }); }

    if (req.method === 'OPTIONS') return noContent(res);
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, name: NAME, version: VERSION });
    }
    if (!this.authorized(req, url)) {
      return json(res, 401, { code: 'UNAUTHORIZED', messageKey: 'errors.unauthorized', message: 'Bearer token inválido.' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') {
        return json(res, 200, {
          node: this.metrics.snapshot(this.config.nodeId, this.voice.activeSessions(), this.store.totalCount()),
          providers: this.providers.providers.map((p) => p.name),
          events: { subscribers: this.events.subscriberCount, sse: this.#sseClients.size, websocket: this.ws.size }
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/guilds') return json(res, 200, { data: this.store.list() });
      if (req.method === 'GET' && url.pathname === '/v1/events') return this.sse(req, res, url);

      const playerMatch = /^\/v1\/guilds\/([^/]+)\/player$/.exec(url.pathname);
      if (playerMatch) {
        const guildId = this.guildFrom(playerMatch);
        if (req.method === 'GET') return json(res, 200, this.store.require(guildId));
        if (req.method === 'PUT') {
          const patch = sanitizePlayerPatch(await readBody(req, this.config.maxBodyBytes));
          return json(res, 200, this.store.update(guildId, patch));
        }
        if (req.method === 'DELETE') {
          this.voice.disconnect(guildId);
          return json(res, 200, { destroyed: this.store.destroy(guildId) });
        }
        throw new LavaLensError('METHOD_NOT_ALLOWED', `Método ${req.method} não permitido.`, 405);
      }

      const loadMatch = /^\/v1\/guilds\/([^/]+)\/load$/.exec(url.pathname);
      if (loadMatch) {
        if (req.method !== 'POST') throw new LavaLensError('METHOD_NOT_ALLOWED', `Método ${req.method} não permitido.`, 405);
        this.guildFrom(loadMatch);
        const body = asObject(await readBody(req, this.config.maxBodyBytes));
        const query = requireString(body.query, 'query');
        const requestedBy = typeof body.requestedBy === 'string' ? body.requestedBy : undefined;
        return json(res, 200, await this.providers.resolve(query, requestedBy));
      }

      const queueMatch = /^\/v1\/guilds\/([^/]+)\/queue$/.exec(url.pathname);
      if (queueMatch) {
        const guildId = this.guildFrom(queueMatch);
        if (req.method === 'GET') return json(res, 200, this.store.require(guildId).queue);
        if (req.method === 'POST') {
          const body = asObject(await readBody(req, this.config.maxBodyBytes));
          return json(res, 200, this.store.enqueue(guildId, sanitizeTrackList(body.tracks)));
        }
        if (req.method === 'DELETE') {
          const state = this.store.require(guildId);
          return json(res, 200, this.store.update(guildId, { queue: { ...state.queue, tracks: [] } }, 'QueueChanged'));
        }
        throw new LavaLensError('METHOD_NOT_ALLOWED', `Método ${req.method} não permitido.`, 405);
      }

      const playMatch = /^\/v1\/guilds\/([^/]+)\/play$/.exec(url.pathname);
      if (req.method === 'POST' && playMatch) {
        const guildId = this.guildFrom(playMatch);
        const body = asObject(await readBody(req, this.config.maxBodyBytes));
        let track = body.track ? sanitizeTrack(body.track) : undefined;
        if (!track) {
          const query = requireString(body.query, 'query ou track');
          const requestedBy = typeof body.requestedBy === 'string' ? body.requestedBy : undefined;
          const result = await this.providers.resolve(query, requestedBy);
          track = result.tracks[0];
          if (!track) throw new LavaLensError('NO_MATCHES', 'Nenhum resultado para a consulta.', 404);
          if (result.tracks.length > 1) this.store.enqueue(guildId, result.tracks.slice(1));
          if (result.playlist) this.store.update(guildId, { playlist: result.playlist });
        }
        const positionMs = body.positionMs === undefined ? 0 : requireFiniteNumber(body.positionMs, 'positionMs', 0, Number.MAX_SAFE_INTEGER);
        await this.voice.play(guildId, track, positionMs);
        return json(res, 202, this.store.require(guildId));
      }

      const connectMatch = /^\/v1\/guilds\/([^/]+)\/voice\/connect$/.exec(url.pathname);
      if (req.method === 'POST' && connectMatch) {
        const guildId = this.guildFrom(connectMatch);
        const body = asObject(await readBody(req, this.config.maxBodyBytes));
        const channelId = requireSnowflake(requireString(body.channelId, 'channelId'), 'channelId');
        const shardId = body.shardId === undefined ? 0 : requireFiniteNumber(body.shardId, 'shardId', 0, 65535);
        await this.voice.connect(guildId, channelId, shardId, body.selfDeaf !== false);
        return json(res, 202, { accepted: true });
      }

      const updateMatch = /^\/v1\/guilds\/([^/]+)\/voice\/update$/.exec(url.pathname);
      if (req.method === 'POST' && updateMatch) {
        const guildId = this.guildFrom(updateMatch);
        const body = asObject(await readBody(req, this.config.maxBodyBytes));
        if (body.type !== 'server' && body.type !== 'state') {
          throw new LavaLensError('VOICE_UPDATE_TYPE', 'type deve ser server ou state.', 400);
        }
        this.voice.ingestUpdate(guildId, body.type, asObject(body.payload, 'payload'));
        return json(res, 202, { accepted: true });
      }

      const commandMatch = /^\/v1\/guilds\/([^/]+)\/commands$/.exec(url.pathname);
      if (req.method === 'POST' && commandMatch) {
        const guildId = this.guildFrom(commandMatch);
        const body = asObject(await readBody(req, this.config.maxBodyBytes));
        const name = requireString(body.name, 'name', 60);
        const args = body.args === undefined ? {} : asObject(body.args, 'args');

        switch (name) {
          case 'pause': this.voice.pause(guildId); break;
          case 'resume': this.voice.resume(guildId); break;
          case 'stop': this.voice.stop(guildId); break;
          case 'skip': this.voice.stop(guildId, true); break;
          case 'seek': await this.voice.seek(guildId, requireFiniteNumber(args.positionMs, 'positionMs', 0, Number.MAX_SAFE_INTEGER)); break;
          case 'disconnect': this.voice.disconnect(guildId); break;
          case 'setVolume':
            await this.voice.setVolume(guildId, requireFiniteNumber(args.volume, 'volume', 0, 200));
            break;
          case 'setRepeat': {
            const state = this.store.get(guildId, true)!;
            this.store.update(guildId, { queue: { ...state.queue, loopMode: requireLoopMode(args.mode) } }, 'QueueChanged');
            break;
          }
          case 'setAutoplay': {
            const state = this.store.get(guildId, true)!;
            this.store.update(guildId, { queue: { ...state.queue, autoplay: requireBoolean(args.enabled, 'enabled') } }, 'QueueChanged');
            break;
          }
          default:
            throw new LavaLensError('UNKNOWN_COMMAND', `Comando desconhecido: ${name}`, 400);
        }
        this.events.emit('CommandExecuted', { name, args }, guildId);
        return json(res, 200, this.store.get(guildId, true));
      }

      throw new LavaLensError('NOT_FOUND', 'Endpoint não encontrado.', 404);
    } catch (error) {
      const mapped = errorBody(error);
      json(res, mapped.status, mapped.body);
    }
  }

  sse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no', ...CORS_HEADERS
    });
    res.flushHeaders?.();
    // Sem timeout de socket: streams de eventos são longos por natureza.
    res.socket?.setTimeout(0);
    res.socket?.setNoDelay(true);
    res.socket?.setKeepAlive(true);
    this.#sseClients.add(res);

    const parsedAfter = Number.parseInt(url.searchParams.get('after') ?? '', 10);
    const after = Number.isFinite(parsedAfter) && parsedAfter > 0 ? parsedAfter : 0;

    const write = (payload: string) => {
      // Cliente lento não pode consumir memória infinita do nó.
      if (res.writableEnded) return;
      if (res.writableLength > 4_000_000) { cleanup(); res.destroy(); return; }
      res.write(payload);
    };

    for (const event of this.events.history(after)) {
      write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    const unsubscribe = this.events.subscribe((event) => {
      write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), 20_000);
    heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.#sseClients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('error', cleanup);
  }

  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`); }
    catch { socket.destroy(); return; }
    if (url.pathname !== '/v1/ws' || !this.authorized(req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.ws.upgrade(req, socket, head);
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.ws.close();
    for (const client of this.#sseClients) client.destroy();
    this.#sseClients.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
