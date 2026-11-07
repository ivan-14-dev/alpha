import { Router } from 'express';
import { z } from 'zod';
import { all, one, run, transaction } from '../db.js';
import { audit, canCollaborateProject, canManageProject, HttpError, id, now, notify, param, requireUser } from '../core.js';

const router = Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const timestamp = z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value)))
  .transform((value) => new Date(value).toISOString());
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1);
const queryInteger = (minimum: number, maximum: number, fallback: string) => z.string().regex(/^\d+$/)
  .default(fallback).transform(Number).pipe(z.number().int().min(minimum).max(maximum));
const pagination = {
  limit: queryInteger(1, 100, '100'),
  offset: queryInteger(0, 1000000, '0'),
};
const listQuery = z.object({ ...pagination, q: z.string().trim().max(120).default('') }).strict();
const boardQuery = z.object({
  ...pagination,
  assigned_to_me: z.enum(['true', 'false']).default('false'),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  overdue: z.enum(['true', 'false']).default('false'),
  due_from: timestamp.optional(),
  due_to: timestamp.optional(),
}).strict().refine((value) => !value.due_from || !value.due_to || value.due_from <= value.due_to,
  'La date de début doit précéder la date de fin.');
const fields = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(12000),
  assignee_id: identifier.nullable(),
  priority: z.enum(['low', 'normal', 'high']),
  due_at: timestamp.nullable(),
  status: z.enum(['todo', 'in_progress', 'done']),
}).strict();
const createTask = fields.omit({ status: true }).extend({
  description: fields.shape.description.default(''),
  assignee_id: fields.shape.assignee_id.default(null),
  priority: fields.shape.priority.default('normal'),
  due_at: fields.shape.due_at.default(null),
});
const updateTask = fields.partial().extend({ version }).refine((input) => Object.keys(input).length > 1,
  'Indiquez au moins un champ à modifier.');
const updateStatus = z.object({ version, status: fields.shape.status }).strict();

interface Project {
  id: string; owner_id: string; organization_id: string | null;
  title: string; summary: string; visibility: 'public' | 'private';
}
interface Task {
  id: string; project_id: string; creator_id: string; assignee_id: string | null;
  title: string; description: string; status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high'; due_at: string | null; version: number;
  created_at: string; updated_at: string;
}
interface Assignee { id: string; name: string; avatar_color: string }
type TaskResult = Task & { assignee_name: string | null; assignee_color: string | null; assignee_current: number };
const projectProjection = 'SELECT p.id,p.owner_id,p.organization_id,p.title,p.summary,p.visibility FROM projects p';
const collaboration = `(p.owner_id=? OR EXISTS (SELECT 1 FROM organization_members om
  WHERE om.organization_id=p.organization_id AND om.user_id=?))`;
const taskProjection = `SELECT t.*,u.name AS assignee_name,u.avatar_color AS assignee_color,
  CASE WHEN t.assignee_id=p.owner_id OR EXISTS (SELECT 1 FROM organization_members om
    WHERE om.organization_id=p.organization_id AND om.user_id=t.assignee_id) THEN 1 ELSE 0 END AS assignee_current
  FROM project_tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assignee_id`;

function presentTask(row: TaskResult) {
  const { assignee_name, assignee_color, assignee_current, ...task } = row;
  return {
    ...task,
    assignee: task.assignee_id ? {
      id: task.assignee_id, name: assignee_name, avatar_color: assignee_color,
      is_former_member: !assignee_current,
    } : null,
  };
}

function projectFor(userId: string, projectId: string) {
  if (!canCollaborateProject(userId, projectId)) throw new HttpError(404, 'Espace de travail introuvable ou accès retiré.');
  return one<Project>(`${projectProjection} WHERE p.id=?`, projectId)!;
}

function managerFor(userId: string, projectId: string) {
  projectFor(userId, projectId);
  if (!canManageProject(userId, projectId)) throw new HttpError(403, 'Seuls les responsables du projet peuvent effectuer cette action.');
}

function taskFor(userId: string, taskId: string) {
  const task = one<Task>('SELECT * FROM project_tasks WHERE id=?', taskId);
  if (!task || !canCollaborateProject(userId, task.project_id)) throw new HttpError(404, 'Tâche introuvable ou accès retiré.');
  return task;
}

function validateAssignee(projectId: string, assigneeId: string | null) {
  if (assigneeId && !canCollaborateProject(assigneeId, projectId)) {
    throw new HttpError(400, 'La personne affectée doit être propriétaire du projet ou membre actuel de son organisation.');
  }
}

function assignmentNotification(assigneeId: string, projectId: string) {
  notify(assigneeId, 'task_assignment', 'Une tâche vous a été attribuée.',
    'Consultez votre espace de travail pour en savoir plus.', `/workspace?project=${encodeURIComponent(projectId)}`);
}

function conflict(): never {
  throw new HttpError(409, 'Cette tâche a été modifiée ou supprimée. Rechargez sa dernière version avant de réessayer ; vos modifications ne sont pas enregistrées.');
}

function readTask(taskId: string) {
  return presentTask(one<TaskResult>(`${taskProjection} WHERE t.id=?`, taskId)!);
}

router.get('/projects', (req, res) => {
  const user = requireUser(req);
  const query = listQuery.parse(req.query);
  const search = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = `${collaboration} AND (p.title LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\')`;
  const values = [user.id, user.id, search, search];
  const total = one<{ count: number }>(`SELECT COUNT(*) AS count FROM projects p WHERE ${where}`, ...values)!.count;
  const projects = all<Project>(`${projectProjection} WHERE ${where}
    ORDER BY p.updated_at DESC,p.id ASC LIMIT ? OFFSET ?`, ...values, query.limit, query.offset);
  res.json({ projects, total, limit: query.limit, offset: query.offset });
});

