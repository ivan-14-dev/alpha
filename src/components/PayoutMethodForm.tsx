import { useState, type FormEvent } from 'react';
import { CreditCard, Landmark, Smartphone } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { CountryField, currencyFor, payoutKindLabels, type PayoutKind, type PayoutMethodView } from './PayoutStatus';
import '../styles/compliance.css';

/* Payout method creation (POST /api/compliance/payout-methods). OWNER: compliance module.
 * Details are sent once over TLS, sealed server-side and never returned: only a masked label comes back. */

const operators: { id: string; label: string }[] = [
  { id: 'mtn', label: 'MTN Mobile Money' }, { id: 'orange', label: 'Orange Money' }, { id: 'moov', label: 'Moov Money' }, { id: 'wave', label: 'Wave' },
  { id: 'airtel', label: 'Airtel Money' }, { id: 'free', label: 'Free Money' }, { id: 'mpesa', label: 'M-Pesa' }, { id: 'vodacom', label: 'Vodacom M-Pesa' },
  { id: 'tigo', label: 'Tigo Pesa' }, { id: 'expresso', label: 'E-Money (Expresso)' }, { id: 'tmoney', label: 'T-Money' }, { id: 'flooz', label: 'Flooz' },
];

const currencies = ['XAF', 'XOF', 'EUR', 'USD', 'GBP', 'CHF', 'CAD', 'MAD', 'TND', 'NGN', 'GHS', 'KES', 'GNF', 'CDF'];

const kinds: { id: PayoutKind; icon: typeof Smartphone; help: string }[] = [
  { id: 'mobile_money', icon: Smartphone, help: 'MTN, Orange, Wave, Moov… Versement sur votre numéro.' },
  { id: 'bank_account', icon: Landmark, help: 'Virement sur un compte à votre nom (IBAN ou RIB).' },
  { id: 'stripe_connect', icon: CreditCard, help: 'Compte Stripe Connect déjà vérifié par Stripe.' },
];

interface Props {
  defaultCountry?: string | null;
  onCreated: (method: PayoutMethodView) => void;
  onCancel: () => void;
}

const compact = (values: Record<string, string>) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value !== ''));

