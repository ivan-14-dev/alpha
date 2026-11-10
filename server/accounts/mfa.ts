import { randomInt } from 'node:crypto';
import { Router, type Request } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, id, now, type User } from '../core.js';
import { accountRestriction, recordSignal } from '../platform/guards.js';
import { clientIp, rateLimit } from '../platform/rateLimit.js';
import { randomToken, seal, sha256Hex, unseal } from '../platform/secrets.js';
import { queueSecurityEmail } from './emails.js';
import { checkPassword, hasUsablePassword } from './passwords.js';
import { insertSession, requireLiveSession, setSessionCookie } from './session.js';
import { authPolicy, enrichUser, mfaStatus } from './status.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export const challengeTtlMs = 5 * 60000;
export const maxChallengeAttempts = 5;
export const recoveryCodeCount = 10;
const recoveryAlphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const publicFields = 'u.id,u.name,u.email,u.title,u.bio,u.skills,u.avatar_color,u.role,u.created_at';

const secretContext = (userId: string) => `mfa:${userId}`;
const normalizeRecoveryCode = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, '');
const recoveryHash = (userId: string, code: string) => sha256Hex(`recovery:${userId}:${normalizeRecoveryCode(code)}`);

/** 16 base32 characters (80 bits) shown as xxxx-xxxx-xxxx-xxxx. */
function newRecoveryCode(): string {
  let code = '';
  while (code.length < 16) code += recoveryAlphabet[randomInt(recoveryAlphabet.length)];
  return code.match(/.{4}/g)!.join('-');
}

/** Replaces all recovery codes (inside a transaction) and returns the plaintext codes, shown once. */
export function regenerateRecoveryCodes(userId: string): string[] {
  run('DELETE FROM mfa_recovery_codes WHERE user_id=?', userId);
  const codes = new Set<string>();
  while (codes.size < recoveryCodeCount) codes.add(newRecoveryCode());
  for (const code of codes) run('INSERT INTO mfa_recovery_codes(id,user_id,code_hash) VALUES (?,?,?)', id(), userId, recoveryHash(userId, code));
  return [...codes];
}

interface TotpRow { secret_sealed: string; enabled_at: string | null; last_used_step: number | null }
const totpRow = (userId: string) => one<TotpRow>('SELECT secret_sealed,enabled_at,last_used_step FROM mfa_totp WHERE user_id=?', userId);

/** Verifies and consumes a TOTP code (replay-safe compare-and-set on last_used_step). Call inside a transaction. */
export function consumeTotp(userId: string, code: string, requireEnabled = true): boolean {
  const row = totpRow(userId);
  if (!row || (requireEnabled && !row.enabled_at)) return false;
  const step = verifyTotp(unseal(row.secret_sealed, secretContext(userId)), code, { lastUsedStep: row.last_used_step });
  if (step === null) return false;
  return Number(run('UPDATE mfa_totp SET last_used_step=?,updated_at=? WHERE user_id=? AND (last_used_step IS NULL OR last_used_step<?)',
    step, now(), userId, step).changes) === 1;
}

export function consumeRecoveryCode(userId: string, code: string): boolean {
  if (normalizeRecoveryCode(code).length !== 16) return false;
  return Number(run('UPDATE mfa_recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL',
    now(), userId, recoveryHash(userId, code)).changes) === 1;
}

/** Accepts a 6-digit TOTP code or a recovery code. */
export function consumeSecondFactor(userId: string, code: string): 'totp' | 'recovery' | null {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) return consumeTotp(userId, trimmed) ? 'totp' : null;
  return consumeRecoveryCode(userId, trimmed) ? 'recovery' : null;
}

/** Creates the second sign-in step. Returns the raw challenge (only its hash is stored). Call inside a transaction. */
export function createMfaChallenge(userId: string, method: 'password' | 'oauth', provider: 'github' | 'google' | null = null): string {
  const challenge = randomToken(32);
  run('DELETE FROM mfa_challenges WHERE expires_at<=?', now());
  run('INSERT INTO mfa_challenges(id_hash,user_id,method,provider,expires_at) VALUES (?,?,?,?,?)',
    sha256Hex(challenge), userId, method, provider, new Date(Date.now() + challengeTtlMs).toISOString());
  return challenge;
}

const codeSchema = z.string().trim().min(6).max(32);
const passwordField = z.string().min(1).max(128);
const manageLimiter = rateLimit({
  name: 'auth.mfa-manage', limit: 20, windowMs: 15 * 60000, key: (req: Request) => req.user?.id ?? clientIp(req),
  message: 'Trop de tentatives sur la double authentification. Réessayez dans 15 minutes.',
});
const verifyLimiter = rateLimit({ name: 'auth.mfa-verify', limit: 30, windowMs: 15 * 60000, message: 'Trop de tentatives. Réessayez dans 15 minutes.' });

