import { Activity, Archive, CreditCard, Database, HardDrive, Mail, RefreshCw, ShoppingBag, UserPlus, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Badge, EmptyState, ErrorState, Loading, useApi } from '../components/ui';
import { dateTime } from '../lib/api';
import '../styles/ops.css';

/** Admin overview — OWNER: ops module. Data from GET /api/system/admin/overview. */

interface Job { name: string; description: string; enabled: boolean; running: boolean; runs: number; failures: number; last_status: string | null; last_finished_at: string | null; last_error: string }
interface Backup { id: string; created_at: string; database: { bytes: number }; files: { bytes: number } | null }
interface AuditEvent { id: string; action: string; target_type: string; target_id: string; created_at: string; actor_name: string | null }
interface Overview {
  version: string;
  node_version: string;
  environment: string;
  started_at: string;
  uptime_seconds: number;
  payment_mode: string;
  counts: { users: number; admins: number; signups_7d: number; active_sessions: number; projects: number; campaigns: number; campaigns_open: number; orders: number; orders_disputed: number };
  files: { total: number; bytes: number; pending_scan: number; infected: number } | null;
  disk: { database_bytes: number; free_pages_bytes: number; wal_bytes: number; backups_bytes: number; free_bytes: number | null; total_bytes: number | null };
  jobs: { total: number; failing: number; running: number; disabled: number; scheduler: string; items: Job[] };
  outbox: { queued: number; failed: number; sent: number; logged: number; failed_24h: number };
  payment_intents: Record<string, number> | null;
  backups: { count: number; latest: Backup | null; settings: { enabled: boolean; keep: number }; in_progress: boolean };
  recent_audit: AuditEvent[];
}

const number = new Intl.NumberFormat('fr-FR');

