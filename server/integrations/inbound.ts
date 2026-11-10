import { Router, type Request, type Response } from 'express';
import { id, notify, now } from '../core.js';
import { all, one, run, transaction } from '../db.js';
import { log } from '../platform/log.js';
import { clientIp, hit } from '../platform/rateLimit.js';
import { hmacHex, safeEqual, sha256Hex, unseal } from '../platform/secrets.js';
import { enqueueProjectEvent } from './outgoing.js';
import { providerSchema, type ProviderId } from './providers.js';

export interface SourceRow {
  id: string;
  project_id: string;
  provider: ProviderId;
  base_url: string;
  connection_id: string | null;
  external_id: string;
  full_name: string;
  url: string;
  default_branch: string;
  webhook_secret_sealed: string;
  provider_webhook_id: string | null;
  setup: 'automatic' | 'manual';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

export const sourceSecretContext = (sourceId: string) => `integration_project_source:${sourceId}`;

type Status = 'processed' | 'ignored';
interface Outcome { status: Status; summary: string }

const ZERO_SHA = /^0{40}$/;
const PUSH_NOTIFY_WINDOW_MS = 30 * 60_000;
const RELEASES_PER_HOUR = 3;

const clip = (value: unknown, max = 120) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const firstLine = (value: unknown) => clip(String(value ?? '').split('\n')[0], 100);

/** Project owner + testers holding an active mission on an open campaign of the project. */
function releaseAudience(projectId: string): string[] {
  return all<{ user_id: string }>(`SELECT owner_id AS user_id FROM projects WHERE id=?
    UNION SELECT m.tester_id FROM missions m JOIN campaigns c ON c.id=m.campaign_id
    WHERE c.project_id=? AND c.status='open' AND m.status IN ('assigned','in_progress','submitted','changes_requested') LIMIT 500`,
  projectId, projectId).map((row) => row.user_id);
}

function projectInfo(projectId: string) {
  return one<{ id: string; title: string; owner_id: string }>('SELECT id,title,owner_id FROM projects WHERE id=?', projectId);
}

function sourceRef(source: SourceRow) {
  return { id: source.id, provider: source.provider, full_name: source.full_name, url: source.url };
}

/** Release-style announcement (deduplicated per version for 24 h, at most 3 per hour per source). */
function announceRelease(source: SourceRow, version: string, extra: Record<string, unknown>): Outcome {
  const summary = `Nouvelle version disponible : ${version}`;
  const project = projectInfo(source.project_id);
  if (!project) return { status: 'ignored', summary: 'Projet introuvable.' };
  if (!hit(`integrations.release-version:${source.id}:${version}`, 1, 24 * 3600_000).allowed) {
    return { status: 'processed', summary: `${summary} (déjà annoncée)` };
  }
  enqueueProjectEvent(source.project_id, 'source.release', () => ({ project_id: source.project_id, source: sourceRef(source), version, ...extra }));
  if (!hit(`integrations.release-notify:${source.id}`, RELEASES_PER_HOUR, 3600_000).allowed) {
    return { status: 'processed', summary: `${summary} (notifications limitées)` };
  }
  for (const userId of releaseAudience(source.project_id)) {
    notify(userId, 'testing.release', summary, `${project.title} · ${source.full_name}`, `/projects/${project.id}`);
  }
  return { status: 'processed', summary };
}

function announcePush(source: SourceRow, branch: string, commits: number, author: string, head: { id: string; message: string } | null): Outcome {
  const summary = clip(`Push sur ${branch} : ${commits} commit${commits > 1 ? 's' : ''}${author ? ` par ${author}` : ''}`
    + (head ? ` — ${head.id.slice(0, 7)} ${firstLine(head.message)}` : ''), 500);
  const project = projectInfo(source.project_id);
  if (!project) return { status: 'ignored', summary: 'Projet introuvable.' };
  enqueueProjectEvent(source.project_id, 'source.push', () => ({
    project_id: source.project_id, source: sourceRef(source), branch, commits, head_commit: head ? head.id : null,
  }));
  if (hit(`integrations.push-notify:${source.id}`, 1, PUSH_NOTIFY_WINDOW_MS).allowed) {
    notify(project.owner_id, 'integrations.activity', `Nouveau push sur ${source.full_name}`, summary, `/projects/${project.id}`);
  }
  return { status: 'processed', summary };
}

type Payload = Record<string, any>;

function processGithub(source: SourceRow, event: string, payload: Payload): Outcome {
  if (event === 'ping') return { status: 'processed', summary: 'Webhook GitHub opérationnel (ping reçu).' };
  if (event === 'push') {
    const ref = String(payload.ref ?? '');
    if (!ref.startsWith('refs/heads/')) return { status: 'ignored', summary: `Référence ignorée : ${clip(ref)}` };
    const branch = ref.slice('refs/heads/'.length);
    const defaultBranch = String(payload.repository?.default_branch ?? source.default_branch ?? '');
    if (payload.deleted) return { status: 'ignored', summary: `Branche supprimée : ${clip(branch)}` };
    if (defaultBranch && branch !== defaultBranch) return { status: 'ignored', summary: `Push ignoré (branche ${clip(branch)})` };
    if (defaultBranch && defaultBranch !== source.default_branch) {
      run('UPDATE integration_project_sources SET default_branch=?,updated_at=? WHERE id=?', clip(defaultBranch, 200), now(), source.id);
    }
    const commits = Array.isArray(payload.commits) ? payload.commits.length : 0;
    const head = payload.head_commit?.id ? { id: String(payload.head_commit.id), message: String(payload.head_commit.message ?? '') } : null;
    return announcePush(source, clip(branch, 200), commits, clip(payload.pusher?.name ?? payload.sender?.login, 80), head);
  }
  if (event === 'release') {
    if (payload.action !== 'published') return { status: 'ignored', summary: `Release ignorée (${clip(payload.action, 40)})` };
    const tag = clip(payload.release?.tag_name, 100);
    if (!tag) return { status: 'ignored', summary: 'Release sans tag.' };
    return announceRelease(source, tag, { name: clip(payload.release?.name, 200), prerelease: !!payload.release?.prerelease, url: clip(payload.release?.html_url, 500) });
  }
  return { status: 'ignored', summary: `Événement GitHub non géré : ${clip(event, 60)}` };
}

function processGitlab(source: SourceRow, event: string, payload: Payload): Outcome {
  if (event === 'Push Hook') {
    const ref = String(payload.ref ?? '');
    const branch = ref.replace(/^refs\/heads\//, '');
    if (ZERO_SHA.test(String(payload.after ?? ''))) return { status: 'ignored', summary: `Branche supprimée : ${clip(branch)}` };
    const defaultBranch = String(payload.project?.default_branch ?? source.default_branch ?? '');
    if (defaultBranch && branch !== defaultBranch) return { status: 'ignored', summary: `Push ignoré (branche ${clip(branch)})` };
    const commits = Number(payload.total_commits_count ?? (Array.isArray(payload.commits) ? payload.commits.length : 0)) || 0;
    const last = Array.isArray(payload.commits) && payload.commits.length ? payload.commits[payload.commits.length - 1] : null;
    const head = payload.checkout_sha ? { id: String(payload.checkout_sha), message: String(last?.message ?? last?.title ?? '') } : null;
    return announcePush(source, clip(branch, 200), commits, clip(payload.user_username ?? payload.user_name, 80), head);
  }
  if (event === 'Tag Push Hook') {
    if (ZERO_SHA.test(String(payload.after ?? ''))) return { status: 'ignored', summary: 'Tag supprimé.' };
    const tag = clip(String(payload.ref ?? '').replace(/^refs\/tags\//, ''), 100);
    if (!tag) return { status: 'ignored', summary: 'Tag sans nom.' };
    return announceRelease(source, tag, { name: tag, prerelease: false, url: '' });
  }
  if (event === 'Release Hook') {
    if (payload.action !== 'create') return { status: 'ignored', summary: `Release ignorée (${clip(payload.action, 40)})` };
    const tag = clip(payload.tag, 100);
    if (!tag) return { status: 'ignored', summary: 'Release sans tag.' };
    return announceRelease(source, tag, { name: clip(payload.name, 200), prerelease: !!payload.upcoming_release, url: clip(payload.url, 500) });
  }
  return { status: 'ignored', summary: `Événement GitLab non géré : ${clip(event, 60)}` };
}

function processFigma(source: SourceRow, event: string, payload: Payload): Outcome {
  if (event === 'PING') return { status: 'processed', summary: 'Webhook Figma opérationnel (ping reçu).' };
  if (payload.file_key !== undefined && String(payload.file_key) !== source.external_id) {
    return { status: 'ignored', summary: 'Fichier Figma différent de la source.' };
  }
  if (event === 'FILE_VERSION_UPDATE') {
    const version = clip(payload.label, 100) || `version ${clip(payload.version_id, 40)}`;
    return announceRelease(source, version, { name: clip(payload.file_name, 200), prerelease: false, url: source.url, version_id: clip(payload.version_id, 60) });
  }
  if (event === 'FILE_COMMENT') {
    const project = projectInfo(source.project_id);
    if (!project) return { status: 'ignored', summary: 'Projet introuvable.' };
    const summary = clip(`Nouveau commentaire Figma sur ${clip(payload.file_name, 120) || source.full_name}${payload.triggered_by?.handle ? ` par ${clip(payload.triggered_by.handle, 60)}` : ''}`, 500);
    if (hit(`integrations.comment-notify:${source.id}`, 1, PUSH_NOTIFY_WINDOW_MS).allowed) {
      notify(project.owner_id, 'integrations.activity', 'Nouveau commentaire Figma', summary, `/projects/${project.id}`);
    }
    return { status: 'processed', summary };
  }
  return { status: 'ignored', summary: `Événement Figma non géré : ${clip(event, 60)}` };
}

const header = (req: Request, name: string) => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
};

function parseBody(req: Request, raw: Buffer): Payload | null {
  try {
    const text = raw.toString('utf8');
    if (/application\/x-www-form-urlencoded/i.test(header(req, 'content-type'))) {
      const payload = new URLSearchParams(text).get('payload');
      return payload ? JSON.parse(payload) : null;
    }
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const unauthorized = (res: Response) => { res.status(401).json({ error: 'Non autorisé.' }); };

/** Mounted on /api/integrations/webhooks (raw Buffer body, CSRF-exempt, no session). */
export const inboundRouter = Router();

inboundRouter.post('/:provider/:sourceId', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const ip = clientIp(req);
  if (!hit(`integrations.inbound.ip:${ip}`, 600, 60_000).allowed) { res.status(429).json({ error: 'Trop de requêtes.' }); return; }
  const providerParsed = providerSchema.safeParse(req.params.provider);
  const sourceId = typeof req.params.sourceId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(req.params.sourceId) ? req.params.sourceId : '';
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const source = providerParsed.success && sourceId
    ? one<SourceRow>('SELECT * FROM integration_project_sources WHERE id=? AND provider=?', sourceId, providerParsed.data) : undefined;
  const rejectAuth = () => {
    const failures = hit(`integrations.inbound.bad:${ip}:${sourceId}`, 30, 10 * 60_000);
    if (!failures.allowed) { res.status(429).json({ error: 'Trop de requêtes.' }); return; }
    unauthorized(res);
  };
  if (!source) { rejectAuth(); return; }
  const provider = source.provider;
  let secret: string;
  try { secret = unseal(source.webhook_secret_sealed, sourceSecretContext(source.id)); } catch { rejectAuth(); return; }

  let payload: Payload | null = null;
  let eventType = '';
  let deliveryId = '';
  if (provider === 'github') {
    const signature = header(req, 'x-hub-signature-256');
    if (!safeEqual(signature, `sha256=${hmacHex(secret, raw)}`)) { rejectAuth(); return; }
    eventType = clip(header(req, 'x-github-event'), 100);
    deliveryId = clip(header(req, 'x-github-delivery'), 200);
    payload = parseBody(req, raw);
  } else if (provider === 'gitlab') {
    if (!safeEqual(header(req, 'x-gitlab-token'), secret)) { rejectAuth(); return; }
    eventType = clip(header(req, 'x-gitlab-event'), 100);
    deliveryId = clip(header(req, 'x-gitlab-event-uuid') || header(req, 'idempotency-key'), 200) || `body:${sha256Hex(Buffer.concat([Buffer.from(`${source.id}:`), raw]))}`;
    payload = parseBody(req, raw);
  } else {
    payload = parseBody(req, raw);
    if (!payload || typeof payload.passcode !== 'string' || !safeEqual(payload.passcode, secret)) { rejectAuth(); return; }
    eventType = clip(payload.event_type, 100);
    deliveryId = `figma:${sha256Hex([source.id, payload.webhook_id, payload.event_type, payload.timestamp, payload.version_id ?? payload.comment_id ?? ''].map((part) => String(part ?? '')).join(':'))}`;
  }
  if (!payload || !eventType || !deliveryId) { res.status(400).json({ error: 'Charge utile invalide.' }); return; }
  if (!hit(`integrations.inbound.source:${source.id}`, 300, 60_000).allowed) { res.status(429).json({ error: 'Trop de requêtes.' }); return; }

  const result = transaction(() => {
    const eventId = id();
    const inserted = run(`INSERT INTO integration_inbound_events (id,provider,delivery_id,event_type,project_source_id,project_id,status)
      VALUES (?,?,?,?,?,?,'received') ON CONFLICT(provider,delivery_id) DO NOTHING`, eventId, provider, deliveryId, eventType, source.id, source.project_id);
    if (!inserted.changes) return { duplicate: true as const };
    let outcome: Outcome | { status: 'failed'; summary: string };
    try {
      outcome = transaction(() => provider === 'github' ? processGithub(source, eventType, payload!)
        : provider === 'gitlab' ? processGitlab(source, eventType, payload!) : processFigma(source, eventType, payload!));
    } catch (error) {
      log.error('integrations.inbound_failed', { provider, source: source.id, error });
      outcome = { status: 'failed', summary: 'Traitement impossible.' };
    }
    const at = now();
    run('UPDATE integration_inbound_events SET status=?,summary=?,processed_at=? WHERE id=?', outcome.status, clip(outcome.summary, 500), at, eventId);
    run('UPDATE integration_project_sources SET last_event_at=? WHERE id=?', at, source.id);
    return { duplicate: false as const, status: outcome.status };
  });
  res.status(200).json(result.duplicate ? { received: true, duplicate: true } : { received: true, status: result.status });
});
