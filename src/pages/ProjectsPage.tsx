import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowUpRight, Blocks, BookOpen, Bot, Building2, Check, Code2, ExternalLink, FlaskConical, FolderKanban, GitBranch, Globe2, HeartPulse, Leaf, LockKeyhole, Palette, Pencil, Plug, Plus, Rocket, Search, Sparkles } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, Modal, PageHeader, useApi } from '../components/ui';
import { api, date, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import FollowButton from '../components/FollowButton';
import BookmarkButton from '../components/BookmarkButton';

interface Project {
  id: string; owner_id: string; organization_id: string | null;
  title: string; summary: string; description: string; category: string;
  stage: string; visibility: 'public' | 'private'; repo_url: string; demo_url: string;
  tags: string[]; color: string; created_at: string; updated_at: string;
  campaign_count: number; open_campaign_count: number; integration_count: number; can_manage: boolean; can_collaborate: boolean;
  author: { id: string; name: string; title: string; avatar_color: string };
  organization: { id: string; name: string } | null;
}
interface Options {
  categories: { value: string; label: string }[];
  stages: { value: string; label: string }[];
  organizations: { id: string; name: string }[];
}
interface Collection {
  projects: Project[]; total: number; limit: number; offset: number;
  stats: { projects: number; open_campaigns: number; organizations: number };
}
const categoryLabels: Record<string, string> = {
  ai: 'Intelligence artificielle', saas: 'SaaS & productivité', 'developer-tools': 'Outils développeurs',
  design: 'Design & création', climate: 'Climat & impact', health: 'Santé & bien-être', education: 'Éducation', other: 'Autre',
};
const stageLabels: Record<string, string> = { idea: 'Idée', prototype: 'Prototype', beta: 'Bêta', launched: 'Lancé' };
const stageTones: Record<string, string> = { idea: 'neutral', prototype: 'purple', beta: 'orange', launched: 'green' };
const colors = ['#6658e8', '#2376d9', '#149784', '#dd8434', '#d85383', '#5a6c85'];

function ProjectIcon({ project }: { project: Pick<Project, 'category' | 'color'> }) {
  const icons = { ai: Bot, saas: Blocks, 'developer-tools': Code2, design: Palette, climate: Leaf, health: HeartPulse, education: BookOpen };
  const Icon = icons[project.category as keyof typeof icons] ?? Rocket;
  const color = /^#[0-9a-fA-F]{6}$/.test(project.color) ? project.color : '#6658e8';
  return <span className="project-icon" style={{ backgroundColor: `${color}18`, color }}><Icon size={28} aria-hidden="true" /></span>;
}

function safeExternalUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function ProjectCard({ project }: { project: Project }) {
  return <article className="card">
    <div className="card-body stack">
      <div className="row-between"><ProjectIcon project={project} /><div className="row gap-sm">
        {project.visibility === 'private' && <Badge><LockKeyhole size={12} /> Privé</Badge>}
        <Badge tone={stageTones[project.stage]}>{stageLabels[project.stage] ?? project.stage}</Badge>
      </div></div>
      <div><p className="eyebrow">{categoryLabels[project.category] ?? project.category}</p>
        <h2><Link to={`/projects/${project.id}`}>{project.title}</Link></h2>
        <p className="muted">{project.summary}</p></div>
      <div className="tag-list">{project.tags.slice(0, 4).map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>
      <div className="row gap-sm"><Avatar name={project.author.name} color={project.author.avatar_color} size="small" />
        <div><span className="small">{project.author.name}</span>
          {project.organization && <div className="small muted">{project.organization.name}</div>}</div>
      </div>
    </div>
    <div className="card-footer row-between"><span className="small muted"><FlaskConical size={14} aria-hidden="true" /> {project.open_campaign_count} campagne{project.open_campaign_count !== 1 ? 's' : ''} ouverte{project.open_campaign_count !== 1 ? 's' : ''}</span>
      <Link to={`/projects/${project.id}`} className="button button-ghost button-small" aria-label={`Découvrir ${project.title}`}>Découvrir <ArrowUpRight size={16} /></Link>
    </div>
  </article>;
}

function ProjectForm({ project, onSaved, onCancel }: { project?: Project; onSaved: (project: Project) => void; onCancel: () => void }) {
  const { user } = useAuth();
  const options = useApi<Options>(`/projects/options?viewer=${encodeURIComponent(user?.id ?? 'public')}`);
  const [values, setValues] = useState({
    title: project?.title ?? '', summary: project?.summary ?? '', description: project?.description ?? '',
    category: project?.category ?? 'saas', stage: project?.stage ?? 'prototype',
    visibility: project?.visibility ?? 'public', organization_id: project?.organization_id ?? '',
    repo_url: project?.repo_url ?? '', demo_url: project?.demo_url ?? '',
    tags: project?.tags.join(', ') ?? '', color: project?.color ?? colors[0],
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const set = (key: keyof typeof values, value: string) => setValues((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    const tags = values.tags.split(',').map((tag) => tag.trim()).filter(Boolean);
    if (tags.length > 12 || tags.some((tag) => tag.length > 30)) {
      setError('Ajoutez au maximum 12 tags de 30 caractères chacun.'); return;
    }
    setPending(true);
    try {
      const result = await api<{ project: Project }>(project ? `/projects/${project.id}` : '/projects', {
        method: project ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...values, tags, organization_id: values.organization_id || null }),
      });
      onSaved(result.project);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  if (options.loading) return <Loading />;
  if (options.error) return <div className="stack"><ErrorState message={options.error} /><button type="button" className="button button-secondary" onClick={options.reload}>Réessayer</button></div>;
  if (!options.data) return null;
  const existingOrganization = project?.organization && !options.data.organizations.some((organization) => organization.id === project.organization_id) ? project.organization : null;
  return <form className="form" onSubmit={submit}>
    <ErrorState message={error} />
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-grid">
        <label className="field full-width">Nom du projet<input required minLength={2} maxLength={100} value={values.title} onChange={(event) => set('title', event.target.value)} placeholder="La prochaine idée qui change tout" /></label>
        <label className="field full-width">En quelques mots<textarea required minLength={10} maxLength={240} rows={2} value={values.summary} onChange={(event) => set('summary', event.target.value)} placeholder="Quel problème résolvez-vous, et pour qui ?" /><span className="help-text">{values.summary.length}/240 caractères</span></label>
        <label className="field full-width">Présentation détaillée<textarea maxLength={12000} rows={6} value={values.description} onChange={(event) => set('description', event.target.value)} placeholder="Votre vision, ce qui existe déjà et les prochaines étapes…" /></label>
        <label className="field">Catégorie<select value={values.category} onChange={(event) => set('category', event.target.value)}>
          {!options.data.categories.some((category) => category.value === values.category) && <option value={values.category}>{values.category}</option>}
          {options.data.categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
        </select></label>
        <label className="field">Avancement<select value={values.stage} onChange={(event) => set('stage', event.target.value)}>{options.data.stages.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></label>
        <label className="field">Visibilité<select value={values.visibility} onChange={(event) => set('visibility', event.target.value)}><option value="public">Public — visible par tout le monde</option><option value="private">Privé — accès limité</option></select><span className="help-text">Les projets privés restent accessibles à leur propriétaire, aux membres de leur organisation et aux testeurs affectés.</span></label>
        <label className="field">Organisation<select value={values.organization_id} onChange={(event) => set('organization_id', event.target.value)}>
          <option value="">Projet personnel</option>
          {existingOrganization && <option value={existingOrganization.id}>{existingOrganization.name} (actuelle)</option>}
          {options.data.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
        </select><span className="help-text">Seules les organisations que vous dirigez ou administrez peuvent être associées. Seul le propriétaire du projet peut le rendre personnel.</span></label>
        <label className="field">Lien de démonstration<input type="url" maxLength={2000} value={values.demo_url} onChange={(event) => set('demo_url', event.target.value)} placeholder="https://mon-projet.fr" /></label>
        <label className="field">Dépôt de code<input type="url" maxLength={2000} value={values.repo_url} onChange={(event) => set('repo_url', event.target.value)} placeholder="https://github.com/…" /></label>
        <label className="field full-width">Tags<input maxLength={382} value={values.tags} onChange={(event) => set('tags', event.target.value)} placeholder="React, open source, collaboration" /><span className="help-text">Séparez les tags par des virgules : 12 maximum, 30 caractères par tag.</span></label>
        <label className="field">Couleur du projet<input type="color" value={values.color} onChange={(event) => set('color', event.target.value)} /></label>
      </div>
    </fieldset>
    <div className="row"><button type="submit" className="button button-primary" disabled={pending}><Check size={16} /> {pending ? 'Enregistrement…' : project ? 'Enregistrer les modifications' : 'Créer le projet'}</button>
      <button type="button" className="button button-secondary" onClick={onCancel} disabled={pending}>Annuler</button></div>
  </form>;
}

export default function ProjectsPage() {
  const { user, loading: authLoading, error: authError } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const activeSearch = params.get('q') ?? params.get('search') ?? '';
  const [search, setSearch] = useState(activeSearch);
  useEffect(() => { setSearch(activeSearch); }, [activeSearch]);
  const [creating, setCreating] = useState(false);
  const query = new URLSearchParams();
  for (const key of ['category', 'stage', 'offset']) if (params.get(key)) query.set(key, params.get(key)!);
  if (activeSearch) query.set('q', activeSearch);
  if (user && params.get('mine') === 'true') query.set('mine', 'true');
  query.set('viewer', user?.id ?? 'public');
  const collection = useApi<Collection>(authLoading ? null : `/projects?${query}`);
  const options = useApi<Options>(authLoading ? null : `/projects/options?viewer=${encodeURIComponent(user?.id ?? 'public')}`);
  function filter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (key === 'q') next.delete('search');
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'offset') next.delete('offset');
    setParams(next);
  }
  const mine = !!user && params.get('mine') === 'true';
  return <div className="stack">
    <PageHeader eyebrow="Le laboratoire du collectif" title="Des idées. Des projets. De l’impact."
      description="Découvrez ce qui se construit sur Alpha. Testez, échangez et donnez vie à votre prochaine idée."
      action={user ? <button type="button" className="button button-primary" onClick={() => setCreating(true)}><Plus size={18} /> Créer un projet</button> : <Link className="button button-primary" to="/login"><Plus size={18} /> Créer un projet</Link>} />
    <ErrorState message={authError} />
    {collection.data && <div className="stat-grid">
      <div className="stat-card"><FolderKanban size={20} /><span className="stat-label">Projets à explorer</span><strong className="stat-value">{collection.data.stats.projects}</strong><span className="stat-note">Selon vos filtres et vos accès</span></div>
      <div className="stat-card"><FlaskConical size={20} /><span className="stat-label">Campagnes ouvertes</span><strong className="stat-value">{collection.data.stats.open_campaigns}</strong><span className="stat-note">Pour faire avancer ces projets</span></div>
      <div className="stat-card"><Building2 size={20} /><span className="stat-label">Organisations</span><strong className="stat-value">{collection.data.stats.organizations}</strong><span className="stat-note">Derrière les projets sélectionnés</span></div>
    </div>}
    <div className="row-between"><div className="tabs" aria-label="Sélection de projets">
      <button type="button" className={`tab${!mine ? ' active' : ''}`} onClick={() => filter('mine', '')}>Explorer les projets</button>
      {user && <button type="button" className={`tab${mine ? ' active' : ''}`} onClick={() => filter('mine', 'true')}>Mes projets</button>}
    </div><span className="small muted"><Sparkles size={14} aria-hidden="true" /> Construire, ensemble.</span></div>
    <form className="filters" onSubmit={(event) => { event.preventDefault(); filter('q', search); }}>
      <label className="field">Rechercher un projet<input className="search-input" type="search" maxLength={120} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nom, idée ou technologie…" /></label>
      <label className="field">Catégorie<select value={params.get('category') ?? ''} disabled={options.loading || !!options.error} onChange={(event) => filter('category', event.target.value)}><option value="">Toutes les catégories</option>{options.data?.categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}</select></label>
      <label className="field">Avancement<select value={params.get('stage') ?? ''} disabled={options.loading || !!options.error} onChange={(event) => filter('stage', event.target.value)}><option value="">Tous les stades</option>{options.data?.stages.map((stage) => <option key={stage.value} value={stage.value}>{stage.label}</option>)}</select></label>
      <button className="button button-secondary" type="submit"><Search size={16} /> Rechercher</button>
    </form>
    {options.error && <div className="stack"><ErrorState message={options.error} /><button type="button" className="button button-secondary" onClick={options.reload}>Recharger les filtres</button></div>}
    {authLoading || collection.loading ? <Loading /> : collection.error ? <div className="stack"><ErrorState message={collection.error} /><button type="button" className="button button-secondary" onClick={collection.reload}>Réessayer</button></div> : collection.data && <>
      <div className="row-between"><p className="muted small">{collection.data.total} projet{collection.data.total !== 1 ? 's' : ''} trouvé{collection.data.total !== 1 ? 's' : ''}{user && ' · Vos projets privés sont visibles uniquement aux personnes autorisées.'}</p></div>
      {collection.data.projects.length ? <div className="card-grid">{collection.data.projects.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
        : <EmptyState title={mine ? 'Votre prochain projet commence ici' : 'Aucun projet pour ces filtres'} description={mine ? 'Partagez votre idée, son avancement et les technologies qui la rendent possible.' : 'Essayez un autre mot-clé ou explorez toutes les catégories.'}
          action={<button type="button" className="button button-secondary" onClick={() => { setParams(mine ? { mine: 'true' } : {}); setSearch(''); if (mine && user) setCreating(true); }}>{mine ? 'Créer mon premier projet' : 'Réinitialiser les filtres'}</button>} />}
      {(collection.data.total > collection.data.limit || collection.data.offset > 0) && <nav className="row-between" aria-label="Pagination des projets">
        <button type="button" className="button button-secondary" disabled={!collection.data.offset} onClick={() => filter('offset', String(Math.max(0, collection.data!.offset - collection.data!.limit)))}><ArrowLeft size={16} /> Précédent</button>
        <span className="small muted">Page {Math.floor(collection.data.offset / collection.data.limit) + 1}</span>
        <button type="button" className="button button-secondary" disabled={collection.data.offset + collection.data.limit >= collection.data.total} onClick={() => filter('offset', String(collection.data!.offset + collection.data!.limit))}>Suivant <ArrowRight size={16} /></button>
      </nav>}
    </>}
    {creating && user && <Modal title="Un nouveau projet, de nouvelles possibilités" onClose={() => setCreating(false)}><ProjectForm onCancel={() => setCreating(false)} onSaved={(project) => { setCreating(false); navigate(`/projects/${project.id}`); }} /></Modal>}
  </div>;
}

export function ProjectDetailPage() {
  const { id } = useParams();
  const { user, loading: authLoading, error: authError } = useAuth();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const result = useApi<{ project: Project }>(authLoading || !id ? null : `/projects/${encodeURIComponent(id)}?viewer=${encodeURIComponent(user?.id ?? 'public')}`);
  if (authLoading || result.loading) return <Loading />;
  if (result.error || !result.data) return <div className="stack"><Link className="button button-ghost" to="/projects"><ArrowLeft size={16} /> Tous les projets</Link><ErrorState message={result.error || 'Projet introuvable.'} /><button type="button" className="button button-secondary" onClick={result.reload}>Réessayer</button></div>;
  const project = result.data.project;
  const demo = safeExternalUrl(project.demo_url);
  const repository = safeExternalUrl(project.repo_url);
  return <div className="stack">
    <Link className="button button-ghost" to="/projects"><ArrowLeft size={16} /> Explorer les projets</Link>
    <ErrorState message={authError} />
    {saved && <div className="alert alert-success" role="status">Les modifications de votre projet ont été enregistrées.</div>}
    <div className="row gap-sm"><ProjectIcon project={project} /><Badge tone={stageTones[project.stage]}>{stageLabels[project.stage] ?? project.stage}</Badge><Badge>{categoryLabels[project.category] ?? project.category}</Badge>{project.visibility === 'private' ? <Badge><LockKeyhole size={13} /> Privé</Badge> : <Badge tone="green"><Globe2 size={13} /> Public</Badge>}</div>
    <PageHeader title={project.title} description={project.summary}
      action={project.can_manage && user && <button type="button" className="button button-secondary" onClick={() => { setSaved(false); setEditing(true); }}><Pencil size={16} /> Modifier le projet</button>} />
    {project.visibility === 'public' && <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}><FollowButton targetType="project" targetId={project.id} /><BookmarkButton targetType="project" targetId={project.id} /><Link className="button button-ghost" to={`/community?project=${encodeURIComponent(project.id)}`}>Actualités du projet <ArrowUpRight size={16} /></Link></div>}
    <div className="detail-layout">
      <div className="detail-main stack">
        {project.can_collaborate && <section className="card card-body stack"><div className="row gap-sm"><FolderKanban size={24} /><h2>L’atelier de l’équipe</h2></div><p className="muted">Répartissez les tâches, suivez leur avancement et construisez ensemble. Ce tableau reste privé à l’équipe, même pour un projet public.</p><Link className="button button-primary" to={`/workspace?project=${encodeURIComponent(project.id)}`}>Ouvrir le tableau de tâches <ArrowUpRight size={16} /></Link></section>}
        <section className="card card-body"><h2>À propos du projet</h2>{project.description ? <div className="prose pre-wrap" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{project.description}</div> : <p className="muted">L’équipe n’a pas encore ajouté de présentation détaillée.</p>}
          {project.tags.length > 0 && <div className="tag-list">{project.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}</div>}
        </section>
        <section className="card card-body stack"><div className="row gap-sm"><FlaskConical size={24} /><h2>Construire avec des retours concrets</h2></div>
          <p className="muted">{project.open_campaign_count > 0 ? `${project.open_campaign_count} campagne${project.open_campaign_count > 1 ? 's sont ouvertes' : ' est ouverte'} pour tester ce projet et partager vos observations.` : 'Aucune campagne ouverte pour le moment. Retrouvez les campagnes de ce projet et suivez sa progression.'}</p>
          <div className="row"><Badge tone="purple">{project.campaign_count} campagne{project.campaign_count !== 1 ? 's' : ''} au total</Badge><Badge tone="green">{project.open_campaign_count} ouverte{project.open_campaign_count !== 1 ? 's' : ''}</Badge></div>
          <Link className="button button-primary" to={`/missions?project=${encodeURIComponent(project.id)}`}>Voir les campagnes <ArrowUpRight size={16} /></Link>
        </section>
        <section className="card card-body stack"><div className="row gap-sm"><Plug size={23} /><h2>Les outils du projet</h2></div>
          <p className="muted">{project.integration_count} intégration{project.integration_count !== 1 ? 's' : ''} liée{project.integration_count !== 1 ? 's' : ''} au projet. L’espace intégrations est réservé aux responsables du projet.</p>
          {project.can_manage && user && <Link className="button button-secondary" to={`/integrations?project=${encodeURIComponent(project.id)}`}>Gérer les intégrations <ArrowUpRight size={16} /></Link>}
        </section>
      </div>
      <aside className="detail-aside stack">
        <section className="card card-body stack"><h2>Porté par</h2><div className="row gap-sm"><Avatar name={project.author.name} color={project.author.avatar_color} /><div><Link to={`/people/${project.author.id}`}><strong>{project.author.name}</strong></Link>{project.author.title && <p className="small muted">{project.author.title}</p>}{project.owner_id === user?.id && <Badge tone="purple">Votre projet</Badge>}</div></div>
          {project.organization && <div className="row gap-sm"><Building2 size={18} /><span>{project.organization.name}</span></div>}
          <div className="divider" /><div className="small muted">Créé le {date(project.created_at)}<br />Mis à jour le {date(project.updated_at)}</div>
        </section>
        <section className="card card-body stack"><h2>Explorer le produit</h2>
          {demo && <a className="button button-primary" href={demo} target="_blank" rel="noreferrer"><ExternalLink size={16} /> Voir la démonstration</a>}
          {repository && <a className="button button-secondary" href={repository} target="_blank" rel="noreferrer"><GitBranch size={16} /> Explorer le code</a>}
          {!demo && !repository && <p className="muted small">Aucun lien de démonstration ou de code n’a encore été ajouté.</p>}
        </section>
        {project.visibility === 'private' && <div className="card card-body"><div className="row gap-sm"><LockKeyhole size={18} /><strong>Un espace privé</strong></div><p className="small muted">Ce projet est réservé à son propriétaire, à son organisation et aux testeurs affectés.</p></div>}
      </aside>
    </div>
    {editing && user && project.can_manage && <Modal title="Modifier le projet" onClose={() => setEditing(false)}><ProjectForm key={project.id} project={project} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); setSaved(true); result.reload(); }} /></Modal>}
  </div>;
}
