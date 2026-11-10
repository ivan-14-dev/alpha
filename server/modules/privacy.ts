import { Router, type Request } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, HttpError, param, requireAdmin, requireUser } from '../core.js';
import { legalDocuments, recordLegalAcceptance, type LegalDocument } from '../platform/legal.js';
import { clientIp, rateLimit } from '../platform/rateLimit.js';
import { setSetting, settingUpdatedAt } from '../platform/settings.js';
import { breachInput, breachPatch, createBreach, deleteBreach, listBreaches, updateBreach } from '../privacy/breaches.js';
import { consentHistory, consentPurposes, consentsFor, currentPolicyVersion, setConsents } from '../privacy/consents.js';
import { erasureBlockers, executeErasure } from '../privacy/erasure.js';
import { buildExportArchive, serializeArchive } from '../privacy/export.js';
import { registerPrivacyModule } from '../privacy/jobs.js';
import { acceptancesFor, isLegalSlug, legalList, renderLegalDocument } from '../privacy/legal.js';
import { processingRegister } from '../privacy/register.js';
import { hasFreshSession, hasUsablePassword, verifyUserPassword } from '../privacy/reauth.js';
import {
  activeErasure, adminView, cancelErasure, createExportRequest, getRequest, isDownloadable, memberView, processExport,
  recordDownload, rejectRequest, requestsFor, scheduleErasure, type PrivacyRequestRow,
} from '../privacy/requests.js';
import { runRetention } from '../privacy/retention.js';
import {
  CONTROLLER_SETTING, controllerIdentity, controllerLabels, controllerSchema, defaultRetention, ERASURE_GRACE_DAYS,
  EXPORT_VALIDITY_DAYS, FRESH_LOGIN_MS, RETENTION_SETTING, retentionSchema, retentionSettings,
} from '../privacy/settings.js';

/** Privacy & legal module (/api/privacy): GDPR rights, consents, legal documents and the admin privacy console. */
registerPrivacyModule();
const router = Router();

const reasonText = z.string().trim().max(1000).default('');

// ---------------------------------------------------------------- Requests (Art. 15, 17, 20)

router.get('/requests', (req, res) => {
  const user = requireUser(req);
  res.json({ requests: requestsFor(user.id).map(memberView), export_validity_days: EXPORT_VALIDITY_DAYS, grace_days: ERASURE_GRACE_DAYS });
});

router.post('/exports', (req, res) => {
  const user = requireUser(req);
  const body = z.object({ reason: reasonText }).strict().parse(req.body ?? {});
  let request: PrivacyRequestRow;
  try {
    request = createExportRequest(user.id, body.reason);
  } catch (error) {
    if (error instanceof HttpError && 'retryAfter' in error) res.setHeader('Retry-After', String(error.retryAfter));
    throw error;
  }
  try {
    request = processExport(request.id);
  } catch {
    // Left pending: the `privacy.exports` job retries it.
  }
  res.status(201).json({ request: memberView(request) });
});

