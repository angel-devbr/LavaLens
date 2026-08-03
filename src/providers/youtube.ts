import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { webStreamToNode } from '../net/http-stream.js';
import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { OpenedAudioSource, PlaylistInfo, ResolvedItem, StoredSource, TrackInfo } from '../types.js';
import type { Provider } from './provider.js';
import { SourceRegistry, trackWithSource } from './provider.js';
import { FfmpegPipeline } from '../audio/ffmpeg.js';
import { installJsRuntime } from './js-runtime.js';
import { YouTubePoTokenManager } from './youtube-po-token.js';

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
  const thumbs = value?.sources ?? value?.thumbnails ?? value?.thumbnail ?? value;
  if (!Array.isArray(thumbs)) return undefined;
  return [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0]?.url;
}

function durationTextToMs(text: string | undefined): number {
  if (!text) return 0;
  const parts = text.split(':').map((piece) => Number.parseInt(piece, 10));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((total, n) => total * 60 + n, 0) * 1000;
}

function normalizeSearchItem(item: any): {
  id?: string;
  title?: string;
  author?: string;
  artworkUrl?: string;
  durationMs: number;
  isLive: boolean;
} {
  const legacyId = item?.id ?? item?.video_id;
  if (legacyId && (item?.title || item?.author)) {
    return {
      id: legacyId,
      title: item.title?.text ?? item.title,
      author: item.author?.name ?? item.author ?? item.channel?.name,
      artworkUrl: bestThumbnail(item.thumbnails ?? item.thumbnail),
      durationMs: Number(item.duration?.seconds ?? item.duration?.total_seconds ?? 0) * 1000,
      isLive: Boolean(item.is_live),
    };
  }

  if (item?.content_id && item?.content_type === 'VIDEO') {
    const metadata = item.metadata;
    const rows = metadata?.metadata?.metadata_rows ?? [];
    const author = (rows[0]?.metadata_parts ?? [])
      .map((part: any) => part?.text?.text ?? part?.text)
      .filter(Boolean)[0];
    let durationText: string | undefined;
    for (const overlay of item.content_image?.overlays ?? []) {
      for (const badge of overlay?.badges ?? (overlay?.badge ? [overlay.badge] : [])) {
        if (typeof badge?.text === 'string' && /^\d+(:\d{2})+$/.test(badge.text)) durationText = badge.text;
      }
    }
    return {
      id: item.content_id,
      title: metadata?.title?.text ?? metadata?.title,
      author,
      artworkUrl: bestThumbnail(item.content_image?.image),
      durationMs: durationTextToMs(durationText),
      isLive: !durationText,
    };
  }
  return { durationMs: 0, isLive: false };
}

async function oembedMetadata(videoId: string): Promise<{ title?: string; author?: string; artworkUrl?: string }> {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!response.ok) return {};
    const data = await response.json() as any;
    return {
      ...(data.title ? { title: String(data.title) } : {}),
      ...(data.author_name ? { author: String(data.author_name) } : {}),
      ...(data.thumbnail_url ? { artworkUrl: String(data.thumbnail_url) } : {}),
    };
  } catch { return {}; }
}

function sabrAudioScore(format: any, preferredQuality: string): number {
  const mime = String(format?.mimeType ?? format?.mime_type ?? '').toLowerCase();
  const quality = String(format?.audioQuality ?? format?.audio_quality ?? '');
  const bitrate = Number(format?.bitrate ?? format?.averageBitrate ?? format?.average_bitrate ?? 0);
  return bitrate
    + (mime.includes('opus') ? 100_000_000 : 0)
    + (mime.includes('webm') ? 50_000_000 : 0)
    + (quality.toLowerCase().includes(preferredQuality.toLowerCase()) ? 10_000_000 : 0)
    - (format?.isDrc || format?.is_drc ? 1_000_000 : 0);
}

function chooseSabrAudioFormat(formats: any[], preferredQuality: string): any | undefined {
  return [...formats]
    .filter((format) => String(format?.mimeType ?? '').includes('audio'))
    .sort((a, b) => sabrAudioScore(b, preferredQuality) - sabrAudioScore(a, preferredQuality))[0];
}

function chooseSabrVideoPlaceholder(formats: any[]): any | undefined {
  return [...formats]
    .filter((format) => String(format?.mimeType ?? '').includes('video'))
    .sort((a, b) => Number(a?.bitrate ?? 0) - Number(b?.bitrate ?? 0))[0];
}

function isDirectWebmOpus(mimeType: string | undefined): boolean {
  const mime = String(mimeType ?? '').toLowerCase();
  return mime.includes('audio/webm') && mime.includes('opus');
}