export default function PayoutMethodForm({ defaultCountry, onCreated, onCancel }: Props) {
  const initialCountry = defaultCountry ?? '';
  const [kind, setKind] = useState<PayoutKind>('mobile_money');
  const [country, setCountry] = useState(initialCountry);
  const [currency, setCurrency] = useState(initialCountry ? currencyFor(initialCountry) : 'XAF');
  const [label, setLabel] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [mobile, setMobile] = useState({ operator: 'mtn', phone: '', account_name: '' });
  const [bank, setBank] = useState({ account_holder: '', iban: '', bic: '', account_number: '', bank_code: '', bank_name: '' });
  const [bankFormat, setBankFormat] = useState<'iban' | 'local'>('iban');
  const [stripeAccount, setStripeAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const changeCountry = (code: string) => {
    setCountry(code);
    if (code.length === 2) setCurrency(currencyFor(code));
  };

  const details = () => {
    if (kind === 'mobile_money') return compact(mobile);
    if (kind === 'stripe_connect') return { account_id: stripeAccount.trim() };
    const { iban, bic, account_number, bank_code, ...rest } = bank;
    return compact(bankFormat === 'iban' ? { ...rest, iban, bic } : { ...rest, account_number, bank_code });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^[A-Z]{2}$/.test(country)) { setError('Choisissez le pays du moyen de versement.'); return; }
    setBusy(true); setError('');
    try {
      const created = await api<PayoutMethodView>('/compliance/payout-methods', {
        method: 'POST',
        body: JSON.stringify({ kind, details: details(), label: label.trim(), country, currency, make_default: makeDefault }),
      });
      onCreated(created);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return <form className="form" onSubmit={submit}>
    <div className="cmp-kind-picker" role="group" aria-label="Type de moyen de versement">
      {kinds.map(({ id, icon: Icon, help }) => <button key={id} type="button" className="cmp-kind-option" aria-pressed={kind === id} onClick={() => { setKind(id); setError(''); }}>
        <strong><Icon size={16} /> {payoutKindLabels[id]}</strong><span>{help}</span>
      </button>)}
    </div>

    <div className="form-grid">
      <CountryField id="payout-country" label="Pays du compte" value={country} onChange={changeCountry} required />
      <label className="field" htmlFor="payout-currency">Devise de versement
        <select id="payout-currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
          {[...new Set([currency, ...currencies])].map((code) => <option key={code} value={code}>{code}</option>)}
        </select>
      </label>
    </div>

    {kind === 'mobile_money' && <div className="form-grid">
      <label className="field" htmlFor="payout-operator">Opérateur
        <select id="payout-operator" value={mobile.operator} onChange={(event) => setMobile({ ...mobile, operator: event.target.value })}>
          {operators.map((operator) => <option key={operator.id} value={operator.id}>{operator.label}</option>)}
        </select>
      </label>
      <label className="field" htmlFor="payout-phone">Numéro (format international)
        <input id="payout-phone" type="tel" inputMode="tel" autoComplete="tel" required maxLength={24} placeholder="+237 6 70 00 00 00"
          value={mobile.phone} onChange={(event) => setMobile({ ...mobile, phone: event.target.value })} />
      </label>
      <label className="field" htmlFor="payout-mobile-name">Nom du titulaire du compte
        <input id="payout-mobile-name" autoComplete="name" required minLength={2} maxLength={120} value={mobile.account_name}
          onChange={(event) => setMobile({ ...mobile, account_name: event.target.value })} />
      </label>
    </div>}

    {kind === 'bank_account' && <>
      <div className="tabs" role="tablist" aria-label="Format des coordonnées bancaires">
        <button type="button" role="tab" aria-selected={bankFormat === 'iban'} className={`tab${bankFormat === 'iban' ? ' active' : ''}`} onClick={() => setBankFormat('iban')}>IBAN (zone SEPA et autres)</button>
        <button type="button" role="tab" aria-selected={bankFormat === 'local'} className={`tab${bankFormat === 'local' ? ' active' : ''}`} onClick={() => setBankFormat('local')}>Numéro de compte et code banque</button>
      </div>
      <div className="form-grid">
        <label className="field" htmlFor="payout-holder">Titulaire du compte
          <input id="payout-holder" autoComplete="name" required minLength={2} maxLength={120} value={bank.account_holder}
            onChange={(event) => setBank({ ...bank, account_holder: event.target.value })} />
        </label>
        <label className="field" htmlFor="payout-bank-name">Banque (facultatif)
          <input id="payout-bank-name" maxLength={120} value={bank.bank_name} onChange={(event) => setBank({ ...bank, bank_name: event.target.value })} />
        </label>
        {bankFormat === 'iban' ? <>
          <label className="field" htmlFor="payout-iban">IBAN
            <input id="payout-iban" required autoComplete="off" spellCheck={false} maxLength={42} placeholder="FR76 3000 6000 0112 3456 7890 189"
              value={bank.iban} onChange={(event) => setBank({ ...bank, iban: event.target.value })} />
          </label>
          <label className="field" htmlFor="payout-bic">BIC (facultatif)
            <input id="payout-bic" autoComplete="off" spellCheck={false} maxLength={11} value={bank.bic} onChange={(event) => setBank({ ...bank, bic: event.target.value })} />
          </label>
        </> : <>
          <label className="field" htmlFor="payout-account">Numéro de compte
            <input id="payout-account" required autoComplete="off" spellCheck={false} maxLength={40} value={bank.account_number}
              onChange={(event) => setBank({ ...bank, account_number: event.target.value })} />
          </label>
          <label className="field" htmlFor="payout-bank-code">Code banque / guichet
            <input id="payout-bank-code" required autoComplete="off" spellCheck={false} maxLength={11} value={bank.bank_code}
              onChange={(event) => setBank({ ...bank, bank_code: event.target.value })} />
          </label>
        </>}
      </div>
    </>}

    {kind === 'stripe_connect' && <label className="field" htmlFor="payout-stripe">Identifiant du compte Stripe Connect
      <input id="payout-stripe" required autoComplete="off" spellCheck={false} maxLength={70} placeholder="acct_…" value={stripeAccount}
        onChange={(event) => setStripeAccount(event.target.value)} />
      <span className="help-text">Visible dans votre tableau de bord Stripe. Stripe effectue sa propre vérification d’identité.</span>
    </label>}

    <label className="field" htmlFor="payout-label">Libellé (facultatif)
      <input id="payout-label" maxLength={80} placeholder="Ex. Mon compte principal" value={label} onChange={(event) => setLabel(event.target.value)} />
    </label>
    <label className="cmp-checkbox"><input type="checkbox" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} /> Utiliser par défaut pour mes retraits</label>
    <p className="help-text">Vos coordonnées sont chiffrées et ne sont plus jamais affichées en clair : seuls les derniers chiffres restent visibles. Le compte doit être à votre nom.</p>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <div className="cmp-actions cmp-actions-end">
      <button type="button" className="button button-ghost" onClick={onCancel} disabled={busy}>Annuler</button>
      <button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
    </div>
  </form>;
}
