import { spawn } from 'node:child_process';
import type { Config } from '../config.js';
import type { OpenedAudioSource } from '../types.js';

export class FfmpegPipeline {
  constructor(private readonly config: Config) {}

  async open(input: string, offsetMs = 0): Promise<OpenedAudioSource> {
    const profile = this.config.audio.profile;
    const bitrate = profile === 'eco' ? Math.min(96, this.config.audio.bitrateKbps)
      : profile === 'quality' ? Math.max(192, this.config.audio.bitrateKbps)
      : this.config.audio.bitrateKbps;
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      ...(offsetMs > 0 ? ['-ss', (offsetMs / 1000).toFixed(3)] : []),
      '-i', input,
      '-vn', '-sn', '-dn',
      '-map_metadata', '-1',
      '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-application', 'audio',
      '-b:a', `${bitrate}k`, '-vbr', 'on',
      '-compression_level', profile === 'eco' ? '3' : profile === 'quality' ? '10' : '7',
      '-frame_duration', '20',
      '-f', 'ogg', 'pipe:1'
    ];
    const child = spawn(this.config.audio.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', (error) => child.stdout.destroy(error));
    child.once('exit', (code) => {
      if (code && code !== 0 && !child.killed) child.stdout.destroy(new Error(stderr || `FFmpeg encerrou com código ${code}`));
    });
    return {
      stream: child.stdout,
      inputType: 'ogg-opus',
      directPassthrough: false,
      sourceCodec: 'unknown',
      sourceContainer: 'unknown',
      cleanup: () => child.kill('SIGKILL')
    };
  }
}
