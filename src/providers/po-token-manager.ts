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
 * O YouTube vincula os tokens de mídia ao ID do vídeo. Este gerenciador mantém
 * o minter BotGuard em memória, gera um token para cada vídeo e usa cache curto.
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
  const [botguard, webpo, utils, jsdom] = await Promise.all([
    import('bgutils-js/botguard'),
    import('bgutils-js/webpo'),
    import('bgutils-js/utils'),
    import('jsdom')
  ]);

  const { BotGuardClient, getChallenge } = botguard;
  const { WebPoMinter } = webpo;
  const { buildURL, getHeaders } = utils;
  const { JSDOM } = jsdom;

  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });

  const runtimeGlobal = dom.window as unknown as typeof globalThis;
  Object.assign(runtimeGlobal, {
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

  let minter: InstanceType<typeof WebPoMinter> | undefined;
  let minterExpiresAt = 0;
  let initializing: Promise<void> | undefined;

  const initialize = async (): Promise<void> => {
    const now = Date.now();
    if (minter && minterExpiresAt > now + 60_000) return;
    if (initializing) return initializing;

    initializing = (async () => {
      const challenge = await getChallenge({
        fetchFunction: globalThis.fetch.bind(globalThis),
        requestKey: config.youtube.poTokenRequestKey
      });
      const interpreterJavascript = challenge.interpreterJavascript
        ?.privateDoNotAccessOrElseSafeScriptWrappedValue;
      if (!interpreterJavascript) throw new Error('Challenge do BotGuard sem interpreter JavaScript.');

      dom.window.eval(String(interpreterJavascript));
      const botGuardClient = await BotGuardClient.create({
        program: challenge.program,
        globalName: challenge.globalName,
        globalObject: runtimeGlobal
      });

      const webPoSignalOutput: unknown[] = [];
      const botguardResponse = await botGuardClient.snapshot({ webPoSignalOutput });
      const response = await fetch(buildURL('GenerateIT', false), {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify([config.youtube.poTokenRequestKey, botguardResponse]),
        signal: AbortSignal.timeout(config.youtube.poTokenGenerationTimeoutMs)
      });
      if (!response.ok) throw new Error(`GenerateIT retornou HTTP ${response.status}.`);

      const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
        await response.json() as [string, number, number, string];
      minter = await WebPoMinter.create({
        integrityToken,
        estimatedTtlSecs,
        mintRefreshThreshold,
        websafeFallbackToken
      }, webPoSignalOutput as never);

      const ttlMs = Math.max(60_000, Number(estimatedTtlSecs || 300) * 1000);
      const refreshMs = Math.max(60_000, Number(mintRefreshThreshold || 60) * 1000);
      minterExpiresAt = Date.now() + Math.max(60_000, ttlMs - refreshMs);
    })();

    try {
      await initializing;
    } finally {
      initializing = undefined;
    }
  };

  return {
    close: () => {
      minter = undefined;
      minterExpiresAt = 0;
      dom.window.close();
    },
    generate: async (contentBinding: string) => {
      await initialize();
      if (!minter) throw new Error('Minter de PO Token não inicializado.');
      return minter.mintAsWebsafeString(contentBinding);
    }
  };
}
