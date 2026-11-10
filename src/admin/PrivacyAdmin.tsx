import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Download, Pencil, Play, Plus, RefreshCw, Save, Search, Trash2 } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, Modal, useApi } from '../components/ui';
import { api, date, dateTime, errorMessage } from '../lib/api';
import '../styles/privacy.css';

/** Admin console — GDPR requests, retention, controller identity, Art. 30 register and breach register. OWNER: privacy module. */

type RequestStatus = 'pending' | 'processing' | 'ready' | 'scheduled' | 'completed' | 'cancelled' | 'rejected';
interface AdminRequest {
  id: string; kind: 'export' | 'erasure'; status: RequestStatus; reason: string; requested_at: string; scheduled_for: string | null;
  processed_at: string | null; expires_at: string | null; downloaded_at: string | null; download_count: number; rejection_reason: string;
  user_id: string; user_name: string | null; user_email: string | null; handled_by_name: string | null; attempts: number; last_error: string;
  response_deadline: string; overdue: boolean; due: boolean;
}
interface Overview {
  requests: { kind: string; status: string; total: number }[]; due_erasures: number; open_breaches: number; overdue_breaches: number;
  controller_missing: string[];
}
interface Retention {
  enabled: boolean; notifications_read_days: number; email_sent_days: number; email_failed_days: number; audit_days: number;
  audit_long_days: number; audit_long_prefixes: string[]; risk_signals_days: number; privacy_requests_days: number;
}
interface RetentionResult { dry_run: boolean; ran_at: string; total: number; categories: { key: string; label: string; count: number; cutoff: string | null; error?: string }[] }
type Controller = Record<string, string>;
interface Activity {
  id: string; name: string; purposes: string[]; legal_basis: string; data_subjects: string[]; data_categories: string[];
  recipients: string[]; transfers: string; retention: string; security: string[]; source: 'core' | 'module';
}
interface Register { generated_at: string; notice: string; activities: Activity[] }
type BreachState = 'not_required' | 'notified_on_time' | 'notified_late' | 'overdue' | 'pending';
interface Breach {
  id: string; title: string; detected_at: string; occurred_at: string | null; description: string; nature: string[]; data_categories: string[];
  affected_count: number; risk_level: 'none' | 'risk' | 'high'; consequences: string; measures: string; notified_cnil_at: string | null;
  cnil_reference: string; notified_users_at: string | null; status: 'open' | 'closed'; created_by_name: string | null; created_at: string;
  deadline: { deadline: string; hours_left: number | null; state: BreachState; users_notification_required: boolean; users_pending: boolean };
}
type Notice = { tone: 'success' | 'error'; message: string } | null;

const statusLabels: Record<RequestStatus, string> = {
  pending: 'En attente', processing: 'En cours', ready: 'Prêt', scheduled: 'Programmée', completed: 'Terminée', cancelled: 'Annulée', rejected: 'Refusée',
};
const statusTones: Record<RequestStatus, string> = {
  pending: 'blue', processing: 'blue', ready: 'green', scheduled: 'orange', completed: 'neutral', cancelled: 'neutral', rejected: 'red',
};
const breachStates: Record<BreachState, { label: string; tone: string }> = {
  not_required: { label: 'Notification non requise', tone: 'neutral' },
  notified_on_time: { label: 'CNIL notifiée dans les 72 h', tone: 'green' },
  notified_late: { label: 'CNIL notifiée hors délai', tone: 'orange' },
  overdue: { label: 'Délai de 72 h dépassé', tone: 'red' },
  pending: { label: 'Notification CNIL à faire', tone: 'orange' },
};
const natureLabels: Record<string, string> = { confidentiality: 'Confidentialité', integrity: 'Intégrité', availability: 'Disponibilité' };
const riskLabels = { none: 'Risque improbable', risk: 'Risque', high: 'Risque élevé' };
const retentionFields: { key: keyof Retention; label: string; help: string }[] = [
  { key: 'notifications_read_days', label: 'Notifications lues (jours)', help: 'Par défaut 365 jours.' },
  { key: 'email_sent_days', label: 'E-mails envoyés (jours)', help: 'Journal d’envoi. Par défaut 90 jours.' },
  { key: 'email_failed_days', label: 'E-mails en échec (jours)', help: 'Par défaut 180 jours.' },
  { key: 'audit_days', label: 'Audit ordinaire (jours)', help: 'Minimum 1 an, par défaut 3 ans.' },
  { key: 'audit_long_days', label: 'Audit financier, confiance et RGPD (jours)', help: 'Minimum 3 ans, par défaut 10 ans.' },
  { key: 'risk_signals_days', label: 'Signaux anti-fraude (jours)', help: 'Uniquement si le module confiance est installé. Par défaut 180 jours.' },
  { key: 'privacy_requests_days', label: 'Demandes RGPD clôturées (jours)', help: 'Preuve de traitement. Par défaut 3 ans.' },
];

