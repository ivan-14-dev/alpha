import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, now, param, requireAdmin } from '../core.js';
import { runJob } from '../platform/jobs.js';
import { log } from '../platform/log.js';
import { mailFrom, mailTransportConfigured, outboxStats, queueEmail, renderEmail, SMTP_PASSWORD_SETTING, SMTP_SETTING } from '../platform/mailer.js';
import { rateLimit } from '../platform/rateLimit.js';
import { getSetting, hasSecretSetting, setSecretSetting, setSetting, settingUpdatedAt } from '../platform/settings.js';
import { channelsStatus, PUSH_CONFIG_SETTING, pushConfig, pushConfigSchema, setChannels } from './channels.js';
import { pushStatus, resetVapidKeys, vapidKeys } from './push.js';
import { streamStats } from './sse.js';

/** Admin console API (`/api/realtime/admin/*`): SMTP, email outbox, Web Push and global channel switches. */
const router = Router();
router.use((req, _res, next) => { requireAdmin(req); next(); });
const MASK = '••••••••';
const noControl = (value: string) => !/[\r\n\u0000-\u001f\u007f]/.test(value);
const hostname = z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/, 'Nom d’hôte SMTP invalide.');
const fromAddress = z.string().trim().min(3).max(255).refine(noControl, 'Adresse d’expédition invalide.')
  .refine((value) => /^([^<>@]{0,120}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(value),
    'Format attendu : « Alpha <no-reply@exemple.fr> » ou « no-reply@exemple.fr ».');
const smtpStored = z.object({
  host: z.string().min(1).max(255), port: z.number().int().min(1).max(65535), secure: z.boolean(),
  user: z.string().max(255).default(''), from: z.string().min(3).max(255),
}).strict();
const smtpInput = z.object({
  host: hostname,
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(255).refine(noControl, 'Identifiant invalide.').default(''),
  from: fromAddress,
  password: z.string().max(500).refine(noControl, 'Mot de passe invalide.').optional(),
  clear_password: z.boolean().optional(),
}).strict();

function smtpDescription() {
  const stored = getSetting<z.infer<typeof smtpStored> | null>(SMTP_SETTING, smtpStored.nullable(), null);
  let env: { host: string; port: number | null; secure: boolean } | null = null;
  if (process.env.SMTP_URL && URL.canParse(process.env.SMTP_URL)) {
    const url = new URL(process.env.SMTP_URL);
    env = { host: url.hostname, port: url.port ? Number(url.port) : null, secure: url.protocol === 'smtps:' };
  }
  const passwordSet = hasSecretSetting(SMTP_PASSWORD_SETTING);
  return {
    configured: mailTransportConfigured(),
    source: env ? 'env' : stored ? 'settings' : 'none',
    env_override: env,
    mail_from_env: !!process.env.MAIL_FROM,
    from: mailFrom(),
    settings: stored,
    password: { configured: passwordSet, mask: passwordSet ? MASK : '' },
    updated_at: settingUpdatedAt(SMTP_SETTING),
    production_without_transport: process.env.NODE_ENV === 'production' && !mailTransportConfigured(),
  };
}

router.get('/status', (req, res) => {
  requireAdmin(req);
  res.json({ smtp: smtpDescription(), outbox: outboxStats(), push: pushStatus(), channels: channelsStatus(), streams: streamStats() });
});

router.get('/email/smtp', (req, res) => {
  requireAdmin(req);
  res.json(smtpDescription());
});

router.put('/email/smtp', (req, res) => {
  const admin = requireAdmin(req);
  const input = smtpInput.parse(req.body);
  if (input.password && input.clear_password) throw new HttpError(400, 'Choisissez entre un nouveau mot de passe et sa suppression.');
  transaction(() => {
    setSetting(SMTP_SETTING, { host: input.host, port: input.port, secure: input.secure, user: input.user, from: input.from }, admin.id);
    if (input.password) setSecretSetting(SMTP_PASSWORD_SETTING, input.password, admin.id);
    else if (input.clear_password) setSecretSetting(SMTP_PASSWORD_SETTING, null, admin.id);
    audit(admin.id, 'realtime.smtp_updated', 'setting', SMTP_SETTING,
      `${input.host}:${input.port} secure=${input.secure} password=${input.password ? 'changed' : input.clear_password ? 'cleared' : 'unchanged'}`);
  });
  res.json(smtpDescription());
});

router.delete('/email/smtp', (req, res) => {
  const admin = requireAdmin(req);
  transaction(() => {
    setSetting(SMTP_SETTING, null, admin.id);
    setSecretSetting(SMTP_PASSWORD_SETTING, null, admin.id);
    audit(admin.id, 'realtime.smtp_removed', 'setting', SMTP_SETTING, '');
  });
  res.json(smtpDescription());
});

router.post('/email/test', rateLimit({
  name: 'realtime.admin-test-email', limit: 5, windowMs: 10 * 60000, key: (req) => req.user?.id ?? 'anonymous',
  message: 'Trop d’e-mails de test envoyés. Réessayez dans quelques minutes.',
}), async (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ to: z.string().trim().email('Adresse e-mail invalide.').max(254).optional() }).strict().parse(req.body ?? {});
  const to = input.to ?? admin.email;
  const emailId = transaction(() => {
    const rendered = renderEmail({
      title: 'E-mail de test Alpha',
      paragraphs: ['Cet e-mail confirme que la configuration d’envoi de la plateforme fonctionne.', `Envoyé le ${new Date().toLocaleString('fr-FR', { timeZone: 'UTC' })} UTC.`],
      footer: 'Message envoyé depuis la console d’administration Alpha.',
    });
    const queued = queueEmail({ to, userId: admin.id, category: 'admin.test', subject: 'Test de configuration e-mail Alpha', text: rendered.text, html: rendered.html });
    audit(admin.id, 'realtime.email_test', 'email', queued, to === admin.email ? 'self' : 'custom');
    return queued;
  });
  try {
    await runJob('mail.deliver');
  } catch (error) {
    log.warn('realtime.email_test_failed', { error });
  }
  const row = one<{ id: string; status: string; last_error: string; attempts: number }>('SELECT id,status,last_error,attempts FROM email_outbox WHERE id=?', emailId)!;
  res.status(202).json({ email: row });
});