/** Password re-authentication for sensitive changes; accounts without a local password (OAuth only) skip it. */
async function confirmPassword(userId: string, password: string | undefined) {
  const stored = one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', userId)?.password_hash;
  if (!hasUsablePassword(stored)) return stored;
  if (!password) throw new HttpError(400, 'Saisissez votre mot de passe actuel.');
  if (!await checkPassword(password, stored)) throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
  return stored;
}

function assertPasswordUnchanged(userId: string, snapshot: string | undefined) {
  if (one<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=?', userId)?.password_hash !== snapshot) {
    throw new HttpError(409, 'Le mot de passe a changé entre-temps. Actualisez puis réessayez.');
  }
}

export const mfaRouter = Router();

mfaRouter.get('/', (req, res) => {
  const { user } = requireLiveSession(req);
  res.json(mfaStatus(user.id));
});

mfaRouter.post('/setup', manageLimiter, async (req, res) => {
  const { user } = requireLiveSession(req);
  const input = z.object({ password: passwordField.optional() }).strict().parse(req.body ?? {});
  const snapshot = await confirmPassword(user.id, input.password);
  const secret = generateTotpSecret();
  transaction(() => {
    requireLiveSession(req);
    assertPasswordUnchanged(user.id, snapshot);
    if (totpRow(user.id)?.enabled_at) throw new HttpError(409, 'La double authentification est déjà activée.');
    run(`INSERT INTO mfa_totp(user_id,secret_sealed,enabled_at,last_used_step,created_at,updated_at) VALUES (?,?,NULL,NULL,?,?)
      ON CONFLICT(user_id) DO UPDATE SET secret_sealed=excluded.secret_sealed,last_used_step=NULL,created_at=excluded.created_at,updated_at=excluded.updated_at`,
    user.id, seal(secret, secretContext(user.id)), now(), now());
  });
  const otpauth = otpauthUri(secret, user.email);
  const qr = await QRCode.toDataURL(otpauth, { errorCorrectionLevel: 'M', margin: 1, width: 220 });
  res.json({ secret, otpauth_url: otpauth, qr_code: qr, issuer: 'Alpha', account: user.email });
});

mfaRouter.post('/enable', manageLimiter, (req, res) => {
  const { code } = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Code à 6 chiffres attendu') }).strict().parse(req.body);
  const result = transaction(() => {
    const { user } = requireLiveSession(req);
    const row = totpRow(user.id);
    if (!row) throw new HttpError(409, 'Commencez par configurer votre application d’authentification.');
    if (row.enabled_at) throw new HttpError(409, 'La double authentification est déjà activée.');
    if (!consumeTotp(user.id, code, false)) return { user, ok: false as const };
    run('UPDATE mfa_totp SET enabled_at=?,updated_at=? WHERE user_id=?', now(), now(), user.id);
    const codes = regenerateRecoveryCodes(user.id);
    audit(user.id, 'auth.mfa_enabled', 'user', user.id);
    queueSecurityEmail(user, 'Double authentification activée', 'La double authentification (application TOTP) vient d’être activée sur votre compte Alpha. Conservez vos codes de récupération en lieu sûr.');
    return { user, ok: true as const, codes };
  });
  if (!result.ok) {
    recordSignal(req, result.user.id, 'mfa_failed', { step: 'enable' });
    throw new HttpError(400, 'Code incorrect. Vérifiez l’heure de votre téléphone puis saisissez le code affiché.');
  }
  res.json({ enabled: true, recovery_codes: result.codes });
});

mfaRouter.post('/disable', manageLimiter, async (req, res) => {
  const { user } = requireLiveSession(req);
  const input = z.object({ password: passwordField.optional(), code: codeSchema }).strict().parse(req.body);
  const snapshot = await confirmPassword(user.id, input.password);
  const ok = transaction(() => {
    requireLiveSession(req);
    assertPasswordUnchanged(user.id, snapshot);
    if (!totpRow(user.id)?.enabled_at) throw new HttpError(409, 'La double authentification n’est pas activée.');
    if (authPolicy().require_admin_mfa && one<{ role: string }>('SELECT role FROM users WHERE id=?', user.id)?.role === 'admin') {
      throw new HttpError(409, 'La politique de sécurité impose la double authentification aux administrateurs : elle ne peut pas être désactivée.');
    }
    if (!consumeSecondFactor(user.id, input.code)) return false;
    run('DELETE FROM mfa_totp WHERE user_id=?', user.id);
    run('DELETE FROM mfa_recovery_codes WHERE user_id=?', user.id);
    run('DELETE FROM mfa_challenges WHERE user_id=?', user.id);
    audit(user.id, 'auth.mfa_disabled', 'user', user.id);
    queueSecurityEmail(user, 'Double authentification désactivée', 'La double authentification vient d’être désactivée sur votre compte Alpha. Votre compte n’est plus protégé que par votre mot de passe ou vos comptes liés.');
    return true;
  });
  if (!ok) {
    recordSignal(req, user.id, 'mfa_failed', { step: 'disable' });
    throw new HttpError(400, 'Code de vérification incorrect.');
  }
  res.json({ enabled: false });
});