function NoticeLine({ notice }: { notice: Notice }) {
  return <div aria-live="polite">{notice && (notice.tone === 'success'
    ? <p className="alert alert-success" role="status">{notice.message}</p>
    : <ErrorState message={notice.message} />)}</div>;
}

async function act(setNotice: (notice: Notice) => void, work: () => Promise<unknown>, success: string) {
  setNotice(null);
  try {
    await work();
    setNotice({ tone: 'success', message: success });
    return true;
  } catch (failure) {
    setNotice({ tone: 'error', message: errorMessage(failure) });
    return false;
  }
}

function OverviewCards({ overview }: { overview: Overview }) {
  const open = overview.requests.filter((row) => ['pending', 'processing', 'scheduled'].includes(row.status)).reduce((sum, row) => sum + row.total, 0);
  return <>
    <div className="stat-grid privacy-stats">
      <div className="stat-card"><span className="stat-label">Demandes en cours</span><p className="stat-value">{open}</p><p className="stat-note">Réponse sous un mois (art. 12.3)</p></div>
      <div className="stat-card"><span className="stat-label">Suppressions échues</span><p className="stat-value">{overview.due_erasures}</p><p className="stat-note">Exécutées par la tâche privacy.erasure</p></div>
      <div className="stat-card"><span className="stat-label">Violations ouvertes</span><p className="stat-value">{overview.open_breaches}</p>
        <p className="stat-note">{overview.overdue_breaches ? `${overview.overdue_breaches} hors délai de 72 h` : 'Aucune notification en retard'}</p></div>
    </div>
    {overview.controller_missing.length > 0 && <p className="alert alert-error" role="note">Identité du responsable incomplète ({overview.controller_missing.join(', ')}) : les documents juridiques affichent « à compléter ».</p>}
  </>;
}

