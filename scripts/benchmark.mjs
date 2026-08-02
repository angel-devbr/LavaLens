import { EventBus } from '../dist/event-bus.js';
import { PlayerStore } from '../dist/player-store.js';
const count = Number(process.argv[2] ?? 10000);
const config = {
  stateTtlMs: 3600000,
  audio: { bitrateKbps: 96, bufferMs: 300, maxQueueSize: 100 }
};
const events = new EventBus(1);
const store = new PlayerStore(config, events);
const before = process.memoryUsage().rss;
const started = performance.now();
for (let i = 0; i < count; i++) store.create(String(i));
const elapsed = performance.now() - started;
const after = process.memoryUsage().rss;
console.log(JSON.stringify({ players: count, elapsedMs: elapsed, rssBefore: before, rssAfter: after, rssDelta: after - before }, null, 2));
store.close();
