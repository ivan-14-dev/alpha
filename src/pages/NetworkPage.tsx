import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Compass, Rss, Users } from 'lucide-react';
import { Avatar, EmptyState, ErrorState, Loading, LoginNotice, PageHeader, useApi } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Followed { id: string; title: string; followers: number; followed_at: string }
interface Person extends Followed { name: string; avatar_color: string }
interface Project extends Followed { summary: string; category: string; color: string }
interface FollowingList {
  items: (Person | Project)[]; total: number; page: number; page_size: number; has_more: boolean;
}

function Following({ type }: { type: 'users' | 'projects' }) {
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const result = useApi<FollowingList>(`/network/following?${new URLSearchParams({ type, page: String(page), page_size: '12' })}`);

  async function remove(targetId: string) {
    if (pending) return;
    setPending(targetId); setError('');
    try {
      await api(`/network/${type}/${encodeURIComponent(targetId)}/follow`, { method: 'DELETE' });
      if (result.data?.items.length === 1 && page > 1) setPage(page - 1);
      else result.reload();
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(null); }
  }

  return <section className="stack" aria-label={type === 'users' ? 'Membres suivis' : 'Projets suivis'}>
    <ErrorState message={error} />
    {result.loading ? <Loading /> : result.error ? <><ErrorState message={result.error} /><button className="button button-secondary" onClick={result.reload}>Réessayer</button></> : result.data && <>
      <p className="small muted">{result.data.total} {type === 'users' ? 'membre(s) suivi(s)' : 'projet(s) public(s) suivi(s)'}</p>
      {result.data.items.length ? <div className="card-grid">{result.data.items.map((item) => {
        const person = 'name' in item;
        const href = person ? `/people/${item.id}` : `/projects/${item.id}`;
        return <article className="card" key={item.id}>
          <div className="card-body stack">
            <div className="row gap-sm"><Avatar name={person ? item.name : item.title} color={person ? item.avatar_color : item.color} /><div>
              <h2><Link to={href}>{person ? item.name : item.title}</Link></h2>
              <p className="small muted">{person ? item.title : item.category}</p>
            </div></div>
            {!person && <p style={{ overflowWrap: 'anywhere' }}>{item.summary}</p>}
            <span className="small muted">{item.followers} abonné{item.followers > 1 ? 's' : ''}</span>
            <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
              <Link className="button button-ghost button-small" to={href}>Découvrir <ArrowRight size={15} /></Link>
              {!person && <Link className="button button-ghost button-small" to={`/community?project=${item.id}`}>Actualités</Link>}
              <button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => void remove(item.id)}>{pending === item.id ? 'Mise à jour…' : 'Ne plus suivre'}</button>
            </div>
          </div>
        </article>;
      })}</div> : <div className="card"><EmptyState title={type === 'users' ? 'Votre réseau commence par une rencontre' : 'Suivez les projets qui vous inspirent'} description="Depuis une fiche publique, choisissez Suivre pour retrouver ses publications dans votre fil." action={<Link className="button button-primary" to={type === 'users' ? '/people' : '/projects'}><Compass size={17} /> Explorer</Link>} /></div>}
      {(page > 1 || result.data.has_more) && <nav className="row row-between" aria-label="Pagination du réseau">
        <button type="button" className="button button-secondary button-small" disabled={page <= 1} onClick={() => setPage(page - 1)}><ArrowLeft size={15} /> Précédent</button>
        <span className="small muted">Page {page} sur {Math.max(1, Math.ceil(result.data.total / result.data.page_size))}</span>
        <button type="button" className="button button-secondary button-small" disabled={!result.data.has_more} onClick={() => setPage(page + 1)}>Suivant <ArrowRight size={15} /></button>
      </nav>}
    </>}
  </section>;
}

export default function NetworkPage() {
  const { user, loading, error } = useAuth();
  const [search] = useSearchParams();
  const type = search.get('type') === 'projects' ? 'projects' : 'users';
  return <div className="stack">
    <PageHeader eyebrow="VOTRE RÉSEAU" title="Gardez le lien avec les bonnes idées." description="Retrouvez les membres et les projets publics que vous suivez." action={<Link className="button button-primary" to="/community?feed=following"><Rss size={17} /> Mon fil</Link>} />
    <ErrorState message={error} />
    <nav className="tabs" aria-label="Votre réseau">
      <Link to="/network?type=users" className={`tab${type === 'users' ? ' active' : ''}`} aria-current={type === 'users' ? 'page' : undefined}><Users size={16} /> Membres suivis</Link>
      <Link to="/network?type=projects" className={`tab${type === 'projects' ? ' active' : ''}`} aria-current={type === 'projects' ? 'page' : undefined}>Projets suivis</Link>
    </nav>
    <div className="row gap-sm" style={{ flexWrap: 'wrap' }}><Link to="/people" className="button button-ghost button-small">Rencontrer des membres <ArrowRight size={15} /></Link><Link to="/projects" className="button button-ghost button-small">Explorer les projets <ArrowRight size={15} /></Link><Link to="/community" className="button button-ghost button-small">Découvrir le collectif</Link></div>
    {loading ? <Loading /> : user ? <Following key={`${user.id}:${type}`} type={type} /> : <div className="card"><LoginNotice /></div>}
    <p className="small muted">Les projets devenus privés n’apparaissent pas ici. Actualisez votre fil pour consulter les nouvelles publications.</p>
  </div>;
}
