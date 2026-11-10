import { useEffect, useState, type FormEvent } from 'react';
import { Activity, CheckCircle2, Play, Settings2, ShieldAlert, UserCheck, XCircle } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { caseKindLabels, caseStatusLabels, EvidenceList, SanctionForm, ScoreMeter, signalLabel, type CaseSubject } from './UsersAdmin';
import '../styles/trust.css';

/** Risk cases queue, detection monitoring and anti-abuse thresholds — OWNER: trust module. Data: /api/trust/admin/*. */

interface RiskCase {
  id: string; user_id: string; kind: string; score: number; status: string; summary: string; evidence: Record<string, unknown>;
  related_user_ids: string[]; detections: number; assigned_to: string | null; assigned_name: string | null; resolution_note: string;
  resolved_by_name: string | null; resolved_at: string | null; created_at: string; last_detected_at: string; subjects: CaseSubject[];
}
interface CasesResponse { cases: RiskCase[]; total: number; limit: number; offset: number }
interface Stats {
  cases: { by_status: { status: string; count: number }[]; active_by_kind: { kind: string; count: number; max_score: number }[]; high: number; unassigned: number };
  signals: { by_kind: { kind: string; last_24h: number; last_7d: number }[]; shared_devices: number; without_device: number; total: number; retention_days: number };
  sanctions: { active_by_kind: { kind: string; count: number }[]; automated_active: number; last_30_days: number };
  appeals: { pending: number; overdue: number; accepted_rate_90d: number | null };
  detection: {
    last_run: { created: number; updated: number; auto_holds: number; failed: string[]; at: string } | null;
    job: { runs: number; last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_error: string | null; failures: number } | null;
    interval_minutes: number;
  };
}
type Group = Record<string, number | boolean>;
interface SettingsResponse {
  thresholds: Group; auto_actions: Group; retention: Group; appeals: Group; signal_retention_days: number;
  defaults: { thresholds: Group; auto_actions: Group; retention: Group; appeals: Group };
}
type GroupName = 'thresholds' | 'auto_actions' | 'retention' | 'appeals';

const fieldInfo: Record<string, { label: string; help: string; min: number; max: number }> = {
  window_days: { label: 'Fenêtre d’analyse (jours)', help: 'Période observée pour les appareils et réseaux partagés.', min: 1, max: 365 },
  multi_account_device_users: { label: 'Comptes par appareil', help: 'Nombre de comptes sur un même appareil déclenchant un dossier.', min: 2, max: 50 },
  ip_registrations_per_day: { label: 'Inscriptions par réseau / 24 h', help: 'Inscriptions depuis une même adresse publique en 24 heures.', min: 2, max: 500 },
  collusion_window_days: { label: 'Fenêtre collusion (jours)', help: 'Missions payées et commandes analysées.', min: 7, max: 365 },
  collusion_repeat_payouts: { label: 'Versements répétés', help: 'Versements d’un même propriétaire au même testeur.', min: 2, max: 100 },
  review_window_days: { label: 'Fenêtre avis (jours)', help: 'Période d’analyse des avis réciproques.', min: 7, max: 365 },
  review_burst_count: { label: 'Rafale d’avis', help: 'Avis de comptes récents reçus dans la fenêtre courte.', min: 2, max: 100 },
  review_burst_hours: { label: 'Fenêtre rafale (heures)', help: 'Durée de la fenêtre courte.', min: 1, max: 168 },
  new_account_days: { label: 'Compte récent (jours)', help: 'Ancienneté en dessous de laquelle un compte est « récent ».', min: 1, max: 90 },
  failed_logins_per_hour: { label: 'Échecs de connexion / heure', help: 'Tentatives échouées sur un même compte.', min: 3, max: 1000 },
  payment_failures_per_day: { label: 'Échecs de paiement / 24 h', help: 'Paiements refusés pour un même membre.', min: 2, max: 1000 },
  withdrawal_after_funding_hours: { label: 'Retrait après financement (heures)', help: 'Délai suspect entre un financement et un retrait.', min: 1, max: 720 },
  dismissed_cooldown_days: { label: 'Délai après classement (jours)', help: 'Un dossier classé n’est pas rouvert pour les mêmes comptes pendant ce délai.', min: 0, max: 365 },
  hold_days: { label: 'Durée de la retenue (jours)', help: 'Durée maximale de la retenue conservatoire des retraits.', min: 1, max: 90 },
  dismissed_cases_days: { label: 'Dossiers classés (jours)', help: 'Conservation des dossiers classés sans suite.', min: 30, max: 3650 },
  sanctions_years: { label: 'Sanctions (années)', help: 'Conservation des sanctions et appels après leur fin.', min: 1, max: 10 },
  sla_days: { label: 'Délai de traitement des appels (jours)', help: 'Engagement de réponse affiché aux membres.', min: 1, max: 60 },
  window_days_appeals: { label: 'Délai pour contester (jours)', help: 'Au moins 6 mois (DSA, art. 20).', min: 180, max: 730 },
};
const infoFor = (group: GroupName, key: string) => fieldInfo[group === 'appeals' && key === 'window_days' ? 'window_days_appeals' : key]
  ?? { label: key.replace(/_/g, ' '), help: '', min: 0, max: 100000 };

