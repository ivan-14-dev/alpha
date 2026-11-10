import { isIP } from 'node:net';
import type { Request } from 'express';
import { one, run, transaction } from '../db.js';
import { id, now } from '../core.js';
import type { SignalKind } from '../platform/guards.js';
import { log } from '../platform/log.js';
import { clientIp } from '../platform/rateLimit.js';
import { keyedHash } from '../platform/secrets.js';
import { isWebhookRequest } from './context.js';
import { inlineSignalDetection } from './detectors.js';

export type IpScope = 'public' | 'private' | 'none';
export interface RequestHashes { ip_hash: string | null; ip_scope: IpScope; device_hash: string | null; ua_hash: string | null }
const noHashes: RequestHashes = { ip_hash: null, ip_scope: 'none', device_hash: null, ua_hash: null };

function expandIpv6(address: string): number[] | null {
  let value = address.split('%')[0]!.toLowerCase();
  const embedded = value.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (embedded) {
    const [a, b, c, d] = embedded.slice(1).map(Number) as [number, number, number, number];
    value = `${value.slice(0, -embedded[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * Normalised address used for hashing + its scope. IPv6 is reduced to its /64 (privacy extensions rotate the
 * interface id). Loopback, RFC 1918, CGNAT (100.64/10), link-local and ULA are `private`: never matched across users.
 */
export function classifyIp(raw: string | undefined | null): { value: string; scope: IpScope } | null {
  if (!raw) return null;
  let address = raw.trim();
  if (address.toLowerCase().startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    const isPrivate = a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    return { value: address, scope: isPrivate ? 'private' : 'public' };
  }
  if (isIP(address) === 6) {
    const groups = expandIpv6(address);
    if (!groups) return null;
    const first = groups[0]!;
    const isPrivate = groups.every((group, index) => group === 0 || (index === 7 && group === 1))
      || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
    return { value: `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`, scope: isPrivate ? 'private' : 'public' };
  }
  return null;
}

/** Client-generated random identifier sent by the web app (`X-Alpha-Device`). */
export function deviceHeader(req: Request): string | null {
  const value = req.get('x-alpha-device')?.trim();
  if (!value || value.toLowerCase() === 'unavailable' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value)) return null;
  return value;
}

/** Keyed HMAC hashes only: raw IP, device id and user agent are never stored. */
export function requestHashes(req: Request | null): RequestHashes {
  if (!req || isWebhookRequest(req)) return noHashes;
  const ip = classifyIp(clientIp(req));
  const device = deviceHeader(req);
  const userAgent = req.get('user-agent')?.trim().slice(0, 512);
  return {
    ip_hash: ip ? keyedHash(ip.value, 'trust.ip') : null,
    ip_scope: ip?.scope ?? 'none',
    device_hash: device ? keyedHash(device, 'trust.device') : null,
    ua_hash: userAgent ? keyedHash(userAgent, 'trust.ua') : null,
  };
}

const PII_SEGMENTS = new Set(['email', 'mail', 'ip', 'phone', 'tel', 'msisdn', 'password', 'passwd', 'token', 'secret', 'address', 'iban',
  'card', 'pan', 'cvc', 'name', 'ua', 'agent', 'device', 'cookie', 'session', 'body', 'text', 'message', 'statement', 'reason', 'note', 'comment']);

/** Keeps at most 12 scalar, non-identifying fields (ids, enums, counts). Free text, e-mails, IPs and phone numbers are dropped. */
export function sanitizeMeta(meta: Record<string, unknown> | null | undefined): Record<string, string | number | boolean | null> {
  const clean: Record<string, string | number | boolean | null> = {};
  if (!meta || typeof meta !== 'object') return clean;
  for (const [key, value] of Object.entries(meta)) {
    if (Object.keys(clean).length >= 12) break;
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || key.split('_').some((segment) => PII_SEGMENTS.has(segment))) continue;
    if (value === null || typeof value === 'boolean') clean[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'string') {
      const text = value.trim();
      if (!text || text.length > 120 || !/^[A-Za-z0-9_.:/-]+$/.test(text) || isIP(text) || /^\+?\d{8,}$/.test(text)) continue;
      clean[key] = text;
    }
  }
  return clean;
}

/** High-volume kinds are recorded at most once per window and fingerprint. */
const throttled: Partial<Record<SignalKind, number>> = { message: 15 * 60000, order: 5 * 60000, mission: 5 * 60000 };

/**
 * Stores a risk signal and runs cheap inline detectors (shared device, burst of registrations from one IP).
 * Never throws: failures are logged and only the signal savepoint is rolled back.
 */
export function storeSignal(req: Request | null, userId: string | null, kind: SignalKind, meta: Record<string, unknown> = {}) {
  try {
    const hashes = requestHashes(req);
    transaction(() => {
      const timestamp = now();
      const window = throttled[kind];
      if (window && userId) {
        const last = one<{ ip_hash: string | null; device_hash: string | null }>(
          'SELECT ip_hash,device_hash FROM risk_signals WHERE user_id=? AND kind=? AND created_at>=? ORDER BY created_at DESC LIMIT 1',
          userId, kind, new Date(Date.now() - window).toISOString());
        if (last && last.ip_hash === hashes.ip_hash && last.device_hash === hashes.device_hash) return;
      }
      run(`INSERT INTO risk_signals(id,user_id,kind,ip_hash,ip_scope,device_hash,ua_hash,meta,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        id(), userId, kind, hashes.ip_hash, hashes.ip_scope, hashes.device_hash, hashes.ua_hash, JSON.stringify(sanitizeMeta(meta)), timestamp);
      if (userId) inlineSignalDetection(kind, hashes);
    });
  } catch (error) {
    log.warn('trust.signal_failed', { kind, error });
  }
}
