import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Download, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Skull, Trash2, XCircle } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import { activeStatus, formatDuration, limitsSummary, RunStatusBadge, statusInfo, usePolling, type RunStatus, type SandboxRunSummary } from '../pages/SandboxPage';
import '../styles/sandbox.css';

/* Sandbox administration: configuration, runtime self-test, image pulls, supervision of runs. OWNER: sandbox module. */

interface Profile {
  id: string; label: string; description: string; enabled: boolean; image: string; command: string[]; entry_candidates: string[]; extract: boolean;
  timeout_s: number; memory_mb: number; cpus: number; pids: number; tmpfs_mb: number;
}

interface Config {
  enabled: boolean; runtime: 'docker' | 'disabled'; oci_runtime: string | null; input_mode: 'auto' | 'bind' | 'stdin';
  max_concurrent: number; daily_quota: number; max_pending_per_user: number; max_build_mb: number; require_clean_scan: boolean;
  log_retention_days: number; run_retention_days: number; allowed_images: string[]; profiles: Profile[];
}

type Bounds = Record<'timeout_s' | 'memory_mb' | 'cpus' | 'pids' | 'tmpfs_mb' | 'max_concurrent' | 'daily_quota' | 'max_pending_per_user'
  | 'max_build_mb' | 'log_retention_days' | 'run_retention_days', [number, number]>;

interface AdminConfig {
  config: Config; defaults: Config; bounds: Bounds; active_runs: number;
  environment: {
    docker_host: string; docker_host_source: string; remote: boolean; tls: boolean; input_mode: 'bind' | 'stdin'; allowlist_locked: boolean;
    effective_allowlist: string[]; work_dir: string; docker_bin: string; instance: string;
  };
}

interface SelfTest {
  ok: boolean; profile_id: string | null; exit_code: number | null; duration_ms: number; output: string; error: string | null;
  check: { ok: boolean; version?: string; error?: string; details?: Record<string, unknown> };
  checks: { non_root: boolean; read_only_root: boolean; network_isolated: boolean; completed: boolean } | null;
}

interface AdminRuns {
  runs: (SandboxRunSummary & { container_name: string })[];
  stats: { queued: number; running: number; finished_24h: number; problems_24h: number };
  active: string[];
}

const checkLabels: Record<keyof NonNullable<SelfTest['checks']>, string> = {
  non_root: 'Utilisateur non root (uid 65534)',
  read_only_root: 'Système de fichiers racine en lecture seule',
  network_isolated: 'Aucun réseau (loopback seulement)',
  completed: 'Script de sonde exécuté jusqu’au bout',
};

const lines = (value: string) => value.split('\n').map((line) => line.trim()).filter(Boolean);

export default function SandboxAdmin() {
  const admin = useApi<AdminConfig>('/sandbox/admin/config');
  if (admin.loading && !admin.data) return <Loading />;
  if (!admin.data) return <ErrorState message={admin.error || 'Configuration indisponible.'} />;
  return <div className="stack sbx-admin">
    <ConfigEditor data={admin.data} onSaved={admin.reload} />
    <SelfTestPanel profiles={admin.data.config.profiles} />
    <AdminRunsPanel />
  </div>;
}

function NumberField({ id, label, value, range, step = 1, onChange, help }: {
  id: string; label: string; value: number; range: [number, number]; step?: number; onChange: (value: number) => void; help?: string;
}) {
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" min={range[0]} max={range[1]} step={step} required value={Number.isFinite(value) ? value : ''}
      onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))} />
    <p className="help-text">{help ? `${help} · ` : ''}{range[0].toLocaleString('fr-FR')} à {range[1].toLocaleString('fr-FR')}</p>
  </div>;
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="card">
    <div className="card-header row-between"><h2>{title}</h2>{action}</div>
    <div className="card-body stack">{children}</div>
  </section>;
}

