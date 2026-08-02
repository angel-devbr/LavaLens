import type { LavaEvent } from './types.js';

export type EventSubscriber = (event: LavaEvent) => void;

export class EventBus {
  #nextId = 1;
  #history: LavaEvent[] = [];
  #subscribers = new Set<EventSubscriber>();

  constructor(private readonly historyLimit: number) {}

  emit<T>(type: string, data: T, guildId?: string): LavaEvent<T> {
    const event: LavaEvent<T> = {
      id: this.#nextId++,
      type,
      at: new Date().toISOString(),
      data,
      ...(guildId ? { guildId } : {})
    };
    this.#history.push(event as LavaEvent);
    if (this.#history.length > this.historyLimit) this.#history.splice(0, this.#history.length - this.historyLimit);
    for (const subscriber of this.#subscribers) {
      try { subscriber(event as LavaEvent); } catch { /* subscriber isolation */ }
    }
    return event;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  history(afterId = 0): LavaEvent[] {
    return this.#history.filter((event) => event.id > afterId);
  }

  get subscriberCount(): number { return this.#subscribers.size; }
}
