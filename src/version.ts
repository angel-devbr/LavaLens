import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Fonte única da versão: lida do package.json em tempo de execução.
 * Evita que `/health`, `/v1/status`, o log de inicialização e o User-Agent
 * saiam de sincronia entre si a cada release (já aconteceu no alpha.1).
 */
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/version.js -> raiz do pacote
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
export const NAME = 'LavaLens Native';
export const USER_AGENT = `LavaLens-Native/${VERSION}`;
