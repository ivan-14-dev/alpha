import { Router, type Request } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { HttpError, id, now, param, requireAdmin, type User } from '../core.js';
import type { Capability } from '../platform/guards.js';
import { runJob } from '../platform/jobs.js';
import { setSetting } from '../platform/settings.js';
import { decideAppeal, type AppealRow } from './appeals.js';
import { caseKinds, caseStatuses, upsertCase, type RiskCaseRow } from './cases.js';
import { lastDetection } from './detectors.js';
import { auditAs, capabilityLabels, groundKeys, groundLabels, kindLabels, revokeSanction, sanctionKinds, type SanctionRow } from './sanctions.js';
import {
  APPEALS_SETTING, appealSettings, appealsSchema, AUTO_ACTIONS_SETTING, autoActions, autoActionsSchema, DAY_MS, defaultAppeals,
  defaultAutoActions, defaultRetention, defaultThresholds, HOUR_MS, isoAgo, RETENTION_SETTING, retentionSchema, signalRetentionDays,
  THRESHOLDS_SETTING, thresholds, thresholdsSchema, trustRetention,
} from './settings.js';
import { adminSanction, adminSanctionView, caseView, listUsers, revokeUserSessions, setUserRole, userDetail, userStatuses } from './users.js';

/** /api/trust/admin/* — every route requires an administrator; every mutation is audited. */
const router = Router();
router.use((req, _res, next) => { requireAdmin(req); next(); });

const identifier = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const restrictable = ['publish', 'message', 'trade', 'money', 'withdraw', 'review', 'test'] as const satisfies readonly Capability[];
const page = { limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).max(100000).default(0) };
const idParam = (req: Request) => identifier.parse(param(req));
const note = (min: number) => z.string().trim().min(min).max(2000);

const sanctionBody = z.object({
  kind: z.enum(sanctionKinds),
  capabilities: z.array(z.enum(restrictable)).max(restrictable.length).default([]),
  public_reason: z.string().trim().min(10).max(2000),
  internal_note: z.string().trim().max(4000).default(''),
  ground: z.enum(groundKeys).default('terms.other'),
  ends_at: z.string().datetime({ offset: true }).nullable().optional(),
  duration_days: z.number().int().min(1).max(3650).optional(),
  appealable: z.boolean().default(true),
  confirm_admin: z.boolean().default(false),
}).strict();
type SanctionBody = z.infer<typeof sanctionBody>;

function endsAt(input: SanctionBody): string | null {
  if (input.ends_at && input.duration_days) throw new HttpError(400, 'Indiquez soit une date de fin, soit une durée, pas les deux.');
  if (input.duration_days) return new Date(Date.now() + input.duration_days * DAY_MS).toISOString();
  return input.ends_at ? new Date(input.ends_at).toISOString() : null;
}

function sanctionFor(admin: User, userId: string, input: SanctionBody, caseId: string | null = null) {
  return adminSanction(admin, {
    userId, kind: input.kind, capabilities: input.capabilities, publicReason: input.public_reason, internalNote: input.internal_note,
    ground: input.ground, endsAt: endsAt(input), appealable: input.appealable, caseId, confirmAdmin: input.confirm_admin,
  });
}

// ----- Members -------------------------------------------------------------------------------------------

const usersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  role: z.enum(['member', 'admin']).optional(),
  status: z.enum(userStatuses).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  ...page,
});

router.get('/users', (req, res) => {
  const query = usersQuery.parse(req.query);
  res.json(listUsers({ ...query, q: query.q || undefined }));
});

router.get('/users/:id', (req, res) => {
  const admin = requireAdmin(req);
  const userId = idParam(req);
  const detail = userDetail(userId);
  // Access to risk data is itself traceable (accountability, GDPR art. 5(2)).
  auditAs(admin.id, 'trust.user.viewed', 'user', userId, {});
  res.json(detail);
});

router.patch('/users/:id/role', (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ role: z.enum(['member', 'admin']) }).strict().parse(req.body);
  res.json(setUserRole(admin, idParam(req), input.role));
});

router.post('/users/:id/sanctions', (req, res) => {
  const admin = requireAdmin(req);
  const sanction = sanctionFor(admin, idParam(req), sanctionBody.parse(req.body));
  res.status(201).json({ sanction: adminSanctionView(sanction) });
});

router.post('/users/:id/sessions/revoke', (req, res) => {
  const admin = requireAdmin(req);
  res.json(revokeUserSessions(admin, idParam(req)));
});

