import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Archive, Check, Code2, LockKeyhole, Package, Plus, Search, ShieldCheck, ShoppingBag } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, ApiError, date, errorMessage, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import BookmarkButton from '../components/BookmarkButton';
import CheckoutDialog from '../components/CheckoutDialog';
import FileAttachments from '../components/FileAttachments';
import { modeLabels, PaymentModeBanner, usePaymentMode, type PaymentMode } from '../components/CheckoutStatus';

const categories = {
  software: 'Logiciels',
  component: 'Composants',
  prototype: 'Prototypes',
  service: 'Services',
  concept: 'Concepts',
};
type Kind = keyof typeof categories;
interface Listing {
  id: string; seller_id: string; title: string; description: string; kind: Kind;
  price_cents: number; license: string; deliverables: string; status: 'active' | 'archived';
  seller_name: string; seller_color: string; project_id: string | null; project_title: string | null;
  terms_locked: number; created_at: string;
}
interface Order {
  id: string; listing_id: string; buyer_id: string; seller_id: string; price_cents: number;
  status: 'paid' | 'delivered' | 'completed' | 'disputed' | 'refunded'; delivery_text: string;
  listing_title: string; kind: Kind; license: string; deliverables: string; created_at: string;
  buyer_name: string; seller_name: string; version: number; revision_requested: number; payment_mode?: PaymentMode;
}
interface OrderEvent {
  id: string; kind: 'purchased' | 'delivered' | 'revision_requested' | 'completed' | 'disputed' | 'resumed' | 'legacy_delivery' | 'refunded';
  body: string; order_version: number; created_at: string | null;
}
const eventLabels: Record<OrderEvent['kind'], string> = {
  purchased: 'Achat de démonstration',
  delivered: 'Livraison privée',
  revision_requested: 'Corrections demandées',
  completed: 'Livraison acceptée · vente démo enregistrée',
  disputed: 'Commande suspendue pour litige',
  resumed: 'Reprise après modération',
  legacy_delivery: 'Livraison historique',
  refunded: 'Remboursement',
};
const realEventLabels: Partial<Record<OrderEvent['kind'], string>> = {
  purchased: 'Achat payé · fonds en séquestre',
  completed: 'Livraison acceptée · paiement versé au vendeur',
};
const orderStates: Record<Order['status'], string> = {
  paid: 'À livrer · achat démo',
  delivered: 'Livrée · à vérifier',
  completed: 'Terminée',
  disputed: 'En litige',
  refunded: 'Remboursée · démo',
};
const realOrderStates: Record<Order['status'], string> = {
  paid: 'À livrer · payée (séquestre)',
  delivered: 'Livrée · à vérifier',
  completed: 'Terminée · paiement versé',
  disputed: 'En litige · fonds bloqués',
  refunded: 'Remboursée',
};
const isRealOrder = (order: Order) => !!order.payment_mode && order.payment_mode !== 'demo';
const orderState = (order: Order) => (isRealOrder(order) ? realOrderStates : orderStates)[order.status];
const orderKind = (order: Order, seller: boolean) => isRealOrder(order) ? `${seller ? 'Vente' : 'Achat'} · ${modeLabels[order.payment_mode!].toLowerCase()}` : seller ? 'Vente démo' : 'Achat démo';
const orderPrice = (order: Order) => isRealOrder(order) ? money(order.price_cents) : `${money(order.price_cents)} · démo`;

function RightsNotice() {
  return <div className="alert small"><ShieldCheck size={18} aria-hidden="true" /> Toutes les offres sont non exclusives en V1 : aucun transfert exclusif de propriété intellectuelle. Un concept n’est pas automatiquement protégé par sa publication. Le vendeur doit disposer des droits nécessaires.</div>;
}

function Pagination({ offset, total, onChange }: { offset: number; total: number; onChange: (offset: number) => void }) {
  if (total <= 24) return null;
  return <nav className="row row-between" aria-label="Pagination">
    <button className="button button-secondary" type="button" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - 24))}>Précédent</button>
    <span className="muted small">{offset + 1}–{Math.min(offset + 24, total)} sur {total}</span>
    <button className="button button-secondary" type="button" disabled={offset + 24 >= total || offset + 24 > 10000} onClick={() => onChange(offset + 24)}>Suivant</button>
  </nav>;
}

