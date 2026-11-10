import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, Ban, Boxes, Clock, Cpu, Download, FileArchive, HardDrive, Info, Lock, MemoryStick, Play, Plus, RefreshCw, ShieldCheck, Terminal,
  UserX, WifiOff,
} from 'lucide-react';
import FileUpload from '../components/FileUpload';
import { Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, ApiError, dateTime, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import '../styles/sandbox.css';

/* Sandbox page: isolated execution of campaign builds. OWNER: sandbox module. */

export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'error';

export interface SandboxRunSummary {
  id: string; requester_id: string; requester_name?: string; campaign_id: string; campaign_title?: string; mission_id: string | null;
  file_id: string | null; file_name: string; profile_id: string; profile_label: string; image: string; runtime: string; status: RunStatus;
  exit_code: number | null; queued_at: string; started_at: string | null; finished_at: string | null; duration_ms: number | null;
  logs_truncated: boolean; error: string; viewer_role: 'requester' | 'owner' | 'admin' | null; container_name?: string;
}

interface RunLimits {
  timeout_s: number; memory_mb: number; cpus: number; pids: number; tmpfs_mb: number; extract?: boolean; entry_candidates?: string[];
}

interface SandboxRunDetail extends SandboxRunSummary {
  command: string[]; limits: RunLimits; logs: string; logs_pruned_at: string | null; artifact_file_id: string | null; file_sha256: string;
  can_cancel: boolean;
  isolation: { network: string; read_only_root: boolean; user: string; capabilities: string; tmp_mb: number };
}

interface SandboxStatus {
  enabled: boolean; runtime: string; oci_runtime: string | null; available: boolean; message: string | null;
  limits: { daily_quota: number; max_pending_per_user: number; max_build_mb: number; max_concurrent: number; require_clean_scan: boolean };
  used_today: number; pending: number; queue: { queued: number; running: number };
}

interface SandboxProfile {
  id: string; label: string; description: string; image: string; extract: boolean; entry_candidates: string[];
  timeout_s: number; memory_mb: number; cpus: number; pids: number; tmpfs_mb: number;
}

interface SandboxCampaign { id: string; title: string; status: string; project_title: string; role: 'owner' | 'tester'; mission_id: string | null }

interface SandboxBuild {
  id: string; original_name: string; size_bytes: number; mime_type: string; scan_status: string; created_at: string; eligible: boolean; reason: string | null;
}

export const statusInfo: Record<RunStatus, { label: string; tone: string }> = {
  queued: { label: 'En file d’attente', tone: 'blue' },
  running: { label: 'En cours', tone: 'purple' },
  succeeded: { label: 'Réussie', tone: 'green' },
  failed: { label: 'Échec', tone: 'red' },
  timeout: { label: 'Délai dépassé', tone: 'orange' },
  cancelled: { label: 'Annulée', tone: 'neutral' },
  error: { label: 'Erreur plateforme', tone: 'red' },
};

export const activeStatus = (status: RunStatus) => status === 'queued' || status === 'running';

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const info = statusInfo[status] ?? { label: status, tone: 'neutral' };
  return <Badge tone={info.tone}>{activeStatus(status) && <span className="sbx-pulse" aria-hidden="true" />}{info.label}</Badge>;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Ko`;
  return `${(bytes / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
}

export const limitsSummary = (limits: Pick<RunLimits, 'timeout_s' | 'memory_mb' | 'cpus' | 'pids'>) =>
  `${limits.timeout_s} s · ${limits.memory_mb} Mo · ${limits.cpus.toLocaleString('fr-FR')} CPU · ${limits.pids} processus`;

/** Fetches `path`, then polls every `interval` ms while `shouldContinue(value)` holds (slower when the tab is hidden). */
export function usePolling<T>(path: string | null, interval: number, shouldContinue: (value: T) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [revision, setRevision] = useState(0);
  const keepGoing = useRef(shouldContinue);
  keepGoing.current = shouldContinue;
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => { timer = setTimeout(() => void tick(), document.hidden ? Math.max(delay, 10000) : delay); };
    const tick = async () => {
      try {
        const value = await api<T>(path);
        if (!active) return;
        setData(value); setError(''); setStatus(null);
        if (keepGoing.current(value)) schedule(interval);
      } catch (caught) {
        if (!active) return;
        setError(errorMessage(caught));
        setStatus(caught instanceof ApiError ? caught.status : null);
        if (!(caught instanceof ApiError) || caught.status >= 500) schedule(interval * 3);
      } finally {
        if (active) setLoading(false);
      }
    };
    setLoading(true);
    void tick();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [path, interval, revision]);
  return { data, setData, error, status, loading, reload: () => setRevision((value) => value + 1) };
}

export default function SandboxPage() {
  const { user, loading } = useAuth();
  const { id } = useParams();
  if (loading) return <Loading />;
  if (!user) return <LoginNotice />;
  return id ? <RunDetail key={id} id={id} /> : <RunList />;
}

function IsolationCard({ status }: { status: SandboxStatus | null }) {
  return <article className="card sbx-explain">
    <div className="card-header"><h2 className="row gap-sm"><ShieldCheck size={18} aria-hidden="true" />Comment l’isolation vous protège</h2></div>
    <div className="card-body stack">
      <ul className="sbx-guarantees">
        <li><WifiOff size={16} aria-hidden="true" /><span><strong>Aucun réseau.</strong> Le programme ne voit qu’une interface locale : il ne peut ni télécharger, ni exfiltrer de données, ni miner de cryptomonnaie pour un tiers.</span></li>
        <li><Lock size={16} aria-hidden="true" /><span><strong>Système en lecture seule.</strong> Seuls <code>/work</code> et <code>/tmp</code>, en mémoire, sont inscriptibles ; ils sont détruits à la fin.</span></li>
        <li><UserX size={16} aria-hidden="true" /><span><strong>Sans privilège.</strong> Utilisateur <code>nobody</code> (uid 65534), aucune capacité Linux, élévation de privilèges interdite.</span></li>
        <li><Cpu size={16} aria-hidden="true" /><span><strong>Ressources bornées.</strong> Durée, mémoire, processeur et nombre de processus limités : le conteneur est arrêté au-delà.</span></li>
        <li><FileArchive size={16} aria-hidden="true" /><span><strong>Build vérifié.</strong> Seuls les builds joints à la campagne{status?.limits.require_clean_scan ? ', analysés et sains,' : ''} sont exécutables ; leur empreinte SHA-256 est contrôlée.</span></li>
      </ul>
      <div className="sbx-note">
        <Info size={16} aria-hidden="true" />
        <p>Le bac à sable <strong>complète</strong> les tests manuels, il ne les remplace pas : il vérifie qu’un build démarre, exécute les tests automatisés
          fournis par le projet et partage un journal reproductible. Pas d’interface graphique, d’émulateur mobile ni d’accès réseau.</p>
      </div>
    </div>
  </article>;
}

function StatusBanner({ status }: { status: SandboxStatus }) {
  if (status.enabled && status.available) return null;
  return <div className="alert sbx-alert-warning" role="status">{status.message}</div>;
}

function RunList() {
  const [params, setParams] = useSearchParams();
  const campaignFilter = params.get('campaign') ?? '';
  const statusFilter = (params.get('status') ?? '') as RunStatus | '';
  const [creating, setCreating] = useState(params.get('new') === '1');
  const status = useApi<SandboxStatus>('/sandbox/status');
  const campaigns = useApi<SandboxCampaign[]>('/sandbox/campaigns');
  const query = new URLSearchParams({ limit: '100' });
  if (campaignFilter) query.set('campaign_id', campaignFilter);
  if (statusFilter) query.set('status', statusFilter);
  const runs = usePolling<SandboxRunSummary[]>(`/sandbox/runs?${query.toString()}`, 5000, (value) => value.some((run) => activeStatus(run.status)));

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    next.delete('new');
    setParams(next, { replace: true });
  };

  const campaignOptions = [...new Map((campaigns.data ?? []).map((campaign) => [campaign.id, campaign])).values()];
  return <div className="stack sbx-page">
    <PageHeader eyebrow="Tests" title="Bac à sable" description="Exécutez les builds de vos campagnes dans un conteneur isolé, sans réseau, et partagez le journal avec l’équipe."
      action={<button className="button button-primary" onClick={() => setCreating(true)} disabled={!status.data?.enabled}><Plus size={16} aria-hidden="true" />Nouvelle exécution</button>} />
    <ErrorState message={status.error} />
    {status.data && <StatusBanner status={status.data} />}
    {status.data && <div className="stat-grid sbx-stats">
      <div className="stat-card"><span className="stat-label">Exécutions aujourd’hui</span><strong className="stat-value">{status.data.used_today} / {status.data.limits.daily_quota}</strong><span className="stat-note">Quota quotidien par membre (UTC)</span></div>
      <div className="stat-card"><span className="stat-label">Vos demandes en attente</span><strong className="stat-value">{status.data.pending} / {status.data.limits.max_pending_per_user}</strong><span className="stat-note">En file ou en cours d’exécution</span></div>
      <div className="stat-card"><span className="stat-label">File de la plateforme</span><strong className="stat-value">{status.data.queue.running} en cours</strong><span className="stat-note">{status.data.queue.queued} en attente · {status.data.limits.max_concurrent} simultanées au plus</span></div>
    </div>}
    <div className="sbx-layout">
      <section className="card sbx-runs">
        <div className="card-header row-between">
          <h2 className="row gap-sm"><Terminal size={18} aria-hidden="true" />Exécutions</h2>
          <button className="button button-ghost button-small" onClick={runs.reload}><RefreshCw size={15} aria-hidden="true" />Actualiser</button>
        </div>
        <div className="card-body">
          <div className="sbx-filters">
            <div className="field">
              <label htmlFor="sbx-filter-campaign">Campagne</label>
              <select id="sbx-filter-campaign" value={campaignFilter} onChange={(event) => update('campaign', event.target.value)}>
                <option value="">Toutes mes campagnes</option>
                {campaignOptions.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.title}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="sbx-filter-status">Statut</label>
              <select id="sbx-filter-status" value={statusFilter} onChange={(event) => update('status', event.target.value)}>
                <option value="">Tous</option>
                {(Object.keys(statusInfo) as RunStatus[]).map((key) => <option key={key} value={key}>{statusInfo[key].label}</option>)}
              </select>
            </div>
          </div>
          <ErrorState message={runs.error} />
          {runs.loading && !runs.data ? <Loading /> : runs.data && runs.data.length === 0
            ? <EmptyState title="Aucune exécution" description="Lancez un build de campagne dans le bac à sable pour obtenir un journal d’exécution isolé." />
            : runs.data && <div className="table-wrap"><table className="data-table sbx-table">
              <thead><tr><th>Build et campagne</th><th>Statut</th><th>Demandé par</th><th>Date</th></tr></thead>
              <tbody>{runs.data.map((run) => <tr key={run.id}>
                <td className="sbx-cell-build"><Link className="text-link sbx-file" to={`/sandbox/${run.id}`}>{run.file_name}</Link>
                  <span className="sbx-sub">{run.campaign_title}</span><span className="sbx-sub">{run.profile_label}</span></td>
                <td><RunStatusBadge status={run.status} />{run.exit_code !== null && (run.status === 'failed' || run.status === 'error') && <span className="sbx-exit">code {run.exit_code}</span>}</td>
                <td>{run.viewer_role === 'requester' ? 'Vous' : run.requester_name}</td>
                <td className="sbx-nowrap">{dateTime(run.queued_at)}<span className="sbx-sub">{run.duration_ms === null ? '—' : formatDuration(run.duration_ms)}</span></td>
              </tr>)}</tbody>
            </table></div>}
        </div>
      </section>
      <aside className="sbx-aside">
        <IsolationCard status={status.data} />
      </aside>
    </div>
    {creating && status.data && <NewRunModal status={status.data} campaigns={campaigns.data ?? []} campaignsLoading={campaigns.loading}
      initialCampaign={campaignFilter} onClose={() => setCreating(false)} />}
  </div>;
}

