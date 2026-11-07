import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Globe2, Heart, LogOut, MessageCircle, Plus, Search, Send, Trash2, UserPlus, Users, X } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, LoginNotice, PageHeader, useApi } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Author { id: string; name: string; title: string; avatar_color: string }
interface Group {
  id: string; owner_id: string; name: string; description: string; category: string;
  color: string; created_at: string; visibility: 'public'; member_count: number;
  is_member: boolean; owner: Author;
}
interface Post {
  id: string; body: string; created_at: string; author: Author; group_id: string | null;
  group_name: string | null; like_count: number; comment_count: number; liked: boolean;
  project_id: string | null; project_title: string | null;
}
interface Comment { id: string; post_id: string; body: string; created_at: string; author: Author }
interface Pagination { total: number; page: number; page_size: number; has_more: boolean }
interface GroupList extends Pagination { groups: Group[]; categories: string[] }
interface ProjectChoice { id: string; title: string }
interface ProjectChoices extends Pagination { projects: ProjectChoice[] }
interface PostList extends Pagination { posts: Post[]; project?: ProjectChoice }
interface CommentList extends Pagination { comments: Comment[] }

const categories = ['Développement web', 'Intelligence artificielle', 'Design & UX', 'Open source', 'Mobile', 'Produit', 'Autre'];
const timestamp = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const memberLabel = (count: number) => `${count} membre${count > 1 ? 's' : ''}`;

function PaginationControls({ data, onPage }: { data: Pagination; onPage: (page: number) => void }) {
  if (data.page === 1 && !data.has_more) return null;
  return <nav className="row row-between" aria-label="Pagination">
    <button type="button" className="button button-secondary button-small" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>
      <ArrowLeft size={15} /> Précédent
    </button>
    <span className="small muted">Page {data.page} sur {Math.max(1, Math.ceil(data.total / data.page_size))}</span>
    <button type="button" className="button button-secondary button-small" disabled={!data.has_more} onClick={() => onPage(data.page + 1)}>
      Suivant <ArrowRight size={15} />
    </button>
  </nav>;
}

function AuthorIdentity({ author, createdAt }: { author: Author; createdAt: string }) {
  return <div className="row gap-sm">
    <Link to={`/people/${author.id}`} aria-label={`Profil de ${author.name}`}><Avatar name={author.name} color={author.avatar_color} /></Link>
    <div>
      <Link to={`/people/${author.id}`}><strong>{author.name}</strong></Link>
      {author.title && <div className="small muted">{author.title}</div>}
      <time className="small muted" dateTime={createdAt} title={timestamp(createdAt)}>{timestamp(createdAt)}</time>
    </div>
  </div>;
}

