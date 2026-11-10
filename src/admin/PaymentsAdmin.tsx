import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Copy, ExternalLink, Plus, RefreshCw, Scale, ShieldAlert, Trash2 } from 'lucide-react';
import { api, dateTime, errorMessage, money } from '../lib/api';
import { Badge, EmptyState, ErrorState, Loading, Modal } from '../components/ui';
import {
  IntentStatusBadge, intentStatusLabels, methodLabels, modeLabels, purposeLabels,
  type IntentStatus, type PaymentMode, type PublicIntent,
} from '../components/CheckoutStatus';
import '../styles/payments.css';

/* Admin payments console: mode switch, providers × environments, fees & FX, intents, webhooks, refunds, ledger. OWNER: payments core.
 * Every call goes through /api/payments/admin/* (requireAdmin + audit server-side). Secrets never come back: only "configured" + a mask. */

type Environment = 'sandbox' | 'live';
interface Amount { mode: Environment; currency: string; total: number }
interface Fees { testing_fee_bps: number; marketplace_fee_bps: number }
interface WebhookEvent {
  id: string; provider: string; event_key?: string; mode?: Environment | null; event_type: string; event_status: string; reference: string | null;
  provider_reference: string | null; intent_id: string | null; status?: WebhookStatus; error: string; attempts: number; received_at: string; processed_at?: string | null;
}
type WebhookStatus = 'received' | 'processed' | 'ignored' | 'failed';
interface Overview {
  mode: PaymentMode; base_currency: string; fees: Fees; ledger_balanced: boolean;
  volumes: { mode: Environment; currency: string; purpose: PublicIntent['purpose']; count: number; amount_minor: number; amount_base_minor: number }[];
  intents_by_status: { mode: Environment; status: IntentStatus; count: number }[];
  escrow: Amount[]; platform_fees: Amount[]; member_balances: Amount[];
  alerts: { review_required: number; unapplied: number; failed_webhooks: number; failed_refunds: number; pending_refunds: number };
  recent_failed_webhooks: WebhookEvent[];
  live_problems: string[];
}
interface Field { key: string; label: string; secret: boolean; required: boolean; help?: string; options?: string[]; placeholder?: string }
interface EnvConfig {
  id: string; environment: Environment; enabled: boolean; settings: Record<string, string>;
  secrets: Record<string, { configured: boolean; mask: string }>; problems: string[]; webhook_url: string; updated_at: string | null; available?: boolean;
}
interface ProviderView {
  id: string; label: string; countries: string[]; currencies: string[]; methods: string[];
  capabilities: { collect: boolean; payout: boolean; refund: boolean; webhooks: 'signed' | 'unsigned' | 'none' };
  docs_url: string; fields: Field[]; webhook_url: string; environments: Record<Environment, EnvConfig>;
}
interface Settings { base_currency: string; base_currency_locked: boolean; fx: Record<string, number>; fees: Fees; currencies: string[] }
interface AdminIntent extends PublicIntent {
  user_id: string; payer_name: string; payer_email: string; fx_rate: number; attempts: number;
  next_check_at: string | null; last_checked_at: string | null; settled_journal_id: string | null;
}
type RefundStatus = 'pending' | 'processing' | 'succeeded' | 'failed';
interface Refund {
  id: string; intent_id: string; order_id: string | null; campaign_id: string | null; journal_id: string | null; mode: Environment; provider: string;
  amount_base_minor: number; base_currency: string; amount_minor: number; currency: string; reason: string; provider_reference: string | null;
  status: RefundStatus; attempts: number; last_error: string; next_attempt_at: string | null; created_at: string; updated_at: string;
}
interface Journal {
  id: string; kind: string; mode: Environment; currency: string; ref_type: string; ref_id: string; memo: string; created_by?: string | null; created_at: string;
  entries?: { account: string; amount_minor: number }[];
}

const LIVE_CONFIRMATION = 'ACTIVER LE MODE RÉEL';
const PAGE = 50;
const sections = [
  { id: 'overview', label: 'Vue d’ensemble' },
  { id: 'providers', label: 'Prestataires' },
  { id: 'settings', label: 'Frais & devises' },
  { id: 'intents', label: 'Paiements' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'refunds', label: 'Remboursements' },
  { id: 'ledger', label: 'Grand livre' },
] as const;
type Section = typeof sections[number]['id'];

const knownProviders = ['simulator', 'stripe', 'flutterwave', 'campay', 'mtn_momo', 'orange_money', 'wave', 'kratos_pay'];
const environmentLabels: Record<Environment, string> = { sandbox: 'Bac à sable', live: 'Production (live)' };
const modeDescriptions: Record<PaymentMode, string> = {
  demo: 'Comportement V3 : paiements simulés, aucun prestataire appelé. Les fonds bac à sable ou réels déjà en séquestre restent gérés.',
  sandbox: 'Environnements de test des prestataires et simulateur intégré : parcours complets sans argent réel.',
  live: 'Encaissements réels via les prestataires configurés en production. Exige HTTPS, ALPHA_SECRETS_KEY et un prestataire valide.',
};
const modeTones: Record<PaymentMode, string> = { demo: 'orange', sandbox: 'blue', live: 'green' };
const webhookStatusLabels: Record<WebhookStatus, string> = { received: 'Reçu', processed: 'Traité', ignored: 'Ignoré', failed: 'En échec' };
const webhookStatusTones: Record<WebhookStatus, string> = { received: 'blue', processed: 'green', ignored: 'neutral', failed: 'red' };
const refundStatusLabels: Record<RefundStatus, string> = { pending: 'En attente', processing: 'En cours', succeeded: 'Remboursé', failed: 'En échec' };
const refundStatusTones: Record<RefundStatus, string> = { pending: 'orange', processing: 'blue', succeeded: 'green', failed: 'red' };
const journalKindLabels: Record<string, string> = {
  'campaign.funded': 'Campagne financée', 'mission.paid': 'Mission payée', 'campaign.refunded': 'Campagne remboursée',
  'order.paid': 'Commande payée', 'order.released': 'Commande versée', 'order.refunded': 'Commande remboursée', adjustment: 'Ajustement manuel',
};
const webhookCapabilityLabels = { signed: 'Webhooks signés', unsigned: 'Webhooks non signés (re-vérifiés)', none: 'Sans webhook (interrogation)' };

