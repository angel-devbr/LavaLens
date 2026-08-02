import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { EventBus } from '../event-bus.js';
import type { PlayerStore } from '../player-store.js';
import type { SourceRegistry } from '../providers/provider.js';
import type { TrackInfo } from '../types.js';
import { RemoteAdapter } from './remote-adapter.js';

interface VoiceSession { adapter: RemoteAdapter; connection: any; player: any; cleanup: (() => void) | undefined; current: TrackInfo | undefined; }

export class VoiceManager {
  #voice: any;
  #sessions = new Map<string, VoiceSession>();
  constructor(
    private readonly config: Config,
    private readonly store: PlayerStore,
    private readonly events: EventBus,
    private readonly sources: SourceRegistry
  ) {}

  async library(): Promise<any> {
    if (!this.#voice) this.#voice = await import('@discordjs/voice');
    return this.#voice;
  }

  async connect(guildId: string, channelId: string, shardId = 0, selfDeaf = true): Promise<void> {
    if (this.#sessions.has(guildId)) return;
    if (this.store.activeCount() >= this.config.audio.maxActivePlayers) {
      throw new LavaLensError('NODE_CAPACITY', 'O nó atingiu o limite de players ativos.', 503, {
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
    const session: VoiceSession = { adapter, connection, player, cleanup: undefined, current: undefined };
    this.#sessions.set(guildId, session);

    player.on(voice.AudioPlayerStatus.Playing, () => this.store.update(guildId, { status: 'playing' }, 'TrackStarted'));
    player.on(voice.AudioPlayerStatus.Paused, () => this.store.update(guildId, { status: 'paused' }, 'TrackPaused'));
    player.on(voice.AudioPlayerStatus.Idle, () => this.onIdle(guildId));
    player.on('error', (error: Error) => this.fail(guildId, error));
    connection.on(voice.VoiceConnectionStatus.Disconnected, () => {
      const state = this.store.get(guildId, true)!;
      this.store.update(guildId, { status: 'reconnecting', voice: { ...state.voice, connected: false, reconnects: state.voice.reconnects + 1 } }, 'VoiceDisconnected');
    });
    connection.on(voice.VoiceConnectionStatus.Ready, () => {
      const state = this.store.get(guildId, true)!;
      this.store.update(guildId, { voice: { ...state.voice, connected: true, channelId, shardId } }, 'VoiceConnected');
    });
    this.store.update(guildId, { voice: { ...this.store.get(guildId, true)!.voice, channelId, shardId } }, 'VoiceConnecting');
  }

  ingestUpdate(guildId: string, type: 'server' | 'state', payload: unknown): void {
    const session = this.#sessions.get(guildId);
    if (!session) throw new LavaLensError('VOICE_SESSION_NOT_FOUND', 'Sessão de voz não encontrada.', 404);
    session.adapter.update(type, payload);
  }

  async play(guildId: string, track: TrackInfo, offsetMs = 0): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (!session) throw new LavaLensError('VOICE_NOT_CONNECTED', 'Conecte o player a um canal de voz primeiro.', 409);
    session.cleanup?.();
    const source = await this.sources.require(track.sourceId).open(offsetMs);
    const voice = await this.library();
    const inputType = source.inputType === 'webm-opus' ? voice.StreamType.WebmOpus
      : source.inputType === 'ogg-opus' ? voice.StreamType.OggOpus
      : voice.StreamType.Arbitrary;
    const resource = voice.createAudioResource(source.stream, { inputType, metadata: track });
    session.cleanup = source.cleanup;
    session.current = track;
    session.player.play(resource);
    this.store.update(guildId, {
      status: 'loading', track, positionMs: offsetMs,
      audio: {
        ...this.store.get(guildId, true)!.audio,
        directPassthrough: source.directPassthrough,
        transcoding: !source.directPassthrough,
        sourceCodec: source.sourceCodec,
        sourceContainer: source.sourceContainer
      }
    }, 'TrackLoading');
  }

  pause(guildId: string): boolean { return Boolean(this.#sessions.get(guildId)?.player.pause(true)); }
  resume(guildId: string): boolean { return Boolean(this.#sessions.get(guildId)?.player.unpause()); }
  stop(guildId: string): boolean { return Boolean(this.#sessions.get(guildId)?.player.stop(true)); }

  async seek(guildId: string, positionMs: number): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (!session?.current) throw new LavaLensError('NOTHING_PLAYING', 'Nenhuma música está tocando.', 409);
    await this.play(guildId, session.current, positionMs);
    this.events.emit('TrackSeeked', { positionMs }, guildId);
  }

  disconnect(guildId: string): void {
    const session = this.#sessions.get(guildId);
    if (!session) return;
    session.cleanup?.();
    session.player.stop(true);
    session.connection.destroy();
    session.adapter.destroy();
    this.#sessions.delete(guildId);
    const state = this.store.get(guildId, true)!;
    this.store.update(guildId, { status: 'stopped', voice: { ...state.voice, connected: false } }, 'VoiceDisconnected');
  }

  onIdle(guildId: string): void {
    const state = this.store.get(guildId);
    if (!state) return;
    const next = this.store.shift(guildId);
    if (next) void this.play(guildId, next).catch((error) => this.fail(guildId, error));
    else this.store.update(guildId, { status: 'idle', track: null, positionMs: 0 }, 'TrackEnded');
  }

  fail(guildId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.update(guildId, { status: 'error', error: { code: 'AUDIO_ERROR', message, at: new Date().toISOString() } }, 'TrackFailed');
  }

  close(): void { for (const guildId of this.#sessions.keys()) this.disconnect(guildId); }
}
