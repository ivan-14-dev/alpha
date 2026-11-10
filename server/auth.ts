import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from './db.js';
import { audit, HttpError, id, param, requireUser, type User } from './core.js';
import { accountRestriction, recordSignal } from './platform/guards.js';
import { pendingRequiredDocuments, recordLegalAcceptance } from './platform/legal.js';
import { hit, rateLimit, resetHits } from './platform/rateLimit.js';
import { authAdminRouter } from './accounts/admin.js';
import { queuePasswordChangedEmail } from './accounts/emails.js';
import { legalRouter } from './accounts/legal.js';
import { createMfaChallenge, mfaRouter } from './accounts/mfa.js';
import { enabledOAuthProviders, providerDefinitions } from './accounts/oauth.js';
import { oauthRouter } from './accounts/oauthRoutes.js';
import { checkPassword, hashPassword, passwordSchema } from './accounts/passwords.js';
import { issueEmailVerification, recoveryRouter } from './accounts/recovery.js';
import { clearSessionCookie, cookieToken, digest, insertSession, requireLiveSession, setSessionCookie } from './accounts/session.js';
import { accountFlags, adminMfaMissing, authPolicy, enrichUser, linkedIdentities, mfaStatus } from './accounts/status.js';
import './accounts/privacy.js';

export { hashPassword };

const publicFields = 'u.id,u.name,u.email,u.title,u.bio,u.skills,u.avatar_color,u.role,u.created_at';
const loadUser = (userId: string) => one<User>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, userId)!;

/**
 * Resolves the session cookie. Users under a `login` restriction are treated as signed out, and admins
 * lose their admin rights while the "MFA required for admins" policy is on and they have no MFA.
 */