function bytes(value: number | null | undefined) {
  if (value === null || value === undefined) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: unit ? 1 : 0 }).format(size)} ${units[unit]}`;
}

function duration(seconds: number) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} j ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

const paymentModes: Record<string, string> = { demo: 'Démonstration', test: 'Test (bac à sable)', live: 'Production (réel)' };

function Stat({ icon, tone, label, value, note }: { icon: ReactNode; tone: string; label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="stat-card">
    <div className="row-between"><span className="stat-label">{label}</span><span className={`stat-icon ${tone}`} aria-hidden="true">{icon}</span></div>
    <div className="stat-value">{value}</div>
    {note && <div className="stat-note">{note}</div>}
  </div>;
}

function JobStatus({ job }: { job: Job }) {
  if (job.running) return <Badge tone="blue">En cours</Badge>;
  if (!job.enabled) return <Badge tone="neutral">Désactivée</Badge>;
  if (job.last_status === 'failed') return <Badge tone="red">Échec</Badge>;
  if (job.last_status === 'ok') return <Badge tone="green">OK</Badge>;
  return <Badge tone="neutral">Jamais exécutée</Badge>;
}

export default function OverviewAdmin() {
  const { data, loading, error, reload } = useApi<Overview>('/system/admin/overview');
  if (loading) return <Loading />;
  if (error || !data) return <ErrorState message={error || 'Vue d’ensemble indisponible.'} />;

  const latestBackupAge = data.backups.latest ? (Date.now() - new Date(data.backups.latest.created_at).getTime()) / 3_600_000 : null;
  const staleBackup = latestBackupAge !== null && latestBackupAge > 26;
  const intents = data.payment_intents ? Object.entries(data.payment_intents) : [];
  const failingJobs = data.jobs.items.filter((job) => job.last_status === 'failed');
  const warnings = failingJobs.length > 0 || data.outbox.failed_24h > 0 || staleBackup || !!data.files?.infected;

  return <div className="stack">
    <div className="row-between">
      <p className="muted small">Alpha {data.version} · Node {data.node_version} · {data.environment} · démarré il y a {duration(data.uptime_seconds)}</p>
      <button type="button" className="button button-secondary button-small" onClick={reload}><RefreshCw size={14} aria-hidden="true" /> Actualiser</button>
    </div>

    {warnings && <div className="alert alert-error" role="status">
      {failingJobs.length > 0 && <div>{failingJobs.length} tâche(s) en échec : {failingJobs.map((job) => job.name).join(', ')}.</div>}
      {data.outbox.failed_24h > 0 && <div>{data.outbox.failed_24h} e-mail(s) en échec ces dernières 24 h.</div>}
      {staleBackup && <div>Dernière sauvegarde il y a {Math.floor(latestBackupAge!)} h.</div>}
      {!!data.files?.infected && <div>{data.files.infected} fichier(s) infecté(s) en quarantaine.</div>}
    </div>}

    <div className="stat-grid ops-stats">
      <Stat icon={<Users size={18} />} tone="purple" label="Comptes" value={number.format(data.counts.users)} note={`${data.counts.admins} administrateur(s)`} />
      <Stat icon={<UserPlus size={18} />} tone="green" label="Inscriptions (7 j)" value={number.format(data.counts.signups_7d)} note={`${number.format(data.counts.active_sessions)} session(s) active(s)`} />
      <Stat icon={<ShoppingBag size={18} />} tone="orange" label="Commandes" value={number.format(data.counts.orders)} note={data.counts.orders_disputed ? `${data.counts.orders_disputed} en litige` : 'Aucun litige'} />
      <Stat icon={<Activity size={18} />} tone="blue" label="Campagnes" value={number.format(data.counts.campaigns)} note={`${data.counts.campaigns_open} ouverte(s) · ${number.format(data.counts.projects)} projet(s)`} />
      <Stat icon={<CreditCard size={18} />} tone="purple" label="Mode de paiement" value={<span className="small">{paymentModes[data.payment_mode] ?? data.payment_mode}</span>}
        note={intents.length ? intents.map(([status, count]) => `${status} : ${count}`).join(' · ') : 'Aucune intention de paiement'} />
      <Stat icon={<Mail size={18} />} tone={data.outbox.failed ? 'orange' : 'green'} label="E-mails en attente" value={number.format(data.outbox.queued)}
        note={`${data.outbox.failed} en échec · ${number.format(data.outbox.sent)} envoyé(s)`} />
      <Stat icon={<Database size={18} />} tone="blue" label="Base de données" value={bytes(data.disk.database_bytes)}
        note={`WAL ${bytes(data.disk.wal_bytes)} · ${data.disk.free_bytes === null ? 'espace disque inconnu' : `${bytes(data.disk.free_bytes)} libres sur le disque`}`} />
      <Stat icon={<HardDrive size={18} />} tone="green" label="Fichiers" value={data.files ? number.format(data.files.total) : '—'}
        note={data.files ? `${bytes(data.files.bytes)} · ${data.files.pending_scan} en analyse` : 'Module fichiers indisponible'} />
    </div>

    <div className="ops-columns">
      <section className="card" aria-labelledby="ops-jobs-title">
        <div className="card-header">
          <h2 id="ops-jobs-title">Tâches planifiées</h2>
          <span className="row">
            {data.jobs.scheduler === 'off' && <Badge tone="orange">Planificateur désactivé</Badge>}
            <Badge tone={data.jobs.failing ? 'red' : 'green'}>{data.jobs.failing ? `${data.jobs.failing} en échec` : 'Toutes saines'}</Badge>
          </span>
        </div>
        {data.jobs.items.length === 0 ? <div className="card-body"><EmptyState title="Aucune tâche enregistrée" /></div> : <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th scope="col">Tâche</th><th scope="col">État</th><th scope="col">Exécutions</th><th scope="col">Dernière fin</th></tr></thead>
            <tbody>
              {data.jobs.items.map((job) => <tr key={job.name}>
                <td><span className="ops-mono">{job.name}</span>{job.last_status === 'failed' && job.last_error && <div className="ops-error-text">{job.last_error}</div>}</td>
                <td><JobStatus job={job} /></td>
                <td>{number.format(job.runs)}{job.failures ? <span className="muted"> ({job.failures} échec(s))</span> : null}</td>
                <td>{job.last_finished_at ? dateTime(job.last_finished_at) : '—'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>}
        <div className="card-footer"><span className="muted small">Exécution manuelle, sauvegardes et contrôles :</span><Link className="button button-ghost button-small" to="/admin/system">Ouvrir Système</Link></div>
      </section>

      <div className="stack">
        <section className="card" aria-labelledby="ops-backup-title">
          <div className="card-header">
            <h2 id="ops-backup-title" className="ops-section-title"><Archive size={18} aria-hidden="true" /> Sauvegardes</h2>
            <Badge tone={data.backups.settings.enabled ? 'green' : 'orange'}>{data.backups.settings.enabled ? 'Quotidiennes' : 'Automatiques désactivées'}</Badge>
          </div>
          <div className="card-body">
            {data.backups.latest ? <dl className="ops-kv">
              <dt>Dernière</dt><dd>{dateTime(data.backups.latest.created_at)}</dd>
              <dt>Taille</dt><dd>{bytes(data.backups.latest.database.bytes + (data.backups.latest.files?.bytes ?? 0))}</dd>
              <dt>Conservées</dt><dd>{data.backups.count} / {data.backups.settings.keep} ({bytes(data.disk.backups_bytes)})</dd>
            </dl> : <p className="muted small">Aucune sauvegarde pour l’instant. Lancez-en une depuis l’onglet Système.</p>}
          </div>
        </section>

        <section className="card" aria-labelledby="ops-audit-title">
          <div className="card-header"><h2 id="ops-audit-title">Journal d’audit récent</h2></div>
          <div className="card-body">
            {data.recent_audit.length === 0 ? <p className="muted small">Aucun événement pour l’instant.</p> : <ul className="list" aria-label="Derniers événements d’audit">
              {data.recent_audit.map((event) => <li key={event.id} className="list-item">
                <div className="stack gap-sm">
                  <span className="ops-mono">{event.action}</span>
                  <span className="muted small">{event.actor_name ?? 'Système'} · {event.target_type} · {dateTime(event.created_at)}</span>
                </div>
              </li>)}
            </ul>}
          </div>
        </section>
      </div>
    </div>
  </div>;
}
