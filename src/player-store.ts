import type { Config } from './config.js';
import { LavaLensError } from './errors.js';
import type { EventBus } from './event-bus.js';
import type { PlayerState, TrackInfo } from './types.js';

function now() { return new Date().toISOString(); }

export class PlayerStore {
  #players = new Map<string, PlayerState>();
  #lastAccess = new Map<string, number>();
  #timer: NodeJS.Timeout;

  constructor(private readonly config: Config, private readonly events: EventBus) {
    this.#timer = setInterval(() => this.cleanup(), Math.min(config.stateTtlMs, 60_000));
    this.#timer.unref();
  }

  create(guildId: string): PlayerState {
    const timestamp = now();
    const state: PlayerState = {
      guildId,
      status: 'idle',
      track: null,
      playlist: { active: false },
      voice: { connected: false, guildId, listeners: 0, reconnects: 0 },
      audio: {
        outputCodec: 'opus', sampleRate: 48000, channels: 2,
        bitrateKbps: this.config.audio.bitrateKbps,
        directPassthrough: false, transcoding: false,
        bufferMs: this.config.audio.bufferMs, packetLossPercent: 0, underruns: 0
      },
      queue: { tracks: [], loopMode: 'off', autoplay: false },
      volume: 100,
      positionMs: 0,
      filters: {},
      createdAt: timestamp,
      updatedAt: timestamp,
      extensions: {}
    };
    this.#players.set(guildId, state);
    this.touch(guildId);
    this.events.emit('PlayerCreated', { state }, guildId);
    return state;
  }

  get(guildId: string, create = false): PlayerState | undefined {
    const state = this.#players.get(guildId) ?? (create ? this.create(guildId) : undefined);
    if (state) this.touch(guildId);
    return state;
  }

  require(guildId: string): PlayerState {
    const state = this.get(guildId);
    if (!state) throw new LavaLensError('PLAYER_NOT_FOUND', 'Player não encontrado.', 404);
    return state;
  }

  update(guildId: string, patch: Partial<PlayerState>, eventType: string | null = 'PlayerUpdated'): PlayerState {
    const current = this.get(guildId, true)!;
    const updated: PlayerState = {
      ...current,
      ...patch,
      guildId: current.guildId,
      createdAt: current.createdAt,
      playlist: patch.playlist ? { ...current.playlist, ...patch.playlist } : current.playlist,
      voice: patch.voice ? { ...current.voice, ...patch.voice } : current.voice,
      audio: patch.audio ? { ...current.audio, ...patch.audio } : current.audio,
      queue: patch.queue ? { ...current.queue, ...patch.queue } : current.queue,
      extensions: patch.extensions ? { ...current.extensions, ...patch.extensions } : current.extensions,
      updatedAt: now()
    };
    this.#players.set(guildId, updated);
    this.touch(guildId);
    if (eventType) this.events.emit(eventType, { state: updated }, guildId);
    return updated;
  }

  updateSilent(guildId: string, patch: Partial<PlayerState>): PlayerState {
    return this.update(guildId, patch, null);
  }

  enqueue(guildId: string, tracks: TrackInfo[]): PlayerState {
    const state = this.get(guildId, true)!;
    if (state.queue.tracks.length + tracks.length > this.config.audio.maxQueueSize) {
      throw new LavaLensError('QUEUE_LIMIT', 'A fila excedeu o limite configurado.', 409, {
        limit: this.config.audio.maxQueueSize
      });
    }
    return this.update(guildId, { queue: { ...state.queue, tracks: [...state.queue.tracks, ...tracks] } }, 'QueueChanged');
  }

  shift(guildId: string): TrackInfo | null {
    const state = this.require(guildId);
    const [next, ...remaining] = state.queue.tracks;
    this.update(guildId, { queue: { ...state.queue, tracks: remaining } }, 'QueueChanged');
    return next ?? null;
  }

  destroy(guildId: string): boolean {
    const existed = this.#players.delete(guildId);
    this.#lastAccess.delete(guildId);
    if (existed) this.events.emit('PlayerDestroyed', {}, guildId);
    return existed;
  }

  list(): PlayerState[] { return [...this.#players.values()]; }
  activeCount(): number { return this.list().filter((p) => ['playing', 'loading', 'reconnecting'].includes(p.status)).length; }
  totalCount(): number { return this.#players.size; }

  touch(guildId: string) { this.#lastAccess.set(guildId, Date.now()); }

  cleanup(): void {
    const cutoff = Date.now() - this.config.stateTtlMs;
    for (const [guildId, accessed] of this.#lastAccess) {
      const state = this.#players.get(guildId);
      if (accessed < cutoff && state && ['idle', 'stopped', 'error'].includes(state.status)) this.destroy(guildId);
    }
  }

  close() { clearInterval(this.#timer); }
}
