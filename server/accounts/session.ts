import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { one, run } from '../db.js';
import { HttpError, requireUser } from '../core.js';

export const sessionCookieName = 'alpha_session';
export const sessionDays = 7;
export const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const secureFlag = () => process.env.NODE_ENV === 'production' ? '; Secure' : '';

export function readCookie(req: Request, name: string): string | undefined {
  return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export function cookieToken(req: Request): string | undefined {
  const token = readCookie(req, sessionCookieName);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

/** Creates a session row (inside the caller's transaction) and replaces the request's previous session, if any. */
export function insertSession(req: Request, userId: string): string {
  const token = randomBytes(32).toString('hex');
  const old = cookieToken(req);
  const createdAt = new Date();
  if (old) run('DELETE FROM sessions WHERE token_hash=?', digest(old));
  run('DELETE FROM sessions WHERE expires_at<=?', createdAt.toISOString());
  run('INSERT INTO sessions(token_hash,user_id,expires_at,public_id,created_at) VALUES (?,?,?,?,?)',
    digest(token), userId, new Date(createdAt.getTime() + sessionDays * 86400000).toISOString(),
    randomBytes(16).toString('hex'), createdAt.toISOString());
  return token;
}

/** Appends (never overwrites) so OAuth callbacks can also clear their state cookie. */
export function setSessionCookie(res: Response, token: string) {
  res.append('Set-Cookie', `${sessionCookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDays * 86400}${secureFlag()}`);
}

export function clearSessionCookie(res: Response) {
  res.append('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag()}`);
}

export function setScopedCookie(res: Response, name: string, value: string, path: string, maxAgeSeconds: number) {
  res.append('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSeconds}${secureFlag()}`);
}

/** Like requireUser, but also re-checks the session row (call inside a transaction to hold the write lock). */
export function requireLiveSession(req: Request) {
  const user = requireUser(req);
  const token = cookieToken(req);
  const tokenHash = token ? digest(token) : '';
  if (!one('SELECT 1 FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>?',
    user.id, tokenHash, new Date().toISOString())) {
    throw new HttpError(401, 'Votre session a expiré ou a été révoquée. Reconnectez-vous.');
  }
  return { user, tokenHash };
}

export function revokeAllSessions(userId: string): number {
  return Number(run('DELETE FROM sessions WHERE user_id=?', userId).changes);
}
