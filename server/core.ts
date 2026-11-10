import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { one, run } from './db.js';
import { emitDomainEvent, emitNotification } from './platform/events.js';
import { log } from './platform/log.js';

export interface User {
  id: string;
  name: string;
  email: string;
  title: string;
  bio: string;
  skills: string;
  avatar_color: string;
  role: 'member' | 'admin';
  created_at: string;
}

declare global {
  namespace Express {
    interface Request { user?: User }
  }
}

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const safeUrl = z.union([z.literal(''), z.string().url().max(2000).refine((value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol), 'URL HTTP ou HTTPS requise')]);

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function requireUser(req: Request): User {
  if (!req.user) throw new HttpError(401, 'Connectez-vous pour continuer.');
  return req.user;
}

export function requireAdmin(req: Request): User {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new HttpError(403, 'Acces reserve a la moderation.');
  return user;
}

export function param(req: Request, key = 'id'): string {
  const value = req.params[key];
  if (typeof value !== 'string') throw new HttpError(400, 'Identifiant invalide.');
  return value;
}

export function canManageProject(userId: string, projectId: string): boolean {
  return !!one(`SELECT p.id FROM projects p WHERE p.id = ? AND
    (p.owner_id = ? OR EXISTS (SELECT 1 FROM organization_members om
    WHERE om.organization_id = p.organization_id AND om.user_id = ? AND om.role IN ('owner','admin')))`,
  projectId, userId, userId);
}

export function canReadProject(userId: string | undefined, projectId: string): boolean {
  return !!one(`SELECT p.id FROM projects p WHERE p.id = ? AND (p.visibility = 'public'
    OR p.owner_id = ? OR EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.user_id = ?)
    OR EXISTS (SELECT 1 FROM campaigns c JOIN missions m ON m.campaign_id = c.id WHERE c.project_id = p.id AND m.tester_id = ? AND m.status != 'cancelled'))`,
  projectId, userId ?? '', userId ?? '', userId ?? '');
}

export function canCollaborateProject(userId: string, projectId: string): boolean {
  return !!one(`SELECT p.id FROM projects p WHERE p.id=? AND (p.owner_id=? OR
    EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id=p.organization_id AND om.user_id=?))`,
  projectId, userId, userId);
}

export function isPublicPost(postId: string): boolean {
  return !!one(`SELECT p.id FROM posts p LEFT JOIN projects project ON project.id=p.project_id
    WHERE p.id=? AND (p.project_id IS NULL OR project.visibility='public')`, postId);
}

/** Inserts an in-app notification, then runs channel hooks (realtime, email, push) in the same transaction. */
export function notify(userId: string, kind: string, title: string, body = '', link = '/') {
  const notificationId = id();
  run('INSERT INTO notifications (id,user_id,kind,title,body,link) VALUES (?,?,?,?,?,?)', notificationId, userId, kind, title, body, link);
  emitNotification({ id: notificationId, user_id: userId, kind, title, body, link });
  return notificationId;
}

/** Audit trail entry. Also published as a domain event (outgoing webhooks, risk detectors) in the same transaction. */
export function audit(actorId: string, action: string, targetType: string, targetId: string, detail = '') {
  run('INSERT INTO audit_events (id,actor_id,action,target_type,target_id,detail) VALUES (?,?,?,?,?,?)',
    id(), actorId, action, targetType, targetId, detail);
  emitDomainEvent({ action, actor_id: actorId, target_type: targetType, target_id: targetId, detail });
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Verifiez les champs du formulaire.', details: error.flatten() });
    return;
  }
  if (error instanceof HttpError) {
    // Trust restrictions carry a structured statement of reasons (DSA art. 17) so the client can link to the appeal.
    const restriction = (error as HttpError & { restriction?: unknown }).restriction;
    res.status(error.status).json(restriction ? { error: error.message, restriction } : { error: error.message });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: 'Corps JSON invalide.' });
    return;
  }
  if (error instanceof Error && 'type' in error && error.type === 'entity.too.large') {
    res.status(413).json({ error: 'Le contenu envoye est trop volumineux.' });
    return;
  }
  if (process.env.NODE_ENV === 'production') log.error('http.unhandled_error', { error, method: _req.method, path: _req.path, request_id: res.getHeader('X-Request-Id') });
  else console.error(error);
  res.status(500).json({ error: 'Une erreur interne est survenue. Veuillez reessayer.' });
}
