/**
 * Generic bridge: reads all Lavalink v4 players and publishes rich snapshots.
 * Run this inside the bot process or as a tiny sidecar.
 */
const lavalinkURL = process.env.LAVALINK_URL ?? "http://localhost:2333";
const lavalinkPassword = process.env.LAVALINK_PASSWORD ?? "change-this-password";
const sessionId = process.env.LAVALINK_SESSION_ID;
const lavalensURL = process.env.LAVALENS_URL ?? "http://localhost:8080";
const lavalensToken = process.env.LAVALENS_TOKEN ?? "change-this-token";
const intervalMs = Number(process.env.BRIDGE_INTERVAL_MS ?? 5000);

if (!sessionId) throw new Error("LAVALINK_SESSION_ID is required");

async function sync() {
  const [playersResponse, statsResponse, versionResponse] = await Promise.all([
    fetch(`${lavalinkURL}/v4/sessions/${sessionId}/players`, {
      headers: { Authorization: lavalinkPassword },
    }),
    fetch(`${lavalinkURL}/v4/stats`, { headers: { Authorization: lavalinkPassword } }),
    fetch(`${lavalinkURL}/version`),
  ]);

  if (!playersResponse.ok) throw new Error(`players: ${playersResponse.status} ${await playersResponse.text()}`);
  const players = await playersResponse.json();
  const stats = statsResponse.ok ? await statsResponse.json() : undefined;
  const version = versionResponse.ok ? (await versionResponse.text()).trim() : undefined;

  await Promise.all(players.map(async (player) => {
    const userData = player.track?.userData ?? {};
    const context = {
      nodeId: process.env.NODE_ID ?? "lavalink-1",
      nodeVersion: version,
      region: process.env.NODE_REGION ?? "unknown",
      playlist: userData.playlist ?? undefined,
      request: userData.requester ?? undefined,
      queue: userData.queue ?? { size: 0, currentIndex: 0 },
      channelName: userData.voiceChannelName ?? undefined,
      listeners: Number(userData.listeners ?? 0),
      extensions: userData.extensions ?? undefined,
    };

    const response = await fetch(`${lavalensURL}/v1/ingest/lavalink`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lavalensToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId, botId: process.env.BOT_ID, player, context, node: stats }),
    });
    if (!response.ok) throw new Error(`LavaLens: ${response.status} ${await response.text()}`);
  }));

  console.log(`sincronizados ${players.length} players`);
}

for (;;) {
  try { await sync(); } catch (error) { console.error(error); }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
