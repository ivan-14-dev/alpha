import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard for outgoing webhooks. A URL is accepted only when EVERY address its host resolves to is a
 * public unicast address; the HTTP request then connects to the vetted address (custom `lookup`), so a
 * second DNS answer (DNS rebinding) can never redirect the request to an internal service.
 */
export class UnsafeUrlError extends Error {}

const isProduction = () => process.env.NODE_ENV === 'production';
const productionPorts = new Set(['', '443', '80', '8443']);

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(network, prefix, 'ipv4');

// IPv6: only global unicast (2000::/3) is allowed. This excludes ::, ::1, IPv4-mapped/NAT64 (::/8, 64:ff9b::/96),
// unique local fc00::/7, link-local fe80::/10 and multicast ff00::/8. Inside 2000::/3 we still refuse
// special-purpose blocks (IETF assignments incl. Teredo, documentation, 6to4 which embeds IPv4).
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
  blockedV6.addSubnet(network, prefix, 'ipv6');
}

let allowedForTests: Set<string> | null = null;
type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
let resolverOverride: Resolver | null = null;

/** Test-only: lets the outgoing webhook tests reach a local HTTP receiver on the listed addresses. */
export function allowWebhookAddressesForTests(addresses: string[] | null) {
  if (addresses && isProduction()) throw new Error('Surcharge réservée aux tests.');
  allowedForTests = addresses ? new Set(addresses) : null;
}

/** Test-only: fake DNS answers (e.g. a public-looking name resolving to 127.0.0.1). */
export function setWebhookResolverForTests(resolver: Resolver | null) {
  if (resolver && isProduction()) throw new Error('Surcharge réservée aux tests.');
  resolverOverride = resolver;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedV4.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');
  return false;
}

function allowed(address: string) {
  return isPublicAddress(address) || (allowedForTests?.has(address) ?? false);
}

/** Synchronous checks shared by the API (immediate feedback) and the delivery worker. */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UnsafeUrlError('URL invalide.'); }
  if (raw.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(raw)) throw new UnsafeUrlError('URL invalide.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProduction())) {
    throw new UnsafeUrlError(isProduction() ? 'Seules les URL HTTPS sont acceptées.' : 'Seules les URL HTTP(S) sont acceptées.');
  }
  if (url.username || url.password) throw new UnsafeUrlError('L’URL ne doit pas contenir d’identifiants.');
  if (isProduction() && !productionPorts.has(url.port)) throw new UnsafeUrlError('Seuls les ports 443, 80 et 8443 sont autorisés.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname.includes('%')) throw new UnsafeUrlError('Nom d’hôte invalide.');
  if (isIP(hostname) && !allowed(hostname)) throw new UnsafeUrlError('Les adresses privées, locales ou réservées sont interdites.');
  if (!isIP(hostname) && (hostname === 'localhost' || hostname.endsWith('.localhost') || (isProduction() && !hostname.includes('.')))) {
    throw new UnsafeUrlError('Les adresses privées, locales ou réservées sont interdites.');
  }
  url.hash = '';
  return url;
}

export interface VettedTarget { url: URL; hostname: string; address: string; family: 4 | 6 }

export async function vetWebhookUrl(raw: string): Promise<VettedTarget> {
  const url = parseWebhookUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  let addresses: { address: string; family: number }[];
  if (literal) addresses = [{ address: hostname, family: literal }];
  else {
    try {
      addresses = await (resolverOverride ?? ((name: string) => dnsLookup(name, { all: true, verbatim: true })))(hostname);
    } catch {
      throw new UnsafeUrlError('Nom de domaine introuvable.');
    }
  }
  if (!addresses.length) throw new UnsafeUrlError('Nom de domaine introuvable.');
  if (addresses.some((item) => !allowed(item.address))) {
    throw new UnsafeUrlError('Ce nom de domaine pointe vers une adresse privée, locale ou réservée.');
  }
  const chosen = addresses[0];
  return { url, hostname, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

export interface PostResult { status: number; durationMs: number }

/** POSTs to the vetted address only: no redirects, no proxy, no connection reuse, hard timeout. */
export function postToVettedTarget(target: VettedTarget, body: string, headers: Record<string, string>, timeoutMs = 10000): Promise<PostResult> {
  const started = Date.now();
  const secure = target.url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, status = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve({ status, durationMs: Date.now() - started });
    };
    const request = (secure ? httpsRequest : httpRequest)({
      host: target.hostname,
      port: target.url.port ? Number(target.url.port) : secure ? 443 : 80,
      path: `${target.url.pathname}${target.url.search}`,
      method: 'POST',
      agent: false,
      headers: { ...headers, 'Content-Length': String(Buffer.byteLength(body)) },
      ...(secure && !isIP(target.hostname) ? { servername: target.hostname } : {}),
      lookup: (_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address: target.address, family: target.family }]);
        else callback(null, target.address, target.family);
      },
    } as unknown as RequestOptions, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      finish(null, status);
    });
    const timer = setTimeout(() => {
      request.destroy(new Error(`Délai de ${Math.round(timeoutMs / 1000)} s dépassé.`));
    }, timeoutMs);
    request.on('error', (error) => finish(error));
    request.end(body);
  });
}
