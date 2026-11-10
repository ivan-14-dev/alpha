import { randomInt } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { one, run, transaction } from '../db.js';
import { audit, HttpError, id, now } from '../core.js';
import { recordSignal } from '../platform/guards.js';
import { clientIp, hit, rateLimit } from '../platform/rateLimit.js';
import { randomToken, sha256Hex } from '../platform/secrets.js';
import { queuePasswordChangedEmail, queuePasswordResetEmail, queueVerificationEmail } from './emails.js';
import { hashPassword, passwordSchema } from './passwords.js';
import { requireLiveSession, revokeAllSessions } from './session.js';

export const verificationTtlMs = 48 * 3600000;
export const resetTtlMs = 3600000;
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const emailSchema = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
interface Recipient { id: string; email: string; name: string }

/** Supersedes any pending link and queues a new verification e-mail. Call inside a transaction. */
export function issueEmailVerification(user: Recipient) {
  const token = randomToken(32);
  run('DELETE FROM email_verification_tokens WHERE user_id=? AND used_at IS NULL', user.id);
  run('INSERT INTO email_verification_tokens(id,user_id,token_hash,email,expires_at) VALUES (?,?,?,?,?)',
    id(), user.id, sha256Hex(token), user.email, new Date(Date.now() + verificationTtlMs).toISOString());
  queueVerificationEmail(user, token);
}

/** Only the most recent reset link stays valid. Call inside a transaction. */
export function issuePasswordReset(user: Recipient) {
  const token = randomToken(32);
  run('DELETE FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL', user.id);
  run('INSERT INTO password_reset_tokens(id,user_id,token_hash,expires_at) VALUES (?,?,?,?)',
    id(), user.id, sha256Hex(token), new Date(Date.now() + resetTtlMs).toISOString());
  queuePasswordResetEmail(user, token);
}