function RequestsTab() {
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('open');
  const query = new URLSearchParams({ ...(kind ? { kind } : {}), ...(status ? { status } : {}) }).toString();
  const { data, loading, error, reload } = useApi<{ requests: AdminRequest[] }>(`/privacy/admin/requests${query ? `?${query}` : ''}`);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState('');
  const [rejecting, setRejecting] = useState<AdminRequest | null>(null);
  const [executing, setExecuting] = useState<AdminRequest | null>(null);
  const [reason, setReason] = useState('');

  async function run(key: string, work: () => Promise<unknown>, success: string) {
    if (pending) return false;
    setPending(key);
    const ok = await act(setNotice, work, success);
    setPending('');
    reload();
    return ok;
  }

  return <section className="card">
    <div className="card-header">
      <div><h2>Demandes des membres</h2><p className="muted small">Exports (art. 15/20) et suppressions (art. 17). Toute action est journalisée.</p></div>
      <div className="row gap-sm privacy-filters">
        <label className="field">Type<select value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">Tous</option><option value="export">Exports</option><option value="erasure">Suppressions</option></select></label>
        <label className="field">Statut<select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="open">En cours</option><option value="">Tous</option>
          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <button type="button" className="button button-ghost button-small" onClick={reload} aria-label="Actualiser"><RefreshCw size={14} aria-hidden="true" /></button>
      </div>
    </div>
    <div className="card-body">
      <NoticeLine notice={notice} />
      {loading && <Loading />}
      <ErrorState message={error} />
      {data && data.requests.length === 0 && <EmptyState title="Aucune demande" description="Aucune demande ne correspond à ces filtres." />}
      {data && data.requests.length > 0 && <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Membre</th><th scope="col">Type</th><th scope="col">Statut</th><th scope="col">Reçue</th><th scope="col">Échéance</th><th scope="col">Actions</th></tr></thead>
        <tbody>{data.requests.map((request) => <tr key={request.id}>
          <td><strong>{request.user_name}</strong><br /><span className="small muted">{request.user_email}</span></td>
          <td>{request.kind === 'export' ? 'Export' : 'Suppression'}{request.reason && <><br /><span className="small muted">« {request.reason} »</span></>}</td>
          <td><Badge tone={statusTones[request.status]}>{statusLabels[request.status]}</Badge>
            {request.last_error && <><br /><span className="small privacy-error-text">{request.last_error}</span></>}
            {request.rejection_reason && <><br /><span className="small muted">{request.rejection_reason}</span></>}
            {request.handled_by_name && <><br /><span className="small muted">par {request.handled_by_name}</span></>}</td>
          <td>{dateTime(request.requested_at)}</td>
          <td>{request.kind === 'erasure' && request.scheduled_for
            ? <>{dateTime(request.scheduled_for)} {request.due && request.status === 'scheduled' && <Badge tone="red">Échue</Badge>}</>
            : request.status === 'ready' && request.expires_at ? <>Lien jusqu’au {date(request.expires_at)}</>
              : <>{date(request.response_deadline)} {request.overdue && <Badge tone="red">En retard</Badge>}</>}</td>
          <td><div className="row gap-sm privacy-actions">
            {request.kind === 'export' && ['pending', 'processing'].includes(request.status) && <button type="button" className="button button-secondary button-small" disabled={!!pending}
              onClick={() => { void run(`process:${request.id}`, () => api(`/privacy/admin/requests/${request.id}/process`, { method: 'POST' }), 'Export prêt : le membre a été prévenu.'); }}>
              <Play size={13} aria-hidden="true" /> Préparer</button>}
            {request.kind === 'erasure' && request.status === 'scheduled' && <button type="button" className="button button-danger button-small" disabled={!!pending} onClick={() => setExecuting(request)}>
              <Trash2 size={13} aria-hidden="true" /> Exécuter</button>}
            {(['pending', 'processing'].includes(request.status) || (request.kind === 'erasure' && request.status === 'scheduled')) && <button type="button" className="button button-ghost button-small" disabled={!!pending}
              onClick={() => { setReason(''); setRejecting(request); }}>Refuser</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
    {rejecting && <Modal title="Refuser la demande" onClose={() => setRejecting(null)}>
      <form className="form" onSubmit={(event) => {
        event.preventDefault();
        void run(`reject:${rejecting.id}`, () => api(`/privacy/admin/requests/${rejecting.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }),
          'Demande refusée : le membre a reçu le motif et les voies de recours.').then((ok) => { if (ok) setRejecting(null); });
      }}>
        <p className="help-text">Un refus doit être motivé juridiquement (art. 12.4 RGPD) : demande manifestement infondée ou excessive, obligation légale de conservation (art. 17.3), identité non établie… Le membre est informé du motif et de son droit de saisir la CNIL.</p>
        <label className="field">Motif communiqué au membre<textarea rows={4} required minLength={10} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <div className="row gap-sm"><button type="submit" className="button button-danger" disabled={!!pending || reason.trim().length < 10}>Refuser la demande</button>
          <button type="button" className="button button-ghost" onClick={() => setRejecting(null)}>Annuler</button></div>
      </form>
    </Modal>}
    {executing && <Modal title="Exécuter la suppression" onClose={() => setExecuting(null)}>
      <div className="stack">
        <p>Le compte de <strong>{executing.user_name}</strong> sera anonymisé de façon <strong>irréversible</strong>. Les pièces comptables, le grand livre et l’audit sont conservés sous l’identifiant anonymisé.</p>
        {!executing.due && <p className="alert alert-error" role="note">Le délai de rétractation court jusqu’au {dateTime(executing.scheduled_for!)}. N’exécutez la suppression avant cette date qu’à la demande expresse et écrite du membre.</p>}
        <div className="row gap-sm">
          <button type="button" className="button button-danger" disabled={!!pending} onClick={() => {
            void run(`execute:${executing.id}`, () => api(`/privacy/admin/requests/${executing.id}/execute`, { method: 'POST' }), 'Compte anonymisé.').then(() => setExecuting(null));
          }}>Anonymiser maintenant</button>
          <button type="button" className="button button-ghost" onClick={() => setExecuting(null)}>Annuler</button>
        </div>
      </div>
    </Modal>}
  </section>;
}

function RetentionTab() {
  const { data, loading, error } = useApi<{ settings: Retention; defaults: Retention; updated_at: string | null }>('/privacy/admin/retention');
  const [form, setForm] = useState<Retention | null>(null);
  const [prefixes, setPrefixes] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState('');
  const [result, setResult] = useState<RetentionResult | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  useEffect(() => {
    if (data) { setForm(data.settings); setPrefixes(data.settings.audit_long_prefixes.join(', ')); }
  }, [data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || pending) return;
    setPending('save');
    await act(setNotice, async () => {
      const saved = await api<{ settings: Retention }>('/privacy/admin/retention', { method: 'PUT', body: JSON.stringify({
        ...form, audit_long_prefixes: prefixes.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
      }) });
      setForm(saved.settings);
      setPrefixes(saved.settings.audit_long_prefixes.join(', '));
    }, 'Durées de conservation enregistrées.');
    setPending('');
  }

  async function runPurge(dryRun: boolean) {
    if (pending) return;
    setPending(dryRun ? 'dry' : 'run');
    await act(setNotice, async () => {
      setResult((await api<{ result: RetentionResult }>('/privacy/admin/retention/run', { method: 'POST', body: JSON.stringify({ dry_run: dryRun }) })).result);
    }, dryRun ? 'Simulation terminée : aucune donnée n’a été supprimée.' : 'Purge effectuée.');
    setPending('');
    setConfirmRun(false);
  }

  return <section className="card">
    <div className="card-header"><div><h2>Durées de conservation</h2>
      <p className="muted small">Purge quotidienne (tâche privacy.retention). Les tables des autres modules sont purgées par leurs propres tâches ; les pièces comptables et le grand livre ne sont jamais purgés ici.</p></div></div>
    <div className="card-body stack">
      {loading && <Loading />}
      <ErrorState message={error} />
      {form && <form className="form" onSubmit={(event) => { void save(event); }}>
        <label className="privacy-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
          <span><strong>Purge automatique activée</strong><span className="help-text">Désactiver uniquement le temps d’une enquête ou d’une procédure (gel des preuves).</span></span></label>
        <div className="form-grid">
          {retentionFields.map((field) => <label key={field.key} className="field">{field.label}
            <input type="number" min={1} required value={form[field.key] as number} onChange={(event) => setForm({ ...form, [field.key]: Number(event.target.value) })} />
            <span className="help-text">{field.help}</span></label>)}
        </div>
        <label className="field">Préfixes d’actions d’audit conservés longtemps<textarea rows={3} value={prefixes} onChange={(event) => setPrefixes(event.target.value)} />
          <span className="help-text">Séparés par des virgules (ex. payment, ledger, privacy). Un préfixe couvre l’action exacte et ses sous-actions (« payment.* »).</span></label>
        <div className="row gap-sm">
          <button type="submit" className="button button-primary" disabled={!!pending}><Save size={14} aria-hidden="true" /> Enregistrer</button>
          <button type="button" className="button button-secondary" disabled={!!pending} onClick={() => { void runPurge(true); }}><Search size={14} aria-hidden="true" /> Simuler la purge</button>
          <button type="button" className="button button-danger" disabled={!!pending} onClick={() => setConfirmRun(true)}><Trash2 size={14} aria-hidden="true" /> Purger maintenant</button>
        </div>
        {data?.updated_at && <p className="help-text">Dernière modification : {dateTime(data.updated_at)}</p>}
      </form>}
      <NoticeLine notice={notice} />
      {result && <div className="table-wrap"><table className="data-table">
        <caption className="small muted">{result.dry_run ? 'Simulation' : 'Purge'} du {dateTime(result.ran_at)} — {result.total} élément(s)</caption>
        <thead><tr><th scope="col">Catégorie</th><th scope="col">Antérieur au</th><th scope="col">{result.dry_run ? 'À supprimer' : 'Supprimés'}</th></tr></thead>
        <tbody>{result.categories.map((category) => <tr key={category.key}><td>{category.label}{category.error && <><br /><span className="small privacy-error-text">{category.error}</span></>}</td>
          <td>{category.cutoff ? dateTime(category.cutoff) : '—'}</td><td>{category.count}</td></tr>)}</tbody>
      </table></div>}
    </div>
    {confirmRun && <Modal title="Purger maintenant" onClose={() => setConfirmRun(false)}>
      <div className="stack"><p>Les données arrivées au terme de leur durée de conservation seront supprimées définitivement. Lancez d’abord une simulation pour vérifier les volumes.</p>
        <div className="row gap-sm"><button type="button" className="button button-danger" disabled={!!pending} onClick={() => { void runPurge(false); }}>Confirmer la purge</button>
          <button type="button" className="button button-ghost" onClick={() => setConfirmRun(false)}>Annuler</button></div></div>
    </Modal>}
  </section>;
}

function ControllerTab() {
  const { data, loading, error } = useApi<{ controller: Controller; labels: Record<string, string>; updated_at: string | null }>('/privacy/admin/controller');
  const [form, setForm] = useState<Controller | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (data) setForm(data.controller); }, [data]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || pending) return;
    setPending(true);
    await act(setNotice, async () => {
      setForm((await api<{ controller: Controller }>('/privacy/admin/controller', { method: 'PUT', body: JSON.stringify(form) })).controller);
    }, 'Identité du responsable enregistrée. Les documents juridiques sont à jour.');
    setPending(false);
  }

  return <section className="card">
    <div className="card-header"><div><h2>Identité du responsable de traitement</h2>
      <p className="muted small">Insérée dans les <Link to="/legal/legal_notice">mentions légales</Link>, la <Link to="/legal/privacy">politique de confidentialité</Link> et les autres documents. Le texte est affiché tel quel (aucune mise en forme).</p></div></div>
    <div className="card-body">
      {loading && <Loading />}
      <ErrorState message={error} />
      {form && data && <form className="form" onSubmit={(event) => { void save(event); }}>
        <div className="form-grid">
          {Object.entries(data.labels).map(([key, label]) => <label key={key} className="field">{label.charAt(0).toUpperCase() + label.slice(1)}
            {key.includes('address')
              ? <textarea rows={2} maxLength={400} value={form[key] ?? ''} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />
              : <input type={key.includes('email') ? 'email' : 'text'} maxLength={200} value={form[key] ?? ''} onChange={(event) => setForm({ ...form, [key]: event.target.value })} />}
          </label>)}
        </div>
        <div className="row gap-sm"><button type="submit" className="button button-primary" disabled={pending}><Save size={14} aria-hidden="true" /> Enregistrer</button>
          {data.updated_at && <span className="help-text">Dernière modification : {dateTime(data.updated_at)}</span>}</div>
      </form>}
      <NoticeLine notice={notice} />
    </div>
  </section>;
}

function RegisterTab() {
  const { data, loading, error } = useApi<Register>('/privacy/admin/register');
  const list = (values: string[]) => values.join(' ; ');
  return <section className="card">
    <div className="card-header"><div><h2>Registre des activités de traitement</h2><p className="muted small">{data?.notice ?? 'Article 30 RGPD.'}</p></div>
      <a className="button button-secondary button-small" href="/api/privacy/admin/register/download" download><Download size={14} aria-hidden="true" /> Télécharger (JSON)</a></div>
    <div className="card-body">
      {loading && <Loading />}
      <ErrorState message={error} />
      {data && <div className="table-wrap"><table className="data-table privacy-register">
        <thead><tr><th scope="col">Traitement</th><th scope="col">Finalités</th><th scope="col">Base légale</th><th scope="col">Données</th><th scope="col">Destinataires / transferts</th><th scope="col">Conservation</th></tr></thead>
        <tbody>{data.activities.map((activity) => <tr key={activity.id}>
          <td><strong>{activity.name}</strong>{activity.source === 'module' && <><br /><Badge>Module</Badge></>}</td>
          <td>{list(activity.purposes)}</td><td>{activity.legal_basis}</td>
          <td>{list(activity.data_categories)}<br /><span className="small muted">Personnes : {list(activity.data_subjects)}</span></td>
          <td>{list(activity.recipients)}<br /><span className="small muted">{activity.transfers}</span></td>
          <td>{activity.retention}</td>
        </tr>)}</tbody>
      </table></div>}
    </div>
  </section>;
}

const toLocalInput = (value: string | null) => {
  if (!value) return '';
  const at = new Date(value);
  return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => value ? new Date(value).toISOString() : null;

interface BreachForm {
  title: string; detected_at: string; occurred_at: string; description: string; nature: string[]; data_categories: string; affected_count: number;
  risk_level: 'none' | 'risk' | 'high'; consequences: string; measures: string; notified_cnil_at: string; cnil_reference: string;
  notified_users_at: string; status: 'open' | 'closed';
}
const emptyBreach = (): BreachForm => ({
  title: '', detected_at: toLocalInput(new Date().toISOString()), occurred_at: '', description: '', nature: ['confidentiality'], data_categories: '',
  affected_count: 0, risk_level: 'risk', consequences: '', measures: '', notified_cnil_at: '', cnil_reference: '', notified_users_at: '', status: 'open',
});
const breachToForm = (breach: Breach): BreachForm => ({
  title: breach.title, detected_at: toLocalInput(breach.detected_at), occurred_at: toLocalInput(breach.occurred_at), description: breach.description,
  nature: breach.nature, data_categories: breach.data_categories.join(', '), affected_count: breach.affected_count, risk_level: breach.risk_level,
  consequences: breach.consequences, measures: breach.measures, notified_cnil_at: toLocalInput(breach.notified_cnil_at), cnil_reference: breach.cnil_reference,
  notified_users_at: toLocalInput(breach.notified_users_at), status: breach.status,
});

function BreachEditor({ breach, onClose, onSaved }: { breach: Breach | null; onClose: () => void; onSaved: (message: string) => void }) {
  const [form, setForm] = useState<BreachForm>(() => breach ? breachToForm(breach) : emptyBreach());
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const set = <K extends keyof BreachForm>(key: K, value: BreachForm[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    const body = {
      ...form,
      detected_at: fromLocalInput(form.detected_at), occurred_at: fromLocalInput(form.occurred_at),
      notified_cnil_at: fromLocalInput(form.notified_cnil_at), notified_users_at: fromLocalInput(form.notified_users_at),
      data_categories: form.data_categories.split(',').map((value) => value.trim()).filter(Boolean),
    };
    try {
      await api(breach ? `/privacy/admin/breaches/${breach.id}` : '/privacy/admin/breaches', { method: breach ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      onSaved(breach ? 'Incident mis à jour.' : 'Incident enregistré dans le registre.');
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  const field = (label: string, input: ReactNode, help?: string) => <label className="field">{label}{input}{help && <span className="help-text">{help}</span>}</label>;
  return <Modal title={breach ? 'Modifier l’incident' : 'Déclarer un incident'} onClose={onClose}>
    <form className="form privacy-breach-form" onSubmit={(event) => { void submit(event); }}>
      <ErrorState message={error} />
      {field('Titre', <input required minLength={3} maxLength={200} value={form.title} onChange={(event) => set('title', event.target.value)} />)}
      <div className="form-grid">
        {field('Détecté le', <input type="datetime-local" required value={form.detected_at} onChange={(event) => set('detected_at', event.target.value)} />, 'Point de départ du délai de 72 h.')}
        {field('Survenu le', <input type="datetime-local" value={form.occurred_at} onChange={(event) => set('occurred_at', event.target.value)} />)}
      </div>
      {field('Description', <textarea rows={3} required maxLength={10000} value={form.description} onChange={(event) => set('description', event.target.value)} />)}
      <fieldset className="privacy-fieldset"><legend className="small">Nature de la violation</legend>
        {Object.entries(natureLabels).map(([value, label]) => <label key={value} className="privacy-inline-check"><input type="checkbox" checked={form.nature.includes(value)}
          onChange={(event) => set('nature', event.target.checked ? [...form.nature, value] : form.nature.filter((item) => item !== value))} /> {label}</label>)}
      </fieldset>
      <div className="form-grid">
        {field('Catégories de données', <input value={form.data_categories} onChange={(event) => set('data_categories', event.target.value)} />, 'Séparées par des virgules (ex. e-mails, noms).')}
        {field('Personnes concernées (nombre)', <input type="number" min={0} value={form.affected_count} onChange={(event) => set('affected_count', Number(event.target.value))} />)}
        {field('Niveau de risque', <select value={form.risk_level} onChange={(event) => set('risk_level', event.target.value as BreachForm['risk_level'])}>
          {Object.entries(riskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>, 'Risque élevé : informer aussi les personnes (art. 34).')}
        {field('Statut', <select value={form.status} onChange={(event) => set('status', event.target.value as BreachForm['status'])}>
          <option value="open">Ouvert</option><option value="closed">Clôturé</option></select>)}
      </div>
      {field('Conséquences probables', <textarea rows={2} maxLength={10000} value={form.consequences} onChange={(event) => set('consequences', event.target.value)} />)}
      {field('Mesures prises ou envisagées', <textarea rows={2} maxLength={10000} value={form.measures} onChange={(event) => set('measures', event.target.value)} />)}
      <div className="form-grid">
        {field('CNIL notifiée le', <input type="datetime-local" value={form.notified_cnil_at} onChange={(event) => set('notified_cnil_at', event.target.value)} />)}
        {field('Référence CNIL', <input maxLength={200} value={form.cnil_reference} onChange={(event) => set('cnil_reference', event.target.value)} />)}
        {field('Personnes informées le', <input type="datetime-local" value={form.notified_users_at} onChange={(event) => set('notified_users_at', event.target.value)} />)}
      </div>
      <div className="row gap-sm"><button type="submit" className="button button-primary" disabled={pending}><Save size={14} aria-hidden="true" /> Enregistrer</button>
        <button type="button" className="button button-ghost" onClick={onClose}>Annuler</button></div>
    </form>
  </Modal>;
}

function BreachesTab() {
  const { data, loading, error, reload } = useApi<{ breaches: Breach[] }>('/privacy/admin/breaches');
  const [editing, setEditing] = useState<Breach | 'new' | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  async function remove(breach: Breach) {
    if (!window.confirm(`Supprimer « ${breach.title} » du registre ? Réservé aux saisies erronées.`)) return;
    await act(setNotice, () => api(`/privacy/admin/breaches/${breach.id}`, { method: 'DELETE' }), 'Incident supprimé.');
    reload();
  }

  return <section className="card">
    <div className="card-header"><div><h2>Registre des violations de données</h2>
      <p className="muted small">Toute violation est documentée (art. 33.5). Notification à la CNIL sous 72 h sauf risque improbable ; information des personnes si le risque est élevé. <a href="https://notifications.cnil.fr/notifications/index" target="_blank" rel="noopener noreferrer">Téléservice CNIL</a></p></div>
      <button type="button" className="button button-primary button-small" onClick={() => setEditing('new')}><Plus size={14} aria-hidden="true" /> Déclarer un incident</button></div>
    <div className="card-body">
      <NoticeLine notice={notice} />
      {loading && <Loading />}
      <ErrorState message={error} />
      {data && data.breaches.length === 0 && <EmptyState title="Aucun incident enregistré" description="Documentez ici toute violation, même mineure ou non notifiée." />}
      {data && data.breaches.length > 0 && <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Incident</th><th scope="col">Détection</th><th scope="col">Risque</th><th scope="col">Délai CNIL (72 h)</th><th scope="col">Statut</th><th scope="col">Actions</th></tr></thead>
        <tbody>{data.breaches.map((breach) => {
          const state = breachStates[breach.deadline.state];
          return <tr key={breach.id}>
            <td><strong>{breach.title}</strong><br /><span className="small muted">{breach.nature.map((value) => natureLabels[value] ?? value).join(', ')}{breach.affected_count ? ` · ${breach.affected_count} personne(s)` : ''}</span></td>
            <td>{dateTime(breach.detected_at)}</td>
            <td><Badge tone={breach.risk_level === 'high' ? 'red' : breach.risk_level === 'risk' ? 'orange' : 'neutral'}>{riskLabels[breach.risk_level]}</Badge></td>
            <td><Badge tone={state.tone}>{state.label}</Badge>
              {breach.deadline.state === 'pending' && <><br /><span className="small privacy-error-text">{breach.deadline.hours_left} h restantes (avant le {dateTime(breach.deadline.deadline)})</span></>}
              {breach.deadline.users_pending && <><br /><span className="small privacy-error-text">Information des personnes requise</span></>}</td>
            <td><Badge tone={breach.status === 'open' ? 'blue' : 'neutral'}>{breach.status === 'open' ? 'Ouvert' : 'Clôturé'}</Badge></td>
            <td><div className="row gap-sm">
              <button type="button" className="button button-ghost button-small" onClick={() => setEditing(breach)} aria-label={`Modifier ${breach.title}`}><Pencil size={13} aria-hidden="true" /></button>
              {Date.now() - Date.parse(breach.created_at) < 24 * 3600000 && <button type="button" className="button button-ghost button-small" onClick={() => { void remove(breach); }} aria-label={`Supprimer ${breach.title}`}><Trash2 size={13} aria-hidden="true" /></button>}
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </div>
    {editing && <BreachEditor breach={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
      onSaved={(message) => { setEditing(null); setNotice({ tone: 'success', message }); reload(); }} />}
  </section>;
}

const tabs = [
  { id: 'requests', label: 'Demandes' },
  { id: 'retention', label: 'Conservation' },
  { id: 'controller', label: 'Responsable' },
  { id: 'register', label: 'Registre art. 30' },
  { id: 'breaches', label: 'Violations' },
] as const;

export default function PrivacyAdmin() {
  const [tab, setTab] = useState<typeof tabs[number]['id']>('requests');
  const overview = useApi<Overview>('/privacy/admin/overview');
  return <div className="stack privacy-admin">
    {overview.data && <OverviewCards overview={overview.data} />}
    <ErrorState message={overview.error} />
    <div className="tabs" role="tablist" aria-label="Console RGPD">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`tab ${tab === item.id ? 'active' : ''}`}
        onClick={() => { setTab(item.id); overview.reload(); }}>{item.label}</button>)}
    </div>
    <div role="tabpanel">
      {tab === 'requests' && <RequestsTab />}
      {tab === 'retention' && <RetentionTab />}
      {tab === 'controller' && <ControllerTab />}
      {tab === 'register' && <RegisterTab />}
      {tab === 'breaches' && <BreachesTab />}
    </div>
  </div>;
}