function StatsPanel({ stats, onDetected }: { stats: Stats; onDetected: (message: string) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = stats.cases.by_status.filter((row) => row.status === 'open' || row.status === 'reviewing').reduce((sum, row) => sum + row.count, 0);
  const sanctions = stats.sanctions.active_by_kind.reduce((sum, row) => sum + row.count, 0);
  const last = stats.detection.last_run ?? null;
  const job = stats.detection.job;

  async function detect() {
    setPending(true); setError('');
    try {
      const result = await api<{ ran: boolean; summary: Stats['detection']['last_run'] }>('/trust/admin/detect', { method: 'POST' });
      onDetected(!result.ran ? 'Une détection est déjà en cours.' : result.summary
        ? `Détection terminée : ${result.summary.created} nouveau${result.summary.created > 1 ? 'x' : ''} dossier${result.summary.created > 1 ? 's' : ''}, ${result.summary.updated} mis à jour.`
        : 'Détection terminée.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <section className="tr-section">
    <div className="tr-stats">
      <div className="stat-card"><span className="stat-label">Dossiers à traiter</span><strong className="stat-value">{active}</strong><span className="stat-note">{stats.cases.unassigned} non assigné{stats.cases.unassigned > 1 ? 's' : ''}</span></div>
      <div className="stat-card"><span className="stat-label">Risque élevé</span><strong className="stat-value">{stats.cases.high}</strong><span className="stat-note">score ≥ 70</span></div>
      <div className="stat-card"><span className="stat-label">Sanctions en vigueur</span><strong className="stat-value">{sanctions}</strong><span className="stat-note">{stats.sanctions.automated_active} mesure{stats.sanctions.automated_active > 1 ? 's' : ''} automatique{stats.sanctions.automated_active > 1 ? 's' : ''}</span></div>
      <div className="stat-card"><span className="stat-label">Appels en attente</span><strong className="stat-value">{stats.appeals.pending}</strong><span className={`stat-note ${stats.appeals.overdue ? 'tr-overdue' : ''}`}>{stats.appeals.overdue} hors délai</span></div>
      <div className="stat-card"><span className="stat-label">Appareils partagés</span><strong className="stat-value">{stats.signals.shared_devices}</strong><span className="stat-note">{stats.signals.without_device} signaux sans appareil (7 j)</span></div>
    </div>
    <div className="card"><div className="card-body stack">
      <div className="row-between">
        <div>
          <strong><Activity size={15} /> Détection automatique</strong>
          <p className="small muted">
            Toutes les {stats.detection.interval_minutes} minutes · {last ? `dernière exécution ${dateTime(last.at)}` : job?.last_finished_at ? `dernière exécution ${dateTime(job.last_finished_at)}` : 'pas encore exécutée depuis le démarrage'}
            {job ? ` · ${job.runs} exécution${job.runs > 1 ? 's' : ''}, ${job.failures} échec${job.failures > 1 ? 's' : ''}` : ''}
          </p>
          {last?.failed.length ? <p className="small text-warning">Détecteurs en erreur : {last.failed.join(', ')}</p> : null}
          {job?.last_status === 'failed' && job.last_error && <p className="small text-warning">Dernière erreur : {job.last_error}</p>}
        </div>
        <button className="button button-primary" type="button" onClick={() => void detect()} disabled={pending}><Play size={15} /> {pending ? 'Analyse…' : 'Lancer la détection'}</button>
      </div>
      <ErrorState message={error} />
    </div></div>
  </section>;
}

function CaseCard({ item, onChanged }: { item: RiskCase; onChanged: (message: string) => void }) {
  const { user: me } = useAuth();
  const [mode, setMode] = useState<'none' | 'dismiss' | 'action'>('none');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const open = item.status === 'open' || item.status === 'reviewing';

  async function post(path: string, body: unknown, message: string) {
    setPending(true); setError('');
    try {
      await api(`/trust/admin/cases/${encodeURIComponent(item.id)}/${path}`, { method: 'POST', body: JSON.stringify(body) });
      setMode('none'); setNote('');
      onChanged(message);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  function dismiss(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void post('dismiss', { note: note.trim() }, 'Dossier classé sans suite.');
  }

  return <article className={`tr-card ${item.score >= 70 && open ? 'tr-card-active' : item.score >= 40 && open ? 'tr-card-warning' : ''}`}>
    <div className="tr-card-head">
      <h3>{caseKindLabels[item.kind] ?? item.kind}
        <Badge tone={item.status === 'open' ? 'orange' : item.status === 'reviewing' ? 'blue' : item.status === 'actioned' ? 'red' : 'neutral'}>{caseStatusLabels[item.status] ?? item.status}</Badge>
      </h3>
      <ScoreMeter score={item.score} />
    </div>
    <p className="small">{item.summary}</p>
    <ul className="tr-chips" aria-label="Comptes concernés">{item.subjects.map((subject) => <li key={subject.user_id} className={subject.role === 'primary' ? 'tr-chip-danger' : ''}>
      {subject.name}{subject.role === 'primary' ? ' · sujet principal' : ''}{subject.user_role === 'admin' ? ' · admin' : ''}
    </li>)}</ul>
    <details className="tr-history"><summary>Éléments de preuve</summary><EvidenceList evidence={item.evidence} /></details>
    <p className="tr-card-meta">
      Ouvert le {dateTime(item.created_at)} · dernière détection {dateTime(item.last_detected_at)} · {item.detections} détection{item.detections > 1 ? 's' : ''}
      {item.assigned_name ? ` · assigné à ${item.assigned_name}` : ' · non assigné'}
      {item.resolved_at && ` · clôturé le ${dateTime(item.resolved_at)}${item.resolved_by_name ? ` par ${item.resolved_by_name}` : ''}`}
    </p>
    {item.resolution_note && <p className="tr-quote tr-internal">{item.resolution_note}</p>}
    <ErrorState message={error} />
    {open && mode === 'none' && <div className="tr-actions">
      {item.assigned_to !== me?.id && <button className="button button-secondary button-small" type="button" disabled={pending}
        onClick={() => void post('assign', {}, 'Dossier assigné à vous.')}><UserCheck size={14} /> M’assigner</button>}
      {item.assigned_to && <button className="button button-ghost button-small" type="button" disabled={pending}
        onClick={() => void post('assign', { assignee_id: null }, 'Dossier remis dans la file.')}>Libérer</button>}
      <button className="button button-secondary button-small" type="button" disabled={pending} onClick={() => setMode('dismiss')}><XCircle size={14} /> Classer sans suite</button>
      <button className="button button-danger button-small" type="button" disabled={pending} onClick={() => setMode('action')}><ShieldAlert size={14} /> Sanctionner</button>
    </div>}
    {open && mode === 'dismiss' && <form className="tr-form" onSubmit={dismiss}>
      <label className="field">Motif du classement (interne)
        <textarea value={note} onChange={(event) => setNote(event.target.value)} required minLength={5} maxLength={2000} rows={2} disabled={pending}
          placeholder="ex. Colocataires vérifiés, réseau d’entreprise, faux positif…" />
      </label>
      <p className="help-text">Les retenues conservatoires liées à ce dossier sont levées automatiquement.</p>
      <div className="tr-actions">
        <button className="button button-primary button-small" type="submit" disabled={pending || note.trim().length < 5}><CheckCircle2 size={14} /> Confirmer le classement</button>
        <button className="button button-ghost button-small" type="button" onClick={() => setMode('none')} disabled={pending}>Annuler</button>
      </div>
    </form>}
    {open && mode === 'action' && <div className="stack">
      <SanctionForm endpoint={`/trust/admin/cases/${encodeURIComponent(item.id)}/action`} subjects={item.subjects} caseNote submitLabel="Sanctionner et clôturer"
        onDone={(message) => { setMode('none'); onChanged(`${message} Dossier clôturé.`); }} />
      <div className="tr-actions"><button className="button button-ghost button-small" type="button" onClick={() => setMode('none')}>Annuler</button></div>
    </div>}
  </article>;
}

const PAGE = 20;

function CasesQueue({ revision, onChanged }: { revision: number; onChanged: () => void }) {
  const [status, setStatus] = useState('active');
  const [kind, setKind] = useState('');
  const [assigned, setAssigned] = useState('');
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState('');
  const params = new URLSearchParams({ status, limit: String(PAGE), offset: String(offset) });
  if (kind) params.set('kind', kind);
  if (assigned) params.set('assigned', assigned);
  params.set('r', String(revision));
  const cases = useApi<CasesResponse>(`/trust/admin/cases?${params}`);
  const reset = (setter: (value: string) => void) => (value: string) => { setter(value); setOffset(0); };
  const changed = (message: string) => { setNotice(message); cases.reload(); onChanged(); };

  return <section className="tr-section">
    <h2><ShieldAlert size={18} /> Dossiers de risque</h2>
    <div className="tr-toolbar">
      <label className="field">Statut<select value={status} onChange={(event) => reset(setStatus)(event.target.value)}>
        <option value="active">À traiter</option><option value="open">Ouverts</option><option value="reviewing">En examen</option>
        <option value="actioned">Sanctionnés</option><option value="dismissed">Classés</option><option value="all">Tous</option>
      </select></label>
      <label className="field">Type<select value={kind} onChange={(event) => reset(setKind)(event.target.value)}>
        <option value="">Tous</option>{Object.entries(caseKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="field">Assignation<select value={assigned} onChange={(event) => reset(setAssigned)(event.target.value)}>
        <option value="">Tous</option><option value="me">Mes dossiers</option><option value="none">Non assignés</option>
      </select></label>
    </div>
    {notice && <p className="alert alert-success" role="status">{notice}</p>}
    {cases.loading ? <Loading /> : cases.error ? <ErrorState message={cases.error} /> : cases.data?.cases.length ? <>
      <div className="tr-cards">{cases.data.cases.map((item) => <CaseCard key={item.id} item={item} onChanged={changed} />)}</div>
      <div className="tr-pager">
        <span>{cases.data.offset + 1}–{cases.data.offset + cases.data.cases.length} sur {cases.data.total}</span>
        <span className="tr-actions">
          <button className="button button-secondary button-small" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
          <button className="button button-secondary button-small" type="button" disabled={offset + cases.data.cases.length >= cases.data.total} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
        </span>
      </div>
    </> : <EmptyState title="Aucun dossier" description="Aucune alerte ne correspond à ces filtres." />}
  </section>;
}

function SignalsTable({ stats }: { stats: Stats }) {
  return <section className="tr-section">
    <h2><Activity size={18} /> Signaux collectés</h2>
    <p className="tr-intro">Empreintes à clé secrète uniquement (aucune adresse IP ni identifiant d’appareil en clair). {stats.signals.total} signaux conservés, purgés après {stats.signals.retention_days} jours.</p>
    {stats.signals.by_kind.length ? <div className="card"><div className="table-wrap"><table className="data-table">
      <thead><tr><th>Type</th><th>24 heures</th><th>7 jours</th></tr></thead>
      <tbody>{stats.signals.by_kind.map((row) => <tr key={row.kind}><td>{signalLabel(row.kind)}</td><td className="tr-num">{row.last_24h}</td><td className="tr-num">{row.last_7d}</td></tr>)}</tbody>
    </table></div></div> : <p className="small muted">Aucun signal sur les 7 derniers jours.</p>}
    {stats.cases.active_by_kind.length > 0 && <ul className="tr-chips">{stats.cases.active_by_kind.map((row) => <li key={row.kind}>
      {caseKindLabels[row.kind] ?? row.kind} : {row.count} (max {row.max_score})
    </li>)}</ul>}
  </section>;
}

function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const settings = useApi<SettingsResponse>('/trust/admin/settings');
  const [draft, setDraft] = useState<Record<GroupName, Group> | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (settings.data) setDraft({ thresholds: settings.data.thresholds, auto_actions: settings.data.auto_actions, retention: settings.data.retention, appeals: settings.data.appeals });
  }, [settings.data]);

  function update(group: GroupName, key: string, value: number | boolean) {
    setDraft((current) => current && { ...current, [group]: { ...current[group], [key]: value } });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setPending(true); setMessage(''); setError('');
    try {
      await api('/trust/admin/settings', { method: 'PUT', body: JSON.stringify(draft) });
      setMessage('Réglages enregistrés. Ils s’appliquent à la prochaine détection.');
      settings.reload(); onSaved();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  function restore() {
    if (settings.data && window.confirm('Rétablir les valeurs par défaut (à enregistrer ensuite) ?')) setDraft({ ...settings.data.defaults });
  }

  if (settings.loading) return <Loading />;
  if (settings.error) return <ErrorState message={settings.error} />;
  if (!draft || !settings.data) return null;
  const numbers = (group: GroupName) => Object.entries(draft[group]).filter(([, value]) => typeof value === 'number').map(([key, value]) => {
    const info = infoFor(group, key);
    const fallback = settings.data!.defaults[group][key];
    return <label key={`${group}.${key}`} className="field">{info.label}
      <input type="number" min={info.min} max={info.max} step={1} required value={Number(value)} disabled={pending}
        onChange={(event) => update(group, key, Math.round(Number(event.target.value)))} />
      <small>{info.help} Défaut : {String(fallback)}.</small>
    </label>;
  });

  return <section className="tr-section">
    <h2><Settings2 size={18} /> Seuils et réglages</h2>
    <form className="card" onSubmit={save}><div className="card-body tr-form">
      <h3>Seuils des détecteurs</h3>
      <div className="tr-settings">{numbers('thresholds')}</div>
      <h3>Actions automatiques</h3>
      <p className="tr-notice"><ShieldAlert size={16} />Seule la retenue conservatoire des retraits peut être automatique (risque élevé). Aucun bannissement ni suspension n’est jamais décidé sans intervention humaine.</p>
      <label className="tr-check"><input type="checkbox" checked={draft.auto_actions.hold_withdrawals_on_high_risk === true} disabled={pending}
        onChange={(event) => update('auto_actions', 'hold_withdrawals_on_high_risk', event.target.checked)} />
        Retenir automatiquement les retraits des comptes à risque élevé, le temps de l’examen</label>
      <div className="tr-settings">{numbers('auto_actions')}</div>
      <h3>Appels</h3>
      <div className="tr-settings">{numbers('appeals')}</div>
      <h3>Conservation</h3>
      <div className="tr-settings">{numbers('retention')}</div>
      <p className="help-text">Les signaux techniques sont conservés {settings.data.signal_retention_days} jours (réglage de la page Confidentialité, privacy.retention).</p>
      {message && <p className="alert alert-success" role="status">{message}</p>}
      <ErrorState message={error} />
      <div className="tr-actions tr-actions-end">
        <button className="button button-ghost" type="button" onClick={restore} disabled={pending}>Valeurs par défaut</button>
        <button className="button button-primary" type="submit" disabled={pending}>{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </div></form>
  </section>;
}

export default function RiskAdmin() {
  const stats = useApi<Stats>('/trust/admin/stats');
  const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<'cases' | 'signals' | 'settings'>('cases');
  const [message, setMessage] = useState('');
  const refresh = () => stats.reload();

  return <div className="tr-page">
    {message && <p className="alert alert-success" role="status">{message}</p>}
    {stats.loading ? <Loading /> : stats.error ? <ErrorState message={stats.error} /> : stats.data &&
      <StatsPanel stats={stats.data} onDetected={(text) => { setMessage(text); refresh(); setRevision((value) => value + 1); }} />}
    <div className="tabs" role="tablist" aria-label="Fraude et sanctions">
      <button className={`tab ${tab === 'cases' ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === 'cases'} onClick={() => setTab('cases')}>Dossiers</button>
      <button className={`tab ${tab === 'signals' ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === 'signals'} onClick={() => setTab('signals')}>Signaux</button>
      <button className={`tab ${tab === 'settings' ? 'active' : ''}`} type="button" role="tab" aria-selected={tab === 'settings'} onClick={() => setTab('settings')}>Réglages</button>
    </div>
    {tab === 'cases' && <CasesQueue revision={revision} onChanged={refresh} />}
    {tab === 'signals' && (stats.data ? <SignalsTable stats={stats.data} /> : <Loading />)}
    {tab === 'settings' && <SettingsForm onSaved={refresh} />}
  </div>;
}
