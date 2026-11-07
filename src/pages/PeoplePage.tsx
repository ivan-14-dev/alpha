import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Building2, CheckCircle2, Search, Settings, Star, Trash2, Users } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, LoginNotice, PageHeader, useApi } from '../components/ui';
import FollowButton from '../components/FollowButton';
import ReputationHighlights from '../components/ReputationHighlights';
import AccountSecurity from '../components/AccountSecurity';
import { api, date, errorMessage } from '../lib/api';
import { useAuth, type User } from '../lib/auth';

interface Person {
  id: string;
  name: string;
  title: string;
  bio: string;
  skills: string;
  avatar_color: string;
  created_at: string;
}

interface DirectoryPerson extends Person {
  public_project_count: number;
  completed_mission_count: number;
  review_count: number;
  average_rating: number | null;
}

interface Collection {
  total: number;
  limit: number;
  offset: number;
}

interface Directory extends Collection { people: DirectoryPerson[] }
interface PublicProject {
  id: string;
  title: string;
  summary: string;
  category: string;
  stage: string;
  tags: string;
  color: string;
  created_at: string;
}
interface Profile extends Person {
  projects: PublicProject[];
  public_project_count: number;
  completed_mission_count: number;
  reputation: { review_count: number; average_rating: number | null };
}
interface Organization {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  created_at: string;
  my_role: 'owner' | 'admin' | 'member';
  member_count: number;
}
interface Member extends Person { role: 'owner' | 'admin' | 'member' }
interface Invitation {
  id: string;
  role: 'member' | 'admin';
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
  created_at: string;
  expires_at: string;
  organization: { id: string; name: string; description: string };
  inviter: Pick<Person, 'id' | 'name' | 'title' | 'avatar_color'>;
  invitee: Pick<Person, 'id' | 'name' | 'title' | 'avatar_color'>;
}
const roles = { owner: 'Propriétaire', admin: 'Administrateur', member: 'Membre' };
const invitationStatuses = { pending: 'En attente', accepted: 'Acceptée', declined: 'Refusée', revoked: 'Révoquée', expired: 'Expirée' };
const teamAccess = 'Un membre accède aux projets privés et aux tâches de l’organisation. Un administrateur peut aussi gérer ses projets. Seul le propriétaire gère les invitations et les membres.';

function stringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch { return []; }
}

function Skills({ value }: { value: string }) {
  const skills = stringList(value);
  return skills.length ? <div className="tag-list">{skills.map((skill, index) => <Badge key={`${skill}-${index}`} tone="purple">{skill}</Badge>)}</div> : <p className="muted small">Aucune compétence renseignée.</p>;
}

function Pagination({ total, limit, offset, onChange }: Collection & { onChange: (offset: number) => void }) {
  if (total <= limit) return null;
  return <nav className="row row-between" aria-label="Pagination">
    <button type="button" className="button button-secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Précédent</button>
    <span className="muted small">{Math.min(offset + 1, total)}–{Math.min(offset + limit, total)} sur {total}</span>
    <button type="button" className="button button-secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Suivant</button>
  </nav>;
}

export default function PeoplePage() {
  const { id } = useParams();
  const { user, loading, error } = useAuth();
  if (loading) return <Loading />;
  return <div className="stack">
    {error && <ErrorState message={error} />}
    {id ? <PersonProfile key={id} personId={id} ownProfile={user?.id === id} /> : <PeopleDirectory userId={user?.id} />}
  </div>;
}