function ListingForm({ listing, onSaved, onClose }: { listing?: Listing; onSaved: (listing: Listing) => void; onClose: () => void }) {
  const platformMode = usePaymentMode();
  const realPayments = !!platformMode && platformMode !== 'demo';
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const projects = useApi<{ projects: { id: string; title: string }[] }>('/marketplace/projects');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const price = String(form.get('price')).replace(',', '.');
    if (!/^\d+(?:\.\d{1,2})?$/.test(price)) { setError('Saisissez un prix positif avec deux décimales au maximum.'); return; }
    const [euros, decimals = ''] = price.split('.');
    const cents = Number(euros) * 100 + Number(decimals.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents < 1 || cents > 10000000) { setError('Le prix doit être compris entre 0,01 € et 100 000 €.'); return; }
    setPending(true); setError('');
    try {
      const payload = {
        title: form.get('title'), description: form.get('description'), kind: form.get('kind'),
        price_cents: cents, license: form.get('license'), deliverables: form.get('deliverables'),
        project_id: form.get('project_id') || null,
      };
      const result = await api<{ listing: Listing }>(listing ? `/marketplace/listings/${listing.id}` : '/marketplace/listings', {
        method: listing ? 'PATCH' : 'POST', body: JSON.stringify(payload),
      });
      onSaved(result.listing);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }

  return <Modal title={listing ? 'Modifier l’offre' : 'Publier une offre'} onClose={() => { if (!pending) onClose(); }}>
    <form className="form" onSubmit={submit}>
      <PaymentModeBanner mode={platformMode} compact />
      <RightsNotice />
      <ErrorState message={error} />
      <div className="form-grid">
        <label className="field full-width">Titre<input name="title" required minLength={3} maxLength={160} defaultValue={listing?.title} placeholder="Un composant prêt pour votre prochain projet" /></label>
        <label className="field">Catégorie<select name="kind" defaultValue={listing?.kind ?? 'software'}>{Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="field">{realPayments ? 'Prix (€)' : 'Prix démo (€)'}<input name="price" type="number" step="0.01" min="0.01" max="100000" required defaultValue={listing ? (listing.price_cents / 100).toFixed(2) : ''} placeholder="49,00" /></label>
        <label className="field full-width">Description<textarea name="description" rows={4} required minLength={20} maxLength={10000} defaultValue={listing?.description} placeholder="Présentez les usages, les prérequis et les limites de votre offre." /></label>
        <label className="field full-width">Livrables inclus<textarea name="deliverables" rows={3} required minLength={10} maxLength={5000} defaultValue={listing?.deliverables} placeholder="Précisez le contenu, le format et le délai de livraison." /></label>
        <label className="field full-width">Conditions d’utilisation — licence non exclusive<textarea name="license" rows={3} required minLength={10} maxLength={5000} defaultValue={listing?.license} placeholder="Usages autorisés, modifications, attribution, redistribution et limites." /></label>
        <label className="field full-width">Projet public associé (facultatif)<select name="project_id" defaultValue={listing?.project_id ?? ''} disabled={projects.loading || !!projects.error}>
          <option value="">Aucun projet</option>
          {listing?.project_id && !projects.data?.projects.some((project) => project.id === listing.project_id) && <option value={listing.project_id}>{listing.project_title}</option>}
          {projects.data?.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select><span className="help-text">Seuls les projets publics que vous gérez peuvent être associés.</span></label>
      </div>
      {projects.loading && <Loading />}
      {projects.error && <div className="stack"><ErrorState message={projects.error} /><button type="button" className="button button-secondary" onClick={projects.reload}>Réessayer les projets</button></div>}
      <label className="row small"><input type="checkbox" required /> Je dispose des droits sur ces livrables et propose une licence non exclusive.</label>
      <p className="help-text">Dès la première commande, le prix, les livrables et les conditions seront figés pour préserver l’accord. Vous pourrez archiver cette offre et en créer une nouvelle.</p>
      <button className="button button-primary" disabled={pending || projects.loading || !!projects.error} type="submit">{pending ? 'Enregistrement…' : listing ? 'Enregistrer les modifications' : 'Publier l’offre démo'}</button>
    </form>
  </Modal>;
}

function ListingCard({ listing, realPayments = false }: { listing: Listing; realPayments?: boolean }) {
  return <article className="card">
    <div className="card-body stack">
      <div className="row row-between"><span className="project-icon"><Code2 size={26} /></span><Badge tone={listing.status === 'active' ? 'purple' : 'neutral'}>{listing.status === 'archived' ? 'Archivée' : categories[listing.kind]}</Badge></div>
      <div><h3><Link to={`/marketplace/${listing.id}`}>{listing.title}</Link></h3><p className="muted">{listing.description.length > 155 ? `${listing.description.slice(0, 155)}…` : listing.description}</p></div>
      <div className="row gap-sm"><Avatar name={listing.seller_name} color={listing.seller_color} size="small" /><span className="small">{listing.seller_name}</span></div>
      <div className="row row-between"><strong className="price">{money(listing.price_cents)}{!realPayments && <> <span className="small muted">démo</span></>}</strong><Link className="button button-ghost button-small" to={`/marketplace/${listing.id}`}>Voir l’offre <ArrowUpRight size={16} /></Link></div>
      <span className="help-text">Licence non exclusive · livraison privée</span>
    </div>
  </article>;
}

function OrderCard({ order, userId }: { order: Order; userId: string }) {
  const seller = order.seller_id === userId;
  return <article className="card card-body stack">
    <div className="row row-between"><div><span className="eyebrow">{orderKind(order, seller)}</span><h3><Link to={`/marketplace?view=orders&order=${order.id}`}>{order.listing_title}</Link></h3></div><Badge tone={order.status === 'completed' ? 'green' : order.status === 'disputed' ? 'orange' : 'blue'}>{order.status === 'paid' && order.revision_requested ? 'Corrections attendues' : orderState(order)}</Badge></div>
    <div className="row row-between"><span className="muted small">{seller ? `Acheteur : ${order.buyer_name}` : `Vendeur : ${order.seller_name}`} · {date(order.created_at)}</span><strong>{orderPrice(order)}</strong></div>
    <Link className="button button-secondary" to={`/marketplace?view=orders&order=${order.id}`}>Ouvrir la commande et son historique privé <ArrowUpRight size={16} /></Link>
  </article>;
}

function OrderHistory({ orderId, real = false }: { orderId: string; real?: boolean }) {
  const [offset, setOffset] = useState(0);
  const history = useApi<{ events: OrderEvent[]; total: number }>(`/marketplace/orders/${encodeURIComponent(orderId)}/history?limit=24&offset=${offset}`);
  return <section className="card card-body stack">
    <h2>Historique privé</h2>
    <p className="help-text">Du plus récent au plus ancien. Les livraisons précédentes restent consultables ; elles ne remplacent pas une correction attendue.</p>
    {history.loading ? <Loading /> : history.error ? <><ErrorState message={history.error} /><button className="button button-secondary" type="button" onClick={history.reload}>Réessayer l’historique</button></> : history.data && <>
      {history.data.events.length ? history.data.events.map((event) => <article className="message-bubble" key={event.id}>
        <h3>{(real && realEventLabels[event.kind]) || eventLabels[event.kind] || event.kind}</h3>
        <p className="small muted">Version {event.order_version} · {event.created_at === null ? 'Date inconnue · livraison antérieure au suivi historique' : date(event.created_at)}</p>
        {event.body && <p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{event.body}</p>}
      </article>) : <p className="muted">Aucun événement enregistré pour cette commande historique.</p>}
      <Pagination offset={offset} total={history.data.total} onChange={setOffset} />
    </>}
  </section>;
}

function OrderDetail({ orderId, userId }: { orderId: string; userId: string }) {
  const detail = useApi<{ order: Order }>(`/marketplace/orders/${encodeURIComponent(orderId)}`);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [dispute, setDispute] = useState(false);
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  const [deliveryDraft, setDeliveryDraft] = useState('');
  const [revisionDraft, setRevisionDraft] = useState('');
  const [disputeDraft, setDisputeDraft] = useState('');
  const order = detail.data?.order;
  const seller = order?.seller_id === userId;

  useEffect(() => {
    if (detail.data) { setStale(false); setError(''); }
  }, [detail.data]);

  function reload() {
    setAcceptedVersion(null);
    detail.reload();
  }

  async function action(endpoint: 'deliver' | 'request-revision' | 'complete' | 'dispute') {
    if (!order || pending || stale || (endpoint === 'complete' && acceptedVersion !== order.version)) return;
    const body = endpoint === 'dispute' ? { reason: disputeDraft } : {
      version: order.version,
      ...(endpoint === 'deliver' ? { delivery_text: deliveryDraft } : endpoint === 'request-revision' ? { note: revisionDraft } : {}),
    };
    setPending(true); setError('');
    try {
      await api(`/marketplace/orders/${encodeURIComponent(order.id)}/${endpoint}`, { method: 'POST', body: JSON.stringify(body) });
      if (endpoint === 'deliver') setDeliveryDraft('');
      if (endpoint === 'request-revision') setRevisionDraft('');
      if (endpoint === 'dispute') setDisputeDraft('');
      setDispute(false); reload();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) { setStale(true); setAcceptedVersion(null); }
    }
    finally { setPending(false); }
  }

  return <section className="stack">
    <Link className="button button-ghost" to="/marketplace?view=orders"><ArrowLeft size={16} />Toutes mes commandes</Link>
    <ErrorState message={error} />
    {stale && <div className="alert stack" role="status"><p>L’état de la commande doit être vérifié avant une nouvelle action. Vos brouillons sont conservés.</p><button className="button button-secondary" type="button" disabled={detail.loading} onClick={reload}>Recharger la commande · conserver les brouillons</button></div>}
    {detail.loading ? <Loading /> : detail.error ? <><ErrorState message={detail.error} /><button className="button button-secondary" type="button" onClick={reload}>Réessayer la commande</button></> : order && <>
    <article className="card card-body stack">
    <div className="row row-between"><div><span className="eyebrow">{orderKind(order, seller)} · version {order.version}</span><h2>{order.listing_title}</h2><Link to={`/marketplace/${order.listing_id}`}>Consulter l’offre et les conditions figées</Link></div><Badge tone={order.status === 'completed' ? 'green' : order.status === 'disputed' ? 'orange' : 'blue'}>{order.status === 'paid' && order.revision_requested ? 'Corrections attendues' : orderState(order)}</Badge></div>
    <div className="row row-between"><span className="muted small">{seller ? `Acheteur : ${order.buyer_name}` : `Vendeur : ${order.seller_name}`} · {date(order.created_at)}</span><strong>{orderPrice(order)}</strong></div>
    <details><summary>Livrables et droits convenus · non exclusifs</summary><div className="stack small"><p className="pre-wrap"><strong>Livrables</strong>{'\n'}{order.deliverables}</p><p className="pre-wrap"><strong>Conditions d’utilisation</strong>{'\n'}{order.license}</p><p className="muted">Les conditions de l’offre sont figées depuis sa première commande.</p></div></details>
    {!!order.revision_requested && <p className="text-warning">Des corrections sont demandées. L’ancienne livraison reste dans l’historique ; elle ne peut pas être acceptée. Une nouvelle livraison différente est nécessaire.</p>}
    {order.delivery_text && <section className="message-bubble"><h3>{order.revision_requested || order.status === 'paid' ? 'Livraison précédente · non acceptable en l’état' : 'Dernière livraison privée'}</h3><p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{order.delivery_text}</p><span className="help-text">Privée entre participants, consultable par la modération uniquement dans le contexte d’un signalement. Les liens restent du texte : vérifiez leur destination avant de les ouvrir.</span></section>}
    {!['cancelled', 'refunded'].includes(order.status) && <FileAttachments resourceType="order" resourceId={order.id} purpose="listing_delivery" canUpload={seller && order.status === 'paid'} title="Fichiers livrés" />}
    {seller && order.status === 'paid' && <form className="form" onSubmit={(event) => {
      event.preventDefault();
      void action('deliver');
    }}><label className="field">{order.revision_requested ? 'Nouvelle livraison corrigée' : 'Livraison privée à l’acheteur'}<textarea name="delivery_text" minLength={10} maxLength={20000} rows={4} required value={deliveryDraft} onChange={(event) => setDeliveryDraft(event.target.value)} placeholder="Livrables, accès et instructions. N’incluez pas de mot de passe personnel." /></label><p className="help-text">Consultez les consignes dans l’historique. Une correction doit changer le contenu, pas seulement les espaces. Chaque livraison est conservée ; {isRealOrder(order) ? 'le paiement (en séquestre) vous est versé à l’acceptation explicite de l’acheteur, frais de plateforme déduits' : 'le gain démo attend l’acceptation explicite de l’acheteur'}.</p><button className="button button-primary" type="submit" disabled={pending || stale}><Package size={16} />{pending ? 'Envoi…' : order.revision_requested ? 'Envoyer la livraison corrigée' : 'Envoyer la livraison'}</button></form>}
    {!seller && order.status === 'paid' && <p className="muted">{order.revision_requested ? 'Le vendeur doit corriger et soumettre une nouvelle livraison.' : 'Le vendeur prépare votre livraison.'} {isRealOrder(order) ? 'Votre paiement est conservé en séquestre jusqu’à votre acceptation.' : 'Aucun argent réel n’a été débité.'}</p>}
    {!seller && order.status === 'delivered' && <>
      <form className="form" onSubmit={(event) => { event.preventDefault(); void action('request-revision'); }}>
        <label className="field">Corrections attendues<textarea name="note" required minLength={10} maxLength={5000} rows={3} value={revisionDraft} onChange={(event) => setRevisionDraft(event.target.value)} placeholder="Décrivez précisément les corrections nécessaires." /></label>
        <p className="help-text">La demande retourne la commande en attente de livraison. {isRealOrder(order) ? 'Le paiement reste en séquestre.' : 'Aucun gain démo n’est enregistré.'}</p>
        <button type="submit" className="button button-secondary" disabled={pending || stale}>{pending ? 'Envoi…' : 'Demander une correction'}</button>
      </form>
      <form className="form" onSubmit={(event) => { event.preventDefault(); void action('complete'); }}>
        <label className="row small"><input type="checkbox" required disabled={pending || stale} checked={acceptedVersion === order.version} onChange={(event) => setAcceptedVersion(event.target.checked ? order.version : null)} /> J’ai vérifié la livraison affichée (version {order.version}) et je l’accepte.</label>
        <button type="submit" className="button button-primary" disabled={pending || stale || acceptedVersion !== order.version}><Check size={16} />{pending ? 'Confirmation…' : isRealOrder(order) ? 'Accepter · verser le paiement au vendeur' : 'Accepter · valider la vente démo'}</button>
      </form>
    </>}
    {seller && order.status === 'delivered' && <p className="muted">En attente de l’acceptation de l’acheteur. Aucun gain n’est encore enregistré.</p>}
    {order.status === 'completed' && <p className="text-success small">{isRealOrder(order) ? 'Livraison acceptée : le paiement a été versé au vendeur depuis le séquestre, frais de plateforme déduits.' : 'Livraison acceptée : le gain démo du vendeur a été enregistré. Aucun transfert réel.'}</p>}
    {order.status === 'disputed' && <p className="text-warning small">{isRealOrder(order) ? 'Signalement transmis à la modération. Les fonds restent en séquestre jusqu’à sa décision (versement au vendeur ou remboursement).' : 'Signalement transmis à la modération. La commande est bloquée, sans remboursement automatique.'}</p>}
    {order.status === 'refunded' && isRealOrder(order) && <p className="small muted">Commande remboursée sur le moyen de paiement d’origine (le délai dépend du prestataire).</p>}
    {(order.status === 'completed' || order.status === 'refunded') && <Link className="button button-ghost button-small" to={`/trust?target_type=order&target_id=${order.id}`}>Signaler un problème à la modération</Link>}
    {(order.status === 'paid' || order.status === 'delivered') && <div>
      <button type="button" className="button button-ghost button-small" disabled={pending || stale} onClick={() => setDispute(!dispute)}>{dispute ? 'Annuler le signalement' : 'Ouvrir un litige'}</button>
      {dispute && <form className="form" onSubmit={(event) => { event.preventDefault(); void action('dispute'); }}>
        <label className="field">Motif du litige<textarea name="reason" required minLength={10} maxLength={5000} rows={3} value={disputeDraft} onChange={(event) => setDisputeDraft(event.target.value)} placeholder="Décrivez précisément le problème pour la modération." /></label>
        <p className="help-text">{isRealOrder(order) ? 'Cette action bloque la commande et crée un signalement. Le paiement reste en séquestre jusqu’à la décision de la modération.' : 'Cette action bloque la commande et crée un signalement. Elle ne rembourse pas automatiquement l’achat, même en mode démo.'}</p>
        <button type="submit" className="button button-danger" disabled={pending || stale}>{pending ? 'Envoi…' : 'Transmettre à la modération'}</button>
      </form>}
    </div>}
    <span className="help-text">Référence : {order.id}</span>
    </article>
    <OrderHistory key={`${order.id}:${order.version}`} orderId={order.id} real={isRealOrder(order)} />
    </>}
  </section>;
}

function OrdersDashboard({ userId }: { userId: string }) {
  const [role, setRole] = useState('all');
  const [offset, setOffset] = useState(0);
  const orders = useApi<{ orders: Order[]; total: number; payment_summary: { earned_cents: number; spent_cents: number } }>(
    `/marketplace/orders?role=${role}&offset=${offset}&limit=24`,
  );
  return <section className="stack">
    <div className="section-heading"><h2>Mes commandes</h2><p className="muted">Suivez vos achats, livrez vos clients et gérez les litiges.</p></div>
    {orders.data && <div className="stat-grid">
      <div className="stat-card"><span className="stat-label">Gains démo Alpha</span><strong className="stat-value">{money(orders.data.payment_summary.earned_cents)}</strong><span className="stat-note">Toutes activités · ventes acceptées et missions versées</span></div>
      <div className="stat-card"><span className="stat-label">Dépenses démo Alpha</span><strong className="stat-value">{money(orders.data.payment_summary.spent_cents)}</strong><span className="stat-note">Toutes activités · achats et financements</span></div>
    </div>}
    <label className="field">Afficher<select value={role} onChange={(event) => { setRole(event.target.value); setOffset(0); }}><option value="all">Achats et ventes</option><option value="buyer">Mes achats</option><option value="seller">Mes ventes</option></select></label>
    {orders.loading ? <Loading /> : orders.error ? <div className="stack"><ErrorState message={orders.error} /><button type="button" className="button button-secondary" onClick={orders.reload}>Réessayer</button></div> : orders.data && <>
      {orders.data.orders.length ? orders.data.orders.map((order) => <OrderCard key={order.id} order={order} userId={userId} />) : <EmptyState title="Aucune commande pour le moment" description="Vos achats et vos ventes de démonstration apparaîtront ici." action={<Link className="button button-secondary" to="/marketplace">Explorer les offres</Link>} />}
      <Pagination offset={offset} total={orders.data.total} onChange={setOffset} />
    </>}
  </section>;
}

function ListingDetail({ listingId }: { listingId: string }) {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const detail = useApi<{ listing: Listing }>(`/marketplace/listings/${encodeURIComponent(listingId)}`);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');
  const [checkout, setCheckout] = useState(false);
  const platformMode = usePaymentMode();
  const realPayments = !!platformMode && platformMode !== 'demo';
  const listing = detail.data?.listing;

  async function buy() {
    if (!accepted) return;
    if (realPayments) { setError(''); setCheckout(true); return; }
    setPending(true); setError('');
    try {
      const { order } = await api<{ order: Order }>(`/marketplace/listings/${encodeURIComponent(listingId)}/buy`, { method: 'POST' });
      navigate(`/marketplace?view=orders&order=${order.id}`);
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }

  async function archive() {
    setPending(true); setError('');
    try {
      await api(`/marketplace/listings/${encodeURIComponent(listingId)}/archive`, { method: 'POST' });
      detail.reload();
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }

  return <div className="stack">
    <Link className="button button-ghost" to="/marketplace"><ArrowLeft size={16} />Toutes les offres</Link>
    <PaymentModeBanner mode={platformMode} />
    {detail.loading || authLoading ? <Loading /> : detail.error ? <div className="stack"><ErrorState message={detail.error} /><button type="button" className="button button-secondary" onClick={detail.reload}>Réessayer</button></div> : listing && <>
      <PageHeader eyebrow={`${categories[listing.kind]} · Licence non exclusive`} title={listing.title} description={`Proposé par ${listing.seller_name} · ${date(listing.created_at)}`} />
      <div className="detail-layout">
        <div className="detail-main stack">
          <section className="card card-body"><h2>À propos de cette offre</h2><p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{listing.description}</p>{listing.project_id && <Link className="button button-ghost" to={`/projects/${listing.project_id}`}>Voir le projet : {listing.project_title}<ArrowUpRight size={16} /></Link>}</section>
          <section className="card card-body"><h2>Ce que vous recevrez</h2><p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{listing.deliverables}</p></section>
          <section className="card card-body stack"><h2>Droits et conditions d’utilisation</h2><Badge tone="purple">Licence non exclusive uniquement</Badge><p className="pre-wrap" style={{ overflowWrap: 'anywhere' }}>{listing.license}</p><RightsNotice /></section>
        </div>
        <aside className="detail-aside stack">
          <section className="card card-body stack">
            <div className="row gap-sm"><Avatar name={listing.seller_name} color={listing.seller_color} /><strong>{listing.seller_name}</strong></div>
            <strong className="price">{money(listing.price_cents)}</strong><span className="small muted">{realPayments ? 'Paiement sécurisé · conservé en séquestre jusqu’à votre validation de la livraison' : 'Prix de démonstration · aucun paiement réel'}</span>
            <Badge tone={listing.status === 'active' ? 'green' : 'neutral'}>{listing.status === 'active' ? 'Offre disponible' : 'Offre archivée'}</Badge>
            {listing.status === 'active' && <BookmarkButton targetType="listing" targetId={listing.id} />}
            {user?.id === listing.seller_id ? <>
              <p className="small muted">Vous êtes le vendeur de cette offre.</p>
              {listing.terms_locked ? <p className="help-text">Des commandes existent : le prix, les droits et les livrables ne sont plus modifiables. Archivez cette offre puis publiez-en une nouvelle pour changer les conditions.</p> : <button type="button" className="button button-secondary" onClick={() => setEditing(true)} disabled={pending}>Modifier l’offre</button>}
              {listing.status === 'active' && <button type="button" className="button button-secondary" disabled={pending} onClick={() => void archive()}><Archive size={16} />{pending ? 'Archivage…' : 'Archiver l’offre'}</button>}
              <p className="help-text">L’archivage bloque les nouveaux achats, sans annuler les commandes existantes.</p>
            </> : listing.status === 'active' ? user ? <form className="form" onSubmit={(event) => { event.preventDefault(); void buy(); }}>
              <label className="row small"><input type="checkbox" required checked={accepted} onChange={(event) => setAccepted(event.target.checked)} /> J’accepte les livrables et les conditions non exclusives de cette offre.</label>
              {realPayments ? <button type="submit" className="button button-primary" disabled={pending || !accepted}><LockKeyhole size={18} />Acheter · paiement sécurisé</button> : <button type="submit" className="button button-primary" disabled={pending || !accepted}><ShoppingBag size={18} />{pending ? 'Création…' : 'Acheter en mode DÉMO'}</button>}
              <p className="help-text">{realPayments ? 'La commande est créée dès la confirmation du paiement. Vous vérifierez la livraison privée avant que le vendeur ne soit payé.' : 'Vous vérifierez la livraison privée avant de valider le gain démo du vendeur.'}</p>
            </form> : <Link className="button button-primary" to="/login">Se connecter pour acheter</Link> : <p className="muted small">Cette offre n’accepte plus de commandes.</p>}
            <ErrorState message={error} />
            {user && <Link className="button button-ghost" to="/marketplace?view=orders">Retrouver mes commandes</Link>}
          </section>
        </aside>
      </div>
      {editing && <ListingForm listing={listing} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); detail.reload(); }} />}
      {checkout && <CheckoutDialog purpose="order_purchase" refId={listing.id} title={listing.title} amountMinor={listing.price_cents} onClose={() => setCheckout(false)} />}
    </>}
  </div>;
}

