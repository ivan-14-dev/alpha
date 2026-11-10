import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownToLine, FlaskConical, Hourglass, Info, Plus, Printer, RefreshCw, ShieldCheck, TriangleAlert, Wallet } from 'lucide-react';
import { api, date, dateTime, errorMessage, money } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader } from '../components/ui';
import KycForm, { KycStatusBadge, type KycView } from '../components/KycForm';
import PayoutMethodForm from '../components/PayoutMethodForm';
import PayoutMethodList from '../components/PayoutMethodList';
import {
  modeLabels, newIdempotencyKey, payoutKindLabels, percentFromBps, toMajorInput, toMinor, WithdrawalStatusBadge,
  type InvoiceView, type PaymentMode, type PayoutMethodView, type WithdrawalView,
} from '../components/PayoutStatus';
import '../styles/compliance.css';

/* /wallet: balances from the ledger, withdrawals, payout methods, identity verification and invoices. OWNER: compliance module. */

interface Movement {
  journal_id: string; kind: string; label: string; memo: string; bucket: 'available' | 'pending';
  amount_minor: number; currency: string; ref_type: string; ref_id: string; created_at: string;
}
interface Limits {
  kyc_required_above_minor: number; min_withdrawal_minor: number; daily_limit_minor: number; monthly_limit_minor: number; manual_review_above_minor: number;
  daily_used_minor: number; monthly_used_minor: number; daily_remaining_minor: number; monthly_remaining_minor: number; without_kyc_remaining_minor: number | null;
}
interface WalletData {
  mode: PaymentMode; notice: string; base_currency: string; base_exponent: number; email_verified: boolean;
  kyc: KycView; payout_methods: PayoutMethodView[]; payout_available: boolean;
  withdrawals: { total: number; withdrawals: WithdrawalView[] };
  invoices: { total: number; invoices: InvoiceView[] };
  balances: { available_minor: number; pending_minor: number; in_flight_minor: number; currency: string } | null;
  movements: Movement[]; limits: Limits; can_withdraw: boolean;
}

const tabs = [
  { id: 'overview', label: 'Aperçu' },
  { id: 'withdrawals', label: 'Retraits' },
  { id: 'methods', label: 'Moyens de versement' },
  { id: 'kyc', label: 'Identité' },
  { id: 'invoices', label: 'Factures' },
] as const;
type Tab = typeof tabs[number]['id'];

const PAGE = 20;

export default function WalletPage() {
  const { user, loading: authLoading } = useAuth();
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = tabs.some((item) => item.id === requested) ? requested as Tab : 'overview';

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setWallet(await api<WalletData>('/compliance/wallet'));
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { if (user) void load(); }, [user, load]);

  const selectTab = (next: Tab) => setParams(next === 'overview' ? {} : { tab: next }, { replace: true });

  if (authLoading) return <Loading />;
  if (!user) return <LoginNotice />;

  const header = <PageHeader eyebrow="Finances" title="Portefeuille" description="Vos gains, vos retraits, votre vérification d’identité et vos factures."
    action={<button type="button" className="button button-secondary" onClick={() => { void load(); }} disabled={refreshing}><RefreshCw size={15} /> Actualiser</button>} />;

  if (!wallet) return <div className="cmp-page">{header}{error ? <ErrorState message={error} /> : <Loading />}</div>;

  return <div className="cmp-page">
    {header}
    <ModeNotice wallet={wallet} />
    {error && <ErrorState message={error} />}
    {!wallet.email_verified && <div className="cmp-notice cmp-notice-warning" role="alert"><TriangleAlert size={18} /><div>
      <strong>Adresse e-mail à confirmer</strong>
      Confirmez votre adresse e-mail pour pouvoir retirer vos gains. Le lien de vérification peut être renvoyé depuis les <Link to="/settings">paramètres du compte</Link>.
    </div></div>}
    <Balances wallet={wallet} />

    <div className="tabs" role="tablist" aria-label="Sections du portefeuille">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`tab${tab === item.id ? ' active' : ''}`} onClick={() => selectTab(item.id)}>
        {item.label}
        {item.id === 'kyc' && <> <KycStatusBadge status={wallet.kyc.status} /></>}
      </button>)}
    </div>

    {tab === 'overview' && <div className="cmp-grid">
      <Movements wallet={wallet} />
      <WithdrawCard wallet={wallet} onDone={() => { void load(); }} goTo={selectTab} />
    </div>}
    {tab === 'withdrawals' && <WithdrawalsCard wallet={wallet} onChange={() => { void load(); }} />}
    {tab === 'methods' && <MethodsCard wallet={wallet} onChange={() => { void load(); }} />}
    {tab === 'kyc' && <section className="card">
      <div className="card-header"><h2>Vérification d’identité</h2><KycStatusBadge status={wallet.kyc.status} /></div>
      <div className="card-body stack">
        <p className="help-text">La vérification d’identité (KYC) est exigée par la réglementation au-delà de {money(wallet.limits.kyc_required_above_minor, wallet.base_currency)} de retraits sur 30 jours glissants. Les prestataires de paiement peuvent aussi demander leurs propres vérifications.</p>
        <KycForm kyc={wallet.kyc} userId={user.id} onChange={(kyc) => setWallet({ ...wallet, kyc })} />
      </div>
    </section>}
    {tab === 'invoices' && <InvoicesCard wallet={wallet} />}
  </div>;
}

