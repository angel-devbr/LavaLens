export type PlaybackStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'reconnecting'
  | 'error';

export interface Artwork {
  url: string;
  width?: number;
  height?: number;
}

export interface TrackInfo {
  id: string;
  sourceId: string;
  title: string;
  author: string;
  source: string;
  uri: string;
  artworkUrl?: string;
  album?: string;
  isrc?: string;
  durationMs: number;
  isLive: boolean;
  seekable: boolean;
  requestedBy?: string;
  providerData?: Record<string, unknown>;
}

export interface PlaylistInfo {
  active: boolean;
  id?: string;
  name?: string;
  uri?: string;
  artworkUrl?: string;
  owner?: string;
  currentIndex?: number;
  totalTracks?: number;
}

export interface VoiceInfo {
  connected: boolean;
  guildId: string;
  channelId?: string;
  shardId?: number;
  botUserId?: string;
  region?: string;
  endpoint?: string;
  listeners: number;
  pingMs?: number;
  daveProtocolVersion?: number;
  daveEpoch?: number;
  transportEncryption?: string;
  reconnects: number;
}

export interface AudioInfo {
  sourceCodec?: string;
  sourceContainer?: string;
  outputCodec: 'opus';
  sampleRate: 48000;
  channels: 2;
  bitrateKbps: number;
  directPassthrough: boolean;
  transcoding: boolean;
  bufferMs: number;
  packetLossPercent: number;
  underruns: number;
}

export type LoopMode = 'off' | 'track' | 'queue';

export interface QueueInfo {
  tracks: TrackInfo[];
  loopMode: LoopMode;
  autoplay: boolean;
}

export interface PlayerState {
  guildId: string;
  status: PlaybackStatus;
  track: TrackInfo | null;
  playlist: PlaylistInfo;
  voice: VoiceInfo;
  audio: AudioInfo;
  queue: QueueInfo;
  volume: number;
  positionMs: number;
  filters: Record<string, unknown>;
  error?: { code: string; message: string; at: string };
  createdAt: string;
  updatedAt: string;
  extensions: Record<string, unknown>;
}

export interface NodeSnapshot {
  id: string;
  version: string;
  uptimeMs: number;
  memory: NodeJS.MemoryUsage;
  cpu: { userMicros: number; systemMicros: number; percentEstimate: number };
  activePlayers: number;
  totalPlayers: number;
  eventLoopDelayMs: number;
  loadAverage: number[];
}

export interface LavaEvent<T = unknown> {
  id: number;
  type: string;
  guildId?: string;
  at: string;
  data: T;
}

export interface ResolvedItem {
  loadType: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  tracks: TrackInfo[];
  playlist?: PlaylistInfo;
  error?: { code: string; message: string };
}

export interface OpenedAudioSource {
  stream: NodeJS.ReadableStream;
  /** Duração conhecida da fonte, quando o provider consegue informar. */
  durationMs?: number;
  inputType: 'webm-opus' | 'ogg-opus' | 'arbitrary';
  directPassthrough: boolean;
  sourceCodec?: string;
  sourceContainer?: string;
  cleanup?: () => void;
}

export interface StoredSource {
  sourceId: string;
  provider: string;
  open(offsetMs?: number): Promise<OpenedAudioSource>;
  expiresAt: number;
}
