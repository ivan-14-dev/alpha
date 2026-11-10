import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Download, ExternalLink, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, date, dateTime, errorMessage, money } from '../lib/api';
import { Badge, EmptyState, ErrorState, Loading, Modal } from '../components/ui';
import { KycStatusBadge, type KycAddress, type KycStatus } from '../components/KycForm';
import {
  countryName, modeLabels, payoutKindLabels, percentFromBps, toMajorInput, toMinor, WithdrawalStatusBadge, withdrawalStatusLabels,
  type InvoiceView, type PaymentMode, type WithdrawalStatus, type WithdrawalView,
} from '../components/PayoutStatus';
import '../styles/compliance.css';

/* Admin console: KYC review, withdrawals queue, invoices, limits, tax & issuer settings, accounting export. OWNER: compliance module.
 * Every action goes through /api/compliance/admin/* (requireAdmin + audit server-side). */

interface Summary {
  mode: PaymentMode; base_currency: string; base_exponent: number; kyc_pending: number;
  withdrawals: { on_hold: number; approved: number; processing: number; failed_30d: number };
  invoices_blocked: boolean; issuer_problems: string[]; invoices_total: number;
}
interface KycQueueItem { user_id: string; status: KycStatus; level: string; legal_name: string; country: string | null; submitted_at: string | null; reviewed_at: string | null; user_name: string; user_email: string; document_count: number }
interface KycDetail {
  user_id: string; user_name: string; user_email: string; user_created_at: string; status: KycStatus; level: string; legal_name: string;
  country: string | null; date_of_birth: string | null; address: KycAddress | null; submitted_at: string | null; reviewed_by: string | null; reviewed_at: string | null; rejection_reason: string;
  documents: { id: string; original_name: string; mime_type: string; size_bytes: number; scan_status: string; created_at: string; download_url: string }[];
}
interface AdminWithdrawal extends WithdrawalView {
  user_id: string; user_name: string; user_email: string; risk_level: string; hold_reason: string; reviewed_by: string | null; reviewed_at: string | null;
  payout_reference: string; provider_reference: string | null; processing_started_at: string | null; kyc_status: KycStatus;
}
interface AdminInvoice extends InvoiceView { user_id: string; user_name: string }
interface Limits { kyc_required_above_minor: number; min_withdrawal_minor: number; daily_limit_minor: number; monthly_limit_minor: number; manual_review_above_minor: number }
interface Retry { max_attempts: number; base_delay_seconds: number; status_check_seconds: number }
interface Tax { default_rate_bps: number; rates: Record<string, number>; prices_include_tax: boolean; exemption_mention: string }
interface Issuer { legal_name: string; address: string; registration_number: string; vat_number: string; legal_form: string; email: string; footer: string }
interface Settings {
  limits: { value: Limits; updated_at: string | null };
  payout_retry: { value: Retry; updated_at: string | null };
  tax: { value: Tax; updated_at: string | null };
  issuer: { value: Issuer; updated_at: string | null; problems: string[] };
}

const sections = [
  { id: 'kyc', label: 'Vérifications KYC' },
  { id: 'withdrawals', label: 'Retraits' },
  { id: 'invoices', label: 'Factures' },
  { id: 'settings', label: 'Limites & fiscalité' },
  { id: 'export', label: 'Export comptable' },
] as const;
type Section = typeof sections[number]['id'];

