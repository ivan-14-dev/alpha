import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BadgeCheck, MessageSquarePlus, Search, Star } from 'lucide-react';
import { Avatar, Badge, DemoNotice, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { ReputationDetails, type ReputationSummary } from '../components/ReputationHighlights';
import { api, date, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface PublicUser {
  id: string;
  name: string;
  title: string;
  avatar_color: string;
}

interface Pagination {
  offset: number;
  limit: number;
  total: number;
  has_more: boolean;
}

interface Review {
  id: string;
  subject_id: string;
  rating: number;
  communication_rating: number | null;
  quality_rating: number | null;
  reviewed_role: 'tester' | 'owner';
  body: string;
  created_at: string;
  verified: boolean;
  author: PublicUser;
}

interface EligibleMission {
  id: string;
  created_at: string;
  reviewer_role: 'tester' | 'owner';
  subject: PublicUser;
}

function Stars({ rating }: { rating: number }) {
  return <span className="row gap-sm" role="img" aria-label={`${rating} étoile${rating > 1 ? 's' : ''} sur 5`}>
    {[1, 2, 3, 4, 5].map((value) => <Star key={value} size={16} aria-hidden="true" fill={value <= rating ? 'currentColor' : 'none'} />)}
  </span>;
}

function PageControls({ pagination, onChange }: { pagination: Pagination; onChange: (offset: number) => void }) {
  if (pagination.total <= pagination.limit) return null;
  return <nav className="row row-between" aria-label="Pagination">
    <button type="button" className="button button-secondary button-small" disabled={pagination.offset === 0} onClick={() => onChange(Math.max(0, pagination.offset - pagination.limit))}>
      <ArrowLeft size={16} aria-hidden="true" /> Précédent
    </button>
    <span className="small muted">Page {Math.floor(pagination.offset / pagination.limit) + 1} sur {Math.ceil(pagination.total / pagination.limit)}</span>
    <button type="button" className="button button-secondary button-small" disabled={!pagination.has_more} onClick={() => onChange(pagination.offset + pagination.limit)}>
      Suivant <ArrowRight size={16} aria-hidden="true" />
    </button>
  </nav>;
}

function ReceivedReviews({ userId, own }: { userId: string; own: boolean }) {
  const [rating, setRating] = useState('');
  const [role, setRole] = useState('');
  const [offset, setOffset] = useState(0);
  const summary = useApi<{
    user: PublicUser;
    summary: ReputationSummary;
  }>(`/reputation/summary?user=${encodeURIComponent(userId)}`);
  const reviews = useApi<{ user: PublicUser; reviews: Review[]; pagination: Pagination }>(
    `/reputation/reviews?user=${encodeURIComponent(userId)}&offset=${offset}${rating ? `&rating=${rating}` : ''}${role ? `&role=${role}` : ''}`,
  );

  return <section className="stack" aria-label="Avis reçus">
    {summary.loading ? <Loading /> : summary.error ? <div className="stack">
      <ErrorState message={summary.error} />
      <button type="button" className="button button-secondary" onClick={summary.reload}>Réessayer le résumé</button>
    </div> : summary.data && <div className="card">
      <div className="card-header">
        <div className="row gap-sm">
          <Avatar name={summary.data.user.name} color={summary.data.user.avatar_color} size="large" />
          <div><h2>{own ? 'Mes avis reçus' : `Avis reçus par ${summary.data.user.name}`}</h2><p className="muted">{summary.data.user.name}{summary.data.user.title ? ` · ${summary.data.user.title}` : ''}</p></div>
        </div>
        <Badge tone="green"><BadgeCheck size={14} aria-hidden="true" /> Collaborations vérifiées</Badge>
      </div>
      <div className="card-body two-column">
        <div>
          <p className="stat-label">Moyenne subjective des avis de collaboration</p>
          <p className="stat-value">{summary.data.summary.average === null ? '—' : summary.data.summary.average.toLocaleString('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}<span className="small muted"> / 5</span></p>
          <p className="muted">{summary.data.summary.count} avis reçu{summary.data.summary.count > 1 ? 's' : ''}</p>
          {summary.data.summary.count === 0 && <p className="small muted">Pas encore de moyenne : aucun avis publié.</p>}
        </div>
        <div className="stack" aria-label="Répartition des notes">
          {summary.data.summary.distribution.map((entry) => <div className="row gap-sm" key={entry.rating}>
            <span className="small">{entry.rating} <Star size={12} aria-hidden="true" /></span>
            <progress className="full-width" value={entry.count} max={summary.data!.summary.count || 1} aria-label={`${entry.rating} étoiles : ${entry.count} avis`} />
            <span className="small">{entry.count}</span>
          </div>)}
        </div>
      </div>
      <div className="card-body stack">
        <p><strong>{summary.data.summary.paid_missions.total}</strong> missions payées en démonstration, tous rôles confondus.</p>
        <ReputationDetails summary={summary.data.summary} />
        <p className="help-text">Ces agrégats incluent les projets privés sans en révéler les détails. L’historique ci-dessous se limite aux projets actuellement publics. Les missions ne sont pas un score de fiabilité ; aucune ponctualité n’est calculée.</p>
      </div>
    </div>}

    <div className="row row-between">
      <h2 className="section-heading">Expériences de collaboration</h2>
      <div className="field">
        <label htmlFor="review-role-filter">Rôle du membre évalué</label>
        <select id="review-role-filter" className="select" value={role} onChange={(event) => { setRole(event.target.value); setOffset(0); }}>
          <option value="">Tous les rôles</option>
          <option value="tester">Testeur ou testeuse</option>
          <option value="owner">Créateur ou créatrice</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="review-rating-filter">Filtrer par note</label>
        <select id="review-rating-filter" className="select" value={rating} onChange={(event) => { setRating(event.target.value); setOffset(0); }}>
          <option value="">Toutes les notes</option>
          {[5, 4, 3, 2, 1].map((value) => <option value={value} key={value}>{value} étoile{value > 1 ? 's' : ''}</option>)}
        </select>
      </div>
    </div>
    {reviews.loading ? <Loading /> : reviews.error ? <div className="stack">
      <ErrorState message={reviews.error} />
      <button type="button" className="button button-secondary" onClick={reviews.reload}>Réessayer les avis</button>
    </div> : reviews.data && <>
      {reviews.data.reviews.length === 0
        ? <EmptyState title={rating || role ? 'Aucun avis avec ces filtres' : 'Aucun avis pour le moment'} description={rating || role ? 'Essayez une autre note, un autre rôle ou affichez tous les avis.' : 'Les avis apparaissent après une mission terminée et son versement de démonstration.'} />
        : <div className="stack">{reviews.data.reviews.map((review) => <article className="card" key={review.id}>
          <div className="card-header">
            <Link className="row gap-sm" to={`/reputation?user=${encodeURIComponent(review.author.id)}`}>
              <Avatar name={review.author.name} color={review.author.avatar_color} />
              <span><strong>{review.author.name}</strong>{review.author.title && <span className="small muted"> · {review.author.title}</span>}</span>
            </Link>
            {review.verified && <Badge tone="green"><BadgeCheck size={14} aria-hidden="true" /> Collaboration vérifiée</Badge>}
          </div>
          <div className="card-body stack">
            <div className="row row-between"><Stars rating={review.rating} /><time className="small muted" dateTime={review.created_at}>{date(review.created_at)}</time></div>
            <p className="small muted">Membre évalué comme {review.reviewed_role === 'tester' ? 'testeur ou testeuse' : 'créateur ou créatrice'}.</p>
            <p className="small">Appréciations subjectives — Communication : {review.communication_rating === null ? 'non renseignée' : `${review.communication_rating}/5`} · Qualité de la contribution : {review.quality_rating === null ? 'non renseignée' : `${review.quality_rating}/5`}</p>
            {review.communication_rating === null && review.quality_rating === null && <p className="help-text">Avis sans critères détaillés : ancien avis ou critères facultatifs laissés vides.</p>}
            <p className="pre-wrap">{review.body}</p>
          </div>
        </article>)}</div>}
      <PageControls pagination={reviews.data.pagination} onChange={setOffset} />
    </>}
  </section>;
}

function ReviewForm({ mission, onClose, onPublished }: { mission: EligibleMission; onClose: () => void; onPublished: () => void }) {
  const [rating, setRating] = useState('');
  const [communication, setCommunication] = useState('');
  const [quality, setQuality] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (!rating || body.trim().length < 10) {
      setError('Choisissez une note et décrivez votre collaboration en au moins 10 caractères.');
      return;
    }
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      await api('/reputation/reviews', { method: 'POST', body: JSON.stringify({
        mission_id: mission.id, rating: Number(rating), body: body.trim(),
        ...(communication ? { communication_rating: Number(communication) } : {}),
        ...(quality ? { quality_rating: Number(quality) } : {}),
      }) });
      onPublished();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <Modal title={`Votre collaboration avec ${mission.subject.name}`} onClose={() => { if (!submitting.current) onClose(); }}>
    <form className="form" onSubmit={submit} aria-busy={pending}>
      <p>Partagez votre appréciation subjective de la collaboration, pas une note du produit. La qualité de la contribution désigne le retour fourni par le testeur ou l’accompagnement du responsable. Aucune rémunération n’est liée à un avis positif.</p>
      <p className="help-text" id="review-privacy">Cet avis sera public avec votre nom. Ne partagez aucun titre de projet confidentiel, contenu de rapport ou donnée privée.</p>
      <div className="field">
        <label htmlFor="review-rating">Votre note globale de collaboration (subjective)</label>
        <select id="review-rating" className="select" value={rating} onChange={(event) => setRating(event.target.value)} required disabled={pending} autoFocus>
          <option value="">Choisir une note</option>
          <option value="1">1 étoile — Très difficile</option>
          <option value="2">2 étoiles — Difficile</option>
          <option value="3">3 étoiles — Correcte</option>
          <option value="4">4 étoiles — Bonne</option>
          <option value="5">5 étoiles — Excellente</option>
        </select>
      </div>
      {([
        ['communication', 'Communication', communication, setCommunication],
        ['quality', 'Qualité de la contribution', quality, setQuality],
      ] as const).map(([field, label, value, setValue]) => <div className="field" key={field}>
        <label htmlFor={`review-${field}`}>{label} — appréciation subjective, facultative</label>
        <select id={`review-${field}`} className="select" value={value} onChange={(event) => setValue(event.target.value)} disabled={pending}>
          <option value="">Non renseignée / pas assez d’éléments</option>
          <option value="1">1 / 5 — Très insatisfaisante</option>
          <option value="2">2 / 5 — Insatisfaisante</option>
          <option value="3">3 / 5 — Correcte</option>
          <option value="4">4 / 5 — Bonne</option>
          <option value="5">5 / 5 — Excellente</option>
        </select>
      </div>)}
      <div className="field">
        <label htmlFor="review-body">Votre expérience de collaboration</label>
        <textarea id="review-body" className="textarea" value={body} onChange={(event) => setBody(event.target.value)} required minLength={10} maxLength={2000} rows={5} disabled={pending} aria-describedby="review-privacy review-body-help" />
        <span className="help-text" id="review-body-help">10 à 2 000 caractères · {body.length}/2 000. Un seul avis par personne et par mission.</span>
      </div>
      <ErrorState message={error} />
      <div className="row gap-sm">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={pending}>Annuler</button>
        <button type="submit" className="button button-primary" disabled={pending}>{pending ? 'Publication en cours…' : 'Publier mon avis public'}</button>
      </div>
    </form>
  </Modal>;
}

function EligibleReviews({ onPublished }: { onPublished: () => void }) {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<EligibleMission | null>(null);
  const [success, setSuccess] = useState('');
  const eligible = useApi<{ missions: EligibleMission[]; pagination: Pagination }>(`/reputation/eligible?offset=${offset}`);

  function published() {
    setSelected(null);
    setSuccess('Votre avis de collaboration a été publié. Merci pour votre retour sincère.');
    if (offset > 0) setOffset(0);
    else eligible.reload();
    onPublished();
  }

  return <section className="card" aria-labelledby="eligible-reviews-heading">
    <div className="card-header"><div><h2 id="eligible-reviews-heading">Partager mon expérience</h2><p className="muted">Vos missions dont le versement de démonstration est confirmé, sans avis de votre part.</p></div></div>
    <div className="card-body stack">
      <DemoNotice />
      {success && <div className="alert alert-success" role="status">{success}</div>}
      {eligible.loading ? <Loading /> : eligible.error ? <div className="stack">
        <ErrorState message={eligible.error} />
        <button type="button" className="button button-secondary" onClick={eligible.reload}>Réessayer les missions</button>
      </div> : eligible.data && <>
        {eligible.data.missions.length === 0
          ? <EmptyState title="Aucune mission à évaluer" description="Une mission devient éligible après son versement de démonstration. Les missions déjà évaluées ne figurent plus ici." />
          : <ul className="list">{eligible.data.missions.map((mission) => <li className="list-item" key={mission.id}>
            <div className="row gap-sm">
              <Avatar name={mission.subject.name} color={mission.subject.avatar_color} />
              <div><Link to={`/reputation?user=${encodeURIComponent(mission.subject.id)}`}><strong>{mission.subject.name}</strong></Link>
                <p className="small muted">{mission.reviewer_role === 'tester' ? 'Responsable de campagne' : 'Testeur ou testeuse'} · mission du {date(mission.created_at)}</p>
                <p className="small muted">Référence : {mission.id}</p>
              </div>
            </div>
            <button type="button" className="button button-secondary button-small" onClick={() => { setSuccess(''); setSelected(mission); }} aria-label={`Évaluer la collaboration avec ${mission.subject.name}`}>
              <MessageSquarePlus size={16} aria-hidden="true" /> Donner un avis
            </button>
          </li>)}</ul>}
        <PageControls pagination={eligible.data.pagination} onChange={setOffset} />
      </>}
    </div>
    {selected && <ReviewForm key={selected.id} mission={selected} onClose={() => setSelected(null)} onPublished={published} />}
  </section>;
}

function PublicHistory({ userId }: { userId: string }) {
  const [offset, setOffset] = useState(0);
  const [role, setRole] = useState('');
  const history = useApi<{
    history: { project_id: string; project_title: string; role: 'tester' | 'owner'; completed_at: string }[];
    pagination: Pagination;
  }>(`/reputation/history?user=${encodeURIComponent(userId)}&offset=${offset}${role ? `&role=${role}` : ''}`);
  return <section className="card" aria-labelledby="public-history-heading">
    <div className="card-header">
      <div><h2 id="public-history-heading">Historique public des collaborations</h2><p className="muted">Missions payées en démonstration sur des projets actuellement publics uniquement.</p></div>
      <div className="field">
        <label htmlFor="history-role-filter">Rôle dans la collaboration</label>
        <select id="history-role-filter" className="select" value={role} onChange={(event) => { setRole(event.target.value); setOffset(0); }}>
          <option value="">Tous les rôles</option>
          <option value="tester">Testeur ou testeuse</option>
          <option value="owner">Créateur ou créatrice</option>
        </select>
      </div>
    </div>
    <div className="card-body stack">
      {history.loading ? <Loading /> : history.error ? <>
        <ErrorState message={history.error} />
        <button type="button" className="button button-secondary" onClick={history.reload}>Réessayer l’historique</button>
      </> : history.data && <>
        {history.data.history.length === 0
          ? <EmptyState title="Aucune collaboration publique à afficher" description="Cet historique ne révèle aucune mission sur un projet privé. Chaque ligne représente une mission payée en démo, pas nécessairement un projet distinct." />
          : <ul className="list">{history.data.history.map((entry, index) => <li className="list-item" key={`${offset + index}-${entry.project_id}`}>
            <div><Link to={`/projects/${encodeURIComponent(entry.project_id)}`}><strong>{entry.project_title}</strong></Link>
              <p className="small muted">{entry.role === 'tester' ? 'Testeur ou testeuse' : 'Créateur ou créatrice'} · terminée le <time dateTime={entry.completed_at}>{date(entry.completed_at)}</time></p>
            </div>
          </li>)}</ul>}
        <PageControls pagination={history.data.pagination} onChange={setOffset} />
      </>}
    </div>
  </section>;
}

export default function ReputationPage() {
  const { user, loading, error: authError } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedUser = searchParams.get('user');
  const userId = requestedUser ?? user?.id;
  const [lookup, setLookup] = useState(requestedUser ?? '');
  const [revision, setRevision] = useState(0);
  useEffect(() => { setLookup(requestedUser ?? ''); }, [requestedUser]);

  function findUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearchParams({ user: lookup.trim() });
  }

  return <div className="stack">
    <PageHeader eyebrow="La confiance se construit ensemble" title="Avis & réputation" description="Des retours sincères sur la collaboration entre les participants à une mission, jamais une note sur la qualité d’un produit." />
    <div className="alert">
      <strong><BadgeCheck size={16} aria-hidden="true" /> Que signifie « vérifiée » ?</strong>
      <p>Seuls les deux participants peuvent publier après une mission au statut payé, en mode démonstration, sans argent réel. Le badge confirme cette collaboration, pas l’exactitude d’une opinion. Aucun avis positif n’est acheté ni exigé pour être rémunéré.</p>
    </div>
    <form className="filters" onSubmit={findUser}>
      <div className="field">
        <label htmlFor="reputation-user">Consulter les avis publics d’un membre</label>
        <input id="reputation-user" className="input" placeholder="Identifiant du membre" value={lookup} onChange={(event) => setLookup(event.target.value)} required maxLength={128} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" />
      </div>
      <button type="submit" className="button button-secondary"><Search size={16} aria-hidden="true" /> Voir les avis</button>
      {user && <Link className="button button-ghost" to="/reputation">Mes avis reçus</Link>}
    </form>
    {authError && <ErrorState message={authError} />}
    {userId !== undefined
      ? <div className="stack" key={`${userId}-${revision}`}><ReceivedReviews userId={userId} own={userId === user?.id} /><PublicHistory userId={userId} /></div>
      : loading ? <Loading />
        : <EmptyState title="Les avis sont publics" description="Indiquez l’identifiant d’un membre pour consulter ses avis sans vous connecter, ou connectez-vous pour retrouver les vôtres." />}
    {user ? <EligibleReviews key={user.id} onPublished={() => setRevision((value) => value + 1)} /> : !loading && <LoginNotice />}
  </div>;
}