function PeopleDirectory({ userId }: { userId?: string }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const { data, loading, error, reload } = useApi<Directory>(`/people?q=${encodeURIComponent(query)}&limit=24&offset=${offset}`);
  function searchPeople(event: FormEvent) {
    event.preventDefault();
    setOffset(0);
    setQuery(search.trim());
  }
  return <>
    <PageHeader eyebrow="Le collectif" title="Les personnes derrière les idées" description="Découvrez les talents, leurs compétences et leurs contributions vérifiées sur Alpha." action={userId ? <Link className="button button-secondary" to={`/people/${userId}`}>Mon profil <ArrowUpRight size={16} /></Link> : <Link className="button button-primary" to="/login">Rejoindre Alpha</Link>} />
    <form className="filters" onSubmit={searchPeople}>
      <label className="field full-width" htmlFor="people-search">Rechercher un talent
        <input id="people-search" className="search-input" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="Nom, identifiant public, titre ou compétence" type="search" />
      </label>
      <button className="button button-primary" type="submit"><Search size={16} /> Rechercher</button>
    </form>
    {loading ? <Loading /> : error ? <div className="stack"><ErrorState message={error} /><button type="button" className="button button-secondary" onClick={reload}>Réessayer</button></div> : data && <>
      <p className="muted small">{data.total} profil{data.total > 1 ? 's' : ''} public{data.total > 1 ? 's' : ''}</p>
      {data.people.length ? <div className="card-grid">{data.people.map((person) => <article className="card" key={person.id}>
        <div className="card-body stack">
          <div className="row gap-sm"><Avatar name={person.name} color={person.avatar_color} /><div><h2><Link to={`/people/${person.id}`}>{person.name}</Link></h2><p className="muted small">{person.title || 'Membre du collectif'}</p></div></div>
          {person.bio && <p>{person.bio.length > 180 ? `${person.bio.slice(0, 180)}…` : person.bio}</p>}
          <Skills value={person.skills} />
          <div className="row gap-sm small"><span>{person.public_project_count} projet{person.public_project_count > 1 ? 's' : ''} public{person.public_project_count > 1 ? 's' : ''}</span><span>·</span><span>{person.completed_mission_count} mission{person.completed_mission_count > 1 ? 's' : ''} terminée{person.completed_mission_count > 1 ? 's' : ''}</span></div>
          {person.review_count > 0 && person.average_rating !== null ? <span className="row gap-sm small"><Star size={15} />{person.average_rating.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}/5 · {person.review_count} avis vérifié{person.review_count > 1 ? 's' : ''}</span> : <span className="muted small">Pas encore d’avis vérifié</span>}
        </div>
        <div className="card-footer"><Link className="button button-ghost button-small" to={`/people/${person.id}`}>Voir le profil <ArrowUpRight size={16} /></Link></div>
      </article>)}</div> : <EmptyState title="Aucun profil trouvé" description="Essayez un autre nom, identifiant ou une autre compétence." />}
      <Pagination {...data} onChange={setOffset} />
    </>}
  </>;
}

