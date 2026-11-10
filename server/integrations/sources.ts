import { Router } from 'express';
import { z } from 'zod';
import { audit, canManageProject, HttpError, id, now, param, requireUser } from '../core.js';
import { all, one, run, transaction } from '../db.js';
import { hit } from '../platform/rateLimit.js';
import { randomToken, seal } from '../platform/secrets.js';
import { ProviderError, providerFailure } from './http.js';
import { accessToken, activeConnection, markConnectionError, requireConnection, type ConnectionRow } from './connections.js';
import { sourceSecretContext, type SourceRow } from './inbound.js';
import {
  createProviderWebhook, deleteProviderWebhook, figmaFile, githubRepository, gitlabProject, inboundWebhookUrl, listGithubRepos,
  listGitlabProjects, providerConfig, providerLabels, providerSchema, type ProviderId,
} from './providers.js';

export const MAX_SOURCES_PER_PROJECT = 20;
export const projectIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const pageSchema = z.coerce.number().int().min(1).max(100).default(1);

export function managedProject(userId: string, value: unknown) {
  const projectId = projectIdSchema.parse(value);
  const project = one<{ id: string; title: string }>('SELECT id,title FROM projects WHERE id=?', projectId);
  if (!project) throw new HttpError(404, 'Projet introuvable.');
  if (!canManageProject(userId, projectId)) throw new HttpError(403, 'Seuls les responsables du projet peuvent gérer ses intégrations.');
  return project;
}

export function publicSource(row: SourceRow) {
  return {
    id: row.id,
    project_id: row.project_id,
    provider: row.provider,
    label: providerLabels[row.provider],
    external_id: row.external_id,
    full_name: row.full_name,
    url: row.url,
    default_branch: row.default_branch,
    setup: row.setup,
    inbound_url: inboundWebhookUrl(row.provider, row.id),
    created_by: row.created_by,
    created_at: row.created_at,
    last_event_at: row.last_event_at,
  };
}

export function recentInbound(projectId: string, limit = 20) {
  return all(`SELECT e.id,e.provider,e.event_type,e.project_source_id,e.status,e.summary,e.received_at,e.processed_at,s.full_name
    FROM integration_inbound_events e LEFT JOIN integration_project_sources s ON s.id=e.project_source_id
    WHERE e.project_id=? ORDER BY e.received_at DESC LIMIT ?`, projectId, limit);
}

/** Token for API calls on behalf of the member; marks the connection when the provider rejects it. */
async function withToken<T>(connection: ConnectionRow, work: (token: string) => Promise<T>): Promise<T> {
  const token = await accessToken(connection);
  try {
    return await work(token);
  } catch (error) {
    if (error instanceof ProviderError && error.status === 401) markConnectionError(connection.id, 'unauthorized');
    return providerFailure(error, providerLabels[connection.provider]);
  }
}

function manualInstructions(provider: ProviderId, url: string, secret: string): string[] {
  if (provider === 'github') {
    return [
      'Sur GitHub, ouvrez le dépôt → Settings → Webhooks → Add webhook.',
      `Payload URL : ${url}`,
      'Content type : application/json.',
      'Secret : collez le secret affiché ci-dessous (il ne sera plus affiché).',
      'Événements : « Let me select individual events » → Pushes et Releases.',
    ];
  }
  if (provider === 'gitlab') {
    return [
      'Sur GitLab, ouvrez le projet → Settings → Webhooks → Add new webhook.',
      `URL : ${url}`,
      'Secret token : collez le secret affiché ci-dessous (il ne sera plus affiché).',
      'Déclencheurs : Push events, Tag push events et Releases events. Laissez la vérification SSL activée.',
    ];
  }
  return [
    'Figma ne permet de créer des webhooks que via son API (POST /v2/webhooks) avec un jeton disposant du scope webhooks:write.',
    `endpoint : ${url}`,
    `passcode : le secret affiché ci-dessous (${secret.length} caractères, il ne sera plus affiché).`,
    'Créez un webhook par événement : FILE_VERSION_UPDATE et FILE_COMMENT (context « file », context_id = clé du fichier).',
  ];
}

export const sourcesRouter = Router();

sourcesRouter.get('/github/repos', async (req, res) => {
  const user = requireUser(req);
  const page = pageSchema.parse(req.query.page);
  if (!hit(`integrations.repos:${user.id}`, 60, 60_000).allowed) throw new HttpError(429, 'Trop de requêtes. Réessayez dans une minute.');
  const connection = requireConnection(user.id, 'github');
  res.json({ page, ...await withToken(connection, (token) => listGithubRepos(token, page)) });
});