const outboxQuery = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'logged', 'cancelled']).optional(),
  category: z.string().trim().max(60).regex(/^[a-z0-9._-]*$/, 'Catégorie invalide.').optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
}).strict();

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

router.get('/email/outbox', (req, res) => {
  requireAdmin(req);
  const query = outboxQuery.parse(req.query);
  const where: string[] = [];
  const params: string[] = [];
  if (query.status) { where.push('status=?'); params.push(query.status); }
  if (query.category) { where.push("category LIKE ? ESCAPE '\\'"); params.push(`${escapeLike(query.category)}%`); }
  if (query.q) { where.push("(to_address LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')"); params.push(`%${escapeLike(query.q)}%`, `%${escapeLike(query.q)}%`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Bodies are never listed; the detail endpoint only returns non-sensitive bodies.
  const rows = all<Record<string, unknown>>(`SELECT id,to_address,user_id,category,subject,sensitive,status,attempts,last_error,send_after,sent_at,created_at
    FROM email_outbox ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`, ...params, query.limit + 1, query.offset);
  const categories = all<{ category: string; count: number }>('SELECT category,COUNT(*) AS count FROM email_outbox GROUP BY category ORDER BY count DESC LIMIT 50');
  res.json({ emails: rows.slice(0, query.limit).map((row) => ({ ...row, sensitive: !!row.sensitive })), has_more: rows.length > query.limit, stats: outboxStats(), categories });
});

router.get('/email/outbox/:id', (req, res) => {
  const admin = requireAdmin(req);
  const emailId = z.string().min(1).max(100).parse(param(req));
  const email = one<{ id: string; to_address: string; category: string; subject: string; sensitive: number; status: string; attempts: number;
    last_error: string; send_after: string; sent_at: string | null; created_at: string; text_body: string }>(
    `SELECT id,to_address,category,subject,sensitive,status,attempts,last_error,send_after,sent_at,created_at,text_body FROM email_outbox WHERE id=?`, emailId);
  if (!email) throw new HttpError(404, 'E-mail introuvable.');
  const sensitive = !!email.sensitive;
  if (!sensitive) audit(admin.id, 'realtime.email_viewed', 'email', email.id, email.category);
  const { text_body: body, ...meta } = email;
  res.json({ email: { ...meta, sensitive, text_body: sensitive ? null : body, body_hidden: sensitive } });
});

function outboxTransition(emailId: string, from: string, to: 'queued' | 'cancelled') {
  const extra = to === 'queued' ? ",attempts=0,last_error='',send_after=?" : '';
  const params = to === 'queued' ? [now()] : [];
  return Number(run(`UPDATE email_outbox SET status=?${extra} WHERE id=? AND status=?`, to, ...params, emailId, from).changes) === 1;
}

router.post('/email/outbox/:id/retry', (req, res) => {
  const admin = requireAdmin(req);
  const emailId = z.string().min(1).max(100).parse(param(req));
  transaction(() => {
    if (!one('SELECT 1 FROM email_outbox WHERE id=?', emailId)) throw new HttpError(404, 'E-mail introuvable.');
    if (!outboxTransition(emailId, 'failed', 'queued')) throw new HttpError(409, 'Seuls les e-mails en échec peuvent être relancés.');
    audit(admin.id, 'realtime.email_retried', 'email', emailId, '');
  });
  res.json({ email: one('SELECT id,status,attempts,last_error FROM email_outbox WHERE id=?', emailId) });
});

router.post('/email/outbox/:id/cancel', (req, res) => {
  const admin = requireAdmin(req);
  const emailId = z.string().min(1).max(100).parse(param(req));
  transaction(() => {
    if (!one('SELECT 1 FROM email_outbox WHERE id=?', emailId)) throw new HttpError(404, 'E-mail introuvable.');
    if (!outboxTransition(emailId, 'queued', 'cancelled')) throw new HttpError(409, 'Seuls les e-mails en file d’attente peuvent être annulés.');
    audit(admin.id, 'realtime.email_cancelled', 'email', emailId, '');
  });
  res.json({ email: one('SELECT id,status,attempts,last_error FROM email_outbox WHERE id=?', emailId) });
});

router.get('/push', (req, res) => {
  requireAdmin(req);
  res.json(pushStatus());
});

router.put('/push', (req, res) => {
  const admin = requireAdmin(req);
  const input = pushConfigSchema.partial().strict().parse(req.body);
  transaction(() => {
    const next = { ...pushConfig(), ...input };
    setSetting(PUSH_CONFIG_SETTING, next, admin.id);
    audit(admin.id, 'realtime.push_updated', 'setting', PUSH_CONFIG_SETTING, `enabled=${next.enabled} ttl=${next.ttl_seconds} subject=${next.subject ? 'custom' : 'default'}`);
  });
  res.json(pushStatus());
});

router.post('/push/keys', (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ rotate: z.boolean().default(false), confirm: z.boolean().optional() }).strict().parse(req.body ?? {});
  if (input.rotate && input.confirm !== true) {
    throw new HttpError(400, 'La rotation des clés supprime tous les abonnements push : confirmez explicitement.');
  }
  const result = transaction(() => {
    if (!input.rotate) {
      const keys = vapidKeys(true)!;
      audit(admin.id, 'realtime.push_keys_ensured', 'setting', 'push.vapid', '');
      return { removed: 0, public_key: keys.publicKey };
    }
    const rotated = resetVapidKeys(admin.id);
    audit(admin.id, 'realtime.push_keys_rotated', 'setting', 'push.vapid', `subscriptions_removed=${rotated.removed}`);
    return rotated;
  });
  res.json({ ...pushStatus(), removed_subscriptions: result.removed });
});

const channelsInput = z.object({ email_notifications: z.boolean().optional(), push: z.boolean().optional() }).strict()
  .refine((value) => value.email_notifications !== undefined || value.push !== undefined, 'Aucun changement demandé.');

router.get('/channels', (req, res) => {
  requireAdmin(req);
  res.json(channelsStatus());
});

router.put('/channels', (req, res) => {
  const admin = requireAdmin(req);
  const input = channelsInput.parse(req.body);
  transaction(() => {
    setChannels(input, admin.id);
    audit(admin.id, 'realtime.channels_updated', 'setting', 'notifications', JSON.stringify(input));
  });
  res.json(channelsStatus());
});

export default router;