function ConfigEditor({ data, onSaved }: { data: AdminConfig; onSaved: () => void }) {
  const [draft, setDraft] = useState<Config>(data.config);
  const [allowlistText, setAllowlistText] = useState(data.config.allowed_images.join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pulls, setPulls] = useState<Record<string, { pending: boolean; text?: string; ok?: boolean }>>({});
  useEffect(() => { setDraft(data.config); setAllowlistText(data.config.allowed_images.join('\n')); }, [data.config]);

  const env = data.environment;
  const candidate: Config = { ...draft, allowed_images: lines(allowlistText) };
  const dirty = JSON.stringify(candidate) !== JSON.stringify(data.config);
  const set = <K extends keyof Config>(key: K, value: Config[K]) => { setDraft((current) => ({ ...current, [key]: value })); setMessage(''); };
  const setProfile = (index: number, patch: Partial<Profile>) => set('profiles', draft.profiles.map((profile, position) => (position === index ? { ...profile, ...patch } : profile)));

  async function save() {
    if (saving) return;
    if (candidate.enabled && !data.config.enabled && !env.remote
      && !window.confirm('Le démon Docker est local à ce serveur. En production, utilisez un hôte dédié (ALPHA_SANDBOX_DOCKER_HOST) avec gVisor. Activer quand même ?')) return;
    setSaving(true); setError(''); setMessage('');
    try {
      await api('/sandbox/admin/config', { method: 'PUT', body: JSON.stringify(candidate) });
      setMessage('Configuration enregistrée et journalisée.');
      onSaved();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  async function pull(profile: Profile) {
    setPulls((current) => ({ ...current, [profile.id]: { pending: true } }));
    try {
      const result = await api<{ image: string; ok: boolean; output: string }>('/sandbox/admin/pull', { method: 'POST', body: JSON.stringify({ profile_id: profile.id }) });
      setPulls((current) => ({ ...current, [profile.id]: { pending: false, ok: result.ok, text: result.output || (result.ok ? 'Image téléchargée.' : 'Échec.') } }));
    } catch (caught) {
      setPulls((current) => ({ ...current, [profile.id]: { pending: false, ok: false, text: errorMessage(caught) } }));
    }
  }

  const addProfile = () => {
    const base = data.defaults.profiles[0];
    let suffix = draft.profiles.length + 1;
    while (draft.profiles.some((profile) => profile.id === `profil-${suffix}`)) suffix += 1;
    set('profiles', [...draft.profiles, { ...base, id: `profil-${suffix}`, label: 'Nouveau profil', description: '', enabled: false }]);
  };

  return <>
    <Section title="Activation et moteur" action={<Badge tone={data.config.enabled && data.config.runtime === 'docker' ? 'green' : 'neutral'}>{data.config.enabled && data.config.runtime === 'docker' ? 'Actif' : 'Désactivé'}</Badge>}>
      {!env.remote && <div className="alert sbx-alert-warning"><AlertTriangle size={15} aria-hidden="true" /> Le démon Docker utilisé est <strong>local</strong> ({env.docker_host}).
        Acceptable en développement ; en production, pointez <code>ALPHA_SANDBOX_DOCKER_HOST</code> vers une machine dédiée (TLS) et ne montez jamais le socket Docker dans le conteneur web.</div>}
      <div className="sbx-admin-grid">
        <label className="sbx-checkbox"><input type="checkbox" checked={draft.enabled} onChange={(event) => set('enabled', event.target.checked)} />Bac à sable activé pour les membres</label>
        <div className="field">
          <label htmlFor="sbx-runtime">Moteur</label>
          <select id="sbx-runtime" value={draft.runtime} onChange={(event) => set('runtime', event.target.value as Config['runtime'])}>
            <option value="docker">Docker (conteneurs isolés)</option>
            <option value="disabled">Aucun (exécutions refusées)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="sbx-oci">Runtime OCI</label>
          <input id="sbx-oci" value={draft.oci_runtime ?? ''} placeholder="runc par défaut — ex. runsc (gVisor)" maxLength={40}
            onChange={(event) => set('oci_runtime', event.target.value.trim() ? event.target.value.trim() : null)} />
          <p className="help-text">Doit être déclaré sur le démon (daemon.json). gVisor ou Kata ajoutent une frontière noyau.</p>
        </div>
        <div className="field">
          <label htmlFor="sbx-input-mode">Transmission du build</label>
          <select id="sbx-input-mode" value={draft.input_mode} onChange={(event) => set('input_mode', event.target.value as Config['input_mode'])}>
            <option value="auto">Automatique (montage local, flux pour un démon distant)</option>
            <option value="bind">Montage en lecture seule (démon local)</option>
            <option value="stdin">Flux standard (démon distant)</option>
          </select>
          <p className="help-text">Mode effectif : {env.input_mode === 'bind' ? 'montage' : 'flux'}.</p>
        </div>
      </div>
      <dl className="sbx-kv sbx-env">
        <dt>Hôte Docker</dt><dd className="sbx-mono">{env.docker_host} <span className="muted">({env.docker_host_source}{env.tls ? ', TLS vérifié' : ''})</span></dd>
        <dt>Exécutable</dt><dd className="sbx-mono">{env.docker_bin}</dd>
        <dt>Répertoire de travail</dt><dd className="sbx-mono">{env.work_dir}</dd>
        <dt>Instance</dt><dd className="sbx-mono">{env.instance}</dd>
        <dt>Exécutions actives</dt><dd>{data.active_runs}</dd>
      </dl>
      <p className="help-text">L’hôte Docker et ses certificats se configurent uniquement par variables d’environnement : une session d’administration compromise ne peut pas rediriger les exécutions.</p>
    </Section>

    <Section title="Quotas et conservation">
      <div className="sbx-admin-grid">
        <NumberField id="sbx-max-concurrent" label="Exécutions simultanées" value={draft.max_concurrent} range={data.bounds.max_concurrent} onChange={(value) => set('max_concurrent', value)} help="toute la plateforme" />
        <NumberField id="sbx-daily-quota" label="Quota quotidien par membre" value={draft.daily_quota} range={data.bounds.daily_quota} onChange={(value) => set('daily_quota', value)} help="jour UTC" />
        <NumberField id="sbx-pending" label="Demandes en attente par membre" value={draft.max_pending_per_user} range={data.bounds.max_pending_per_user} onChange={(value) => set('max_pending_per_user', value)} />
        <NumberField id="sbx-build-mb" label="Taille maximale du build (Mo)" value={draft.max_build_mb} range={data.bounds.max_build_mb} onChange={(value) => set('max_build_mb', value)} />
        <NumberField id="sbx-log-days" label="Conservation des journaux (jours)" value={draft.log_retention_days} range={data.bounds.log_retention_days} onChange={(value) => set('log_retention_days', value)} />
        <NumberField id="sbx-run-days" label="Conservation des exécutions (jours)" value={draft.run_retention_days} range={data.bounds.run_retention_days} onChange={(value) => set('run_retention_days', value)} />
      </div>
      <label className="sbx-checkbox"><input type="checkbox" checked={draft.require_clean_scan} onChange={(event) => set('require_clean_scan', event.target.checked)} />
        Exiger une analyse antivirus « saine » même quand l’analyse des fichiers n’est pas obligatoire sur la plateforme</label>
    </Section>

    <Section title="Liste blanche d’images">
      <div className="field">
        <label htmlFor="sbx-allowlist">Images autorisées (une entrée par ligne)</label>
        <textarea id="sbx-allowlist" rows={5} className="sbx-mono" value={env.allowlist_locked ? env.effective_allowlist.join('\n') : allowlistText}
          disabled={env.allowlist_locked} onChange={(event) => { setAllowlistText(event.target.value); setMessage(''); }} />
        <p className="help-text">{env.allowlist_locked
          ? 'Verrouillée par ALPHA_SANDBOX_IMAGE_ALLOWLIST : modifiable uniquement par l’exploitation.'
          : 'Un dépôt (alpine, ghcr.io/org/runner) autorise toutes ses versions épinglées ; une version exacte (alpine:3.20, …@sha256:…) n’autorise qu’elle ; un préfixe se termine par /*. Les profils doivent toujours épingler une version (nom:tag ≠ latest, ou @sha256:…).'}</p>
      </div>
    </Section>

    <Section title="Profils d’exécution" action={<div className="row gap-sm">
      <button className="button button-ghost button-small" type="button" onClick={() => { if (window.confirm('Remplacer tous les profils par ceux d’origine ?')) set('profiles', data.defaults.profiles); }}><RotateCcw size={15} aria-hidden="true" />Profils d’origine</button>
      <button className="button button-secondary button-small" type="button" onClick={addProfile}><Plus size={15} aria-hidden="true" />Ajouter</button>
    </div>}>
      <p className="help-text">Commande = un argument par ligne, jamais interprétée par un shell. Variables (argument entier) : <code>{'{input}'}</code> chemin du build,
        <code>{'{app}'}</code> dossier extrait, <code>{'{entry}'}</code> premier point d’entrée trouvé. L’image doit contenir <code>/bin/sh</code> (script d’entrée).</p>
      {draft.profiles.length === 0 && <EmptyState title="Aucun profil" description="Ajoutez au moins un profil pour permettre des exécutions." />}
      {draft.profiles.map((profile, index) => <fieldset key={index} className="sbx-profile">
        <legend>{profile.label || profile.id}</legend>
        <div className="sbx-admin-grid">
          <div className="field"><label htmlFor={`sbx-p-id-${index}`}>Identifiant</label><input id={`sbx-p-id-${index}`} value={profile.id} maxLength={40} onChange={(event) => setProfile(index, { id: event.target.value })} /></div>
          <div className="field"><label htmlFor={`sbx-p-label-${index}`}>Libellé</label><input id={`sbx-p-label-${index}`} value={profile.label} maxLength={80} onChange={(event) => setProfile(index, { label: event.target.value })} /></div>
          <div className="field"><label htmlFor={`sbx-p-image-${index}`}>Image épinglée</label><input id={`sbx-p-image-${index}`} className="sbx-mono" value={profile.image} maxLength={255} onChange={(event) => setProfile(index, { image: event.target.value.trim() })} /></div>
          <label className="sbx-checkbox"><input type="checkbox" checked={profile.enabled} onChange={(event) => setProfile(index, { enabled: event.target.checked })} />Proposé aux membres</label>
        </div>
        <div className="field"><label htmlFor={`sbx-p-desc-${index}`}>Description</label><textarea id={`sbx-p-desc-${index}`} rows={2} maxLength={500} value={profile.description} onChange={(event) => setProfile(index, { description: event.target.value })} /></div>
        <div className="sbx-admin-grid">
          <div className="field"><label htmlFor={`sbx-p-cmd-${index}`}>Commande (argv)</label>
            <textarea id={`sbx-p-cmd-${index}`} rows={4} className="sbx-mono" value={profile.command.join('\n')} onChange={(event) => setProfile(index, { command: lines(event.target.value) })} /></div>
          <div className="field"><label htmlFor={`sbx-p-entry-${index}`}>Points d’entrée possibles (archives)</label>
            <textarea id={`sbx-p-entry-${index}`} rows={4} className="sbx-mono" value={profile.entry_candidates.join('\n')} onChange={(event) => setProfile(index, { entry_candidates: lines(event.target.value) })} /></div>
        </div>
        <label className="sbx-checkbox"><input type="checkbox" checked={profile.extract} onChange={(event) => setProfile(index, { extract: event.target.checked })} />Extraire les archives .zip / .tar.gz dans /work/app</label>
        <div className="sbx-admin-grid sbx-limits-grid">
          <NumberField id={`sbx-p-timeout-${index}`} label="Durée max (s)" value={profile.timeout_s} range={data.bounds.timeout_s} onChange={(value) => setProfile(index, { timeout_s: value })} />
          <NumberField id={`sbx-p-mem-${index}`} label="Mémoire (Mo)" value={profile.memory_mb} range={data.bounds.memory_mb} onChange={(value) => setProfile(index, { memory_mb: value })} />
          <NumberField id={`sbx-p-cpu-${index}`} label="CPU" step={0.1} value={profile.cpus} range={data.bounds.cpus} onChange={(value) => setProfile(index, { cpus: value })} />
          <NumberField id={`sbx-p-pids-${index}`} label="Processus" value={profile.pids} range={data.bounds.pids} onChange={(value) => setProfile(index, { pids: value })} />
          <NumberField id={`sbx-p-tmpfs-${index}`} label="Espace /work (Mo)" value={profile.tmpfs_mb} range={data.bounds.tmpfs_mb} onChange={(value) => setProfile(index, { tmpfs_mb: value })} />
        </div>
        <div className="row gap-sm sbx-wrap">
          <button className="button button-secondary button-small" type="button" onClick={() => void pull(profile)} disabled={pulls[profile.id]?.pending || dirty}
            title={dirty ? 'Enregistrez d’abord la configuration' : undefined}><Download size={15} aria-hidden="true" />{pulls[profile.id]?.pending ? 'Téléchargement…' : 'Télécharger l’image'}</button>
          <button className="button button-danger button-small" type="button" onClick={() => set('profiles', draft.profiles.filter((_, position) => position !== index))}><Trash2 size={15} aria-hidden="true" />Supprimer</button>
          <span className="small muted">{Number.isFinite(profile.timeout_s) && Number.isFinite(profile.cpus) ? limitsSummary(profile) : ''}</span>
        </div>
        {pulls[profile.id]?.text && <pre className={`sbx-output ${pulls[profile.id]?.ok ? '' : 'sbx-output-error'}`}>{pulls[profile.id]?.text}</pre>}
      </fieldset>)}
    </Section>

    <div className="sbx-savebar" role="region" aria-label="Enregistrement de la configuration">
      <ErrorState message={error} />
      {message && <p className="small text-success" role="status">{message}</p>}
      <div className="row gap-sm">
        <button className="button button-primary" type="button" onClick={() => void save()} disabled={saving || !dirty}><Save size={16} aria-hidden="true" />{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        <button className="button button-secondary" type="button" disabled={saving || !dirty} onClick={() => { setDraft(data.config); setAllowlistText(data.config.allowed_images.join('\n')); setError(''); }}>Annuler les modifications</button>
        {dirty && <span className="small muted">Modifications non enregistrées</span>}
      </div>
    </div>
  </>;
}

function SelfTestPanel({ profiles }: { profiles: Profile[] }) {
  const [profileId, setProfileId] = useState(profiles.find((profile) => profile.enabled)?.id ?? profiles[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<SelfTest | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setPending(true); setError(''); setResult(null);
    try {
      setResult(await api<SelfTest>('/sandbox/admin/test', { method: 'POST', body: JSON.stringify(profileId ? { profile_id: profileId } : {}) }));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(false);
    }
  }

  const details = result?.check.details;
  return <Section title="Vérification du moteur" action={result && <Badge tone={result.ok ? 'green' : 'red'}>{result.ok ? 'Isolation vérifiée' : 'Échec'}</Badge>}>
    <p className="help-text">Interroge le démon (<code>docker info</code>) puis lance une sonde avec les options de production : identité, système de fichiers, interfaces et accès réseau.
      Fonctionne même lorsque l’accès des membres est désactivé.</p>
    <div className="sbx-inline">
      <div className="field">
        <label htmlFor="sbx-test-profile">Profil</label>
        <select id="sbx-test-profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
          {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
        </select>
      </div>
      <button className="button button-primary button-small" type="button" onClick={() => void run()} disabled={pending}><ShieldCheck size={15} aria-hidden="true" />{pending ? 'Vérification…' : 'Lancer l’auto-test'}</button>
    </div>
    <ErrorState message={error} />
    {result && <div className="stack">
      {result.error && <div className="alert alert-error">{result.error}</div>}
      <dl className="sbx-kv">
        <dt>Démon</dt><dd>{result.check.ok ? `Docker ${result.check.version ?? ''}` : result.check.error}</dd>
        {details && <>
          <dt>Système</dt><dd>{String(details.operating_system ?? '—')} · noyau {String(details.kernel ?? '—')} · {String(details.architecture ?? '')}</dd>
          <dt>Runtimes</dt><dd className="sbx-mono">{(details.runtimes as string[] | undefined)?.join(', ') ?? '—'} (défaut : {String(details.default_runtime ?? '—')})</dd>
          <dt>Sécurité</dt><dd>cgroup v{String(details.cgroup_version ?? '?')} · seccomp {details.seccomp ? 'oui' : 'non'} · AppArmor {details.apparmor ? 'oui' : 'non'} · rootless {details.rootless ? 'oui' : 'non'} · userns {details.userns ? 'oui' : 'non'} · {details.remote ? 'démon distant' : 'démon local'}</dd>
        </>}
        {result.profile_id && <><dt>Sonde</dt><dd>profil {result.profile_id} · code {result.exit_code ?? '—'} · {formatDuration(result.duration_ms)}</dd></>}
      </dl>
      {result.checks && <ul className="sbx-checks">
        {(Object.keys(checkLabels) as (keyof typeof checkLabels)[]).map((key) => <li key={key} className={result.checks![key] ? 'ok' : 'ko'}>
          {result.checks![key] ? <CheckCircle2 size={15} aria-hidden="true" /> : <XCircle size={15} aria-hidden="true" />}{checkLabels[key]}
        </li>)}
      </ul>}
      {result.output && <pre className="sbx-output">{result.output}</pre>}
    </div>}
  </Section>;
}

function AdminRunsPanel() {
  const [status, setStatus] = useState<RunStatus | ''>('');
  const [killing, setKilling] = useState('');
  const [error, setError] = useState('');
  const path = `/sandbox/admin/runs?limit=100${status ? `&status=${status}` : ''}`;
  const runs = usePolling<AdminRuns>(path, 5000, (value) => value.stats.queued + value.stats.running > 0);

  async function kill(run: SandboxRunSummary) {
    if (killing || !window.confirm(`Arrêter l’exécution de « ${run.file_name} » demandée par ${run.requester_name ?? 'un membre'} ?`)) return;
    setKilling(run.id); setError('');
    try {
      await api(`/sandbox/admin/runs/${encodeURIComponent(run.id)}/kill`, { method: 'POST', body: JSON.stringify({}) });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setKilling('');
      runs.reload();
    }
  }

  const stats = runs.data?.stats;
  return <Section title="Exécutions" action={<button className="button button-ghost button-small" type="button" onClick={runs.reload}><RefreshCw size={15} aria-hidden="true" />Actualiser</button>}>
    {stats && <div className="stat-grid sbx-admin-stats">
      <div className="stat-card"><span className="stat-label">En cours</span><strong className="stat-value">{stats.running}</strong><span className="stat-note">{runs.data!.active.length} suivies par ce processus</span></div>
      <div className="stat-card"><span className="stat-label">En file</span><strong className="stat-value">{stats.queued}</strong></div>
      <div className="stat-card"><span className="stat-label">Terminées (24 h)</span><strong className="stat-value">{stats.finished_24h}</strong></div>
      <div className="stat-card"><span className="stat-label">Erreurs et délais (24 h)</span><strong className="stat-value">{stats.problems_24h}</strong></div>
    </div>}
    <div className="sbx-inline">
      <div className="field">
        <label htmlFor="sbx-admin-status">Statut</label>
        <select id="sbx-admin-status" value={status} onChange={(event) => setStatus(event.target.value as RunStatus | '')}>
          <option value="">Tous</option>
          {(Object.keys(statusInfo) as RunStatus[]).map((key) => <option key={key} value={key}>{statusInfo[key].label}</option>)}
        </select>
      </div>
    </div>
    <ErrorState message={error || runs.error} />
    {runs.loading && !runs.data ? <Loading /> : runs.data && runs.data.runs.length === 0
      ? <EmptyState title="Aucune exécution" />
      : runs.data && <div className="table-wrap"><table className="data-table sbx-table">
        <thead><tr><th>Date</th><th>Build</th><th>Membre et campagne</th><th>Statut</th><th>Conteneur</th><th><span className="sbx-sr-only">Actions</span></th></tr></thead>
        <tbody>{runs.data.runs.map((run) => <tr key={run.id}>
          <td className="sbx-nowrap">{dateTime(run.queued_at)}<span className="sbx-sub">{formatDuration(run.duration_ms)}</span></td>
          <td className="sbx-cell-build"><Link className="text-link sbx-file" to={`/sandbox/${run.id}`}>{run.file_name}</Link><span className="sbx-sub">{run.profile_id}</span></td>
          <td>{run.requester_name}<span className="sbx-sub">{run.campaign_title}</span></td>
          <td><RunStatusBadge status={run.status} />{run.error && !activeStatus(run.status) && <span className={run.status === 'cancelled' ? 'sbx-sub' : 'sbx-error-text'} title={run.error}>{run.error}</span>}</td>
          <td className="sbx-mono sbx-container">{run.container_name}</td>
          <td>{activeStatus(run.status) && <button className="button button-danger button-small" type="button" onClick={() => void kill(run)} disabled={killing === run.id}>
            <Skull size={14} aria-hidden="true" />{killing === run.id ? 'Arrêt…' : 'Tuer'}</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    <p className="help-text">Chaque arrêt, modification de configuration, auto-test et téléchargement d’image est inscrit au journal d’audit.</p>
  </Section>;
}