router.post('/users/:id/cases', (req, res) => {
  const admin = requireAdmin(req);
  const userId = idParam(req);
  const input = z.object({ summary: z.string().trim().min(10).max(500), score: z.number().int().min(0).max(100).default(50) }).strict().parse(req.body);
  const result = transaction(() => {
    if (!one('SELECT 1 FROM users WHERE id=?', userId)) throw new HttpError(404, 'Membre introuvable.');
    const created = upsertCase({ kind: 'manual', userId, related: [], score: input.score, summary: input.summary,
      evidence: { opened_by_admin: true }, dedupeKey: `manual:${id()}` })!;
    run("UPDATE risk_cases SET status='reviewing',assigned_to=? WHERE id=?", admin.id, created.id);
    auditAs(admin.id, 'trust.case.opened', 'risk_case', created.id, { user_id: userId, score: input.score });
    return created;
  });
  res.status(201).json({ case: caseView(one<RiskCaseRow>('SELECT * FROM risk_cases WHERE id=?', result.id)!) });
});

// ----- Sanctions -----------------------------------------------------------------------------------------

router.get('/sanctions', (req, res) => {
  const query = z.object({ active: z.enum(['1', '0']).default('1'), kind: z.enum(sanctionKinds).optional(), ...page }).parse(req.query);
  const at = now();
  const where = [query.active === '1' ? 's.revoked_at IS NULL AND s.starts_at<=? AND (s.ends_at IS NULL OR s.ends_at>?)' : '1=1'];
  const params: (string | number)[] = query.active === '1' ? [at, at] : [];
  if (query.kind) { where.push('s.kind=?'); params.push(query.kind); }
  const rows = all<SanctionRow & { user_name: string; created_by_name: string | null }>(`SELECT s.*,u.name AS user_name,cb.name AS created_by_name
    FROM sanctions s JOIN users u ON u.id=s.user_id LEFT JOIN users cb ON cb.id=s.created_by WHERE ${where.join(' AND ')}
    ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, ...params, query.limit, query.offset);
  res.json({ sanctions: rows.map(adminSanctionView) });
});

router.post('/sanctions/:id/revoke', (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ reason: note(10) }).strict().parse(req.body);
  res.json({ sanction: adminSanctionView(revokeSanction(idParam(req), admin.id, input.reason)) });
});

// ----- Risk cases ----------------------------------------------------------------------------------------

const casesQuery = z.object({
  status: z.enum(['active', 'all', ...caseStatuses]).default('active'),
  kind: z.enum(caseKinds).optional(),
  user_id: identifier.optional(),
  assigned: z.enum(['me', 'none']).optional(),
  ...page,
});

router.get('/cases', (req, res) => {
  const admin = requireAdmin(req);
  const query = casesQuery.parse(req.query);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.status === 'active') where.push("c.status IN ('open','reviewing')");
  else if (query.status !== 'all') { where.push('c.status=?'); params.push(query.status); }
  if (query.kind) { where.push('c.kind=?'); params.push(query.kind); }
  if (query.user_id) { where.push('EXISTS (SELECT 1 FROM risk_case_subjects x WHERE x.case_id=c.id AND x.user_id=?)'); params.push(query.user_id); }
  if (query.assigned === 'me') { where.push('c.assigned_to=?'); params.push(admin.id); }
  if (query.assigned === 'none') where.push('c.assigned_to IS NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM risk_cases c ${clause}`, ...params)!.total;
  const rows = all<RiskCaseRow & { assigned_name: string | null; resolved_by_name: string | null }>(`SELECT c.*,a.name AS assigned_name,r.name AS resolved_by_name
    FROM risk_cases c LEFT JOIN users a ON a.id=c.assigned_to LEFT JOIN users r ON r.id=c.resolved_by ${clause}
    ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,c.score DESC,c.last_detected_at DESC LIMIT ? OFFSET ?`,
  ...params, query.limit, query.offset);
  const subjects = rows.length ? all<{ case_id: string; user_id: string; role: string; name: string; user_role: string }>(`SELECT cs.case_id,cs.user_id,cs.role,
      u.name,u.role AS user_role FROM risk_case_subjects cs JOIN users u ON u.id=cs.user_id WHERE cs.case_id IN (${rows.map(() => '?').join(',')})
      ORDER BY cs.role DESC,u.name`, ...rows.map((row) => row.id)) : [];
  res.json({
    cases: rows.map((row) => ({ ...caseView(row), subjects: subjects.filter((subject) => subject.case_id === row.id).map(({ case_id: _case, ...subject }) => subject) })),
    total, limit: query.limit, offset: query.offset,
  });
});