function CreateGroupForm({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState(categories[0]);
  const [color, setColor] = useState('#6658e8');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await api<{ group: Group }>('/community/groups', {
        method: 'POST', body: JSON.stringify({ name, description, category, color }),
      });
      onClose();
      navigate(`/community/${result.group.id}`);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }

  return <section className="card" aria-labelledby="create-group-title">
    <div className="card-header row row-between">
      <h2 id="create-group-title">Un sujet commun, un nouveau collectif</h2>
      <button type="button" className="icon-button" disabled={pending} onClick={onClose} aria-label="Fermer le formulaire"><X size={20} /></button>
    </div>
    <form className="card-body form" onSubmit={submit}>
      <div className="alert"><Globe2 size={17} /> Tous les groupes Alpha sont publics dans cette première version. Leur description et leurs publications sont visibles par tous, même sans compte.</div>
      <div className="form-grid">
        <label className="field">Nom du groupe<input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required disabled={pending} placeholder="Ex. Les artisans du web" /></label>
        <label className="field">Thématique<select value={category} onChange={(event) => setCategory(event.target.value)} disabled={pending}>{categories.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="field full-width">Description<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={2000} required disabled={pending} rows={3} placeholder="À qui s’adresse ce groupe ? Qu’aimeriez-vous construire ensemble ?" /></label>
        <label className="field">Couleur du groupe<select value={color} onChange={(event) => setColor(event.target.value)} disabled={pending}>
          <option value="#6658e8">Violet</option><option value="#2877c7">Bleu</option><option value="#21816a">Vert</option><option value="#b85a30">Terracotta</option>
        </select></label>
      </div>
      <ErrorState message={error} />
      <div className="row row-between">
        <span className="help-text">Vous en devenez le créateur et le premier membre.</span>
        <button type="submit" className="button button-primary" disabled={pending || !name.trim() || !description.trim()}><Plus size={17} /> {pending ? 'Création…' : 'Créer le groupe public'}</button>
      </div>
    </form>
  </section>;
}

function GroupDiscovery({ selectedId, updatedGroup }: { selectedId?: string; updatedGroup: Group | null }) {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [filter, setFilter] = useState({ q: '', category: '' });
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ q: filter.q, category: filter.category, page: String(page), page_size: '6' });
  const groups = useApi<GroupList>(`/community/groups?${query}`);
  const options = Array.from(new Set([...(groups.data?.categories ?? []), ...(category ? [category] : [])]));
  const filtered = !!filter.q || !!filter.category;

  function submit(event: FormEvent) {
    event.preventDefault();
    setFilter({ q: search.trim(), category }); setPage(1);
  }

  return <section className="card" id="group-discovery" aria-labelledby="group-discovery-title">
    <div className="card-header">
      <div className="row row-between"><h2 id="group-discovery-title">Trouvez votre collectif</h2><Users size={20} /></div>
      <p className="small muted">Des groupes publics pour partager, apprendre et construire.</p>
    </div>
    <div className="card-body stack">
      <form className="form" onSubmit={submit}>
        <label className="field">Rechercher un groupe<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} placeholder="Un sujet, une passion…" /></label>
        <label className="field">Thématique<select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">Toutes les thématiques</option>
          {options.map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <button type="submit" className="button button-secondary"><Search size={16} /> Rechercher</button>
      </form>
      {groups.loading ? <Loading /> : groups.error ? <div className="stack"><ErrorState message={groups.error} /><button type="button" className="button button-secondary" onClick={groups.reload}>Réessayer</button></div> : groups.data && <>
        <div className="small muted">{groups.data.total} groupe{groups.data.total > 1 ? 's' : ''} {filtered ? 'correspondant à votre recherche' : 'à découvrir'}</div>
        {groups.data.groups.length === 0 ? <EmptyState title={filtered ? 'Aucun groupe trouvé' : 'Le prochain collectif sera le vôtre'} description={filtered ? 'Essayez un autre mot-clé ou une autre thématique.' : 'Créez le premier groupe public autour de votre sujet.'} /> : <div className="stack">
          {groups.data.groups.map((initialGroup) => {
            const group = updatedGroup?.id === initialGroup.id ? updatedGroup : initialGroup;
            return <article key={group.id} className="list-item stack">
              <div className="row gap-sm">
                <Avatar name={group.name} color={group.color} />
                <div><Link to={`/community/${group.id}`} aria-current={selectedId === group.id ? 'page' : undefined}><strong>{group.name}</strong></Link><div className="small muted">{group.category}</div></div>
              </div>
              <p className="small" style={{ overflowWrap: 'anywhere' }}>{group.description.length > 150 ? `${group.description.slice(0, 150)}…` : group.description}</p>
              <div className="row row-between"><span className="small muted">{memberLabel(group.member_count)}</span><Badge tone={group.is_member ? 'purple' : 'neutral'}>{group.is_member ? 'Membre · Public' : 'Public'}</Badge></div>
              <Link className="button button-ghost button-small" to={`/community/${group.id}`}>Découvrir le groupe <ArrowRight size={14} /></Link>
            </article>;
          })}
        </div>}
        <PaginationControls data={groups.data} onPage={setPage} />
      </>}
    </div>
  </section>;
}

