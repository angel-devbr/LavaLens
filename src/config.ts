import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface Config {
  port: number;
  host: string;
  token: string;
  nodeId: string;
  stateTtlMs: number;
  eventHistory: number;
  maxBodyBytes: number;
  logLevel: string;
  youtube: {
    enabled: boolean;
    oauthRequired: boolean;
    credentialsFile: string;
    maxPlaylistTracks: number;
    cacheDir: string;
  };
  audio: {
    ffmpegPath: string;
    profile: 'eco' | 'balanced' | 'quality';
    bitrateKbps: number;
    bufferMs: number;
    maxActivePlayers: number;
    maxQueueSize: number;
  };
}

const bool = (value: string | undefined, fallback: boolean) =>
  value == null ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
const int = (value: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};


function validYoutubeCredentials(file: string): boolean {
  try {
    const raw = process.env.YOUTUBE_OAUTH_CREDENTIALS_JSON ?? (existsSync(file) ? readFileSync(file, 'utf8') : '');
    if (!raw) return false;
    const value = JSON.parse(raw);
    return typeof value === 'object' && value !== null &&
      (typeof value.refresh_token === 'string' || typeof value.access_token === 'string');
  } catch { return false; }
}

export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function loadConfig(options: { allowMissingYoutubeOAuth?: boolean } = {}): Config {
  loadDotEnv();
  const profile = (process.env.AUDIO_PROFILE ?? 'balanced') as Config['audio']['profile'];
  const config: Config = {
    port: int(process.env.PORT, 8080, 1, 65535),
    host: process.env.HOST ?? '0.0.0.0',
    token: process.env.LAVALENS_TOKEN ?? randomBytes(32).toString('hex'),
    nodeId: process.env.NODE_ID ?? 'node-local-01',
    stateTtlMs: int(process.env.STATE_TTL_MS, 1_800_000, 60_000),
    eventHistory: int(process.env.EVENT_HISTORY, 64, 1, 1024),
    maxBodyBytes: int(process.env.MAX_BODY_BYTES, 524_288, 1024, 10_485_760),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    youtube: {
      enabled: bool(process.env.YOUTUBE_ENABLED, true),
      oauthRequired: bool(process.env.YOUTUBE_OAUTH_REQUIRED, true),
      credentialsFile: process.env.YOUTUBE_OAUTH_CREDENTIALS_FILE ?? './lavalens-oauth.json',
      maxPlaylistTracks: int(process.env.YOUTUBE_MAX_PLAYLIST_TRACKS, 100, 1, 1000),
      cacheDir: process.env.YOUTUBE_CACHE_DIR ?? './.cache/youtube'
    },
    audio: {
      ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
      profile: ['eco', 'balanced', 'quality'].includes(profile) ? profile : 'balanced',
      bitrateKbps: int(process.env.AUDIO_BITRATE_KBPS, 128, 32, 512),
      bufferMs: int(process.env.AUDIO_BUFFER_MS, 500, 100, 5000),
      maxActivePlayers: int(process.env.MAX_ACTIVE_PLAYERS, 2, 1, 1000),
      maxQueueSize: int(process.env.MAX_QUEUE_SIZE, 500, 1, 10000)
    }
  };

  if (config.token.length < 24) throw new Error('LAVALENS_TOKEN deve ter pelo menos 24 caracteres.');
  if (
    config.youtube.enabled &&
    config.youtube.oauthRequired &&
    !options.allowMissingYoutubeOAuth &&
    !validYoutubeCredentials(config.youtube.credentialsFile)
  ) {
    throw new Error(
      `OAuth do YouTube é obrigatório e as credenciais estão ausentes ou inválidas. Execute "npm run oauth:youtube" ou defina YOUTUBE_OAUTH_CREDENTIALS_JSON.`
    );
  }
  return config;
}
