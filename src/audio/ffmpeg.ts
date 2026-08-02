import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';
import type { OpenedAudioSource } from '../types.js';

export function buildFfmpegArgs(config: Config, input: string, offsetMs = 0, hasStdin = false): string[] {
  const profile = config.audio.profile;
  const bitrate = profile === 'eco' ? Math.min(96, config.audio.bitrateKbps)
    : profile === 'quality' ? Math.max(192, config.audio.bitrateKbps)
    : config.audio.bitrateKbps;
  const seekArgs = offsetMs > 0 ? ['-ss', (offsetMs / 1000).toFixed(3)] : [];
  return [
    '-hide_banner', '-loglevel', 'error',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    // Em arquivo/URL seekável, -ss antes de -i é rápido. Em pipe:0 isso não
    // funciona porque a entrada não permite seek; nesse caso -ss precisa ficar
    // depois de -i para o FFmpeg descartar/decodificar até o ponto correto.
    ...(!hasStdin ? seekArgs : []),
    '-i', input,
    ...(hasStdin ? seekArgs : []),
    '-vn', '-sn', '-dn',
    '-map_metadata', '-1',
    '-ac', '2', '-ar', '48000',
    '-c:a', 'libopus', '-application', 'audio',
    '-b:a', `${bitrate}k`, '-vbr', 'on',
    '-compression_level', profile === 'eco' ? '3' : profile === 'quality' ? '10' : '7',
    '-frame_duration', '20',
    '-f', 'ogg', 'pipe:1'
  ];
}

export class FfmpegPipeline {
  constructor(private readonly config: Config) {}

  /** Transcodifica um stream já aberto (ex.: download do YouTube) aplicando offset. */
  async openFromStream(input: NodeJS.ReadableStream, offsetMs = 0): Promise<OpenedAudioSource> {
    const opened = await this.open('pipe:0', offsetMs, input);
    return opened;
  }

  async open(input: string, offsetMs = 0, stdinStream?: NodeJS.ReadableStream): Promise<OpenedAudioSource> {
    const args = buildFfmpegArgs(this.config, input, offsetMs, Boolean(stdinStream));

    const child = spawn(this.config.audio.ffmpegPath, args, {
      stdio: [stdinStream ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    // O consumidor recebe um PassThrough: assim conseguimos propagar erros de
    // spawn (ENOENT) e de saída não-zero como 'error' de stream de verdade,
    // em vez de entregar um stdout que fecha silenciosamente.
    const output = new PassThrough();
    let settled = false;
    let stderr = '';
    let killed = false;

    const failStream = (error: Error) => {
      if (settled) return;
      settled = true;
      output.destroy(error);
    };

    if (stdinStream && child.stdin) {
      // EPIPE é esperado quando matamos o FFmpeg antes do fim do stream.
      child.stdin.on('error', () => { /* ignorado de propósito */ });
      stdinStream.on('error', (error: Error) => failStream(error));
      stdinStream.pipe(child.stdin);
    }

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });

    child.once('error', (error: NodeJS.ErrnoException) => {
      failStream(error.code === 'ENOENT'
        ? new LavaLensError('FFMPEG_NOT_FOUND', `FFmpeg não encontrado em "${this.config.audio.ffmpegPath}". Instale o FFmpeg ou ajuste FFMPEG_PATH.`, 503)
        : error);
    });

    child.once('close', (code, signal) => {
      if (killed || signal === 'SIGKILL') return;
      if (code && code !== 0) {
        failStream(new Error(stderr.trim() || `FFmpeg encerrou com código ${code}.`));
      } else {
        settled = true;
      }
    });

    child.stdout?.once('error', failStream);
    child.stdout?.pipe(output);

    return {
      stream: output,
      inputType: 'ogg-opus',
      directPassthrough: false,
      sourceCodec: 'unknown',
      sourceContainer: 'unknown',
      cleanup: () => {
        killed = true;
        settled = true;
        if (stdinStream) { stdinStream.unpipe?.(child.stdin ?? undefined); (stdinStream as any).destroy?.(); }
        child.stdout?.unpipe(output);
        if (!child.killed) child.kill('SIGKILL');
        output.destroy();
      }
    };
  }
}
