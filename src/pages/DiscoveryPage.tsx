import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Bookmark, Search } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, LoginNotice, PageHeader, useApi } from '../components/ui';
import BookmarkButton from '../components/BookmarkButton';
import { useAuth } from '../lib/auth';
import { money } from '../lib/api';

type Kind = 'project' | 'campaign' | 'listing' | 'person';
interface Resource { id: string; type: Kind; title: string; summary: string; detail: string; amount_cents: number | null; saved: boolean; href: string }
interface Results { items: Resource[]; total: number; limit: number; offset: number }
const kinds: Record<Kind, string> = { project: 'Projets', campaign: 'Campagnes de test', listing: 'Offres marketplace', person: 'Talents' };
const listingKinds: Record<string, string> = { software: 'Logiciel', component: 'Composant', prototype: 'Prototype', service: 'Service', concept: 'Concept' };

function ResultsPage({ library }: { library: boolean }) {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? 'all';
  const offset = params.get('offset') ?? '0';
  const [draft, setDraft] = useState(q);
  const query = new URLSearchParams({ q, type, offset, limit: '20' });
  const results = useApi<Results>(`/discovery/${library ? 'bookmarks' : 'search'}?${query}`);
  const update = (values: Record<string, string>) => setParams({ q, type, offset: '0', ...values });
  function search(event: FormEvent) { event.preventDefault(); update({ q: draft.trim() }); }
  return <div className="stack">
    <PageHeader eyebrow={library ? 'Votre bibliothèque privée' : 'Explorer Alpha'} title={library ? 'À retrouver, à votre rythme.' : 'Une recherche, toutes les possibilités.'}
      description={library ? 'Gardez les projets, campagnes et offres qui vous intéressent. Vos favoris ne sont pas communiqués aux autres membres.' : 'Découvrez les projets publics, les campagnes de test, les offres et les talents du collectif.'}
      action={<Link className="button button-secondary" to={library ? '/search' : '/library'}>{library ? <Search size={16} /> : <Bookmark size={16} />}{library ? 'Explorer Alpha' : 'Mes favoris'}</Link>} />
    <form className="filters" onSubmit={search}>
      <label className="field full-width">Rechercher {library ? 'dans mes favoris' : 'sur Alpha'}<input type="search" maxLength={120} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Un projet, une compétence, une idée…" /></label>
      <button className="button button-primary" type="submit"><Search size={16} /> Rechercher</button>
    </form>
    <nav className="tabs" aria-label="Types de résultats">
      <button className={`tab ${type === 'all' ? 'active' : ''}`} onClick={() => update({ type: 'all' })} aria-pressed={type === 'all'}>Tout</button>
      {(Object.entries(kinds) as [Kind, string][]).filter(([kind]) => !library || kind !== 'person').map(([kind, label]) =>
        <button className={`tab ${type === kind ? 'active' : ''}`} key={kind} aria-pressed={type === kind} onClick={() => update({ type: kind })}>{label}</button>)}
    </nav>
    {library && <p className="small muted">Seules les ressources encore publiques et les offres actives sont affichées et comptées. Un favori ne donne aucun accès privé et ne réserve ni une place de test ni un achat.</p>}
    {results.loading ? <Loading /> : results.error ? <div className="stack"><ErrorState message={results.error} />
      <button className="button button-secondary" type="button" onClick={results.reload}>Réessayer</button></div> : results.data && <>
      <p className="muted" role="status">{results.data.total} résultat{results.data.total !== 1 ? 's' : ''}</p>
      {!results.data.items.length ? <EmptyState title={library ? 'Aucun favori visible avec ces filtres' : 'Aucun résultat avec ces filtres'}
        description={library ? 'Enregistrez une ressource depuis sa fiche ou la recherche pour la retrouver ici.' : 'Essayez un autre mot-clé ou un autre type de ressource.'} /> :
        <div className="card-grid">{results.data.items.map((item) => <article className="card card-body stack" key={`${item.type}:${item.id}`} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <div><Badge tone="purple">{kinds[item.type]}</Badge></div>
          <h2><Link to={item.href}>{item.title}</Link></h2>
          <p className="muted">{item.summary}</p>
          {item.detail && <p className="small">{item.type === 'listing' ? listingKinds[item.detail] ?? item.detail : item.type === 'campaign' ? item.detail === 'open' ? 'Campagne ouverte · consultez son échéance et les places restantes' : 'Campagne fermée' : item.detail}</p>}
          {item.amount_cents !== null && <p><strong>{money(item.amount_cents)}</strong> {item.type === 'campaign' ? 'de récompense simulée' : 'en simulation'}</p>}
          <div className="row-between" style={{ flexWrap: 'wrap', gap: 12 }}>
            <Link to={item.href}>Découvrir <ArrowUpRight size={14} /></Link>
            {item.type !== 'person' && <BookmarkButton targetType={item.type} targetId={item.id} initialSaved={item.saved} onChange={library ? results.reload : undefined} />}
          </div>
        </article>)}</div>}
      {(results.data.total > results.data.limit || results.data.offset > 0) && <nav className="row-between" aria-label="Pagination des résultats">
        <button className="button button-secondary" disabled={!results.data.offset} onClick={() => update({ offset: String(Math.max(0, results.data!.offset - results.data!.limit)) })}>Précédent</button>
        <span className="small">Page {Math.floor(results.data.offset / results.data.limit) + 1}</span>
        <button className="button button-secondary" disabled={results.data.offset + results.data.limit >= results.data.total} onClick={() => update({ offset: String(results.data!.offset + results.data!.limit) })}>Suivant</button>
      </nav>}
    </>}
  </div>;
}

export default function DiscoveryPage({ library = false }: { library?: boolean }) {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  if (library && loading) return <Loading />;
  if (library && !user) return <LoginNotice />;
  return <ResultsPage key={`${library}:${params.get('q') ?? ''}`} library={library} />;
}
