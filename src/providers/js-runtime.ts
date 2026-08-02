import { createContext, runInContext } from 'node:vm';

/**
 * Interpretador JavaScript para o youtubei.js.
 *
 * O youtubei.js 17.x não executa o player obfuscado por padrão. Este adaptador
 * usa node:vm, sem dependências extras, e preserva os Web APIs mínimos que o
 * player pode referenciar durante a decifragem.
 *
 * node:vm não é uma fronteira de segurança para código hostil. O código avaliado
 * vem do player oficial obtido pelo youtubei.js; o timeout existe para impedir que
 * uma mudança ou regressão trave o event loop indefinidamente.
 */

export interface BuildScriptResult {
  output: string;
  exported: string[];
  exportedRawValues?: Record<string, unknown>;
}

function readTimeout(): number {
  const parsed = Number.parseInt(process.env.YOUTUBE_JS_EVAL_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.min(15_000, Math.max(100, parsed));
}

const EVAL_TIMEOUT_MS = readTimeout();
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield'
]);

function safeIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) && !RESERVED.has(value);
}

export function evaluatePlayerScript(
  data: BuildScriptResult,
  env: Record<string, unknown>
): Record<string, unknown> {
  if (!data || typeof data.output !== 'string') {
    throw new TypeError('O script do player do YouTube é inválido.');
  }

  // Contexto mínimo. Não expõe require, process, module nem acesso ao filesystem.
  // Alguns players extraídos usam Web APIs globais, então fornecemos apenas os
  // construtores/funções de dados necessários à decifragem.
  const sandbox: Record<string, unknown> = Object.create(null);
  sandbox.console = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.atob = atob;
  sandbox.btoa = btoa;
  sandbox.structuredClone = structuredClone;
  if (globalThis.crypto) sandbox.crypto = globalThis.crypto;

  const context = createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });
  context.__env = env ?? {};

  // O contrato atual do youtubei.js acrescenta um `return process(...)` no nível
  // superior. Por isso o código precisa estar dentro de uma função. Os argumentos
  // são expostos apenas quando seus nomes são identificadores JavaScript seguros;
  // o fluxo atual usa n, sig e sp.
  const argNames = Object.keys(env ?? {}).filter(safeIdentifier);
  const argsLiteral = argNames.map((name) => `__env[${JSON.stringify(name)}]`).join(',');
  const source = `(function(${argNames.join(',')}){${data.output}\n})(${argsLiteral});`;

  const result = runInContext(source, context, {
    timeout: EVAL_TIMEOUT_MS,
    displayErrors: true
  }) as unknown;

  if (typeof result !== 'object' || result === null) {
    throw new Error('O script do player do YouTube não retornou um objeto.');
  }
  return result as Record<string, unknown>;
}

let installed = false;

/** Registra o interpretador antes de qualquer Innertube.create(). */
export async function installJsRuntime(): Promise<void> {
  if (installed) return;
  const { Platform } = await import('youtubei.js');
  const platform = Platform as unknown as {
    shim?: Record<string, unknown>;
  };
  if (!platform?.shim) throw new Error('O Platform shim do youtubei.js não está disponível.');
  platform.shim.eval = evaluatePlayerScript as unknown as never;
  installed = true;
}
