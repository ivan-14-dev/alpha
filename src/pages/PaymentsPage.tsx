import { useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, CircleDollarSign, Clock3, Landmark, ReceiptText, RefreshCw, ShieldCheck } from 'lucide-react';
import { Avatar, Badge, DemoNotice, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, date, errorMessage, money } from '../lib/api';
import { useAuth } from '../lib/auth';

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
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const refreshing = summary.loading || campaigns.loading || missions.loading || transactions.loading;
  const stats = summary.data?.summary;
  const fundingAmount = confirmation?.kind === 'funding' ? amountInCents(confirmation.amount) : null;

  function reloadAll() {
    summary.reload();
    campaigns.reload();
    missions.reload();
    transactions.reload();
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
      action={<div className="row gap-sm"><Badge tone="purple"><ShieldCheck size={14} aria-hidden="true" /> Mode démo</Badge><button type="button" className="button button-secondary" disabled={pending || refreshing} onClick={reloadAll}><RefreshCw size={16} aria-hidden="true" /> Actualiser</button></div>} />
    <DemoNotice />
    <p className="small muted">Toutes les valeurs sont simulées, en euros. Les gains sont un cumul d’activité, pas un solde de portefeuille. Aucun retrait ni transfert bancaire n’est disponible.</p>
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
            return <article className="card" key={campaign.id}>
              <div className="card-header row row-between"><h3>{campaign.title}</h3><Badge tone={campaign.status === 'open' ? 'green' : 'neutral'}>{campaign.status === 'open' ? 'Ouverte' : 'Fermée'}</Badge></div>
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
              <div className="card-footer">
                {campaign.status === 'open' && campaign.remaining_cents > 0
                  ? <button type="button" className="button button-primary full-width" disabled={pending} aria-label={`Financer ${campaign.title}, reste ${money(campaign.remaining_cents)}`} onClick={() => openConfirmation({ kind: 'funding', campaign, amount: (campaign.remaining_cents / 100).toFixed(2) })}><CircleDollarSign size={17} aria-hidden="true" /> Financer le budget</button>
                  : <span className="small muted">{campaign.remaining_cents === 0 ? 'Budget entièrement financé en démo' : 'Financement indisponible : campagne fermée'}</span>}
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
