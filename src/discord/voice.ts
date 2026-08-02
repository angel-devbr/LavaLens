import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { EventBus } from '../event-bus.js';
import type { PlayerStore } from '../player-store.js';
import type { SourceRegistry } from '../providers/provider.js';
import type { TrackInfo } from '../types.js';
import { RemoteAdapter } from './remote-adapter.js';

interface VoiceSession {
  adapter: RemoteAdapter;
  connection: any;
  player: any;
  cleanup: (() => void) | undefined;
  current: TrackInfo | undefined;
  resource: any;
  channelId: string;
  /** Evita que o avanço automático da fila rode duas vezes para o mesmo fim de faixa. */
  advancing: boolean;
  /** Marca parada explícita (comando stop) para o onIdle não tratar como fim natural. */
  stopping: boolean;
  /** Posição absoluta em que o recurso atual começou (seek/reabertura por volume). */
  basePositionMs: number;
}

export class VoiceManager {
  #voice: any;
  #sessions = new Map<string, VoiceSession>();
  #poll: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly store: PlayerStore,
    private readonly events: EventBus,
    private readonly sources: SourceRegistry,
    voiceLibrary?: any
  ) {
    this.#voice = voiceLibrary;
    // Atualiza posição/ping/ouvintes periodicamente: o estado prometido pelo README
    // só é "rico" se esses campos forem realmente preenchidos.
    this.#poll = setInterval(() => this.tick(), 1000);
    this.#poll.unref();
  }

  /** Número de sessões de voz reais (não confia no campo `status`, que o cliente pode alterar). */
  activeSessions(): number { return this.#sessions.size; }
  hasSession(guildId: string): boolean { return this.#sessions.has(guildId); }

  async library(): Promise<any> {
    if (!this.#voice) this.#voice = await import('@discordjs/voice');
    return this.#voice;
  }

  async connect(guildId: string, channelId: string, shardId = 0, selfDeaf = true): Promise<void> {
    const existing = this.#sessions.get(guildId);
    if (existing) {
      if (existing.channelId === channelId) return;
      // Trocar de canal: recria a sessão em vez de ignorar o pedido silenciosamente.
      this.disconnect(guildId);
    }
    if (this.#sessions.size >= this.config.audio.maxActivePlayers) {
      throw new LavaLensError('NODE_CAPACITY', 'O nó atingiu o limite de players ativos.', 503, {
        limit: this.config.audio.maxActivePlayers,
        active: this.#sessions.size
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
      adapter, connection, player, cleanup: undefined, current: undefined,
      resource: undefined, channelId, advancing: false, stopping: false, basePositionMs: 0
    };
    this.#sessions.set(guildId, session);

    player.on(voice.AudioPlayerStatus.Playing, () => this.store.update(guildId, { status: 'playing' }, 'TrackStarted'));
    player.on(voice.AudioPlayerStatus.Paused, () => this.store.update(guildId, { status: 'paused' }, 'TrackPaused'));
    player.on(voice.AudioPlayerStatus.AutoPaused, () => this.store.update(guildId, { status: 'paused' }, 'TrackPaused'));
    player.on(voice.AudioPlayerStatus.Idle, () => void this.onIdle(guildId));
    player.on('error', (error: Error) => this.fail(guildId, error));

    connection.on(voice.VoiceConnectionStatus.Disconnected, () => {
      const state = this.store.get(guildId, true)!;
      this.store.update(guildId, {
        status: 'reconnecting',
        voice: { ...state.voice, connected: false, reconnects: state.voice.reconnects + 1 }
      }, 'VoiceDisconnected');
    });
    connection.on(voice.VoiceConnectionStatus.Ready, () => {
      const state = this.store.get(guildId, true)!;
      this.store.update(guildId, {
        voice: { ...state.voice, connected: true, channelId, shardId, ...this.transportInfo(session) }
      }, 'VoiceConnected');
    });
    connection.on('error', (error: Error) => this.fail(guildId, error));

    this.store.update(guildId, {
      voice: { ...this.store.get(guildId, true)!.voice, channelId, shardId, connected: false }
    }, 'VoiceConnecting');
  }

  /** Extrai ping/criptografia/DAVE da conexão para o estado observável. */
  private transportInfo(session: VoiceSession): Record<string, unknown> {
    const info: Record<string, unknown> = {};
    try {
      const ping = session.connection?.ping;
      if (ping && typeof ping.ws === 'number') info.pingMs = ping.ws;
      const networking = session.connection?.state?.networking?.state;
      if (networking?.connectionData?.encryptionMode) info.transportEncryption = networking.connectionData.encryptionMode;
      if (networking?.connectionOptions?.endpoint) info.endpoint = networking.connectionOptions.endpoint;
      const dave = networking?.dave;
      if (dave) {
        if (typeof dave.protocolVersion === 'number') info.daveProtocolVersion = dave.protocolVersion;
        if (typeof dave.lastTransitionId === 'number') info.daveEpoch = dave.lastTransitionId;
      }
    } catch { /* observabilidade nunca deve derrubar o player */ }
    return info;
  }

  private currentPosition(session: VoiceSession, statePositionMs: number): number {
    const elapsed = typeof session.resource?.playbackDuration === 'number'
      ? Math.max(0, session.resource.playbackDuration)
      : 0;
    return session.resource ? session.basePositionMs + elapsed : statePositionMs;
  }

  private tick(): void {
    for (const [guildId, session] of this.#sessions) {
      const state = this.store.get(guildId);
      if (!state) continue;
      const rawPosition = this.currentPosition(session, state.positionMs);
      const positionMs = state.track?.durationMs && !state.track.isLive
        ? Math.min(rawPosition, state.track.durationMs)
        : rawPosition;
      const transport = this.transportInfo(session);
      const changed = positionMs !== state.positionMs ||
        Object.entries(transport).some(([key, value]) => (state.voice as any)[key] !== value);
      if (!changed) continue;
      // Atualização silenciosa: não emite evento por segundo para não inundar SSE/WS.
      this.store.patchSilently(guildId, {
        positionMs,
        voice: { ...state.voice, ...transport }
      });
    }
  }

  ingestUpdate(guildId: string, type: 'server' | 'state', payload: unknown): void {
    const session = this.#sessions.get(guildId);
    if (!session) throw new LavaLensError('VOICE_SESSION_NOT_FOUND', 'Sessão de voz não encontrada.', 404);
    session.adapter.update(type, payload);
    if (type === 'state' && payload && typeof payload === 'object') {
      const channelId = (payload as any).channel_id;
      if (typeof channelId === 'string') session.channelId = channelId;
    }
  }

  async play(guildId: string, track: TrackInfo, offsetMs = 0): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (!session) throw new LavaLensError('VOICE_NOT_CONNECTED', 'Conecte o player a um canal de voz primeiro.', 409);

    const stored = this.sources.get(track.sourceId);
    if (!stored) {
      throw new LavaLensError('SOURCE_EXPIRED', 'A fonte da faixa expirou. Resolva a busca novamente.', 410, {
        sourceId: track.sourceId
      });
    }

    session.cleanup?.();
    session.cleanup = undefined;

    let source;
    try {
      source = await stored.open(offsetMs);
    } catch (error) {
      this.fail(guildId, error);
      throw error instanceof LavaLensError
        ? error
        : new LavaLensError('SOURCE_OPEN_FAILED', error instanceof Error ? error.message : String(error), 502);
    }

    const voice = await this.library();
    const inputType = source.inputType === 'webm-opus' ? voice.StreamType.WebmOpus
      : source.inputType === 'ogg-opus' ? voice.StreamType.OggOpus
      : voice.StreamType.Arbitrary;
    const stateBeforePlay = this.store.get(guildId, true)!;
    // O volume inline custa CPU porque exige transformar o fluxo Opus. Para manter
    // o caminho ultraleve, ele só é ativado quando o volume difere de 100%.
    const inlineVolume = stateBeforePlay.volume !== 100;
    const resource = voice.createAudioResource(source.stream, { inputType, metadata: track, inlineVolume });
    if (inlineVolume && resource.volume) resource.volume.setVolume(stateBeforePlay.volume / 100);

    // Erro no stream de origem precisa virar estado de erro, não crash silencioso.
    source.stream.on?.('error', (error: Error) => this.fail(guildId, error));

    session.cleanup = source.cleanup;
    session.current = track;
    session.resource = resource;
    session.basePositionMs = offsetMs;
    session.advancing = false;
    session.stopping = false;
    session.player.play(resource);

    this.store.update(guildId, {
      status: 'loading',
      track,
      positionMs: offsetMs,
      error: undefined,
      audio: {
        ...this.store.get(guildId, true)!.audio,
        directPassthrough: source.directPassthrough && !inlineVolume,
        transcoding: !source.directPassthrough || inlineVolume,
        sourceCodec: source.sourceCodec,
        sourceContainer: source.sourceContainer
      }
    }, 'TrackLoading');
  }

  pause(guildId: string): boolean { return Boolean(this.#sessions.get(guildId)?.player.pause(true)); }
  resume(guildId: string): boolean { return Boolean(this.#sessions.get(guildId)?.player.unpause()); }

  /** Aplica volume real. Só recria a fonte quando sai do passthrough de 100%. */
  async setVolume(guildId: string, volume: number): Promise<void> {
    const state = this.store.get(guildId, true)!;
    this.store.update(guildId, { volume }, 'VolumeChanged');
    const session = this.#sessions.get(guildId);
    if (!session?.current || !session.resource) return;

    const positionMs = this.currentPosition(session, state.positionMs);

    if (session.resource.volume && volume !== 100) {
      session.resource.volume.setVolume(volume / 100);
      return;
    }
    if (!session.resource.volume && volume === 100) return;

    // Ao sair de 100%, reabre com volume inline. Ao voltar para 100%, reabre
    // sem transformer para recuperar Opus passthrough e reduzir CPU.
    await this.play(guildId, session.current, positionMs);
  }

  /** stop() encerra a faixa atual; `skip` mantém a fila para avançar. */
  stop(guildId: string, skip = false): boolean {
    const session = this.#sessions.get(guildId);
    if (!session) return false;
    if (!skip) {
      // Parada explícita: limpa a fila e sinaliza para onIdle não avançar nem falhar.
      session.stopping = true;
      const state = this.store.get(guildId, true)!;
      if (state.queue.tracks.length) {
        this.store.update(guildId, { queue: { ...state.queue, tracks: [] } }, 'QueueChanged');
      }
      session.current = undefined;
      session.cleanup?.();
      session.cleanup = undefined;
      session.resource = undefined;
      session.basePositionMs = 0;
    }
    return Boolean(session.player.stop(true));
  }

  async seek(guildId: string, positionMs: number): Promise<void> {
    const session = this.#sessions.get(guildId);
    if (!session?.current) throw new LavaLensError('NOTHING_PLAYING', 'Nenhuma música está tocando.', 409);
    if (!Number.isFinite(positionMs) || positionMs < 0) {
      throw new LavaLensError('INVALID_FIELD', 'positionMs deve ser um número não negativo.', 400, { field: 'positionMs' });
    }
    if (session.current.isLive) {
      throw new LavaLensError('NOT_SEEKABLE', 'Não é possível buscar em transmissões ao vivo.', 409);
    }
    await this.play(guildId, session.current, positionMs);
    this.events.emit('TrackSeeked', { positionMs }, guildId);
  }

  disconnect(guildId: string): void {
    const session = this.#sessions.get(guildId);
    if (!session) return;
    this.#sessions.delete(guildId);
    try { session.cleanup?.(); } catch { /* já encerrado */ }
    try { session.player.stop(true); } catch { /* já encerrado */ }
    try { session.connection.destroy(); } catch { /* já destruída */ }
    try { session.adapter.destroy(); } catch { /* já destruído */ }
    const state = this.store.get(guildId, true)!;
    this.store.update(guildId, {
      status: 'stopped',
      positionMs: 0,
      voice: { ...state.voice, connected: false }
    }, 'VoiceDisconnected');
  }

  async onIdle(guildId: string): Promise<void> {
    const session = this.#sessions.get(guildId);
    const state = this.store.get(guildId);
    if (!session || !state) return;
    if (session.advancing) return;

    // Parada explícita: apenas volta para 'stopped', sem avançar fila nem gerar erro.
    if (session.stopping) {
      session.stopping = false;
      session.current = undefined;
      session.resource = undefined;
      session.basePositionMs = 0;
      this.store.update(guildId, { status: 'stopped', track: null, positionMs: 0 }, 'TrackEnded');
      return;
    }

    session.advancing = true;

    try {
      const finished = session.current;
      this.events.emit('TrackEnded', { track: finished ?? null, reason: 'finished' }, guildId);

      // loopMode=track: repete a mesma faixa.
      if (state.queue.loopMode === 'track' && finished) {
        await this.play(guildId, finished, 0);
        return;
      }

      const next = this.store.shift(guildId);
      if (next) {
        // loopMode=queue: devolve a faixa concluída ao fim da fila.
        if (state.queue.loopMode === 'queue' && finished) this.store.enqueue(guildId, [finished]);
        await this.play(guildId, next);
        return;
      }

      // Fila vazia com loopMode=queue: recomeça pela faixa que acabou.
      if (state.queue.loopMode === 'queue' && finished) {
        await this.play(guildId, finished, 0);
        return;
      }

      session.current = undefined;
      session.resource = undefined;
      session.basePositionMs = 0;
      this.store.update(guildId, { status: 'idle', track: null, positionMs: 0 }, 'QueueEnded');
    } catch (error) {
      this.fail(guildId, error);
    } finally {
      session.advancing = false;
    }
  }

  fail(guildId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof LavaLensError ? error.code : 'AUDIO_ERROR';
    this.store.update(guildId, {
      status: 'error',
      error: { code, message, at: new Date().toISOString() }
    }, 'TrackFailed');
  }

  close(): void {
    clearInterval(this.#poll);
    for (const guildId of [...this.#sessions.keys()]) this.disconnect(guildId);
  }
}
