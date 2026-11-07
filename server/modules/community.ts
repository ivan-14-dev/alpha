import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { audit, canManageProject, HttpError, id, isPublicPost, notify, now, param, requireUser } from '../core.js';
import { all, one, run, transaction } from '../db.js';

const router = Router();
const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const pagination = {
  page: z.coerce.number().int().min(1).max(10000).default(1),
  page_size: z.coerce.number().int().min(1).max(50).default(20),
};
const groupInput = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().min(1).max(2000),
  category: z.string().trim().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#6658e8'),
}).strict();
const postInput = z.object({
  body: z.string().trim().min(1).max(5000),
  group_id: identifier.optional(),
  project_id: identifier.optional(),
}).strict().refine((input) => !(input.group_id && input.project_id), 'Choisissez un groupe ou un projet, pas les deux.');
const commentInput = z.object({ body: z.string().trim().min(1).max(2000) }).strict();

interface AuthorRow {
  author_id: string;
  author_name: string;
  author_title: string;
  author_color: string;
}
interface GroupRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  category: string;
  color: string;
  created_at: string;
  member_count: number;
  is_member: number;
  owner_name: string;
  owner_title: string;
  owner_color: string;
}
interface PostRow extends AuthorRow {
  id: string;
  group_id: string | null;
  group_name: string | null;
  project_id: string | null;
  project_title: string | null;
  body: string;
  created_at: string;
  like_count: number;
  comment_count: number;
  liked: number;
}
interface CommentRow extends AuthorRow {
  id: string;
  post_id: string;
  body: string;
  created_at: string;
}

const groupSelect = `SELECT g.id,g.owner_id,g.name,g.description,g.category,g.color,g.created_at,
  u.name AS owner_name,u.title AS owner_title,u.avatar_color AS owner_color,
  (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count,
  EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=g.id AND gm.user_id=?) AS is_member
  FROM groups g JOIN users u ON u.id=g.owner_id`;
const publicPostCondition = "(p.project_id IS NULL OR EXISTS (SELECT 1 FROM projects project WHERE project.id=p.project_id AND project.visibility='public'))";
const postSelect = `SELECT p.id,p.author_id,p.group_id,p.project_id,p.body,p.created_at,g.name AS group_name,
  project.title AS project_title,
  u.name AS author_name,u.title AS author_title,u.avatar_color AS author_color,
  (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS comment_count,
  EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=?) AS liked
  FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN groups g ON g.id=p.group_id
  LEFT JOIN projects project ON project.id=p.project_id`;
const commentSelect = `SELECT c.id,c.post_id,c.author_id,c.body,c.created_at,
  u.name AS author_name,u.title AS author_title,u.avatar_color AS author_color
  FROM comments c JOIN users u ON u.id=c.author_id`;

function publicAuthor(row: AuthorRow) {
  return { id: row.author_id, name: row.author_name, title: row.author_title, avatar_color: row.author_color };
}
function publicGroup(row: GroupRow) {
  return {
    id: row.id, owner_id: row.owner_id, name: row.name, description: row.description,
    category: row.category, color: row.color, created_at: row.created_at,
    visibility: 'public' as const, member_count: row.member_count, is_member: !!row.is_member,
    owner: { id: row.owner_id, name: row.owner_name, title: row.owner_title, avatar_color: row.owner_color },
  };
}
function publicPost(row: PostRow) {
  return {
    id: row.id, body: row.body, created_at: row.created_at, author: publicAuthor(row),
    group_id: row.group_id, group_name: row.group_name,
    project_id: row.project_id, project_title: row.project_title,
    like_count: row.like_count, comment_count: row.comment_count, liked: !!row.liked,
  };
}
function publicComment(row: CommentRow) {
  return { id: row.id, post_id: row.post_id, body: row.body, created_at: row.created_at, author: publicAuthor(row) };
}
function groupById(groupId: string, viewerId?: string) {
  const group = one<GroupRow>(`${groupSelect} WHERE g.id=?`, viewerId ?? '', groupId);
  if (!group) throw new HttpError(404, 'Groupe introuvable.');
  return publicGroup(group);
}
function postById(postId: string, viewerId?: string) {
  const post = one<PostRow>(`${postSelect} WHERE p.id=? AND ${publicPostCondition}`, viewerId ?? '', postId);
  if (!post) throw new HttpError(404, 'Publication introuvable.');
  return publicPost(post);
}
function pathId(req: Request, key = 'id') {
  return identifier.parse(param(req, key));
}
function pageInfo(total: number, page: number, pageSize: number) {
  return { total, page, page_size: pageSize, has_more: page * pageSize < total };
}
function commentCount(postId: string) {
  return one<{ count: number }>('SELECT COUNT(*) AS count FROM comments WHERE post_id=?', postId)!.count;
}
function publicProject(projectId: string) {
  const project = one<{ id: string; title: string }>("SELECT id,title FROM projects WHERE id=? AND visibility='public'", projectId);
  if (!project) throw new HttpError(404, 'Projet public introuvable.');
  return project;
}

