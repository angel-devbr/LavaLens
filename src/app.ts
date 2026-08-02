import type { Config } from './config.js';
import { EventBus } from './event-bus.js';
import { Metrics } from './metrics.js';
import { PlayerStore } from './player-store.js';
import { ProviderRegistry } from './providers/registry.js';
import { VoiceManager } from './discord/voice.js';
import { ApiServer } from './server.js';

export function createApp(config: Config) {
  const events = new EventBus(config.eventHistory);
  const store = new PlayerStore(config, events);
  const providers = new ProviderRegistry(config);
  const metrics = new Metrics();
  const voice = new VoiceManager(config, store, events, providers.sources);
  const server = new ApiServer(config, store, providers, voice, events, metrics);
  return {
    config, events, store, providers, metrics, voice, server,
    async close() { voice.close(); providers.close(); store.close(); await server.close(); }
  };
}
