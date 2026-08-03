import { BotGuardClient } from 'bgutils-js/botguard';
import type { WebPoSignalOutput } from 'bgutils-js/shared-types';
import { buildURL, getHeaders } from 'bgutils-js/utils';
import { WebPoMinter } from 'bgutils-js/webpo';
import { JSDOM } from 'jsdom';
import type { Config } from '../config.js';

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Gera PO Tokens content-bound por vídeo usando BotGuard.
 * O minter é reutilizado enquanto o integrity token estiver válido; cada vídeo
 * recebe seu próprio token e o cache é renovado antes do vencimento.
 */
export class YouTubePoTokenManager {
  #minter: WebPoMinter | undefined;
  #minterExpiresAt = 0;
  #initializing: Promise<void> | undefined;
  #tokens = new Map<string, CachedToken>();
  #failUntil = 0;

  constructor(
    private readonly config: Config,
    private readonly innertube: any,
  ) {}

  get enabled(): boolean {
    return this.config.youtube.poTokenAutoEnabled;
  }

  invalidate(videoId?: string): void {
    if (videoId) this.#tokens.delete(videoId);
    else {
      this.#tokens.clear();
      this.#minter = undefined;
      this.#minterExpiresAt = 0;
    }
  }

  async get(videoId: string, forceRefresh = false): Promise<string | undefined> {
    if (!this.enabled) return this.config.youtube.poToken;
    const now = Date.now();
    if (!forceRefresh) {
      const cached = this.#tokens.get(videoId);
      if (cached && cached.expiresAt > now + 30_000) return cached.token;
    }
    if (now < this.#failUntil && !forceRefresh) return this.config.youtube.poToken;

    try {
      await this.#ensureMinter(forceRefresh);
      const token = await this.#withTimeout(
        this.#minter!.mintAsWebsafeString(videoId),
        this.config.youtube.poTokenGenerationTimeoutMs,
        'Tempo limite ao gerar PO Token.',
      );
      const expiresAt = Math.min(
        this.#minterExpiresAt,
        now + this.config.youtube.poTokenCacheTtlMs,
      );
      this.#tokens.set(videoId, { token, expiresAt });
      this.#trimCache();
      return token;
    } catch (error) {
      this.#failUntil = Date.now() + this.config.youtube.poTokenFailureCooldownMs;
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'youtubePoTokenGenerationFailed',
        at: new Date().toISOString(),
        videoId,
        message: error instanceof Error ? error.message : String(error),
      }));
      return this.config.youtube.poToken;
    }
  }

  async #ensureMinter(forceRefresh: boolean): Promise<void> {
    const refreshMargin = 60_000;
    if (!forceRefresh && this.#minter && this.#minterExpiresAt > Date.now() + refreshMargin) return;
    if (this.#initializing) return this.#initializing;

    this.#initializing = this.#initializeMinter();
    try {
      await this.#initializing;
    } finally {
      this.#initializing = undefined;
    }
  }

  async #initializeMinter(): Promise<void> {
    this.#installDom();
    const challenge = await this.#withTimeout(
      this.innertube.getAttestationChallenge('ENGAGEMENT_TYPE_UNBOUND'),
      this.config.youtube.poTokenGenerationTimeoutMs,
      'Tempo limite ao buscar desafio BotGuard.',
    );
    const bg = challenge?.bg_challenge;
    if (!bg) throw new Error('O YouTube não retornou desafio BotGuard.');

    const interpreterPath = bg.interpreter_url
      ?.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
    if (!interpreterPath) throw new Error('URL do interpretador BotGuard ausente.');
    const interpreterResponse = await fetch(
      interpreterPath.startsWith('http') ? interpreterPath : `https:${interpreterPath}`,
      { signal: AbortSignal.timeout(this.config.youtube.poTokenGenerationTimeoutMs) },
    );
    if (!interpreterResponse.ok) {
      throw new Error(`Interpretador BotGuard respondeu HTTP ${interpreterResponse.status}.`);
    }
    const interpreterJavascript = await interpreterResponse.text();
    new Function(interpreterJavascript)();

    const client = await BotGuardClient.create({
      program: bg.program,
      globalName: bg.global_name,
      globalObject: globalThis,
    });
    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await client.snapshot({ webPoSignalOutput });
    const integrityResponse = await fetch(buildURL('GenerateIT', false), {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify([this.config.youtube.poTokenRequestKey, botguardResponse]),
      signal: AbortSignal.timeout(this.config.youtube.poTokenGenerationTimeoutMs),
    });
    if (!integrityResponse.ok) {
      throw new Error(`GenerateIT respondeu HTTP ${integrityResponse.status}.`);
    }
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] =
      await integrityResponse.json() as [string, number, number, string];
    if (!integrityToken) throw new Error('Integrity token vazio.');

    this.#minter = await WebPoMinter.create({
      integrityToken,
      estimatedTtlSecs,
      mintRefreshThreshold,
      websafeFallbackToken,
    }, webPoSignalOutput);

    const safeTtlMs = Math.max(
      60_000,
      Math.min(
        this.config.youtube.poTokenCacheTtlMs,
        Math.max(60, Number(estimatedTtlSecs || 3600) - 60) * 1000,
      ),
    );
    this.#minterExpiresAt = Date.now() + safeTtlMs;
    this.#tokens.clear();
    this.#failUntil = 0;
    console.info(JSON.stringify({
      level: 'info',
      event: 'youtubePoTokenMinterReady',
      at: new Date().toISOString(),
      ttlMs: safeTtlMs,
    }));
  }

  #installDom(): void {
    if (Reflect.has(globalThis, 'window') && Reflect.has(globalThis, 'document')) return;
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://www.youtube.com/',
      referrer: 'https://www.youtube.com/',
      pretendToBeVisual: false,
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      origin: dom.window.origin,
    });
    if (!Reflect.has(globalThis, 'navigator')) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: dom.window.navigator,
      });
    }
  }

  #trimCache(): void {
    const max = this.config.youtube.poTokenCacheMaxEntries;
    while (this.#tokens.size > max) {
      const oldest = this.#tokens.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#tokens.delete(oldest);
    }
  }

  async #withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), ms);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