function activeCase(caseId: string) {
  const row = one<RiskCaseRow>('SELECT * FROM risk_cases WHERE id=?', caseId);
  if (!row) throw new HttpError(404, 'Dossier introuvable.');
  if (!['open', 'reviewing'].includes(row.status)) throw new HttpError(409, 'Ce dossier est déjà clôturé.');
  return row;
}

/** Conservative automatic holds only last while a case is under review. */
function liftAutomaticHolds(caseId: string, adminId: string, reason: string) {
  const holds = all<{ id: string }>('SELECT id FROM sanctions WHERE case_id=? AND automated=1 AND revoked_at IS NULL', caseId);
  for (const hold of holds) revokeSanction(hold.id, adminId, reason);
  return holds.length;
}

router.post('/cases/:id/assign', (req, res) => {
  const admin = requireAdmin(req);
  const caseId = idParam(req);
  const input = z.object({ assignee_id: identifier.nullable().optional() }).strict().parse(req.body ?? {});
  const assignee = input.assignee_id === undefined ? admin.id : input.assignee_id;
  const updated = transaction(() => {
    const current = activeCase(caseId);
    if (assignee && one<{ role: string }>('SELECT role FROM users WHERE id=?', assignee)?.role !== 'admin') {
      throw new HttpError(400, 'Le dossier doit être confié à un administrateur.');
    }
    run('UPDATE risk_cases SET assigned_to=?,status=?,updated_at=? WHERE id=?', assignee, assignee ? 'reviewing' : 'open', now(), caseId);
    auditAs(admin.id, 'trust.case.assigned', 'risk_case', caseId, { from: current.assigned_to, to: assignee });
    return one<RiskCaseRow>('SELECT * FROM risk_cases WHERE id=?', caseId)!;
  });
  res.json({ case: caseView(updated) });
});

router.post('/cases/:id/dismiss', (req, res) => {
  const admin = requireAdmin(req);
  const caseId = idParam(req);
  const input = z.object({ note: note(5) }).strict().parse(req.body);
  const updated = transaction(() => {
    const current = activeCase(caseId);
    const lifted = liftAutomaticHolds(caseId, admin.id, `Alerte classée sans suite après examen humain. ${input.note}`);
    const timestamp = now();
    run(`UPDATE risk_cases SET status='dismissed',resolution_note=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?`,
      input.note, admin.id, timestamp, timestamp, caseId);
    auditAs(admin.id, 'trust.case.dismissed', 'risk_case', caseId, { kind: current.kind, score: current.score, note: input.note, lifted_holds: lifted });
    return one<RiskCaseRow>('SELECT * FROM risk_cases WHERE id=?', caseId)!;
  });
  res.json({ case: caseView(updated) });
});

router.post('/cases/:id/action', (req, res) => {
  const admin = requireAdmin(req);
  const caseId = idParam(req);
  const input = sanctionBody.extend({ user_id: identifier.optional(), note: z.string().trim().max(2000).default('') }).strict().parse(req.body);
  const result = transaction(() => {
    const current = activeCase(caseId);
    const target = input.user_id ?? current.user_id;
    if (!one('SELECT 1 FROM risk_case_subjects WHERE case_id=? AND user_id=?', caseId, target)) {
      throw new HttpError(400, 'La sanction doit viser un membre concerné par ce dossier.');
    }
    liftAutomaticHolds(caseId, admin.id, 'Mesure conservatoire remplacée par la décision de la modération.');
    const { user_id: _user, note: _note, ...body } = input;
    const sanction = sanctionFor(admin, target, body, caseId);
    const timestamp = now();
    run(`UPDATE risk_cases SET status='actioned',resolution_note=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=?`,
      input.note || `Sanction ${kindLabels[sanction.kind].toLowerCase()} appliquée.`, admin.id, timestamp, timestamp, caseId);
    auditAs(admin.id, 'trust.case.actioned', 'risk_case', caseId, { kind: current.kind, user_id: target, sanction_id: sanction.id });
    return { sanction, case: one<RiskCaseRow>('SELECT * FROM risk_cases WHERE id=?', caseId)! };
  });
  res.json({ case: caseView(result.case), sanction: adminSanctionView(result.sanction) });
});

// ----- Appeals -------------------------------------------------------------------------------------------