export function attachUser(req: Request, _res: Response, next: NextFunction) {
  const token = cookieToken(req);
  if (token) {
    const user = one<User>(`SELECT ${publicFields} FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
      digest(token), new Date().toISOString());
    if (user && !accountRestriction(user.id, 'login')) {
      if (user.role === 'admin' && adminMfaMissing(user.id, user.role)) user.role = 'member';
      req.user = user;
    }
  }
  next();
}

const windowMs = 15 * 60000;
const limitMessage = 'Trop de tentatives. Réessayez dans 15 minutes.';
const passwordLimiter = rateLimit({ name: 'auth.password', limit: 30, windowMs, message: limitMessage });
const registerLimiter = rateLimit({ name: 'auth.register', limit: 30, windowMs, message: limitMessage });
const loginLimiter = rateLimit({ name: 'auth.login', limit: 30, windowMs, message: limitMessage });
const perAccountLoginLimit = 20;

const credentials = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: passwordSchema,
});
const registerInput = credentials.extend({ name: z.string().trim().min(2).max(80), accept_terms: z.boolean().optional() });
const sessionPage = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(50)).default('20'),
  offset: z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(z.number().int().min(0).max(1000000)).default('0'),
}).strict();
const passwordChange = z.object({
  current_password: z.string().min(1).max(128),
  new_password: passwordSchema,
}).strict();

export const authRouter = Router();
authRouter.get('/me', (req, res) => res.json({ user: req.user ? enrichUser(req.user) : null }));

/** Security status of the signed-in account (settings page). Never contains secrets. */
authRouter.get('/account', (req, res) => {
  const user = requireUser(req);
  const flags = accountFlags(user.id);
  const identities = linkedIdentities(user.id);
  const storedRole = one<{ role: string }>('SELECT role FROM users WHERE id=?', user.id)!.role;
  res.json({
    email: user.email,
    email_verified: flags.email_verified,
    email_verified_at: flags.email_verified_at,
    has_password: flags.has_password,
    mfa: mfaStatus(user.id),
    identities,
    oauth_providers: enabledOAuthProviders().map((provider) => ({
      id: provider, name: providerDefinitions[provider].name, linked: identities.some((identity) => identity.provider === provider),
    })),
    can_unlink: flags.has_password || identities.length > 1,
    pending_legal: pendingRequiredDocuments(user.id),
    admin_mfa_required: adminMfaMissing(user.id, storedRole),
    policy: authPolicy(),
  });
});

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
    if (session.current) throw new HttpError(409, 'Utilisez la déconnexion pour fermer votre session actuelle.');
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
authRouter.post('/password', passwordLimiter, async (req, res) => {
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
      throw new HttpError(409, 'Le mot de passe a changé entre-temps. Actualisez puis réessayez.');
    }
    if (!valid) throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
    if (!changed) throw new HttpError(400, 'Choisissez un mot de passe différent du mot de passe actuel.');
    run('UPDATE users SET password_hash=? WHERE id=?', passwordHash!, user.id);
    run('DELETE FROM sessions WHERE user_id=?', user.id);
    run('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', new Date().toISOString(), user.id);
    run('DELETE FROM mfa_challenges WHERE user_id=?', user.id);
    const sessionToken = insertSession(req, user.id);
    queuePasswordChangedEmail(user);
    audit(user.id, 'auth.password_changed', 'user', user.id);
    return sessionToken;
  });
  setSessionCookie(res, token);
  res.json({ ok: true });
});
authRouter.post('/register', registerLimiter, async (req, res) => {
  const input = registerInput.parse(req.body);
  if (one('SELECT id FROM users WHERE email=?', input.email)) throw new HttpError(409, 'Cette adresse est déjà utilisée.');
  const passwordHash = await hashPassword(input.password);
  const userId = id();
  const token = transaction(() => {
    if (one('SELECT id FROM users WHERE email=?', input.email)) throw new HttpError(409, 'Cette adresse est déjà utilisée.');
    run('INSERT INTO users (id,name,email,password_hash) VALUES (?,?,?,?)', userId, input.name, input.email, passwordHash);
    if (input.accept_terms === true) recordLegalAcceptance(userId, ['terms', 'privacy']);
    // Verification is offered, never required: the account is usable immediately.
    issueEmailVerification({ id: userId, email: input.email, name: input.name });
    const sessionToken = insertSession(req, userId);
    recordSignal(req, userId, 'register', { method: 'password' });
    return sessionToken;
  });
  setSessionCookie(res, token);
  res.status(201).json({ user: enrichUser(loadUser(userId)) });
});
authRouter.post('/login', loginLimiter, async (req, res) => {
  const input = credentials.parse(req.body);
  // Per-account bucket against distributed guessing; a successful sign-in resets it.
  const accountKey = `auth.login-account:${input.email}`;
  if (!hit(accountKey, perAccountLoginLimit, windowMs).allowed) {
    throw new HttpError(429, 'Trop de tentatives pour ce compte. Réessayez dans 15 minutes ou réinitialisez votre mot de passe.');
  }
  const account = one<{ id: string; password_hash: string }>('SELECT id,password_hash FROM users WHERE email=?', input.email);
  const valid = await checkPassword(input.password, account?.password_hash);
  if (!account || !valid) {
    recordSignal(req, account?.id ?? null, 'login_failed', {});
    throw new HttpError(401, 'Adresse email ou mot de passe incorrect.');
  }
  const restriction = accountRestriction(account.id, 'login');
  if (restriction) throw new HttpError(403, restriction.message);
  const result = transaction(() => {
    const latest = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', account.id);
    if (latest?.password_hash !== account.password_hash) throw new HttpError(401, 'Adresse email ou mot de passe incorrect.');
    if (one('SELECT 1 FROM mfa_totp WHERE user_id=? AND enabled_at IS NOT NULL', account.id)) {
      return { challenge: createMfaChallenge(account.id, 'password') };
    }
    const sessionToken = insertSession(req, account.id);
    recordSignal(req, account.id, 'login', {});
    return { token: sessionToken };
  });
  resetHits(accountKey);
  if (result.challenge) {
    res.json({ mfa_required: true, challenge: result.challenge });
    return;
  }
  setSessionCookie(res, result.token!);
  res.json({ user: enrichUser(loadUser(account.id)) });
});
authRouter.post('/logout', (req, res) => {
  const token = cookieToken(req);
  if (token) run('DELETE FROM sessions WHERE token_hash=?', digest(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.use(recoveryRouter);
authRouter.use('/mfa', mfaRouter);
authRouter.use('/oauth', oauthRouter);
authRouter.use('/legal', legalRouter);
authRouter.use('/admin', authAdminRouter);
