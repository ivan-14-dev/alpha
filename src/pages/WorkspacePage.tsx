import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, ApiError, date, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

type Status = 'todo' | 'in_progress' | 'done';
type Priority = 'low' | 'normal' | 'high';
interface Project { id: string; title: string; summary: string; visibility: 'public' | 'private' }
interface Assignee { id: string; name: string; avatar_color: string }
interface Task {
  id: string; project_id: string; title: string; description: string;
  status: Status; priority: Priority; due_at: string | null; version: number;
  assignee_id: string | null; assignee: (Assignee & { is_former_member: boolean }) | null;
}
interface Board {
  project: Project; tasks: Task[]; eligible_assignees: Assignee[]; can_manage: boolean;
  total: number; limit: number; offset: number;
  stats: { total: number; todo: number; in_progress: number; done: number };
}
interface Projects { projects: Project[]; total: number; limit: number; offset: number }
const statuses: Record<Status, string> = { todo: 'À faire', in_progress: 'En cours', done: 'Terminées' };
const priorities: Record<Priority, string> = { low: 'Basse', normal: 'Normale', high: 'Haute' };

function localDateTime(value: string | null) {
  if (!value) return '';
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function dateBoundary(value: string, end = false) {
  const time = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isFinite(time.getTime()) ? time.toISOString() : value;
}

function draftFor(task?: Task) {
  return {
    title: task?.title ?? '', description: task?.description ?? '',
    assignee_id: task?.assignee_id ?? '', priority: task?.priority ?? 'normal',
    due_at: localDateTime(task?.due_at ?? null), status: task?.status ?? 'todo',
  };
}

function TaskForm({ projectId, task, assignees, onSaved, onClose }: {
  projectId: string; task?: Task; assignees: Assignee[]; onSaved: () => void; onClose: () => void;
}) {
  const [original, setOriginal] = useState(task);
  const [draft, setDraft] = useState(() => draftFor(task));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setDraft((current) => ({ ...current, [key]: value })); setConfirmDelete(false);
  };
  function failed(error: unknown) {
    setError(errorMessage(error));
    setStale(error instanceof ApiError && error.status === 409);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || stale) return;
    setPending(true); setError('');
    try {
      const input: Record<string, unknown> = {};
      if (original) {
        input.version = original.version;
        const previous = draftFor(original);
        for (const key of Object.keys(draft) as (keyof typeof draft)[]) {
          if (draft[key] !== previous[key]) input[key] = draft[key];
        }
        if (Object.keys(input).length === 1) { onClose(); return; }
      } else {
        Object.assign(input, draft);
        delete input.status;
      }
      if ('due_at' in input) input.due_at = draft.due_at ? new Date(draft.due_at).toISOString() : null;
      if ('assignee_id' in input) input.assignee_id = draft.assignee_id || null;
      await api(original ? `/workspace/tasks/${original.id}` : `/workspace/projects/${projectId}/tasks`, {
        method: original ? 'PATCH' : 'POST', body: JSON.stringify(input),
      });
      onSaved();
    } catch (error) { failed(error); }
    finally { setPending(false); }
  }
  async function reloadCurrent() {
    if (!original || pending) return;
    setPending(true); setError('');
    try {
      const { task } = await api<{ task: Task }>(`/workspace/tasks/${original.id}`);
      setOriginal(task); setDraft(draftFor(task)); setStale(false); setConfirmDelete(false);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!original || pending || stale) return;
    setPending(true); setError('');
    try {
      await api(`/workspace/tasks/${original.id}?version=${original.version}`, { method: 'DELETE' });
      onSaved();
    } catch (error) { failed(error); }
    finally { setPending(false); }
  }
  return <form className="form" onSubmit={submit}>
    <ErrorState message={error} />
    {stale && <div className="stack">
      <p className="small">Votre brouillon est conservé ci-dessous. Le rechargement le remplacera par la version actuelle : copiez vos saisies si vous souhaitez les garder.</p>
      <button className="button button-secondary" type="button" disabled={pending} onClick={() => void reloadCurrent()}>Recharger et remplacer mon brouillon</button>
    </div>}
    <fieldset disabled={pending} className="form-grid" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label className="field full-width">Titre<input required maxLength={160} value={draft.title} onChange={(event) => set('title', event.target.value)} /></label>
      <label className="field full-width">Description<textarea rows={5} maxLength={12000} value={draft.description} onChange={(event) => set('description', event.target.value)} /></label>
      <label className="field">Personne affectée<select value={draft.assignee_id} onChange={(event) => set('assignee_id', event.target.value)}>
        <option value="">Non affectée</option>
        {original?.assignee && !assignees.some((person) => person.id === original.assignee_id) &&
          <option value={original.assignee.id} disabled>{original.assignee.name} — ancien membre</option>}
        {assignees.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select></label>
      <label className="field">Priorité<select value={draft.priority} onChange={(event) => set('priority', event.target.value as Priority)}>
        {Object.entries(priorities).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <label className="field">Échéance (heure locale)<input type="datetime-local" max="9999-12-31T23:59" value={draft.due_at} onChange={(event) => set('due_at', event.target.value)} /></label>
      {original && <label className="field">Statut<select value={draft.status} onChange={(event) => set('status', event.target.value as Status)}>
        {Object.entries(statuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>}
    </fieldset>
    <div className="row" style={{ flexWrap: 'wrap' }}>
      <button type="submit" className="button button-primary" disabled={pending || stale}>{pending ? 'Enregistrement…' : original ? 'Enregistrer' : 'Créer la tâche'}</button>
      <button type="button" className="button button-secondary" disabled={pending} onClick={onClose}>Annuler</button>
      {original && <button type="button" className="button button-ghost" disabled={pending || stale} onClick={() => setConfirmDelete(true)}>Supprimer…</button>}
    </div>
    {confirmDelete && <div className="stack"><p>Supprimer définitivement cette tâche ?</p>
      <button type="button" className="button button-secondary" disabled={pending || stale} onClick={() => void remove()}>Confirmer la suppression</button>
    </div>}
  </form>;
}

function TaskBoard({ projectId, userId }: { projectId: string; userId: string }) {
  const [filters, setFilters] = useState({ assigned: false, priority: '', overdue: false, from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const [mutationError, setMutationError] = useState('');
  const [pendingTask, setPendingTask] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const query = new URLSearchParams({ limit: '100', offset: String(offset) });
  if (filters.assigned) query.set('assigned_to_me', 'true');
  if (filters.priority) query.set('priority', filters.priority);
  if (filters.overdue) query.set('overdue', 'true');
  if (filters.from) query.set('due_from', dateBoundary(filters.from));
  if (filters.to) query.set('due_to', dateBoundary(filters.to, true));
  const board = useApi<Board>(`/workspace/projects/${encodeURIComponent(projectId)}?${query}`);
  const data = board.data;
  const filter = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => {
    setFilters((current) => ({ ...current, [key]: value })); setOffset(0); setSaved(false);
  };
  async function changeStatus(task: Task, status: Status) {
    if (pendingTask) return;
    setPendingTask(task.id); setMutationError(''); setSaved(false);
    try {
      await api(`/workspace/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status, version: task.version }) });
      setSaved(true); board.reload();
    } catch (error) { setMutationError(errorMessage(error)); }
    finally { setPendingTask(null); }
  }
  return <section className="stack" aria-label="Tableau des tâches">
    <div className="form-grid">
      <label className="row small"><input type="checkbox" checked={filters.assigned} onChange={(event) => filter('assigned', event.target.checked)} /> Affectées à moi</label>
      <label className="row small"><input type="checkbox" checked={filters.overdue} onChange={(event) => filter('overdue', event.target.checked)} /> En retard (hors terminées)</label>
      <label className="field">Priorité<select value={filters.priority} onChange={(event) => filter('priority', event.target.value)}>
        <option value="">Toutes</option>{Object.entries(priorities).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="field">Échéance à partir du<input type="date" max="9999-12-31" value={filters.from} onChange={(event) => filter('from', event.target.value)} /></label>
      <label className="field">Échéance jusqu’au<input type="date" max="9999-12-31" value={filters.to} onChange={(event) => filter('to', event.target.value)} /></label>
    </div>
    {mutationError && <div className="stack"><ErrorState message={mutationError} />
      <button className="button button-secondary" type="button" onClick={() => { board.reload(); setMutationError(''); }}>Recharger le tableau</button>
    </div>}
    {saved && <p role="status" className="alert alert-success">Modification enregistrée.</p>}
    {board.loading ? <Loading /> : board.error ? <div className="stack"><ErrorState message={board.error} />
      <button className="button button-secondary" type="button" onClick={board.reload}>Réessayer</button></div> : data && <>
      <div className="row-between"><div><h2 style={{ overflowWrap: 'anywhere' }}>{data.project.title}</h2>
        <Link className="small" to={`/projects/${data.project.id}`}>Voir le projet</Link>
      </div>{data.can_manage && <button className="button button-primary" type="button" onClick={() => { setEditing('new'); setSaved(false); }}>Créer une tâche</button>}</div>
      <p className="muted" role="status">{data.stats.done} / {data.stats.total} tâche{data.stats.total !== 1 ? 's' : ''} terminée{data.stats.total !== 1 ? 's' : ''} sur l’ensemble du projet.</p>
      <p className="small muted">{data.total} résultat{data.total !== 1 ? 's' : ''} selon vos filtres. Les colonnes affichent uniquement cette page ({data.tasks.length} tâche{data.tasks.length !== 1 ? 's' : ''}).</p>
      {!data.tasks.length && <EmptyState title={data.stats.total ? 'Aucune tâche sur cette page avec ces filtres' : 'Votre tableau est prêt'}
        description={data.stats.total ? 'Ajustez les filtres ou revenez à la première page.' : data.can_manage ? 'Créez la première tâche de votre équipe.' : 'Un responsable peut créer et affecter les tâches.'} />}
      <div className="card-grid" style={{ alignItems: 'start' }}>
        {(Object.keys(statuses) as Status[]).map((status) => <section key={status} className="card card-body stack" aria-label={statuses[status]} style={{ minWidth: 0 }}>
          <h3>{statuses[status]} <span className="muted">({data.tasks.filter((task) => task.status === status).length})</span></h3>
          {data.tasks.filter((task) => task.status === status).map((task) => {
            const overdue = task.due_at && task.status !== 'done' && new Date(task.due_at).getTime() < Date.now();
            return <article key={task.id} className="card card-body stack" style={{ padding: 14, minWidth: 0, overflowWrap: 'anywhere' }}>
              <h4>{task.title}</h4>
              {task.description && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{task.description}</p>}
              <div><Badge tone={task.priority === 'high' ? 'orange' : 'neutral'}>Priorité {priorities[task.priority].toLowerCase()}</Badge></div>
              <p className="small">{task.assignee ? `${task.assignee.name}${task.assignee.is_former_member ? ' — ancien membre' : ''}` : 'Non affectée'}</p>
              {task.due_at && <p className="small">{overdue ? 'En retard · ' : 'Échéance · '}<time dateTime={task.due_at}>{date(task.due_at)}</time></p>}
              {(data.can_manage || (task.assignee_id === userId && !task.assignee?.is_former_member)) && <label className="field">Statut de « {task.title} »
                <select value={task.status} disabled={pendingTask !== null} onChange={(event) => void changeStatus(task, event.target.value as Status)}>
                  {Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>}
              {data.can_manage && <button type="button" className="button button-secondary button-small" disabled={pendingTask !== null} onClick={() => { setEditing(task); setSaved(false); }}>Modifier « {task.title} »</button>}
            </article>;
          })}
          {!data.tasks.some((task) => task.status === status) && <p className="small muted">Aucune tâche affichée.</p>}
        </section>)}
      </div>
      {(data.total > data.limit || offset > 0) && <nav className="row-between" aria-label="Pagination des tâches">
        <button className="button button-secondary" type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - data.limit))}>Tâches précédentes</button>
        <span className="small">Page {Math.floor(offset / data.limit) + 1}</span>
        <button className="button button-secondary" type="button" disabled={offset + data.limit >= data.total} onClick={() => setOffset(offset + data.limit)}>Tâches suivantes</button>
      </nav>}
    </>}
    {editing && data?.can_manage && <Modal title={editing === 'new' ? 'Créer une tâche privée' : 'Modifier la tâche'} onClose={() => setEditing(null)}>
      <TaskForm projectId={projectId} task={editing === 'new' ? undefined : editing} assignees={data.eligible_assignees}
        onClose={() => setEditing(null)} onSaved={() => { if (editing === 'new') setOffset(0); setEditing(null); setSaved(true); setMutationError(''); board.reload(); }} />
    </Modal>}
  </section>;
}

function Workspace({ userId }: { userId: string }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('project') ?? '';
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ q: activeSearch, limit: '25', offset: String(offset) });
  const projects = useApi<Projects>(`/workspace/projects?${query}`);
  return <div className="stack">
    <PageHeader eyebrow="Construire ensemble" title="Espace de travail" description="Les tâches de vos projets, réservées à votre équipe." />
    <div className="alert" role="note"><strong>Tableau privé, même pour un projet public.</strong> Seuls le propriétaire du projet et les membres actuels de son organisation ont accès aux tâches. Les testeurs externes et le public n’y ont pas accès.</div>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); setActiveSearch(search); setOffset(0); }}>
      <label className="field">Rechercher parmi mes projets<input type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <div><button className="button button-secondary" type="submit">Rechercher</button></div>
    </form>
    {projects.loading ? <Loading /> : projects.error ? <div className="stack"><ErrorState message={projects.error} />
      <button className="button button-secondary" type="button" onClick={projects.reload}>Recharger les projets</button></div> : projects.data && <>
      <label className="field">Projet de l’équipe<select value={selected} onChange={(event) => {
        const next = new URLSearchParams(params);
        if (event.target.value) next.set('project', event.target.value); else next.delete('project');
        setParams(next);
      }}>
        <option value="">Choisir un projet</option>
        {selected && !projects.data.projects.some((project) => project.id === selected) && <option value={selected}>Projet sélectionné par lien direct ou sur une autre page</option>}
        {projects.data.projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}
      </select></label>
      {!projects.data.projects.length && <EmptyState title="Aucun projet d’équipe trouvé" description={activeSearch ? 'Essayez un autre mot-clé.' : 'Créez un projet ou acceptez une invitation dans une organisation pour collaborer.'} />}
      {(projects.data.total > projects.data.limit || offset > 0) && <nav className="row-between" aria-label="Pagination des projets">
        <button className="button button-secondary" type="button" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - projects.data!.limit))}>Projets précédents</button>
        <span className="small">Page {Math.floor(offset / projects.data.limit) + 1} · {projects.data.total} projets</span>
        <button className="button button-secondary" type="button" disabled={offset + projects.data.limit >= projects.data.total} onClick={() => setOffset(offset + projects.data!.limit)}>Projets suivants</button>
      </nav>}
    </>}
    {selected ? <TaskBoard key={selected} projectId={selected} userId={userId} /> : <EmptyState title="Choisissez un projet" description="Son tableau de tâches privé apparaîtra ici." />}
  </div>;
}

export default function WorkspacePage() {
  const { user, loading, error } = useAuth();
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!user) return <LoginNotice />;
  return <Workspace key={user.id} userId={user.id} />;
}