const PAGE = 50;
const post = (path: string, body: unknown = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
const riskTones: Record<string, string> = { low: 'green', medium: 'orange', high: 'red' };
const riskLabels: Record<string, string> = { low: 'Risque faible', medium: 'Risque moyen', high: 'Risque élevé' };
const scanStatusLabels: Record<string, string> = { pending: 'analyse en cours', clean: 'sain', skipped: 'non analysé (antivirus désactivé)', infected: 'menace détectée', error: 'erreur d’analyse' };

async function runJob(name: string): Promise<string> {
  const result = await api<{ status: string; error: string }>(`/system/admin/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });
  if (result.status !== 'ok') throw new Error(result.error || 'La tâche a échoué.');
  return 'Tâche exécutée.';
}

export default function ComplianceAdmin() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>('kyc');

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api<Summary>('/compliance/admin/summary'));
      setError('');
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);
  useEffect(() => { void loadSummary(); }, [loadSummary]);

  if (!summary) return error ? <ErrorState message={error} /> : <Loading />;
  const currency = summary.base_currency;

  return <div className="stack">
    <div className="stat-grid">
      <Stat label="Mode de paiement" value={modeLabels[summary.mode]} hint={summary.mode === 'demo' ? 'Aucun retrait possible.' : `Devise de base ${currency}`} />
      <Stat label="Dossiers KYC à examiner" value={String(summary.kyc_pending)} />
      <Stat label="Retraits à revoir" value={String(summary.withdrawals.on_hold)} hint={`${summary.withdrawals.approved} approuvé(s), ${summary.withdrawals.processing} en cours`} />
      <Stat label="Échecs de versement (30 j)" value={String(summary.withdrawals.failed_30d)} />
      <Stat label="Documents émis" value={String(summary.invoices_total)} hint="Reçus, factures de commission, relevés" />
    </div>
    {error && <ErrorState message={error} />}
    {(summary.invoices_blocked || summary.issuer_problems.length > 0) && <div className={`cmp-notice ${summary.invoices_blocked ? 'cmp-notice-warning' : 'cmp-notice-sandbox'}`} role="alert">
      <div><strong>{summary.invoices_blocked ? 'Émission des factures réelles bloquée' : 'Émetteur des factures incomplet'}</strong>
        Complétez l’identité de l’émetteur dans « Limites & fiscalité » : les factures du mode réel ne sont émises qu’avec des mentions complètes.
        <ul className="cmp-problems">{summary.issuer_problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>
    </div>}
    <div className="tabs" role="tablist" aria-label="Sections conformité">
      {sections.map((item) => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} className={`tab${section === item.id ? ' active' : ''}`} onClick={() => setSection(item.id)}>
        {item.label}
        {item.id === 'kyc' && summary.kyc_pending > 0 && <> <Badge tone="orange">{summary.kyc_pending}</Badge></>}
        {item.id === 'withdrawals' && summary.withdrawals.on_hold > 0 && <> <Badge tone="orange">{summary.withdrawals.on_hold}</Badge></>}
      </button>)}
    </div>
    {section === 'kyc' && <KycQueue onChange={() => { void loadSummary(); }} />}
    {section === 'withdrawals' && <WithdrawalsQueue mode={summary.mode} onChange={() => { void loadSummary(); }} />}
    {section === 'invoices' && <Invoices onChange={() => { void loadSummary(); }} />}
    {section === 'settings' && <SettingsPanel currency={currency} onChange={() => { void loadSummary(); }} />}
    {section === 'export' && <ExportPanel />}
    <p className="cmp-legal">Les seuils, taux et mentions proposés sont des modèles : ils doivent être validés par un expert-comptable et un juriste (LCB-FT, agrément de prestataire de paiement, mentions de facturation, TVA, déclaration DAC7) avant toute exploitation réelle.</p>
  </div>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stat-card"><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{hint && <span className="cmp-stat-hint">{hint}</span>}</div>;
}

function Feedback({ error, message }: { error: string; message: string }) {
  return <>{error && <div className="alert alert-error" role="alert">{error}</div>}{message && <div className="alert alert-success" role="status">{message}</div>}</>;
}

// ------------------------------------------------------------------ KYC

function KycQueue({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<KycStatus>('submitted');
  const [data, setData] = useState<{ total: number; profiles: KycQueueItem[] } | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<{ total: number; profiles: KycQueueItem[] }>(`/compliance/admin/kyc?status=${status}&limit=${PAGE}`));
      setError('');
    } catch (failure) { setError(errorMessage(failure)); }
  }, [status]);
  useEffect(() => { setData(null); void load(); }, [load]);

  return <section className="card">
    <div className="card-header"><h2>Dossiers d’identité</h2>
      <label className="field" htmlFor="kyc-filter">Statut
        <select id="kyc-filter" value={status} onChange={(event) => setStatus(event.target.value as KycStatus)}>
          <option value="submitted">À examiner</option><option value="approved">Approuvés</option><option value="rejected">Refusés</option><option value="draft">Brouillons</option>
        </select>
      </label>
    </div>
    {error && <div className="card-body"><ErrorState message={error} /></div>}
    {!data ? <Loading /> : data.profiles.length === 0
      ? <div className="card-body"><EmptyState title="Aucun dossier" description={status === 'submitted' ? 'Aucun dossier en attente de vérification.' : 'Aucun dossier dans cet état.'} /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Utilisateur</th><th>Nom légal</th><th>Pays</th><th>Envoyé le</th><th>Documents</th><th>Statut</th><th /></tr></thead>
        <tbody>{data.profiles.map((profile) => <tr key={profile.user_id}>
          <td>{profile.user_name}<span className="cmp-sub">{profile.user_email}</span></td>
          <td>{profile.legal_name || '—'}</td>
          <td>{countryName(profile.country)}</td>
          <td>{profile.submitted_at ? dateTime(profile.submitted_at) : '—'}</td>
          <td>{profile.document_count}</td>
          <td><KycStatusBadge status={profile.status} /></td>
          <td><button type="button" className="button button-secondary button-small" onClick={() => setSelected(profile.user_id)}>Examiner</button></td>
        </tr>)}</tbody>
      </table>{data.total > data.profiles.length && <p className="cmp-more small muted">{data.profiles.length} sur {data.total} affichés (les plus anciens d’abord).</p>}</div>}
    {selected && <KycReview userId={selected} onClose={() => setSelected(null)} onDecided={() => { setSelected(null); void load(); onChange(); }} />}
  </section>;
}

function KycReview({ userId, onClose, onDecided }: { userId: string; onClose: () => void; onDecided: () => void }) {
  const [detail, setDetail] = useState<KycDetail | null>(null);
  const [error, setError] = useState('');
  const [level, setLevel] = useState<'basic' | 'enhanced'>('basic');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    api<KycDetail>(`/compliance/admin/kyc/${encodeURIComponent(userId)}`).then((value) => { if (active) setDetail(value); }).catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [userId]);

  const decide = async (action: 'approve' | 'reject') => {
    if (action === 'reject' && reason.trim().length < 5) { setError('Indiquez un motif de refus (5 caractères minimum) : il sera communiqué à l’utilisateur.'); return; }
    setBusy(true); setError('');
    try {
      await post(`/compliance/admin/kyc/${encodeURIComponent(userId)}/${action}`, action === 'approve' ? { level, note: note.trim() } : { reason: reason.trim() });
      onDecided();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const address = detail?.address;
  return <Modal title="Dossier d’identité" onClose={onClose}>
    <div className="cmp-modal-body">
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {!detail ? !error && <Loading /> : <>
        <dl className="cmp-dl">
          <dt>Compte</dt><dd>{detail.user_name} · {detail.user_email}<span className="cmp-sub">Inscrit le {date(detail.user_created_at)}</span></dd>
          <dt>Statut</dt><dd><KycStatusBadge status={detail.status} />{detail.reviewed_at && <span className="cmp-sub">Décision du {dateTime(detail.reviewed_at)}</span>}</dd>
          <dt>Nom légal</dt><dd>{detail.legal_name || '—'}</dd>
          <dt>Date de naissance</dt><dd>{detail.date_of_birth ? date(`${detail.date_of_birth}T12:00:00Z`) : '—'}</dd>
          <dt>Pays</dt><dd>{countryName(detail.country)}</dd>
          <dt>Adresse</dt><dd>{address ? [address.line1, address.line2, [address.postal_code, address.city].filter(Boolean).join(' '), address.region].filter(Boolean).join(', ') : '—'}</dd>
          {detail.rejection_reason && <><dt>Dernier motif de refus</dt><dd>{detail.rejection_reason}</dd></>}
        </dl>
        <div>
          <h3>Pièces justificatives</h3>
          {detail.documents.length === 0 ? <p className="help-text">Aucun document.</p> : <ul className="cmp-docs">
            {detail.documents.map((document) => <li key={document.id}>
              <a href={document.download_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> {document.original_name}</a>
              <span className="small muted">{document.mime_type} · antivirus : {scanStatusLabels[document.scan_status] ?? document.scan_status}</span>
            </li>)}
          </ul>}
          <p className="help-text">Chaque consultation de dossier est journalisée. Ne téléchargez les pièces que sur un poste sécurisé.</p>
        </div>
        {detail.status === 'submitted' && <>
          <fieldset className="cmp-fieldset"><legend>Approuver</legend>
            <label className="field" htmlFor="kyc-level">Niveau
              <select id="kyc-level" value={level} onChange={(event) => setLevel(event.target.value as 'basic' | 'enhanced')}>
                <option value="basic">Standard (pièce d’identité)</option><option value="enhanced">Renforcé (identité + justificatif de domicile)</option>
              </select>
            </label>
            <label className="field" htmlFor="kyc-note">Note interne (facultatif)<input id="kyc-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <div className="cmp-actions cmp-actions-end"><button type="button" className="button button-primary" disabled={busy} onClick={() => { void decide('approve'); }}>Approuver l’identité</button></div>
          </fieldset>
          <fieldset className="cmp-fieldset"><legend>Refuser</legend>
            <label className="field" htmlFor="kyc-reason">Motif communiqué à l’utilisateur
              <textarea id="kyc-reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex. Document illisible : merci d’envoyer une photo nette du recto et du verso." />
            </label>
            <div className="cmp-actions cmp-actions-end"><button type="button" className="button button-danger" disabled={busy} onClick={() => { void decide('reject'); }}>Refuser le dossier</button></div>
          </fieldset>
        </>}
      </>}
    </div>
  </Modal>;
}

// ------------------------------------------------------------------ Withdrawals

type WithdrawalFilter = 'open' | 'all' | WithdrawalStatus;

function WithdrawalsQueue({ mode, onChange }: { mode: PaymentMode; onChange: () => void }) {
  const [filter, setFilter] = useState<WithdrawalFilter>('open');
  const [data, setData] = useState<{ total: number; withdrawals: AdminWithdrawal[] } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<{ withdrawal: AdminWithdrawal; action: 'approve' | 'reject' } | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api<{ total: number; withdrawals: AdminWithdrawal[] }>(`/compliance/admin/withdrawals?status=${filter}&limit=${PAGE}`));
      setError('');
    } catch (failure) { setError(errorMessage(failure)); }
  }, [filter]);
  useEffect(() => { setData(null); void load(); }, [load]);

  const action = async (work: () => Promise<string>) => {
    setBusy(true); setError(''); setMessage('');
    try {
      setMessage(await work());
      await load();
      onChange();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const retry = (withdrawal: AdminWithdrawal) => action(async () => {
    await post(`/compliance/admin/withdrawals/${encodeURIComponent(withdrawal.id)}/retry`);
    return 'Tentative programmée immédiatement : lancez les versements pour l’exécuter maintenant.';
  });

  return <section className="card">
    <div className="card-header"><h2>Retraits</h2>
      <div className="cmp-filters">
        <label className="field" htmlFor="withdrawal-filter">Statut
          <select id="withdrawal-filter" value={filter} onChange={(event) => setFilter(event.target.value as WithdrawalFilter)}>
            <option value="open">En cours (à traiter)</option><option value="all">Tous</option>
            {(Object.keys(withdrawalStatusLabels) as WithdrawalStatus[]).map((status) => <option key={status} value={status}>{withdrawalStatusLabels[status]}</option>)}
          </select>
        </label>
        <button type="button" className="button button-secondary button-small" disabled={busy || mode === 'demo'} onClick={() => { void action(() => runJob('compliance.payouts')); }}>
          <Play size={14} /> Lancer les versements
        </button>
      </div>
    </div>
    <div className="card-body"><Feedback error={error} message={message} />
      <p className="help-text">Les retraits approuvés sont versés automatiquement par la tâche « compliance.payouts » (toutes les minutes). Un refus recrédite immédiatement le solde de l’utilisateur. Un résultat inconnu du prestataire place le retrait en vérification sans recrédit : contrôlez le versement chez le prestataire avant de refuser.</p>
    </div>
    {!data ? <Loading /> : data.withdrawals.length === 0
      ? <div className="card-body"><EmptyState title="Aucun retrait" description="Aucun retrait ne correspond à ce filtre." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Demandé le</th><th>Utilisateur</th><th className="cmp-amount">Montant</th><th>Moyen</th><th>Risque</th><th>Statut</th><th /></tr></thead>
        <tbody>{data.withdrawals.map((withdrawal) => {
          const reviewable = withdrawal.status === 'on_hold' || withdrawal.status === 'requested';
          const rejectable = reviewable || withdrawal.status === 'approved';
          const retryable = withdrawal.status === 'approved' || (withdrawal.status === 'processing' && !!withdrawal.provider_reference);
          return <tr key={withdrawal.id}>
            <td>{dateTime(withdrawal.created_at)}<span className="cmp-sub">{withdrawal.mode === 'sandbox' ? 'Bac à sable' : 'Réel'}</span></td>
            <td>{withdrawal.user_name}<span className="cmp-sub">{withdrawal.user_email}</span><span className="cmp-sub">KYC : <KycStatusBadge status={withdrawal.kyc_status} /></span></td>
            <td className="cmp-amount">{money(withdrawal.amount_base_minor, withdrawal.base_currency)}
              {withdrawal.currency !== withdrawal.base_currency && <span className="cmp-sub">{money(withdrawal.amount_minor, withdrawal.currency)}</span>}</td>
            <td>{withdrawal.method ? <>{payoutKindLabels[withdrawal.method.kind]}<span className="cmp-sub cmp-mono">{withdrawal.method.display_mask}</span></> : '—'}<span className="cmp-sub">{withdrawal.provider}</span></td>
            <td><Badge tone={riskTones[withdrawal.risk_level] ?? 'neutral'}>{riskLabels[withdrawal.risk_level] ?? withdrawal.risk_level}</Badge>{withdrawal.hold_reason && <span className="cmp-sub">{withdrawal.hold_reason}</span>}</td>
            <td><WithdrawalStatusBadge status={withdrawal.status} />
              {withdrawal.attempts > 0 && <span className="cmp-sub">{withdrawal.attempts} tentative(s){withdrawal.next_attempt_at && ['approved', 'processing'].includes(withdrawal.status) ? `, prochaine ${dateTime(withdrawal.next_attempt_at)}` : ''}</span>}
              {withdrawal.failure_reason && <span className="cmp-sub">{withdrawal.failure_reason}</span>}
              {withdrawal.provider_reference && <span className="cmp-sub cmp-mono">{withdrawal.provider_reference}</span>}
              {withdrawal.review_note && <span className="cmp-sub">Note : {withdrawal.review_note}</span>}</td>
            <td><div className="cmp-table-actions">
              {reviewable && <button type="button" className="button button-primary button-small" disabled={busy} onClick={() => setDecision({ withdrawal, action: 'approve' })}>Approuver</button>}
              {rejectable && <button type="button" className="button button-danger button-small" disabled={busy} onClick={() => setDecision({ withdrawal, action: 'reject' })}>Rejeter</button>}
              {retryable && <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { void retry(withdrawal); }}><RefreshCw size={13} /> Relancer</button>}
            </div></td>
          </tr>;
        })}</tbody>
      </table>{data.total > data.withdrawals.length && <p className="cmp-more small muted">{data.withdrawals.length} sur {data.total} affichés.</p>}</div>}
    {decision && <WithdrawalDecision {...decision} onClose={() => setDecision(null)} onDone={(text) => { setDecision(null); setMessage(text); void load(); onChange(); }} />}
  </section>;
}

function WithdrawalDecision({ withdrawal, action, onClose, onDone }: { withdrawal: AdminWithdrawal; action: 'approve' | 'reject'; onClose: () => void; onDone: (message: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (action === 'reject' && text.trim().length < 5) { setError('Indiquez un motif (5 caractères minimum) : il sera communiqué à l’utilisateur.'); return; }
    setBusy(true); setError('');
    try {
      await post(`/compliance/admin/withdrawals/${encodeURIComponent(withdrawal.id)}/${action}`, action === 'approve' ? { note: text.trim() } : { reason: text.trim() });
      onDone(action === 'approve' ? 'Retrait approuvé : il sera versé au prochain passage de la tâche de versement.' : 'Retrait rejeté : le montant a été recrédité à l’utilisateur.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const amount = money(withdrawal.amount_base_minor, withdrawal.base_currency);
  return <Modal title={action === 'approve' ? 'Approuver le retrait' : 'Rejeter le retrait'} onClose={onClose}>
    <form className="form" onSubmit={submit}>
      <p>{withdrawal.user_name} — {amount} vers {withdrawal.method?.display_mask ?? '—'} ({withdrawal.provider}).</p>
      {withdrawal.hold_reason && <p className="help-text">Motif de mise en attente : {withdrawal.hold_reason}</p>}
      <label className="field" htmlFor="withdrawal-text">{action === 'approve' ? 'Note interne (facultatif)' : 'Motif communiqué à l’utilisateur'}
        <textarea id="withdrawal-text" rows={3} maxLength={500} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      {action === 'reject' && <p className="help-text">Le montant de {amount} sera recrédité sur le solde disponible de l’utilisateur.</p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="cmp-actions cmp-actions-end">
        <button type="button" className="button button-ghost" onClick={onClose} disabled={busy}>Annuler</button>
        <button type="submit" className={`button ${action === 'approve' ? 'button-primary' : 'button-danger'}`} disabled={busy}>{action === 'approve' ? 'Approuver' : 'Rejeter et recréditer'}</button>
      </div>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------ Invoices

function Invoices({ onChange }: { onChange: () => void }) {
  const [filters, setFilters] = useState({ from: '', to: '', kind: '' });
  const [items, setItems] = useState<AdminInvoice[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value)).toString();
  const load = useCallback(async (offset = 0) => {
    try {
      const page = await api<{ total: number; invoices: AdminInvoice[] }>(`/compliance/admin/invoices?limit=${PAGE}&offset=${offset}${query ? `&${query}` : ''}`);
      setItems((previous) => (offset ? [...(previous ?? []), ...page.invoices] : page.invoices));
      setTotal(page.total);
      setError('');
    } catch (failure) { setError(errorMessage(failure)); }
  }, [query]);
  useEffect(() => { setItems(null); void load(); }, [load]);

  const issue = async () => {
    setBusy(true); setError(''); setMessage('');
    try {
      await runJob('compliance.invoices');
      setMessage('Émission terminée.');
      await load();
      onChange();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return <section className="card">
    <div className="card-header"><h2>Factures, reçus et relevés</h2>
      <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { void issue(); }}><Play size={14} /> Émettre les documents en attente</button>
    </div>
    <div className="card-body stack">
      <div className="cmp-filters">
        <label className="field" htmlFor="invoice-from">Du<input id="invoice-from" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label className="field" htmlFor="invoice-to">Au<input id="invoice-to" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <label className="field" htmlFor="invoice-kind">Type
          <select id="invoice-kind" value={filters.kind} onChange={(event) => setFilters({ ...filters, kind: event.target.value })}>
            <option value="">Tous</option><option value="receipt">Reçus de paiement</option><option value="commission">Factures de commission</option><option value="payout_statement">Relevés de versement</option>
          </select>
        </label>
      </div>
      <Feedback error={error} message={message} />
      <p className="help-text">Les documents sont émis automatiquement (tâche « compliance.invoices », toutes les 5 minutes) à partir du grand livre, une seule fois par écriture, avec une numérotation continue par année (série « SBX » pour le bac à sable). Ils sont immuables : une erreur se corrige par un avoir ou une écriture d’ajustement.</p>
    </div>
    {!items ? <Loading /> : items.length === 0
      ? <div className="card-body"><EmptyState title="Aucun document" description="Aucun document ne correspond à ces critères." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Numéro</th><th>Type</th><th>Destinataire</th><th>Émis le</th><th className="cmp-amount">HT</th><th className="cmp-amount">TVA</th><th className="cmp-amount">TTC</th><th /></tr></thead>
        <tbody>{items.map((invoice) => <tr key={invoice.id}>
          <td className="cmp-mono">{invoice.number}</td>
          <td>{invoice.kind_label}<span className="cmp-sub">{invoice.description}</span></td>
          <td>{invoice.user_name}</td>
          <td>{dateTime(invoice.issued_at)}</td>
          <td className="cmp-amount">{money(invoice.amount_net_minor, invoice.currency)}</td>
          <td className="cmp-amount">{money(invoice.amount_tax_minor, invoice.currency)}<span className="cmp-sub">{percentFromBps(invoice.tax_rate_bps)}</span></td>
          <td className="cmp-amount">{money(invoice.amount_gross_minor, invoice.currency)}</td>
          <td><a className="button button-ghost button-small" href={invoice.html_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> Voir</a></td>
        </tr>)}</tbody>
      </table>
      {items.length < total && <div className="cmp-more"><button type="button" className="button button-secondary button-small" onClick={() => { void load(items.length); }}>Afficher plus</button></div>}</div>}
  </section>;
}

// ------------------------------------------------------------------ Settings

function SettingsPanel({ currency, onChange }: { currency: string; onChange: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<Settings>('/compliance/admin/settings').then((value) => { if (active) setSettings(value); }).catch((failure) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, []);
  if (!settings) return error ? <ErrorState message={error} /> : <Loading />;
  const save = async (name: keyof Settings, value: unknown) => {
    const next = await api<Settings>(`/compliance/admin/settings/${name}`, { method: 'PUT', body: JSON.stringify(value) });
    setSettings(next);
    onChange();
  };
  return <div className="two-column">
    <LimitsForm value={settings.limits.value} currency={currency} save={(value) => save('limits', value)} />
    <RetryForm value={settings.payout_retry.value} save={(value) => save('payout_retry', value)} />
    <TaxForm value={settings.tax.value} save={(value) => save('tax', value)} />
    <IssuerForm value={settings.issuer.value} problems={settings.issuer.problems} save={(value) => save('issuer', value)} />
  </div>;
}

function SettingsCard({ title, description, children, onSubmit }: { title: string; description: string; children: ReactNode; onSubmit: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(''); setMessage('');
    try {
      await onSubmit();
      setMessage('Réglages enregistrés.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return <section className="card">
    <div className="card-header"><h2>{title}</h2></div>
    <form className="card-body form" onSubmit={submit}>
      <p className="help-text">{description}</p>
      {children}
      <Feedback error={error} message={message} />
      <div className="cmp-actions cmp-actions-end"><button type="submit" className="button button-primary" disabled={busy}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button></div>
    </form>
  </section>;
}

const limitFields: { key: keyof Limits; label: string }[] = [
  { key: 'min_withdrawal_minor', label: 'Retrait minimum' },
  { key: 'daily_limit_minor', label: 'Plafond sur 24 heures glissantes' },
  { key: 'monthly_limit_minor', label: 'Plafond sur 30 jours glissants' },
  { key: 'kyc_required_above_minor', label: 'KYC obligatoire au-delà de (cumul 30 jours)' },
  { key: 'manual_review_above_minor', label: 'Revue manuelle au-delà de (par retrait)' },
];

function LimitsForm({ value, currency, save }: { value: Limits; currency: string; save: (value: Limits) => Promise<void> }) {
  const [form, setForm] = useState<Record<keyof Limits, string>>(() => Object.fromEntries(limitFields.map(({ key }) => [key, toMajorInput(value[key], currency)])) as Record<keyof Limits, string>);
  const submit = async () => {
    const parsed = {} as Limits;
    for (const { key, label } of limitFields) {
      const minor = toMinor(form[key], currency);
      if (minor === null) throw new Error(`Montant invalide : ${label}.`);
      parsed[key] = minor;
    }
    await save(parsed);
  };
  return <SettingsCard title="Limites de retrait" description={`Montants en ${currency} (devise de base), appliqués à chaque demande de retrait. Le seuil KYC s’apprécie sur le cumul des retraits des 30 derniers jours, conformément à une approche par les risques.`} onSubmit={submit}>
    <div className="form-grid">{limitFields.map(({ key, label }) => <label key={key} className="field" htmlFor={`limit-${key}`}>{label}
      <span className="cmp-inline-input"><input id={`limit-${key}`} inputMode="decimal" required value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} /><span className="cmp-currency">{currency}</span></span>
    </label>)}</div>
  </SettingsCard>;
}

function RetryForm({ value, save }: { value: Retry; save: (value: Retry) => Promise<void> }) {
  const [form, setForm] = useState({ max_attempts: String(value.max_attempts), base_delay_minutes: String(Math.round(value.base_delay_seconds / 60 * 100) / 100), status_check_minutes: String(Math.round(value.status_check_seconds / 60 * 100) / 100) });
  const submit = () => save({
    max_attempts: Number(form.max_attempts),
    base_delay_seconds: Math.round(Number(form.base_delay_minutes.replace(',', '.')) * 60),
    status_check_seconds: Math.round(Number(form.status_check_minutes.replace(',', '.')) * 60),
  });
  return <SettingsCard title="Nouvelles tentatives de versement" description="Après un refus du prestataire, le versement est retenté avec un délai qui double à chaque essai (24 h maximum). Au-delà du nombre de tentatives, le retrait échoue et le montant est recrédité." onSubmit={submit}>
    <div className="form-grid">
      <label className="field" htmlFor="retry-max">Nombre maximal de tentatives<input id="retry-max" type="number" min={1} max={10} required value={form.max_attempts} onChange={(event) => setForm({ ...form, max_attempts: event.target.value })} /></label>
      <label className="field" htmlFor="retry-delay">Délai avant la 2ᵉ tentative (minutes)<input id="retry-delay" inputMode="decimal" required value={form.base_delay_minutes} onChange={(event) => setForm({ ...form, base_delay_minutes: event.target.value })} /></label>
      <label className="field" htmlFor="retry-check">Vérification d’un versement en attente (minutes)<input id="retry-check" inputMode="decimal" required value={form.status_check_minutes} onChange={(event) => setForm({ ...form, status_check_minutes: event.target.value })} /></label>
    </div>
  </SettingsCard>;
}

const percentToBps = (value: string) => {
  const number = Number(value.replace(',', '.').replace('%', '').trim());
  if (!Number.isFinite(number) || number < 0 || number > 100) return null;
  return Math.round(number * 100);
};
const bpsToPercent = (bps: number) => String(bps / 100).replace('.', ',');

function TaxForm({ value, save }: { value: Tax; save: (value: Tax) => Promise<void> }) {
  const [rate, setRate] = useState(bpsToPercent(value.default_rate_bps));
  const [rates, setRates] = useState(() => Object.entries(value.rates).map(([country, bps]) => ({ country, rate: bpsToPercent(bps) })));
  const [inclusive, setInclusive] = useState(value.prices_include_tax);
  const [mention, setMention] = useState(value.exemption_mention);
  const submit = async () => {
    const defaultBps = percentToBps(rate);
    if (defaultBps === null) throw new Error('Taux par défaut invalide.');
    const byCountry: Record<string, number> = {};
    for (const row of rates) {
      const country = row.country.trim().toUpperCase();
      const bps = percentToBps(row.rate);
      if (!/^[A-Z]{2}$/.test(country)) throw new Error(`Code pays invalide : « ${row.country} ».`);
      if (bps === null) throw new Error(`Taux invalide pour ${country}.`);
      if (country in byCountry) throw new Error(`Le pays ${country} apparaît deux fois.`);
      byCountry[country] = bps;
    }
    await save({ default_rate_bps: defaultBps, rates: byCountry, prices_include_tax: inclusive, exemption_mention: mention.trim() });
  };
  return <SettingsCard title="Taxes (TVA)" description="Taux appliqué à la commission de la plateforme, selon le pays de résidence vérifié du bénéficiaire (taux par défaut sinon). Exemples : France 20 %, Cameroun 19,25 %, Sénégal 18 %, Côte d’Ivoire 18 %. À valider avec votre expert-comptable (autoliquidation B2B, guichet OSS…)." onSubmit={submit}>
    <label className="field" htmlFor="tax-default">Taux par défaut (%)<input id="tax-default" inputMode="decimal" required value={rate} onChange={(event) => setRate(event.target.value)} /></label>
    <div className="cmp-rates">
      <span className="field">Taux par pays</span>
      {rates.map((row, index) => <div key={index} className="cmp-rate-row">
        <input aria-label="Code pays ISO" maxLength={2} placeholder="FR" value={row.country} onChange={(event) => setRates(rates.map((item, position) => position === index ? { ...item, country: event.target.value.toUpperCase() } : item))} />
        <input aria-label={`Taux pour ${row.country || 'ce pays'} (%)`} inputMode="decimal" placeholder="20" value={row.rate} onChange={(event) => setRates(rates.map((item, position) => position === index ? { ...item, rate: event.target.value } : item))} />
        <button type="button" className="button button-ghost button-small" onClick={() => setRates(rates.filter((_, position) => position !== index))} aria-label={`Supprimer le taux ${row.country}`}><Trash2 size={13} /></button>
      </div>)}
      <div><button type="button" className="button button-secondary button-small" onClick={() => setRates([...rates, { country: '', rate: '' }])}><Plus size={13} /> Ajouter un pays</button></div>
    </div>
    <label className="cmp-checkbox"><input type="checkbox" checked={inclusive} onChange={(event) => setInclusive(event.target.checked)} /> La commission prélevée s’entend toutes taxes comprises (TTC) : la TVA est extraite du montant prélevé.</label>
    <label className="field" htmlFor="tax-mention">Mention en cas de taux nul (facultatif)
      <input id="tax-mention" maxLength={300} placeholder="Ex. TVA non applicable, art. 293 B du CGI — ou — Autoliquidation" value={mention} onChange={(event) => setMention(event.target.value)} />
    </label>
  </SettingsCard>;
}

function IssuerForm({ value, problems, save }: { value: Issuer; problems: string[]; save: (value: Issuer) => Promise<void> }) {
  const [form, setForm] = useState(value);
  const field = (key: keyof Issuer, label: string, options: { textarea?: boolean; placeholder?: string; max: number; type?: string }) => <label className="field" htmlFor={`issuer-${key}`}>{label}
    {options.textarea
      ? <textarea id={`issuer-${key}`} rows={key === 'footer' ? 4 : 3} maxLength={options.max} placeholder={options.placeholder} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
      : <input id={`issuer-${key}`} type={options.type ?? 'text'} maxLength={options.max} placeholder={options.placeholder} value={form[key]} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />}
  </label>;
  return <SettingsCard title="Émetteur des factures" description="Identité légale imprimée sur chaque document. Raison sociale, adresse et immatriculation sont obligatoires pour émettre les factures du mode réel." onSubmit={() => save(form)}>
    {problems.length > 0 && <div className="cmp-notice cmp-notice-warning"><div><strong>À compléter</strong><ul className="cmp-problems">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div></div>}
    <div className="form-grid">
      {field('legal_name', 'Raison sociale', { max: 160, placeholder: 'Alpha SAS' })}
      {field('legal_form', 'Forme juridique et capital', { max: 160, placeholder: 'SAS au capital de 10 000 €' })}
      {field('registration_number', 'Immatriculation (SIREN/RCS ou RCCM)', { max: 120, placeholder: 'RCS Paris 123 456 789' })}
      {field('vat_number', 'N° de TVA intracommunautaire / NIU', { max: 40, placeholder: 'FR12 123456789' })}
      {field('email', 'E-mail de facturation', { max: 254, type: 'email', placeholder: 'factures@exemple.fr' })}
    </div>
    {field('address', 'Adresse du siège', { textarea: true, max: 500 })}
    {field('footer', 'Mentions légales de bas de page', { textarea: true, max: 2000, placeholder: 'Pénalités de retard : 3 fois le taux d’intérêt légal. Indemnité forfaitaire pour frais de recouvrement : 40 €. Pas d’escompte pour paiement anticipé.' })}
  </SettingsCard>;
}

// ------------------------------------------------------------------ Export

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

function ExportPanel() {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))));
  const [to, setTo] = useState(isoDay(today));
  const [mode, setMode] = useState('');
  const [separator, setSeparator] = useState<'semicolon' | 'comma'>('semicolon');
  const days = from && to ? (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000 + 1 : 0;
  const problem = !from || !to ? 'Choisissez une période.' : days <= 0 ? 'La date de fin doit suivre la date de début.' : days > 366 ? 'La période ne peut pas dépasser 366 jours.' : '';
  const query = new URLSearchParams({ from, to, sep: separator, ...(mode ? { mode } : {}) }).toString();
  return <section className="card">
    <div className="card-header"><h2>Export comptable des journaux</h2></div>
    <div className="card-body form">
      <p className="help-text">Toutes les écritures du grand livre de la période (dates UTC incluses), avec les numéros des documents émis. Le fichier est protégé contre l’injection de formules dans les tableurs. Chaque export est journalisé.</p>
      <div className="cmp-filters">
        <label className="field" htmlFor="export-from">Du<input id="export-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
        <label className="field" htmlFor="export-to">Au<input id="export-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label className="field" htmlFor="export-mode">Mode
          <select id="export-mode" value={mode} onChange={(event) => setMode(event.target.value)}><option value="">Tous</option><option value="live">Réel</option><option value="sandbox">Bac à sable</option></select>
        </label>
        <label className="field" htmlFor="export-sep">Séparateur
          <select id="export-sep" value={separator} onChange={(event) => setSeparator(event.target.value as 'semicolon' | 'comma')}><option value="semicolon">Point-virgule (Excel FR)</option><option value="comma">Virgule</option></select>
        </label>
      </div>
      {problem ? <div className="alert alert-error" role="alert">{problem}</div>
        : <div><a className="button button-primary" href={`/api/compliance/admin/exports/journals.csv?${query}`} download><Download size={15} /> Télécharger le CSV</a></div>}
    </div>
  </section>;
}