function ModeNotice({ wallet }: { wallet: WalletData }) {
  const Icon = wallet.mode === 'live' ? ShieldCheck : wallet.mode === 'sandbox' ? FlaskConical : Info;
  return <div className={`cmp-notice cmp-notice-${wallet.mode}`} role="note"><Icon size={18} /><div>
    <strong>Mode {modeLabels[wallet.mode].toLowerCase()}</strong>{wallet.notice}
  </div></div>;
}

function Balances({ wallet }: { wallet: WalletData }) {
  if (!wallet.balances) {
    return <section className="card"><div className="card-body">
      <EmptyState title="Pas de solde en mode démonstration" description="Les gains affichés dans les missions et la marketplace sont fictifs : aucun compte n’est tenu dans le grand livre et aucun retrait n’est possible. Vous pouvez néanmoins préparer votre vérification d’identité et vos moyens de versement." />
    </div></section>;
  }
  const { available_minor, pending_minor, in_flight_minor, currency } = wallet.balances;
  return <div className="stat-grid cmp-balances">
    <div className="stat-card"><span className="stat-label"><Wallet size={14} /> Disponible</span><strong className="stat-value">{money(available_minor, currency)}</strong>
      <span className="cmp-stat-hint">Montant que vous pouvez retirer dès maintenant.</span></div>
    <div className="stat-card"><span className="stat-label"><Hourglass size={14} /> En attente</span><strong className="stat-value">{money(pending_minor, currency)}</strong>
      <span className="cmp-stat-hint">Gains réservés jusqu’à la validation de la mission ou la livraison de la commande.</span></div>
    <div className="stat-card"><span className="stat-label"><ArrowDownToLine size={14} /> Retraits en cours</span><strong className="stat-value">{money(in_flight_minor, currency)}</strong>
      <span className="cmp-stat-hint">Demandés, pas encore versés. Ils ne sont plus comptés dans le disponible.</span></div>
  </div>;
}