function GroupHeader({ group, onChange }: { group: Group; onChange: (group: Group) => void }) {
  const { user, loading } = useAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const owner = user?.id === group.owner_id;
  async function membership() {
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await api<{ group: Group }>(`/community/groups/${group.id}/${group.is_member ? 'leave' : 'join'}`, { method: 'POST' });
      onChange(result.group);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }

  return <section className="card" aria-labelledby="group-title">
    <div className="card-body stack">
      <div className="row row-between"><div className="row gap-sm"><Avatar name={group.name} color={group.color} size="large" /><div><h2 id="group-title">{group.name}</h2><span className="muted small">{group.category}</span></div></div><Badge tone="green"><Globe2 size={13} /> Groupe public</Badge></div>
      <p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{group.description}</p>
      <div className="row gap-sm"><Users size={16} /><strong>{memberLabel(group.member_count)}</strong><span className="muted small">Créé le <time dateTime={group.created_at}>{timestamp(group.created_at)}</time></span></div>
      <div className="small muted">Un groupe animé par <Link to={`/people/${group.owner.id}`}>{group.owner.name}</Link>.</div>
      <div className="alert small">Ce groupe est public : tout le monde peut lire ses publications et commentaires. Rejoignez-le pour publier. Il n’existe pas de groupes privés dans cette version.</div>
      <ErrorState message={error} />
      <div id="group-membership">
        {loading ? <Loading /> : !user ? <Link className="button button-primary" to="/login">Se connecter pour rejoindre</Link> : owner ? <Badge tone="purple">Vous êtes le créateur · Membre permanent</Badge> : <button type="button" className={`button ${group.is_member ? 'button-secondary' : 'button-primary'}`} disabled={pending} onClick={() => void membership()}>
          {group.is_member ? <LogOut size={16} /> : <UserPlus size={16} />}{pending ? 'Mise à jour…' : group.is_member ? 'Quitter le groupe' : 'Rejoindre le groupe'}
        </button>}
      </div>
    </div>
  </section>;
}

function PostComposer({ group, projectId, onCreated }: { group?: Group; projectId?: string; onCreated: () => void }) {
  const { user, loading } = useAuth();
  const [body, setBody] = useState('');
  const [selectedProject, setSelectedProject] = useState(projectId ?? '');
  const [projectPage, setProjectPage] = useState(1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const projectQuery = new URLSearchParams({ page: String(projectPage), page_size: '50' });
  if (projectId) projectQuery.set('project', projectId);
  const projects = useApi<ProjectChoices>(user && !group ? `/community/publishable-projects?${projectQuery}` : null);
  const selectedChoice = projects.data?.projects.find((project) => project.id === selectedProject);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !body.trim()) return;
    setPending(true); setError('');
    try {
      await api('/community/posts', { method: 'POST', body: JSON.stringify({
        body, ...(group ? { group_id: group.id } : selectedProject ? { project_id: selectedProject } : {}),
      }) });
      setBody(''); onCreated();
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  if (loading) return <Loading />;
  if (!user) return <div className="card"><LoginNotice /></div>;
  if (group && !group.is_member) return <div className="alert">Envie de lancer une discussion ? Rejoignez ce groupe avec le bouton ci-dessus pour publier.</div>;
  if (projectId && projects.loading) return <Loading />;
  if (projectId && projects.error) return <div className="stack"><ErrorState message={projects.error} /><button className="button button-secondary" onClick={projects.reload}>Réessayer</button></div>;
  if (projectId && !selectedChoice) return <div className="alert">Seuls les responsables de ce projet public peuvent publier ses actualités. Vous pouvez participer aux discussions ci-dessous.</div>;
  return <section className="card">
    <form className="card-body form" onSubmit={submit}>
      <div className="row gap-sm"><Avatar name={user.name} color={user.avatar_color} /><div><strong>{selectedProject ? 'Partagez une actualité du projet' : 'Partagez ce qui vous anime'}</strong><div className="small muted">{group ? `Dans ${group.name}` : selectedChoice ? selectedChoice.title : 'Avec tout le collectif Alpha'}</div></div></div>
      {!group && !projectId && <div className="stack">
        <label className="field">Publier dans<select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)} disabled={pending || projects.loading}>
          <option value="">Le collectif · publication générale</option>
          {projects.data?.projects.map((project) => <option value={project.id} key={project.id}>Projet · {project.title}</option>)}
        </select></label>
        {projects.loading ? <Loading /> : projects.error ? <><ErrorState message={projects.error} /><button type="button" className="button button-ghost button-small" onClick={projects.reload}>Recharger les projets</button></> : projects.data && <PaginationControls data={projects.data} onPage={(page) => { setSelectedProject(''); setProjectPage(page); }} />}
        <span className="help-text">Les projets publics dont vous êtes responsable sont proposés. Une actualité avertit leurs abonnés, sans recopier son contenu dans la notification.</span>
      </div>}
      <label className="field" htmlFor="post-body">Votre publication<textarea id="post-body" value={body} onChange={(event) => setBody(event.target.value)} maxLength={5000} required disabled={pending} rows={4} placeholder="Une idée à explorer, un retour d’expérience, une question pour le collectif…" /></label>
      <ErrorState message={error} />
      <div className="row row-between"><span className="help-text"><Globe2 size={13} /> Publication publique · {body.length}/5 000</span><button type="submit" className="button button-primary" disabled={pending || !body.trim() || (!!selectedProject && !selectedChoice)}><Send size={16} /> {pending ? 'Publication…' : 'Publier'}</button></div>
    </form>
  </section>;
}