router.get('/publishable-projects', (req, res) => {
  const user = requireUser(req);
  const query = z.object({ ...pagination, project: identifier.optional() }).parse(req.query);
  const where = `WHERE p.visibility='public' AND (p.owner_id=? OR EXISTS (
    SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id
      AND om.user_id=? AND om.role IN ('owner','admin')))${query.project ? ' AND p.id=?' : ''}`;
  const values = [user.id, user.id, ...(query.project ? [query.project] : [])];
  const projects = all<{ id: string; title: string }>(`SELECT p.id,p.title FROM projects p ${where}
    ORDER BY p.title,p.id LIMIT ? OFFSET ?`, ...values, query.page_size, (query.page - 1) * query.page_size);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM projects p ${where}`, ...values)!.total;
  res.json({ projects, ...pageInfo(total, query.page, query.page_size) });
});

router.get('/groups', (req, res) => {
  const query = z.object({
    ...pagination,
    q: z.string().trim().max(100).default(''),
    category: z.string().trim().max(60).default(''),
  }).parse(req.query);
  const conditions: string[] = [];
  const values: string[] = [];
  if (query.q) {
    const search = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push("(g.name LIKE ? ESCAPE '\\' OR g.description LIKE ? ESCAPE '\\')");
    values.push(search, search);
  }
  if (query.category) {
    conditions.push('g.category=?');
    values.push(query.category);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const groups = all<GroupRow>(`${groupSelect}${where}
    ORDER BY member_count DESC,g.created_at DESC,g.id DESC LIMIT ? OFFSET ?`,
  req.user?.id ?? '', ...values, query.page_size, (query.page - 1) * query.page_size).map(publicGroup);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM groups g${where}`, ...values)!.total;
  const categories = all<{ category: string }>('SELECT DISTINCT category FROM groups ORDER BY category LIMIT 100')
    .map((row) => row.category);
  res.json({ groups, categories, ...pageInfo(total, query.page, query.page_size) });
});

router.get('/groups/:id', (req, res) => {
  res.json({ group: groupById(pathId(req), req.user?.id) });
});

router.post('/groups', (req, res) => {
  const user = requireUser(req);
  const input = groupInput.parse(req.body);
  const groupId = id();
  const group = transaction(() => {
    run('INSERT INTO groups (id,owner_id,name,description,category,color,created_at) VALUES (?,?,?,?,?,?,?)',
      groupId, user.id, input.name, input.description, input.category, input.color, now());
    run('INSERT INTO group_members (group_id,user_id) VALUES (?,?)', groupId, user.id);
    audit(user.id, 'community.group.created', 'group', groupId);
    return groupById(groupId, user.id);
  });
  res.status(201).json({ group });
});

router.post('/groups/:id/join', (req, res) => {
  const user = requireUser(req);
  const groupId = pathId(req);
  const group = transaction(() => {
    groupById(groupId, user.id);
    run('INSERT OR IGNORE INTO group_members (group_id,user_id) VALUES (?,?)', groupId, user.id);
    return groupById(groupId, user.id);
  });
  res.json({ group });
});

router.post('/groups/:id/leave', (req, res) => {
  const user = requireUser(req);
  const groupId = pathId(req);
  const group = transaction(() => {
    const existing = groupById(groupId, user.id);
    if (existing.owner_id === user.id) throw new HttpError(409, 'Le créateur ne peut pas quitter son groupe.');
    run('DELETE FROM group_members WHERE group_id=? AND user_id=?', groupId, user.id);
    return groupById(groupId, user.id);
  });
  res.json({ group });
});

router.get('/posts', (req, res) => {
  const query = z.object({
    ...pagination, group: identifier.optional(), project: identifier.optional(),
    feed: z.enum(['discovery', 'following']).default('discovery'),
  }).parse(req.query);
  const viewer = query.feed === 'following' ? requireUser(req).id : req.user?.id;
  if (query.group) groupById(query.group, req.user?.id);
  const project = query.project ? publicProject(query.project) : undefined;
  const conditions = [publicPostCondition];
  const values: string[] = [];
  if (query.group) { conditions.push('p.group_id=?'); values.push(query.group); }
  if (query.project) { conditions.push('p.project_id=?'); values.push(query.project); }
  if (query.feed === 'following') {
    conditions.push(`(p.author_id=? OR EXISTS (SELECT 1 FROM user_follows uf WHERE uf.follower_id=? AND uf.following_id=p.author_id)
      OR EXISTS (SELECT 1 FROM project_follows pf WHERE pf.user_id=? AND pf.project_id=p.project_id)
      OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id=? AND gm.group_id=p.group_id))`);
    values.push(viewer!, viewer!, viewer!, viewer!);
  }
  const where = ` WHERE ${conditions.join(' AND ')}`;
  const posts = all<PostRow>(`${postSelect}${where} ORDER BY p.created_at DESC,p.id DESC LIMIT ? OFFSET ?`,
    req.user?.id ?? '', ...values, query.page_size, (query.page - 1) * query.page_size).map(publicPost);
  const total = one<{ total: number }>(`SELECT COUNT(*) AS total FROM posts p${where}`, ...values)!.total;
  res.json({ posts, ...(project ? { project } : {}), ...pageInfo(total, query.page, query.page_size) });
});

