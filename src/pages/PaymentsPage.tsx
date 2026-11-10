import { useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, CircleDollarSign, Clock3, Landmark, LockKeyhole, ReceiptText, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { Avatar, Badge, DemoNotice, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, date, errorMessage, money, money as formatMoney } from '../lib/api';
import { useAuth } from '../lib/auth';
import CheckoutDialog from '../components/CheckoutDialog';
import { IntentStatusBadge, intentDestination, modeLabels, PaymentModeBanner, purposeLabels, usePaymentMode, type PaymentMode, type PublicIntent } from '../components/CheckoutStatus';

interface Summary {
  earned_cents: number;
  spent_cents: number;
  reserved_cents: number;
  payable_cents: number;
  payable_count: number;
  mode: 'demo';
}

interface Campaign {
  id: string;
  title: string;
  slots: number;
  reward_cents: number;
  status: 'open' | 'closed';
  budget_cents: number;
  funded_cents: number;
  reserved_cents: number;
  paid_cents: number;
  available_cents: number;
  remaining_cents: number;
  payment_mode?: PaymentMode;
  currency?: string;
  refunded_cents?: number;
  escrow_cents?: number;
}

interface RealBalances {
  mode: PaymentMode;
  base_currency: string;
  balances: { mode: 'sandbox' | 'live'; currency: string; available_minor: number }[];
  campaign_escrow: { mode: 'sandbox' | 'live'; currency: string; amount_minor: number }[];
}

interface Mission {
  id: string;
  campaign_id: string;
  campaign_title: string;
  reward_cents: number;
  tester_name: string;
  tester_avatar_color: string;
  status: 'accepted';
}

interface LedgerEntry {
  id: string;
  title: string;
  kind: 'funding' | 'payout' | 'purchase' | 'sale' | 'refund';
  amount_cents: number;
  status: 'completed' | 'pending' | 'failed';
  created_at: string;
  mode: 'demo';
}

interface PageResult {
  total: number;
  limit: number;
  offset: number;
  mode: 'demo';
  notice: string;
}

type Confirmation = { kind: 'funding'; campaign: Campaign; amount: string } | { kind: 'payout'; mission: Mission };

/** Demo campaigns keep the V3 simulated funding; real-money campaigns (or new ones once payments are on) go through checkout. */
function fundingRoute(campaign: Campaign, platformMode: PaymentMode | null): 'demo' | 'checkout' | 'blocked' {
  const campaignMode = campaign.payment_mode ?? 'demo';
  if (campaignMode !== 'demo') return platformMode === campaignMode ? 'checkout' : 'blocked';
  return platformMode && platformMode !== 'demo' && campaign.funded_cents === 0 ? 'checkout' : 'demo';
}

const kindLabels: Record<LedgerEntry['kind'], string> = {
  funding: 'Financement', payout: 'Récompense de mission', purchase: 'Achat', sale: 'Vente', refund: 'Remboursement',
};
const statusLabels: Record<LedgerEntry['status'], string> = {
  completed: 'Confirmé', pending: 'En attente', failed: 'Échoué',
};

function amountInCents(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function Pagination({ total, limit, offset, section, disabled, onChange }: {
  total: number; limit: number; offset: number; section: string; disabled: boolean; onChange: (offset: number) => void;
}) {
  if (total <= limit && offset === 0) return null;
  return <nav className="row row-between card-footer" aria-label={`Pagination — ${section}`}>
    <span className="small muted">{offset < total ? `${offset + 1}–${Math.min(offset + limit, total)}` : '0'} sur {total}</span>
    <div className="row gap-sm">
      <button type="button" className="button button-secondary button-small" disabled={disabled || offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Précédent</button>
      <button type="button" className="button button-secondary button-small" disabled={disabled || offset + limit >= total} onClick={() => onChange(offset + limit)}>Suivant</button>
    </div>
  </nav>;
}

export default function PaymentsPage() {
  const { user, loading: authLoading, error: authError } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedCampaignId = searchParams.get('campaign');
  if (authLoading) return <Loading />;
  if (authError) return <ErrorState message={authError} />;
  if (!user) return <><PageHeader eyebrow="Votre espace financier" title="Paiements" description="Suivez vos budgets et vos opérations de démonstration." /><DemoNotice /><LoginNotice /></>;
  return <PaymentsLedger key={`${user.id}:${selectedCampaignId ?? ''}`} selectedCampaignId={selectedCampaignId} clearSelection={() => {
    const next = new URLSearchParams(searchParams);
    next.delete('campaign');
    setSearchParams(next);
  }} />;
}

function PaymentsLedger({ selectedCampaignId, clearSelection }: { selectedCampaignId: string | null; clearSelection: () => void }) {
  const [campaignOffset, setCampaignOffset] = useState(0);
  const [missionOffset, setMissionOffset] = useState(0);
  const [transactionOffset, setTransactionOffset] = useState(0);
  const summary = useApi<{ summary: Summary; mode: 'demo'; notice: string }>('/payments/summary');
  const campaigns = useApi<PageResult & { campaigns: Campaign[] }>(`/payments/campaigns?limit=6&offset=${campaignOffset}${selectedCampaignId !== null ? `&campaign=${encodeURIComponent(selectedCampaignId)}` : ''}`);
  const missions = useApi<PageResult & { missions: Mission[] }>(`/payments/missions?limit=10&offset=${missionOffset}`);
  const transactions = useApi<PageResult & { transactions: LedgerEntry[] }>(`/payments/transactions?limit=15&offset=${transactionOffset}`);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [checkout, setCheckout] = useState<Campaign | null>(null);
  const [refunding, setRefunding] = useState<Campaign | null>(null);
  const platformMode = usePaymentMode();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [realRevision, setRealRevision] = useState(0);
  const refreshing = summary.loading || campaigns.loading || missions.loading || transactions.loading;
  const stats = summary.data?.summary;
  const fundingAmount = confirmation?.kind === 'funding' ? amountInCents(confirmation.amount) : null;

  function reloadAll() {
    summary.reload();
    campaigns.reload();
    missions.reload();
    transactions.reload();
    setRealRevision((value) => value + 1);
  }

  async function refundCampaign(campaign: Campaign) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setActionError('');
    try {
      await api(`/payments/campaigns/${encodeURIComponent(campaign.id)}/refund`, { method: 'POST', body: JSON.stringify({}) });
      setSuccess(`Remboursement du solde non utilisé de « ${campaign.title} » demandé. Il est envoyé au prestataire d’origine.`);
      setRefunding(null);
      reloadAll();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  function openConfirmation(value: Confirmation) {
    setActionError('');
    setSuccess('');
    setConfirmation(value);
  }

  async function confirmAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmation || busy.current) return;
    const action = confirmation;
    const amount = action.kind === 'funding' ? amountInCents(action.amount) : action.mission.reward_cents;
    if (amount === null || (action.kind === 'funding' && amount > action.campaign.remaining_cents)) {
      setActionError('Saisissez un montant positif, avec au plus deux décimales, inférieur ou égal au budget restant.');
      return;
    }
    busy.current = true;
    setPending(true);
    setActionError('');
    try {
      if (action.kind === 'funding') {
        await api(`/payments/campaigns/${encodeURIComponent(action.campaign.id)}/fund`, {
          method: 'POST', body: JSON.stringify({ amount_cents: amount }),
        });
        setSuccess(`${money(amount)} de financement simulé enregistrés pour « ${action.campaign.title} ». Aucun argent réel n’a été débité.`);
      } else {
        await api(`/payments/missions/${encodeURIComponent(action.mission.id)}/pay`, { method: 'POST' });
        setSuccess(`Versement simulé de ${money(amount)} confirmé pour ${action.mission.tester_name}. Aucun argent réel n’a été envoyé.`);
      }
      setConfirmation(null);
      setMissionOffset(0);
      setTransactionOffset(0);
      reloadAll();
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  }

  return <div className="stack">
    <PageHeader eyebrow="Finances · votre activité" title="Paiements"
      description="Des budgets transparents, du premier financement à la dernière récompense."
      action={<div className="row gap-sm"><Badge tone={platformMode === 'live' ? 'green' : platformMode === 'sandbox' ? 'blue' : 'purple'}><ShieldCheck size={14} aria-hidden="true" /> {platformMode && platformMode !== 'demo' ? modeLabels[platformMode] : 'Mode démo'}</Badge><button type="button" className="button button-secondary" disabled={pending || refreshing} onClick={reloadAll}><RefreshCw size={16} aria-hidden="true" /> Actualiser</button></div>} />
    <PaymentModeBanner mode={platformMode} />
    {platformMode && platformMode !== 'demo'
      ? <p className="small muted">Les indicateurs ci-dessous reprennent votre activité de démonstration (V3). Vos paiements {platformMode === 'live' ? 'réels' : 'de bac à sable'}, vos soldes et vos séquestres figurent dans la section « Paiements sécurisés ». Les retraits se font depuis votre <Link className="text-link" to="/wallet">portefeuille</Link>.</p>
      : <p className="small muted">Toutes les valeurs sont simulées, en euros. Les gains sont un cumul d’activité, pas un solde de portefeuille. Aucun retrait ni transfert bancaire n’est disponible.</p>}
    <div role="status" aria-live="polite">{success && <div className="alert alert-success">{success}</div>}</div>

    <section aria-label="Indicateurs financiers" aria-busy={summary.loading}>
      {summary.loading ? <Loading /> : summary.error ? <ErrorState message={summary.error} /> : stats && <div className="stat-grid">
        <article className="stat-card"><div className="row row-between"><span className="stat-label">Gains simulés</span><ArrowDownLeft size={20} className="text-success" aria-hidden="true" /></div><div className="stat-value">{money(stats.earned_cents)}</div><p className="stat-note">Récompenses et ventes confirmées · pas un solde</p></article>
        <article className="stat-card"><div className="row row-between"><span className="stat-label">Dépenses simulées</span><ArrowUpRight size={20} aria-hidden="true" /></div><div className="stat-value">{money(stats.spent_cents)}</div><p className="stat-note">Financements et achats confirmés</p></article>
        <article className="stat-card"><div className="row row-between"><span className="stat-label">Budgets réservés</span><Landmark size={20} aria-hidden="true" /></div><div className="stat-value">{money(stats.reserved_cents)}</div><p className="stat-note">Engagements de vos missions non versées</p></article>
        <article className="stat-card"><div className="row row-between"><span className="stat-label">Récompenses à verser</span><Clock3 size={20} aria-hidden="true" /></div><div className="stat-value">{money(stats.payable_cents)}</div><p className="stat-note">{stats.payable_count} rapport{stats.payable_count > 1 ? 's' : ''} accepté{stats.payable_count > 1 ? 's' : ''} · sous réserve de financement</p></article>
      </div>}
    </section>

    <section className="stack" aria-labelledby="campaign-budgets-title" aria-busy={campaigns.loading}>
      <div className="section-heading row row-between"><div><h2 id="campaign-budgets-title">{selectedCampaignId !== null ? 'Budget de la campagne sélectionnée' : 'Budgets de mes campagnes'}</h2><p className="muted small">Financez progressivement ou confirmez le financement du solde complet.</p></div>{selectedCampaignId !== null ? <button type="button" className="button button-secondary button-small" disabled={pending} onClick={clearSelection}>Toutes mes campagnes</button> : <Landmark size={22} aria-hidden="true" />}</div>
      {campaigns.loading ? <Loading /> : campaigns.error ? <ErrorState message={campaigns.error} /> : campaigns.data && <>
        {campaigns.data.campaigns.length === 0 ? <EmptyState title={selectedCampaignId !== null ? 'Campagne indisponible' : 'Aucune campagne à afficher'} description={selectedCampaignId !== null ? 'Cette campagne n’existe pas ou vous n’en êtes pas responsable.' : 'Les campagnes dont vous êtes responsable apparaissent ici avec leur budget de démonstration.'} /> : <div className="card-grid">
          {campaigns.data.campaigns.map((campaign) => {
            const percent = Math.min(100, Math.round(campaign.funded_cents / campaign.budget_cents * 100));
            const route = fundingRoute(campaign, platformMode);
            const real = (campaign.payment_mode ?? 'demo') !== 'demo';
            const money = (minor: number) => formatMoney(minor, real ? campaign.currency : undefined);
            return <article className="card" key={campaign.id}>
              <div className="card-header row row-between"><h3>{campaign.title}</h3><div className="row gap-sm">{real && <Badge tone={campaign.payment_mode === 'live' ? 'green' : 'blue'}>{modeLabels[campaign.payment_mode!]}</Badge>}<Badge tone={campaign.status === 'open' ? 'green' : 'neutral'}>{campaign.status === 'open' ? 'Ouverte' : 'Fermée'}</Badge></div></div>
              <div className="card-body stack">
                <div className="row row-between"><span className="muted small">Budget prévu</span><strong className="price">{money(campaign.budget_cents)}</strong></div>
                <p className="small muted">{campaign.slots} place{campaign.slots > 1 ? 's' : ''} × {money(campaign.reward_cents)} par mission</p>
                <div className="progress" role="progressbar" aria-label={`Financement de ${campaign.title}`} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${money(campaign.funded_cents)} financés sur ${money(campaign.budget_cents)}`}><div className="progress-bar" style={{ width: `${percent}%` }} /></div>
                <div className="three-column">
                  <div><div className="small muted">Financé</div><strong>{money(campaign.funded_cents)}</strong></div>
                  <div><div className="small muted">Réservé</div><strong>{money(campaign.reserved_cents)}</strong></div>
                  <div><div className="small muted">Versé</div><strong>{money(campaign.paid_cents)}</strong></div>
                </div>
                <div className="divider" />
                <div className="row row-between small"><span>Reste à financer</span><strong>{money(campaign.remaining_cents)}</strong></div>
                <div className="row row-between small"><span className="muted">Disponible après réservations</span><strong className={campaign.available_cents < 0 ? 'text-warning' : 'text-success'}>{money(campaign.available_cents)}</strong></div>
                {campaign.available_cents < 0 && <p className="small text-warning">Le financement actuel ne couvre pas tous les engagements.</p>}
              </div>
              {real && !!campaign.refunded_cents && <div className="card-body small muted">Déjà remboursé : {money(campaign.refunded_cents)}</div>}
              <div className="card-footer">
                {campaign.status === 'open' && campaign.remaining_cents > 0
                  ? route === 'checkout'
                    ? <button type="button" className="button button-primary full-width" disabled={pending} aria-label={`Financer ${campaign.title} par paiement sécurisé, reste ${money(campaign.remaining_cents)}`} onClick={() => { setActionError(''); setSuccess(''); setCheckout(campaign); }}><LockKeyhole size={17} aria-hidden="true" /> Financer par paiement sécurisé</button>
                    : route === 'blocked'
                      ? <span className="small muted">Campagne financée en mode {modeLabels[campaign.payment_mode!].toLowerCase()} : financement indisponible dans le mode actuel de la plateforme.</span>
                      : <button type="button" className="button button-primary full-width" disabled={pending} aria-label={`Financer ${campaign.title}, reste ${money(campaign.remaining_cents)}`} onClick={() => openConfirmation({ kind: 'funding', campaign, amount: (campaign.remaining_cents / 100).toFixed(2) })}><CircleDollarSign size={17} aria-hidden="true" /> Financer le budget</button>
                  : real && campaign.status === 'closed' && campaign.available_cents > 0
                    ? <button type="button" className="button button-secondary full-width" disabled={pending} onClick={() => { setActionError(''); setSuccess(''); setRefunding(campaign); }}>Rembourser le solde non utilisé ({money(campaign.available_cents)})</button>
                    : <span className="small muted">{campaign.remaining_cents === 0 ? real ? 'Budget entièrement financé (séquestre)' : 'Budget entièrement financé en démo' : 'Financement indisponible : campagne fermée'}</span>}
              </div>
            </article>;
          })}
        </div>}
        <Pagination {...campaigns.data} section="campagnes" disabled={pending} onChange={setCampaignOffset} />
      </>}
    </section>

    <section className="card" aria-labelledby="mission-payouts-title" aria-busy={missions.loading}>
      <div className="card-header row row-between"><div><h2 id="mission-payouts-title">Rapports acceptés · versements</h2><p className="small muted">Seul le responsable peut confirmer une récompense, une fois le budget financé.</p></div><CheckCircle2 size={22} aria-hidden="true" /></div>
      {missions.loading ? <Loading /> : missions.error ? <div className="card-body"><ErrorState message={missions.error} /></div> : missions.data && <>
        {missions.data.missions.length === 0 ? <EmptyState title="Aucun versement en attente" description="Les missions dont vous avez accepté le rapport apparaîtront ici. Une mission déjà versée ne peut pas être payée une seconde fois." /> : <div className="list">
          {missions.data.missions.map((mission) => <div className="list-item row row-between" key={mission.id}>
            <div className="row gap-sm"><Avatar name={mission.tester_name} color={mission.tester_avatar_color} /><div><strong>{mission.tester_name}</strong><p className="small muted">{mission.campaign_title}</p><Badge tone="green">Rapport accepté</Badge></div></div>
            <div className="row gap-sm"><strong>{money(mission.reward_cents)}</strong><button type="button" className="button button-secondary button-small" disabled={pending} aria-label={`Verser ${money(mission.reward_cents)} en démo à ${mission.tester_name} pour ${mission.campaign_title}`} onClick={() => openConfirmation({ kind: 'payout', mission })}>Verser en démo <ArrowUpRight size={16} aria-hidden="true" /></button></div>
          </div>)}
        </div>}
        <Pagination {...missions.data} section="versements" disabled={pending} onChange={setMissionOffset} />
      </>}
    </section>

    <SecurePayments key={realRevision} platformMode={platformMode} />

    <section className="card" aria-labelledby="ledger-title" aria-busy={transactions.loading}>
      <div className="card-header row row-between"><div><h2 id="ledger-title">Mon registre d’activité</h2><p className="small muted">Uniquement vos opérations. Les versements de missions sont inscrits au registre du testeur ; leur total figure dans vos budgets.</p></div><ReceiptText size={22} aria-hidden="true" /></div>
      {transactions.loading ? <Loading /> : transactions.error ? <div className="card-body"><ErrorState message={transactions.error} /></div> : transactions.data && <>
        {transactions.data.transactions.length === 0 ? <EmptyState title="Votre registre commence ici" description="Vos financements, récompenses et opérations de marché simulés seront conservés dans ce registre." /> : <div className="table-wrap">
          <table className="data-table"><caption className="small muted">Opérations de démonstration — montants simulés, sans transfert réel</caption><thead><tr><th scope="col">Opération</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Statut</th><th scope="col">Montant</th></tr></thead><tbody>
            {transactions.data.transactions.map((entry) => {
              const incoming = entry.kind === 'payout' || entry.kind === 'sale' || entry.kind === 'refund';
              return <tr key={entry.id}><td><strong>{entry.title}</strong><div className="small muted">Démonstration</div></td><td><time dateTime={entry.created_at}>{date(entry.created_at)}</time></td><td>{kindLabels[entry.kind]}</td><td><Badge tone={entry.status === 'completed' ? 'green' : entry.status === 'failed' ? 'orange' : 'neutral'}>{statusLabels[entry.status]}</Badge></td><td><strong className={incoming && entry.status === 'completed' ? 'text-success' : ''}>{incoming ? '+' : '−'}{money(entry.amount_cents)}</strong></td></tr>;
            })}
          </tbody></table>
        </div>}
        <Pagination {...transactions.data} section="activité" disabled={pending} onChange={setTransactionOffset} />
      </>}
    </section>

    {checkout && <CheckoutDialog purpose="campaign_funding" refId={checkout.id} title={checkout.title} amountMinor={checkout.remaining_cents} onClose={() => setCheckout(null)} />}
    {refunding && <Modal title="Rembourser le solde non utilisé" onClose={() => { if (!busy.current) setRefunding(null); }}>
      <div className="form">
        <p>Le solde non engagé de <strong>{refunding.title}</strong> ({formatMoney(refunding.available_cents, refunding.currency)}) sera remboursé sur le moyen de paiement d’origine. Les récompenses déjà réservées aux missions en cours restent en séquestre.</p>
        <ErrorState message={actionError} />
        <div className="row gap-sm"><button type="button" className="button button-secondary" disabled={pending} onClick={() => setRefunding(null)}>Annuler</button><button type="button" className="button button-primary" disabled={pending} onClick={() => void refundCampaign(refunding)}>{pending ? 'Demande…' : 'Confirmer le remboursement'}</button></div>
      </div>
    </Modal>}
    {confirmation && <Modal title={confirmation.kind === 'funding' ? 'Confirmer un financement simulé' : 'Confirmer un versement simulé'} onClose={() => { if (!busy.current) setConfirmation(null); }}>
      <form className="form" onSubmit={(event) => void confirmAction(event)} aria-busy={pending}>
        <DemoNotice />
        {confirmation.kind === 'funding' ? <>
          <h3>{confirmation.campaign.title}</h3>
          <div className="row row-between"><span>Budget restant à financer</span><strong>{money(confirmation.campaign.remaining_cents)}</strong></div>
          <label className="field" htmlFor="funding-amount">Montant du financement simulé (€)
            <input id="funding-amount" className="input" type="text" inputMode="decimal" autoFocus required maxLength={18} value={confirmation.amount} disabled={pending} aria-describedby="funding-help" aria-invalid={Boolean(actionError)} onChange={(event) => { setConfirmation({ ...confirmation, amount: event.target.value }); setActionError(''); }} />
          </label>
          <p id="funding-help" className="help-text">Le montant proposé finance tout le budget restant. Vous pouvez choisir un montant inférieur. Deux décimales maximum.</p>
          {fundingAmount !== null && fundingAmount <= confirmation.campaign.remaining_cents && <p className="small muted">Après confirmation : {money(confirmation.campaign.remaining_cents - fundingAmount)} resteront à financer.</p>}
        </> : <>
          <p>Confirmer la récompense de <strong>{money(confirmation.mission.reward_cents)}</strong> pour <strong>{confirmation.mission.tester_name}</strong> ?</p>
          <p className="small muted">{confirmation.mission.campaign_title} · rapport accepté. Cette action enregistre un versement de démonstration, sans transfert bancaire.</p>
        </>}
        <ErrorState message={actionError} />
        <div className="row gap-sm">
          <button type="button" className="button button-secondary" disabled={pending} onClick={() => setConfirmation(null)}>Annuler</button>
          <button type="submit" className="button button-primary" disabled={pending} autoFocus={confirmation.kind === 'payout'}>
            {pending ? 'Enregistrement…' : confirmation.kind === 'funding' ? `Confirmer le financement${fundingAmount !== null ? ` de ${money(fundingAmount)}` : ''}` : `Confirmer le versement de ${money(confirmation.mission.reward_cents)}`}
          </button>
        </div>
        {pending && <p className="small muted" role="status">Enregistrement de l’opération simulée…</p>}
      </form>
    </Modal>}
  </div>;
}

/** Ledger balances and checkout history for sandbox/live payments (shown when real payments are on or already used). */
function SecurePayments({ platformMode }: { platformMode: PaymentMode | null }) {
  const [offset, setOffset] = useState(0);
  const intents = useApi<{ intents: PublicIntent[]; total: number; limit: number; offset: number }>(`/payments/intents?limit=10&offset=${offset}`);
  const balances = useApi<RealBalances>('/payments/balances');
  const hasHistory = !!intents.data?.total || !!balances.data?.balances.length || !!balances.data?.campaign_escrow.length;
  if (!platformMode || (platformMode === 'demo' && !hasHistory)) return null;
  return <section className="card" aria-labelledby="secure-payments-title" aria-busy={intents.loading || balances.loading}>
    <div className="card-header row row-between"><div><h2 id="secure-payments-title">Paiements sécurisés</h2><p className="small muted">Paiements {platformMode === 'live' ? 'réels' : platformMode === 'sandbox' ? 'de bac à sable' : 'sandbox et réels'} traités par nos prestataires, conservés en séquestre jusqu’à validation. Registre comptable en partie double.</p></div><Link className="button button-secondary button-small" to="/wallet"><Wallet size={16} aria-hidden="true" /> Mon portefeuille</Link></div>
    <div className="card-body stack">
      {balances.loading ? <Loading /> : balances.error ? <ErrorState message={balances.error} /> : balances.data && <div className="stat-grid">
        {balances.data.balances.length === 0 && balances.data.campaign_escrow.length === 0 && <article className="stat-card"><span className="stat-label">Solde disponible</span><div className="stat-value">{money(0, balances.data.base_currency)}</div><p className="stat-note">Récompenses et ventes versées apparaîtront ici</p></article>}
        {balances.data.balances.map((row) => <article className="stat-card" key={`user:${row.mode}:${row.currency}`}><span className="stat-label">Solde disponible · {modeLabels[row.mode]}</span><div className="stat-value">{money(row.available_minor, row.currency)}</div><p className="stat-note">Récompenses et ventes nettes de frais · retrait depuis le portefeuille</p></article>)}
        {balances.data.campaign_escrow.map((row) => <article className="stat-card" key={`escrow:${row.mode}:${row.currency}`}><span className="stat-label">Séquestre de mes campagnes · {modeLabels[row.mode]}</span><div className="stat-value">{money(row.amount_minor, row.currency)}</div><p className="stat-note">Fonds réservés au paiement des testeurs</p></article>)}
      </div>}
    </div>
    {intents.loading ? <Loading /> : intents.error ? <div className="card-body"><ErrorState message={intents.error} /></div> : intents.data && (intents.data.intents.length === 0
      ? <EmptyState title="Aucun paiement sécurisé" description="Vos financements de campagnes et achats payés par carte ou mobile money apparaîtront ici." />
      : <div className="table-wrap"><table className="data-table"><caption className="small muted">Historique de vos paiements par prestataire</caption><thead><tr><th scope="col">Paiement</th><th scope="col">Date</th><th scope="col">Prestataire</th><th scope="col">Statut</th><th scope="col">Montant</th><th scope="col"><span className="pay-sr-only">Actions</span></th></tr></thead><tbody>
        {intents.data.intents.map((intent) => <tr key={intent.id}>
          <td><strong>{intent.title}</strong><span className="pay-sub">{purposeLabels[intent.purpose]} · {modeLabels[intent.mode]}</span></td>
          <td><time dateTime={intent.created_at}>{date(intent.created_at)}</time></td>
          <td>{intent.provider}{intent.customer_phone_masked && <span className="pay-sub pay-mono">{intent.customer_phone_masked}</span>}</td>
          <td><IntentStatusBadge intent={intent} />{intent.failure_reason && intent.status !== 'succeeded' && <span className="pay-sub">{intent.failure_reason}</span>}</td>
          <td className="pay-amount"><strong>−{money(intent.amount_minor, intent.currency)}</strong></td>
          <td>{intent.final ? <Link className="text-link small" to={intentDestination(intent).to}>{intentDestination(intent).label}</Link> : <Link className="text-link small" to={`/checkout/return?intent=${encodeURIComponent(intent.id)}`}>Suivre</Link>}</td>
        </tr>)}
      </tbody></table></div>)}
    {intents.data && <Pagination total={intents.data.total} limit={intents.data.limit} offset={intents.data.offset} section="paiements sécurisés" disabled={intents.loading} onChange={setOffset} />}
  </section>;
}
