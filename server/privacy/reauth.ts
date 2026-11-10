import type { Request } from 'express';
import { one } from '../db.js';
import { checkPassword, hasUsablePassword as usableHash } from '../accounts/passwords.js';
import { cookieToken, digest } from '../accounts/session.js';
import { FRESH_LOGIN_MS } from './settings.js';

const storedHash = (userId: string) => one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', userId)?.password_hash;

/** False for OAuth-only and anonymized accounts (and any unknown hash format): those need a fresh login instead. */
export function hasUsablePassword(userId: string): boolean {
  return usableHash(storedHash(userId));
}

/** Delegates to the accounts module so the hash format stays in one place (constant-time, uniform timing). */
export function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  return checkPassword(password, storedHash(userId));
}

/** True when the current session was opened less than 10 minutes ago (recent re-authentication). */
export function hasFreshSession(req: Request, userId: string): boolean {
  const token = cookieToken(req);
  if (!token) return false;
  const session = one<{ created_at: string | null }>('SELECT created_at FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',
    digest(token), userId, new Date().toISOString());
  if (!session?.created_at) return false;
  const age = Date.now() - Date.parse(session.created_at);
  return age >= 0 && age <= FRESH_LOGIN_MS;
}
