import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, CreditCard, Landmark, LockKeyhole, Smartphone } from 'lucide-react';
import { EmptyState, ErrorState, Loading, Modal, useApi } from './ui';
import { api, errorMessage, money } from '../lib/api';
import { PaymentModeBanner, type PaymentMode, type PublicIntent } from './CheckoutStatus';
import '../styles/payments.css';

type MethodId = 'card' | 'mobile_money' | 'bank_transfer';
interface AvailableProvider {
  id: string;
  label: string;
  methods: { id: MethodId; label: string }[];
  currencies: string[];
  default_currency: string | null;
  countries: string[];
  operators: string[];
}
interface Available { mode: PaymentMode; base_currency: string; providers: AvailableProvider[] }
interface IntentResponse { intent: PublicIntent; redirect_url: string | null; instructions: string; reused: boolean }

const operatorLabels: Record<string, string> = {
  mtn: 'MTN Mobile Money', orange: 'Orange Money', moov: 'Moov Money', wave: 'Wave', airtel: 'Airtel Money',
  free: 'Free Money', mpesa: 'M-Pesa', vodafone: 'Vodafone Cash', tigo: 'Tigo Pesa', expresso: 'E-Money',
};
const methodIcons = { card: CreditCard, mobile_money: Smartphone, bank_transfer: Landmark };