mfaRouter.post('/recovery-codes', manageLimiter, (req, res) => {
  const { code } = z.object({ code: codeSchema }).strict().parse(req.body);
  const result = transaction(() => {
    const { user } = requireLiveSession(req);
    if (!totpRow(user.id)?.enabled_at) throw new HttpError(409, 'La double authentification n’est pas activée.');
    if (!consumeSecondFactor(user.id, code)) return { user, codes: null };
    const codes = regenerateRecoveryCodes(user.id);
    audit(user.id, 'auth.mfa_recovery_regenerated', 'user', user.id);
    return { user, codes };
  });
  if (!result.codes) {
    recordSignal(req, result.user.id, 'mfa_failed', { step: 'recovery_codes' });
    throw new HttpError(400, 'Code de vérification incorrect.');
  }
  res.json({ recovery_codes: result.codes });
});

const verifyInput = z.object({
  challenge: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
  code: z.string().trim().regex(/^\d{6}$/).optional(),
  recovery_code: z.string().trim().min(16).max(32).optional(),
}).strict().refine((value) => !!value.code !== !!value.recovery_code, { message: 'Saisissez un code à 6 chiffres ou un code de récupération.' });

mfaRouter.post('/verify', verifyLimiter, (req, res) => {
  const input = verifyInput.parse(req.body);
  const challengeHash = sha256Hex(input.challenge);
  const outcome = transaction(() => {
    const challenge = one<{ user_id: string; method: string; provider: string | null; attempts: number; expires_at: string; used_at: string | null }>(
      'SELECT user_id,method,provider,attempts,expires_at,used_at FROM mfa_challenges WHERE id_hash=?', challengeHash);
    if (!challenge || challenge.used_at || challenge.expires_at <= now() || challenge.attempts >= maxChallengeAttempts) {
      return { kind: 'expired' as const };
    }
    run('UPDATE mfa_challenges SET attempts=attempts+1 WHERE id_hash=?', challengeHash);
    const restriction = accountRestriction(challenge.user_id, 'login');
    if (restriction) return { kind: 'restricted' as const, message: restriction.message };
    const method = input.code ? (consumeTotp(challenge.user_id, input.code) ? 'totp' : null)
      : (consumeRecoveryCode(challenge.user_id, input.recovery_code!) ? 'recovery' : null);
    if (!method) return { kind: 'failed' as const, userId: challenge.user_id, remaining: maxChallengeAttempts - challenge.attempts - 1 };
    run('UPDATE mfa_challenges SET used_at=? WHERE id_hash=?', now(), challengeHash);
    if (challenge.provider) run('UPDATE oauth_identities SET last_login_at=? WHERE user_id=? AND provider=?', now(), challenge.user_id, challenge.provider);
    const token = insertSession(req, challenge.user_id);
    if (method === 'recovery') {
      audit(challenge.user_id, 'auth.mfa_recovery_used', 'user', challenge.user_id);
      const remaining = all('SELECT 1 FROM mfa_recovery_codes WHERE user_id=? AND used_at IS NULL', challenge.user_id).length;
      const user = one<User>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, challenge.user_id)!;
      queueSecurityEmail(user, 'Code de récupération utilisé', `Un code de récupération vient d’être utilisé pour vous connecter. Il vous en reste ${remaining}.`);
    }
    recordSignal(req, challenge.user_id, challenge.method === 'oauth' ? 'oauth_login' : 'login', { mfa: method });
    return { kind: 'ok' as const, token, userId: challenge.user_id };
  });
  if (outcome.kind === 'expired') throw new HttpError(410, 'Cette étape de connexion a expiré ou a été bloquée après trop d’essais. Reconnectez-vous.');
  if (outcome.kind === 'restricted') throw new HttpError(403, outcome.message);
  if (outcome.kind === 'failed') {
    recordSignal(req, outcome.userId, 'mfa_failed', { step: 'login' });
    throw new HttpError(401, outcome.remaining > 0
      ? `Code incorrect. Il vous reste ${outcome.remaining} essai${outcome.remaining > 1 ? 's' : ''}.`
      : 'Code incorrect. Trop d’essais : reconnectez-vous.');
  }
  setSessionCookie(res, outcome.token);
  res.json({ user: enrichUser(one<User>(`SELECT ${publicFields} FROM users u WHERE u.id=?`, outcome.userId)!) });
});
