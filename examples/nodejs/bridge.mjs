const BASE = process.env.LAVALENS_URL ?? 'http://localhost:8080';
const TOKEN = process.env.LAVALENS_TOKEN;
if (!TOKEN) throw new Error('Defina LAVALENS_TOKEN');

async function api(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// No seu cliente de Gateway do Discord:
// 1. encaminhe eventos VOICE_SERVER_UPDATE e VOICE_STATE_UPDATE para voice/update;
// 2. escute DiscordGatewayPayload no WebSocket e envie payload ao shard correto.
export const connect = (guildId, channelId, shardId = 0) =>
  api(`/v1/guilds/${guildId}/voice/connect`, { channelId, shardId });
export const voiceServerUpdate = (guildId, payload) =>
  api(`/v1/guilds/${guildId}/voice/update`, { type: 'server', payload });
export const voiceStateUpdate = (guildId, payload) =>
  api(`/v1/guilds/${guildId}/voice/update`, { type: 'state', payload });
export const play = (guildId, query) => api(`/v1/guilds/${guildId}/play`, { query });
