import { loadConfig } from './config.js';
import { YouTubeProvider } from './providers/youtube.js';

const command = process.argv[2];
if (command === 'youtube-oauth') {
  const config = loadConfig({ allowMissingYoutubeOAuth: true });
  await YouTubeProvider.runOAuth(config);
} else if (command === 'inspect') {
  const guildId = process.argv[3];
  const base = process.env.PUBLIC_BASE_URL ?? 'http://localhost:8080';
  const token = process.env.LAVALENS_TOKEN;
  if (!guildId || !token) throw new Error('Uso: LAVALENS_TOKEN=... npm run inspect -- GUILD_ID');
  const response = await fetch(`${base}/v1/guilds/${guildId}/player`, { headers: { authorization: `Bearer ${token}` } });
  console.log(JSON.stringify(await response.json(), null, 2));
} else {
  console.log('Comandos: youtube-oauth | inspect GUILD_ID');
}
