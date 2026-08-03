import type { Config } from '../config.js';
import { PoTokenManager } from './po-token-manager.js';

/**
 * Adaptador de compatibilidade usado pelo provider do YouTube.
 * Toda a geração, renovação, cache e fallback ficam centralizados em
 * PoTokenManager; o parâmetro Innertube é mantido apenas para preservar a
 * interface atual do provider.
 */
export class YouTubePoTokenManager {
  readonly #manager: PoTokenManager;

  constructor(config: Config, _innertube?: unknown) {
    this.#manager = new PoTokenManager(config);
  }

  get enabled(): boolean {
    return this.#manager.status().enabled;
  }

  get(videoId: string, forceRefresh = false): Promise<string | undefined> {
    return this.#manager.get(videoId, forceRefresh);
  }

  invalidate(videoId?: string): void {
    this.#manager.invalidate(videoId);
  }

  status(): ReturnType<PoTokenManager['status']> {
    return this.#manager.status();
  }

  close(): void {
    this.#manager.close();
  }
}