router.get('/posts/:id', (req, res) => {
  res.json({ post: postById(pathId(req), req.user?.id) });
});

router.post('/posts', (req, res) => {
  const user = requireUser(req);
  const input = postInput.parse(req.body);
  const postId = id();
  const post = transaction(() => {
    if (input.group_id) {
      const group = groupById(input.group_id, user.id);
      if (!group.is_member) throw new HttpError(403, 'Rejoignez ce groupe public pour y publier.');
    }
    if (input.project_id) {
      publicProject(input.project_id);
      if (!canManageProject(user.id, input.project_id)) throw new HttpError(403, 'Seuls les responsables du projet peuvent publier ses actualités.');
    }
    run('INSERT INTO posts (id,author_id,group_id,project_id,body,created_at) VALUES (?,?,?,?,?,?)',
      postId, user.id, input.group_id ?? null, input.project_id ?? null, input.body, now());
    if (input.project_id) {
      const followers = all<{ user_id: string }>('SELECT user_id FROM project_follows WHERE project_id=? AND user_id<>?', input.project_id, user.id);
      for (const follower of followers) notify(follower.user_id, 'community.project_update', 'Une nouvelle actualité de projet',
        'Un projet que vous suivez a partagé une actualité publique.', `/community?project=${input.project_id}`);
    }
    return postById(postId, user.id);
  });
  res.status(201).json({ post });
});

router.delete('/posts/:id', (req, res) => {
  const user = requireUser(req);
  const postId = pathId(req);
  transaction(() => {
    const post = postById(postId, user.id);
    if (post.author.id !== user.id) throw new HttpError(403, 'Vous ne pouvez supprimer que vos publications.');
    run('DELETE FROM comments WHERE post_id=?', postId);
    run('DELETE FROM post_likes WHERE post_id=?', postId);
    run('DELETE FROM posts WHERE id=?', postId);
    audit(user.id, 'community.post.deleted', 'post', postId);
  });
  res.json({ deleted: true });
});

router.post('/posts/:id/like', (req, res) => {
  const user = requireUser(req);
  const postId = pathId(req);
  const result = transaction(() => {
    const post = postById(postId, user.id);
    if (post.liked) run('DELETE FROM post_likes WHERE post_id=? AND user_id=?', postId, user.id);
    else run('INSERT INTO post_likes (post_id,user_id) VALUES (?,?)', postId, user.id);
    return { liked: !post.liked, like_count: post.like_count + (post.liked ? -1 : 1) };
  });
  res.json(result);
});

router.get('/posts/:id/like', (req, res) => {
  const post = postById(pathId(req), req.user?.id);
  res.json({ liked: post.liked, like_count: post.like_count });
});

router.get('/posts/:id/comments', (req, res) => {
  const postId = pathId(req);
  postById(postId, req.user?.id);
  const query = z.object(pagination).parse(req.query);
  const comments = all<CommentRow>(`${commentSelect} WHERE c.post_id=? ORDER BY c.created_at,c.id LIMIT ? OFFSET ?`,
    postId, query.page_size, (query.page - 1) * query.page_size).map(publicComment);
  res.json({ comments, ...pageInfo(commentCount(postId), query.page, query.page_size) });
});

router.post('/posts/:id/comments', (req, res) => {
  const user = requireUser(req);
  const postId = pathId(req);
  const input = commentInput.parse(req.body);
  const result = transaction(() => {
    postById(postId, user.id);
    const commentId = id();
    run('INSERT INTO comments (id,post_id,author_id,body,created_at) VALUES (?,?,?,?,?)',
      commentId, postId, user.id, input.body, now());
    const comment = publicComment(one<CommentRow>(`${commentSelect} WHERE c.id=?`, commentId)!);
    return { comment, comment_count: commentCount(postId) };
  });
  res.status(201).json(result);
});

function deleteComment(req: Request, res: Response) {
  const user = requireUser(req);
  const commentId = pathId(req, req.params.commentId ? 'commentId' : 'id');
  const nestedPostId = req.params.commentId ? pathId(req) : undefined;
  const result = transaction(() => {
    if (nestedPostId) postById(nestedPostId, user.id);
    const comment = one<CommentRow>(`${commentSelect} WHERE c.id=?`, commentId);
    if (!comment || (nestedPostId && comment.post_id !== nestedPostId)) {
      throw new HttpError(404, 'Commentaire introuvable.');
    }
    if (!isPublicPost(comment.post_id)) throw new HttpError(404, 'Commentaire introuvable.');
    if (comment.author_id !== user.id) throw new HttpError(403, 'Vous ne pouvez supprimer que vos commentaires.');
    run('DELETE FROM comments WHERE id=?', commentId);
    audit(user.id, 'community.comment.deleted', 'comment', commentId);
    return { deleted: true, comment_count: commentCount(comment.post_id) };
  });
  res.json(result);
}
router.delete('/posts/:id/comments/:commentId', deleteComment);
router.delete('/comments/:id', deleteComment);

export default router;