function sabrError(error: unknown, videoId: string): LavaLensError {
  if (error instanceof LavaLensError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/po.?token|proof.?of.?origin|attestation|botguard|no media parts|protocol updates/i.test(message)) {
    return new LavaLensError(
      'YOUTUBE_SABR_POTOKEN_REQUIRED',
      'O YouTube rejeitou ou exigiu um PO Token válido para este vídeo.',
      503,
      { videoId },
    );
  }
  return new LavaLensError('YOUTUBE_SABR_FAILED', `Falha no streaming SABR do YouTube: ${message}`, 502, { videoId });
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
  #poTokens: YouTubePoTokenManager | undefined;
  #initializing: Promise<void> | undefined;

  constructor(private readonly config: Config, private readonly sources: SourceRegistry) {}
  canResolve(query: string): boolean { return /(youtube\.com|youtu\.be)/i.test(query) || !/^https?:\/\//i.test(query); }

  async init(): Promise<void> {
    if (this.#yt) return;
    if (this.#initializing) return this.#initializing;
    const pending = (async () => {
      const credentials = credentialsFrom(this.config);
      if (this.config.youtube.oauthRequired && !credentials) {
        throw new LavaLensError('YOUTUBE_OAUTH_REQUIRED', 'OAuth do YouTube é obrigatório.', 503);
      }
      const module = await import('youtubei.js');
      await installJsRuntime();
      this.#module = module;
      const cache = new module.UniversalCache(true, this.config.youtube.cacheDir);
      const yt = await module.Innertube.create({
        client_type: module.ClientType.TV,
        cache,
        enable_session_cache: true,
        generate_session_locally: true,
      });
      if (credentials) await yt.session.signIn(credentials);
      yt.session.on('update-credentials', ({ credentials: fresh }: any) => {
        try { writeFileSync(this.config.youtube.credentialsFile, JSON.stringify(fresh, null, 2), { mode: 0o600 }); }
        catch { /* disco somente leitura */ }
      });
      this.#yt = yt;
      this.#poTokens = new YouTubePoTokenManager(this.config, yt);
    })();
    this.#initializing = pending;
    try { await pending; } finally { this.#initializing = undefined; }
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
      const normalized = normalizeSearchItem(item);
      if (normalized.id) tracks.push(this.trackFromSearch(normalized, requestedBy));
    }
    return tracks.length ? { loadType: 'search', tracks } : { loadType: 'empty', tracks: [] };
  }

  trackFromSearch(item: ReturnType<typeof normalizeSearchItem>, requestedBy?: string): TrackInfo {
    const id = item.id!;
    const source = this.makeSource(id);
    this.sources.put(source);
    return trackWithSource({
      id,
      title: item.title ?? 'Sem título',
      author: item.author ?? 'YouTube',
      source: 'youtube',
      uri: `https://www.youtube.com/watch?v=${id}`,
      ...(item.artworkUrl ? { artworkUrl: item.artworkUrl } : {}),
      durationMs: item.durationMs,
      isLive: item.isLive,
      seekable: !item.isLive,
      ...(requestedBy ? { requestedBy } : {}),
      providerData: { videoId: id, oauth: true, sabrFallback: this.config.youtube.sabrEnabled, poTokenAuto: this.config.youtube.poTokenAutoEnabled },
    }, source);
  }

  async resolveVideo(id: string, requestedBy?: string): Promise<TrackInfo> {
    const info = await this.#yt.getBasicInfo(id, 'TV');
    const basic = info.basic_info ?? {};
    const live = Boolean(basic.is_live || basic.is_live_content);
    const fallback = (!basic.title || !basic.author) ? await oembedMetadata(id) : {};
    const source = this.makeSource(id);
    this.sources.put(source);
    const artworkUrl = bestThumbnail(basic.thumbnail) ?? fallback.artworkUrl;
    return trackWithSource({
      id,
      title: basic.title ?? fallback.title ?? 'Sem título',
      author: basic.author ?? basic.channel?.name ?? fallback.author ?? 'YouTube',
      source: 'youtube',
      uri: `https://www.youtube.com/watch?v=${id}`,
      ...(artworkUrl ? { artworkUrl } : {}),
      durationMs: Number(basic.duration ?? 0) * 1000,
      isLive: live,
      seekable: !live,
      ...(requestedBy ? { requestedBy } : {}),
      providerData: { videoId: id, channelId: basic.channel_id, oauth: true, sabrFallback: this.config.youtube.sabrEnabled, poTokenAuto: this.config.youtube.poTokenAutoEnabled },
    }, source);
  }

  private async makePlayerRequest(videoId: string, reloadPlaybackContext?: unknown): Promise<any> {
    const endpoint = new this.#module.YTNodes.NavigationEndpoint({ watchEndpoint: { videoId } });
    const extraArgs: Record<string, any> = {
      playbackContext: {
        adPlaybackContext: { pyv: true },
        contentPlaybackContext: {
          vis: 0,
          splay: false,
          lactMilliseconds: '-1',
          signatureTimestamp: this.#yt.session.player?.signature_timestamp,
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
    };
    if (reloadPlaybackContext) extraArgs.playbackContext.reloadPlaybackContext = reloadPlaybackContext;
    return endpoint.call(this.#yt.actions, { ...extraArgs, parse: true });
  }

  private async openSabrAudio(videoId: string, offsetMs: number, retriedPoToken = false): Promise<OpenedAudioSource> {
    if (!this.config.youtube.sabrEnabled) {
      throw new LavaLensError('YOUTUBE_SABR_DISABLED', 'Este vídeo exige SABR, mas YOUTUBE_SABR_ENABLED está desativado.', 503, { videoId });
    }

    try {
      const [{ SabrStream }, { buildSabrFormat, EnabledTrackTypes }] = await Promise.all([
        import('googlevideo/sabr-stream'),
        import('googlevideo/utils'),
      ]);
      const poToken = await this.#poTokens?.get(videoId, retriedPoToken) ?? this.config.youtube.poToken;
      const playerResponse = await this.makePlayerRequest(videoId);
      const rawStreamingUrl = playerResponse.streaming_data?.server_abr_streaming_url;
      const serverAbrStreamingUrl = rawStreamingUrl ? await this.#yt.session.player?.decipher(rawStreamingUrl) : undefined;
      const videoPlaybackUstreamerConfig = playerResponse.player_config?.media_common_config
        ?.media_ustreamer_request_config?.video_playback_ustreamer_config;
      const formats = (playerResponse.streaming_data?.adaptive_formats ?? []).map(buildSabrFormat);
      if (!serverAbrStreamingUrl || !videoPlaybackUstreamerConfig || !formats.length) {
        throw new LavaLensError('YOUTUBE_SABR_METADATA_MISSING', 'Metadados SABR ausentes.', 503, {
          videoId,
          hasUrl: Boolean(serverAbrStreamingUrl),
          hasUstreamer: Boolean(videoPlaybackUstreamerConfig),
          formats: formats.length,
        });
      }

      const client = this.#yt.session.context.client;
      const clientNameId = Number.parseInt(String(this.#module.Constants.CLIENT_NAME_IDS[client.clientName] ?? client.clientName), 10);
      if (!Number.isFinite(clientNameId)) {
        throw new LavaLensError('YOUTUBE_SABR_CLIENT_INVALID', 'Cliente Innertube inválido para SABR.', 503, { clientName: client.clientName });
      }

      const stream = new SabrStream({
        formats,
        serverAbrStreamingUrl,
        videoPlaybackUstreamerConfig,
        ...(poToken ? { poToken } : {}),
        durationMs: Number(playerResponse.video_details?.duration ?? 0) * 1000 || undefined,
        clientInfo: { clientName: clientNameId, clientVersion: client.clientVersion },
      });
      stream.on('reloadPlayerResponse', (reloadPlaybackContext: unknown) => {
        void this.makePlayerRequest(videoId, reloadPlaybackContext).then(async (fresh) => {
          const nextRawUrl = fresh.streaming_data?.server_abr_streaming_url;
          const nextUrl = nextRawUrl ? await this.#yt.session.player?.decipher(nextRawUrl) : undefined;
          const nextConfig = fresh.player_config?.media_common_config
            ?.media_ustreamer_request_config?.video_playback_ustreamer_config;
          if (nextUrl) stream.setStreamingURL(nextUrl);
          if (nextConfig) stream.setUstreamerConfig(nextConfig);
        }).catch(() => stream.abort());
      });

      const result = await stream.start({
        audioFormat: (available: any[]) => chooseSabrAudioFormat(available, this.config.youtube.sabrAudioQuality),
        videoFormat: chooseSabrVideoPlaceholder,
        enabledTrackTypes: EnabledTrackTypes.AUDIO_ONLY,
        maxRetries: this.config.youtube.sabrMaxRetries,
        stallDetectionMs: this.config.youtube.sabrStallDetectionMs,
      });
      const selected = result.selectedFormats.audioFormat;
      const rawNodeStream = webStreamToNode(result.audioStream as ReadableStream<Uint8Array>);
      const nodeStream = new PassThrough({ highWaterMark: 1 << 18 });
      rawNodeStream.once('error', (error) => nodeStream.destroy(sabrError(error, videoId)));
      rawNodeStream.pipe(nodeStream);
      const direct = isDirectWebmOpus(selected?.mimeType) && offsetMs === 0;
      if (!direct) {
        const pipeline = new FfmpegPipeline(this.config);
        const transcoded = await pipeline.openFromStream(nodeStream, offsetMs);
        const cleanup = transcoded.cleanup;
        return {
          ...transcoded,
          sourceCodec: String(selected?.mimeType ?? '').includes('opus') ? 'opus' : 'unknown',
          sourceContainer: String(selected?.mimeType ?? '').includes('webm') ? 'webm' : 'sabr',
          cleanup: () => { cleanup?.(); stream.abort(); },
        };
      }
      return {
        stream: nodeStream,
        inputType: 'webm-opus',
        directPassthrough: true,
        sourceCodec: 'opus',
        sourceContainer: 'webm-sabr',
        cleanup: () => { rawNodeStream.destroy(); nodeStream.destroy(); stream.abort(); },
      };
    } catch (error) {
      const mapped = sabrError(error, videoId);
      if (!retriedPoToken && this.config.youtube.poTokenAutoEnabled && mapped.code === 'YOUTUBE_SABR_POTOKEN_REQUIRED') {
        this.#poTokens?.invalidate(videoId);
        return this.openSabrAudio(videoId, offsetMs, true);
      }
      throw mapped;
    }
  }

  makeSource(videoId: string): StoredSource {
    const sourceId = randomUUID();
    return {
      sourceId,
      provider: this.name,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      open: async (offsetMs = 0): Promise<OpenedAudioSource> => {
        await this.init();
        try {
          const webStream = await this.#yt.download(videoId, {
            type: 'audio', quality: 'best', format: 'webm', codec: 'opus', client: 'TV',
          }) as ReadableStream<Uint8Array>;
          const directStream = webStreamToNode(webStream);
          if (offsetMs > 0) {
            const pipeline = new FfmpegPipeline(this.config);
            const piped = await pipeline.openFromStream(directStream, offsetMs);
            return { ...piped, sourceCodec: 'opus', sourceContainer: 'webm' };
          }
          return {
            stream: directStream,
            inputType: 'webm-opus',
            directPassthrough: true,
            sourceCodec: 'opus',
            sourceContainer: 'webm',
            cleanup: () => directStream.destroy(),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/No valid URL to decipher|Video is unplayable|server_abr_streaming_url|SABR/i.test(message)) throw error;
          return this.openSabrAudio(videoId, offsetMs);
        }
      },
    };
  }

  async resolvePlaylist(id: string, requestedBy?: string): Promise<ResolvedItem> {
    const playlist = await this.#yt.getPlaylist(id);
    const items = Array.from(playlist?.videos ?? []).slice(0, this.config.youtube.maxPlaylistTracks) as any[];
    const tracks: TrackInfo[] = [];
    for (const item of items) {
      const normalized = normalizeSearchItem(item);
      if (normalized.id) tracks.push(this.trackFromSearch(normalized, requestedBy));
    }
    const info: PlaylistInfo = {
      active: true,
      id,
      name: playlist?.info?.title ?? playlist?.title ?? 'Playlist do YouTube',
      uri: `https://www.youtube.com/playlist?list=${id}`,
      artworkUrl: bestThumbnail(playlist?.info?.thumbnail ?? items[0]?.thumbnail),
      owner: playlist?.info?.author?.name ?? playlist?.author?.name,
      currentIndex: 0,
      totalTracks: tracks.length,
    };
    return { loadType: 'playlist', tracks, playlist: info };
  }

  static async runOAuth(config: Config): Promise<void> {
    const module = await import('youtubei.js');
    await installJsRuntime();
    mkdirSync(dirname(config.youtube.credentialsFile), { recursive: true });
    const cache = new module.UniversalCache(true, config.youtube.cacheDir);
    const yt = await module.Innertube.create({ client_type: module.ClientType.TV, cache, generate_session_locally: true });
    let saved = false;
    yt.session.on('auth-pending', (data: any) => console.log(`Abra: ${data.verification_url}\nCódigo: ${data.user_code}\n`));
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

export const __testables = {
  normalizeSearchItem,
  durationTextToMs,
  bestThumbnail,
  chooseSabrAudioFormat,
  isDirectWebmOpus,
  sabrAudioScore,
};
