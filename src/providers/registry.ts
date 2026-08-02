import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { ResolvedItem } from '../types.js';
import { HttpProvider } from './http.js';
import type { Provider } from './provider.js';
import { SourceRegistry } from './provider.js';
import { YouTubeProvider } from './youtube.js';

export class ProviderRegistry {
  readonly sources = new SourceRegistry();
  readonly providers: Provider[];
  constructor(config: Config) {
    this.providers = [
      ...(config.youtube.enabled ? [new YouTubeProvider(config, this.sources)] : []),
      new HttpProvider(config, this.sources)
    ];
  }
  async resolve(query: string, requestedBy?: string): Promise<ResolvedItem> {
    const provider = this.providers.find((candidate) => candidate.canResolve(query));
    if (!provider) throw new LavaLensError('NO_PROVIDER', 'Nenhum provider reconheceu a consulta.', 400);
    return provider.resolve(query, requestedBy);
  }
  close() { this.sources.close(); }
}