function Comments({ postId, onCountChange }: { postId: string; onCountChange: (count: number) => void }) {
  const { user, loading: authLoading } = useAuth();
  const [page, setPage] = useState(1);
  const comments = useApi<CommentList>(`/community/posts/${postId}/comments?page=${page}&page_size=20`);
  const [body, setBody] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');

  function refresh(count: number, latest = false) {
    onCountChange(count);
    const lastPage = Math.max(1, Math.ceil(count / 20));
    const nextPage = latest ? lastPage : Math.min(page, lastPage);
    if (nextPage !== page) setPage(nextPage);
    else comments.reload();
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !body.trim()) return;
    setPending('create'); setError('');
    try {
      const result = await api<{ comment: Comment; comment_count: number }>(`/community/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
      setBody(''); refresh(result.comment_count, true);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(null); }
  }
  async function remove(commentId: string) {
    if (pending || !window.confirm('Supprimer définitivement votre commentaire ?')) return;
    setPending(commentId); setError('');
    try {
      const result = await api<{ deleted: boolean; comment_count: number }>(`/community/posts/${postId}/comments/${commentId}`, { method: 'DELETE' });
      refresh(result.comment_count);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(null); }
  }
  return <section className="stack" id={`comments-${postId}`} aria-label="Commentaires">
    <h3>La discussion</h3>
    {comments.loading ? <Loading /> : comments.error ? <div className="stack"><ErrorState message={comments.error} /><button type="button" className="button button-secondary button-small" onClick={comments.reload}>Réessayer</button></div> : comments.data && <>
      {comments.data.comments.length === 0 ? <p className="muted small">Aucun commentaire pour le moment. Lancez la discussion !</p> : <div className="stack">
        {comments.data.comments.map((comment) => <article key={comment.id} className="list-item stack">
          <div className="row row-between"><AuthorIdentity author={comment.author} createdAt={comment.created_at} />{user?.id === comment.author.id && <button type="button" className="icon-button text-danger" aria-label={`Supprimer votre commentaire du ${timestamp(comment.created_at)}`} disabled={!!pending} onClick={() => void remove(comment.id)}><Trash2 size={15} /></button>}</div>
          <p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{comment.body}</p>
        </article>)}
      </div>}
      <PaginationControls data={comments.data} onPage={setPage} />
    </>}
    <ErrorState message={error} />
    {authLoading ? <Loading /> : user ? <form className="form" onSubmit={submit}>
      <label className="field" htmlFor={`comment-body-${postId}`}>Votre commentaire<textarea id={`comment-body-${postId}`} value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} required rows={2} disabled={!!pending} placeholder="Faites avancer la discussion…" /></label>
      <div className="row row-between"><span className="help-text">{body.length}/2 000 · Public</span><button type="submit" className="button button-secondary button-small" disabled={!!pending || !body.trim()}>{pending === 'create' ? 'Envoi…' : 'Commenter'}</button></div>
    </form> : <p className="small muted"><Link to="/login">Connectez-vous</Link> pour commenter ou aimer cette publication.</p>}
  </section>;
}

function PostCard({ post, onDeleted }: { post: Post; onDeleted: () => void }) {
  const { user } = useAuth();
  const [liked, setLiked] = useState(post.liked);
  const [likeCount, setLikeCount] = useState(post.like_count);
  const [commentCount, setCommentCount] = useState(post.comment_count);
  const [showComments, setShowComments] = useState(false);
  const [pending, setPending] = useState<'like' | 'delete' | null>(null);
  const [error, setError] = useState('');
  async function toggleLike() {
    if (pending) return;
    setPending('like'); setError('');
    try {
      const result = await api<{ liked: boolean; like_count: number }>(`/community/posts/${post.id}/like`, { method: 'POST' });
      setLiked(result.liked); setLikeCount(result.like_count);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(null); }
  }
  async function remove() {
    if (pending || !window.confirm('Supprimer définitivement votre publication et tous ses commentaires ?')) return;
    setPending('delete'); setError('');
    try { await api(`/community/posts/${post.id}`, { method: 'DELETE' }); onDeleted(); }
    catch (error) { setError(errorMessage(error)); }
    finally { setPending(null); }
  }
  return <article className="card">
    <div className="card-body stack">
      <div className="row row-between"><AuthorIdentity author={post.author} createdAt={post.created_at} />{user?.id === post.author.id && <button type="button" className="icon-button text-danger" disabled={!!pending} onClick={() => void remove()} aria-label="Supprimer votre publication"><Trash2 size={17} /></button>}</div>
      {post.group_id && <div><Link to={`/community/${post.group_id}`}><Badge tone="purple"><Users size={12} /> {post.group_name} · Public</Badge></Link></div>}
      {post.project_id && <div className="row gap-sm" style={{ flexWrap: 'wrap' }}><Link to={`/projects/${post.project_id}`}><Badge tone="green"><Globe2 size={12} /> {post.project_title} · Projet public</Badge></Link><Link className="small" to={`/community?project=${post.project_id}`}>Toutes les actualités</Link></div>}
      <p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{post.body}</p>
      <ErrorState message={error} />
    </div>
    <div className="card-footer row gap-sm">
      {user ? <button type="button" className={`button button-ghost button-small${liked ? ' text-danger' : ''}`} aria-pressed={liked} disabled={!!pending} onClick={() => void toggleLike()} aria-label={`${liked ? 'Retirer votre mention J’aime' : 'Aimer cette publication'} · ${likeCount}`}>
        <Heart size={17} fill={liked ? 'currentColor' : 'none'} /> {likeCount} J’aime
      </button> : <Link className="button button-ghost button-small" to="/login" aria-label={`Se connecter pour aimer · ${likeCount} mentions J’aime`}><Heart size={17} /> {likeCount} J’aime</Link>}
      <button type="button" className="button button-ghost button-small" onClick={() => setShowComments((value) => !value)} aria-expanded={showComments} aria-controls={`comments-${post.id}`}><MessageCircle size={17} /> {commentCount} commentaire{commentCount > 1 ? 's' : ''}</button>
    </div>
    {showComments && <div className="card-body"><Comments postId={post.id} onCountChange={setCommentCount} /></div>}
  </article>;
}

function Feed({ group, projectId, feed }: { group?: Group; projectId?: string; feed: 'discovery' | 'following' }) {
  const { user, loading: authLoading } = useAuth();
  const [page, setPage] = useState(1);
  const query = new URLSearchParams({ page: String(page), page_size: '20', feed });
  if (group) query.set('group', group.id);
  if (projectId) query.set('project', projectId);
  const posts = useApi<PostList>(feed === 'following' && (authLoading || !user) ? null : `/community/posts?${query}`);
  function created() { if (page !== 1) setPage(1); else posts.reload(); }
  function deleted() {
    if (posts.data?.posts.length === 1 && page > 1) setPage(page - 1);
    else posts.reload();
  }
  if (feed === 'following' && authLoading) return <Loading />;
  if (feed === 'following' && !user) return <div className="card"><LoginNotice /></div>;
  return <div className="stack">
    {(!projectId || posts.data?.project) && <PostComposer group={group} projectId={projectId} onCreated={created} />}
    <div className="section-heading row row-between"><h2>{group ? 'Les échanges du groupe' : projectId ? 'Les actualités du projet' : feed === 'following' ? 'Votre fil personnalisé' : 'Le fil du collectif'}</h2><span className="muted small">Les plus récents d’abord</span></div>
    {posts.data?.project && <Link className="button button-ghost button-small" to={`/projects/${posts.data.project.id}`}>{posts.data.project.title} <ArrowRight size={15} /></Link>}
    {!group && !projectId && <p className="muted small">{feed === 'following' ? 'Vos publications, les membres et projets publics suivis, ainsi que vos groupes. Actualisez pour découvrir les nouveautés.' : 'Les publications du collectif, de tous ses groupes publics et les actualités des projets publics.'}</p>}
    <button type="button" className="button button-secondary button-small" onClick={posts.reload} disabled={posts.loading}>Actualiser le fil</button>
    {posts.loading ? <Loading /> : posts.error ? <div className="stack"><ErrorState message={posts.error} /><button type="button" className="button button-secondary" onClick={posts.reload}>Réessayer</button></div> : posts.data && <>
      {posts.data.posts.length === 0 ? <div className="card"><EmptyState title="Tout commence par une conversation" description={group ? 'Ce groupe attend sa première publication. Partagez une question ou une idée avec ses membres.' : projectId ? 'Aucune actualité publique pour ce projet dans ce fil.' : feed === 'following' ? 'Suivez des membres ou des projets, ou rejoignez un groupe pour enrichir votre fil.' : 'Le collectif n’a pas encore publié. Une idée, une question ? À vous de lancer la discussion.'} action={feed === 'following' ? <Link className="button button-primary" to="/network">Explorer mon réseau</Link> : undefined} /></div> : posts.data.posts.map((post) => <PostCard key={`${post.id}:${post.like_count}:${post.comment_count}:${post.liked}`} post={post} onDeleted={deleted} />)}
      <PaginationControls data={posts.data} onPage={setPage} />
    </>}
  </div>;
}

function CommunityWorkspace({ groupId, projectId, feed }: { groupId?: string; projectId?: string; feed: 'discovery' | 'following' }) {
  const { user, loading, error: authError } = useAuth();
  const [creating, setCreating] = useState(false);
  const [updatedGroup, setUpdatedGroup] = useState<Group | null>(null);
  const detail = useApi<{ group: Group }>(groupId ? `/community/groups/${encodeURIComponent(groupId)}` : null);
  const group = updatedGroup ?? detail.data?.group;
  return <div className="stack">
    <PageHeader eyebrow="LE COLLECTIF ALPHA" title="Les idées avancent ensemble." description="Rencontrez les bonnes personnes, partagez vos découvertes et construisez la suite, ensemble." action={user ? <button type="button" className="button button-primary" onClick={() => setCreating((value) => !value)} aria-expanded={creating} aria-controls="group-create"><Plus size={18} /> Créer un groupe</button> : !loading ? <Link to="/login" className="button button-primary">Rejoindre le collectif <ArrowRight size={17} /></Link> : undefined} />
    <ErrorState message={authError} />
    <nav className="tabs" aria-label="Communauté">
      <Link className={`tab${!groupId && !projectId && feed === 'discovery' ? ' active' : ''}`} to="/community" aria-current={!groupId && !projectId && feed === 'discovery' ? 'page' : undefined}>Découvrir</Link>
      <Link className={`tab${feed === 'following' ? ' active' : ''}`} to="/community?feed=following" aria-current={feed === 'following' ? 'page' : undefined}>Mon fil</Link>
      <Link className="tab" to="/network">Mon réseau</Link>
      <a className="tab" href="#group-discovery">Les groupes</a>
      {groupId && <span className="tab active">{group?.name ?? 'Le groupe'}</span>}
      {projectId && <span className="tab active">Actualités du projet</span>}
    </nav>
    {creating && user && <div id="group-create"><CreateGroupForm onClose={() => setCreating(false)} /></div>}
    <div className="detail-layout">
      <main className="detail-main stack">
        {groupId ? <>
          <Link className="button button-ghost button-small" to="/community"><ArrowLeft size={15} /> Tout le collectif</Link>
          {detail.loading ? <Loading /> : detail.error ? <div className="stack"><ErrorState message={detail.error} /><button type="button" className="button button-secondary" onClick={detail.reload}>Réessayer</button></div> : group && <><GroupHeader group={group} onChange={setUpdatedGroup} /><Feed group={group} feed={feed} /></>}
        </> : <Feed projectId={projectId} feed={feed} />}
      </main>
      <aside className="detail-aside stack">
        <GroupDiscovery selectedId={groupId} updatedGroup={updatedGroup} />
        <section className="card"><div className="card-body stack"><div className="row gap-sm"><Globe2 size={20} /><h3>Un collectif ouvert</h3></div><p className="small muted">Les groupes et les publications visibles ici sont publics. Les actualités d’un projet devenu privé sont masquées. Partagez vos idées, pas vos informations confidentielles.</p><p className="small muted">Échangez avec respect, donnez du contexte et faites grandir les idées des autres.</p></div></section>
      </aside>
    </div>
  </div>;
}

export default function CommunityPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const [search] = useSearchParams();
  const projectId = id ? undefined : search.get('project') ?? undefined;
  const feed = search.get('feed') === 'following' ? 'following' : 'discovery';
  return <CommunityWorkspace key={`${id ?? 'global'}:${projectId ?? ''}:${feed}:${user?.id ?? 'visitor'}`} groupId={id} projectId={projectId} feed={feed} />;
}
