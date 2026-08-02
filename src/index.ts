import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp(config);
await app.server.listen();
console.log(JSON.stringify({
  level: 'info', event: 'started', name: 'LavaLens Native', version: '0.1.0-alpha.2',
  nodeId: config.nodeId, address: `http://${config.host}:${config.port}`,
  youtubeOAuthRequired: config.youtube.enabled && config.youtube.oauthRequired
}));

async function shutdown(signal: string) {
  console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
  await app.close(); process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
