import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from './db.js';
import { audit, HttpError, id, param, requireUser, type User } from './core.js';

const derive = promisify(scrypt);
const cookieName = 'alpha_session';
const sessionDays = 7;
const publicFields = 'u.id,u.name,u.email,u.title,u.bio,u.skills,u.avatar_color,u.role,u.created_at';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieToken = (req: Request) => {
  const token = req.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [salt, value] = stored.split(':');
  const actual = await derive(password, salt, 64) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = cookieToken(req);
  if (token) req.user = one<User>(`SELECT ${publicFields} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
    digest(token), new Date().toISOString());
  next();
}

function insertSession(req: Request, userId: string) {
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

function setSessionCookie(res: Response, token: string) {
  res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionDays * 86400}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}

function requireLiveSession(req: Request) {
  const user = requireUser(req);
  const token = cookieToken(req);
  const tokenHash = token ? digest(token) : '';
  if (!one('SELECT 1 FROM sessions WHERE user_id=? AND token_hash=? AND expires_at>?',
    user.id, tokenHash, new Date().toISOString())) {
    throw new HttpError(401, 'Votre session a expire ou a ete revoquee. Reconnectez-vous.');
  }
  return { user, tokenHash };
}

const attempts = new Map<string, { count: number; reset: number }>();
function rateLimit(req: Request, _res: Response, next: NextFunction) {
  const current = Date.now();
  for (const [key, value] of attempts) if (value.reset <= current) attempts.delete(key);
  const key = `${req.ip}:${req.path}`;
  const entry = attempts.get(key) ?? { count: 0, reset: current + 15 * 60000 };
  entry.count += 1;
  attempts.set(key, entry);
  if (entry.count > 30) throw new HttpError(429, 'Trop de tentatives. Reessayez dans 15 minutes.');
  next();
}

const credentials = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(10).max(128),
});
const sessionPage = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(50)).default('20'),
  offset: z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().min(0).max(1000000)).default('0'),
}).strict();
const passwordChange = z.object({
  current_password: z.string().min(1).max(128),
  new_password: z.string().min(10).max(128),
}).strict();

export const authRouter = Router();
authRouter.get('/me', (req, res) => res.json({ user: req.user ?? null }));
authRouter.get('/sessions', (req, res) => {
  requireUser(req);
  const { limit, offset } = sessionPage.parse(req.query);
  const result = transaction(() => {
    const { user, tokenHash } = requireLiveSession(req);
    const now = new Date().toISOString();
    const total = one<{ total: number }>('SELECT COUNT(*) AS total FROM sessions WHERE user_id=? AND expires_at>?', user.id, now)!.total;
    const sessions = all<{ id: string; created_at: string | null; expires_at: string; current: number }>(
      `SELECT public_id AS id,created_at,expires_at,token_hash=? AS current FROM sessions
       WHERE user_id=? AND expires_at>? ORDER BY current DESC,created_at DESC,public_id DESC LIMIT ? OFFSET ?`,
      tokenHash, user.id, now, limit, offset).map((session) => ({ ...session, current: !!session.current }));
    return { sessions, total, limit, offset, has_more: offset + sessions.length < total };
  });
  res.json(result);
});
authRouter.delete('/sessions/:id', (req, res) => {
  requireUser(req);
  const sessionId = z.string().regex(/^[a-f0-9]{32}$/).parse(param(req));
  transaction(() => {
    const { user, tokenHash } = requireLiveSession(req);
    const session = one<{ current: number }>(
      'SELECT token_hash=? AS current FROM sessions WHERE public_id=? AND user_id=? AND expires_at>?',
      tokenHash, sessionId, user.id, new Date().toISOString());
    if (!session) throw new HttpError(404, 'Session introuvable.');
    if (session.current) throw new HttpError(409, 'Utilisez la deconnexion pour fermer votre session actuelle.');
    run('DELETE FROM sessions WHERE public_id=? AND user_id=?', sessionId, user.id);
    audit(user.id, 'auth.session_revoked', 'user', user.id);
  });
  res.json({ ok: true });
});
authRouter.post('/sessions/revoke-others', (req, res) => {
  const revoked = transaction(() => {
    const { user, tokenHash } = requireLiveSession(req);
    const count = Number(run('DELETE FROM sessions WHERE user_id=? AND token_hash!=?', user.id, tokenHash).changes);
    audit(user.id, 'auth.sessions_revoked', 'user', user.id, JSON.stringify({ revoked: count }));
    return count;
  });
  res.json({ ok: true, revoked });
});
authRouter.post('/password', rateLimit, async (req, res) => {
  const { user, account } = transaction(() => {
    const { user } = requireLiveSession(req);
    const account = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', user.id)!;
    return { user, account };
  });
  const input = passwordChange.parse(req.body);
  const valid = await checkPassword(input.current_password, account.password_hash);
  const changed = input.new_password !== input.current_password;
  const passwordHash = valid && changed ? await hashPassword(input.new_password) : undefined;
  const token = transaction(() => {
    // Both checks must run after scrypt, while holding the same write lock as rotation.
    requireLiveSession(req);
    const latest = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', user.id);
    if (latest?.password_hash !== account.password_hash) {
      throw new HttpError(409, 'Le mot de passe a change entre-temps. Actualisez puis reessayez.');
    }
    if (!valid) throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
    if (!changed) throw new HttpError(400, 'Choisissez un mot de passe different du mot de passe actuel.');
    run('UPDATE users SET password_hash=? WHERE id=?', passwordHash!, user.id);
    run('DELETE FROM sessions WHERE user_id=?', user.id);
    const sessionToken = insertSession(req, user.id);
    audit(user.id, 'auth.password_changed', 'user', user.id);
    return sessionToken;
  });
  setSessionCookie(res, token);
  res.json({ ok: true });
});
authRouter.post('/register', rateLimit, async (req, res) => {
  const input = credentials.extend({ name: z.string().trim().min(2).max(80) }).parse(req.body);
  if (one('SELECT id FROM users WHERE email=?', input.email)) throw new HttpError(409, 'Cette adresse est deja utilisee.');
  const passwordHash = await hashPassword(input.password);
  const userId = id();
  const token = transaction(() => {
    if (one('SELECT id FROM users WHERE email=?', input.email)) throw new HttpError(409, 'Cette adresse est deja utilisee.');
    run('INSERT INTO users (id,name,email,password_hash) VALUES (?,?,?,?)', userId, input.name, input.email, passwordHash);
    return insertSession(req, userId);
  });
  setSessionCookie(res, token);
  res.status(201).json({ user: one<User>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, userId) });
});
authRouter.post('/login', rateLimit, async (req, res) => {
  const input = credentials.parse(req.body);
  const account = one<{ id: string; password_hash: string }>('SELECT id,password_hash FROM users WHERE email=?', input.email);
  const valid = await checkPassword(input.password, account?.password_hash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`);
  if (!account || !valid) throw new HttpError(401, 'Adresse email ou mot de passe incorrect.');
  const token = transaction(() => {
    const latest = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', account.id);
    if (latest?.password_hash !== account.password_hash) throw new HttpError(401, 'Adresse email ou mot de passe incorrect.');
    return insertSession(req, account.id);
  });
  setSessionCookie(res, token);
  res.json({ user: one<User>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, account.id) });
});
authRouter.post('/logout', (req, res) => {
  const token = cookieToken(req);
  if (token) run('DELETE FROM sessions WHERE token_hash=?', digest(token));
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  res.json({ ok: true });
});