router.get('/exports/:id/download', (req, res) => {
  const user = requireUser(req);
  const request = getRequest(param(req));
  if (!request || request.user_id !== user.id || request.kind !== 'export') throw new HttpError(404, 'Export introuvable.');
  if (request.status === 'ready' && !isDownloadable(request)) {
    run("UPDATE privacy_requests SET status='completed',updated_at=? WHERE id=? AND status='ready'", new Date().toISOString(), request.id);
  }
  if (!isDownloadable(request)) {
    const expired = request.status === 'ready' || request.status === 'completed';
    throw new HttpError(expired ? 410 : 409, expired
      ? 'Ce lien de téléchargement a expiré. Faites une nouvelle demande d’export.'
      : request.status === 'rejected' || request.status === 'cancelled' ? 'Cette demande d’export a été clôturée.' : 'Cet export n’est pas encore prêt.');
  }
  const archive = buildExportArchive(user.id);
  recordDownload(request);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="alpha-donnees-personnelles-${archive.generated_at.slice(0, 10)}.json"`);
  res.setHeader('Cache-Control', 'no-store, private');
  for (const chunk of serializeArchive(archive)) res.write(chunk);
  res.end();
});

const erasureLimiter = rateLimit({
  name: 'privacy-erasure', limit: 5, windowMs: 15 * 60000,
  key: (req) => req.user?.id ?? clientIp(req),
  message: 'Trop de tentatives de suppression. Réessayez dans quelques minutes.',
});

function erasureState(req: Request, userId: string) {
  const request = activeErasure(userId);
  return {
    request: request ? memberView(request) : null,
    blockers: erasureBlockers(userId),
    requires_password: hasUsablePassword(userId),
    recent_login: hasFreshSession(req, userId),
    fresh_login_minutes: FRESH_LOGIN_MS / 60000,
    grace_days: ERASURE_GRACE_DAYS,
  };
}

router.get('/erasure', (req, res) => {
  const user = requireUser(req);
  res.json(erasureState(req, user.id));
});

router.post('/erasure', erasureLimiter, async (req, res) => {
  const user = requireUser(req);
  const body = z.object({
    password: z.string().max(200).optional(),
    confirmation: z.string().max(40),
    reason: reasonText,
  }).strict().parse(req.body ?? {});
  if (body.confirmation.trim() !== 'SUPPRIMER') throw new HttpError(400, 'Saisissez SUPPRIMER en majuscules pour confirmer.');
  if (hasUsablePassword(user.id)) {
    if (!body.password) throw new HttpError(400, 'Saisissez votre mot de passe pour confirmer.');
    if (!await verifyUserPassword(user.id, body.password)) throw new HttpError(403, 'Mot de passe incorrect.');
  } else if (!hasFreshSession(req, user.id)) {
    throw new HttpError(403, `Pour votre sécurité, reconnectez-vous (connexion de moins de ${FRESH_LOGIN_MS / 60000} minutes) puis recommencez.`);
  }
  if (activeErasure(user.id)) throw new HttpError(409, 'Une suppression de compte est déjà programmée.');
  const blockers = erasureBlockers(user.id);
  if (blockers.length) {
    res.status(409).json({ error: 'Votre compte ne peut pas encore être supprimé.', blockers });
    return;
  }
  const request = scheduleErasure(user.id, body.reason);
  res.status(201).json({ request: memberView(request) });
});

router.delete('/erasure', (req, res) => {
  const user = requireUser(req);
  res.json({ request: memberView(cancelErasure(user.id)) });
});

// ---------------------------------------------------------------- Consents (Art. 7)

function consentState(userId: string) {
  return { policy_version: currentPolicyVersion(), consents: consentsFor(userId), history: consentHistory(userId, 50) };
}

router.get('/consents', (req, res) => {
  const user = requireUser(req);
  res.json(consentState(user.id));
});

const consentInput = z.object(Object.fromEntries(consentPurposes.map((purpose) => [purpose, z.boolean().optional()])) as
  Record<typeof consentPurposes[number], z.ZodOptional<z.ZodBoolean>>).strict();

router.put('/consents', (req, res) => {
  const user = requireUser(req);
  const changes = consentInput.parse(req.body ?? {});
  const changed = transaction(() => {
    const list = setConsents(user.id, changes, 'settings');
    if (list.length) audit(user.id, 'privacy.consents.updated', 'user', user.id, JSON.stringify(Object.fromEntries(list.map((purpose) => [purpose, changes[purpose]]))));
    return list;
  });
  res.json({ ...consentState(user.id), changed });
});

// ---------------------------------------------------------------- Legal documents

router.get('/legal', (req, res) => {
  res.json({ documents: legalList(req.user?.id ?? null) });
});

router.get('/legal/acceptances', (req, res) => {
  const user = requireUser(req);
  res.json({ acceptances: acceptancesFor(user.id) });
});

router.post('/legal/accept', (req, res) => {
  const user = requireUser(req);
  const { documents } = z.object({
    documents: z.array(z.string().max(40)).min(1).max(10),
  }).strict().parse(req.body ?? {});
  const unknown = documents.filter((doc) => !Object.hasOwn(legalDocuments, doc));
  if (unknown.length) throw new HttpError(400, `Document inconnu ou purement informatif : ${unknown.join(', ')}.`);
  const unique = [...new Set(documents)] as LegalDocument[];
  transaction(() => {
    recordLegalAcceptance(user.id, unique);
    audit(user.id, 'privacy.legal.accepted', 'user', user.id, JSON.stringify(Object.fromEntries(unique.map((doc) => [doc, legalDocuments[doc].version]))));
  });
  res.json({ documents: legalList(user.id), acceptances: acceptancesFor(user.id) });
});

router.get('/legal/:doc', (req, res) => {
  const slug = param(req, 'doc');
  if (!isLegalSlug(slug)) throw new HttpError(404, 'Document introuvable.');
  const document = renderLegalDocument(slug);
  const status = legalList(req.user?.id ?? null).find((item) => item.slug === slug)!;
  res.json({ document: { ...document, accepted_at: status.accepted_at, pending: status.pending } });
});

// ---------------------------------------------------------------- Admin console (requireAdmin, every mutation audited)

const admin = Router();
admin.use((req, _res, next) => { requireAdmin(req); next(); });

type AdminRow = PrivacyRequestRow & { user_name: string; user_email: string; handled_by_name: string | null };
const requestSelect = `SELECT r.*,u.name AS user_name,u.email AS user_email,h.name AS handled_by_name
  FROM privacy_requests r JOIN users u ON u.id=r.user_id LEFT JOIN users h ON h.id=r.handled_by`;
const optionalControllerFields = new Set(['share_capital', 'vat_number', 'phone']);

admin.get('/overview', (_req, res) => {
  const breaches = listBreaches();
  res.json({
    requests: all<{ kind: string; status: string; total: number }>('SELECT kind,status,COUNT(*) AS total FROM privacy_requests GROUP BY kind,status'),
    due_erasures: one<{ total: number }>("SELECT COUNT(*) AS total FROM privacy_requests WHERE kind='erasure' AND status='scheduled' AND scheduled_for<=?", new Date().toISOString())!.total,
    open_breaches: breaches.filter((breach) => breach.status === 'open').length,
    overdue_breaches: breaches.filter((breach) => breach.deadline.state === 'overdue').length,
    controller_missing: Object.entries(controllerIdentity()).filter(([key, value]) => !value && !optionalControllerFields.has(key))
      .map(([key]) => controllerLabels[key as keyof typeof controllerLabels]),
  });
});

admin.get('/requests', (req, res) => {
  const query = z.object({
    kind: z.enum(['export', 'erasure']).optional(),
    status: z.enum(['pending', 'processing', 'ready', 'scheduled', 'completed', 'cancelled', 'rejected', 'open']).optional(),
  }).parse(req.query);
  const where: string[] = [];
  const params: string[] = [];
  if (query.kind) { where.push('r.kind=?'); params.push(query.kind); }
  if (query.status === 'open') where.push("r.status IN ('pending','processing','scheduled','ready')");
  else if (query.status) { where.push('r.status=?'); params.push(query.status); }
  const rows = all<AdminRow>(`${requestSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.requested_at DESC LIMIT 200`, ...params);
  res.json({ requests: rows.map(adminView) });
});

function adminRequest(requestId: string) {
  const row = one<AdminRow>(`${requestSelect} WHERE r.id=?`, requestId);
  if (!row) throw new HttpError(404, 'Demande introuvable.');
  return adminView(row);
}

admin.post('/requests/:id/process', (req, res) => {
  const user = requireAdmin(req);
  const request = getRequest(param(req));
  if (!request) throw new HttpError(404, 'Demande introuvable.');
  if (request.kind !== 'export') throw new HttpError(400, 'Utilisez « Exécuter » pour une suppression.');
  processExport(request.id, user.id);
  res.json({ request: adminRequest(request.id) });
});

admin.post('/requests/:id/reject', (req, res) => {
  const user = requireAdmin(req);
  const { reason } = z.object({ reason: z.string().trim().min(10, 'Indiquez un motif juridique précis (10 caractères minimum).').max(2000) }).strict().parse(req.body ?? {});
  rejectRequest(param(req), user.id, reason);
  res.json({ request: adminRequest(param(req)) });
});

admin.post('/requests/:id/execute', (req, res) => {
  const user = requireAdmin(req);
  const request = getRequest(param(req));
  if (!request || request.kind !== 'erasure') throw new HttpError(404, 'Demande de suppression introuvable.');
  if (request.status !== 'scheduled') throw new HttpError(409, 'Seule une suppression programmée peut être exécutée.');
  if (request.user_id === user.id) throw new HttpError(409, 'Vous ne pouvez pas exécuter la suppression de votre propre compte.');
  const early = !!request.scheduled_for && request.scheduled_for > new Date().toISOString();
  const outcome = executeErasure(request.id, { actorId: user.id, allowEarly: early });
  audit(user.id, 'privacy.admin.erasure_executed', 'privacy_request', request.id, JSON.stringify({ outcome: outcome.status, early }));
  if (outcome.status === 'blocked') {
    res.status(409).json({ error: 'La suppression est bloquée.', blockers: outcome.blockers, request: adminRequest(request.id) });
    return;
  }
  if (outcome.status === 'failed') throw new HttpError(500, `La suppression a échoué : ${outcome.error}`);
  res.json({ outcome, request: adminRequest(request.id) });
});

admin.get('/retention', (_req, res) => {
  res.json({ settings: retentionSettings(), defaults: defaultRetention, updated_at: settingUpdatedAt(RETENTION_SETTING) });
});

admin.put('/retention', (req, res) => {
  const user = requireAdmin(req);
  const settings = retentionSchema.parse({ ...retentionSettings(), ...(req.body ?? {}) });
  transaction(() => {
    setSetting(RETENTION_SETTING, settings, user.id);
    audit(user.id, 'privacy.admin.retention_updated', 'setting', RETENTION_SETTING, JSON.stringify(settings));
  });
  res.json({ settings, defaults: defaultRetention, updated_at: settingUpdatedAt(RETENTION_SETTING) });
});

admin.post('/retention/run', (req, res) => {
  const user = requireAdmin(req);
  const { dry_run } = z.object({ dry_run: z.boolean().default(true) }).strict().parse(req.body ?? {});
  const result = runRetention(dry_run);
  audit(user.id, dry_run ? 'privacy.admin.retention_dry_run' : 'privacy.admin.retention_run', 'setting', RETENTION_SETTING,
    JSON.stringify({ total: result.total, categories: Object.fromEntries(result.categories.map((category) => [category.key, category.count])) }));
  res.json({ result });
});

admin.get('/controller', (_req, res) => {
  res.json({ controller: controllerIdentity(), labels: controllerLabels, updated_at: settingUpdatedAt(CONTROLLER_SETTING) });
});

admin.put('/controller', (req, res) => {
  const user = requireAdmin(req);
  const controller = controllerSchema.parse({ ...controllerIdentity(), ...(req.body ?? {}) });
  transaction(() => {
    setSetting(CONTROLLER_SETTING, controller, user.id);
    audit(user.id, 'privacy.admin.controller_updated', 'setting', CONTROLLER_SETTING);
  });
  res.json({ controller, labels: controllerLabels, updated_at: settingUpdatedAt(CONTROLLER_SETTING) });
});

admin.get('/register', (_req, res) => {
  res.json(processingRegister());
});

admin.get('/register/download', (req, res) => {
  const user = requireAdmin(req);
  const register = processingRegister();
  audit(user.id, 'privacy.admin.register_downloaded', 'setting', 'processing_register');
  res.setHeader('Content-Disposition', `attachment; filename="alpha-registre-traitements-${register.generated_at.slice(0, 10)}.json"`);
  res.type('application/json; charset=utf-8').send(JSON.stringify(register, null, 2));
});

admin.get('/breaches', (_req, res) => {
  res.json({ breaches: listBreaches() });
});

admin.post('/breaches', (req, res) => {
  const user = requireAdmin(req);
  res.status(201).json({ breach: createBreach(user.id, breachInput.parse(req.body ?? {})) });
});

admin.patch('/breaches/:id', (req, res) => {
  const user = requireAdmin(req);
  res.json({ breach: updateBreach(user.id, param(req), breachPatch.parse(req.body ?? {})) });
});

admin.delete('/breaches/:id', (req, res) => {
  const user = requireAdmin(req);
  deleteBreach(user.id, param(req));
  res.status(204).end();
});

router.use('/admin', admin);

export default router;