router.get('/projects/:id', (req, res) => {
  const user = requireUser(req);
  const projectId = identifier.parse(param(req));
  const project = projectFor(user.id, projectId);
  const query = boardQuery.parse(req.query);
  const conditions = ['t.project_id=?'];
  const values: (string | number)[] = [projectId];
  if (query.assigned_to_me === 'true') { conditions.push('t.assignee_id=?'); values.push(user.id); }
  if (query.priority) { conditions.push('t.priority=?'); values.push(query.priority); }
  if (query.overdue === 'true') { conditions.push("t.status!='done' AND t.due_at<?"); values.push(now()); }
  if (query.due_from) { conditions.push('t.due_at>=?'); values.push(query.due_from); }
  if (query.due_to) { conditions.push('t.due_at<=?'); values.push(query.due_to); }
  const where = conditions.join(' AND ');
  const total = one<{ count: number }>(`SELECT COUNT(*) AS count FROM project_tasks t WHERE ${where}`, ...values)!.count;
  const tasks = all<TaskResult>(`${taskProjection} WHERE ${where}
    ORDER BY t.created_at DESC,t.id ASC LIMIT ? OFFSET ?`, ...values, query.limit, query.offset).map(presentTask);
  const eligibleAssignees = all<Assignee>(`SELECT u.id,u.name,u.avatar_color FROM users u WHERE u.id=? OR
    EXISTS (SELECT 1 FROM organization_members om WHERE om.organization_id=? AND om.user_id=u.id)
    ORDER BY u.name COLLATE NOCASE,u.id`, project.owner_id, project.organization_id);
  const stats = one<{ total: number; done: number; todo: number; in_progress: number }>(`SELECT COUNT(*) AS total,
    COALESCE(SUM(status='done'),0) AS done,COALESCE(SUM(status='todo'),0) AS todo,
    COALESCE(SUM(status='in_progress'),0) AS in_progress FROM project_tasks WHERE project_id=?`, projectId)!;
  res.json({
    project, tasks, eligible_assignees: eligibleAssignees, can_manage: canManageProject(user.id, projectId),
    total, stats, limit: query.limit, offset: query.offset,
  });
});

router.post('/projects/:id/tasks', (req, res) => {
  const user = requireUser(req);
  const projectId = identifier.parse(param(req));
  const task = transaction(() => {
    managerFor(user.id, projectId);
    const input = createTask.parse(req.body);
    validateAssignee(projectId, input.assignee_id);
    const taskId = id();
    const time = now();
    run(`INSERT INTO project_tasks
      (id,project_id,creator_id,assignee_id,title,description,priority,due_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
    taskId, projectId, user.id, input.assignee_id, input.title, input.description, input.priority, input.due_at, time, time);
    if (input.assignee_id) assignmentNotification(input.assignee_id, projectId);
    audit(user.id, 'task.created', 'project_task', taskId);
    return readTask(taskId);
  });
  res.status(201).json({ task });
});

router.get('/tasks/:id', (req, res) => {
  const user = requireUser(req);
  const taskId = identifier.parse(param(req));
  taskFor(user.id, taskId);
  res.json({ task: readTask(taskId) });
});

router.patch('/tasks/:id', (req, res) => {
  const user = requireUser(req);
  const taskId = identifier.parse(param(req));
  const result = transaction(() => {
    const task = taskFor(user.id, taskId);
    const manager = canManageProject(user.id, task.project_id);
    if (!manager && task.assignee_id !== user.id) throw new HttpError(403, 'Seule la personne affectée peut changer le statut de cette tâche.');
    if (!manager && req.body && typeof req.body === 'object' &&
      Object.keys(req.body).some((key) => key !== 'status' && key !== 'version')) {
      throw new HttpError(403, 'Vous pouvez uniquement modifier le statut de votre tâche.');
    }
    const input = manager ? updateTask.parse(req.body) : updateStatus.parse(req.body);
    if (task.version !== input.version) conflict();
    if ('assignee_id' in input && input.assignee_id !== undefined) validateAssignee(task.project_id, input.assignee_id);
    const changes = Object.entries(input).filter(([key, value]) => key !== 'version' && value !== task[key as keyof Task]);
    if (!changes.length) return readTask(taskId);
    // Field names come only from the strict schemas; compare-and-swap also guards the write itself.
    const updated = run(`UPDATE project_tasks SET ${changes.map(([key]) => `${key}=?`).join(',')},
      version=version+1,updated_at=? WHERE id=? AND version=?`,
    ...changes.map(([, value]) => value!), now(), taskId, input.version);
    if (!updated.changes) conflict();
    if ('assignee_id' in input && input.assignee_id && input.assignee_id !== task.assignee_id) {
      assignmentNotification(input.assignee_id, task.project_id);
    }
    audit(user.id, 'task.updated', 'project_task', taskId, changes.map(([key]) => key).join(','));
    return readTask(taskId);
  });
  res.json({ task: result });
});

// DELETE /tasks/:id?version=3 requires the last version returned by the board.
router.delete('/tasks/:id', (req, res) => {
  const user = requireUser(req);
  const taskId = identifier.parse(param(req));
  transaction(() => {
    const task = taskFor(user.id, taskId);
    managerFor(user.id, task.project_id);
    const input = z.object({
      version: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(version),
    }).strict().parse(req.query);
    if (!run('DELETE FROM project_tasks WHERE id=? AND version=?', taskId, input.version).changes) conflict();
    audit(user.id, 'task.deleted', 'project_task', taskId);
  });
  res.json({ deleted: true });
});

export default router;
