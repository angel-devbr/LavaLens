import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { NAME, VERSION } from './version.js';

const config = loadConfig();
const app = createApp(config);

const log = (level: string, event: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, event, at: new Date().toISOString(), ...extra }));

/**
 * Erros de rede transitórios são esperados em streaming de áudio (a origem some,
 * o Discord fecha a conexão, o FFmpeg é morto no meio de um write). Esses casos
 * já são tratados perto da origem — nos streams dos providers, no FFmpeg e nos
 * sockets de SSE/WebSocket. Se ainda assim escaparem para o topo, registramos e
 * seguimos, porque derrubar o nó afetaria todos os outros players.
 *
 * Qualquer outra exceção é tratada como estado corrompido: fazemos desligamento
 * controlado (fecha conexões, encerra players) e saímos com código != 0 para que
 * o supervisor (systemd, Docker, Render) reinicie o processo limpo.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETRESET', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE'
]);

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  // undici embrulha a causa real em `cause`.
  const cause = (error as { cause?: unknown }).cause as NodeJS.ErrnoException | undefined;
  return Boolean(cause?.code && TRANSIENT_NETWORK_CODES.has(cause.code));
}

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(exitCode === 0 ? 'info' : 'error', 'shutdown', { signal, exitCode });
  // Se o fechamento travar, não deixamos o processo pendurado.
  const timer = setTimeout(() => process.exit(exitCode || 1), 10_000);
  timer.unref();
  try {
    await app.close();
  } catch (error) {
    log('error', 'shutdownFailed', { message: error instanceof Error ? error.message : String(error) });
  }
  process.exit(exitCode);
}

process.on('uncaughtException', (error: Error & { code?: string }) => {
  if (isTransientNetworkError(error)) {
    log('warn', 'transientNetworkError', { code: error.code, message: error.message });
    return;
  }
  log('error', 'uncaughtException', { code: error.code, message: error.message, stack: error.stack });
  void shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason: unknown) => {
  if (isTransientNetworkError(reason)) {
    const code = (reason as NodeJS.ErrnoException).code;
    log('warn', 'transientNetworkRejection', { code, message: (reason as Error).message });
    return;
  }
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log('error', 'unhandledRejection', { message: error.message, stack: error.stack });
  void shutdown('unhandledRejection', 1);
});

await app.server.listen();
log('info', 'started', {
  name: NAME,
  version: VERSION,
  nodeId: config.nodeId,
  address: `http://${config.host}:${config.port}`,
  youtubeOAuthRequired: config.youtube.enabled && config.youtube.oauthRequired,
  allowPrivateNetwork: config.allowPrivateNetwork
});

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
