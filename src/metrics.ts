import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadavg } from 'node:os';
import type { NodeSnapshot } from './types.js';

export class Metrics {
  #startedAt = Date.now();
  #cpuStart = process.cpuUsage();
  #wallStart = process.hrtime.bigint();
  #eventLoop = monitorEventLoopDelay({ resolution: 20 });

  constructor() { this.#eventLoop.enable(); }

  snapshot(nodeId: string, activePlayers: number, totalPlayers: number): NodeSnapshot {
    const cpu = process.cpuUsage(this.#cpuStart);
    const wallMicros = Number(process.hrtime.bigint() - this.#wallStart) / 1000;
    const percent = wallMicros > 0 ? ((cpu.user + cpu.system) / wallMicros) * 100 : 0;
    return {
      id: nodeId,
      version: '0.1.0-alpha.1',
      uptimeMs: Date.now() - this.#startedAt,
      memory: process.memoryUsage(),
      cpu: { userMicros: cpu.user, systemMicros: cpu.system, percentEstimate: Number(percent.toFixed(2)) },
      activePlayers,
      totalPlayers,
      eventLoopDelayMs: Number((this.#eventLoop.mean / 1e6).toFixed(2)),
      loadAverage: loadavg()
    };
  }
}