function MarketplaceHome() {
  const { user, loading: authLoading, error: authError } = useAuth();
  const platformMode = usePaymentMode();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view = params.get('view') === 'orders' ? 'orders' : params.get('view') === 'mine' ? 'mine' : 'discover';
  const orderId = params.get('order');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('all');
  const [offset, setOffset] = useState(0);
  const listings = useApi<{ listings: Listing[]; total: number }>(view === 'orders' || (view === 'mine' && !user) ? null :
    `/marketplace/listings?q=${encodeURIComponent(query)}${kind ? `&kind=${kind}` : ''}&limit=24&offset=${offset}${view === 'mine' ? `&mine=true&status=${status}` : ''}`);

  function changeView(next: string) {
    setOffset(0); setParams(next === 'discover' ? {} : { view: next });
  }

  return <div className="stack">
    <PageHeader eyebrow="Le talent devient concret" title="Marketplace" description="Des outils, des idées et du savoir-faire pour faire avancer vos projets."
      action={user ? <button className="button button-primary" type="button" onClick={() => setCreating(true)}><Plus size={18} />Publier une offre</button> : <Link className="button button-primary" to="/login">Se connecter pour vendre</Link>} />
    <PaymentModeBanner mode={platformMode} />
    <div className="tabs" aria-label="Vues de la marketplace">
      <button type="button" className={`tab ${view === 'discover' ? 'active' : ''}`} onClick={() => changeView('discover')}>Explorer</button>
      <button type="button" className={`tab ${view === 'mine' ? 'active' : ''}`} onClick={() => changeView('mine')}>Mes offres</button>
      <button type="button" className={`tab ${view === 'orders' ? 'active' : ''}`} onClick={() => changeView('orders')}>Achats et ventes</button>
    </div>
    <ErrorState message={authError} />
    {authLoading && view !== 'discover' ? <Loading /> : !user && view !== 'discover' ? <LoginNotice /> : view === 'orders' && user ? orderId ? <OrderDetail key={`${user.id}:${orderId}`} orderId={orderId} userId={user.id} /> : <OrdersDashboard key={user.id} userId={user.id} /> : <>
      <RightsNotice />
      <form className="filters" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setOffset(0); }}>
        <label className="field">Rechercher une offre<input className="search-input" value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} placeholder="Logiciel, composant, expertise…" /></label>
        <label className="field">Catégorie<select value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }}><option value="">Toutes les catégories</option>{Object.entries(categories).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        {view === 'mine' && <label className="field">État de mes offres<select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}><option value="all">Toutes</option><option value="active">Actives</option><option value="archived">Archivées</option></select></label>}
        <button className="button button-secondary" type="submit"><Search size={16} />Rechercher</button>
      </form>
      {listings.loading ? <Loading /> : listings.error ? <div className="stack"><ErrorState message={listings.error} /><button className="button button-secondary" type="button" onClick={listings.reload}>Réessayer</button></div> : listings.data && <>
        <div className="row row-between"><h2>{view === 'mine' ? 'Mes offres' : 'À découvrir'}</h2><span className="small muted">{listings.data.total} offre{listings.data.total > 1 ? 's' : ''}</span></div>
        {listings.data.listings.length ? <div className="card-grid">{listings.data.listings.map((listing) => <ListingCard key={listing.id} listing={listing} realPayments={!!platformMode && platformMode !== 'demo'} />)}</div> : <EmptyState title={view === 'mine' ? 'Votre première offre commence ici' : 'Aucune offre ne correspond'} description={view === 'mine' ? 'Présentez vos livrables, vos conditions et votre prix démo.' : 'Essayez un autre mot-clé ou une autre catégorie.'} />}
        <Pagination offset={offset} total={listings.data.total} onChange={setOffset} />
      </>}
    </>}
    {creating && user && <ListingForm onClose={() => setCreating(false)} onSaved={(listing) => { setCreating(false); navigate(`/marketplace/${listing.id}`); }} />}
  </div>;
}

export default function MarketplacePage() {
  const { id } = useParams();
  return id ? <ListingDetail key={id} listingId={id} /> : <MarketplaceHome />;
}
