import { createTransport, type Transporter } from 'nodemailer';
import { z } from 'zod';
import { all, one, run } from '../db.js';
import { id, now } from '../core.js';
import { registerJob } from './jobs.js';
import { log } from './log.js';
import { appOrigin, getSecretSetting, getSetting } from './settings.js';

export interface EmailMessage {
  to: string;
  userId?: string | null;
  /** e.g. 'account.verify', 'account.reset', 'notification.payment'. */
  category: string;
  subject: string;
  text: string;
  html?: string;
  /** Sensitive bodies (tokens, codes) are redacted from the outbox once delivered. */
  sensitive?: boolean;
}

const smtpSettings = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().max(255).default(''),
  from: z.string().min(3).max(255),
}).strict();
export type SmtpSettings = z.infer<typeof smtpSettings>;
export const SMTP_SETTING = 'mail.smtp';
export const SMTP_PASSWORD_SETTING = 'mail.smtp.password';

/** Queue inside the caller's transaction: the email is only sent if the business change commits. */
export function queueEmail(message: EmailMessage): string {
  const emailId = id();
  run(`INSERT INTO email_outbox(id,to_address,user_id,category,subject,text_body,html_body,sensitive)
    VALUES (?,?,?,?,?,?,?,?)`, emailId, message.to, message.userId ?? null, message.category, message.subject,
  message.text, message.html ?? null, message.sensitive ? 1 : 0);
  return emailId;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

/** Minimal accessible, escaped transactional template. `action.url` may be relative to APP_ORIGIN. */
export function renderEmail(input: { title: string; paragraphs: string[]; action?: { label: string; url: string }; footer?: string }) {
  const url = input.action ? new URL(input.action.url, `${appOrigin()}/`).toString() : '';
  const footer = input.footer ?? 'Vous recevez cet e-mail car vous avez un compte Alpha. Ne transférez jamais un lien de sécurité.';
  const text = [input.title, '', ...input.paragraphs, ...(input.action ? ['', `${input.action.label} : ${url}`] : []), '', '—', footer].join('\n');
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f6f4ef;font-family:Arial,sans-serif;color:#1d1b29">
<div style="max-width:560px;margin:0 auto;padding:32px 20px"><p style="font-size:22px;font-weight:700;margin:0 0 24px">alpha.</p>
<div style="background:#fff;border-radius:14px;padding:28px"><h1 style="font-size:20px;margin:0 0 16px">${escape(input.title)}</h1>
${input.paragraphs.map((paragraph) => `<p style="line-height:1.55;margin:0 0 14px">${escape(paragraph)}</p>`).join('')}
${input.action ? `<p style="margin:24px 0 8px"><a href="${escape(url)}" style="background:#6658e8;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">${escape(input.action.label)}</a></p><p style="font-size:12px;color:#6f6a7d;word-break:break-all">${escape(url)}</p>` : ''}
</div><p style="font-size:12px;color:#6f6a7d;line-height:1.5">${escape(footer)}</p></div></body></html>`;
  return { text, html };
}

function smtpUrlTransport(): Transporter | null {
  if (process.env.SMTP_URL) return createTransport(process.env.SMTP_URL);
  const settings = getSetting<SmtpSettings | null>(SMTP_SETTING, smtpSettings.nullable(), null);
  if (!settings) return null;
  const password = getSecretSetting(SMTP_PASSWORD_SETTING);
  return createTransport({ host: settings.host, port: settings.port, secure: settings.secure,
    auth: settings.user ? { user: settings.user, pass: password ?? '' } : undefined });
}

export function mailFrom(): string {
  return process.env.MAIL_FROM ?? getSetting<SmtpSettings | null>(SMTP_SETTING, smtpSettings.nullable(), null)?.from ?? 'Alpha <no-reply@alpha.local>';
}

export function mailTransportConfigured(): boolean {
  return !!process.env.SMTP_URL || !!getSetting<SmtpSettings | null>(SMTP_SETTING, smtpSettings.nullable(), null);
}

let transportOverride: Pick<Transporter, 'sendMail'> | null = null;
/** Tests can inject a fake transport. */
export function setMailTransportForTests(transport: Pick<Transporter, 'sendMail'> | null) { transportOverride = transport; }

/** Sends due emails. Without SMTP outside production, messages are marked `logged` (visible in the admin outbox). */
export async function deliverQueuedEmails(limit = 25): Promise<{ sent: number; failed: number; logged: number }> {
  const due = all<{ id: string; to_address: string; subject: string; text_body: string; html_body: string | null; attempts: number; sensitive: number; category: string }>(
    `SELECT id,to_address,subject,text_body,html_body,attempts,sensitive,category FROM email_outbox
     WHERE status='queued' AND send_after<=? ORDER BY created_at LIMIT ?`, now(), limit);
  const result = { sent: 0, failed: 0, logged: 0 };
  if (!due.length) return result;
  const transport = transportOverride ?? smtpUrlTransport();
  // In production without SMTP, keep emails queued untouched until an admin configures a transport.
  if (!transport && process.env.NODE_ENV === 'production') return result;
  for (const email of due) {
    if (Number(run("UPDATE email_outbox SET status='sending',attempts=attempts+1 WHERE id=? AND status='queued'", email.id).changes) !== 1) continue;
    if (!transport) {
      run("UPDATE email_outbox SET status='logged',sent_at=? WHERE id=?", now(), email.id);
      log.info('mail.logged', { category: email.category, email_id: email.id });
      // Local development helper (never in production): print the body so links/codes can be followed.
      if (process.env.MAIL_LOG_BODY === '1') process.stdout.write(`\n--- e-mail to ${email.to_address}: ${email.subject}\n${email.text_body}\n---\n`);
      result.logged += 1;
      continue;
    }
    try {
      await transport.sendMail({ from: mailFrom(), to: email.to_address, subject: email.subject, text: email.text_body, html: email.html_body ?? undefined });
      run(`UPDATE email_outbox SET status='sent',sent_at=?,last_error=''${email.sensitive ? ",text_body='[contenu sensible supprime apres envoi]',html_body=NULL" : ''} WHERE id=?`, now(), email.id);
      result.sent += 1;
    } catch (error) {
      const attempts = email.attempts + 1;
      const retry = attempts < 5;
      const delayMs = Math.min(3600000, 30000 * 2 ** attempts);
      run('UPDATE email_outbox SET status=?,last_error=?,send_after=? WHERE id=?', retry ? 'queued' : 'failed',
        error instanceof Error ? error.message.slice(0, 500) : 'Erreur SMTP', new Date(Date.now() + delayMs).toISOString(), email.id);
      log.warn('mail.failed', { email_id: email.id, attempts, error });
      result.failed += 1;
    }
  }
  return result;
}

/** Recovers rows left in `sending` after a crash (jobs never overlap within the single SQLite process). Delivery is at-least-once. */
export function recoverStuckEmails() {
  run("UPDATE email_outbox SET status='queued' WHERE status='sending'");
}

export function outboxStats() {
  return one<{ queued: number; failed: number; sent: number; logged: number }>(`SELECT
    COALESCE(SUM(status='queued'),0) AS queued, COALESCE(SUM(status='failed'),0) AS failed,
    COALESCE(SUM(status='sent'),0) AS sent, COALESCE(SUM(status='logged'),0) AS logged FROM email_outbox`)!;
}

registerJob({
  name: 'mail.deliver',
  description: 'Envoie les e-mails en file d’attente (SMTP) avec reprise exponentielle.',
  intervalMs: 15000,
  run: async () => { recoverStuckEmails(); await deliverQueuedEmails(); },
});
