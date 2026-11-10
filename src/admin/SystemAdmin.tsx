import { Archive, CircleCheck, CircleX, Info, Play, RefreshCw, Save, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Badge, EmptyState, ErrorState, Loading, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import '../styles/ops.css';

/** System administration — OWNER: ops module. Environment checks, backups, jobs and settings audit trail. */

type CheckStatus = 'ok' | 'warning' | 'error' | 'info';
interface EnvironmentCheck { id: string; label: string; status: CheckStatus; detail: string }
interface Artifact { file: string; bytes: number; sha256: string }
interface Backup { id: string; created_at: string; app_version: string; schema_version: number | null; database: Artifact; files: Artifact | null; files_skipped?: string }
interface BackupSettings { enabled: boolean; keep: number; include_files: boolean }
interface BackupsResponse { directory: string; settings: BackupSettings; in_progress: boolean; backups: Backup[] }
interface Job { name: string; description: string; interval_ms: number; enabled: boolean; running: boolean; runs: number; failures: number; last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_error: string }
interface JobsResponse { jobs: Job[]; scheduler: 'on' | 'off' }
interface SettingsAudit {
  settings: Array<{ key: string; updated_at: string; secret_configured: boolean; updated_by_name: string | null }>;
  events: Array<{ id: string; action: string; target_type: string; target_id: string; detail: string; created_at: string; actor_name: string | null }>;
}

const statusTone: Record<CheckStatus, string> = { ok: 'green', warning: 'orange', error: 'red', info: 'blue' };
const statusLabel: Record<CheckStatus, string> = { ok: 'OK', warning: 'À surveiller', error: 'À corriger', info: 'Information' };

function bytes(value: number) {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: unit ? 1 : 0 }).format(size)} ${units[unit]}`;
}

function interval(ms: number) {
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)} j`;
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}

function CheckIcon({ status }: { status: CheckStatus }) {
  const Icon = status === 'ok' ? CircleCheck : status === 'error' ? CircleX : status === 'warning' ? TriangleAlert : Info;
  return <Icon className={`ops-check-icon ${status}`} size={18} aria-hidden="true" />;
}

function EnvironmentPanel() {
  const { data, loading, error, reload } = useApi<{ checks: EnvironmentCheck[] }>('/system/admin/environment');
  const problems = data?.checks.filter((check) => check.status === 'error').length ?? 0;
  return <section className="card" aria-labelledby="ops-env-title">
    <div className="card-header">
      <h2 id="ops-env-title">Contrôles d’environnement</h2>
      <span className="row">
        {data && <Badge tone={problems ? 'red' : 'green'}>{problems ? `${problems} à corriger` : 'Aucun problème bloquant'}</Badge>}
        <button type="button" className="button button-secondary button-small" onClick={reload} disabled={loading}><RefreshCw size={14} aria-hidden="true" /> Revérifier</button>
      </span>
    </div>
    <div className="card-body">
      {loading ? <Loading /> : error ? <ErrorState message={error} /> : <ul className="list" aria-label="Résultats des contrôles">
        {data!.checks.map((check) => <li key={check.id} className="ops-check">
          <CheckIcon status={check.status} />
          <span className="row"><strong>{check.label}</strong><Badge tone={statusTone[check.status]}>{statusLabel[check.status]}</Badge></span>
          <p>{check.detail}</p>
        </li>)}
      </ul>}
      <p className="help-text">Les valeurs secrètes ne sont jamais affichées. Les variables d’environnement se modifient dans <code>deploy/.env</code> puis <code>docker compose up -d</code>.</p>
    </div>
  </section>;
}

