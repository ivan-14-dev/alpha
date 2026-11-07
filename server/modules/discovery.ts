import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { HttpError, param, requireUser } from '../core.js';

const router = Router();
const targetType = z.enum(['project', 'campaign', 'listing']);
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const integer = (fallback: string, minimum: number, maximum: number) =>
  z.string().regex(/^\d+$/).default(fallback).transform(Number).pipe(z.number().int().min(minimum).max(maximum));
const pagination = { limit: integer('20', 1, 50), offset: integer('0', 0, 10000) };
const searchQuery = z.object({
  q: z.string().trim().max(120).default(''),
  type: z.enum(['all', 'project', 'campaign', 'listing', 'person']).default('all'),
  ...pagination,
}).strict();
const libraryQuery = searchQuery.extend({ type: z.enum(['all', 'project', 'campaign', 'listing']).default('all') });

type ResourceType = 'project' | 'campaign' | 'listing' | 'person';
interface Resource {
  id: string; type: ResourceType; title: string; summary: string; detail: string;
  amount_cents: number | null; created_at: string; saved: number;
}

const resources = `WITH resources AS (
  SELECT p.id,'project' AS type,p.title,p.summary,p.category AS detail,NULL AS amount_cents,p.created_at,
    p.title || ' ' || p.summary || ' ' || p.description || ' ' || p.tags AS search_text
    FROM projects p WHERE p.visibility='public'
  UNION ALL
  SELECT c.id,'campaign',c.title,p.title,c.status,c.reward_cents,c.created_at,
    c.title || ' ' || c.description || ' ' || c.requirements || ' ' || p.title
    FROM campaigns c JOIN projects p ON p.id=c.project_id WHERE p.visibility='public'
  UNION ALL
  SELECT l.id,'listing',l.title,substr(l.description,1,240),l.kind,l.price_cents,l.created_at,
    l.title || ' ' || l.description || ' ' || l.deliverables
    FROM listings l WHERE l.status='active'
  UNION ALL
  SELECT u.id,'person',u.name,u.title,'',NULL,u.created_at,
    u.name || ' ' || u.title || ' ' || u.bio || ' ' || u.skills FROM users u
)`;

const paths: Record<ResourceType, string> = { project: '/projects/', campaign: '/missions/', listing: '/marketplace/', person: '/people/' };
const present = (resource: Resource) => ({
  ...resource, saved: Boolean(resource.saved), href: paths[resource.type] + encodeURIComponent(resource.id),
});

function visible(type: z.infer<typeof targetType>, targetId: string) {
  if (!one(`${resources} SELECT id FROM resources WHERE type=? AND id=?`, type, targetId)) {
    throw new HttpError(404, 'Cet élément public n’est plus disponible.');
  }
}

router.get('/search', (req, res) => {
  const query = searchQuery.parse(req.query);
  const escaped = query.q.replace(/[\\%_]/g, '\\$&');
  const where = "WHERE (?='all' OR r.type=?) AND r.search_text LIKE ? ESCAPE '\\'";
  const values = [query.type, query.type, `%${escaped}%`];
  const total = one<{ total: number }>(`${resources} SELECT COUNT(*) AS total FROM resources r ${where}`, ...values)!.total;
  const items = all<Resource>(`${resources} SELECT r.id,r.type,r.title,r.summary,r.detail,r.amount_cents,r.created_at,
    EXISTS(SELECT 1 FROM bookmarks b WHERE b.user_id=? AND b.target_type=r.type AND b.target_id=r.id) AS saved
    FROM resources r ${where}
    ORDER BY CASE WHEN r.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,r.created_at DESC,r.type,r.id LIMIT ? OFFSET ?`,
  req.user?.id ?? '', ...values, `${escaped}%`, query.limit, query.offset);
  res.json({ items: items.map(present), total, limit: query.limit, offset: query.offset });
});

router.get('/bookmarks', (req, res) => {
  const user = requireUser(req);
  const query = libraryQuery.parse(req.query);
  const search = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
  const from = `FROM bookmarks b JOIN resources r ON r.type=b.target_type AND r.id=b.target_id
    WHERE b.user_id=? AND (?='all' OR r.type=?) AND r.search_text LIKE ? ESCAPE '\\'`;
  const values = [user.id, query.type, query.type, search];
  const total = one<{ total: number }>(`${resources} SELECT COUNT(*) AS total ${from}`, ...values)!.total;
  const items = all<Resource>(`${resources} SELECT r.id,r.type,r.title,r.summary,r.detail,r.amount_cents,r.created_at,1 AS saved
    ${from} ORDER BY b.created_at DESC,b.target_type,b.target_id LIMIT ? OFFSET ?`, ...values, query.limit, query.offset);
  res.json({ items: items.map(present), total, limit: query.limit, offset: query.offset });
});

router.get('/bookmarks/:type/:id', (req, res) => {
  const user = requireUser(req);
  const type = targetType.parse(param(req, 'type'));
  const targetId = identifier.parse(param(req));
  visible(type, targetId);
  res.json({ saved: !!one('SELECT 1 FROM bookmarks WHERE user_id=? AND target_type=? AND target_id=?', user.id, type, targetId) });
});

router.post('/bookmarks/:type/:id', (req, res) => {
  const user = requireUser(req);
  const type = targetType.parse(param(req, 'type'));
  const targetId = identifier.parse(param(req));
  transaction(() => {
    visible(type, targetId);
    run('INSERT OR IGNORE INTO bookmarks(user_id,target_type,target_id) VALUES (?,?,?)', user.id, type, targetId);
  });
  res.json({ saved: true });
});

router.delete('/bookmarks/:type/:id', (req, res) => {
  const user = requireUser(req);
  const type = targetType.parse(param(req, 'type'));
  const targetId = identifier.parse(param(req));
  run('DELETE FROM bookmarks WHERE user_id=? AND target_type=? AND target_id=?', user.id, type, targetId);
  res.json({ saved: false });
});

export default router;
