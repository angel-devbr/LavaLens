import type { OpenedAudioSource, ResolvedItem, StoredSource, TrackInfo } from '../types.js';

export interface Provider {
  readonly name: string;
  canResolve(query: string): boolean;
  resolve(query: string, requestedBy?: string): Promise<ResolvedItem>;
}

export class SourceRegistry {
  #sources = new Map<string, StoredSource>();
  #timer: NodeJS.Timeout;

  constructor() {
    this.#timer = setInterval(() => this.cleanup(), 60_000);
    this.#timer.unref();
  }

  put(source: StoredSource): void { this.#sources.set(source.sourceId, source); }
  get(sourceId: string): StoredSource | undefined { return this.#sources.get(sourceId); }
  require(sourceId: string): StoredSource {
    const source = this.get(sourceId);
    if (!source) throw new Error(`Fonte expirada ou inexistente: ${sourceId}`);
    return source;
  }
  cleanup(): void {
    const now = Date.now();
    for (const [id, source] of this.#sources) if (source.expiresAt <= now) this.#sources.delete(id);
  }
  close() { clearInterval(this.#timer); }
}

export function trackWithSource(track: Omit<TrackInfo, 'sourceId'>, source: StoredSource): TrackInfo {
  return { ...track, sourceId: source.sourceId };
}
