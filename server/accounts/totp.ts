import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32 (no padding), RFC 4226 HOTP and RFC 6238 TOTP (SHA-1, 6 digits, 30 s). */
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const totpPeriodSeconds = 30;
export const totpDigits = 6;
export const totpIssuer = 'Alpha';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error('Caractère base32 invalide.');
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = totpDigits): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', secret).update(message).digest();
  const offset = hash[hash.length - 1] & 0xf;
  const binary = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (timeMs = Date.now()) => Math.floor(timeMs / 1000 / totpPeriodSeconds);

export function totpCode(secretBase32: string, step = totpStep()): string {
  return hotp(base32Decode(secretBase32), step);
}

/**
 * Returns the matched time step (±window) or null. Steps lower than or equal to `lastUsedStep`
 * are rejected so an intercepted code can never be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, options: { lastUsedStep?: number | null; window?: number; timeMs?: number } = {}): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(options.timeMs);
  const window = options.window ?? 1;
  const lastUsed = options.lastUsedStep ?? -1;
  let matched: number | null = null;
  // Every candidate is computed and compared so timing does not reveal which step matched.
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0) continue;
    const candidate = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(candidate, Buffer.from(code)) && matched === null && step > lastUsed) matched = step;
  }
  return matched;
}

export function otpauthUri(secretBase32: string, account: string): string {
  const label = `${encodeURIComponent(totpIssuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer: totpIssuer, algorithm: 'SHA1', digits: String(totpDigits), period: String(totpPeriodSeconds) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