function Movements({ wallet }: { wallet: WalletData }) {
  return <section className="card">
    <div className="card-header"><h2>Mouvements récents</h2><span className="small muted">{wallet.movements.length ? `${wallet.movements.length} derniers` : ''}</span></div>
    {wallet.movements.length === 0
      ? <div className="card-body"><EmptyState title="Aucun mouvement" description={wallet.mode === 'demo' ? 'Le grand livre n’est pas utilisé en mode démonstration.' : 'Vos gains de missions et ventes apparaîtront ici dès qu’ils seront crédités.'} /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Date</th><th>Opération</th><th>Solde</th><th className="cmp-amount">Montant</th></tr></thead>
        <tbody>{wallet.movements.map((movement, index) => <tr key={`${movement.journal_id}-${movement.bucket}-${index}`}>
          <td>{dateTime(movement.created_at)}</td>
          <td>{movement.label}{movement.memo && <span className="cmp-sub">{movement.memo}</span>}</td>
          <td><Badge tone={movement.bucket === 'available' ? 'green' : 'orange'}>{movement.bucket === 'available' ? 'Disponible' : 'En attente'}</Badge></td>
          <td className={`cmp-amount ${movement.amount_minor >= 0 ? 'cmp-amount-in' : 'cmp-amount-out'}`}>{movement.amount_minor > 0 ? '+' : ''}{money(movement.amount_minor, movement.currency)}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

function WithdrawCard({ wallet, onDone, goTo }: { wallet: WalletData; onDone: () => void; goTo: (tab: Tab) => void }) {
  const methods = wallet.payout_methods.filter((method) => !method.deleted_at);
  const preferred = methods.find((method) => method.is_default && method.payout_available) ?? methods.find((method) => method.payout_available) ?? methods[0];
  const [methodId, setMethodId] = useState(preferred?.id ?? '');
  const [amount, setAmount] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const currency = wallet.base_currency;
  const { limits } = wallet;
  const available = wallet.balances?.available_minor ?? 0;
  const method = methods.find((item) => item.id === methodId) ?? preferred;
  const minor = amount ? toMinor(amount, currency) : null;
  const max = Math.max(0, Math.min(available, limits.daily_remaining_minor, limits.monthly_remaining_minor));
  const kycNeeded = minor !== null && limits.without_kyc_remaining_minor !== null && minor > limits.without_kyc_remaining_minor;

  const problem = (() => {
    if (wallet.mode === 'demo') return 'Les retraits sont désactivés en mode démonstration.';
    if (!wallet.email_verified) return 'Confirmez votre adresse e-mail pour retirer vos gains.';
    if (!methods.length) return 'Ajoutez un moyen de versement pour retirer vos gains.';
    if (!wallet.payout_available) return 'Aucun de vos moyens de versement n’est pris en charge par un prestataire actif pour le moment.';
    if (available <= 0) return 'Votre solde disponible est nul.';
    return '';
  })();

  const validate = (): string => {
    if (minor === null || minor <= 0) return 'Indiquez un montant valide.';
    if (minor < limits.min_withdrawal_minor) return `Le montant minimum est de ${money(limits.min_withdrawal_minor, currency)}.`;
    if (minor > available) return 'Le montant dépasse votre solde disponible.';
    if (minor > limits.daily_remaining_minor) return `Plafond journalier : il vous reste ${money(limits.daily_remaining_minor, currency)} sur 24 heures.`;
    if (minor > limits.monthly_remaining_minor) return `Plafond mensuel : il vous reste ${money(limits.monthly_remaining_minor, currency)} sur 30 jours.`;
    if (kycNeeded && wallet.kyc.status !== 'approved') return 'Ce montant nécessite une vérification d’identité approuvée.';
    if (!method?.payout_available) return 'Ce moyen de versement n’est pas disponible actuellement. Choisissez-en un autre.';
    return '';
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = validate();
    setMessage('');
    if (invalid) { setError(invalid); return; }
    setBusy(true); setError('');
    try {
      const withdrawal = await api<WithdrawalView>('/compliance/withdrawals', {
        method: 'POST', body: JSON.stringify({ amount_minor: minor, payout_method_id: method!.id, idempotency_key: key }),
      });
      setMessage(withdrawal.status === 'on_hold'
        ? `Demande de retrait de ${money(withdrawal.amount_base_minor, withdrawal.base_currency)} enregistrée. Elle sera vérifiée par notre équipe avant versement ; vous serez notifié.`
        : `Retrait de ${money(withdrawal.amount_base_minor, withdrawal.base_currency)} approuvé : le versement de ${money(withdrawal.amount_minor, withdrawal.currency)} est en cours de traitement.`);
      setAmount('');
      setKey(newIdempotencyKey());
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return <section className="card">
    <div className="card-header"><h2>Retirer</h2>{wallet.balances && <span className="small muted">Disponible : {money(available, currency)}</span>}</div>
    <div className="card-body stack">
      {problem && <div className="cmp-notice cmp-notice-warning"><Info size={16} /><div>
        {problem}{' '}
        {!methods.length && wallet.mode !== 'demo' && <button type="button" className="button button-secondary button-small" onClick={() => goTo('methods')}><Plus size={14} /> Ajouter un moyen</button>}
      </div></div>}
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="withdraw-amount">Montant</label>
          <div className="cmp-inline-input">
            <input id="withdraw-amount" inputMode="decimal" autoComplete="off" required placeholder={toMajorInput(limits.min_withdrawal_minor, currency)} value={amount}
              disabled={!!problem || busy} onChange={(event) => { setAmount(event.target.value); setError(''); }} aria-describedby="withdraw-limits" />
            <span className="cmp-currency">{currency}</span>
            <button type="button" className="button button-ghost button-small" disabled={!!problem || busy || max <= 0} onClick={() => setAmount(toMajorInput(max, currency))}>Maximum</button>
          </div>
        </div>
        <label className="field" htmlFor="withdraw-method">Moyen de versement
          <select id="withdraw-method" value={method?.id ?? ''} disabled={!methods.length || busy || wallet.mode === 'demo'} onChange={(event) => setMethodId(event.target.value)}>
            {methods.map((item) => <option key={item.id} value={item.id} disabled={!item.payout_available}>
              {(item.label || payoutKindLabels[item.kind])} — {item.display_mask} ({item.currency}){item.payout_available ? '' : ' — indisponible'}
            </option>)}
          </select>
        </label>
        {method && method.currency !== currency && <p className="help-text">Le montant sera converti en {method.currency} au taux en vigueur au moment de la demande ; le montant exact versé figure dans l’historique.</p>}
        {kycNeeded && wallet.kyc.status !== 'approved' && <div className="cmp-notice cmp-notice-warning"><ShieldCheck size={16} /><div>
          Au-delà de {money(limits.kyc_required_above_minor, currency)} de retraits sur 30 jours, une vérification d’identité est obligatoire.{' '}
          {wallet.kyc.status === 'submitted' ? 'Votre dossier est en cours de vérification.' : <button type="button" className="button button-secondary button-small" onClick={() => goTo('kyc')}>Vérifier mon identité</button>}
        </div></div>}
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {message && <div className="alert alert-success" role="status">{message}</div>}
        <button type="submit" className="button button-primary" disabled={!!problem || busy}><ArrowDownToLine size={16} /> {busy ? 'Envoi…' : 'Demander le retrait'}</button>
      </form>
      <ul className="cmp-limits" id="withdraw-limits" aria-label="Limites de retrait">
        <li><span>Montant minimum</span><strong>{money(limits.min_withdrawal_minor, currency)}</strong></li>
        <li><span>Reste sur 24 heures</span><strong>{money(limits.daily_remaining_minor, currency)} / {money(limits.daily_limit_minor, currency)}</strong></li>
        <li><span>Reste sur 30 jours</span><strong>{money(limits.monthly_remaining_minor, currency)} / {money(limits.monthly_limit_minor, currency)}</strong></li>
        {limits.without_kyc_remaining_minor !== null && <li><span>Retirable sans vérification d’identité</span><strong>{money(limits.without_kyc_remaining_minor, currency)}</strong></li>}
        <li><span>Vérification manuelle au-delà de</span><strong>{money(limits.manual_review_above_minor, currency)}</strong></li>
      </ul>
      <p className="cmp-legal">Les retraits sont versés par nos prestataires de paiement agréés, généralement en quelques minutes pour le mobile money et sous 1 à 3 jours ouvrés pour les virements. Une demande peut être annulée tant que le versement n’a pas commencé.</p>
    </div>
  </section>;
}

function usePaged<T>(path: string, initial: { total: number; items: T[] }) {
  const [items, setItems] = useState(initial.items);
  const [total, setTotal] = useState(initial.total);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setItems(initial.items); setTotal(initial.total); }, [initial.items, initial.total]);
  const more = async (pick: (payload: Record<string, unknown>) => { total: number; items: T[] }) => {
    setLoading(true); setError('');
    try {
      const page = pick(await api<Record<string, unknown>>(`${path}?limit=${PAGE}&offset=${items.length}`));
      setItems([...items, ...page.items]); setTotal(page.total);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  };
  return { items, total, loading, error, more };
}

function WithdrawalsCard({ wallet, onChange }: { wallet: WalletData; onChange: () => void }) {
  const paged = usePaged<WithdrawalView>('/compliance/withdrawals', { total: wallet.withdrawals.total, items: wallet.withdrawals.withdrawals });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const cancel = async (withdrawal: WithdrawalView) => {
    if (!window.confirm(`Annuler le retrait de ${money(withdrawal.amount_base_minor, withdrawal.base_currency)} ? Le montant sera recrédité sur votre solde disponible.`)) return;
    setBusy(withdrawal.id); setError('');
    try {
      await api(`/compliance/withdrawals/${encodeURIComponent(withdrawal.id)}/cancel`, { method: 'POST' });
      onChange();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy('');
    }
  };
  return <section className="card">
    <div className="card-header"><h2>Historique des retraits</h2><span className="small muted">{paged.total} au total</span></div>
    {(error || paged.error) && <div className="card-body"><ErrorState message={error || paged.error} /></div>}
    {paged.items.length === 0
      ? <div className="card-body"><EmptyState title="Aucun retrait" description="Vos demandes de retrait et leur suivi apparaîtront ici." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Date</th><th className="cmp-amount">Montant</th><th>Moyen</th><th>Statut</th><th>Détails</th><th /></tr></thead>
        <tbody>{paged.items.map((withdrawal) => <tr key={withdrawal.id}>
          <td>{dateTime(withdrawal.created_at)}{withdrawal.mode === 'sandbox' && <span className="cmp-sub">Bac à sable</span>}</td>
          <td className="cmp-amount">{money(withdrawal.amount_base_minor, withdrawal.base_currency)}
            {withdrawal.currency !== withdrawal.base_currency && <span className="cmp-sub">soit {money(withdrawal.amount_minor, withdrawal.currency)}</span>}</td>
          <td>{withdrawal.method ? <>{withdrawal.method.label || payoutKindLabels[withdrawal.method.kind]}<span className="cmp-sub cmp-mono">{withdrawal.method.display_mask}</span></> : '—'}</td>
          <td><WithdrawalStatusBadge status={withdrawal.status} /></td>
          <td className="small">{withdrawalDetails(withdrawal)}</td>
          <td>{withdrawal.can_cancel && <button type="button" className="button button-ghost button-small" disabled={!!busy} onClick={() => { void cancel(withdrawal); }}>Annuler</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    {paged.items.length < paged.total && <div className="cmp-more"><button type="button" className="button button-secondary button-small" disabled={paged.loading}
      onClick={() => { void paged.more((payload) => ({ total: payload.total as number, items: payload.withdrawals as WithdrawalView[] })); }}>Afficher plus</button></div>}
  </section>;
}

function withdrawalDetails(withdrawal: WithdrawalView): string {
  switch (withdrawal.status) {
    case 'requested':
    case 'on_hold': return 'Vérification par l’équipe conformité avant versement.';
    case 'approved': return withdrawal.attempts > 0 && withdrawal.next_attempt_at
      ? `Nouvelle tentative prévue le ${dateTime(withdrawal.next_attempt_at)}.`
      : 'En file d’attente pour versement.';
    case 'processing': return 'Le prestataire traite le versement.';
    case 'paid': return withdrawal.paid_at ? `Versé le ${dateTime(withdrawal.paid_at)}.` : 'Versé.';
    case 'failed': return `${withdrawal.failure_reason || 'Le versement a échoué.'} Le montant a été recrédité.`;
    case 'rejected': return `${withdrawal.review_note ? `Motif : ${withdrawal.review_note}. ` : ''}Le montant a été recrédité.`;
    case 'cancelled': return 'Annulé ; le montant a été recrédité.';
    default: return '';
  }
}

function MethodsCard({ wallet, onChange }: { wallet: WalletData; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const methods = wallet.payout_methods.filter((method) => !method.deleted_at);
  return <section className="card">
    <div className="card-header"><h2>Moyens de versement</h2>
      <button type="button" className="button button-primary button-small" onClick={() => setAdding(true)}><Plus size={14} /> Ajouter</button></div>
    <div className="card-body stack">
      <p className="help-text">Les retraits sont versés uniquement sur des comptes à votre nom. Les coordonnées sont chiffrées ; seul un aperçu masqué est affiché. Un moyen utilisé par une demande de retrait en cours ne peut pas être supprimé.</p>
      <PayoutMethodList methods={methods} onChange={onChange} />
    </div>
    {adding && <Modal title="Ajouter un moyen de versement" onClose={() => setAdding(false)}>
      <PayoutMethodForm defaultCountry={wallet.kyc.country} onCancel={() => setAdding(false)} onCreated={() => { setAdding(false); onChange(); }} />
    </Modal>}
  </section>;
}

function InvoicesCard({ wallet }: { wallet: WalletData }) {
  const paged = usePaged<InvoiceView>('/compliance/invoices', { total: wallet.invoices.total, items: wallet.invoices.invoices });
  return <section className="card">
    <div className="card-header"><h2>Factures et reçus</h2><span className="small muted">{paged.total} document{paged.total > 1 ? 's' : ''}</span></div>
    <div className="card-body"><p className="help-text">Reçus de paiement, factures de commission de la plateforme et relevés de versement, émis automatiquement et numérotés de façon continue. Ils sont conservés 10 ans.</p></div>
    {paged.error && <div className="card-body"><ErrorState message={paged.error} /></div>}
    {paged.items.length === 0
      ? <div className="card-body"><EmptyState title="Aucun document" description="Vos reçus et factures apparaîtront ici après vos paiements, ventes et retraits." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Numéro</th><th>Type</th><th>Date</th><th className="cmp-amount">HT</th><th className="cmp-amount">TVA</th><th className="cmp-amount">TTC</th><th /></tr></thead>
        <tbody>{paged.items.map((invoice) => <tr key={invoice.id}>
          <td className="cmp-mono">{invoice.number}{invoice.series === 'sandbox' && <span className="cmp-sub">Bac à sable : sans valeur comptable</span>}</td>
          <td>{invoice.kind_label}<span className="cmp-sub">{invoice.description}</span></td>
          <td>{date(invoice.issued_at)}</td>
          <td className="cmp-amount">{money(invoice.amount_net_minor, invoice.currency)}</td>
          <td className="cmp-amount">{invoice.amount_tax_minor ? <>{money(invoice.amount_tax_minor, invoice.currency)}<span className="cmp-sub">{percentFromBps(invoice.tax_rate_bps)}</span></> : '—'}</td>
          <td className="cmp-amount">{money(invoice.amount_gross_minor, invoice.currency)}</td>
          <td><a className="button button-ghost button-small" href={invoice.html_url} target="_blank" rel="noopener noreferrer"><Printer size={14} /> Imprimer</a></td>
        </tr>)}</tbody>
      </table></div>}
    {paged.items.length < paged.total && <div className="cmp-more"><button type="button" className="button button-secondary button-small" disabled={paged.loading}
      onClick={() => { void paged.more((payload) => ({ total: payload.total as number, items: payload.invoices as InvoiceView[] })); }}>Afficher plus</button></div>}
  </section>;
}