function BackupsPanel() {
  const { data, loading, error, reload } = useApi<BackupsResponse>('/system/admin/backups');
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [busy, setBusy] = useState<'backup' | 'settings' | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => { if (data) setSettings(data.settings); }, [data]);

  async function backupNow() {
    setBusy('backup'); setStatus(null);
    try {
      const { backup } = await api<{ backup: Backup }>('/system/admin/backups', { method: 'POST', body: JSON.stringify({}) });
      setStatus({ tone: 'success', message: `Sauvegarde ${backup.id} créée (${bytes(backup.database.bytes + (backup.files?.bytes ?? 0))}).` });
      reload();
    } catch (failure) {
      setStatus({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy('settings'); setStatus(null);
    try {
      const saved = await api<{ settings: BackupSettings }>('/system/admin/backups/settings', { method: 'PUT', body: JSON.stringify(settings) });
      setSettings(saved.settings);
      setStatus({ tone: 'success', message: 'Réglages des sauvegardes enregistrés.' });
    } catch (failure) {
      setStatus({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setBusy(null);
    }
  }

  return <section className="card" aria-labelledby="ops-backups-title">
    <div className="card-header">
      <h2 id="ops-backups-title" className="ops-section-title"><Archive size={18} aria-hidden="true" /> Sauvegardes</h2>
      <button type="button" className="button button-primary button-small" onClick={backupNow} disabled={busy !== null || !!data?.in_progress}>
        <Archive size={14} aria-hidden="true" /> {busy === 'backup' || data?.in_progress ? 'Sauvegarde en cours…' : 'Sauvegarder maintenant'}
      </button>
    </div>
    <div className="card-body stack">
      <div aria-live="polite">{status && <div className={`alert alert-${status.tone}`}>{status.message}</div>}</div>
      {loading ? <Loading /> : error ? <ErrorState message={error} /> : <>
        {settings && <form className="ops-inline-form" onSubmit={saveSettings} aria-label="Réglages des sauvegardes automatiques">
          <label className="ops-checkbox" htmlFor="ops-backup-enabled">
            <input id="ops-backup-enabled" type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} />
            Sauvegarde quotidienne automatique
          </label>
          <label className="ops-checkbox" htmlFor="ops-backup-files">
            <input id="ops-backup-files" type="checkbox" checked={settings.include_files} onChange={(event) => setSettings({ ...settings, include_files: event.target.checked })} />
            Inclure les fichiers déposés
          </label>
          <label className="field" htmlFor="ops-backup-keep">
            Nombre de sauvegardes conservées
            <input id="ops-backup-keep" type="number" min={1} max={365} required value={settings.keep}
              onChange={(event) => setSettings({ ...settings, keep: Math.max(1, Math.min(365, Number(event.target.value) || 1)) })} aria-describedby="ops-backup-keep-help" />
          </label>
          <button type="submit" className="button button-secondary button-small" disabled={busy !== null}><Save size={14} aria-hidden="true" /> Enregistrer</button>
        </form>}
        <p id="ops-backup-keep-help" className="help-text">
          Copie cohérente à chaud (<code>VACUUM INTO</code>), compressée, avec somme SHA-256, dans <span className="ops-mono">{data!.directory}</span>.
          Copiez ce dossier hors du serveur (restic, rclone) : une sauvegarde sur le même disque ne protège pas d’une panne matérielle.
          Restauration : <code>npm run restore -- &lt;id&gt;.json</code>, serveur arrêté.
        </p>
        {data!.backups.length === 0 ? <EmptyState title="Aucune sauvegarde" description="Lancez une première sauvegarde pour vérifier la configuration." /> : <div className="table-wrap">
          <table className="data-table">
            <caption className="muted small" style={{ textAlign: 'left', paddingBottom: 8 }}>{data!.backups.length} sauvegarde(s), la plus récente en premier</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Identifiant</th><th scope="col">Base</th><th scope="col">Fichiers</th><th scope="col">Schéma / version</th><th scope="col">SHA-256</th></tr></thead>
            <tbody>
              {data!.backups.map((backup) => <tr key={backup.id}>
                <td>{dateTime(backup.created_at)}</td>
                <td className="ops-mono">{backup.id}</td>
                <td>{bytes(backup.database.bytes)}</td>
                <td>{backup.files ? bytes(backup.files.bytes) : <span className="muted">{backup.files_skipped ? 'ignorés' : 'non inclus'}</span>}</td>
                <td>v{backup.schema_version ?? '?'} · {backup.app_version}</td>
                <td className="ops-mono" title={backup.database.sha256}>{backup.database.sha256.slice(0, 12)}…</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
      </>}
    </div>
  </section>;
}

function JobsPanel() {
  const { data, loading, error, reload } = useApi<JobsResponse>('/system/admin/jobs');
  const [running, setRunning] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

  async function run(name: string) {
    setRunning(name); setStatus(null);
    try {
      const result = await api<{ status: 'ok' | 'failed'; error: string }>(`/system/admin/jobs/${encodeURIComponent(name)}/run`, { method: 'POST', body: JSON.stringify({}) });
      setStatus(result.status === 'ok'
        ? { tone: 'success', message: `Tâche ${name} exécutée.` }
        : { tone: 'error', message: `Tâche ${name} en échec : ${result.error}` });
      reload();
    } catch (failure) {
      setStatus({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setRunning(null);
    }
  }

  return <section className="card" aria-labelledby="ops-jobs-admin-title">
    <div className="card-header">
      <h2 id="ops-jobs-admin-title">Tâches planifiées</h2>
      {data && <Badge tone={data.scheduler === 'off' ? 'orange' : 'green'}>{data.scheduler === 'off' ? 'Planificateur désactivé (ALPHA_JOBS=off)' : 'Planificateur actif'}</Badge>}
    </div>
    <div className="card-body stack">
      <div aria-live="polite">{status && <div className={`alert alert-${status.tone}`}>{status.message}</div>}</div>
      {loading ? <Loading /> : error ? <ErrorState message={error} /> : data!.jobs.length === 0 ? <EmptyState title="Aucune tâche enregistrée" /> : <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th scope="col">Tâche</th><th scope="col">Fréquence</th><th scope="col">Dernier résultat</th><th scope="col">Exécutions</th><th scope="col"><span className="muted">Action</span></th></tr></thead>
          <tbody>
            {data!.jobs.map((job) => <tr key={job.name}>
              <td><span className="ops-mono">{job.name}</span><div className="muted small">{job.description}</div></td>
              <td>{interval(job.interval_ms)}{!job.enabled && <div><Badge tone="neutral">Désactivée</Badge></div>}</td>
              <td>
                {job.running ? <Badge tone="blue">En cours</Badge> : job.last_status === 'failed' ? <Badge tone="red">Échec</Badge> : job.last_status === 'ok' ? <Badge tone="green">OK</Badge> : <Badge tone="neutral">Jamais</Badge>}
                {job.last_finished_at && <div className="muted small">{dateTime(job.last_finished_at)}</div>}
                {job.last_status === 'failed' && job.last_error && <div className="ops-error-text">{job.last_error}</div>}
              </td>
              <td>{job.runs}{job.failures ? <span className="muted"> · {job.failures} échec(s)</span> : null}</td>
              <td><button type="button" className="button button-secondary button-small" onClick={() => run(job.name)} disabled={running !== null || job.running} aria-label={`Exécuter la tâche ${job.name} maintenant`}>
                <Play size={13} aria-hidden="true" /> {running === job.name ? 'Exécution…' : 'Exécuter'}
              </button></td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </div>
  </section>;
}

function SettingsAuditPanel() {
  const { data, loading, error } = useApi<SettingsAudit>('/system/admin/settings-audit');
  return <section className="card" aria-labelledby="ops-audit-trail-title">
    <div className="card-header"><h2 id="ops-audit-trail-title">Réglages et actions d’administration</h2></div>
    <div className="card-body">
      {loading ? <Loading /> : error ? <ErrorState message={error} /> : <div className="ops-columns">
        <div className="table-wrap">
          {data!.settings.length === 0 ? <p className="muted small">Aucun réglage enregistré.</p> : <table className="data-table">
            <caption className="muted small" style={{ textAlign: 'left', paddingBottom: 8 }}>Dernière modification de chaque réglage (valeurs masquées)</caption>
            <thead><tr><th scope="col">Réglage</th><th scope="col">Modifié</th><th scope="col">Par</th><th scope="col">Secret</th></tr></thead>
            <tbody>
              {data!.settings.map((setting) => <tr key={setting.key}>
                <td className="ops-mono">{setting.key}</td>
                <td>{dateTime(setting.updated_at)}</td>
                <td>{setting.updated_by_name ?? <span className="muted">Système</span>}</td>
                <td>{setting.secret_configured ? <Badge tone="purple">Chiffré</Badge> : <span className="muted">—</span>}</td>
              </tr>)}
            </tbody>
          </table>}
        </div>
        <div>
          <h3 className="small">Actions récentes des administrateurs</h3>
          {data!.events.length === 0 ? <p className="muted small">Aucune action enregistrée.</p> : <ul className="list">
            {data!.events.slice(0, 30).map((event) => <li key={event.id} className="list-item">
              <div className="stack gap-sm">
                <span className="ops-mono">{event.action}</span>
                <span className="muted small">{event.actor_name ?? '—'} · {event.target_type} · {dateTime(event.created_at)}</span>
              </div>
            </li>)}
          </ul>}
        </div>
      </div>}
    </div>
  </section>;
}

export default function SystemAdmin() {
  return <div className="stack">
    <EnvironmentPanel />
    <BackupsPanel />
    <JobsPanel />
    <SettingsAuditPanel />
    <section className="card" aria-labelledby="ops-metrics-title">
      <div className="card-header"><h2 id="ops-metrics-title">Supervision</h2></div>
      <div className="card-body stack">
        <dl className="ops-kv">
          <dt>Vivacité</dt><dd className="ops-mono">GET /api/health</dd>
          <dt>Disponibilité</dt><dd className="ops-mono">GET /api/system/ready (503 si base, migrations ou clé de chiffrement indisponibles)</dd>
          <dt>Métriques</dt><dd className="ops-mono">GET /api/system/metrics — Authorization: Bearer $METRICS_TOKEN (format Prometheus)</dd>
        </dl>
        <p className="help-text">Exemples d’alertes Prometheus et procédures d’incident : <code>docs/operations.md</code>.</p>
      </div>
    </section>
  </div>;
}