const put = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
const percent = (bps: number) => `${(bps / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
function amounts(rows: Amount[]) {
  const visible = rows.filter((row) => row.total !== 0);
  return visible.length ? visible.map((row) => `${money(row.total, row.currency)} · ${modeLabels[row.mode] ?? row.mode}`).join(' — ') : '—';
}
function query(values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== '' && value !== false) params.set(key, String(value));
  return params.toString();
}

export default function PaymentsAdmin() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [section, setSection] = useState<Section>('overview');

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api<Overview>('/payments/admin/overview'));
      setError('');
    } catch (failure) { setError(errorMessage(failure)); }
  }, []);
  useEffect(() => { void loadOverview(); }, [loadOverview]);

  if (!overview) return error ? <ErrorState message={error} /> : <Loading />;
  const { alerts } = overview;
  const toReview = alerts.review_required + alerts.unapplied;
  const refresh = () => { void loadOverview(); };

  return <div className="pay-admin">
    <ModeBanner mode={overview.mode} />
    <div className="stat-grid">
      <Stat label="Mode de paiement" value={modeLabels[overview.mode]} hint={`Devise de référence ${overview.base_currency}`} />
      <Stat label="Grand livre" value={overview.ledger_balanced ? 'Équilibré' : 'Déséquilibré'} hint="Somme des écritures par mode et devise" />
      <Stat label="Fonds en séquestre" value={amounts(overview.escrow)} />
      <Stat label="Commissions encaissées" value={amounts(overview.platform_fees)} hint={`Tests ${percent(overview.fees.testing_fee_bps)} · marketplace ${percent(overview.fees.marketplace_fee_bps)}`} />
      <Stat label="Soldes des membres" value={amounts(overview.member_balances)} hint="Disponibles au retrait (module conformité)" />
    </div>
    {error && <ErrorState message={error} />}
    {!overview.ledger_balanced && <div className="pay-banner pay-banner-danger" role="alert"><Scale size={18} aria-hidden="true" />
      <div><strong>Grand livre déséquilibré</strong>Une écriture ne s’annule pas. Les mouvements continuent d’être refusés s’ils sont incohérents ; vérifiez l’onglet « Grand livre » et contactez l’équipe technique.</div></div>}
    <div className="tabs" role="tablist" aria-label="Sections paiements">
      {sections.map((item) => <button key={item.id} type="button" role="tab" aria-selected={section === item.id} className={`tab${section === item.id ? ' active' : ''}`} onClick={() => setSection(item.id)}>
        {item.label}
        {item.id === 'intents' && toReview > 0 && <> <Badge tone="orange">{toReview}</Badge></>}
        {item.id === 'webhooks' && alerts.failed_webhooks > 0 && <> <Badge tone="red">{alerts.failed_webhooks}</Badge></>}
        {item.id === 'refunds' && alerts.failed_refunds > 0 && <> <Badge tone="red">{alerts.failed_refunds}</Badge></>}
      </button>)}
    </div>
    {section === 'overview' && <OverviewSection overview={overview} onChange={refresh} onOpen={setSection} />}
    {section === 'providers' && <ProvidersSection onChange={refresh} />}
    {section === 'settings' && <SettingsSection onChange={refresh} />}
    {section === 'intents' && <IntentsSection onChange={refresh} />}
    {section === 'webhooks' && <WebhooksSection />}
    {section === 'refunds' && <RefundsSection onChange={refresh} />}
    {section === 'ledger' && <LedgerSection baseCurrency={overview.base_currency} onChange={refresh} />}
  </div>;
}

function ModeBanner({ mode }: { mode: PaymentMode }) {
  const text: Record<PaymentMode, [string, string]> = {
    demo: ['Mode démonstration', 'Aucun prestataire n’est appelé : les parcours simulés de la V3 sont utilisés pour les financements et les achats.'],
    sandbox: ['Mode bac à sable', 'Les paiements passent par les environnements de test des prestataires ou le simulateur intégré. Aucun argent réel.'],
    live: ['Paiements réels actifs', 'Les cartes et comptes mobile money des membres sont réellement débités. Surveillez les alertes et les webhooks en échec.'],
  };
  return <div className={`pay-banner pay-banner-${mode}`} role="status"><ShieldAlert size={18} aria-hidden="true" />
    <div><strong>{text[mode][0]}</strong>{text[mode][1]}</div></div>;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <div className="stat-card"><span className="stat-label">{label}</span><strong className="stat-value">{value}</strong>{hint && <span className="pay-sub">{hint}</span>}</div>;
}

function Feedback({ error, message, warnings = [] }: { error: string; message: string; warnings?: string[] }) {
  return <>
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    {message && <div className="alert alert-success" role="status">{message}</div>}
    {warnings.length > 0 && <div className="pay-banner pay-banner-warning" role="status"><ShieldAlert size={18} aria-hidden="true" />
      <div><strong>À noter</strong><ul className="pay-problems">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></div></div>}
  </>;
}

function Pager({ total, offset, onChange }: { total: number; offset: number; onChange: (offset: number) => void }) {
  if (total <= PAGE) return null;
  return <div className="row row-between card-body">
    <span className="small muted">{offset + 1}–{Math.min(offset + PAGE, total)} sur {total}</span>
    <div className="row gap-sm">
      <button type="button" className="button button-ghost button-small" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE))}>Précédent</button>
      <button type="button" className="button button-ghost button-small" disabled={offset + PAGE >= total} onClick={() => onChange(offset + PAGE)}>Suivant</button>
    </div>
  </div>;
}

function LegalNotice() {
  return <div className="pay-banner pay-banner-warning pay-legal"><ShieldAlert size={18} aria-hidden="true" /><div>
    <strong>Avant d’encaisser de l’argent réel</strong>
    <ul>
      <li>Conserver des fonds pour le compte de tiers (séquestre, reversement aux testeurs et vendeurs) est une activité de services de paiement réglementée
        (agrément d’établissement de paiement ou de monnaie électronique en France/UE ; réglementations BEAC/COBAC et BCEAO en Afrique centrale et de l’Ouest).</li>
      <li>Sans agrément propre, passez par un partenaire régulé ou par les produits « marketplace » des prestataires (comptes connectés, sous-comptes,
        paiements fractionnés) afin que les fonds ne transitent pas par un compte de la plateforme.</li>
      <li>Faites valider par un avocat les CGU/CGV, le mandat d’encaissement, la politique de remboursement, la fiscalité (TVA, DAC7) et les obligations LCB-FT.</li>
      <li>Les litiges et rétrofacturations (chargebacks) peuvent être débités après versement au bénéficiaire : prévoyez une réserve et une procédure.</li>
    </ul>
  </div></div>;
}

// ------------------------------------------------------------------ overview & mode

function OverviewSection({ overview, onChange, onOpen }: { overview: Overview; onChange: () => void; onOpen: (section: Section) => void }) {
  const { alerts } = overview;
  const allAlerts: { count: number; label: string; section: Section }[] = [
    { count: alerts.review_required, label: 'paiement(s) à examiner (montant ou devise incohérents)', section: 'intents' },
    { count: alerts.unapplied, label: 'paiement(s) encaissé(s) mais non appliqué(s)', section: 'intents' },
    { count: alerts.failed_webhooks, label: 'webhook(s) en échec', section: 'webhooks' },
    { count: alerts.failed_refunds, label: 'remboursement(s) en échec', section: 'refunds' },
    { count: alerts.pending_refunds, label: 'remboursement(s) en attente du prestataire', section: 'refunds' },
  ];
  const alertItems = allAlerts.filter((item) => item.count > 0);

  return <div className="pay-admin">
    <ModeSwitch overview={overview} onChange={onChange} />
    <section className="card"><div className="card-header"><h2>Problèmes et alertes</h2></div><div className="card-body stack">
      {alertItems.length === 0 && overview.live_problems.length === 0 && <p className="text-success small">Aucune alerte.</p>}
      {alertItems.length > 0 && <ul className="pay-problems">{alertItems.map((item) => <li key={item.label}>
        <strong>{item.count}</strong> {item.label} — <button type="button" className="button button-ghost button-small" onClick={() => onOpen(item.section)}>Voir</button>
      </li>)}</ul>}
      {overview.live_problems.length > 0 && <div><strong className="small">Pré-requis du mode réel manquants</strong>
        <ul className="pay-problems">{overview.live_problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div>}
    </div></section>
    <section className="card"><div className="card-header"><h2>Volumes encaissés</h2></div>
      {overview.volumes.length === 0 ? <div className="card-body"><EmptyState title="Aucun encaissement" description="Les paiements réussis en bac à sable ou en réel apparaîtront ici." /></div>
        : <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Mode</th><th>Objet</th><th>Devise</th><th>Nombre</th><th>Montant</th><th>Équivalent {overview.base_currency}</th></tr></thead>
          <tbody>{overview.volumes.map((row) => <tr key={`${row.mode}:${row.currency}:${row.purpose}`}>
            <td><Badge tone={modeTones[row.mode]}>{modeLabels[row.mode]}</Badge></td><td>{purposeLabels[row.purpose] ?? row.purpose}</td><td>{row.currency}</td>
            <td>{row.count}</td><td className="pay-amount">{money(row.amount_minor, row.currency)}</td><td className="pay-amount">{money(row.amount_base_minor, overview.base_currency)}</td>
          </tr>)}</tbody>
        </table></div>}
      {overview.intents_by_status.length > 0 && <div className="card-body"><p className="small muted">
        {overview.intents_by_status.map((row) => `${modeLabels[row.mode]} · ${intentStatusLabels[row.status] ?? row.status} : ${row.count}`).join(' — ')}</p></div>}
    </section>
    {overview.recent_failed_webhooks.length > 0 && <section className="card"><div className="card-header"><h2>Derniers webhooks en échec</h2></div>
      <WebhookTable events={overview.recent_failed_webhooks} /></section>}
  </div>;
}

function ModeSwitch({ overview, onChange }: { overview: Overview; onChange: () => void }) {
  const [target, setTarget] = useState<PaymentMode | null>(null);
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  return <section className="card"><div className="card-header"><h2>Mode des paiements</h2></div><div className="card-body stack">
    <Feedback error="" message={message} warnings={warnings} />
    <div className="pay-mode-switch" role="group" aria-label="Choisir le mode des paiements">
      {(['demo', 'sandbox', 'live'] as const).map((mode) => <button key={mode} type="button" aria-pressed={overview.mode === mode}
        className={`pay-mode-card${overview.mode === mode ? ' is-active' : ''}${mode === 'live' ? ' is-live' : ''}`}
        onClick={() => { if (overview.mode !== mode) { setMessage(''); setWarnings([]); setTarget(mode); } }}>
        <span className="row row-between"><strong>{modeLabels[mode]}</strong>{overview.mode === mode && <Badge tone={modeTones[mode]}>Actif</Badge>}</span>
        <span className="small muted">{modeDescriptions[mode]}</span>
        {mode === 'live' && overview.mode !== 'live' && overview.live_problems.length > 0 && <span className="small text-warning">{overview.live_problems.length} pré-requis manquant(s)</span>}
      </button>)}
    </div>
    <LegalNotice />
    {target && <ModeDialog overview={overview} target={target} onClose={() => setTarget(null)} onDone={(result) => {
      setTarget(null); setMessage(`Mode « ${modeLabels[result.mode]} » activé.`); setWarnings(result.warnings); onChange();
    }} />}
  </div></section>;
}

function ModeDialog({ overview, target, onClose, onDone }: {
  overview: Overview; target: PaymentMode; onClose: () => void; onDone: (result: { mode: PaymentMode; warnings: string[] }) => void;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const live = target === 'live';
  const heldInCurrent = overview.mode !== 'demo' ? overview.escrow.filter((row) => row.mode === overview.mode && row.total !== 0) : [];
  const confirmed = !live || (confirmation.normalize('NFC').trim() === LIVE_CONFIRMATION && acknowledged && overview.live_problems.length === 0);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed) return;
    setPending(true); setError('');
    try {
      onDone(await put<{ mode: PaymentMode; previous: PaymentMode; warnings: string[] }>('/payments/admin/mode', live ? { mode: target, confirmation } : { mode: target }));
    } catch (failure) { setError(errorMessage(failure)); setPending(false); }
  }

  return <Modal title={`Passer en mode « ${modeLabels[target]} »`} onClose={() => { if (!pending) onClose(); }}>
    <form className="form" onSubmit={submit}>
      <p>{modeDescriptions[target]}</p>
      {heldInCurrent.length > 0 && <div className="pay-banner pay-banner-warning"><ShieldAlert size={18} aria-hidden="true" /><div>
        <strong>Des fonds restent en séquestre en mode {modeLabels[overview.mode]}</strong>
        {amounts(heldInCurrent)}. Ils resteront gérés (versements, remboursements, réconciliation), mais aucun nouveau paiement {modeLabels[overview.mode].toLowerCase()} ne sera accepté.
      </div></div>}
      {target === 'demo' && <p className="help-text">En démonstration, les campagnes et commandes déjà financées en argent réel ou en bac à sable restent verrouillées sur leur mode.</p>}
      {live && <>
        <LegalNotice />
        {overview.live_problems.length > 0 && <div className="pay-banner pay-banner-danger" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div>
          <strong>Activation impossible pour le moment</strong><ul className="pay-problems">{overview.live_problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div></div>}
        <label className="pay-checkbox"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
          <span>Je confirme que le montage juridique (agrément ou partenaire régulé, CGU, politique de remboursement) a été validé par un avocat.</span></label>
        <label className="field">Pour confirmer, saisissez « {LIVE_CONFIRMATION} »
          <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
      </>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="pay-actions">
        <button type="button" className="button button-ghost" onClick={onClose} disabled={pending}>Annuler</button>
        <button type="submit" className={`button ${live ? 'button-danger' : 'button-primary'}`} disabled={pending || !confirmed}>{pending ? 'Activation…' : `Activer « ${modeLabels[target]} »`}</button>
      </div>
    </form>
  </Modal>;
}

// ------------------------------------------------------------------ providers

function ProvidersSection({ onChange }: { onChange: () => void }) {
  const [data, setData] = useState<{ mode: PaymentMode; providers: ProviderView[] } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api<{ mode: PaymentMode; providers: ProviderView[] }>('/payments/admin/providers')); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!data) return error ? <ErrorState message={error} /> : <Loading />;
  return <div className="pay-admin-section">
    {error && <ErrorState message={error} />}
    <p className="small muted">Chaque prestataire se configure séparément pour le bac à sable et la production. Les secrets sont chiffrés au repos
      (ALPHA_SECRETS_KEY) et ne sont jamais réaffichés. Déclarez l’URL de webhook dans le tableau de bord du prestataire.</p>
    <div className="pay-provider-grid">
      {data.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} mode={data.mode} onSaved={() => { void load(); onChange(); }} />)}
    </div>
  </div>;
}

function ProviderCard({ provider, mode, onSaved }: { provider: ProviderView; mode: PaymentMode; onSaved: () => void }) {
  const [environment, setEnvironment] = useState<Environment>(mode === 'live' && provider.environments.live.available !== false ? 'live' : 'sandbox');
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const config = provider.environments[environment];
  const unavailable = environment === 'live' && config.available === false;
  const status = (env: Environment) => {
    const value = provider.environments[env];
    if (env === 'live' && value.available === false) return null;
    return value.enabled ? <Badge tone={value.problems.length ? 'orange' : 'green'}>{value.problems.length ? 'À compléter' : 'Activé'}</Badge> : <Badge>Désactivé</Badge>;
  };

  return <article className="card pay-provider-card"><div className="card-body stack">
    <div className="row row-between">
      <h3>{provider.label}</h3>
      {provider.docs_url && <a className="button button-ghost button-small" href={provider.docs_url} target="_blank" rel="noreferrer noopener">Documentation <ExternalLink size={14} aria-hidden="true" /></a>}
    </div>
    <p className="pay-sub">
      {provider.methods.map((method) => methodLabels[method] ?? method).join(', ')} · {provider.currencies.join(', ')}
      {provider.countries.length > 0 && <> · {provider.countries.includes('*') ? 'tous pays' : provider.countries.join(', ')}</>}
    </p>
    <div className="row gap-sm">
      {provider.capabilities.refund && <Badge tone="purple">Remboursements</Badge>}
      {provider.capabilities.payout && <Badge tone="purple">Versements</Badge>}
      <Badge>{webhookCapabilityLabels[provider.capabilities.webhooks]}</Badge>
    </div>
    <div className="tabs" role="tablist" aria-label={`Environnements ${provider.label}`}>
      {(['sandbox', 'live'] as const).map((env) => <button key={env} type="button" role="tab" aria-selected={environment === env} className={`tab${environment === env ? ' active' : ''}`}
        onClick={() => { setEnvironment(env); setMessage(''); setWarnings([]); }}>{environmentLabels[env]} {status(env)}</button>)}
    </div>
    <Feedback error="" message={message} warnings={warnings} />
    {unavailable ? <p className="small muted">Le simulateur n’existe qu’en bac à sable : il ne peut jamais encaisser d’argent réel.</p>
      : <ProviderForm key={`${environment}:${config.updated_at ?? ''}:${String(config.enabled)}`} provider={provider} config={config}
        onSaved={(result) => { setMessage(`Configuration ${environmentLabels[environment].toLowerCase()} enregistrée.`); setWarnings(result); onSaved(); }} />}
    <CopyField label="URL de webhook" value={config.webhook_url || provider.webhook_url} />
    {config.updated_at && <span className="pay-sub">Dernière modification : {dateTime(config.updated_at)}</span>}
  </div></article>;
}

function ProviderForm({ provider, config, onSaved }: { provider: ProviderView; config: EnvConfig; onSaved: (warnings: string[]) => void }) {
  const [enabled, setEnabled] = useState(config.enabled);
  const [secretActions, setSecretActions] = useState<Record<string, 'replace' | 'clear' | undefined>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const prefix = `${provider.id}-${config.environment}`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const settings: Record<string, string> = {};
    const secrets: Record<string, string | null> = {};
    for (const field of provider.fields) {
      const value = String(form.get(`field:${field.key}`) ?? '').trim();
      if (!field.secret) { if (value) settings[field.key] = value; continue; }
      if (secretActions[field.key] === 'clear') secrets[field.key] = null;
      else if (value) secrets[field.key] = value;
    }
    setPending(true); setError('');
    try {
      const result = await put<{ provider: EnvConfig; warnings: string[] }>(`/payments/admin/providers/${encodeURIComponent(provider.id)}/${config.environment}`, { enabled, settings, secrets });
      onSaved(result.warnings);
    } catch (failure) { setError(errorMessage(failure)); setPending(false); }
  }

  const setAction = (key: string, action: 'replace' | 'clear' | undefined) => setSecretActions((current) => ({ ...current, [key]: action }));

  return <form className="form" onSubmit={submit}>
    <label className="pay-checkbox"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <span>Activer {provider.label} en {environmentLabels[config.environment].toLowerCase()}</span></label>
    {provider.fields.map((field) => {
      const id = `${prefix}-${field.key}`;
      const label = <>{field.label}{field.required && <span aria-hidden="true"> *</span>}</>;
      const help = field.help && <span className="help-text">{field.help}</span>;
      if (!field.secret) {
        return <label key={field.key} className="field" htmlFor={id}>{label}
          {field.options?.length
            ? <select id={id} name={`field:${field.key}`} defaultValue={config.settings[field.key] ?? ''}>
              {!field.required && <option value="">—</option>}
              {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            : <input id={id} name={`field:${field.key}`} defaultValue={config.settings[field.key] ?? ''} placeholder={field.placeholder} maxLength={500} autoComplete="off" />}
          {help}</label>;
      }
      const secret = config.secrets[field.key] ?? { configured: false, mask: '' };
      const action = secretActions[field.key];
      if (secret.configured && !action) {
        return <div key={field.key} className="field"><span>{label}</span>
          <span className="pay-secret">Configuré <code>{secret.mask || '••••'}</code>
            <button type="button" className="button button-ghost button-small" onClick={() => setAction(field.key, 'replace')}>Remplacer</button>
            <button type="button" className="button button-ghost button-small" onClick={() => setAction(field.key, 'clear')}><Trash2 size={14} aria-hidden="true" />Effacer</button>
          </span>{help}</div>;
      }
      if (action === 'clear') {
        return <div key={field.key} className="field"><span>{label}</span>
          <span className="pay-secret text-warning">Sera effacé à l’enregistrement.
            <button type="button" className="button button-ghost button-small" onClick={() => setAction(field.key, undefined)}>Annuler</button></span></div>;
      }
      return <label key={field.key} className="field" htmlFor={id}>{label}
        <span className="pay-copy"><input id={id} name={`field:${field.key}`} type="password" autoComplete="new-password" spellCheck={false} maxLength={4000}
          placeholder={secret.configured ? 'Nouvelle valeur' : field.placeholder ?? 'Valeur secrète'} />
          {action === 'replace' && <button type="button" className="button button-ghost button-small" onClick={() => setAction(field.key, undefined)}>Annuler</button>}</span>
        {help}</label>;
    })}
    {config.enabled && config.problems.length > 0 && <div className="pay-banner pay-banner-warning"><ShieldAlert size={18} aria-hidden="true" /><div>
      <strong>Configuration incomplète</strong><ul className="pay-problems">{config.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul></div></div>}
    {error && <div className="alert alert-error" role="alert">{error}</div>}
    <div><button type="submit" className="button button-primary button-small" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer'}</button></div>
  </form>;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      input.current?.select();
    }
  }
  return <div className="field"><span>{label}</span>
    <span className="pay-copy"><input ref={input} readOnly value={value} aria-label={label} onFocus={(event) => event.currentTarget.select()} />
      <button type="button" className="button button-ghost button-small" onClick={() => { void copy(); }}><Copy size={14} aria-hidden="true" />{copied ? 'Copié' : 'Copier'}</button></span>
    <span className="pay-sr-only" aria-live="polite">{copied ? 'URL copiée' : ''}</span>
  </div>;
}

// ------------------------------------------------------------------ settings

function SettingsSection({ onChange }: { onChange: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const load = useCallback(async () => {
    try { setSettings(await api<Settings>('/payments/admin/settings')); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!settings) return error ? <ErrorState message={error} /> : <Loading />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    const form = new FormData(event.currentTarget);
    const bps = (name: string) => Math.round(Number(String(form.get(name)).replace(',', '.')) * 100);
    const fx: Record<string, number> = {};
    for (const code of settings.currencies) {
      const raw = String(form.get(`fx:${code}`) ?? '').trim().replace(',', '.');
      if (code !== settings.base_currency && raw && Number(raw) > 0) fx[code] = Number(raw);
    }
    const body: Record<string, unknown> = { fees: { testing_fee_bps: bps('testing_fee'), marketplace_fee_bps: bps('marketplace_fee') }, fx };
    const base = String(form.get('base_currency') ?? '');
    if (!settings.base_currency_locked && base && base !== settings.base_currency) body.base_currency = base;
    setPending(true); setError(''); setMessage('');
    try {
      await put('/payments/admin/settings', body);
      setMessage('Paramètres enregistrés.');
      await load();
      setRevision((value) => value + 1);
      onChange();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <section className="card"><div className="card-header"><h2>Frais & devises</h2></div>
    <form key={revision} className="form card-body" onSubmit={submit}>
      <Feedback error={error} message={message} />
      <div className="form-grid">
        <label className="field">Commission sur les missions de test (%)
          <input name="testing_fee" type="number" min={0} max={50} step={0.01} required defaultValue={settings.fees.testing_fee_bps / 100} />
          <span className="help-text">Retenue sur la récompense versée au testeur.</span></label>
        <label className="field">Commission marketplace (%)
          <input name="marketplace_fee" type="number" min={0} max={50} step={0.01} required defaultValue={settings.fees.marketplace_fee_bps / 100} />
          <span className="help-text">Retenue sur le prix versé au vendeur.</span></label>
        <label className="field">Devise de référence
          <select name="base_currency" defaultValue={settings.base_currency} disabled={settings.base_currency_locked}>
            {settings.currencies.map((code) => <option key={code} value={code}>{code}</option>)}
          </select>
          <span className="help-text">{settings.base_currency_locked ? 'Verrouillée : le grand livre contient déjà des écritures.' : 'Devise des prix, budgets et soldes. Elle se verrouille à la première écriture.'}</span></label>
      </div>
      <fieldset className="stack">
        <legend className="small"><strong>Taux de change</strong> — unités de devise pour 1 {settings.base_currency}</legend>
        <p className="help-text">Utilisés pour convertir les montants vers la devise du prestataire (arrondi supérieur à l’encaissement). XAF et XOF sont fixés à 655,957 pour 1 EUR par défaut. Laissez vide une devise non utilisée.</p>
        <div className="form-grid">
          {settings.currencies.filter((code) => code !== settings.base_currency).map((code) => <label key={code} className="field">{code}
            <input name={`fx:${code}`} type="number" min={0} step="any" defaultValue={settings.fx[code] ?? ''} /></label>)}
        </div>
      </fieldset>
      <div><button type="submit" className="button button-primary" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer'}</button></div>
    </form>
  </section>;
}

// ------------------------------------------------------------------ intents

function IntentsSection({ onChange }: { onChange: () => void }) {
  const [filters, setFilters] = useState({ status: '', mode: '', provider: '', purpose: '', review: false, q: '' });
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ intents: AdminIntent[]; total: number } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const path = useMemo(() => `/payments/admin/intents?${query({ ...filters, review: filters.review ? '1' : undefined, limit: PAGE, offset })}`, [filters, offset]);
  const load = useCallback(async () => {
    try { setData(await api<{ intents: AdminIntent[]; total: number }>(path)); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  const filter = (patch: Partial<typeof filters>) => { setFilters((current) => ({ ...current, ...patch })); setOffset(0); };

  async function reconcile(intent: AdminIntent) {
    setBusy(intent.id); setError(''); setMessage('');
    try {
      const result = await post<{ intent: AdminIntent }>(`/payments/admin/intents/${intent.id}/reconcile`);
      setMessage(`Paiement ${intent.id} : ${intentStatusLabels[result.intent.status]}${result.intent.review_required ? ' (à examiner)' : ''}.`);
      await load(); onChange();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(''); }
  }

  return <section className="card">
    <div className="card-header"><h2>Paiements</h2></div>
    <div className="card-body stack">
      <form className="pay-filters" onSubmit={(event) => { event.preventDefault(); filter({ q: search.trim() }); }}>
        <label className="field">Statut<select value={filters.status} onChange={(event) => filter({ status: event.target.value })}>
          <option value="">Tous</option>{Object.entries(intentStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">Mode<select value={filters.mode} onChange={(event) => filter({ mode: event.target.value })}>
          <option value="">Tous</option><option value="sandbox">{modeLabels.sandbox}</option><option value="live">{modeLabels.live}</option></select></label>
        <label className="field">Prestataire<select value={filters.provider} onChange={(event) => filter({ provider: event.target.value })}>
          <option value="">Tous</option>{knownProviders.map((provider) => <option key={provider} value={provider}>{provider}</option>)}</select></label>
        <label className="field">Objet<select value={filters.purpose} onChange={(event) => filter({ purpose: event.target.value })}>
          <option value="">Tous</option>{Object.entries(purposeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="pay-checkbox"><input type="checkbox" checked={filters.review} onChange={(event) => filter({ review: event.target.checked })} /><span>À examiner uniquement</span></label>
        <label className="field">Recherche<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Identifiant, référence, e-mail" maxLength={200} /></label>
        <button type="submit" className="button button-ghost button-small">Filtrer</button>
      </form>
      <Feedback error={error} message={message} />
    </div>
    {!data ? <Loading /> : data.intents.length === 0 ? <div className="card-body"><EmptyState title="Aucun paiement" description="Aucun paiement ne correspond à ces filtres." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Date</th><th>Payeur</th><th>Objet</th><th>Prestataire</th><th>Montant</th><th>Statut</th><th /></tr></thead>
        <tbody>{data.intents.map((intent) => <tr key={intent.id}>
          <td>{dateTime(intent.created_at)}<span className="pay-sub pay-mono">{intent.id}</span></td>
          <td>{intent.payer_name}<span className="pay-sub">{intent.payer_email}</span></td>
          <td>{intent.title}<span className="pay-sub">{purposeLabels[intent.purpose]}</span></td>
          <td>{intent.provider}<span className="pay-sub">{[intent.method && (methodLabels[intent.method] ?? intent.method), intent.operator, intent.customer_phone_masked].filter(Boolean).join(' · ')}</span></td>
          <td className="pay-amount">{money(intent.amount_minor, intent.currency)}
            {intent.currency !== intent.base_currency && <span className="pay-sub">{money(intent.amount_base_minor, intent.base_currency)}</span>}
            <span className="pay-sub"><Badge tone={modeTones[intent.mode]}>{modeLabels[intent.mode]}</Badge></span></td>
          <td><IntentStatusBadge intent={intent} />{intent.failure_reason && <span className="pay-sub">{intent.failure_reason}</span>}</td>
          <td><div className="pay-table-actions">
            <button type="button" className="button button-ghost button-small" onClick={() => setSelected(intent.id)}>Détails</button>
            <button type="button" className="button button-ghost button-small" disabled={busy === intent.id} onClick={() => { void reconcile(intent); }}>
              <RefreshCw size={14} aria-hidden="true" />{busy === intent.id ? 'Vérification…' : 'Réconcilier'}</button>
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    {data && <Pager total={data.total} offset={offset} onChange={setOffset} />}
    {selected && <IntentDetail intentId={selected} onClose={() => setSelected(null)} />}
  </section>;
}

function IntentDetail({ intentId, onClose }: { intentId: string; onClose: () => void }) {
  const [data, setData] = useState<{ intent: AdminIntent; refunds: Refund[]; webhooks: WebhookEvent[]; journals: Journal[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ intent: AdminIntent; refunds: Refund[]; webhooks: WebhookEvent[]; journals: Journal[] }>(`/payments/admin/intents/${intentId}`)
      .then((value) => { if (active) setData(value); })
      .catch((failure: unknown) => { if (active) setError(errorMessage(failure)); });
    return () => { active = false; };
  }, [intentId]);
  const intent = data?.intent;
  const rows: [string, ReactNode][] = intent ? [
    ['Identifiant', <span className="pay-mono">{intent.id}</span>],
    ['Objet', `${purposeLabels[intent.purpose]} — ${intent.title}`],
    ['Payeur', `${intent.payer_name} (${intent.payer_email})`],
    ['Mode', modeLabels[intent.mode]],
    ['Prestataire', [intent.provider, intent.method && (methodLabels[intent.method] ?? intent.method), intent.operator].filter(Boolean).join(' · ')],
    ['Référence prestataire', intent.provider_reference ? <span className="pay-mono">{intent.provider_reference}</span> : '—'],
    ['Montant', `${money(intent.amount_minor, intent.currency)} (${money(intent.amount_base_minor, intent.base_currency)}, taux ${intent.fx_rate})`],
    ['Statut', <IntentStatusBadge intent={intent} />],
    ['Règlement', intent.settlement === 'settled' ? 'Appliqué au grand livre' : intent.settlement === 'unapplied' ? 'Encaissé mais non appliqué (à traiter)' : 'Aucun'],
    ['Motif d’échec', intent.failure_reason || '—'],
    ['Téléphone', intent.customer_phone_masked || '—'],
    ['Tentatives de vérification', `${intent.attempts}${intent.last_checked_at ? ` · dernière ${dateTime(intent.last_checked_at)}` : ''}${intent.next_check_at ? ` · prochaine ${dateTime(intent.next_check_at)}` : ''}`],
    ['Créé le', dateTime(intent.created_at)],
    ['Expire le', dateTime(intent.expires_at)],
  ] : [];
  return <Modal title="Détail du paiement" onClose={onClose}>
    {error ? <ErrorState message={error} /> : !data || !intent ? <Loading /> : <div className="stack">
      {intent.review_required && <div className="pay-banner pay-banner-danger" role="alert"><ShieldAlert size={18} aria-hidden="true" /><div>
        <strong>À examiner</strong>Le prestataire a confirmé un montant ou une devise différents : rien n’a été crédité. Vérifiez la transaction chez le prestataire, puis remboursez-la ou passez un ajustement.</div></div>}
      <dl className="pay-summary">{rows.map(([label, value]) => <div key={label} style={{ display: 'contents' }}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <h3>Écritures</h3>
      {data.journals.length ? <ul className="pay-problems">{data.journals.map((journal) => <li key={journal.id}>{journalKindLabels[journal.kind] ?? journal.kind} · {dateTime(journal.created_at)} <span className="pay-mono">{journal.id}</span></li>)}</ul>
        : <p className="small muted">Aucune écriture.</p>}
      <h3>Webhooks</h3>
      {data.webhooks.length ? <WebhookTable events={data.webhooks} /> : <p className="small muted">Aucun webhook reçu pour ce paiement.</p>}
      <h3>Remboursements</h3>
      {data.refunds.length ? <ul className="pay-problems">{data.refunds.map((refund) => <li key={refund.id}>{money(refund.amount_minor, refund.currency)} · {refundStatusLabels[refund.status]}{refund.last_error && ` — ${refund.last_error}`}</li>)}</ul>
        : <p className="small muted">Aucun remboursement.</p>}
    </div>}
  </Modal>;
}

// ------------------------------------------------------------------ webhooks

function WebhookTable({ events }: { events: WebhookEvent[] }) {
  return <div className="table-wrap"><table className="data-table">
    <thead><tr><th>Reçu le</th><th>Prestataire</th><th>Événement</th><th>Référence</th><th>Statut</th><th>Erreur</th></tr></thead>
    <tbody>{events.map((event) => <tr key={event.id}>
      <td>{dateTime(event.received_at)}{event.processed_at && <span className="pay-sub">traité {dateTime(event.processed_at)}</span>}</td>
      <td>{event.provider}{event.mode && <span className="pay-sub">{modeLabels[event.mode]}</span>}</td>
      <td>{event.event_type || '—'}{event.event_status && <span className="pay-sub">{event.event_status}</span>}</td>
      <td><span className="pay-mono">{event.reference ?? event.provider_reference ?? '—'}</span>{event.intent_id && <span className="pay-sub pay-mono">{event.intent_id}</span>}</td>
      <td>{event.status ? <Badge tone={webhookStatusTones[event.status]}>{webhookStatusLabels[event.status]}</Badge> : <Badge tone="red">En échec</Badge>}
        {event.attempts > 1 && <span className="pay-sub">{event.attempts} tentatives</span>}</td>
      <td className="small">{event.error || '—'}</td>
    </tr>)}</tbody>
  </table></div>;
}

function WebhooksSection() {
  const [status, setStatus] = useState('');
  const [provider, setProvider] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ events: WebhookEvent[]; total: number } | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api<{ events: WebhookEvent[]; total: number }>(`/payments/admin/webhooks?${query({ status, provider, limit: PAGE, offset })}`)); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }, [status, provider, offset]);
  useEffect(() => { void load(); }, [load]);
  return <section className="card">
    <div className="card-header"><h2>Webhooks reçus</h2>
      <button type="button" className="button button-ghost button-small" onClick={() => { void load(); }}><RefreshCw size={14} aria-hidden="true" />Actualiser</button></div>
    <div className="card-body stack">
      <div className="pay-filters">
        <label className="field">Statut<select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
          <option value="">Tous</option>{Object.entries(webhookStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field">Prestataire<select value={provider} onChange={(event) => { setProvider(event.target.value); setOffset(0); }}>
          <option value="">Tous</option>{knownProviders.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
      </div>
      <p className="help-text">Chaque événement est dédoublonné, puis le paiement est re-vérifié auprès du prestataire avant tout crédit. Les signatures invalides sont refusées (401) sans être enregistrées.</p>
      {error && <ErrorState message={error} />}
    </div>
    {!data ? <Loading /> : data.events.length === 0 ? <div className="card-body"><EmptyState title="Aucun webhook" description="Aucun événement ne correspond à ces filtres." /></div>
      : <WebhookTable events={data.events} />}
    {data && <Pager total={data.total} offset={offset} onChange={setOffset} />}
  </section>;
}

// ------------------------------------------------------------------ refunds

function RefundsSection({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ refunds: Refund[]; total: number } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try { setData(await api<{ refunds: Refund[]; total: number }>(`/payments/admin/refunds?${query({ status, limit: PAGE, offset })}`)); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }, [status, offset]);
  useEffect(() => { void load(); }, [load]);

  async function retry(refund: Refund) {
    setBusy(refund.id); setError(''); setMessage('');
    try {
      const result = await post<{ refund: Refund | null }>(`/payments/admin/refunds/${refund.id}/retry`);
      setMessage(`Remboursement relancé : ${result.refund ? refundStatusLabels[result.refund.status] : 'demande envoyée'}.`);
      await load(); onChange();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(''); }
  }

  return <section className="card">
    <div className="card-header"><h2>Remboursements</h2>
      <label className="field">Statut<select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
        <option value="">Tous</option>{Object.entries(refundStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    <div className="card-body stack">
      <p className="help-text">Le grand livre est corrigé immédiatement ; l’ordre de remboursement est ensuite envoyé au prestataire d’origine et relancé automatiquement (tâche payments.reconcile).</p>
      <Feedback error={error} message={message} />
    </div>
    {!data ? <Loading /> : data.refunds.length === 0 ? <div className="card-body"><EmptyState title="Aucun remboursement" description="Aucun remboursement ne correspond à ce filtre." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Date</th><th>Origine</th><th>Montant</th><th>Prestataire</th><th>Statut</th><th /></tr></thead>
        <tbody>{data.refunds.map((refund) => <tr key={refund.id}>
          <td>{dateTime(refund.created_at)}<span className="pay-sub pay-mono">{refund.id}</span></td>
          <td>{refund.order_id ? 'Commande' : 'Campagne'} <span className="pay-mono">{refund.order_id ?? refund.campaign_id}</span><span className="pay-sub">{refund.reason}</span></td>
          <td className="pay-amount">{money(refund.amount_minor, refund.currency)}<span className="pay-sub"><Badge tone={modeTones[refund.mode]}>{modeLabels[refund.mode]}</Badge></span></td>
          <td>{refund.provider}<span className="pay-sub pay-mono">{refund.provider_reference ?? '—'}</span></td>
          <td><Badge tone={refundStatusTones[refund.status]}>{refundStatusLabels[refund.status]}</Badge>
            <span className="pay-sub">{refund.attempts} tentative(s){refund.next_attempt_at && refund.status !== 'succeeded' ? ` · prochaine ${dateTime(refund.next_attempt_at)}` : ''}</span>
            {refund.last_error && <span className="pay-sub">{refund.last_error}</span>}</td>
          <td>{(refund.status === 'failed' || refund.status === 'pending') && <button type="button" className="button button-ghost button-small" disabled={busy === refund.id} onClick={() => { void retry(refund); }}>
            <RefreshCw size={14} aria-hidden="true" />{busy === refund.id ? 'Envoi…' : 'Réessayer'}</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    {data && <Pager total={data.total} offset={offset} onChange={setOffset} />}
  </section>;
}

// ------------------------------------------------------------------ ledger

function LedgerSection({ baseCurrency, onChange }: { baseCurrency: string; onChange: () => void }) {
  const [mode, setMode] = useState('');
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ journals: Journal[]; ledger_balanced: boolean } | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const load = useCallback(async () => {
    try { setData(await api<{ journals: Journal[]; ledger_balanced: boolean }>(`/payments/admin/journals?${query({ mode, kind, limit: PAGE, offset })}`)); setError(''); }
    catch (failure) { setError(errorMessage(failure)); }
  }, [mode, kind, offset]);
  useEffect(() => { void load(); }, [load]);

  return <section className="card">
    <div className="card-header"><h2>Grand livre</h2>
      <button type="button" className="button button-primary button-small" onClick={() => { setMessage(''); setAdjusting(true); }}><Plus size={14} aria-hidden="true" />Ajustement manuel</button></div>
    <div className="card-body stack">
      <div className="pay-filters">
        <label className="field">Mode<select value={mode} onChange={(event) => { setMode(event.target.value); setOffset(0); }}>
          <option value="">Tous</option><option value="sandbox">{modeLabels.sandbox}</option><option value="live">{modeLabels.live}</option></select></label>
        <label className="field">Type<select value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); }}>
          <option value="">Tous</option>{Object.entries(journalKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        {data && <Badge tone={data.ledger_balanced ? 'green' : 'red'}>{data.ledger_balanced ? 'Grand livre équilibré' : 'Grand livre déséquilibré'}</Badge>}
      </div>
      <p className="help-text">Écritures en partie double, immuables : chaque mouvement d’argent sandbox ou réel s’y retrouve (montants en unités mineures de la devise, positifs = débit du compte).</p>
      <Feedback error={error} message={message} />
    </div>
    {!data ? <Loading /> : data.journals.length === 0 ? <div className="card-body"><EmptyState title="Aucune écriture" description="Le grand livre est vide pour ces filtres." /></div>
      : <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Date</th><th>Type</th><th>Référence</th><th>Lignes</th></tr></thead>
        <tbody>{data.journals.map((journal) => <tr key={journal.id}>
          <td>{dateTime(journal.created_at)}<span className="pay-sub"><Badge tone={modeTones[journal.mode]}>{modeLabels[journal.mode]}</Badge> {journal.currency}</span></td>
          <td>{journalKindLabels[journal.kind] ?? journal.kind}{journal.memo && <span className="pay-sub">{journal.memo}</span>}</td>
          <td><span className="pay-mono">{journal.ref_type}:{journal.ref_id}</span></td>
          <td><ul className="pay-problems">{(journal.entries ?? []).map((entry) => <li key={`${entry.account}:${entry.amount_minor}`}>
            <span className="pay-mono">{entry.account}</span> <span className={`pay-amount ${entry.amount_minor > 0 ? 'pay-amount-in' : 'pay-amount-out'}`}>{money(entry.amount_minor, journal.currency)}</span></li>)}</ul></td>
        </tr>)}</tbody>
      </table></div>}
    {data && (offset > 0 || data.journals.length === PAGE) && <div className="row row-between card-body">
      <span className="small muted">Écritures {offset + 1}–{offset + data.journals.length}</span>
      <div className="row gap-sm">
        <button type="button" className="button button-ghost button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
        <button type="button" className="button button-ghost button-small" disabled={data.journals.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
      </div>
    </div>}
    {adjusting && <AdjustmentDialog baseCurrency={baseCurrency} onClose={() => setAdjusting(false)} onDone={(journalId) => {
      setAdjusting(false); setMessage(`Ajustement enregistré (écriture ${journalId}).`); setOffset(0); void load(); onChange();
    }} />}
  </section>;
}

function AdjustmentDialog({ baseCurrency, onClose, onDone }: { baseCurrency: string; onClose: () => void; onDone: (journalId: string) => void }) {
  const [mode, setMode] = useState<Environment>('sandbox');
  const [currency, setCurrency] = useState(baseCurrency);
  const [memo, setMemo] = useState('');
  const [legs, setLegs] = useState([{ account: '', amount: '' }, { account: '', amount: '' }]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const parsed = legs.map((leg) => Number.parseInt(leg.amount, 10));
  const sum = parsed.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
  const valid = memo.trim().length >= 5 && legs.every((leg, index) => leg.account.trim() && Number.isFinite(parsed[index]) && parsed[index] !== 0) && sum === 0;
  const update = (index: number, patch: Partial<{ account: string; amount: string }>) => setLegs((current) => current.map((leg, position) => position === index ? { ...leg, ...patch } : leg));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid) return;
    setPending(true); setError('');
    try {
      const result = await post<{ journal_id: string }>('/payments/admin/adjustments', {
        mode, currency: currency.trim().toUpperCase(), memo: memo.trim(),
        legs: legs.map((leg, index) => ({ account: leg.account.trim(), amount_minor: parsed[index] })),
      });
      onDone(result.journal_id);
    } catch (failure) { setError(errorMessage(failure)); setPending(false); }
  }

  return <Modal title="Ajustement manuel du grand livre" onClose={() => { if (!pending) onClose(); }}>
    <form className="form" onSubmit={submit}>
      <div className="pay-banner pay-banner-warning"><ShieldAlert size={18} aria-hidden="true" /><div><strong>Écriture définitive et auditée</strong>
        Réservé aux corrections (écart prestataire, geste commercial, rétrofacturation). Elle ne déclenche aucun mouvement chez le prestataire.</div></div>
      <div className="form-grid">
        <label className="field">Mode<select value={mode} onChange={(event) => setMode(event.target.value as Environment)}>
          <option value="sandbox">{modeLabels.sandbox}</option><option value="live">{modeLabels.live}</option></select></label>
        <label className="field">Devise<input value={currency} onChange={(event) => setCurrency(event.target.value)} pattern="[A-Za-z]{3}" maxLength={3} required /></label>
      </div>
      <label className="field">Motif (obligatoire)<textarea value={memo} onChange={(event) => setMemo(event.target.value)} rows={2} minLength={5} maxLength={500} required /></label>
      <div className="pay-legs">
        <span className="small muted">Comptes : user:&lt;id&gt;:available, escrow:campaign:&lt;id&gt;, escrow:order:&lt;id&gt;, provider:&lt;id&gt;, platform:fees, platform:adjustments… Montants en unités mineures (centimes), la somme doit être nulle.</span>
        {legs.map((leg, index) => <div key={index} className="pay-leg">
          <label className="field">Compte<input value={leg.account} onChange={(event) => update(index, { account: event.target.value })} placeholder="platform:adjustments" maxLength={120} required /></label>
          <label className="field">Montant<input value={leg.amount} onChange={(event) => update(index, { amount: event.target.value })} inputMode="numeric" pattern="-?[0-9]+" placeholder="-1500" required /></label>
          <button type="button" className="button button-ghost button-small" disabled={legs.length <= 2} aria-label={`Retirer la ligne ${index + 1}`}
            onClick={() => setLegs((current) => current.filter((_, position) => position !== index))}><Trash2 size={14} aria-hidden="true" /></button>
        </div>)}
        <div className="row row-between">
          <button type="button" className="button button-ghost button-small" disabled={legs.length >= 10} onClick={() => setLegs((current) => [...current, { account: '', amount: '' }])}><Plus size={14} aria-hidden="true" />Ajouter une ligne</button>
          <span className={`small ${sum === 0 ? 'text-success' : 'text-warning'}`}>Somme : {sum}</span>
        </div>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="pay-actions">
        <button type="button" className="button button-ghost" onClick={onClose} disabled={pending}>Annuler</button>
        <button type="submit" className="button button-primary" disabled={pending || !valid}>{pending ? 'Enregistrement…' : 'Enregistrer l’ajustement'}</button>
      </div>
    </form>
  </Modal>;
}