function newKey() {
  return `chk_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * Real-money checkout (sandbox/live): provider, method, currency and, for mobile money, phone + operator.
 * Creates a payment intent then follows the provider redirect or shows its instructions.
 */
export default function CheckoutDialog({ purpose, refId, title, amountMinor, onClose }: {
  purpose: 'campaign_funding' | 'order_purchase';
  refId: string;
  title: string;
  /** Amount in the platform base currency (minor units), for display only: the server computes the real amount. */
  amountMinor: number;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const available = useApi<Available>(`/payments/providers/available?purpose=${purpose}`);
  const [providerId, setProviderId] = useState('');
  const [methodId, setMethodId] = useState('');
  const [currency, setCurrency] = useState('');
  const [phone, setPhone] = useState('');
  const [operator, setOperator] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState<PublicIntent | null>(null);
  const busy = useRef(false);
  const idempotencyKey = useRef(newKey());

  const data = available.data;
  const providers = data?.providers ?? [];
  const provider = providers.find((item) => item.id === providerId) ?? providers[0];
  const method = provider?.methods.find((item) => item.id === methodId) ?? provider?.methods[0];
  const selectedCurrency = provider && provider.currencies.includes(currency) ? currency : provider?.default_currency ?? provider?.currencies[0] ?? '';
  const mobile = method?.id === 'mobile_money';
  const selectedOperator = provider?.operators.includes(operator) ? operator : provider?.operators[0] ?? '';

  function follow(result: IntentResponse) {
    const url = result.redirect_url;
    if (url) {
      if (url.startsWith('/') && !url.startsWith('//')) { navigate(url); return; }
      const target = new URL(url, window.location.origin);
      if (target.origin === window.location.origin) { navigate(`${target.pathname}${target.search}`); return; }
      if (target.protocol === 'https:' || target.protocol === 'http:') { window.location.assign(target.href); return; }
      throw new Error('Adresse de paiement du prestataire invalide.');
    }
    if (result.intent.final) {
      navigate(`/checkout/return?intent=${encodeURIComponent(result.intent.id)}`);
      return;
    }
    setWaiting(result.intent);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider || busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api<IntentResponse>('/payments/intents', {
        method: 'POST',
        body: JSON.stringify({
          purpose,
          ref_id: refId,
          provider: provider.id,
          ...(method ? { method: method.id } : {}),
          ...(selectedCurrency ? { currency: selectedCurrency } : {}),
          ...(mobile ? { phone: phone.trim(), ...(selectedOperator ? { operator: selectedOperator } : {}) } : {}),
          idempotency_key: idempotencyKey.current,
        }),
      });
      if (result.intent.final && result.intent.status !== 'succeeded') {
        throw new Error(result.intent.failure_reason || 'Le paiement n’a pas pu être initié.');
      }
      follow(result);
    } catch (failure) {
      // A failed attempt is final server-side: the next click must create a new intent.
      idempotencyKey.current = newKey();
      setError(errorMessage(failure));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  const close = () => { if (!busy.current) onClose(); };
  const base = data?.base_currency ?? 'EUR';

  return <Modal title={purpose === 'campaign_funding' ? 'Financer la campagne' : 'Paiement sécurisé'} onClose={close}>
    {available.loading ? <Loading /> : available.error ? <ErrorState message={available.error} /> : waiting ? <div className="form">
      <PaymentModeBanner mode={waiting.mode} compact />
      <h3>Validez le paiement</h3>
      <div className="pay-instructions" role="status">{waiting.instructions || 'Suivez les instructions reçues de votre opérateur pour valider le paiement.'}</div>
      {waiting.customer_phone_masked && <p className="small muted">Demande envoyée au <span className="pay-mono">{waiting.customer_phone_masked}</span>.</p>}
      <div className="pay-total"><span>Montant</span><strong>{money(waiting.amount_minor, waiting.currency)}</strong></div>
      <div className="pay-actions">
        {waiting.provider === 'simulator' && <button type="button" className="button button-primary" onClick={() => navigate(`/checkout/simulator?reference=${encodeURIComponent(waiting.id)}`)}>Ouvrir le simulateur <ArrowUpRight size={16} aria-hidden="true" /></button>}
        <button type="button" className={waiting.provider === 'simulator' ? 'button button-secondary' : 'button button-primary'} onClick={() => navigate(`/checkout/return?intent=${encodeURIComponent(waiting.id)}`)}>Suivre la confirmation <ArrowUpRight size={16} aria-hidden="true" /></button>
      </div>
    </div> : !providers.length ? <EmptyState title="Aucun moyen de paiement disponible" description={data?.mode === 'demo' ? 'La plateforme est en mode démonstration.' : 'Aucun prestataire n’est configuré pour le moment. Réessayez plus tard ou contactez l’équipe Alpha.'} /> : <form className="form" onSubmit={(event) => void submit(event)} aria-busy={pending}>
      <PaymentModeBanner mode={data?.mode ?? null} compact />
      <div><h3>{title}</h3><p className="small muted">{purpose === 'campaign_funding' ? 'Les fonds sont conservés en séquestre pour la campagne et versés aux testeurs à la validation de leurs rapports. Le solde non utilisé peut être remboursé à la clôture.' : 'Le montant est conservé en séquestre et versé au vendeur lorsque vous validez la livraison. En cas de litige, la modération peut vous rembourser.'}</p></div>
      <div className="pay-total"><span>Montant à payer</span><strong>{money(amountMinor, base)}</strong></div>

      <fieldset className="pay-options">
        <legend>Prestataire de paiement</legend>
        {providers.map((item) => <label className="pay-option" key={item.id}>
          <input type="radio" name="provider" value={item.id} checked={provider?.id === item.id} disabled={pending} onChange={() => { setProviderId(item.id); setMethodId(''); setCurrency(''); setOperator(''); setError(''); }} />
          <span className="pay-option-body"><strong>{item.label}</strong><span className="pay-chips">{item.methods.map((entry) => <span className="pay-chip" key={entry.id}>{entry.label}</span>)}{item.currencies.map((code) => <span className="pay-chip" key={code}>{code}</span>)}</span></span>
        </label>)}
      </fieldset>

      {provider && provider.methods.length > 1 && <fieldset className="pay-options">
        <legend>Moyen de paiement</legend>
        {provider.methods.map((item) => {
          const Icon = methodIcons[item.id] ?? CreditCard;
          return <label className="pay-option" key={item.id}><input type="radio" name="method" value={item.id} checked={method?.id === item.id} disabled={pending} onChange={() => { setMethodId(item.id); setError(''); }} /><Icon size={18} aria-hidden="true" /><span className="pay-option-body"><strong>{item.label}</strong></span></label>;
        })}
      </fieldset>}

      <div className="form-grid">
        {provider && provider.currencies.length > 1 && <label className="field">Devise du paiement
          <select value={selectedCurrency} disabled={pending} onChange={(event) => setCurrency(event.target.value)}>{provider.currencies.map((code) => <option key={code} value={code}>{code}</option>)}</select>
        </label>}
        {mobile && provider && provider.operators.length > 0 && <label className="field">Opérateur
          <select value={selectedOperator} disabled={pending} onChange={(event) => setOperator(event.target.value)}>{provider.operators.map((code) => <option key={code} value={code}>{operatorLabels[code] ?? code.toUpperCase()}</option>)}</select>
        </label>}
        {mobile && <label className="field">Numéro mobile money
          <input type="tel" inputMode="tel" autoComplete="tel" required value={phone} disabled={pending} maxLength={20} pattern="\+?[0-9 ]{6,20}" placeholder="+237 6 XX XX XX XX" aria-describedby="checkout-phone-help" onChange={(event) => { setPhone(event.target.value); setError(''); }} />
        </label>}
      </div>
      {mobile && <p id="checkout-phone-help" className="help-text">Format international recommandé. Vous recevrez une demande de validation sur ce téléphone. Seule une version masquée du numéro est conservée par Alpha.</p>}
      {selectedCurrency && selectedCurrency !== base && <p className="help-text">Le montant sera converti en {selectedCurrency} au taux de change configuré par Alpha ; le montant exact est confirmé avant la redirection chez le prestataire.</p>}

      <ErrorState message={error} />
      <div className="row gap-sm">
        <button type="button" className="button button-secondary" disabled={pending} onClick={close}>Annuler</button>
        <button type="submit" className="button button-primary" disabled={pending || !provider}><LockKeyhole size={16} aria-hidden="true" /> {pending ? 'Connexion au prestataire…' : `Payer avec ${provider?.label ?? 'le prestataire'}`}</button>
      </div>
      <p className="small muted">Vous serez redirigé vers {provider?.label ?? 'le prestataire'} ou recevrez une demande de validation. Alpha ne voit ni ne stocke vos données bancaires.</p>
    </form>}
  </Modal>;
}
