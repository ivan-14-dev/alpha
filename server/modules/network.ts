import { Router } from 'express';
import { z } from 'zod';
import { HttpError, notify, param, requireUser } from '../core.js';
import { all, one, run, transaction } from '../db.js';

const router = Router();
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const targetType = z.enum(['user', 'project']);
type TargetType = z.infer<typeof targetType>;

function assertTarget(type: TargetType, targetId: string) {
  const target = type === 'user'
    ? one('SELECT id FROM users WHERE id=?', targetId)
    : one("SELECT id FROM projects WHERE id=? AND visibility='public'", targetId);
  if (!target) throw new HttpError(404, type === 'user' ? 'Membre introuvable.' : 'Projet public introuvable.');
}

function status(type: TargetType, targetId: string, viewerId?: string) {
  assertTarget(type, targetId);
  const table = type === 'user' ? 'user_follows' : 'project_follows';
  const target = type === 'user' ? 'following_id' : 'project_id';
  const follower = type === 'user' ? 'follower_id' : 'user_id';
  return {
    following: !!one(`SELECT 1 FROM ${table} WHERE ${target}=? AND ${follower}=?`, targetId, viewerId ?? ''),
    followers: one<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${target}=?`, targetId)!.count,
    can_follow: !!viewerId && !(type === 'user' && targetId === viewerId),
  };
}

router.get('/status', (req, res) => {
  const query = z.object({ target_type: targetType, target_id: identifier }).parse(req.query);
  res.json(status(query.target_type, query.target_id, req.user?.id));
});

router.get('/following', (req, res) => {
  const user = requireUser(req);
  const query = z.object({
    type: z.enum(['users', 'projects']).default('users'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    page_size: z.coerce.number().int().min(1).max(50).default(20),
  }).parse(req.query);
  const from = query.type === 'users'
    ? 'FROM user_follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=?'
    : "FROM project_follows f JOIN projects p ON p.id=f.project_id WHERE f.user_id=? AND p.visibility='public'";
  const fields = query.type === 'users'
    ? `u.id,u.name,u.title,u.avatar_color,f.created_at AS followed_at,
      (SELECT COUNT(*) FROM user_follows followers WHERE followers.following_id=u.id) AS followers`
    : `p.id,p.title,p.summary,p.category,p.color,f.created_at AS followed_at,
      (SELECT COUNT(*) FROM project_follows followers WHERE followers.project_id=p.id) AS followers`;
  const items = all(`SELECT ${fields} ${from} ORDER BY f.created_at DESC,${query.type === 'users' ? 'u' : 'p'}.id DESC LIMIT ? OFFSET ?`,
    user.id, query.page_size, (query.page - 1) * query.page_size);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total ${from}`, user.id)!.total;
  res.json({ type: query.type, items, total, page: query.page, page_size: query.page_size, has_more: query.page * query.page_size < total });
});

for (const type of ['user', 'project'] as const) {
  const path = type === 'user' ? '/users/:id/follow' : '/projects/:id/follow';
  const table = type === 'user' ? 'user_follows' : 'project_follows';
  const target = type === 'user' ? 'following_id' : 'project_id';
  const follower = type === 'user' ? 'follower_id' : 'user_id';
  router.post(path, (req, res) => {
    const user = requireUser(req);
    const targetId = identifier.parse(param(req));
    const result = transaction(() => {
      assertTarget(type, targetId);
      if (type === 'user' && targetId === user.id) throw new HttpError(400, 'Vous ne pouvez pas vous suivre vous-même.');
      const inserted = run(`INSERT OR IGNORE INTO ${table} (${follower},${target}) VALUES (?,?)`, user.id, targetId);
      if (inserted.changes === 1) {
        const recipient = type === 'user' ? targetId : one<{ owner_id: string }>('SELECT owner_id FROM projects WHERE id=?', targetId)!.owner_id;
        if (recipient !== user.id) notify(recipient, 'network.follow',
          'Un nouveau suivi', type === 'user' ? 'Un membre suit désormais votre activité publique.' : 'Un membre suit désormais un de vos projets publics.',
          type === 'user' ? `/people/${user.id}` : '/network');
      }
      return status(type, targetId, user.id);
    });
    res.json(result);
  });
  router.delete(path, (req, res) => {
    const user = requireUser(req);
    const targetId = identifier.parse(param(req));
    // Do not inspect or disclose a target: stale follows remain removable after privatization.
    run(`DELETE FROM ${table} WHERE ${follower}=? AND ${target}=?`, user.id, targetId);
    res.json({ following: false });
  });
}

export default router;
