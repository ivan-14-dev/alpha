import { Router } from 'express';
import { z } from 'zod';
import { audit, canManageProject, HttpError, id, now, param, requireUser, safeUrl } from '../core.js';
import { all, one, run, transaction } from '../db.js';

const router = Router();
const projectId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const providerSchema = z.enum(['github', 'gitlab', 'linear', 'figma']);
type Provider = z.infer<typeof providerSchema>;
interface Project { id: string; title: string }
interface Integration {
  id: string;
  project_id: string;
  provider: Provider;
  url: string;
  created_at: string;
}

const providerHosts: Record<Provider, string[]> = {
  github: ['github.com'],
  gitlab: ['gitlab.com'],
  linear: ['linear.app'],
  figma: ['figma.com', 'www.figma.com'],
};

function providerUrl(provider: Provider, value: string): string {
  const parsed = new URL(value);
  const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]?.toLowerCase();
  const validAuthority = providerHosts[provider].some((host) => authority === host || authority === `${host}:443`);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || !providerHosts[provider].includes(parsed.hostname) || !validAuthority
    || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new HttpError(400, `Utilisez une URL HTTPS sans identifiants sur ${providerHosts[provider].join(' ou ')}.`);
  }
  return parsed.href;
}

function managedProject(userId: string, value: unknown): Project {
  const parsedId = projectId.parse(value);
  const project = one<Project>('SELECT id,title FROM projects WHERE id=?', parsedId);
  if (!project) throw new HttpError(404, 'Projet introuvable.');
  if (!canManageProject(userId, parsedId)) throw new HttpError(403, 'Seuls les responsables du projet peuvent gérer ses intégrations et exporter ses rapports.');
  return project;
}

router.use((req, res, next) => {
  requireUser(req);
  res.set('Cache-Control', 'private, no-store');
  next();
});

router.get('/projects', (req, res) => {
  const user = requireUser(req);
  const offset = z.coerce.number().int().min(0).max(1000000).default(0).parse(req.query.offset);
  const projects = all<Project>(`SELECT p.id,p.title FROM projects p
    WHERE p.owner_id=? OR EXISTS (
      SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id
      AND om.user_id=? AND om.role IN ('owner','admin')
    ) ORDER BY p.updated_at DESC,p.id LIMIT 201 OFFSET ?`, user.id, user.id, offset);
  res.json({ projects: projects.slice(0, 200), has_more: projects.length > 200, offset });
});

router.get('/export', (req, res) => {
  const user = requireUser(req);
  const project = managedProject(user.id, req.query.project_id);
  const payload = transaction(() => {
    const campaigns = all(`SELECT id,project_id,title,description,kind,reward_cents,slots,
      requirements,target_devices,deadline,status,created_at FROM campaigns
      WHERE project_id=? ORDER BY created_at,id LIMIT 10001`, project.id);
    const missions = all(`SELECT m.id,m.campaign_id,m.status,m.decision_note,m.created_at,m.updated_at
      FROM missions m JOIN campaigns c ON c.id=m.campaign_id
      WHERE c.project_id=? ORDER BY m.created_at,m.id LIMIT 10001`, project.id);
    const reports = all(`SELECT r.id,r.mission_id,r.summary,r.steps,r.expected,r.observed,
      r.evidence_url,r.created_at,r.updated_at FROM test_reports r
      JOIN missions m ON m.id=r.mission_id JOIN campaigns c ON c.id=m.campaign_id
      WHERE c.project_id=? ORDER BY r.created_at,r.id LIMIT 10001`, project.id);
    if ([campaigns, missions, reports].some((rows) => rows.length > 10000)) {
      throw new HttpError(413, 'Ce projet dépasse la limite de 10 000 éléments par catégorie. Aucun export partiel n’a été généré.');
    }
    return { version: 1, exported_at: now(), project, financial_mode: 'demo', campaigns, missions, reports };
  });
  res.set('Content-Disposition', `attachment; filename="alpha-export-${project.id}.json"`);
  res.json(payload);
});

router.get('/', (req, res) => {
  const project = managedProject(requireUser(req).id, req.query.project_id);
  const integrations = all<Integration>('SELECT id,project_id,provider,url,created_at FROM integrations WHERE project_id=? ORDER BY provider LIMIT 4', project.id);
  res.json({ project, integrations });
});

router.post('/', (req, res) => {
  const user = requireUser(req);
  const input = z.object({
    project_id: projectId,
    provider: providerSchema,
    url: z.string().trim().min(1).max(2000).url().pipe(safeUrl),
  }).strict().parse(req.body);
  const project = managedProject(user.id, input.project_id);
  const url = providerUrl(input.provider, input.url);
  const integration = transaction(() => {
    run(`INSERT INTO integrations (id,project_id,provider,url) VALUES (?,?,?,?)
      ON CONFLICT(project_id,provider) DO UPDATE SET url=excluded.url`, id(), project.id, input.provider, url);
    const saved = one<Integration>('SELECT id,project_id,provider,url,created_at FROM integrations WHERE project_id=? AND provider=?', project.id, input.provider)!;
    audit(user.id, 'integration.link.saved', 'integration', saved.id, input.provider);
    return saved;
  });
  res.json({ integration });
});

router.delete('/:id', (req, res) => {
  const user = requireUser(req);
  const integrationId = projectId.parse(param(req));
  const integration = one<Integration>('SELECT id,project_id,provider,url,created_at FROM integrations WHERE id=?', integrationId);
  if (!integration) throw new HttpError(404, 'Lien enregistré introuvable.');
  managedProject(user.id, integration.project_id);
  transaction(() => {
    run('DELETE FROM integrations WHERE id=?', integration.id);
    audit(user.id, 'integration.link.deleted', 'integration', integration.id, integration.provider);
  });
  res.json({ deleted: true });
});

export default router;
