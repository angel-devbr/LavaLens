import type { EventBus } from '../event-bus.js';

interface AdapterMethods {
  onVoiceServerUpdate(data: unknown): void;
  onVoiceStateUpdate(data: unknown): void;
  destroy(): void;
}

export class RemoteAdapter {
  #methods: AdapterMethods | undefined;
  constructor(private readonly guildId: string, private readonly events: EventBus) {}

  creator = (methods: AdapterMethods) => {
    this.#methods = methods;
    return {
      sendPayload: (payload: unknown) => {
        this.events.emit('DiscordGatewayPayload', { payload }, this.guildId);
        return true;
      },
      destroy: () => {
        this.#methods = undefined;
        this.events.emit('DiscordVoiceAdapterDestroyed', {}, this.guildId);
      }
    };
  };

  update(type: 'server' | 'state', payload: unknown): void {
    if (!this.#methods) throw new Error('Adaptador de voz ainda não foi criado.');
    if (type === 'server') this.#methods.onVoiceServerUpdate(payload);
    else this.#methods.onVoiceStateUpdate(payload);
  }

  destroy(): void { this.#methods?.destroy(); this.#methods = undefined; }
}
