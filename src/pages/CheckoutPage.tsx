import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Clock3, FlaskConical, RefreshCw, XCircle } from 'lucide-react';
import { EmptyState, ErrorState, Loading, LoginNotice, PageHeader } from '../components/ui';
import { IntentStatusBadge, intentDestination, methodLabels, PaymentModeBanner, purposeLabels, type PublicIntent } from '../components/CheckoutStatus';
import { api, dateTime, errorMessage, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import '../styles/payments.css';

const validId = (value: string | null): value is string => !!value && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const POLL_MS = 2500;
const MAX_POLLS = 72;

/** Checkout pages: /checkout/simulator?reference=, /checkout/return?intent=, /checkout/cancel?intent=. */
export default function CheckoutPage() {
  const location = useLocation();
  const [params] = useSearchParams();
  const { user, loading, error } = useAuth();
  const section = location.pathname.replace(/^\/checkout\/?/, '').split('/')[0];
  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;
  if (!user) return <div className="pay-checkout"><PageHeader eyebrow="Paiement" title="Connectez-vous pour suivre votre paiement" /><LoginNotice /></div>;
  if (section === 'simulator') {
    const reference = params.get('reference');
    return validId(reference) ? <SimulatorCheckout key={reference} intentId={reference} /> : <InvalidLink />;
  }
  if (section === 'return' || section === 'cancel') {
    const intentId = params.get('intent');
    if (!validId(intentId)) return <InvalidLink />;
    return section === 'return' ? <CheckoutReturn key={intentId} intentId={intentId} /> : <CheckoutCancel key={intentId} intentId={intentId} />;
  }
  return <InvalidLink />;
}

function InvalidLink() {
  return <div className="pay-checkout"><EmptyState title="Lien de paiement invalide" description="Ce lien de paiement est incomplet ou a expiré. Retrouvez vos paiements dans votre espace." action={<Link className="button button-primary" to="/payments">Mes paiements</Link>} /></div>;
}

const intentPath = (intentId: string, suffix = '') => `/payments/intents/${encodeURIComponent(intentId)}${suffix}`;

function IntentSummary({ intent }: { intent: PublicIntent }) {
  return <dl className="pay-summary">
    <dt>Objet</dt><dd>{intent.title}</dd>
    <dt>Type</dt><dd>{purposeLabels[intent.purpose]}</dd>
    <dt>Montant</dt><dd className="pay-amount">{money(intent.amount_minor, intent.currency)}{intent.currency !== intent.base_currency && <span className="pay-sub">soit {money(intent.amount_base_minor, intent.base_currency)}</span>}</dd>
    <dt>Prestataire</dt><dd>{intent.provider}{intent.method ? ` · ${methodLabels[intent.method] ?? intent.method}` : ''}</dd>
    {intent.customer_phone_masked && <><dt>Téléphone</dt><dd className="pay-mono">{intent.customer_phone_masked}</dd></>}
    <dt>Référence</dt><dd className="pay-mono">{intent.id}</dd>
    <dt>Statut</dt><dd><IntentStatusBadge intent={intent} /></dd>
    <dt>Créé le</dt><dd>{dateTime(intent.created_at)}</dd>
  </dl>;
}

function SimulatorCheckout({ intentId }: { intentId: string }) {
  const navigate = useNavigate();
  const [intent, setIntent] = useState<PublicIntent | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<'' | 'succeeded' | 'failed'>('');
  const busy = useRef(false);

  useEffect(() => {
    let active = true;
    api<{ intent: PublicIntent }>(intentPath(intentId))
      .then((result) => { if (active) setIntent(result.intent); })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [intentId]);

  async function complete(outcome: 'succeeded' | 'failed') {
    if (busy.current) return;
    busy.current = true;
    setPending(outcome);
    setError('');
    try {
      await api(`/payments/simulator/${encodeURIComponent(intentId)}/complete`, { method: 'POST', body: JSON.stringify({ outcome }) });
      navigate(`/checkout/return?intent=${encodeURIComponent(intentId)}`, { replace: true });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      busy.current = false;
      setPending('');
    }
  }

  return <div className="pay-checkout">
    <PageHeader eyebrow="Simulateur Alpha · bac à sable" title="Page de paiement simulée" description="Cette page remplace la page hébergée d’un prestataire. Choisissez le résultat du paiement de test." />
    <div className="pay-banner pay-banner-sandbox" role="note"><FlaskConical size={16} aria-hidden="true" /><div><strong>Aucun argent réel</strong>Le résultat est transmis à Alpha par un webhook signé, exactement comme pour un vrai prestataire.</div></div>
    <ErrorState message={error} />
    {!intent ? (!error && <Loading />) : <section className="card card-body stack">
      <IntentSummary intent={intent} />
      {intent.final ? <div className="stack"><p className="muted">Ce paiement est déjà finalisé.</p><Link className="button button-primary" to={`/checkout/return?intent=${encodeURIComponent(intent.id)}`}>Voir le résultat</Link></div> : <>
        <div className="pay-simulator-actions">
          <button type="button" className="button button-primary" disabled={!!pending} onClick={() => void complete('succeeded')}><CheckCircle2 size={17} aria-hidden="true" /> {pending === 'succeeded' ? 'Paiement…' : `Payer ${money(intent.amount_minor, intent.currency)}`}</button>
          <button type="button" className="button button-danger" disabled={!!pending} onClick={() => void complete('failed')}><XCircle size={17} aria-hidden="true" /> {pending === 'failed' ? 'Envoi…' : 'Échouer le paiement'}</button>
        </div>
        <Link className="button button-ghost" to={`/checkout/cancel?intent=${encodeURIComponent(intent.id)}`}>Abandonner et revenir</Link>
      </>}
    </section>}
  </div>;
}

function CheckoutReturn({ intentId }: { intentId: string }) {
  const [intent, setIntent] = useState<PublicIntent | null>(null);
  const [error, setError] = useState('');
  const [polls, setPolls] = useState(0);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let count = 0;
    const read = () => api<{ intent: PublicIntent }>(intentPath(intentId));
    const tick = async () => {
      try {
        // Every 4th poll asks Alpha to re-confirm with the provider (status API); the others only read the intent.
        const result = count % 4 === 0 ? await api<{ intent: PublicIntent }>(intentPath(intentId, '/refresh'), { method: 'POST' }).catch(read) : await read();
        if (!active) return;
        setIntent(result.intent);
        setError('');
        count += 1;
        setPolls(count);
        const done = result.intent.final && (result.intent.status !== 'succeeded' || result.intent.settlement !== 'none' || result.intent.review_required);
        if (!done && count < MAX_POLLS) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (failure) {
        if (active) setError(errorMessage(failure));
      }
    };
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [intentId, round]);

  if (!intent) return <div className="pay-checkout">{error ? <><ErrorState message={error} /><Link className="button button-secondary" to="/payments">Mes paiements</Link></> : <Loading />}</div>;
  const destination = intentDestination(intent);
  const review = intent.review_required || intent.settlement === 'unapplied';
  const success = intent.status === 'succeeded' && !review;
  const failed = ['failed', 'cancelled', 'expired'].includes(intent.status) && !review;
  const waiting = !success && !failed && !review;
  const stopped = waiting && polls >= MAX_POLLS;
  const tone = success ? 'success' : failed ? 'failure' : review ? 'review' : 'pending';
  const Icon = success ? CheckCircle2 : failed ? XCircle : review ? AlertTriangle : Clock3;
  const heading = success ? (intent.settlement === 'settled' ? 'Paiement confirmé' : 'Paiement reçu, enregistrement en cours…')
    : failed ? intent.status === 'expired' ? 'Paiement expiré' : intent.status === 'cancelled' ? 'Paiement annulé' : 'Paiement échoué'
      : review ? 'Paiement en vérification' : 'Confirmation en cours…';
  const message = success
    ? intent.purpose === 'campaign_funding' ? 'Les fonds sont en séquestre pour votre campagne. Vous pouvez sélectionner vos testeurs.' : 'Votre commande est payée. Le vendeur est prévenu et vous livrera en privé ; le paiement lui sera versé quand vous validerez la livraison.'
    : failed ? intent.failure_reason || 'Aucun montant n’a été crédité. Vous pouvez réessayer avec le même ou un autre moyen de paiement.'
      : review ? 'Le montant confirmé par le prestataire ne correspond pas à la demande. Rien n’a été crédité ; l’équipe Alpha vérifie et vous contactera.'
        : intent.method === 'mobile_money' ? 'Validez la demande reçue sur votre téléphone (code PIN). Cette page se met à jour automatiquement.' : 'Nous attendons la confirmation du prestataire. Cette page se met à jour automatiquement.';

  return <div className="pay-checkout">
    <PaymentModeBanner mode={intent.mode} compact />
    <section className={`card pay-result pay-result-${tone}`} aria-live="polite">
      <span className="pay-result-icon"><Icon size={30} aria-hidden="true" /></span>
      <h2>{heading}</h2>
      <p className="muted">{message}</p>
      {waiting && intent.instructions && <div className="pay-instructions">{intent.instructions}</div>}
      {waiting && !stopped && <div className="loading" role="status"><RefreshCw className="spin" size={18} aria-hidden="true" /> Vérification auprès de {intent.provider}…</div>}
      {stopped && <div className="stack"><p className="small muted">Le prestataire n’a pas encore confirmé. Vous recevrez une notification dès la confirmation ; Alpha continue de vérifier automatiquement.</p><button type="button" className="button button-secondary" onClick={() => { setPolls(0); setRound((value) => value + 1); }}><RefreshCw size={16} aria-hidden="true" /> Vérifier à nouveau</button></div>}
      <IntentSummary intent={intent} />
      <ErrorState message={error} />
      <div className="row gap-sm">
        {(success || review) && <Link className="button button-primary" to={destination.to}>{destination.label}</Link>}
        {failed && <Link className="button button-primary" to={destination.to}>Réessayer le paiement</Link>}
        {waiting && intent.provider === 'simulator' && <Link className="button button-primary" to={`/checkout/simulator?reference=${encodeURIComponent(intent.id)}`}>Ouvrir le simulateur</Link>}
        {waiting && <Link className="button button-ghost" to={`/checkout/cancel?intent=${encodeURIComponent(intent.id)}`}>Abandonner ce paiement</Link>}
        <Link className="button button-secondary" to="/payments">Mes paiements</Link>
      </div>
    </section>
  </div>;
}

function CheckoutCancel({ intentId }: { intentId: string }) {
  const [intent, setIntent] = useState<PublicIntent | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ intent: PublicIntent }>(intentPath(intentId, '/cancel'), { method: 'POST' })
      .then((result) => { if (active) setIntent(result.intent); })
      .catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [intentId]);
  if (error) return <div className="pay-checkout"><ErrorState message={error} /><Link className="button button-secondary" to="/payments">Mes paiements</Link></div>;
  if (!intent) return <Loading />;
  const destination = intentDestination(intent);
  const cancelled = intent.status === 'cancelled';
  return <div className="pay-checkout">
    <section className={`card pay-result ${cancelled ? 'pay-result-failure' : intent.status === 'succeeded' ? 'pay-result-success' : 'pay-result-pending'}`}>
      <span className="pay-result-icon">{cancelled ? <XCircle size={30} aria-hidden="true" /> : <CheckCircle2 size={30} aria-hidden="true" />}</span>
      <h2>{cancelled ? 'Paiement abandonné' : 'Ce paiement ne peut plus être annulé'}</h2>
      <p className="muted">{cancelled ? 'Aucun montant n’a été crédité. Si le prestataire confirme malgré tout un débit, Alpha l’enregistrera automatiquement ou le remboursera.' : 'Il est déjà finalisé : consultez son résultat.'}</p>
      <IntentSummary intent={intent} />
      <div className="row gap-sm">
        {cancelled ? <Link className="button button-primary" to={destination.to}>{destination.label}</Link> : <Link className="button button-primary" to={`/checkout/return?intent=${encodeURIComponent(intent.id)}`}>Voir le résultat</Link>}
        <Link className="button button-secondary" to="/payments">Mes paiements</Link>
      </div>
    </section>
  </div>;
}
