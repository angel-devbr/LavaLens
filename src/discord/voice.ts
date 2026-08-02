import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { EventBus } from '../event-bus.js';
import type { PlayerStore } from '../player-store.js';
import type { SourceRegistry } from '../providers/provider.js';
import type { TrackInfo } from '../types.js';
import { RemoteAdapter } from './remote-adapter.js';

type VoiceModuleLoader = () => Promise<any>;

interface VoiceSession {
  adapter: RemoteAdapter;
  connection: any;
  player: any;
  resource: any | undefined;
  cleanup: (() => void) | undefined;
  current: TrackInfo | undefined;
  basePositionMs: number;
  startedAtMs: number | undefined;
  stopping: boolean;
  destroyed: boolean;
}

export class VoiceManager {
  #voice: any;
  #sessions = new Map<string, VoiceSession>();

  constructor(
    private readonly config: Config,
    private readonly store: PlayerStore,
    private readonly events: EventBus,
    private readonly sources: SourceRegistry,
    private readonly voiceModuleLoader: VoiceModuleLoader = () => import('@discordjs/voice')
  ) {}

  async library(): Promise<any> {
    if (!this.#voice) this.#voice = await this.voiceModuleLoader();
    return this.#voice;
  }

  get sessionCount(): number { return this.#sessions.size; }

  async connect(guildId: string, channelId: string, shardId = 0, selfDeaf = true): Promise<void> {
    const existing = this.#sessions.get(guildId);
    if (existing) {
      const currentChannel = this.store.get(guildId, true)!.voice.channelId;
      if (currentChannel === channelId) return;
      this.disconnect(guildId);
    }

    if (this.#sessions.size >= this.config.audio.maxActivePlayers) {
      throw new LavaLensError('NODE_CAPACITY', 'O nó atingiu o limite de sessões de voz.', 503, {
        limit: this.config.audio.maxActivePlayers
      });
    }

    const voice = await this.library();
    const adapter = new RemoteAdapter(guildId, this.events);
    const connection = voice.joinVoiceChannel({
      guildId, channelId, adapterCreator: adapter.creator, selfDeaf, selfMute: false
    });
    const player = voice.createAudioPlayer({
      behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause }
    });
    connection.subscribe(player);

    const session: VoiceSession = {
      adapter,
      connection,
      player,
      resource: undefined,
      cleanup: undefined,
      current: undefined,
      basePositionMs: 0,
      startedAtMs: undefined,
      stopping: false,
      destroyed: false
    };
    this.#sessions.set(guildId, session);

    player.on(voice.AudioPlayerStatus.Playing, () => {
      if (session.destroyed) return;
      if (session.startedAtMs == null) session.startedAtMs = Date.now();
      this.store.update(guildId, { status: 'playing' }, 'TrackStarted');
    });
    player.on(voice.AudioPlayerStatus.Paused, () => {
      if (session.destroyed) return;
      this.syncPosition(guildId);
      session.startedAtMs = undefined;
      this.store.update(guildId, { status: 'paused' }, 'TrackPaused');
    });
    player.on(voice.AudioPlayerStatus.Idle, () => this.onIdle(guildId));
    player.on('error', (error: Error) => this.fail(guildId, error));

    connection.on(voice.VoiceConnectionStatus.Disconnected, () => {
      if (session.destroyed) return;
      const state = this.store.get(guildId, true)!;
      this.store.update(guildId, {
        status: 'reconnecting',
        voice: { ...state.voice, connected: false, reconnects: state.voice.reconnects + 1 }
      }, 'VoiceDisconnected');
    });
    connection.on(voice.VoiceConnectionStatus.Ready, () => {
      if (session.destroyed) return;
      const state = this.store.get(guildId, true)!;
      this.store.update(guildId, {
        voice: { ...state.voice, connected: true, channelId, shardId }
      }, 'VoiceConnected');
    });

    this.store.update(guildId, {
      voice: { ...this.store.get(guildId, true)!.voice, channelId, shardId }
    }, 'VoiceConnecting');
  }

  ingestUpdate(guildId: string, type: 'server' | 'state', payload: unknown): void {
    const session = this.#sessions.get(guildId);
    if (!session) throw new LavaLensError('VOICE_SESSION_NOT_FOUND', 'Sessão de voz não encontrada.', 404);
    session.adapter.update(type, payload);
  }

  async play(guildId: string, track: TrackInfo, offsetMs = 0): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (!session) throw new LavaLensError('VOICE_NOT_CONNECTED', 'Conecte o player a um canal de voz primeiro.', 409);
    if (!Number.isFinite(offsetMs) || offsetMs < 0) {
      throw new LavaLensError('INVALID_POSITION', 'positionMs deve ser um número maior ou igual a zero.', 400);
    }
    if (!track || typeof track.sourceId !== 'string') {
      throw new LavaLensError('INVALID_TRACK', 'A faixa não contém sourceId válido.', 400);
    }

    session.cleanup?.();
    session.cleanup = undefined;
    session.stopping = false;
    session.basePositionMs = offsetMs;
    session.startedAtMs = undefined;

    const source = await this.sources.require(track.sourceId).open(offsetMs);
    const voice = await this.library();
    const inputType = source.inputType === 'webm-opus' ? voice.StreamType.WebmOpus
      : source.inputType === 'ogg-opus' ? voice.StreamType.OggOpus
      : voice.StreamType.Arbitrary;
    const resource = voice.createAudioResource(source.stream, {
      inputType,
      metadata: track,
      inlineVolume: true
    });

    const state = this.store.get(guildId, true)!;
    resource.volume?.setVolume(Math.max(0, state.volume) / 100);
    session.resource = resource;
    session.cleanup = source.cleanup;
    session.current = track;
    session.player.play(resource);

    this.store.update(guildId, {
      status: 'loading',
      track,
      positionMs: offsetMs,
      error: undefined,
      audio: {
        ...state.audio,
        directPassthrough: source.directPassthrough,
        transcoding: !source.directPassthrough,
        sourceCodec: source.sourceCodec,
        sourceContainer: source.sourceContainer
      }
    }, 'TrackLoading');
  }

