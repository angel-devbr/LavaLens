import { LavaLensError } from './errors.js';
import type { LoopMode, PlayerState, TrackInfo } from './types.js';

/** Garante que o corpo recebido é um objeto JSON (evita `null`, arrays e escalares). */
export function asObject(value: unknown, field = 'body'): Record<string, any> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LavaLensError('INVALID_BODY', `O corpo da requisição deve ser um objeto JSON (${field}).`, 400);
  }
  return value as Record<string, any>;
}

export function requireString(value: unknown, field: string, maxLength = 4096): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LavaLensError('INVALID_FIELD', `${field} é obrigatório e deve ser uma string não vazia.`, 400, { field });
  }
  if (value.length > maxLength) {
    throw new LavaLensError('INVALID_FIELD', `${field} excede ${maxLength} caracteres.`, 400, { field });
  }
  return value.trim();
}

export function requireFiniteNumber(value: unknown, field: string, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new LavaLensError('INVALID_FIELD', `${field} deve ser um número.`, 400, { field });
  }
  return Math.min(max, Math.max(min, parsed));
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new LavaLensError('INVALID_FIELD', `${field} deve ser booleano (true ou false).`, 400, { field });
  }
  return value;
}

export const LOOP_MODES: LoopMode[] = ['off', 'track', 'queue'];

export function requireLoopMode(value: unknown): LoopMode {
  if (typeof value !== 'string' || !LOOP_MODES.includes(value as LoopMode)) {
    throw new LavaLensError('INVALID_FIELD', `mode deve ser um de: ${LOOP_MODES.join(', ')}.`, 400, { field: 'mode' });
  }
  return value as LoopMode;
}

/** Valida uma faixa vinda do cliente (fila/play) sem confiar no formato. */
export function sanitizeTrack(value: unknown, index = 0): TrackInfo {
  const track = asObject(value, `tracks[${index}]`);
  const sourceId = requireString(track.sourceId, `tracks[${index}].sourceId`, 200);
  const durationMs = Number.isFinite(Number(track.durationMs)) ? Math.max(0, Number(track.durationMs)) : 0;
  return {
    id: typeof track.id === 'string' && track.id ? track.id.slice(0, 200) : sourceId,
    sourceId,
    title: typeof track.title === 'string' ? track.title.slice(0, 500) : 'Sem título',
    author: typeof track.author === 'string' ? track.author.slice(0, 300) : 'Desconhecido',
    source: typeof track.source === 'string' ? track.source.slice(0, 60) : 'unknown',
    uri: typeof track.uri === 'string' ? track.uri.slice(0, 2048) : '',
    ...(typeof track.artworkUrl === 'string' ? { artworkUrl: track.artworkUrl.slice(0, 2048) } : {}),
    ...(typeof track.album === 'string' ? { album: track.album.slice(0, 300) } : {}),
    ...(typeof track.isrc === 'string' ? { isrc: track.isrc.slice(0, 40) } : {}),
    durationMs,
    isLive: Boolean(track.isLive),
    seekable: Boolean(track.seekable),
    ...(typeof track.requestedBy === 'string' ? { requestedBy: track.requestedBy.slice(0, 120) } : {}),
    ...(track.providerData && typeof track.providerData === 'object' && !Array.isArray(track.providerData)
      ? { providerData: track.providerData as Record<string, unknown> }
      : {})
  };
}

export function sanitizeTrackList(value: unknown, field = 'tracks'): TrackInfo[] {
  if (!Array.isArray(value)) {
    throw new LavaLensError('TRACKS_REQUIRED', `${field} deve ser um array.`, 400, { field });
  }
  return value.map((item, index) => sanitizeTrack(item, index));
}

const PLAYBACK_STATUSES = new Set<PlayerState['status']>([
  'idle', 'loading', 'playing', 'paused', 'stopped', 'reconnecting', 'error'
]);

/**
 * Aceita apenas campos que o cliente pode alterar via PUT /player.
 * Campos derivados (voice, audio, positionMs, timestamps) são de responsabilidade do servidor.
 */
export function sanitizePlayerPatch(input: unknown): Partial<PlayerState> {
  const body = asObject(input);
  const patch: Partial<PlayerState> = {};

  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !PLAYBACK_STATUSES.has(body.status as PlayerState['status'])) {
      throw new LavaLensError('INVALID_FIELD', `status deve ser um de: ${[...PLAYBACK_STATUSES].join(', ')}.`, 400, { field: 'status' });
    }
    patch.status = body.status as PlayerState['status'];
  }
  if (body.volume !== undefined) patch.volume = requireFiniteNumber(body.volume, 'volume', 0, 200);
  if (body.filters !== undefined) patch.filters = asObject(body.filters, 'filters');
  if (body.extensions !== undefined) patch.extensions = asObject(body.extensions, 'extensions');
  if (body.playlist !== undefined) {
    const playlist = asObject(body.playlist, 'playlist');
    patch.playlist = {
      active: Boolean(playlist.active),
      ...(typeof playlist.id === 'string' ? { id: playlist.id.slice(0, 200) } : {}),
      ...(typeof playlist.name === 'string' ? { name: playlist.name.slice(0, 300) } : {}),
      ...(typeof playlist.uri === 'string' ? { uri: playlist.uri.slice(0, 2048) } : {}),
      ...(typeof playlist.artworkUrl === 'string' ? { artworkUrl: playlist.artworkUrl.slice(0, 2048) } : {}),
      ...(typeof playlist.owner === 'string' ? { owner: playlist.owner.slice(0, 200) } : {}),
      ...(Number.isFinite(Number(playlist.currentIndex)) ? { currentIndex: Number(playlist.currentIndex) } : {}),
      ...(Number.isFinite(Number(playlist.totalTracks)) ? { totalTracks: Number(playlist.totalTracks) } : {})
    };
  }
  if (body.queue !== undefined) {
    const queue = asObject(body.queue, 'queue');
    const partial: Partial<PlayerState['queue']> = {};
    if (queue.tracks !== undefined) partial.tracks = sanitizeTrackList(queue.tracks, 'queue.tracks');
    if (queue.loopMode !== undefined) partial.loopMode = requireLoopMode(queue.loopMode);
    if (queue.autoplay !== undefined) partial.autoplay = requireBoolean(queue.autoplay, 'queue.autoplay');
    patch.queue = partial as PlayerState['queue'];
  }
  return patch;
}

/** IDs do Discord são snowflakes numéricos; evita chaves absurdas e path traversal no store. */
export function requireSnowflake(value: string, field: string): string {
  if (!/^\d{1,25}$/.test(value)) {
    throw new LavaLensError('INVALID_ID', `${field} deve ser um ID numérico do Discord.`, 400, { field, value });
  }
  return value;
}