function usableResetToken(tokenHash: string) {
  const row = one<{ id: string; user_id: string; expires_at: string; used_at: string | null }>(
    'SELECT id,user_id,expires_at,used_at FROM password_reset_tokens WHERE token_hash=?', tokenHash);
  if (!row || row.used_at) throw new HttpError(400, 'Ce lien de réinitialisation est invalide ou a déjà été utilisé. Demandez-en un nouveau.');
  if (row.expires_at <= now()) throw new HttpError(410, 'Ce lien de réinitialisation a expiré. Demandez-en un nouveau.');
  return row;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Pads a response to a minimum duration so its timing does not reveal whether an account exists. */
async function padUntil(startedAt: number, minimumMs: number) {
  const remaining = startedAt + minimumMs - Date.now();
  if (remaining > 0) await sleep(remaining);
}

const forgotMessage = 'Si un compte correspond à cette adresse, un e-mail contenant un lien de réinitialisation vient d’être envoyé. Pensez à vérifier vos courriers indésirables.';

export const recoveryRouter = Router();

recoveryRouter.post('/verify-email', rateLimit({ name: 'auth.verify-email', limit: 30, windowMs: 15 * 60000, message: 'Trop de tentatives. Réessayez dans quelques minutes.' }), (req, res) => {
  const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
  transaction(() => {
    const row = one<{ id: string; user_id: string; email: string; expires_at: string; used_at: string | null }>(
      'SELECT id,user_id,email,expires_at,used_at FROM email_verification_tokens WHERE token_hash=?', sha256Hex(token));
    if (!row) throw new HttpError(400, 'Ce lien de vérification est invalide. Demandez un nouvel e-mail depuis « Mon compte ».');
    if (row.used_at) throw new HttpError(400, 'Ce lien de vérification a déjà été utilisé.');
    if (row.expires_at <= now()) throw new HttpError(410, 'Ce lien de vérification a expiré. Demandez un nouvel e-mail depuis « Mon compte ».');
    const user = one<{ email: string; email_verified_at: string | null }>('SELECT email,email_verified_at FROM users WHERE id=?', row.user_id);
    if (!user || user.email !== row.email) throw new HttpError(400, 'Ce lien de vérification ne correspond plus à votre adresse actuelle.');
    if (Number(run('UPDATE email_verification_tokens SET used_at=? WHERE id=? AND used_at IS NULL', now(), row.id).changes) !== 1) {
      throw new HttpError(400, 'Ce lien de vérification a déjà été utilisé.');
    }
    if (!user.email_verified_at) {
      run('UPDATE users SET email_verified_at=? WHERE id=?', now(), row.user_id);
      audit(row.user_id, 'auth.email_verified', 'user', row.user_id);
    }
  });
  res.json({ ok: true, email_verified: true });
});

recoveryRouter.post('/verify-email/resend', rateLimit({
  name: 'auth.verify-resend', limit: 3, windowMs: 60 * 60000, key: (req: Request) => req.user?.id ?? clientIp(req),
  message: 'Vous avez demandé plusieurs e-mails récemment. Patientez une heure avant de réessayer.',
}), (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  transaction(() => {
    const { user } = requireLiveSession(req);
    const account = one<{ email_verified_at: string | null }>('SELECT email_verified_at FROM users WHERE id=?', user.id)!;
    if (account.email_verified_at) throw new HttpError(409, 'Votre adresse e-mail est déjà vérifiée.');
    issueEmailVerification(user);
  });
  res.status(202).json({ ok: true });
});

recoveryRouter.post('/password/forgot', rateLimit({ name: 'auth.forgot', limit: 10, windowMs: 15 * 60000, message: 'Trop de demandes. Réessayez dans 15 minutes.' }), async (req, res) => {
  const startedAt = Date.now();
  const { email } = z.object({ email: emailSchema }).strict().parse(req.body);
  // The per-address limit is silent: answering 429 only for some addresses would leak information.
  if (hit(`auth.forgot-email:${email}`, 5, 60 * 60000).allowed) {
    transaction(() => {
      const user = one<Recipient>('SELECT id,email,name FROM users WHERE email=?', email);
      if (user) issuePasswordReset(user);
    });
  }
  await padUntil(startedAt, 200 + randomInt(0, 60));
  res.status(202).json({ ok: true, message: forgotMessage });
});

recoveryRouter.post('/password/reset', rateLimit({ name: 'auth.reset', limit: 20, windowMs: 15 * 60000, message: 'Trop de tentatives. Réessayez dans 15 minutes.' }), async (req, res) => {
  const input = z.object({ token: tokenSchema, password: passwordSchema }).strict().parse(req.body);
  const tokenHash = sha256Hex(input.token);
  usableResetToken(tokenHash);
  const passwordHash = await hashPassword(input.password);
  transaction(() => {
    const row = usableResetToken(tokenHash);
    if (Number(run('UPDATE password_reset_tokens SET used_at=? WHERE id=? AND used_at IS NULL', now(), row.id).changes) !== 1) {
      throw new HttpError(400, 'Ce lien de réinitialisation a déjà été utilisé.');
    }
    const user = one<Recipient>('SELECT id,email,name FROM users WHERE id=?', row.user_id);
    if (!user) throw new HttpError(400, 'Ce lien de réinitialisation est invalide.');
    run('UPDATE password_reset_tokens SET used_at=? WHERE user_id=? AND used_at IS NULL', now(), user.id);
    // Receiving the link proves control of the mailbox.
    run('UPDATE users SET password_hash=?,email_verified_at=COALESCE(email_verified_at,?) WHERE id=?', passwordHash, now(), user.id);
    revokeAllSessions(user.id);
    run('DELETE FROM mfa_challenges WHERE user_id=?', user.id);
    queuePasswordChangedEmail(user);
    audit(user.id, 'auth.password_reset', 'user', user.id);
    recordSignal(req, user.id, 'password_reset', {});
  });
  res.json({ ok: true });
});
