import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, canCollaborateProject, canManageProject, canReadProject, HttpError, id, now, param, requireUser, safeUrl } from '../core.js';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const categories = [
  { value: 'ai', label: 'Intelligence artificielle' },
  { value: 'saas', label: 'SaaS & productivité' },
  { value: 'developer-tools', label: 'Outils développeurs' },
  { value: 'design', label: 'Design & création' },
  { value: 'climate', label: 'Climat & impact' },
  { value: 'health', label: 'Santé & bien-être' },
  { value: 'education', label: 'Éducation' },
  { value: 'other', label: 'Autre' },
];
const stages = [
  { value: 'idea', label: 'Idée' },
  { value: 'prototype', label: 'Prototype' },
  { value: 'beta', label: 'Bêta' },
  { value: 'launched', label: 'Lancé' },
];
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const projectUrl = z.string().trim()
  .pipe(z.union([z.literal(''), z.string().url().max(2000)]))
  .pipe(safeUrl);
const projectFields = z.object({
  title: z.string().trim().min(2).max(100),
  summary: z.string().trim().min(10).max(240),
  description: z.string().trim().max(12000),
  category: z.string().trim().min(1).max(60),
  stage: z.enum(['idea', 'prototype', 'beta', 'launched']),
  visibility: z.enum(['public', 'private']),
  organization_id: identifier.nullable(),
  repo_url: projectUrl,
  demo_url: projectUrl,
  tags: z.array(z.string().trim().min(1).max(30)).max(12).transform((values) => [...new Set(values)]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();
const createProject = projectFields.extend({
  description: projectFields.shape.description.default(''),
  stage: projectFields.shape.stage.default('prototype'),
  visibility: projectFields.shape.visibility.default('public'),
  organization_id: projectFields.shape.organization_id.default(null),
  repo_url: projectFields.shape.repo_url.default(''),
  demo_url: projectFields.shape.demo_url.default(''),
  tags: projectFields.shape.tags.default([]),
  color: projectFields.shape.color.default('#6658e8'),
});
const updateProject = projectFields.partial().refine((value) => Object.keys(value).length > 0, 'Indiquez au moins un champ à modifier.');
const querySchema = z.object({
  q: z.string().trim().max(120).default(''),
  search: z.string().trim().max(120).default(''),
  category: z.string().trim().max(60).default(''),
  stage: z.enum(['', 'idea', 'prototype', 'beta', 'launched']).default(''),
  mine: z.enum(['true', 'false', '1', '0']).default('false'),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

interface ProjectRow {
  id: string;
  owner_id: string;
  organization_id: string | null;
  title: string;
  summary: string;
  description: string;
  category: string;
  stage: string;
  visibility: 'public' | 'private';
  repo_url: string;
  demo_url: string;
  tags: string;
  color: string;
  created_at: string;
  updated_at: string;
}
interface ProjectResult extends ProjectRow {
  author_name: string;
  author_title: string;
  author_color: string;
  organization_name: string | null;
  campaign_count: number;
  open_campaign_count: number;
  integration_count: number;
}

const projection = `SELECT p.*, u.name AS author_name, u.title AS author_title,
  u.avatar_color AS author_color, o.name AS organization_name,
  (SELECT COUNT(*) FROM campaigns c WHERE c.project_id=p.id) AS campaign_count,
  (SELECT COUNT(*) FROM campaigns c WHERE c.project_id=p.id AND c.status='open') AS open_campaign_count,
  (SELECT COUNT(*) FROM integrations i WHERE i.project_id=p.id) AS integration_count
  FROM projects p JOIN users u ON u.id=p.owner_id
  LEFT JOIN organizations o ON o.id=p.organization_id`;

// Keep filtering in SQL before pagination; this mirrors canReadProject.
const readable = `(p.visibility='public' OR p.owner_id=? OR
  EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id AND om.user_id=?) OR
  EXISTS (SELECT 1 FROM campaigns c JOIN missions m ON m.campaign_id=c.id
    WHERE c.project_id=p.id AND m.tester_id=? AND m.status!='cancelled'))`;

function present(row: ProjectResult, userId?: string) {
  const { tags, author_name, author_title, author_color, organization_name, ...project } = row;
  const parsedTags: unknown = JSON.parse(tags);
  return {
    ...project,
    tags: z.array(z.string()).parse(parsedTags),
    author: { id: row.owner_id, name: author_name, title: author_title, avatar_color: author_color },
    organization: row.organization_id ? { id: row.organization_id, name: organization_name } : null,
    can_manage: !!userId && canManageProject(userId, row.id),
    can_collaborate: !!userId && canCollaborateProject(userId, row.id),
  };
}

function getProject(projectId: string, userId?: string) {
  if (!canReadProject(userId, projectId)) throw new HttpError(404, 'Projet introuvable.');
  const project = one<ProjectResult>(`${projection} WHERE p.id=?`, projectId);
  if (!project) throw new HttpError(404, 'Projet introuvable.');
  return present(project, userId);
}

function authorizeOrganization(organizationId: string | null, userId: string) {
  if (!organizationId) return;
  const organization = one(`SELECT o.id FROM organizations o WHERE o.id=? AND
    (o.owner_id=? OR EXISTS (SELECT 1 FROM organization_members om
    WHERE om.organization_id=o.id AND om.user_id=? AND om.role IN ('owner','admin')))`,
  organizationId, userId, userId);
  if (!organization) throw new HttpError(403, 'Vous devez être propriétaire ou administrateur de cette organisation.');
}

router.get('/options', (req, res) => {
  const userId = req.user?.id ?? '';
  const organizations = req.user ? all<{ id: string; name: string }>(`SELECT o.id,o.name FROM organizations o
    WHERE o.owner_id=? OR EXISTS (SELECT 1 FROM organization_members om
      WHERE om.organization_id=o.id AND om.user_id=? AND om.role IN ('owner','admin'))
    ORDER BY o.name COLLATE NOCASE LIMIT 100`, userId, userId) : [];
  const existingCategories = all<{ category: string }>(`SELECT DISTINCT p.category FROM projects p
    WHERE ${readable} ORDER BY p.category LIMIT 100`, userId, userId, userId);
  res.json({
    categories: [...categories, ...existingCategories
      .filter(({ category }) => !categories.some(({ value }) => value === category))
      .map(({ category }) => ({ value: category, label: category }))],
    stages,
    organizations,
  });
});

router.get('/', (req, res) => {
  const query = querySchema.parse(req.query);
  const userId = req.user?.id ?? '';
  const conditions = [readable];
  const values: (string | number)[] = [userId, userId, userId];
  if (query.mine === 'true' || query.mine === '1') {
    const user = requireUser(req);
    conditions.push('p.owner_id=?');
    values.push(user.id);
  }
  if (query.q || query.search) {
    const search = `%${(query.q || query.search).replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(p.title LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR p.tags LIKE ? ESCAPE '\\')");
    values.push(search, search, search);
  }
  if (query.category) { conditions.push('p.category=?'); values.push(query.category); }
  if (query.stage) { conditions.push('p.stage=?'); values.push(query.stage); }
  const where = conditions.join(' AND ');
  const stats = one<{ projects: number; open_campaigns: number; organizations: number }>(
    `SELECT COUNT(*) AS projects, COUNT(DISTINCT p.organization_id) AS organizations,
      COALESCE(SUM((SELECT COUNT(*) FROM campaigns c WHERE c.project_id=p.id AND c.status='open')),0) AS open_campaigns
      FROM projects p WHERE ${where}`, ...values)!;
  const projects = all<ProjectResult>(`${projection} WHERE ${where}
    ORDER BY p.updated_at DESC,p.id ASC LIMIT ? OFFSET ?`, ...values, query.limit, query.offset)
    .filter((project) => canReadProject(req.user?.id, project.id))
    .map((project) => present(project, req.user?.id));
  res.json({ projects, total: stats.projects, stats, limit: query.limit, offset: query.offset });
});

router.get('/:id', (req, res) => {
  res.json({ project: getProject(identifier.parse(param(req)), req.user?.id) });
});

router.post('/', (req, res) => {
  const user = requireUser(req);
  const input = createProject.parse(req.body);
  const projectId = id();
  transaction(() => {
    authorizeOrganization(input.organization_id, user.id);
    const timestamp = now();
    run(`INSERT INTO projects
      (id,owner_id,organization_id,title,summary,description,category,stage,visibility,repo_url,demo_url,tags,color,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    projectId, user.id, input.organization_id, input.title, input.summary, input.description,
    input.category, input.stage, input.visibility, input.repo_url, input.demo_url,
    JSON.stringify(input.tags), input.color, timestamp, timestamp);
    audit(user.id, 'project.created', 'project', projectId);
  });
  res.status(201).json({ project: getProject(projectId, user.id) });
});

router.patch('/:id', (req, res) => {
  const user = requireUser(req);
  const projectId = identifier.parse(param(req));
  const input = updateProject.parse(req.body);
  const project = transaction(() => {
    getProject(projectId, user.id);
    if (!canManageProject(user.id, projectId)) throw new HttpError(403, 'Vous ne pouvez pas modifier ce projet.');
    const existing = one<ProjectRow>('SELECT * FROM projects WHERE id=?', projectId)!;
    if (input.organization_id !== undefined && input.organization_id !== existing.organization_id) {
      if (input.organization_id === null && existing.owner_id !== user.id) {
        throw new HttpError(403, 'Seul le propriétaire peut retirer le projet de son organisation.');
      }
      authorizeOrganization(input.organization_id, user.id);
    }
    const updated = { ...existing, ...input, tags: input.tags === undefined ? existing.tags : JSON.stringify(input.tags) };
    run(`UPDATE projects SET title=?,summary=?,description=?,category=?,stage=?,visibility=?,
      organization_id=?,repo_url=?,demo_url=?,tags=?,color=?,updated_at=? WHERE id=?`,
    updated.title, updated.summary, updated.description, updated.category, updated.stage, updated.visibility,
    updated.organization_id, updated.repo_url, updated.demo_url, updated.tags, updated.color, now(), projectId);
    if (!canReadProject(user.id, projectId)) {
      throw new HttpError(403, 'Cette association retirerait votre accès au projet. Demandez à son propriétaire de la modifier.');
    }
    audit(user.id, 'project.updated', 'project', projectId);
    return getProject(projectId, user.id);
  });
  res.json({ project });
});

export default router;
