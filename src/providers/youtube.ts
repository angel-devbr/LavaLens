import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { OpenedAudioSource, PlaylistInfo, ResolvedItem, StoredSource, TrackInfo } from '../types.js';
import type { Provider } from './provider.js';
import { SourceRegistry, trackWithSource } from './provider.js';

function videoIdFrom(query: string): string | null {
  try {
    const url = new URL(query);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
    if (url.hostname.includes('youtube.com')) return url.searchParams.get('v') ?? url.pathname.match(/\/shorts\/([^/?]+)/)?.[1] ?? null;
  } catch { /* search text */ }
  return /^[\w-]{11}$/.test(query) ? query : null;
}
function playlistIdFrom(query: string): string | null {
  try { return new URL(query).searchParams.get('list'); } catch { return null; }
}
function bestThumbnail(value: any): string | undefined {
  const thumbs = value?.thumbnails ?? value?.thumbnail ?? value;
  if (!Array.isArray(thumbs)) return undefined;
  return [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
}
function credentialsFrom(config: Config): any | null {
  if (process.env.YOUTUBE_OAUTH_CREDENTIALS_JSON) return JSON.parse(process.env.YOUTUBE_OAUTH_CREDENTIALS_JSON);
  if (existsSync(config.youtube.credentialsFile)) return JSON.parse(readFileSync(config.youtube.credentialsFile, 'utf8'));
  return null;
}

export class YouTubeProvider implements Provider {
  readonly name = 'youtube';
  #yt: any;
  #module: any;
  #initializing: Promise<void> | undefined;
  constructor(private readonly config: Config, private readonly sources: SourceRegistry) {}
  canResolve(query: string): boolean { return /(youtube\.com|youtu\.be)/i.test(query) || !/^https?:\/\//i.test(query); }

  async init(): Promise<void> {
    if (this.#yt) return;
    if (this.#initializing) return this.#initializing;
    this.#initializing = (async () => {
      const credentials = credentialsFrom(this.config);
      if (this.config.youtube.oauthRequired && !credentials) {
        throw new LavaLensError('YOUTUBE_OAUTH_REQUIRED', 'OAuth do YouTube é obrigatório.', 503);
      }
      const module = await import('youtubei.js');
      this.#module = module;
      const cache = new module.UniversalCache(true, this.config.youtube.cacheDir);
      const yt = await module.Innertube.create({
        client_type: 'TV',
        cache,
        enable_session_cache: true,
        generate_session_locally: true
      });
      if (credentials) await yt.session.signIn(credentials);
      this.#yt = yt;
    })();
    try { await this.#initializing; } finally { this.#initializing = undefined; }
  }

  async resolve(query: string, requestedBy?: string): Promise<ResolvedItem> {
    await this.init();
    const playlistId = playlistIdFrom(query);
    if (playlistId) return this.resolvePlaylist(playlistId, requestedBy);
    const directId = videoIdFrom(query);
    if (directId) return { loadType: 'track', tracks: [await this.resolveVideo(directId, requestedBy)] };

    const search = await this.#yt.search(query, { type: 'video' });
    const videos = Array.from(search?.videos ?? search?.results ?? []).slice(0, 10) as any[];
    const tracks: TrackInfo[] = [];
    for (const item of videos) {
      const id = item?.id ?? item?.video_id;
      if (!id) continue;
      tracks.push(await this.trackFromSearch(item, requestedBy));
    }
    return tracks.length ? { loadType: 'search', tracks } : { loadType: 'empty', tracks: [] };
  }

  async trackFromSearch(item: any, requestedBy?: string): Promise<TrackInfo> {
    const id = item.id ?? item.video_id;
    const source = this.makeSource(id);
    this.sources.put(source);
    return trackWithSource({
      id,
      title: item.title?.text ?? item.title ?? 'Sem título',
      author: item.author?.name ?? item.author ?? item.channel?.name ?? 'YouTube',
      source: 'youtube',
      uri: `https://www.youtube.com/watch?v=${id}`,
      artworkUrl: bestThumbnail(item.thumbnails ?? item.thumbnail),
      durationMs: Number(item.duration?.seconds ?? item.duration?.total_seconds ?? 0) * 1000,
      isLive: Boolean(item.is_live),
      seekable: !item.is_live,
      ...(requestedBy ? { requestedBy } : {}),
      providerData: { videoId: id, oauth: true }
    }, source);
  }

  async resolveVideo(id: string, requestedBy?: string): Promise<TrackInfo> {
    const info = await this.#yt.getInfo(id, { client: 'TV' });
    const basic = info.basic_info ?? {};
    const source = this.makeSource(id);
    this.sources.put(source);
    return trackWithSource({
      id,
      title: basic.title ?? 'Sem título',
      author: basic.author ?? basic.channel?.name ?? 'YouTube',
      source: 'youtube',
      uri: `https://www.youtube.com/watch?v=${id}`,
      artworkUrl: bestThumbnail(basic.thumbnail),
      durationMs: Number(basic.duration ?? 0) * 1000,
      isLive: Boolean(basic.is_live || basic.is_live_content),
      seekable: !Boolean(basic.is_live || basic.is_live_content),
      ...(requestedBy ? { requestedBy } : {}),
      providerData: { videoId: id, channelId: basic.channel_id, oauth: true }
    }, source);
  }

  makeSource(videoId: string): StoredSource {
    const sourceId = randomUUID();
    return {
      sourceId,
      provider: this.name,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      open: async (): Promise<OpenedAudioSource> => {
        await this.init();
        const webStream = await this.#yt.download(videoId, {
          type: 'audio', quality: 'best', format: 'webm', codec: 'opus', client: 'TV'
        });
        return {
          stream: Readable.fromWeb(webStream as never),
          inputType: 'webm-opus',
          directPassthrough: true,
          sourceCodec: 'opus',
          sourceContainer: 'webm'
        };
      }
    };
  }

  async resolvePlaylist(id: string, requestedBy?: string): Promise<ResolvedItem> {
    const playlist = await this.#yt.getPlaylist(id);
    const items = Array.from(playlist?.videos ?? []).slice(0, this.config.youtube.maxPlaylistTracks) as any[];
    const tracks: TrackInfo[] = [];
    for (const item of items) tracks.push(await this.trackFromSearch(item, requestedBy));
    const info: PlaylistInfo = {
      active: true,
      id,
      name: playlist?.info?.title ?? playlist?.title ?? 'Playlist do YouTube',
      uri: `https://www.youtube.com/playlist?list=${id}`,
      artworkUrl: bestThumbnail(playlist?.info?.thumbnail ?? items[0]?.thumbnail),
      owner: playlist?.info?.author?.name ?? playlist?.author?.name,
      currentIndex: 0,
      totalTracks: tracks.length
    };
    return { loadType: 'playlist', tracks, playlist: info };
  }

  static async runOAuth(config: Config): Promise<void> {
    const module = await import('youtubei.js');
    mkdirSync(dirname(config.youtube.credentialsFile), { recursive: true });
    const cache = new module.UniversalCache(true, config.youtube.cacheDir);
    const yt = await module.Innertube.create({ client_type: 'TV', cache, generate_session_locally: true });
    let saved = false;
    yt.session.on('auth-pending', (data: any) => {
      console.log(`\nAbra: ${data.verification_url}\nCódigo: ${data.user_code}\n`);
    });
    yt.session.on('auth', ({ credentials }: any) => {
      writeFileSync(config.youtube.credentialsFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      saved = true;
      console.log(`OAuth salvo em ${config.youtube.credentialsFile}`);
    });
    yt.session.on('update-credentials', ({ credentials }: any) => {
      writeFileSync(config.youtube.credentialsFile, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    });
    await yt.session.signIn();
    while (!saved) await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