function PersonProfile({ personId, ownProfile }: { personId: string; ownProfile: boolean }) {
  const { data, loading, error, reload } = useApi<{ person: Profile }>(`/people/${encodeURIComponent(personId)}`);
  if (loading) return <Loading />;
  if (error) return <div className="stack"><Link to="/people">← Retour à l’annuaire</Link><ErrorState message={error} /><button type="button" className="button button-secondary" onClick={reload}>Réessayer</button></div>;
  if (!data) return null;
  const person = data.person;
  const stages: Record<string, string> = { idea: 'Idée', concept: 'Concept', prototype: 'Prototype', beta: 'Bêta', live: 'En ligne', launched: 'Lancé' };
  const categories: Record<string, string> = { ai: 'Intelligence artificielle', saas: 'SaaS', 'developer-tools': 'Outils de développement', design: 'Design', climate: 'Climat', health: 'Santé', education: 'Éducation', other: 'Autre' };
  return <>
    <Link className="button button-ghost" to="/people"><ArrowLeft size={16} /> Retour à l’annuaire</Link>
    <PageHeader eyebrow="Profil public" title={person.name} description={person.title || 'Membre du collectif Alpha'} action={<div className="row gap-sm" style={{ flexWrap: 'wrap' }}><FollowButton targetType="user" targetId={person.id} />{ownProfile && <Link className="button button-secondary" to="/settings"><Settings size={16} /> Modifier mon profil</Link>}</div>} />
    <div className="detail-layout">
      <div className="detail-main stack">
        <section className="card card-body stack">
          <div className="row gap-sm"><Avatar name={person.name} color={person.avatar_color} size="large" /><div><h2>À propos</h2><p className="muted small">Membre depuis le {date(person.created_at)}</p></div></div>
          <p className="pre-wrap">{person.bio || 'Ce membre n’a pas encore ajouté de présentation.'}</p>
          <h3>Compétences</h3><Skills value={person.skills} />
          <p className="muted small">Identifiant public : {person.id}</p>
        </section>
        <section className="stack">
          <h2 className="section-heading">Projets publics</h2>
          {person.projects.length ? <div className="card-grid">{person.projects.map((project) => <article className="card card-body stack" key={project.id}>
            <div className="row row-between"><Badge tone="purple">{stages[project.stage] ?? project.stage}</Badge><span className="muted small">{categories[project.category] ?? project.category}</span></div>
            <h3><Link to={`/projects/${project.id}`}>{project.title}</Link></h3>
            <p className="muted">{project.summary}</p>
            <div className="tag-list">{stringList(project.tags).map((tag, index) => <Badge key={`${tag}-${index}`}>{tag}</Badge>)}</div>
            <Link className="button button-ghost button-small" to={`/projects/${project.id}`}>Découvrir le projet <ArrowUpRight size={16} /></Link>
          </article>)}</div> : <EmptyState title="Aucun projet public" description="Les projets privés ne sont jamais affichés sur un profil public." />}
          {person.public_project_count > person.projects.length && <p className="muted small">Les {person.projects.length} projets publics les plus récents sont affichés.</p>}
        </section>
      </div>
      <aside className="detail-aside stack">
        <section className="card card-body stack">
          <h2>Contributions vérifiées</h2>
          <div><p className="stat-label">Projets publics</p><p className="stat-value">{person.public_project_count}</p></div>
          <div><p className="stat-label">Missions terminées</p><p className="stat-value">{person.completed_mission_count}</p><p className="stat-note">Rapports acceptés, avec ou sans versement de démonstration.</p></div>
        </section>
        <ReputationHighlights userId={person.id} />
      </aside>
    </div>
  </>;
}

function useSettingsAnchor(id: 'teams' | 'invitations') {
  const { hash, search } = useLocation();
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    const target = hash || (new URLSearchParams(search).get('tab') === 'teams' ? '#teams' : '');
    if (target !== `#${id}`) return;
    const frame = requestAnimationFrame(() => {
      section.current?.focus({ preventScroll: true });
      section.current?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, search, id]);
  return section;
}

export function SettingsPage() {
  const { user, loading, error, refresh } = useAuth();
  if (loading) return <Loading />;
  if (error && !user) return <div className="stack"><ErrorState message={error} /><button type="button" className="button button-secondary" onClick={() => { void refresh().catch(() => undefined); }}>Réessayer</button></div>;
  if (!user) return <LoginNotice />;
  return <div className="stack">
    <PageHeader eyebrow="Votre espace" title="Paramètres" description="Présentez vos compétences et gérez vos organisations." action={<Link className="button button-secondary" to={`/people/${user.id}`}>Voir mon profil <ArrowUpRight size={16} /></Link>} />
    {error && <ErrorState message={error} />}
    <ProfileForm key={user.id} user={user} refresh={refresh} />
    <Organizations key={`organizations-${user.id}`} userId={user.id} />
    <AccountSecurity key={`security-${user.id}`} />
  </div>;
}