sourcesRouter.get('/gitlab/projects', async (req, res) => {
  const user = requireUser(req);
  const page = pageSchema.parse(req.query.page);
  const search = z.string().trim().max(100).default('').parse(req.query.search ?? '');
  if (!hit(`integrations.repos:${user.id}`, 60, 60_000).allowed) throw new HttpError(429, 'Trop de requêtes. Réessayez dans une minute.');
  const connection = requireConnection(user.id, 'gitlab');
  res.json({ page, ...await withToken(connection, (token) => listGitlabProjects(token, connection.base_url, page, search)) });
});

sourcesRouter.get('/projects/:projectId/sources', (req, res) => {
  const project = managedProject(requireUser(req).id, param(req, 'projectId'));
  const sources = all<SourceRow>('SELECT * FROM integration_project_sources WHERE project_id=? ORDER BY created_at', project.id);
  res.json({ project, sources: sources.map(publicSource), inbound_events: recentInbound(project.id) });
});

sourcesRouter.get('/projects/:projectId/inbound-events', (req, res) => {
  const project = managedProject(requireUser(req).id, param(req, 'projectId'));
  const limit = z.coerce.number().int().min(1).max(100).default(50).parse(req.query.limit);
  res.json({ events: recentInbound(project.id, limit) });
});

const createSourceSchema = z.object({
  provider: providerSchema,
  external_id: z.string().trim().regex(/^\d{1,20}$/, 'Identifiant numérique attendu.').optional(),
  full_name: z.string().trim().min(3).max(300).regex(/^[\w.-]+(\/[\w.-]+)+$/, 'Format attendu : propriétaire/dépôt.')
    .refine((value) => !value.split('/').some((segment) => /^\.+$/.test(segment)), 'Format attendu : propriétaire/dépôt.').optional(),
  file_key: z.string().trim().regex(/^[a-zA-Z0-9]{10,64}$/, 'Clé de fichier Figma invalide.').optional(),
  manual: z.boolean().optional(),
}).strict();

sourcesRouter.post('/projects/:projectId/sources', async (req, res) => {
  const user = requireUser(req);
  const project = managedProject(user.id, param(req, 'projectId'));
  const input = createSourceSchema.parse(req.body);
  const provider = input.provider;
  if (!hit(`integrations.sources:${user.id}`, 30, 3600_000).allowed) throw new HttpError(429, 'Trop de sources créées. Réessayez plus tard.');
  const count = one<{ total: number }>('SELECT COUNT(*) AS total FROM integration_project_sources WHERE project_id=?', project.id)!.total;
  if (count >= MAX_SOURCES_PER_PROJECT) throw new HttpError(409, `Un projet peut lier au plus ${MAX_SOURCES_PER_PROJECT} sources.`);
  const reference = provider === 'figma' ? input.file_key ?? input.external_id : input.external_id ?? input.full_name;
  if (!reference) throw new HttpError(400, provider === 'figma' ? 'Indiquez la clé du fichier Figma.' : 'Indiquez le dépôt (propriétaire/nom) ou son identifiant.');
  if (provider === 'figma' && !/^[a-zA-Z0-9]{10,64}$/.test(reference)) throw new HttpError(400, 'Clé de fichier Figma invalide.');

  const connection = activeConnection(user.id, provider);
  const baseUrl = providerConfig(provider).base_url;
  let resolved: { external_id: string; full_name: string; url: string; default_branch: string; hookRef: string };
  if (connection) {
    resolved = await withToken(connection, async (token) => {
      if (provider === 'github') {
        const repo = await githubRepository(token, reference);
        return { ...repo, hookRef: repo.full_name };
      }
      if (provider === 'gitlab') {
        const repo = await gitlabProject(token, connection.base_url, reference);
        return { ...repo, hookRef: repo.external_id };
      }
      const file = await figmaFile(token, reference);
      return { external_id: reference, full_name: file.name.slice(0, 300) || reference, url: `https://www.figma.com/design/${reference}`, default_branch: '', hookRef: reference };
    });
  } else {
    if (provider !== 'figma' && !input.full_name) throw new HttpError(400, 'Sans compte connecté, indiquez le dépôt au format propriétaire/nom.');
    const name = provider === 'figma' ? reference : input.full_name!;
    resolved = {
      external_id: provider === 'figma' ? reference : name.toLowerCase(),
      full_name: name,
      url: provider === 'github' ? `https://github.com/${name}` : provider === 'gitlab' ? `${baseUrl}/${name}` : `https://www.figma.com/design/${reference}`,
      default_branch: '',
      hookRef: name,
    };
  }

  const sourceId = id();
  const secret = randomToken(32);
  transaction(() => {
    const duplicate = one('SELECT id FROM integration_project_sources WHERE project_id=? AND provider=? AND (external_id=? OR lower(full_name)=lower(?))',
      project.id, provider, resolved.external_id, resolved.full_name);
    if (duplicate) throw new HttpError(409, 'Cette source est déjà liée au projet.');
    run(`INSERT INTO integration_project_sources (id,project_id,provider,base_url,connection_id,external_id,full_name,url,default_branch,webhook_secret_sealed,setup,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,'manual',?)`, sourceId, project.id, provider, connection?.base_url ?? baseUrl, connection?.id ?? null,
    resolved.external_id, resolved.full_name, resolved.url, resolved.default_branch, seal(secret, sourceSecretContext(sourceId)), user.id);
    audit(user.id, 'integration.source.created', 'integration_source', sourceId, provider);
  });

  const inboundUrl = inboundWebhookUrl(provider, sourceId);
  let automaticError = '';
  if (connection && !input.manual) {
    try {
      const token = await accessToken(connection);
      const hookId = await createProviderWebhook(provider, token, connection.base_url, resolved.hookRef, inboundUrl, secret);
      run(`UPDATE integration_project_sources SET provider_webhook_id=?,setup='automatic',updated_at=? WHERE id=?`, hookId, now(), sourceId);
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : error instanceof HttpError ? error.status : 0;
      automaticError = status === 403 || status === 404
        ? `Le compte connecté n’a pas les droits pour créer le webhook (${provider === 'github' ? 'administrateur du dépôt, scope admin:repo_hook' : provider === 'gitlab' ? 'rôle Maintainer et scope api' : 'scope webhooks:write'}).`
        : status === 422 || status === 400
          ? `${providerLabels[provider]} a refusé l’URL de réception (elle doit être publique et en HTTPS).`
          : `${providerLabels[provider]} n’a pas pu créer le webhook automatiquement.`;
    }
  }
  const source = one<SourceRow>('SELECT * FROM integration_project_sources WHERE id=?', sourceId)!;
  res.status(201).json({
    source: publicSource(source),
    setup: source.setup === 'automatic'
      ? { mode: 'automatic', url: inboundUrl }
      : { mode: 'manual', url: inboundUrl, secret, reason: automaticError || null, instructions: manualInstructions(provider, inboundUrl, secret) },
  });
});

