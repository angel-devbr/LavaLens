import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { Readable } from 'node:stream';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { LavaLensError } from '../errors.js';
import { USER_AGENT } from '../version.js';

/**
 * Streaming HTTP baseado em node:http/node:https.
 *
 * Além de evitar os problemas de backpressure do fetch/undici, este módulo
 * fixa (pin) o IP que foi validado pelo anti-SSRF na conexão real. Assim o
 * host não é resolvido novamente pelo socket e DNS rebinding não consegue
 * trocar um IP público por loopback/metadados entre validação e conexão.
 */

function ipv4ToLong(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

const BLOCKED_V4_RANGES: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
];

function ipv4InBlockedRange(address: string): boolean {
  const value = ipv4ToLong(address);
  if (value == null) return true;
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const baseValue = ipv4ToLong(base);
    if (baseValue == null) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((baseValue & mask) >>> 0);
  });
}

/** Converte IPv6 comprimido/IPv4-mapeado em exatamente oito grupos de 16 bits. */
function parseIpv6(address: string): number[] | null {
  let input = address.toLowerCase().replace(/^\[|\]$/g, '');
  // Zone IDs são úteis apenas em link-local e nunca devem sair do nó.
  if (input.includes('%')) return null;

  const dottedIndex = input.lastIndexOf(':');
  if (input.includes('.') && dottedIndex >= 0) {
    const ipv4 = input.slice(dottedIndex + 1);
    const value = ipv4ToLong(ipv4);
    if (value == null) return null;
    input = `${input.slice(0, dottedIndex)}:${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }

  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = input.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw !== undefined && rightRaw ? rightRaw.split(':') : [];
  if (rightRaw === undefined && left.length !== 8) return null;
  if (rightRaw !== undefined && left.length + right.length >= 8) return null;
  const missing = rightRaw === undefined ? 0 : 8 - left.length - right.length;
  const pieces = [...left, ...Array(missing).fill('0'), ...right];
  if (pieces.length !== 8) return null;
  const groups = pieces.map((piece) => /^[0-9a-f]{1,4}$/.test(piece) ? Number.parseInt(piece, 16) : Number.NaN);
  return groups.some(Number.isNaN) ? null : groups;
}

function groupsToIpv4(groups: number[]): string {
  const value = (((groups[6]! << 16) >>> 0) | groups[7]!) >>> 0;
  return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

export function isPrivateAddress(address: string): boolean {
  const clean = address.replace(/^\[|\]$/g, '');
  const version = isIP(clean);
  if (version === 4) return ipv4InBlockedRange(clean);
  if (version !== 6) return true;

  const groups = parseIpv6(clean);
  if (!groups) return true;
  const allZero = groups.every((group) => group === 0);
  if (allZero) return true; // ::/128
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true; // ::1

  // ::ffff:0:0/96 (IPv4-mapped), inclusive na forma hexadecimal.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return ipv4InBlockedRange(groupsToIpv4(groups));
  }
  // IPv4-compatible ::/96. Bloqueia também representações ofuscadas de IPv4.
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return ipv4InBlockedRange(groupsToIpv4(groups));
  }
  // NAT64 well-known 64:ff9b::/96: aplica a política ao IPv4 embutido.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
    return ipv4InBlockedRange(groupsToIpv4(groups));
  }

  const first = groups[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // documentação
  return false;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Valida e resolve uma URL, retornando os IPs que deverão ser fixados no socket. */
export async function resolveAllowedAddresses(url: URL, allowPrivateNetwork: boolean): Promise<ResolvedAddress[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LavaLensError('UNSUPPORTED_PROTOCOL', `Protocolo não suportado: ${url.protocol}`, 400);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  const literalFamily = isIP(host);
  if (literalFamily) {
    addresses = [{ address: host, family: literalFamily as 4 | 6 }];
  } else {
    try {
      const found = await lookup(host, { all: true, verbatim: true });
      addresses = found
        .filter((entry): entry is typeof entry & { family: 4 | 6 } => entry.family === 4 || entry.family === 6)
        .map((entry) => ({ address: entry.address, family: entry.family }));
    } catch {
      throw new LavaLensError('DNS_FAILED', `Não foi possível resolver o host: ${host}`, 400);
    }
  }

  if (!addresses.length) throw new LavaLensError('DNS_FAILED', `O host não retornou endereços utilizáveis: ${host}`, 400);
  if (!allowPrivateNetwork && addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new LavaLensError(
      'BLOCKED_ADDRESS',
      'Endereço interno, reservado ou multicast bloqueado. Defina ALLOW_PRIVATE_NETWORK=true para permitir.',
      403,
      { host }
    );
  }
  // Ordem determinística e preferência por IPv4, que tende a funcionar em mais hosts baratos.
  return [...new Map(addresses.map((entry) => [`${entry.family}:${entry.address}`, entry])).values()]
    .sort((a, b) => a.family - b.family);
}

/** Mantido para consumidores existentes; a conexão real usa resolveAllowedAddresses(). */
export async function assertAllowedUrl(url: URL, allowPrivateNetwork: boolean): Promise<void> {
  await resolveAllowedAddresses(url, allowPrivateNetwork);
}

export interface HttpStreamOptions {
  allowPrivateNetwork: boolean;
  method?: 'GET' | 'HEAD';
  maxRedirects?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface HttpStreamResult {
  stream: IncomingMessage;
  statusCode: number;
  headers: IncomingMessage['headers'];
  finalUrl: URL;
}

export async function openHttpStream(target: URL, options: HttpStreamOptions): Promise<HttpStreamResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;
  let url = target;

  for (let redirect = 0; redirect <= maxRedirects; redirect++) {
    const resolved = await resolveAllowedAddresses(url, options.allowPrivateNetwork);
    const pinned = resolved[0]!;
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const current = url;

    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const requestOptions: RequestOptions = {
        method: options.method ?? 'GET',
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...options.headers },
        // O host continua no URL/Host/SNI, mas o socket recebe o IP já validado.
        lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family)
      };
      const req = requester(current, requestOptions, resolve);
      req.setTimeout(timeoutMs, () => req.destroy(new LavaLensError('UPSTREAM_TIMEOUT', 'Tempo esgotado ao abrir a fonte.', 504)));
      req.once('error', reject);
      req.end();
    });

    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.resume();
      if (redirect === maxRedirects) throw new LavaLensError('TOO_MANY_REDIRECTS', 'Excesso de redirecionamentos.', 502);
      url = new URL(location, current);
      continue; // o novo host será resolvido, validado e fixado novamente
    }
    if (status >= 400) {
      response.resume();
      throw new LavaLensError('UPSTREAM_STATUS', `A origem respondeu HTTP ${status}.`, 502, { status });
    }
    return { stream: response, statusCode: status, headers: response.headers, finalUrl: current };
  }
  throw new LavaLensError('TOO_MANY_REDIRECTS', 'Excesso de redirecionamentos.', 502);
}

export interface ProbeResult {
  contentType: string;
  contentLength: number;
  acceptsRanges: boolean;
}

export async function probeSource(url: URL, allowPrivateNetwork: boolean): Promise<ProbeResult> {
  try {
    const result = await openHttpStream(url, { allowPrivateNetwork, method: 'HEAD', timeoutMs: 5000 });
    result.stream.resume();
    const length = Number(result.headers['content-length'] ?? 0);
    return {
      contentType: String(result.headers['content-type'] ?? ''),
      contentLength: Number.isFinite(length) ? length : 0,
      acceptsRanges: String(result.headers['accept-ranges'] ?? '').toLowerCase().includes('bytes')
    };
  } catch {
    return { contentType: '', contentLength: 0, acceptsRanges: false };
  }
}

/** Adaptador web-stream -> Node que respeita backpressure e cancela corretamente. */
export function webStreamToNode(webStream: ReadableStream<Uint8Array>): Readable {
  const reader = webStream.getReader();
  let reading = false;

  return new Readable({
    highWaterMark: 1 << 18,
    read() {
      if (reading) return;
      reading = true;
      reader.read().then(
        ({ done, value }) => {
          reading = false;
          if (done) { this.push(null); return; }
          this.push(Buffer.from(value));
        },
        (error: unknown) => {
          reading = false;
          this.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      );
    },
    destroy(error, callback) {
      reader.cancel().catch(() => { /* já encerrado */ });
      callback(error);
    }
  });
}
