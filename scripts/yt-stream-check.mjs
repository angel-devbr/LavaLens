#!/usr/bin/env node
/** Exercita exatamente o provider real, inclusive fallback SABR/googlevideo. */
import { loadConfig } from '../dist/config.js';
import { SourceRegistry } from '../dist/providers/provider.js';
import { YouTubeProvider } from '../dist/providers/youtube.js';

const video = process.argv[2] ?? 'dQw4w9WgXcQ';
const seconds = Number(process.argv[3] ?? 180);
const query = /^https?:/.test(video) ? video : `https://www.youtube.com/watch?v=${video}`;
const log = (...args) => console.log(new Date().toISOString(), ...args);

process.on('uncaughtException', (error) => { log('UNCAUGHT', error); process.exit(9); });
process.on('unhandledRejection', (error) => { log('UNHANDLED', error); process.exit(9); });

const config = loadConfig();
const sources = new SourceRegistry();
const provider = new YouTubeProvider(config, sources);
const resolved = await provider.resolve(query, 'yt-stream-check');
const track = resolved.tracks[0];
if (!track) throw new Error(`Nenhuma faixa resolvida: ${JSON.stringify(resolved.error ?? resolved.loadType)}`);
const stored = sources.get(track.sourceId);
if (!stored) throw new Error('StoredSource não encontrado.');
const opened = await stored.open(0);
log('OPEN', { title: track.title, inputType: opened.inputType, direct: opened.directPassthrough, container: opened.sourceContainer });

let bytes = 0;
let ended = false;
opened.stream.on('data', (chunk) => { bytes += chunk.length; });
opened.stream.on('end', () => { ended = true; log('END', { bytes }); });
opened.stream.on('error', (error) => { log('STREAM_ERROR', error); process.exitCode = 1; });
opened.stream.resume();

await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
log('SOBREVIVEU', { seconds, bytes, ended });
opened.cleanup?.();
