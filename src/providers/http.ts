import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { OpenedAudioSource, ResolvedItem, StoredSource } from '../types.js';
import type { Provider } from './provider.js';
import { SourceRegistry, trackWithSource } from './provider.js';
import { FfmpegPipeline } from '../audio/ffmpeg.js';
import { assertAllowedUrl, openHttpStream, probeSource } from '../net/http-stream.js';

/** Decodifica sem estourar em `%` inválido (ex.: "/%ZZ.mp3"). */
function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export class HttpProvider implements Provider {
  readonly name = 'http';
  constructor(private readonly config: Config, private readonly sources: SourceRegistry) {}
  canResolve(query: string): boolean { return /^https?:\/\//i.test(query) && !/(youtube\.com|youtu\.be)/i.test(query); }

  async resolve(query: string, requestedBy?: string): Promise<ResolvedItem> {
    if (!this.canResolve(query)) throw new LavaLensError('UNSUPPORTED_URL', 'URL não suportada pelo provider HTTP.');

    let url: URL;
    try { url = new URL(query); }
    catch { throw new LavaLensError('INVALID_URL', 'URL inválida.', 400); }

    // Bloqueio anti-SSRF já no resolve, para não vazar rede interna nem criar fonte inútil.
    await assertAllowedUrl(url, this.config.allowPrivateNetwork);

    const title = url.searchParams.get('title') ?? safeDecode(url.pathname.split('/').pop() || url.hostname);
    const author = url.searchParams.get('author') ?? url.hostname;
    const artworkUrl = url.searchParams.get('artwork') ?? undefined;
    const rawDuration = Number(url.searchParams.get('durationMs') ?? 0);
    const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
    const sourceId = randomUUID();

    const probe = await probeSource(url, this.config.allowPrivateNetwork);
    const contentType = probe.contentType;
    const directWebm = /audio\/webm|video\/webm/i.test(contentType);
    const directOgg = /audio\/(ogg|opus)/i.test(contentType);
    // Arquivo com tamanho conhecido é estático: dá para buscar e não é "ao vivo".
    const isFiniteFile = probe.contentLength > 0;
    const isLive = !isFiniteFile && durationMs <= 0;
    const pipeline = new FfmpegPipeline(this.config);

    const source: StoredSource = {
      sourceId,
      provider: this.name,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
      open: async (offsetMs = 0): Promise<OpenedAudioSource> => {
        if (offsetMs === 0 && (directWebm || directOgg)) {
          // node:http em vez de fetch(): evita o crash do undici sob backpressure.
          const result = await openHttpStream(url, { allowPrivateNetwork: this.config.allowPrivateNetwork });
          return {
            stream: result.stream,
            inputType: directWebm ? 'webm-opus' : 'ogg-opus',
            directPassthrough: true,
            sourceCodec: 'opus',
            sourceContainer: directWebm ? 'webm' : 'ogg',
            ...(durationMs > 0 ? { durationMs } : {}),
            cleanup: () => result.stream.destroy()
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
        durationMs,
        isLive,
        // FFmpeg busca por tempo mesmo sem duração declarada, desde que seja arquivo.
        seekable: !isLive,
        ...(requestedBy ? { requestedBy } : {}),
        providerData: { contentType, contentLength: probe.contentLength, acceptsRanges: probe.acceptsRanges }
      }, source)]
    };
  }
}
