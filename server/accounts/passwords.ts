import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';

const derive = promisify(scrypt);
const storedFormat = /^[a-f0-9]{32}:[a-f0-9]{128}$/;
const dummyHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

/** Same rules for registration, password change and password reset. */
export const passwordSchema = z.string().min(10).max(128);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

/** Accounts created through OAuth have no usable local password (empty hash). */
export function hasUsablePassword(stored: string | null | undefined): boolean {
  return !!stored && storedFormat.test(stored);
}

/** Always runs one scrypt derivation, even for unknown or password-less accounts, to keep timing uniform. */
export async function checkPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const usable = hasUsablePassword(stored);
  const [salt, value] = (usable ? stored! : dummyHash).split(':');
  const actual = await derive(password, salt, 64) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return usable && actual.length === expected.length && timingSafeEqual(actual, expected);
}