function ProfileForm({ user, refresh }: { user: User; refresh: () => Promise<void> }) {
  const [name, setName] = useState(user.name);
  const [title, setTitle] = useState(user.title);
  const [bio, setBio] = useState(user.bio);
  const [skills, setSkills] = useState(stringList(user.skills).join(', '));
  const [color, setColor] = useState(user.avatar_color);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    setError(''); setSuccess('');
    const skillList = [...new Set(skills.split(',').map((skill) => skill.trim()).filter(Boolean))];
    if (skillList.length > 20 || skillList.some((skill) => skill.length > 50)) {
      setError('Indiquez au maximum 20 compétences de 50 caractères chacune.');
      return;
    }
    setPending(true);
    try {
      const { person } = await api<{ person: Person }>('/people/me', { method: 'PATCH', body: JSON.stringify({ name, title, bio, skills: skillList, avatar_color: color }) });
      setName(person.name); setTitle(person.title); setBio(person.bio); setSkills(stringList(person.skills).join(', ')); setColor(person.avatar_color);
      setSuccess('Votre profil public a été mis à jour.');
      await refresh();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <section className="card card-body stack">
    <div className="row gap-sm"><Avatar name={name || user.name} color={color} /><div><h2>Mon profil public</h2><p className="muted small">Ces informations sont visibles dans l’annuaire. Votre adresse e-mail reste privée.</p></div></div>
    <form className="form" onSubmit={save}>
      <div className="form-grid">
        <label className="field" htmlFor="profile-name">Nom<input id="profile-name" required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} disabled={pending} autoComplete="name" /></label>
        <label className="field" htmlFor="profile-title">Titre ou métier<input id="profile-title" maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} disabled={pending} placeholder="Développeuse, designer, testeur…" /></label>
        <label className="field full-width" htmlFor="profile-bio">Présentation<textarea id="profile-bio" rows={5} maxLength={3000} value={bio} onChange={(event) => setBio(event.target.value)} disabled={pending} /></label>
        <label className="field full-width" htmlFor="profile-skills">Compétences<input id="profile-skills" maxLength={1040} value={skills} onChange={(event) => setSkills(event.target.value)} disabled={pending} placeholder="React, design produit, tests utilisateurs" /><span className="help-text">Séparez les compétences par une virgule. 20 maximum, 50 caractères chacune.</span></label>
        <label className="field" htmlFor="profile-color">Couleur de l’avatar<input id="profile-color" type="color" value={color} onChange={(event) => setColor(event.target.value)} disabled={pending} /></label>
      </div>
      <ErrorState message={error} />
      {success && <p className="alert alert-success" role="status">{success}</p>}
      <div><button className="button button-primary" type="submit" disabled={pending}><CheckCircle2 size={16} /> {pending ? 'Enregistrement…' : 'Enregistrer mon profil'}</button></div>
    </form>
  </section>;
}

