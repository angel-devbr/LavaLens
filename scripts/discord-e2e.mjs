#!/usr/bin/env node
/**
 * Teste E2E real sem gravar o token em disco.
 *
 * Variáveis obrigatórias:
 * DISCORD_TOKEN, DISCORD_GUILD_ID, DISCORD_VOICE_CHANNEL_ID, LAVALENS_TOKEN
 * Opcionais: LAVALENS_URL, TEST_QUERY, E2E_TIMEOUT_MS
 */
const required = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_VOICE_CHANNEL_ID', 'LAVALENS_TOKEN'];
for (const key of required) if (!process.env[key]) throw new Error(`Variável obrigatória ausente: ${key}`);

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;
const lavaToken = process.env.LAVALENS_TOKEN;
const lavaUrl = process.env.LAVALENS_URL ?? 'http://127.0.0.1:8080';
const testQuery = process.env.TEST_QUERY;
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 60_000);
const abort = new AbortController();
let gateway;
let heartbeat;
let sequence = null;
let ready = false;
let completed = false;

const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function lava(path, init = {}) {
  const response = await fetch(new URL(path, lavaUrl), {
    ...init,
    headers: { authorization: `Bearer ${lavaToken}`, 'content-type': 'application/json', ...init.headers }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw Object.assign(new Error(body?.message ?? `LavaLens HTTP ${response.status}`), { status: response.status, body });
  return body;
}

async function discord(path) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { authorization: `Bot ${token}`, 'user-agent': 'LavaLens-Native-E2E/0.1' }
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status} em ${path}`);
  return response.json();
}

function send(payload) {
  if (gateway?.readyState !== WebSocket.OPEN) return false;
  gateway.send(JSON.stringify(payload));
  return true;
}

async function forward(type, payload) {
  await lava(`/v1/guilds/${guildId}/voice/update`, {
    method: 'POST', body: JSON.stringify({ type, payload })
  });
}

async function onLavaEvent(event) {
  if (event.guildId && event.guildId !== guildId) return;
  if (event.type === 'DiscordGatewayPayload' && ready) send(event.data?.payload);
  if (event.type === 'VoiceConnected') {
    log('voice-connected');
    if (testQuery) {
      await lava(`/v1/guilds/${guildId}/play`, { method: 'POST', body: JSON.stringify({ query: testQuery }) });
    } else completed = true;
  }
  if (event.type === 'TrackStarted') {
    const state = await lava(`/v1/guilds/${guildId}/player`);
    log('track-started', {
      title: state.track?.title,
      source: state.track?.source,
      directPassthrough: state.audio?.directPassthrough,
      transcoding: state.audio?.transcoding,
      dave: state.voice?.daveProtocolVersion,
      encryption: state.voice?.transportEncryption
    });
    completed = true;
  }
  if (event.type === 'TrackFailed') {
    throw new Error(event.data?.state?.error?.message ?? 'TrackFailed');
  }
}

async function consumeSse() {
  const response = await fetch(new URL('/v1/events', lavaUrl), {
    headers: { authorization: `Bearer ${lavaToken}` }, signal: abort.signal
  });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const line = block.split(/\r?\n/).find((item) => item.startsWith('data:'));
      if (line) await onLavaEvent(JSON.parse(line.slice(5).trim()));
    }
  }
}

async function connectGateway() {
  await new Promise((resolve, reject) => {
    gateway = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    gateway.addEventListener('error', () => reject(new Error('Falha ao abrir o Discord Gateway.')));
    gateway.addEventListener('close', (event) => {
      clearInterval(heartbeat);
      if (!completed) reject(new Error(`Gateway fechou: ${event.code}`));
    });
    gateway.addEventListener('message', async ({ data }) => {
      try {
        const packet = JSON.parse(String(data));
        if (packet.s != null) sequence = packet.s;
        if (packet.op === 10) {
          heartbeat = setInterval(() => send({ op: 1, d: sequence }), packet.d.heartbeat_interval);
          heartbeat.unref?.();
          // GUILDS (1<<0) + GUILD_VOICE_STATES (1<<7). Sem o segundo bit o Discord
          // não envia VOICE_STATE_UPDATE do próprio bot e o handshake de voz nunca
          // completa — o teste expira sem nunca chegar em VoiceConnected.
          const intents = (1 << 0) | (1 << 7);
          send({ op: 2, d: { token, intents, properties: { os: process.platform, browser: 'lavalens-native', device: 'lavalens-native' } } });
          return;
        }
        if (packet.op !== 0) return;
        if (packet.t === 'READY') {
          ready = true;
          log('gateway-ready', { botId: packet.d.user?.id, username: packet.d.user?.username });
          await lava(`/v1/guilds/${guildId}/voice/connect`, {
            method: 'POST', body: JSON.stringify({ channelId, shardId: 0, selfDeaf: true })
          });
          resolve();
        } else if (packet.t === 'VOICE_SERVER_UPDATE' && packet.d.guild_id === guildId) {
          await forward('server', packet.d);
        } else if (packet.t === 'VOICE_STATE_UPDATE' && packet.d.guild_id === guildId) {
          await forward('state', packet.d);
        }
      } catch (error) { reject(error); }
    });
  });
}

async function cleanup() {
  clearInterval(heartbeat); abort.abort();
  try { await lava(`/v1/guilds/${guildId}/commands`, { method: 'POST', body: JSON.stringify({ name: 'disconnect' }) }); } catch {}
  try { gateway?.close(1000, 'test complete'); } catch {}
}

try {
  const me = await discord('/users/@me');
  const guild = await discord(`/guilds/${guildId}`);
  const channel = await discord(`/channels/${channelId}`);
  if (channel.guild_id !== guildId) throw new Error('O canal não pertence ao servidor informado.');
  log('preflight-ok', { bot: `${me.username}#${me.discriminator}`, guild: guild.name, channel: channel.name });
  const sse = consumeSse().catch((error) => { if (error.name !== 'AbortError') throw error; });
  await connectGateway();
  const deadline = Date.now() + timeoutMs;
  while (!completed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!completed) throw new Error(`Teste expirou após ${timeoutMs}ms.`);
  const state = await lava(`/v1/guilds/${guildId}/player`);
  log('e2e-ok', { status: state.status, positionMs: state.positionMs, voice: state.voice });
  await cleanup(); await sse;
} catch (error) {
  log('e2e-failed', { message: error.message, status: error.status });
  await cleanup(); process.exitCode = 1;
}
