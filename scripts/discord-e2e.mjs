#!/usr/bin/env node

const required = ['DISCORD_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_VOICE_CHANNEL_ID', 'LAVALENS_TOKEN'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Variável obrigatória ausente: ${key}`);
}

const discordToken = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const channelId = process.env.DISCORD_VOICE_CHANNEL_ID;
const lavaToken = process.env.LAVALENS_TOKEN;
const lavaUrl = process.env.LAVALENS_URL ?? 'http://127.0.0.1:8080';
const testQuery = process.env.TEST_QUERY;
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS ?? 45_000);

function log(event, data = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

async function lava(path, init = {}) {
  const response = await fetch(new URL(path, lavaUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${lavaToken}`,
      'content-type': 'application/json',
      ...init.headers
    }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(body?.message ?? `LavaLens HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function discord(path) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      authorization: `Bot ${discordToken}`,
      'user-agent': 'LavaLens-Native-E2E/0.1'
    }
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status} em ${path}`);
  return response.json();
}

let gateway;
let heartbeat;
let sequence = null;
let gatewayReady = false;
let voiceConnected = false;
let finished = false;
const sseAbort = new AbortController();

async function forwardVoiceUpdate(type, payload) {
  await lava(`/v1/guilds/${guildId}/voice/update`, {
    method: 'POST', body: JSON.stringify({ type, payload })
  });
  log('voice-update-forwarded', { type });
}

function sendGateway(payload) {
  if (!gateway || gateway.readyState !== WebSocket.OPEN) return false;
  gateway.send(JSON.stringify(payload));
  return true;
}

async function handleLavaEvent(event) {
  if (event.guildId && event.guildId !== guildId) return;
  if (event.type === 'DiscordGatewayPayload' && gatewayReady) {
    const payload = event.data?.payload;
    if (payload && sendGateway(payload)) log('gateway-payload-sent', { op: payload.op });
  }
  if (event.type === 'VoiceConnected') {
    voiceConnected = true;
    log('voice-connected');
    if (testQuery) {
      const state = await lava(`/v1/guilds/${guildId}/play`, {
        method: 'POST', body: JSON.stringify({ query: testQuery })
      });
      log('play-accepted', { status: state.status, source: state.track?.source, title: state.track?.title });
    } else finished = true;
  }
  if (event.type === 'TrackStarted') {
    const state = await lava(`/v1/guilds/${guildId}/player`);
    log('track-started', {
      title: state.track?.title,
      source: state.track?.source,
      artworkUrl: state.track?.artworkUrl,
      playlist: state.playlist?.name,
      directPassthrough: state.audio?.directPassthrough,
      transcoding: state.audio?.transcoding
    });
    finished = true;
  }
  if (event.type === 'TrackFailed') {
    log('track-failed', { message: event.data?.state?.error?.message ?? 'unknown' });
    finished = true;
  }
}

async function consumeSse() {
  const response = await fetch(new URL('/v1/events', lavaUrl), {
    headers: { authorization: `Bearer ${lavaToken}` }, signal: sseAbort.signal
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
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = block.split(/\r?\n/).find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      try { await handleLavaEvent(JSON.parse(dataLine.slice(5).trim())); }
      catch (error) { log('event-handler-error', { message: error.message }); }
    }
  }
}

async function openGateway() {
  return new Promise((resolve, reject) => {
    gateway = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
    gateway.addEventListener('open', () => log('gateway-open'));
    gateway.addEventListener('error', () => reject(new Error('Falha ao abrir o Discord Gateway.')));
    gateway.addEventListener('close', (event) => {
      clearInterval(heartbeat);
      if (!finished) reject(new Error(`Gateway fechou: ${event.code}`));
    });
    gateway.addEventListener('message', async ({ data }) => {
      try {
        const packet = JSON.parse(String(data));
        if (packet.s != null) sequence = packet.s;
        if (packet.op === 10) {
          const interval = packet.d.heartbeat_interval;
          heartbeat = setInterval(() => sendGateway({ op: 1, d: sequence }), interval);
          heartbeat.unref?.();
          sendGateway({
            op: 2,
            d: {
              token: discordToken,
              intents: 1,
              properties: { os: process.platform, browser: 'lavalens-native', device: 'lavalens-native' }
            }
          });
          return;
        }
        if (packet.op === 11) return;
        if (packet.op === 7) throw new Error('Discord solicitou reconexão do Gateway.');
        if (packet.op === 9) throw new Error('Sessão do Gateway inválida.');
        if (packet.op !== 0) return;

        if (packet.t === 'READY') {
          gatewayReady = true;
          log('gateway-ready', { botId: packet.d.user?.id, username: packet.d.user?.username });
          await lava(`/v1/guilds/${guildId}/voice/connect`, {
            method: 'POST', body: JSON.stringify({ channelId, shardId: 0, selfDeaf: true })
          });
          log('voice-connect-accepted', { guildId, channelId });
          resolve();
        } else if (packet.t === 'VOICE_SERVER_UPDATE' && packet.d.guild_id === guildId) {
          await forwardVoiceUpdate('server', packet.d);
        } else if (packet.t === 'VOICE_STATE_UPDATE' && packet.d.guild_id === guildId) {
          await forwardVoiceUpdate('state', packet.d);
        }
      } catch (error) { reject(error); }
    });
  });
}

async function cleanup() {
  clearInterval(heartbeat);
  sseAbort.abort();
  try {
    await lava(`/v1/guilds/${guildId}/commands`, {
      method: 'POST', body: JSON.stringify({ name: 'disconnect' })
    });
  } catch { /* best effort */ }
  try { gateway?.close(1000, 'test complete'); } catch { /* best effort */ }
}

async function main() {
  const me = await discord('/users/@me');
  log('token-valid', { botId: me.id, username: me.username });
  const guild = await discord(`/guilds/${guildId}`);
  log('guild-access-ok', { guildId: guild.id, name: guild.name });
  const channel = await discord(`/channels/${channelId}`);
  if (channel.guild_id !== guildId) throw new Error('O canal informado não pertence ao servidor informado.');
  log('channel-access-ok', { channelId: channel.id, type: channel.type, name: channel.name });

  const sseTask = consumeSse().catch((error) => {
    if (error.name !== 'AbortError') throw error;
  });
  await openGateway();
  const deadline = Date.now() + timeoutMs;
  while (!finished && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (!finished) throw new Error(`Teste expirou após ${timeoutMs}ms; voiceConnected=${voiceConnected}.`);

  const state = await lava(`/v1/guilds/${guildId}/player`);
  log('final-state', {
    status: state.status,
    title: state.track?.title,
    source: state.track?.source,
    positionMs: state.positionMs,
    voiceConnected: state.voice?.connected,
    daveProtocolVersion: state.voice?.daveProtocolVersion,
    transportEncryption: state.voice?.transportEncryption
  });
  await cleanup();
  await sseTask;
}

main().catch(async (error) => {
  log('e2e-failed', { message: error.message, status: error.status });
  await cleanup();
  process.exitCode = 1;
});
