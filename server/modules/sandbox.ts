import { Router, type Request } from 'express';
import { z } from 'zod';
import { all, one, transaction } from '../db.js';
import { audit, HttpError, param, requireAdmin, requireUser } from '../core.js';
import { requireCapability } from '../platform/guards.js';
import { rateLimit } from '../platform/rateLimit.js';
import {
  bounds, ConfigError, defaultConfig, effectiveAllowlist, environmentAllowlist, sandboxActive, sandboxConfig, saveConfig, tmpSizeMb, validateConfig,
} from '../sandbox/config.js';
import { dockerSettings, inputModeFor, instanceId, isRemoteDocker } from '../sandbox/docker.js';
import {
  activeRunIds, campaignAccess, campaignBuilds, cancelRun, createRun, getRunRow, pendingCount, pullProfileImage, RUN_STATUSES, runRole,
  runtimeStatus, selfTest, TERMINAL_STATUSES, usageToday, type RunRow,
} from '../sandbox/service.js';

/** Isolated execution of campaign builds. Members: owners and accepted testers of a campaign. Admin: configuration and supervision. */
const router = Router();

const identifier = z.string().trim().min(1).max(100);
const createSchema = z.object({ campaign_id: identifier, file_id: identifier, profile_id: z.string().trim().min(1).max(60) }).strict();
const listQuery = z.object({
  campaign_id: identifier.optional(),
  status: z.enum(RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const lightColumns = `r.id,r.requester_id,r.campaign_id,r.mission_id,r.file_id,r.file_name,r.profile_id,r.profile_label,r.image,r.runtime,r.status,
  r.exit_code,r.queued_at,r.started_at,r.finished_at,r.duration_ms,r.logs_truncated,r.error,c.title AS campaign_title,c.owner_id AS campaign_owner_id,
  u.name AS requester_name`;

type DetailedRun = RunRow & { campaign_title?: string; requester_name?: string };

function presentRun(row: DetailedRun, viewer: { id: string; role: string }, withLogs: boolean) {
  const role = runRole(viewer, row);
  const { logs, command, limits, container_name: containerName, cancelled_by: _cancelledBy, logs_pruned_at: prunedAt, ...rest } = row;
  const parsedLimits = JSON.parse(limits) as { tmpfs_mb: number } & Record<string, unknown>;
  return {
    ...rest,
    command: JSON.parse(command) as string[],
    limits: parsedLimits,
    logs_pruned_at: prunedAt,
    logs_truncated: !!row.logs_truncated,
    ...(withLogs ? { logs } : {}),
    ...(viewer.role === 'admin' ? { container_name: containerName } : {}),
    viewer_role: role,
    can_cancel: !TERMINAL_STATUSES.has(row.status) && role !== null,
    isolation: { network: 'none', read_only_root: true, user: '65534:65534', capabilities: 'aucune', tmp_mb: tmpSizeMb(parsedLimits) },
  };
}

function loadRun(req: Request) {
  const user = requireUser(req);
  const row = one<DetailedRun>(`SELECT r.*,c.title AS campaign_title,u.name AS requester_name
    FROM sandbox_runs r JOIN campaigns c ON c.id=r.campaign_id JOIN users u ON u.id=r.requester_id WHERE r.id=?`, param(req));
  if (!row || !runRole(user, row)) throw new HttpError(404, 'Exécution introuvable.');
  return { user, row };
}

function publicProfiles() {
  return sandboxConfig().profiles.filter((profile) => profile.enabled).map((profile) => ({
    id: profile.id, label: profile.label, description: profile.description, image: profile.image, extract: profile.extract,
    entry_candidates: profile.entry_candidates, timeout_s: profile.timeout_s, memory_mb: profile.memory_mb, cpus: profile.cpus, pids: profile.pids,
    tmpfs_mb: profile.tmpfs_mb,
  }));
}

function queueStats() {
  return one<{ queued: number; running: number }>(`SELECT COALESCE(SUM(status='queued'),0) AS queued, COALESCE(SUM(status='running'),0) AS running
    FROM sandbox_runs WHERE status IN ('queued','running')`)!;
}

router.get('/status', async (req, res) => {
  const user = requireUser(req);
  const config = sandboxConfig();
  const enabled = sandboxActive(config);
  const check = enabled ? await runtimeStatus() : null;
  res.json({
    enabled,
    runtime: config.runtime,
    oci_runtime: config.oci_runtime,
    available: !!check?.ok,
    message: !enabled ? 'Le bac à sable est désactivé par l’administration de la plateforme.' : check?.ok ? null
      : 'Le moteur d’exécution est momentanément indisponible : vos demandes restent en file d’attente.',
    limits: { daily_quota: config.daily_quota, max_pending_per_user: config.max_pending_per_user, max_build_mb: config.max_build_mb,
      max_concurrent: config.max_concurrent, require_clean_scan: config.require_clean_scan },
    used_today: usageToday(user.id).runs,
    pending: pendingCount(user.id),
    queue: queueStats(),
  });
});

router.get('/profiles', (req, res) => {
  requireUser(req);
  res.json(publicProfiles());
});

/** Campaigns where the user may run builds (owner, or accepted tester whose mission is not cancelled). */
router.get('/campaigns', (req, res) => {
  const user = requireUser(req);
  const rows = all<{ id: string; title: string; status: string; owner_id: string; project_title: string; mission_id: string | null }>(
    `SELECT c.id,c.title,c.status,c.owner_id,p.title AS project_title,NULL AS mission_id
      FROM campaigns c JOIN projects p ON p.id=c.project_id WHERE c.owner_id=?
     UNION ALL
     SELECT c.id,c.title,c.status,c.owner_id,p.title,m.id FROM applications a JOIN campaigns c ON c.id=a.campaign_id
      JOIN projects p ON p.id=c.project_id LEFT JOIN missions m ON m.application_id=a.id
      WHERE a.tester_id=? AND a.status='accepted' AND c.owner_id!=? AND (m.id IS NULL OR m.status!='cancelled')
     ORDER BY 2 LIMIT 500`, user.id, user.id, user.id);
  res.json(rows.map((row) => ({ id: row.id, title: row.title, status: row.status, project_title: row.project_title,
    role: row.owner_id === user.id ? 'owner' : 'tester', mission_id: row.mission_id })));
});

router.get('/campaigns/:id/builds', (req, res) => {
  const user = requireUser(req);
  const campaignId = param(req);
  if (!campaignAccess(user.id, campaignId)) throw new HttpError(404, 'Campagne introuvable.');
  res.json(campaignBuilds(campaignId));
});

router.get('/runs', (req, res) => {
  const user = requireUser(req);
  const query = listQuery.parse(req.query);
  const filters = ['(r.requester_id=? OR c.owner_id=?)'];
  const params: string[] = [user.id, user.id];
  if (query.campaign_id) { filters.push('r.campaign_id=?'); params.push(query.campaign_id); }
  if (query.status) { filters.push('r.status=?'); params.push(query.status); }
  const rows = all<Record<string, unknown> & { requester_id: string; campaign_owner_id: string }>(`SELECT ${lightColumns}
    FROM sandbox_runs r JOIN campaigns c ON c.id=r.campaign_id JOIN users u ON u.id=r.requester_id
    WHERE ${filters.join(' AND ')} ORDER BY r.queued_at DESC LIMIT ?`, ...params, query.limit);
  res.json(rows.map(({ campaign_owner_id: ownerId, ...row }) => ({ ...row, logs_truncated: !!row.logs_truncated,
    viewer_role: row.requester_id === user.id ? 'requester' : ownerId === user.id ? 'owner' : null })));
});

router.post('/runs', rateLimit({ name: 'sandbox.run', limit: 20, windowMs: 60000, key: (req) => req.user?.id ?? 'anonymous',
  message: 'Trop de demandes d’exécution : patientez une minute.' }), (req, res) => {
  const user = requireCapability(req, 'test');
  const input = createSchema.parse(req.body);
  const row = createRun(user.id, input);
  res.status(202).json(presentRun(row, user, false));
});

router.get('/runs/:id', (req, res) => {
  const { user, row } = loadRun(req);
  res.json(presentRun(row, user, true));
});

router.get('/runs/:id/logs', (req, res) => {
  const { row } = loadRun(req);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sandbox-${row.id}.log"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(row.logs);
});

router.post('/runs/:id/cancel', async (req, res) => {
  const { user, row } = loadRun(req);
  const updated = await cancelRun(user, row.id);
  res.json(presentRun({ ...updated, campaign_title: row.campaign_title, requester_name: row.requester_name }, user, true));
});

// ------------------------------------------------------------------------------------------------------------------
// Administration (requireAdmin + audit on every mutation)
// ------------------------------------------------------------------------------------------------------------------

router.get('/admin/config', (req, res) => {
  requireAdmin(req);
  const config = sandboxConfig();
  const docker = dockerSettings();
  res.json({
    config,
    defaults: defaultConfig,
    bounds,
    environment: {
      docker_host: docker.host ?? 'unix:///var/run/docker.sock',
      docker_host_source: process.env.ALPHA_SANDBOX_DOCKER_HOST ? 'ALPHA_SANDBOX_DOCKER_HOST' : process.env.DOCKER_HOST ? 'DOCKER_HOST' : 'défaut',
      remote: isRemoteDocker(),
      tls: !!docker.tlsVerify && docker.tlsVerify !== '0',
      input_mode: inputModeFor(config.input_mode),
      allowlist_locked: environmentAllowlist() !== null,
      effective_allowlist: effectiveAllowlist(config),
      work_dir: docker.workDir,
      docker_bin: docker.bin,
      instance: instanceId(),
    },
    active_runs: activeRunIds().length,
  });
});

router.put('/admin/config', (req, res) => {
  const admin = requireAdmin(req);
  let config;
  try { config = validateConfig(req.body); }
  catch (error) {
    if (error instanceof ConfigError) throw new HttpError(400, error.message);
    throw error;
  }
  transaction(() => {
    const before = sandboxConfig();
    saveConfig(config, admin.id);
    const changes = [before.enabled !== config.enabled ? `enabled=${config.enabled}` : '', before.runtime !== config.runtime ? `runtime=${config.runtime}` : '',
      `profiles=${config.profiles.map((profile) => `${profile.id}:${profile.image}`).join(',')}`].filter(Boolean).join(' ');
    audit(admin.id, 'sandbox.config_updated', 'setting', 'sandbox.config', changes.slice(0, 1000));
  });
  res.json({ config: sandboxConfig() });
});

router.post('/admin/test', async (req, res) => {
  const admin = requireAdmin(req);
  const body = z.object({ profile_id: z.string().max(60).optional() }).strict().parse(req.body ?? {});
  const result = await selfTest(body.profile_id);
  transaction(() => audit(admin.id, 'sandbox.self_test', 'sandbox', result.profile_id ?? 'runtime', result.ok ? 'ok' : (result.error ?? 'échec').slice(0, 300)));
  res.json(result);
});

router.post('/admin/pull', async (req, res) => {
  const admin = requireAdmin(req);
  const body = z.object({ profile_id: z.string().min(1).max(60) }).strict().parse(req.body);
  transaction(() => audit(admin.id, 'sandbox.image_pull', 'sandbox_profile', body.profile_id));
  res.json(await pullProfileImage(body.profile_id));
});

router.get('/admin/runs', (req, res) => {
  requireAdmin(req);
  const query = listQuery.extend({ user_id: identifier.optional() }).parse(req.query);
  const filters = ['1=1'];
  const params: string[] = [];
  if (query.campaign_id) { filters.push('r.campaign_id=?'); params.push(query.campaign_id); }
  if (query.status) { filters.push('r.status=?'); params.push(query.status); }
  if (query.user_id) { filters.push('r.requester_id=?'); params.push(query.user_id); }
  const rows = all<Record<string, unknown>>(`SELECT ${lightColumns},r.container_name FROM sandbox_runs r JOIN campaigns c ON c.id=r.campaign_id
    JOIN users u ON u.id=r.requester_id WHERE ${filters.join(' AND ')} ORDER BY r.queued_at DESC LIMIT ?`, ...params, query.limit);
  const since = new Date(Date.now() - 86400000).toISOString();
  const stats = one<Record<string, number>>(`SELECT COALESCE(SUM(status IN ('succeeded','failed','timeout','cancelled','error') AND finished_at>=?),0) AS finished_24h,
    COALESCE(SUM(status IN ('error','timeout') AND finished_at>=?),0) AS problems_24h FROM sandbox_runs`, since, since)!;
  res.json({ runs: rows.map((row) => ({ ...row, logs_truncated: !!row.logs_truncated })), stats: { ...queueStats(), ...stats }, active: activeRunIds() });
});

router.post('/admin/runs/:id/kill', async (req, res) => {
  const admin = requireAdmin(req);
  const row = getRunRow(param(req));
  if (!row) throw new HttpError(404, 'Exécution introuvable.');
  const updated = await cancelRun(admin, row.id);
  res.json({ id: updated.id, status: updated.status, error: updated.error });
});

export default router;