function Organizations({ userId }: { userId: string }) {
  const section = useSettingsAnchor('teams');
  const [offset, setOffset] = useState(0);
  const organizations = useApi<Collection & { organizations: Organization[] }>(`/people/organizations?limit=12&offset=${offset}`);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const selected = organizations.data?.organizations.find((organization) => organization.id === selectedId) ?? organizations.data?.organizations[0];
  async function create(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(''); setSuccess('');
    try {
      const { organization } = await api<{ organization: Organization }>('/people/organizations', { method: 'POST', body: JSON.stringify({ name, description }) });
      setName(''); setDescription(''); setSelectedId(organization.id); setOffset(0);
      setSuccess('Organisation créée. Vous en êtes propriétaire.');
      organizations.reload();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <section className="stack" id="teams" ref={section} tabIndex={-1} style={{ scrollMarginTop: 96 }}>
    <ReceivedInvitations onJoined={() => { setOffset(0); organizations.reload(); }} />
    <div className="section-heading"><h2 className="row gap-sm"><Building2 size={22} /> Mes organisations</h2><p className="muted">Seules les organisations dont vous êtes membre apparaissent ici.</p></div>
    {success && <p className="alert alert-success" role="status">{success}</p>}
    <div className="two-column">
      <div className="stack">
        {organizations.loading ? <Loading /> : organizations.error ? <div className="stack"><ErrorState message={organizations.error} /><button type="button" className="button button-secondary" onClick={organizations.reload}>Réessayer</button></div> : organizations.data && <>
          {organizations.data.organizations.length ? <div className="stack">{organizations.data.organizations.map((organization) => <article className="card card-body stack" key={organization.id}>
            <div className="row row-between"><h3>{organization.name}</h3><Badge tone={organization.my_role === 'owner' ? 'purple' : 'neutral'}>{roles[organization.my_role]}</Badge></div>
            <p className="muted pre-wrap">{organization.description || 'Aucune description.'}</p>
            <div className="row row-between"><span className="small">{organization.member_count} membre{organization.member_count > 1 ? 's' : ''}</span><button type="button" className={`button ${selected?.id === organization.id ? 'button-primary' : 'button-secondary'} button-small`} aria-pressed={selected?.id === organization.id} onClick={() => { setSelectedId(organization.id); setSuccess(''); }}>Voir les membres</button></div>
          </article>)}</div> : <EmptyState title="Aucune organisation" description="Acceptez une invitation ci-dessus ou créez une organisation pour collaborer avec votre équipe." />}
          <Pagination {...organizations.data} onChange={setOffset} />
        </>}
      </div>
      <section className="card card-body stack">
        <h3>Créer une organisation</h3>
        <form className="form" onSubmit={create}>
          <label className="field" htmlFor="organization-name">Nom de l’organisation<input id="organization-name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} disabled={pending} /></label>
          <label className="field" htmlFor="organization-description">Description<textarea id="organization-description" rows={4} maxLength={3000} value={description} onChange={(event) => setDescription(event.target.value)} disabled={pending} /></label>
          <p className="help-text">Vous serez automatiquement ajouté comme propriétaire. Seul le propriétaire peut modifier les membres.</p>
          <ErrorState message={error} />
          <button className="button button-primary" type="submit" disabled={pending}>{pending ? 'Création…' : 'Créer l’organisation'}</button>
        </form>
      </section>
    </div>
    {selected && <OrganizationMembers key={selected.id} organization={selected} owner={selected.owner_id === userId} onChanged={(message) => { setSuccess(message); organizations.reload(); }} />}
  </section>;
}

function ReceivedInvitations({ onJoined }: { onJoined: () => void }) {
  const section = useSettingsAnchor('invitations');
  const [offset, setOffset] = useState(0);
  const invitations = useApi<Collection & { invitations: Invitation[] }>(`/people/invitations?limit=12&offset=${offset}`);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function respond(invitation: Invitation, action: 'accept' | 'decline') {
    setPending(invitation.id); setError(''); setSuccess('');
    try {
      await api(`/people/invitations/${invitation.id}/${action}`, { method: 'POST' });
      setSuccess(action === 'accept' ? `Vous avez rejoint ${invitation.organization.name}.` : 'Invitation refusée. Aucun accès d’équipe n’a été accordé.');
      invitations.reload();
      if (action === 'accept') onJoined();
    } catch (failure) { setError(errorMessage(failure)); invitations.reload(); }
    finally { setPending(''); }
  }
  return <section className="card card-body stack" id="invitations" ref={section} tabIndex={-1} style={{ scrollMarginTop: 96 }}>
    <h2>Invitations reçues</h2>
    <p className="muted">Vous restez libre d’accepter ou de refuser. Une invitation seule ne donne aucun accès et expire après 7 jours.</p>
    <p className="help-text">{teamAccess}</p>
    <ErrorState message={error} />
    {success && <p className="alert alert-success" role="status">{success}</p>}
    {invitations.loading ? <Loading /> : invitations.error ? <div className="stack"><ErrorState message={invitations.error} /><button type="button" className="button button-secondary" onClick={invitations.reload}>Réessayer</button></div> : invitations.data && <>
      {invitations.data.invitations.length ? <div className="stack">{invitations.data.invitations.map((invitation) => <article className="card card-body stack" key={invitation.id}>
        <div className="row row-between" style={{ flexWrap: 'wrap' }}><h3>{invitation.organization.name}</h3><Badge tone={invitation.status === 'pending' ? 'purple' : 'neutral'}>{invitationStatuses[invitation.status]}</Badge></div>
        {invitation.organization.description && <p className="muted pre-wrap">{invitation.organization.description}</p>}
        <p>Invitation de <Link to={`/people/${invitation.inviter.id}`}>{invitation.inviter.name}</Link> · Rôle proposé : <strong>{roles[invitation.role]}</strong></p>
        <p className="muted small">Envoyée le {date(invitation.created_at)} · Expiration le {date(invitation.expires_at)}</p>
        {invitation.status === 'pending' && <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="button button-primary" disabled={!!pending} onClick={() => { void respond(invitation, 'accept'); }}>{pending === invitation.id ? 'Traitement…' : 'Accepter et rejoindre'}</button>
          <button type="button" className="button button-secondary" disabled={!!pending} onClick={() => { void respond(invitation, 'decline'); }}>Refuser</button>
        </div>}
      </article>)}</div> : <EmptyState title="Aucune invitation reçue" description="Les invitations de vos futurs collaborateurs apparaîtront ici." />}
      <Pagination {...invitations.data} onChange={setOffset} />
    </>}
  </section>;
}

function SentInvitations({ organizationId }: { organizationId: string }) {
  const [offset, setOffset] = useState(0);
  const invitations = useApi<Collection & { invitations: Invitation[] }>(`/people/organizations/${organizationId}/invitations?limit=12&offset=${offset}`);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function revoke(invitation: Invitation) {
    setPending(invitation.id); setError(''); setSuccess('');
    try {
      await api(`/people/invitations/${invitation.id}/revoke`, { method: 'POST' });
      setSuccess(`L’invitation de ${invitation.invitee.name} a été révoquée.`);
      invitations.reload();
    } catch (failure) { setError(errorMessage(failure)); invitations.reload(); }
    finally { setPending(''); }
  }
  return <section className="stack">
    <h3>Invitations envoyées</h3>
    <p className="help-text">Les invitations en attente peuvent être révoquées. Après expiration ou refus, vous pouvez envoyer une nouvelle invitation. Un départ ou un retrait révoque aussi l’ancienne adhésion.</p>
    <ErrorState message={error} />
    {success && <p className="alert alert-success" role="status">{success}</p>}
    {invitations.loading ? <Loading /> : invitations.error ? <div className="stack"><ErrorState message={invitations.error} /><button type="button" className="button button-secondary" onClick={invitations.reload}>Réessayer</button></div> : invitations.data && <>
      {invitations.data.invitations.length ? <ul className="list">{invitations.data.invitations.map((invitation) => <li className="list-item" key={invitation.id} style={{ flexWrap: 'wrap', gap: 12 }}>
        <div><Link to={`/people/${invitation.invitee.id}`}>{invitation.invitee.name}</Link><p className="muted small">{roles[invitation.role]} · Expiration le {date(invitation.expires_at)}</p></div>
        <div className="row gap-sm" style={{ flexWrap: 'wrap' }}><Badge tone={invitation.status === 'pending' ? 'purple' : 'neutral'}>{invitationStatuses[invitation.status]}</Badge>
          {invitation.status === 'pending' && <button type="button" className="button button-danger button-small" disabled={!!pending} aria-label={`Révoquer l’invitation de ${invitation.invitee.name}`} onClick={() => { void revoke(invitation); }}>{pending === invitation.id ? 'Révocation…' : 'Révoquer'}</button>}
        </div>
      </li>)}</ul> : <EmptyState title="Aucune invitation envoyée" description="Invitez un profil public à rejoindre votre équipe." />}
      <Pagination {...invitations.data} onChange={setOffset} />
    </>}
  </section>;
}

function MemberRoleEditor({ member, pending, onSave }: { member: Member; pending: boolean; onSave: (role: 'member' | 'admin') => Promise<void> }) {
  const [role, setRole] = useState<'member' | 'admin'>(member.role === 'admin' ? 'admin' : 'member');
  return <form className="row gap-sm" style={{ flexWrap: 'wrap' }} onSubmit={(event) => { event.preventDefault(); void onSave(role); }}>
    <label className="field" htmlFor={`role-${member.id}`}>Rôle de {member.name}<select id={`role-${member.id}`} value={role} onChange={(event) => setRole(event.target.value as 'member' | 'admin')} disabled={pending}><option value="member">Membre</option><option value="admin">Administrateur</option></select></label>
    <button type="submit" className="button button-secondary button-small" disabled={pending || role === member.role}>Enregistrer le rôle</button>
  </form>;
}

function OrganizationMembers({ organization, owner, onChanged }: { organization: Organization; owner: boolean; onChanged: (message: string) => void }) {
  const [offset, setOffset] = useState(0);
  const members = useApi<Collection & { members: Member[] }>(`/people/organizations/${organization.id}/members?limit=24&offset=${offset}`);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [invitationsRevision, setInvitationsRevision] = useState(0);
  useEffect(() => {
    const timeout = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timeout);
  }, [search]);
  const directory = useApi<Directory>(owner && query ? `/people?q=${encodeURIComponent(query)}&limit=100` : null);
  const candidates = directory.data?.people.filter((person) => person.id !== organization.owner_id && !members.data?.members.some((member) => member.id === person.id)) ?? [];
  async function inviteMember(event: FormEvent) {
    event.preventDefault();
    setPending(true); setError(''); setSuccess('');
    try {
      await api(`/people/organizations/${organization.id}/invitations`, { method: 'POST', body: JSON.stringify({ user_id: selectedUser, role }) });
      setSelectedUser(''); setSearch('');
      setInvitationsRevision((value) => value + 1);
      setSuccess('Invitation envoyée pour 7 jours. Aucun accès n’est accordé avant son acceptation.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  async function changeRole(memberId: string, nextRole: 'member' | 'admin') {
    setPending(true); setError(''); setSuccess('');
    try {
      await api(`/people/organizations/${organization.id}/members/${memberId}`, { method: 'PATCH', body: JSON.stringify({ role: nextRole }) });
      members.reload();
      setSuccess('Le rôle du membre a été mis à jour.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  async function removeMember(member: Member) {
    if (!window.confirm(`Retirer ${member.name} de ${organization.name} ? Son accès d’équipe aux projets et aux tâches sera retiré immédiatement.`)) return;
    setPending(true); setError(''); setSuccess('');
    try {
      await api(`/people/organizations/${organization.id}/members/${member.id}`, { method: 'DELETE' });
      if (members.data?.members.length === 1 && offset > 0) setOffset(Math.max(0, offset - 24));
      members.reload();
      onChanged('Le membre a été retiré de l’organisation.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  async function leave() {
    if (!window.confirm(`Quitter ${organization.name} ? Vous perdrez immédiatement votre accès d’équipe aux projets privés et aux tâches. Vos affectations historiques resteront conservées. Une nouvelle invitation sera nécessaire pour revenir.`)) return;
    setPending(true); setError(''); setSuccess('');
    try {
      await api(`/people/organizations/${organization.id}/leave`, { method: 'POST' });
      onChanged(`Vous avez quitté ${organization.name}. Votre accès d’équipe a été retiré.`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <section className="card card-body stack">
    <div><h3 className="row gap-sm"><Users size={20} /> Membres de {organization.name}</h3><p className="muted small">Cette liste est réservée aux membres de l’organisation. {owner ? 'Le rôle du propriétaire est protégé.' : 'Seul le propriétaire peut gérer les membres.'}</p></div>
    <p className="help-text">{teamAccess}</p>
    <ErrorState message={error} />
    {success && <p className="alert alert-success" role="status">{success}</p>}
    {members.loading ? <Loading /> : members.error ? <div className="stack"><ErrorState message={members.error} /><button type="button" className="button button-secondary" onClick={members.reload}>Réessayer</button></div> : members.data && <>
      {members.data.members.length ? <ul className="list">{members.data.members.map((member) => <li className="list-item" key={member.id} style={{ flexWrap: 'wrap', gap: 12 }}>
        <div className="row gap-sm"><Avatar name={member.name} color={member.avatar_color} size="small" /><div><Link to={`/people/${member.id}`}>{member.name}</Link><p className="muted small">{member.id}</p></div></div>
        <div className="stack"><Badge tone={member.role === 'owner' ? 'purple' : 'neutral'}>{roles[member.role]}</Badge>{owner && member.id !== organization.owner_id && member.role !== 'owner' && <>
          <MemberRoleEditor key={`${member.id}-${member.role}`} member={member} pending={pending} onSave={(nextRole) => changeRole(member.id, nextRole)} />
          <button type="button" className="button button-danger button-small" disabled={pending} aria-label={`Retirer ${member.name} de l’organisation`} onClick={() => { void removeMember(member); }}><Trash2 size={15} /> Retirer</button>
        </>}</div>
      </li>)}</ul> : <EmptyState title="Aucun membre sur cette page" />}
      <Pagination {...members.data} onChange={setOffset} />
    </>}
    {!owner && <div><button type="button" className="button button-danger" disabled={pending} onClick={() => { void leave(); }}>{pending ? 'Traitement…' : 'Quitter l’organisation'}</button><p className="help-text">Une confirmation vous sera demandée. Vos accès d’équipe seront retirés immédiatement.</p></div>}
    {owner && <>
      <div className="divider" />
      <h3>Inviter une personne</h3>
      <p className="help-text">Recherchez un profil public et choisissez le rôle proposé. La personne devra accepter pour devenir membre. Pour modifier un membre existant, utilisez les contrôles ci-dessus.</p>
      <label className="field" htmlFor="member-search">Rechercher par nom ou identifiant public<input id="member-search" type="search" maxLength={100} value={search} onChange={(event) => { setSearch(event.target.value); setSelectedUser(''); }} disabled={pending} placeholder="Nom ou identifiant du profil Alpha" /></label>
      {!query && <p className="muted small">Saisissez un nom ou un identifiant pour rechercher une personne à inviter.</p>}
      {directory.loading ? <Loading /> : directory.error ? <div className="stack"><ErrorState message={directory.error} /><button type="button" className="button button-secondary" onClick={directory.reload}>Réessayer la recherche</button></div> : directory.data && <form className="form" onSubmit={inviteMember}>
        {candidates.length === 0 ? <p className="muted">Aucun autre profil non membre affiché ne correspond à la recherche.</p> : <div className="form-grid">
          <label className="field" htmlFor="member-user">Profil public<select id="member-user" value={selectedUser} onChange={(event) => setSelectedUser(event.target.value)} required disabled={pending}><option value="">Sélectionner une personne</option>{candidates.map((person) => <option value={person.id} key={person.id}>{person.name} — {person.id}</option>)}</select></label>
          <label className="field" htmlFor="member-role">Rôle<select id="member-role" value={role} onChange={(event) => setRole(event.target.value as 'member' | 'admin')} disabled={pending}><option value="member">Membre</option><option value="admin">Administrateur</option></select></label>
        </div>}
        {directory.data.total > directory.data.people.length && <p className="help-text">Les 100 premiers profils sont affichés. Affinez la recherche pour trouver une autre personne.</p>}
        <p className="help-text">L’invitation expire après 7 jours. Aucun accès n’est accordé avant l’acceptation.</p>
        <div><button type="submit" className="button button-primary" disabled={pending || !selectedUser || !candidates.some((person) => person.id === selectedUser)}>{pending ? 'Envoi…' : 'Envoyer l’invitation'}</button></div>
      </form>}
      <div className="divider" />
      <SentInvitations key={invitationsRevision} organizationId={organization.id} />
    </>}
  </section>;
}