function managedSource(userId: string, projectValue: string, sourceValue: string): SourceRow {
  const project = managedProject(userId, projectValue);
  const source = one<SourceRow>('SELECT * FROM integration_project_sources WHERE id=? AND project_id=?', projectIdSchema.parse(sourceValue), project.id);
  if (!source) throw new HttpError(404, 'Source introuvable.');
  return source;
}

/** Regenerates the secret of a MANUAL source (the automatic hook would need to be recreated at the provider). */
sourcesRouter.post('/projects/:projectId/sources/:sourceId/rotate-secret', (req, res) => {
  const user = requireUser(req);
  const source = managedSource(user.id, param(req, 'projectId'), param(req, 'sourceId'));
  if (source.setup !== 'manual') throw new HttpError(409, 'Ce webhook est géré automatiquement : supprimez puis liez de nouveau la source pour changer son secret.');
  const secret = randomToken(32);
  transaction(() => {
    run('UPDATE integration_project_sources SET webhook_secret_sealed=?,updated_at=? WHERE id=?', seal(secret, sourceSecretContext(source.id)), now(), source.id);
    audit(user.id, 'integration.source.secret_rotated', 'integration_source', source.id, source.provider);
  });
  const url = inboundWebhookUrl(source.provider, source.id);
  res.json({ source: publicSource(source), setup: { mode: 'manual', url, secret, reason: null, instructions: manualInstructions(source.provider, url, secret) } });
});

sourcesRouter.delete('/projects/:projectId/sources/:sourceId', async (req, res) => {
  const user = requireUser(req);
  const source = managedSource(user.id, param(req, 'projectId'), param(req, 'sourceId'));
  transaction(() => {
    run('DELETE FROM integration_project_sources WHERE id=?', source.id);
    audit(user.id, 'integration.source.deleted', 'integration_source', source.id, source.provider);
  });
  let removed = false;
  if (source.provider_webhook_id) {
    const connection = (source.connection_id
      ? one<ConnectionRow>('SELECT * FROM integration_connections WHERE id=? AND revoked_at IS NULL', source.connection_id)
      : undefined) ?? activeConnection(user.id, source.provider);
    if (connection) {
      try {
        const token = await accessToken(connection);
        const hookRef = source.provider === 'github' ? source.full_name : source.external_id;
        await deleteProviderWebhook(source.provider, token, connection.base_url, hookRef, source.provider_webhook_id);
        removed = true;
      } catch { /* best effort: the inbound URL now answers 401, the provider will disable it */ }
    }
  }
  res.json({ deleted: true, provider_webhook_removed: removed, manual_cleanup: !!source.provider_webhook_id && !removed });
});
