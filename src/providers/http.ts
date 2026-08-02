import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { OpenedAudioSource, ResolvedItem, StoredSource } from '../types.js';
import type { Provider } from './provider.js';
import { SourceRegistry, trackWithSource } from './provider.js';
import { FfmpegPipeline } from '../audio/ffmpeg.js';

export class HttpProvider implements Provider {
  readonly name = 'http';
  constructor(private readonly config: Config, private readonly sources: SourceRegistry) {}
  canResolve(query: string): boolean { return /^https?:\/\//i.test(query) && !/(youtube\.com|youtu\.be)/i.test(query); }

  async resolve(query: string, requestedBy?: string): Promise<ResolvedItem> {
    if (!this.canResolve(query)) throw new LavaLensError('UNSUPPORTED_URL', 'URL não suportada pelo provider HTTP.');
    const url = new URL(query);
    const title = url.searchParams.get('title') ?? decodeURIComponent(url.pathname.split('/').pop() || url.hostname);
    const author = url.searchParams.get('author') ?? url.hostname;
    const artworkUrl = url.searchParams.get('artwork') ?? undefined;
    const durationMs = Number(url.searchParams.get('durationMs') ?? 0);
    const sourceId = randomUUID();

    let contentType = '';
    try {
      const response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      contentType = response.headers.get('content-type') ?? '';
    } catch { /* streams often reject HEAD; FFmpeg can still open them */ }

    const directWebm = /audio\/webm|video\/webm/i.test(contentType);
    const directOgg = /audio\/(ogg|opus)/i.test(contentType);
    const pipeline = new FfmpegPipeline(this.config);
    const source: StoredSource = {
      sourceId,
      provider: this.name,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      open: async (offsetMs = 0): Promise<OpenedAudioSource> => {
        if (offsetMs === 0 && (directWebm || directOgg)) {
          const response = await fetch(url, { redirect: 'follow' });
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          return {
            stream: Readable.fromWeb(response.body as never),
            inputType: directWebm ? 'webm-opus' : 'ogg-opus',
            directPassthrough: true,
            sourceCodec: 'opus',
            sourceContainer: directWebm ? 'webm' : 'ogg'
          };
        }
        return pipeline.open(url.toString(), offsetMs);
      }
    };
    this.sources.put(source);
    return {
      loadType: 'track',
      tracks: [trackWithSource({
        id: sourceId,
        title,
        author,
        source: 'http',
        uri: url.toString(),
        ...(artworkUrl ? { artworkUrl } : {}),
        durationMs: Number.isFinite(durationMs) ? durationMs : 0,
        isLive: durationMs <= 0,
        seekable: durationMs > 0,
        ...(requestedBy ? { requestedBy } : {}),
        providerData: { contentType }
      }, source)]
    };
  }
}