router.get('/appeals', (req, res) => {
  const query = z.object({ status: z.enum(['pending', 'accepted', 'rejected', 'all']).default('pending'), ...page }).parse(req.query);
  const clause = query.status === 'all' ? '' : 'WHERE a.status=?';
  const params = query.status === 'all' ? [] : [query.status];
  const sla = appealSettings().sla_days;
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM appeals a ${clause}`, ...params)!.total;
  const rows = all<AppealRow & Record<string, unknown> & { s_capabilities: string; s_appealable: number; s_automated: number; s_kind: SanctionRow['kind'] }>(
    `SELECT a.*,u.name AS user_name,u.email AS user_email,r.name AS reviewer_name,
      s.kind AS s_kind,s.capabilities AS s_capabilities,s.ground AS s_ground,s.public_reason AS s_public_reason,s.internal_note AS s_internal_note,
      s.starts_at AS s_starts_at,s.ends_at AS s_ends_at,s.revoked_at AS s_revoked_at,s.appealable AS s_appealable,s.automated AS s_automated,
      s.case_id AS s_case_id,cb.name AS s_created_by_name,c.kind AS case_kind,c.score AS case_score,c.summary AS case_summary,
      (SELECT COUNT(*) FROM appeals x WHERE x.sanction_id=a.sanction_id) AS appeals_on_sanction
    FROM appeals a JOIN users u ON u.id=a.user_id JOIN sanctions s ON s.id=a.sanction_id LEFT JOIN users r ON r.id=a.reviewer_id
    LEFT JOIN users cb ON cb.id=s.created_by LEFT JOIN risk_cases c ON c.id=s.case_id ${clause}
    ORDER BY CASE a.status WHEN 'pending' THEN 0 ELSE 1 END,CASE WHEN a.status='pending' THEN a.created_at END ASC,a.decided_at DESC LIMIT ? OFFSET ?`,
    ...params, query.limit, query.offset);
  const at = Date.now();
  res.json({
    appeals: rows.map((row) => {
      const due = new Date(Date.parse(row.created_at) + sla * DAY_MS).toISOString();
      let capabilities: Capability[] = [];
      try { capabilities = JSON.parse(row.s_capabilities); } catch { /* ignore */ }
      return {
        id: row.id, status: row.status, statement: row.statement, decision_note: row.decision_note, created_at: row.created_at,
        decided_at: row.decided_at, user_id: row.user_id, user_name: row.user_name, user_email: row.user_email, reviewer_name: row.reviewer_name,
        sla_due_at: due, overdue: row.status === 'pending' && Date.parse(due) < at, appeals_on_sanction: row.appeals_on_sanction,
        sanction: {
          id: row.sanction_id, kind: row.s_kind, kind_label: kindLabels[row.s_kind], capabilities,
          capability_labels: capabilities.map((capability) => capabilityLabels[capability] ?? capability),
          ground: row.s_ground, ground_label: groundLabels[row.s_ground as keyof typeof groundLabels] ?? row.s_ground,
          public_reason: row.s_public_reason, internal_note: row.s_internal_note, starts_at: row.s_starts_at, ends_at: row.s_ends_at,
          revoked_at: row.s_revoked_at, appealable: row.s_appealable === 1, automated: row.s_automated === 1, created_by_name: row.s_created_by_name,
          case: row.s_case_id ? { id: row.s_case_id, kind: row.case_kind, score: row.case_score, summary: row.case_summary } : null,
        },
      };
    }),
    total, limit: query.limit, offset: query.offset, sla_days: sla,
  });
});

router.post('/appeals/:id/accept', (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ note: z.string().trim().max(2000).default('') }).strict().parse(req.body ?? {});
  res.json({ appeal: decideAppeal(admin, idParam(req), 'accepted', input.note) });
});

router.post('/appeals/:id/reject', (req, res) => {
  const admin = requireAdmin(req);
  const input = z.object({ note: note(10) }).strict().parse(req.body);
  res.json({ appeal: decideAppeal(admin, idParam(req), 'rejected', input.note) });
});

// ----- Monitoring & configuration ------------------------------------------------------------------------

router.get('/stats', (_req, res) => {
  const at = now();
  const day = isoAgo(DAY_MS);
  const week = isoAgo(7 * DAY_MS);
  const window = isoAgo(thresholds().window_days * DAY_MS);
  const slaSince = isoAgo(appealSettings().sla_days * DAY_MS);
  const jobRuns = one("SELECT name FROM sqlite_master WHERE type='table' AND name='job_runs'")
    ? one('SELECT runs,last_started_at,last_finished_at,last_status,last_error,failures FROM job_runs WHERE name=?', 'trust.detect') ?? null : null;
  res.json({
    cases: {
      by_status: all('SELECT status,COUNT(*) AS count FROM risk_cases GROUP BY status'),
      active_by_kind: all("SELECT kind,COUNT(*) AS count,MAX(score) AS max_score FROM risk_cases WHERE status IN ('open','reviewing') GROUP BY kind ORDER BY count DESC"),
      high: one<{ count: number }>("SELECT COUNT(*) AS count FROM risk_cases WHERE status IN ('open','reviewing') AND score>=70")!.count,
      unassigned: one<{ count: number }>("SELECT COUNT(*) AS count FROM risk_cases WHERE status='open' AND assigned_to IS NULL")!.count,
    },
    signals: {
      by_kind: all('SELECT kind,SUM(created_at>=?) AS last_24h,COUNT(*) AS last_7d FROM risk_signals WHERE created_at>=? GROUP BY kind ORDER BY last_7d DESC', day, week),
      shared_devices: one<{ count: number }>(`SELECT COUNT(*) AS count FROM (SELECT device_hash FROM risk_signals WHERE device_hash IS NOT NULL
        AND user_id IS NOT NULL AND created_at>=? GROUP BY device_hash HAVING COUNT(DISTINCT user_id)>=2)`, window)!.count,
      without_device: one<{ count: number }>('SELECT COUNT(*) AS count FROM risk_signals WHERE device_hash IS NULL AND created_at>=?', week)!.count,
      total: one<{ count: number }>('SELECT COUNT(*) AS count FROM risk_signals')!.count,
      retention_days: signalRetentionDays(),
    },
    sanctions: {
      active_by_kind: all(`SELECT kind,COUNT(*) AS count FROM sanctions WHERE revoked_at IS NULL AND starts_at<=? AND (ends_at IS NULL OR ends_at>?)
        GROUP BY kind`, at, at),
      automated_active: one<{ count: number }>(`SELECT COUNT(*) AS count FROM sanctions WHERE automated=1 AND revoked_at IS NULL AND starts_at<=?
        AND (ends_at IS NULL OR ends_at>?)`, at, at)!.count,
      last_30_days: one<{ count: number }>('SELECT COUNT(*) AS count FROM sanctions WHERE created_at>=?', isoAgo(30 * DAY_MS))!.count,
    },
    appeals: {
      pending: one<{ count: number }>("SELECT COUNT(*) AS count FROM appeals WHERE status='pending'")!.count,
      overdue: one<{ count: number }>("SELECT COUNT(*) AS count FROM appeals WHERE status='pending' AND created_at<?", slaSince)!.count,
      accepted_rate_90d: one<{ rate: number | null }>(`SELECT ROUND(100.0*SUM(status='accepted')/NULLIF(COUNT(*),0),1) AS rate FROM appeals
        WHERE status!='pending' AND decided_at>=?`, isoAgo(90 * DAY_MS))!.rate,
    },
    detection: { last_run: lastDetection(), job: jobRuns, interval_minutes: 10, hour_ms: HOUR_MS },
  });
});

const settingsPayload = () => ({
  thresholds: thresholds(), auto_actions: autoActions(), retention: trustRetention(), appeals: appealSettings(),
  signal_retention_days: signalRetentionDays(),
  defaults: { thresholds: defaultThresholds, auto_actions: defaultAutoActions, retention: defaultRetention, appeals: defaultAppeals },
});

router.get('/settings', (_req, res) => { res.json(settingsPayload()); });

const settingsInput = z.object({
  thresholds: z.record(z.unknown()).optional(),
  auto_actions: z.record(z.unknown()).optional(),
  retention: z.record(z.unknown()).optional(),
  appeals: z.record(z.unknown()).optional(),
}).strict();

router.put('/settings', (req, res) => {
  const admin = requireAdmin(req);
  const input = settingsInput.parse(req.body);
  transaction(() => {
    const changes: Record<string, unknown> = {};
    if (input.thresholds) changes[THRESHOLDS_SETTING] = thresholdsSchema.parse({ ...thresholds(), ...input.thresholds });
    if (input.auto_actions) changes[AUTO_ACTIONS_SETTING] = autoActionsSchema.parse({ ...autoActions(), ...input.auto_actions });
    if (input.retention) changes[RETENTION_SETTING] = retentionSchema.parse({ ...trustRetention(), ...input.retention });
    if (input.appeals) changes[APPEALS_SETTING] = appealsSchema.parse({ ...appealSettings(), ...input.appeals });
    for (const [key, value] of Object.entries(changes)) setSetting(key, value, admin.id);
    if (Object.keys(changes).length) auditAs(admin.id, 'trust.settings.updated', 'setting', 'trust', changes);
  });
  res.json(settingsPayload());
});

router.post('/detect', async (req, res) => {
  const admin = requireAdmin(req);
  const ran = await runJob('trust.detect');
  auditAs(admin.id, 'trust.detection.run', 'job', 'trust.detect', { ran, summary: lastDetection() });
  res.json({ ran, summary: lastDetection() });
});

export default router;