  pause(guildId: string): boolean {
    return Boolean(this.#sessions.get(guildId)?.player.pause(true));
  }

  resume(guildId: string): boolean {
    return Boolean(this.#sessions.get(guildId)?.player.unpause());
  }

  stop(guildId: string): boolean {
    const session = this.#sessions.get(guildId);
    if (!session) return false;
    session.stopping = true;
    this.syncPosition(guildId);
    session.startedAtMs = undefined;
    session.cleanup?.();
    session.cleanup = undefined;
    return Boolean(session.player.stop(true));
  }

  setVolume(guildId: string, volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 200) {
      throw new LavaLensError('INVALID_VOLUME', 'volume deve estar entre 0 e 200.', 400);
    }
    const session = this.#sessions.get(guildId);
    session?.resource?.volume?.setVolume(volume / 100);
    this.store.update(guildId, { volume }, 'VolumeChanged');
  }

  async seek(guildId: string, positionMs: number): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (!session?.current) throw new LavaLensError('NOTHING_PLAYING', 'Nenhuma música está tocando.', 409);
    if (!Number.isFinite(positionMs) || positionMs < 0 || (!session.current.seekable && positionMs > 0)) {
      throw new LavaLensError('INVALID_POSITION', 'A posição é inválida ou a faixa não permite seek.', 400);
    }
    await this.play(guildId, session.current, positionMs);
    this.events.emit('TrackSeeked', { positionMs }, guildId);
  }

  syncPosition(guildId: string): void {
    const session = this.#sessions.get(guildId);
    if (!session?.current) return;
    let positionMs = session.basePositionMs;
    if (session.startedAtMs != null) positionMs += Date.now() - session.startedAtMs;
    if (session.current.durationMs > 0) positionMs = Math.min(positionMs, session.current.durationMs);
    this.store.updateSilent(guildId, { positionMs: Math.max(0, Math.trunc(positionMs)) });
  }

  syncAllPositions(): void {
    for (const guildId of this.#sessions.keys()) this.syncPosition(guildId);
  }

  disconnect(guildId: string): void {
    const session = this.#sessions.get(guildId);
    if (!session) return;
    session.destroyed = true;
    session.stopping = true;
    session.startedAtMs = undefined;
    session.cleanup?.();
    session.cleanup = undefined;
    this.#sessions.delete(guildId);
    try { session.player.stop(true); } catch { /* already stopped */ }
    try { session.connection.destroy(); } catch { /* already destroyed */ }
    session.adapter.destroy();
    const state = this.store.get(guildId, true)!;
    this.store.update(guildId, {
      status: 'stopped',
      track: null,
      positionMs: 0,
      voice: { ...state.voice, connected: false }
    }, 'VoiceDisconnected');
  }

  onIdle(guildId: string): void {
    const session = this.#sessions.get(guildId);
    if (!session || session.destroyed) return;
    this.syncPosition(guildId);
    session.startedAtMs = undefined;
    session.cleanup?.();
    session.cleanup = undefined;
    session.resource = undefined;

    if (session.stopping) {
      session.stopping = false;
      session.current = undefined;
      session.basePositionMs = 0;
      this.store.update(guildId, { status: 'stopped', track: null, positionMs: 0 }, 'TrackStopped');
      return;
    }

    const state = this.store.get(guildId, true)!;
    const finished = session.current;
    let next: TrackInfo | null = null;

    if (state.queue.loopMode === 'track' && finished) {
      next = finished;
    } else {
      if (state.queue.loopMode === 'queue' && finished) this.store.enqueue(guildId, [finished]);
      next = this.store.shift(guildId);
    }

    if (next) {
      void this.play(guildId, next).catch((error) => this.fail(guildId, error));
      return;
    }

    session.current = undefined;
    session.basePositionMs = 0;
    this.store.update(guildId, { status: 'idle', track: null, positionMs: 0 }, 'TrackEnded');
  }

  fail(guildId: string, error: unknown): void {
    const session = this.#sessions.get(guildId);
    if (session) {
      session.startedAtMs = undefined;
      session.cleanup?.();
      session.cleanup = undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.store.update(guildId, {
      status: 'error',
      error: { code: 'AUDIO_ERROR', message, at: new Date().toISOString() }
    }, 'TrackFailed');
  }

  close(): void {
    for (const guildId of [...this.#sessions.keys()]) this.disconnect(guildId);
  }
}