function NewRunModal({ status, campaigns, campaignsLoading, initialCampaign, onClose }: {
  status: SandboxStatus; campaigns: SandboxCampaign[]; campaignsLoading: boolean; initialCampaign: string; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [campaignKey, setCampaignKey] = useState('');
  const campaignChosen = useRef(false);
  const [fileId, setFileId] = useState('');
  const [profileId, setProfileId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const campaign = campaigns.find((item) => `${item.id}:${item.role}` === campaignKey);
  const profiles = useApi<SandboxProfile[]>('/sandbox/profiles');
  const builds = useApi<SandboxBuild[]>(campaign ? `/sandbox/campaigns/${encodeURIComponent(campaign.id)}/builds` : null);
  const profile = profiles.data?.find((item) => item.id === profileId);

  // Campaigns may still be loading when the modal opens: preselect (?campaign= or a single campaign) once they arrive.
  useEffect(() => {
    if (campaignChosen.current) return;
    const preset = campaigns.find((item) => item.id === initialCampaign) ?? (campaigns.length === 1 ? campaigns[0] : undefined);
    if (preset) {
      campaignChosen.current = true;
      setCampaignKey(`${preset.id}:${preset.role}`);
    }
  }, [campaigns, initialCampaign]);
  useEffect(() => {
    const first = builds.data?.find((build) => build.eligible);
    setFileId((current) => (builds.data?.some((build) => build.id === current && build.eligible) ? current : first?.id ?? ''));
  }, [builds.data]);
  useEffect(() => { if (!profileId && profiles.data?.length) setProfileId(profiles.data[0].id); }, [profiles.data, profileId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !campaign || !fileId || !profileId) return;
    setPending(true); setError('');
    try {
      const run = await api<SandboxRunSummary>('/sandbox/runs', { method: 'POST', body: JSON.stringify({ campaign_id: campaign.id, file_id: fileId, profile_id: profileId }) });
      navigate(`/sandbox/${run.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
      setPending(false);
    }
  }

  const quotaReached = status.used_today >= status.limits.daily_quota;
  return <Modal title="Nouvelle exécution" onClose={onClose}>
    <form className="form sbx-form" onSubmit={submit} aria-busy={pending}>
      {campaignsLoading ? <Loading /> : campaigns.length === 0
        ? <p className="muted small">Le bac à sable est réservé aux propriétaires de campagnes et aux testeurs dont la candidature a été acceptée. <Link className="text-link" to="/testing">Voir les campagnes de test</Link></p>
        : <>
          <div className="field">
            <label htmlFor="sbx-campaign">Campagne</label>
            <select id="sbx-campaign" required value={campaignKey} onChange={(event) => { campaignChosen.current = true; setCampaignKey(event.target.value); }} disabled={pending}>
              <option value="">Choisir une campagne…</option>
              {campaigns.map((item) => <option key={`${item.id}:${item.role}`} value={`${item.id}:${item.role}`}>{item.title} — {item.project_title} ({item.role === 'owner' ? 'propriétaire' : 'testeur'})</option>)}
            </select>
          </div>
          {campaign && <div className="field">
            <label htmlFor="sbx-build">Build</label>
            {builds.loading ? <Loading /> : <>
              <ErrorState message={builds.error} />
              {builds.data && builds.data.length === 0
                ? <p className="help-text">Aucun build n’est joint à cette campagne.{campaign.role === 'owner' ? ' Ajoutez-en un ci-dessous.' : ' Demandez au propriétaire d’en publier un.'}</p>
                : <select id="sbx-build" required value={fileId} onChange={(event) => setFileId(event.target.value)} disabled={pending} aria-describedby="sbx-build-help">
                  <option value="">Choisir un build…</option>
                  {builds.data?.map((build) => <option key={build.id} value={build.id} disabled={!build.eligible}>
                    {build.original_name} · {formatBytes(build.size_bytes)} · {dateTime(build.created_at)}{build.eligible ? '' : ` — ${build.reason}`}
                  </option>)}
                </select>}
              <p id="sbx-build-help" className="help-text">Script shell, binaire Linux statique, JAR ou archive .zip / .tar.gz (≤ {status.limits.max_build_mb} Mo){status.limits.require_clean_scan ? ', analysé par l’antivirus' : ''}.</p>
            </>}
            {campaign.role === 'owner' && <FileUpload purpose="campaign_build" resourceType="campaign" resourceId={campaign.id} label="Ajouter un build à la campagne"
              disabled={pending} onUploaded={() => builds.reload()} />}
          </div>}
          <div className="field">
            <label htmlFor="sbx-profile">Environnement d’exécution</label>
            {profiles.loading ? <Loading /> : <select id="sbx-profile" required value={profileId} onChange={(event) => setProfileId(event.target.value)} disabled={pending}>
              {profiles.data?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>}
            <ErrorState message={profiles.error} />
            {profile && <div className="sbx-profile-help">
              {profile.description && <p>{profile.description}</p>}
              <p className="sbx-limits"><Clock size={13} aria-hidden="true" />{limitsSummary(profile)} · <HardDrive size={13} aria-hidden="true" />{profile.tmpfs_mb} Mo d’espace de travail</p>
              {profile.extract && profile.entry_candidates.length > 0 && <p>Dans une archive, le premier fichier trouvé parmi : <code>{profile.entry_candidates.join(', ')}</code></p>}
            </div>}
          </div>
          <p className="help-text">Le build est copié dans un conteneur sans réseau, puis détruit. Le journal (256 Ko au plus) reste visible par vous, le propriétaire de la campagne et l’administration.</p>
          {quotaReached && <div className="alert sbx-alert-warning">Quota quotidien atteint ({status.limits.daily_quota} exécutions).</div>}
          <ErrorState message={error} />
          <div className="row gap-sm">
            <button className="button button-primary" type="submit" disabled={pending || !fileId || !profileId || quotaReached}>
              <Play size={16} aria-hidden="true" />{pending ? 'Envoi…' : 'Lancer l’exécution'}
            </button>
            <button className="button button-secondary" type="button" onClick={onClose} disabled={pending}>Annuler</button>
          </div>
        </>}
    </form>
  </Modal>;
}

export function LogViewer({ logs, live }: { logs: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [logs]);
  return <pre ref={ref} className="sbx-log" tabIndex={0} aria-label="Journal d’exécution" aria-busy={live}
    onScroll={(event) => { const element = event.currentTarget; stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
    {logs || (live ? 'En attente de la sortie du programme…' : 'Aucune sortie.')}
  </pre>;
}

function RunDetail({ id }: { id: string }) {
  const runPath = `/sandbox/runs/${encodeURIComponent(id)}`;
  const run = usePolling<SandboxRunDetail>(runPath, 2000, (value) => activeStatus(value.status));
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState('');

  async function cancel() {
    if (!run.data || cancelling) return;
    if (!window.confirm(run.data.status === 'running' ? 'Arrêter cette exécution ? Le conteneur sera tué immédiatement.' : 'Retirer cette demande de la file d’attente ?')) return;
    setCancelling(true); setActionError('');
    try {
      run.setData(await api<SandboxRunDetail>(`${runPath}/cancel`, { method: 'POST', body: JSON.stringify({}) }));
    } catch (caught) {
      setActionError(errorMessage(caught));
      run.reload();
    } finally {
      setCancelling(false);
    }
  }

  const back = <Link className="text-link row gap-sm sbx-back" to="/sandbox"><ArrowLeft size={15} aria-hidden="true" />Toutes les exécutions</Link>;
  if (run.loading && !run.data) return <Loading />;
  if (!run.data) {
    return <div className="stack">{back}{run.status === 404
      ? <EmptyState title="Exécution introuvable" description="Elle a peut-être été supprimée, ou vous n’y avez pas accès." />
      : <ErrorState message={run.error} />}</div>;
  }
  const data = run.data;
  const live = activeStatus(data.status);
  const errorTone = data.status === 'cancelled' ? 'sbx-alert-info' : data.status === 'timeout' ? 'sbx-alert-warning' : 'alert-error';
  return <div className="stack sbx-page">
    {back}
    <PageHeader eyebrow="Bac à sable" title={data.file_name} description={`${data.campaign_title ?? 'Campagne'} · ${data.profile_label}`}
      action={<div className="row gap-sm">
        <RunStatusBadge status={data.status} />
        {data.can_cancel && <button className="button button-danger button-small" onClick={() => void cancel()} disabled={cancelling}>
          <Ban size={15} aria-hidden="true" />{cancelling ? 'Arrêt…' : data.status === 'running' ? 'Arrêter' : 'Annuler'}
        </button>}
      </div>} />
    <ErrorState message={actionError} />
    {run.error && <div className="alert sbx-alert-warning" role="status">Actualisation impossible : {run.error}</div>}
    {data.error && <div className={`alert ${errorTone}`} role="status">{data.error}</div>}
    {data.status === 'queued' && <div className="alert sbx-alert-info" role="status">Demande en file d’attente : elle démarrera dès qu’un emplacement d’exécution se libérera.</div>}
    {data.status === 'succeeded' && <div className="alert alert-success" role="status">Le programme s’est terminé normalement (code 0).</div>}
    <div className="detail-layout">
      <div className="detail-main">
        <section className="card">
          <div className="card-header row-between">
            <h2 className="row gap-sm"><Terminal size={18} aria-hidden="true" />Journal</h2>
            <div className="row gap-sm">
              {live && <span className="small muted">Actualisation toutes les 2 s</span>}
              {!live && data.logs && <a className="button button-secondary button-small" href={`/api${runPath}/logs`} download><Download size={15} aria-hidden="true" />Télécharger</a>}
              {data.artifact_file_id && <a className="button button-ghost button-small" href={`/api/files/${encodeURIComponent(data.artifact_file_id)}/download`}><FileArchive size={15} aria-hidden="true" />Journal étendu</a>}
            </div>
          </div>
          <div className="card-body stack">
            {data.logs_truncated && <p className="help-text">Journal tronqué : le début et la fin sont conservés (256 Ko au plus){data.artifact_file_id ? ' ; une copie plus longue est disponible.' : '.'}</p>}
            {data.logs_pruned_at && <p className="help-text">Journal supprimé le {dateTime(data.logs_pruned_at)} (durée de conservation dépassée).</p>}
            <LogViewer logs={data.logs} live={live} />
          </div>
        </section>
      </div>
      <aside className="detail-aside">
        <section className="card">
          <div className="card-header"><h2>Résultat</h2></div>
          <div className="card-body">
            <dl className="sbx-kv">
              <dt>Statut</dt><dd>{statusInfo[data.status].label}</dd>
              <dt>Code de sortie</dt><dd>{data.exit_code ?? '—'}</dd>
              <dt>Durée</dt><dd>{formatDuration(data.duration_ms)}</dd>
              <dt>Demandée</dt><dd>{dateTime(data.queued_at)}{data.viewer_role === 'requester' ? ' par vous' : data.requester_name ? ` par ${data.requester_name}` : ''}</dd>
              {data.started_at && <><dt>Démarrée</dt><dd>{dateTime(data.started_at)}</dd></>}
              {data.finished_at && <><dt>Terminée</dt><dd>{dateTime(data.finished_at)}</dd></>}
            </dl>
          </div>
        </section>
        <section className="card">
          <div className="card-header"><h2>Environnement</h2></div>
          <div className="card-body stack">
            <dl className="sbx-kv">
              <dt>Image</dt><dd className="sbx-mono">{data.image}</dd>
              <dt>Commande</dt><dd className="sbx-mono">{data.command.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')}</dd>
              <dt>Build</dt><dd className="sbx-mono" title={data.file_sha256}>{data.file_name}<br />sha256 {data.file_sha256.slice(0, 16)}…</dd>
              {data.container_name && <><dt>Conteneur</dt><dd className="sbx-mono">{data.container_name}</dd></>}
            </dl>
            <ul className="sbx-chips" aria-label="Limites et isolation">
              <li><Clock size={13} aria-hidden="true" />{data.limits.timeout_s} s max</li>
              <li><MemoryStick size={13} aria-hidden="true" />{data.limits.memory_mb} Mo</li>
              <li><Cpu size={13} aria-hidden="true" />{data.limits.cpus.toLocaleString('fr-FR')} CPU · {data.limits.pids} processus</li>
              <li><HardDrive size={13} aria-hidden="true" />{data.limits.tmpfs_mb} Mo /work · {data.isolation.tmp_mb} Mo /tmp</li>
              <li><WifiOff size={13} aria-hidden="true" />Réseau : aucun</li>
              <li><Lock size={13} aria-hidden="true" />Racine en lecture seule</li>
              <li><UserX size={13} aria-hidden="true" />uid {data.isolation.user} · capacités : {data.isolation.capabilities}</li>
            </ul>
          </div>
        </section>
        <section className="card">
          <div className="card-body sbx-note">
            <Boxes size={16} aria-hidden="true" />
            <p>Une exécution réussie montre que le build démarre et que ses tests automatisés passent dans un environnement minimal. Elle ne remplace pas les retours des testeurs.</p>
          </div>
        </section>
      </aside>
    </div>
  </div>;
}
