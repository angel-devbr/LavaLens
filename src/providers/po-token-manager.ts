import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { LavaLensError } from '../errors.js';

type CacheEntry = { token: string; expiresAt: number };

type PoTokenRuntime = {
  close?: () => void;
  generate: (contentBinding: string) => Promise<string>;
};

/**
 * Gera PO Tokens content-bound sob demanda.
 *
 * O YouTube passou a vincular muitos tokens ao ID do vídeo, portanto um único
 * token estático renovado por cron não é suficiente. Este gerenciador mantém a
 * infraestrutura BotGuard em memória, gera um token por vídeo e usa cache curto.
 */
export class PoTokenManager {
  readonly #cache = new Map<string, CacheEntry>();
  readonly #pending = new Map<string, Promise<string | undefined>>();
  #runtime?: Promise<PoTokenRuntime>;
  #closed = false;
  #lastFailureAt = 0;

  constructor(
    private readonly config: Config,
    private readonly runtimeFactory: (config: Config) => Promise<PoTokenRuntime> = createRuntime
  ) {}

  async get(contentBinding: string, forceRefresh = false): Promise<string | undefined> {
    if (!this.config.youtube.poTokenAutoEnabled) return this.config.youtube.poToken;
    if (this.#closed) throw new LavaLensError('YOUTUBE_POTOKEN_CLOSED', 'Gerenciador de PO Token encerrado.', 503);

    const now = Date.now();
    const cached = this.#cache.get(contentBinding);
    if (!forceRefresh && cached && cached.expiresAt > now) return cached.token;
    if (forceRefresh) this.#cache.delete(contentBinding);

    const existing = this.#pending.get(contentBinding);
    if (existing) return existing;

    const pending = this.#generateWithFallback(contentBinding).finally(() => {
      this.#pending.delete(contentBinding);
    });
    this.#pending.set(contentBinding, pending);
    return pending;
  }

  invalidate(contentBinding?: string): void {
    if (contentBinding) this.#cache.delete(contentBinding);
    else this.#cache.clear();
  }

  status() {
    const now = Date.now();
    return {
      enabled: this.config.youtube.poTokenAutoEnabled,
      cachedTokens: [...this.#cache.values()].filter((entry) => entry.expiresAt > now).length,
      pending: this.#pending.size,
      runtimeReady: Boolean(this.#runtime),
      staticFallbackConfigured: Boolean(this.config.youtube.poToken),
      lastFailureAt: this.#lastFailureAt || undefined
    };
  }

  close(): void {
    this.#closed = true;
    this.#cache.clear();
    this.#pending.clear();
    void this.#runtime?.then((runtime) => runtime.close?.()).catch(() => undefined);
  }

  async #generateWithFallback(contentBinding: string): Promise<string | undefined> {
    const now = Date.now();
    if (this.#lastFailureAt && now - this.#lastFailureAt < this.config.youtube.poTokenFailureCooldownMs) {
      return this.config.youtube.poToken;
    }

    try {
      const runtime = await this.#runtimeInstance();
      const token = await Promise.race([
        runtime.generate(contentBinding),
        delay(this.config.youtube.poTokenGenerationTimeoutMs).then(() => {
          throw new LavaLensError('YOUTUBE_POTOKEN_TIMEOUT', 'A geração automática do PO Token excedeu o limite.', 503);
        })
      ]);
      if (!token || token.length < 40) {
        throw new LavaLensError('YOUTUBE_POTOKEN_INVALID', 'O BotGuard retornou um PO Token inválido.', 503);
      }
      this.#remember(contentBinding, token);
      this.#lastFailureAt = 0;
      return token;
    } catch (error) {
      this.#lastFailureAt = Date.now();
      void this.#runtime?.then((runtime) => runtime.close?.()).catch(() => undefined);
      this.#runtime = undefined;
      if (this.config.youtube.poToken) return this.config.youtube.poToken;
      throw new LavaLensError(
        'YOUTUBE_POTOKEN_GENERATION_FAILED',
        'Não foi possível gerar automaticamente o PO Token do YouTube.',
        503,
        { cause: error instanceof Error ? error.message : String(error), contentBinding }
      );
    }
  }

  #remember(contentBinding: string, token: string): void {
    this.#cache.set(contentBinding, {
      token,
      expiresAt: Date.now() + this.config.youtube.poTokenCacheTtlMs
    });
    while (this.#cache.size > this.config.youtube.poTokenCacheMaxEntries) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#cache.delete(oldest);
    }
  }

  #runtimeInstance(): Promise<PoTokenRuntime> {
    if (!this.#runtime) this.#runtime = this.runtimeFactory(this.config);
    return this.#runtime;
  }
}

async function createRuntime(config: Config): Promise<PoTokenRuntime> {
  const [{ BG }, { JSDOM }] = await Promise.all([
    import('bgutils-js'),
    import('jsdom')
  ]);

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const window = dom.window as any;

  Object.assign(window, {
    fetch: globalThis.fetch.bind(globalThis),
    crypto: globalThis.crypto,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    Request: globalThis.Request,
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    atob: globalThis.atob,
    btoa: globalThis.btoa
  });

  let initializedFor: string | undefined;
  let challenge: any;

  return {
    close: () => dom.window.close(),
    generate: async (contentBinding: string) => {
      const bgConfig: any = {
        fetch: globalThis.fetch.bind(globalThis),
        globalObj: window,
        identifier: contentBinding,
        requestKey: config.youtube.poTokenRequestKey
      };

      if (!challenge || initializedFor !== contentBinding) {
        challenge = await BG.Challenge.create(bgConfig);
        if (!challenge) throw new Error('BotGuard não retornou challenge.');
        const script = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue
          ?? challenge.interpreterJavascript?.private_do_not_access_or_else_safe_script_wrapped_value;
        if (!script) throw new Error('Challenge do BotGuard sem interpreter JavaScript.');
        window.eval(String(script));
        initializedFor = contentBinding;
      }

      const result = await BG.PoToken.generate({
        program: challenge.program,
        globalName: challenge.globalName,
        bgConfig
      });
      return String(result?.poToken ?? '');
    }
  };
}
