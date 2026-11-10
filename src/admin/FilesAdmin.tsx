import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, Download, Eraser, FileSearch, KeyRound, RefreshCw, RotateCcw, Save, ShieldAlert, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, Modal } from '../components/ui';
import { formatFileSize, type UploadPolicy } from '../components/FileUpload';
import { ScanBadge, type FileInfo, type ScanStatus } from '../components/FileAttachments';
import { api, dateTime, errorMessage } from '../lib/api';
import '../styles/files.css';

/* Files & antivirus administration: storage statistics, scan supervision, quarantine, ClamAV, rules and KYC access log. OWNER: files module. */

const MB = 1024 * 1024;

interface ClamavSetting { enabled: boolean; host: string; port: number; timeout_ms: number }
interface AdminPolicy extends UploadPolicy {
  default_max_bytes: number; default_kinds: string[]; kind_ids: string[]; overridden: boolean; internal: boolean;
}
interface Overview {
  stats: { purpose: string; scan_status: ScanStatus; count: number; bytes: number; label: string }[];
  totals: { active: number; bytes: number; pending: number; quarantined: number; errors: number; awaiting_purge: number; unattached: number };
  scanner: { configured: true; source: 'settings' | 'env'; host: string; port: number; timeout_ms: number } | { configured: false };
  clamav_setting: ClamavSetting | null;
  clamav_env: { host: string; port: number } | null;
  require_scan: boolean;
  quota_bytes: number;
  hard_max_bytes: number;
  kyc_retention_days: number;
  encryption: { algorithm: string; key_fingerprint: string; files_with_previous_key: number };
  policies: AdminPolicy[];
  kinds: { id: string; label: string; extensions: string[] }[];
}
interface AdminFile extends FileInfo {
  owner_email: string | null; scan_detail: string | null; scanned_at: string | null; scan_attempts: number; next_scan_at: string | null;
  quarantined_at: string | null; purged_at: string | null; detected_kind: string | null; retain_until: string | null; deleted_at: string | null;
  link: string | null;
}
interface AccessEntry {
  id: string; file_id: string; actor_id: string | null; actor_name: string | null; actor_email: string | null; action: string;
  reason: string; at: string; owner_id: string | null; owner_name: string | null; purpose: string | null;
}
interface ClamavTest {
  ok: boolean; ping?: boolean; version?: string; latency_ms: number; target?: string; message?: string; error?: string;
  verdict?: { status: 'clean' | 'infected' | 'error'; signature?: string; detail?: string };
}
type Filters = { state: string; scan_status: string; purpose: string; q: string };

/** Like useApi, but keeps the previous data while reloading so forms and tables don't flash. */
function useAdminData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    api<T>(path).then((value) => { if (active) { setData(value); setError(''); } })
      .catch((reason) => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, revision]);
  return { data, error, loading, reload: useCallback(() => setRevision((value) => value + 1), []) };
}

const tabs = [
  { id: 'overview', label: 'Vue d’ensemble' },
  { id: 'files', label: 'Fichiers' },
  { id: 'antivirus', label: 'Antivirus' },
  { id: 'rules', label: 'Règles & quotas' },
  { id: 'kyc', label: 'Journal KYC' },
] as const;
type TabId = (typeof tabs)[number]['id'];

export default function FilesAdmin() {
  const overview = useAdminData<Overview>('/files/admin/overview');
  const [tab, setTab] = useState<TabId>('overview');
  const [filters, setFilters] = useState<Filters>({ state: 'active', scan_status: '', purpose: '', q: '' });
  const baseId = useId();
  if (!overview.data) return overview.loading ? <Loading /> : <ErrorState message={overview.error || 'Données indisponibles.'} />;
  const showFiles = (next: Partial<Filters>) => { setFilters({ state: 'active', scan_status: '', purpose: '', q: '', ...next }); setTab('files'); };
  return <div className="stack fadm">
    <div className="fadm-tabs" role="tablist" aria-label="Sections fichiers & antivirus">
      {tabs.map((item) => <button key={item.id} type="button" role="tab" id={`${baseId}-${item.id}`} aria-selected={tab === item.id}
        aria-controls={`${baseId}-panel`} className={`fadm-tab ${tab === item.id ? 'active' : ''}`} onClick={() => setTab(item.id)}>{item.label}</button>)}
    </div>
    <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-${tab}`} className="stack">
      <ErrorState message={overview.error} />
      {tab === 'overview' && <OverviewPanel data={overview.data} reload={overview.reload} showFiles={showFiles} />}
      {tab === 'files' && <FilesPanel data={overview.data} filters={filters} setFilters={setFilters} onChanged={overview.reload} />}
      {tab === 'antivirus' && <AntivirusPanel data={overview.data} reload={overview.reload} />}
      {tab === 'rules' && <RulesPanel data={overview.data} reload={overview.reload} />}
      {tab === 'kyc' && <AccessLogPanel />}
    </div>
  </div>;
}

function Section({ title, children, action, icon }: { title: string; children: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return <section className="card">
    <div className="card-header"><h2 className="fadm-title">{icon}{title}</h2>{action}</div>
    <div className="card-body stack">{children}</div>
  </section>;
}

function Stat({ label, value, note, onClick, tone }: { label: string; value: string; note?: string; onClick?: () => void; tone?: 'danger' | 'warning' }) {
  const body = <><span className="stat-label">{label}</span><strong className={`stat-value fadm-stat-${tone ?? 'plain'}`}>{value}</strong>{note && <div className="stat-note">{note}</div>}</>;
  return onClick
    ? <button type="button" className="stat-card fadm-stat-button" onClick={onClick}>{body}</button>
    : <div className="stat-card">{body}</div>;
}

const statusOrder: ScanStatus[] = ['clean', 'pending', 'infected', 'error', 'skipped'];
const statusColumn: Record<ScanStatus, string> = { clean: 'Sains', pending: 'En attente', infected: 'Infectés', error: 'Erreurs', skipped: 'Non analysés' };

function OverviewPanel({ data, reload, showFiles }: { data: Overview; reload: () => void; showFiles: (filters: Partial<Filters>) => void }) {
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const rows = data.policies.map((policy) => {
    const items = data.stats.filter((item) => item.purpose === policy.purpose);
    const byStatus = Object.fromEntries(statusOrder.map((status) => [status, items.find((item) => item.scan_status === status)?.count ?? 0])) as Record<ScanStatus, number>;
    return { policy, count: items.reduce((sum, item) => sum + item.count, 0), bytes: items.reduce((sum, item) => sum + item.bytes, 0), byStatus };
  });
  const runAction = async (name: 'scan-pending' | 'cleanup' | 'rekey') => {
    setBusy(name); setResult(''); setError('');
    try {
      const report = await api<Record<string, unknown>>(`/files/admin/${name}`, { method: 'POST' });
      if (name === 'scan-pending') {
        const value = report as { scanned: number; statuses: Record<string, number> };
        const detail = Object.entries(value.statuses).map(([status, count]) => `${statusColumn[status as ScanStatus] ?? status} : ${count}`).join(', ');
        setResult(value.scanned ? `${value.scanned} fichier(s) analysé(s)${detail ? ` — ${detail}` : ''}.` : 'Aucun fichier en attente d’analyse.');
      } else if (name === 'cleanup') {
        const value = report as Record<string, number>;
        setResult(`Nettoyage terminé : ${value.unattached} envoi(s) non rattaché(s), ${value.unattached_kyc} brouillon(s) KYC, ${value.privacy_exports} export(s) RGPD, `
          + `${value.kyc_expired} pièce(s) KYC arrivée(s) à échéance, ${value.purged} contenu(s) effacé(s), ${value.temp_files} fichier(s) temporaire(s), ${value.orphans} objet(s) orphelin(s).`);
      } else {
        const value = report as { rekeyed: number; failed: number; remaining: number };
        setResult(`${value.rekeyed} fichier(s) rechiffré(s), ${value.failed} échec(s), ${value.remaining} restant(s).`);
      }
      reload();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  };
  const scanner = data.scanner;
  return <>
    {!scanner.configured && data.require_scan && <div className="alert alert-error" role="alert">
      Aucun antivirus n’est configuré alors que l’analyse est obligatoire : les nouveaux fichiers restent « en attente » et ne peuvent pas être téléchargés.
    </div>}
    <div className="stat-grid fadm-stats">
      <Stat label="Fichiers actifs" value={data.totals.active.toLocaleString('fr-FR')} note={`${formatFileSize(data.totals.bytes)} chiffrés au repos`} onClick={() => showFiles({})} />
      <Stat label="En attente d’analyse" value={data.totals.pending.toLocaleString('fr-FR')} tone={data.totals.pending ? 'warning' : undefined}
        note={scanner.configured ? `clamd ${scanner.host}:${scanner.port}` : 'Aucun antivirus configuré'} onClick={() => showFiles({ scan_status: 'pending' })} />
      <Stat label="En quarantaine" value={data.totals.quarantined.toLocaleString('fr-FR')} tone={data.totals.quarantined ? 'danger' : undefined}
        note="Contenu effacé, métadonnées conservées" onClick={() => showFiles({ state: 'quarantined' })} />
      <Stat label="Erreurs d’analyse" value={data.totals.errors.toLocaleString('fr-FR')} tone={data.totals.errors ? 'warning' : undefined} onClick={() => showFiles({ scan_status: 'error' })} />
      <Stat label="Non rattachés" value={data.totals.unattached.toLocaleString('fr-FR')} note="Supprimés après 24 h (KYC : 30 jours)" onClick={() => showFiles({ state: 'unattached' })} />
      <Stat label="À effacer physiquement" value={data.totals.awaiting_purge.toLocaleString('fr-FR')} note="Traités par la tâche files.cleanup" onClick={() => showFiles({ state: 'deleted' })} />
    </div>
    <Section title="Stockage par usage" icon={<Activity size={16} aria-hidden="true" />}>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Usage</th><th scope="col">Fichiers</th><th scope="col">Volume</th>{statusOrder.map((status) => <th key={status} scope="col">{statusColumn[status]}</th>)}<th scope="col">Limite</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.policy.purpose}>
          <th scope="row" className="fadm-row-head">{row.policy.label}{row.policy.internal && <span className="fadm-muted"> (serveur)</span>}</th>
          <td>{row.count.toLocaleString('fr-FR')}</td><td>{formatFileSize(row.bytes)}</td>
          {statusOrder.map((status) => <td key={status}>{row.byStatus[status] ? <button type="button" className="fadm-link"
            onClick={() => showFiles({ purpose: row.policy.purpose, scan_status: status })}>{row.byStatus[status].toLocaleString('fr-FR')}</button> : '—'}</td>)}
          <td>{formatFileSize(row.policy.max_bytes)}{row.policy.overridden && <Badge tone="purple">Personnalisée</Badge>}</td>
        </tr>)}</tbody>
      </table></div>
    </Section>
    <Section title="Chiffrement & maintenance" icon={<KeyRound size={16} aria-hidden="true" />}>
      <dl className="fadm-kv">
        <dt>Algorithme</dt><dd>{data.encryption.algorithm}, clé dérivée par fichier</dd>
        <dt>Empreinte de la clé</dt><dd><code>{data.encryption.key_fingerprint}</code></dd>
        <dt>Fichiers sur une ancienne clé</dt><dd>{data.encryption.files_with_previous_key.toLocaleString('fr-FR')}</dd>
        <dt>Plafond absolu par fichier</dt><dd>{formatFileSize(data.hard_max_bytes)}</dd>
      </dl>
      <div className="fadm-actions">
        <button type="button" className="button button-secondary" disabled={!!busy || !scanner.configured} onClick={() => runAction('scan-pending')}>
          <RefreshCw size={15} aria-hidden="true" className={busy === 'scan-pending' ? 'spin' : ''} />Analyser les fichiers en attente</button>
        <button type="button" className="button button-secondary" disabled={!!busy} onClick={() => runAction('cleanup')}>
          <Eraser size={15} aria-hidden="true" />Lancer le nettoyage</button>
        <button type="button" className="button button-secondary" disabled={!!busy || data.encryption.files_with_previous_key === 0} onClick={() => runAction('rekey')}>
          <KeyRound size={15} aria-hidden="true" />Rechiffrer avec la clé actuelle</button>
      </div>
      {busy && <p className="help-text" role="status">Traitement en cours…</p>}
      {result && <div className="alert alert-success" role="status">{result}</div>}
      <ErrorState message={error} />
    </Section>
  </>;
}

const stateLabels: Record<string, string> = { active: 'Actifs', quarantined: 'En quarantaine', unattached: 'Non rattachés', deleted: 'Supprimés', all: 'Tous' };
const PAGE = 50;

function FilesPanel({ data, filters, setFilters, onChanged }: { data: Overview; filters: Filters; setFilters: (filters: Filters) => void; onChanged: () => void }) {
  const [draft, setDraft] = useState(filters.q);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<{ file: AdminFile; action: 'details' | 'quarantine' | 'delete' | 'download' } | null>(null);
  const [notice, setNotice] = useState('');
  const [rowError, setRowError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { setDraft(filters.q); setOffset(0); }, [filters]);
  const params = new URLSearchParams({ state: filters.state, limit: String(PAGE), offset: String(offset) });
  if (filters.scan_status) params.set('scan_status', filters.scan_status);
  if (filters.purpose) params.set('purpose', filters.purpose);
  if (filters.q) params.set('q', filters.q);
  const list = useAdminData<{ total: number; files: AdminFile[] }>(`/files/admin/files?${params}`);
  const refresh = () => { list.reload(); onChanged(); };

  const rescan = async (file: AdminFile) => {
    setBusy(file.id); setNotice(''); setRowError('');
    try {
      const updated = await api<AdminFile>(`/files/admin/files/${file.id}/rescan`, { method: 'POST' });
      setNotice(`Nouvelle analyse de « ${file.original_name} » : ${updated.quarantined ? 'infecté, mis en quarantaine' : updated.scan_status === 'clean' ? 'sain' : updated.scan_status}.`);
      refresh();
    } catch (reason) {
      setRowError(errorMessage(reason));
    } finally {
      setBusy('');
    }
  };
  const update = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  const submit = (event: FormEvent) => { event.preventDefault(); update({ q: draft.trim() }); };
  const total = list.data?.total ?? 0;

  return <Section title="Fichiers" icon={<FileSearch size={16} aria-hidden="true" />}>
    <form className="fadm-filters" onSubmit={submit} role="search">
      <div className="field"><label htmlFor="fadm-state">État</label>
        <select id="fadm-state" value={filters.state} onChange={(event) => update({ state: event.target.value })}>
          {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></div>
      <div className="field"><label htmlFor="fadm-status">Analyse</label>
        <select id="fadm-status" value={filters.scan_status} onChange={(event) => update({ scan_status: event.target.value })}>
          <option value="">Toutes</option>
          {statusOrder.map((status) => <option key={status} value={status}>{statusColumn[status]}</option>)}
        </select></div>
      <div className="field"><label htmlFor="fadm-purpose">Usage</label>
        <select id="fadm-purpose" value={filters.purpose} onChange={(event) => update({ purpose: event.target.value })}>
          <option value="">Tous</option>
          {data.policies.map((policy) => <option key={policy.purpose} value={policy.purpose}>{policy.label}</option>)}
        </select></div>
      <div className="field fadm-search"><label htmlFor="fadm-q">Recherche</label>
        <input id="fadm-q" value={draft} maxLength={200} onChange={(event) => setDraft(event.target.value)} placeholder="Nom, e-mail du titulaire, identifiant ou SHA-256" /></div>
      <button type="submit" className="button button-secondary">Filtrer</button>
    </form>
    {notice && <div className="alert alert-success" role="status">{notice}</div>}
    <ErrorState message={rowError || list.error} />
    {!list.data ? <Loading /> : list.data.files.length === 0 ? <EmptyState title="Aucun fichier" description="Aucun fichier ne correspond à ces filtres." /> : <>
      <div className="table-wrap"><table className="data-table fadm-table">
        <thead><tr><th scope="col">Fichier</th><th scope="col">Titulaire</th><th scope="col">Usage</th><th scope="col">Analyse</th><th scope="col">Envoyé</th><th scope="col"><span className="fa-sr">Actions</span></th></tr></thead>
        <tbody>{list.data.files.map((file) => <tr key={file.id} className={file.deleted_at ? 'fadm-deleted' : ''}>
          <td><button type="button" className="fadm-link fadm-name" onClick={() => setSelected({ file, action: 'details' })}>{file.original_name}</button>
            <span className="fadm-sub">{formatFileSize(file.size_bytes)}{file.deleted_at ? ` · supprimé le ${dateTime(file.deleted_at)}` : ''}{file.purged_at ? ' · contenu effacé' : ''}</span></td>
          <td>{file.owner_name ?? <span className="fadm-muted">Compte supprimé</span>}{file.owner_email && <span className="fadm-sub">{file.owner_email}</span>}</td>
          <td>{file.purpose_label}{!file.resource_type && !file.deleted_at && <span className="fadm-sub">non rattaché</span>}</td>
          <td><ScanBadge status={file.scan_status} quarantined={file.quarantined} />{file.scan_status === 'pending' && file.scan_attempts > 0 && <span className="fadm-sub">{file.scan_attempts} tentative(s)</span>}</td>
          <td className="fadm-nowrap">{dateTime(file.created_at)}</td>
          <td><div className="fadm-row-actions">
            {file.available && !file.deleted_at && <button type="button" className="button button-ghost button-small" onClick={() => setSelected({ file, action: 'download' })}
              aria-label={`Télécharger ${file.original_name}`}><Download size={14} aria-hidden="true" /></button>}
            {!file.deleted_at && !file.quarantined && <button type="button" className="button button-ghost button-small" disabled={!data.scanner.configured || busy === file.id}
              onClick={() => rescan(file)} aria-label={`Analyser à nouveau ${file.original_name}`} title="Analyser à nouveau"><RefreshCw size={14} aria-hidden="true" className={busy === file.id ? 'spin' : ''} /></button>}
            {!file.deleted_at && !file.quarantined && <button type="button" className="button button-ghost button-small" onClick={() => setSelected({ file, action: 'quarantine' })}
              aria-label={`Mettre en quarantaine ${file.original_name}`} title="Mettre en quarantaine"><ShieldAlert size={14} aria-hidden="true" /></button>}
            {!file.deleted_at && <button type="button" className="button button-danger button-small" onClick={() => setSelected({ file, action: 'delete' })}
              aria-label={`Supprimer ${file.original_name}`} title="Supprimer"><Trash2 size={14} aria-hidden="true" /></button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>
      <div className="row-between fadm-pager">
        <span className="help-text">{offset + 1}–{Math.min(offset + PAGE, total)} sur {total.toLocaleString('fr-FR')}</span>
        <div className="fadm-actions">
          <button type="button" className="button button-secondary button-small" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédents</button>
          <button type="button" className="button button-secondary button-small" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Suivants</button>
        </div>
      </div>
    </>}
    {selected?.action === 'details' && <DetailsModal file={selected.file} onClose={() => setSelected(null)} />}
    {selected?.action === 'download' && <DownloadModal file={selected.file} onClose={() => setSelected(null)} />}
    {(selected?.action === 'quarantine' || selected?.action === 'delete') && <ModerationModal file={selected.file} action={selected.action}
      onClose={() => setSelected(null)} onDone={(message) => { setSelected(null); setNotice(message); refresh(); }} />}
  </Section>;
}

function DetailsModal({ file, onClose }: { file: AdminFile; onClose: () => void }) {
  return <Modal title="Détails du fichier" onClose={onClose}>
    <dl className="fadm-kv">
      <dt>Nom</dt><dd>{file.original_name}</dd>
      <dt>Identifiant</dt><dd><code>{file.id}</code></dd>
      <dt>Usage</dt><dd>{file.purpose_label}</dd>
      <dt>Type détecté</dt><dd>{file.detected_kind ?? '—'} ({file.mime_type})</dd>
      <dt>Taille</dt><dd>{formatFileSize(file.size_bytes)}</dd>
      <dt>SHA-256</dt><dd><code className="fadm-hash">{file.sha256}</code></dd>
      <dt>Titulaire</dt><dd>{file.owner_name ?? 'Compte supprimé'}{file.owner_email ? ` (${file.owner_email})` : ''}</dd>
      <dt>Ressource</dt><dd>{file.resource_type ? <>{file.resource_type} · <code>{file.resource_id}</code>{file.link && <> · <a href={file.link}>Ouvrir</a></>}</> : 'Non rattaché'}</dd>
      <dt>Analyse</dt><dd><ScanBadge status={file.scan_status} quarantined={file.quarantined} />{file.scan_detail && <span className="fadm-sub">{file.scan_detail}</span>}</dd>
      <dt>Dernière analyse</dt><dd>{file.scanned_at ? dateTime(file.scanned_at) : '—'}{file.scan_attempts ? ` · ${file.scan_attempts} tentative(s)` : ''}</dd>
      {file.next_scan_at && <><dt>Prochain essai</dt><dd>{dateTime(file.next_scan_at)}</dd></>}
      {file.quarantined_at && <><dt>Quarantaine</dt><dd>{dateTime(file.quarantined_at)}</dd></>}
      {file.retain_until && <><dt>Conservé jusqu’au</dt><dd>{dateTime(file.retain_until)}</dd></>}
      {file.deleted_at && <><dt>Supprimé</dt><dd>{dateTime(file.deleted_at)}{file.purged_at ? ` · contenu effacé le ${dateTime(file.purged_at)}` : ''}</dd></>}
    </dl>
  </Modal>;
}

function DownloadModal({ file, onClose }: { file: AdminFile; onClose: () => void }) {
  const isKyc = file.purpose === 'kyc_document';
  const [reason, setReason] = useState('');
  const valid = !isKyc || reason.trim().length >= 3;
  const href = `${file.download_url}${isKyc ? `?reason=${encodeURIComponent(reason.trim().slice(0, 200))}` : ''}`;
  return <Modal title="Télécharger le fichier" onClose={onClose}>
    <div className="stack">
      <p>Le fichier sera déchiffré et téléchargé tel quel (jamais affiché dans le navigateur).{file.scan_status !== 'clean' && ' Il n’a pas été déclaré sain par l’antivirus : ouvrez-le uniquement dans un environnement isolé.'}</p>
      {isKyc && <div className="field">
        <label htmlFor="fadm-download-reason">Motif de consultation (obligatoire, journalisé)</label>
        <input id="fadm-download-reason" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} placeholder="Ex. : vérification du dossier KYC n° …" />
        <p className="help-text">Chaque accès d’un administrateur à une pièce d’identité est inscrit au journal KYC.</p>
      </div>}
      <div className="row-between">
        <button type="button" className="button button-secondary" onClick={onClose}>Annuler</button>
        {valid
          ? <a className="button button-primary" href={href} download onClick={() => window.setTimeout(onClose, 0)}><Download size={15} aria-hidden="true" />Télécharger</a>
          : <button type="button" className="button button-primary" disabled><Download size={15} aria-hidden="true" />Télécharger</button>}
      </div>
    </div>
  </Modal>;
}

function ModerationModal({ file, action, onClose, onDone }: { file: AdminFile; action: 'quarantine' | 'delete'; onClose: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const quarantine = action === 'quarantine';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      if (quarantine) await api(`/files/admin/files/${file.id}/quarantine`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      else await api(`/files/admin/files/${file.id}`, { method: 'DELETE', body: JSON.stringify(reason.trim() ? { reason: reason.trim() } : {}) });
      onDone(quarantine ? `« ${file.original_name} » est en quarantaine : son contenu a été effacé et le titulaire prévenu.` : `« ${file.original_name} » a été supprimé.`);
    } catch (reason) {
      setError(errorMessage(reason));
      setBusy(false);
    }
  };
  return <Modal title={quarantine ? 'Mettre en quarantaine' : 'Supprimer le fichier'} onClose={() => !busy && onClose()}>
    <form className="form" onSubmit={submit}>
      <p>{quarantine
        ? `Le contenu chiffré de « ${file.original_name} » sera effacé définitivement ; ses métadonnées restent consultables et le titulaire est notifié.`
        : `« ${file.original_name} » sera supprimé puis son contenu effacé physiquement. Action journalisée.`}</p>
      <div className="field">
        <label htmlFor="fadm-reason">{quarantine ? 'Motif (obligatoire)' : 'Motif (facultatif)'}</label>
        <textarea id="fadm-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={quarantine ? 3 : undefined} maxLength={300} required={quarantine} rows={3} />
      </div>
      <ErrorState message={error} />
      <div className="row-between">
        <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>Annuler</button>
        <button type="submit" className="button button-danger" disabled={busy || (quarantine && reason.trim().length < 3)}>
          {quarantine ? <ShieldAlert size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}{busy ? 'Traitement…' : quarantine ? 'Mettre en quarantaine' : 'Supprimer'}
        </button>
      </div>
    </form>
  </Modal>;
}

function AntivirusPanel({ data, reload }: { data: Overview; reload: () => void }) {
  const initial = data.clamav_setting ?? { enabled: true, host: data.clamav_env?.host ?? '', port: data.clamav_env?.port ?? 3310, timeout_ms: 60000 };
  const [form, setForm] = useState<ClamavSetting>(initial);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<ClamavTest | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const scanner = data.scanner;

  const save = async (body: Record<string, unknown>, success: string) => {
    setSaving(true); setMessage(''); setError('');
    try {
      await api('/files/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
      setMessage(success);
      reload();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save({ clamav: { ...form, host: form.host.trim() } }, form.enabled ? 'Configuration de l’antivirus enregistrée.' : 'Antivirus désactivé.');
  };
  const runTest = async (useForm: boolean) => {
    setTesting(true); setTest(null); setError('');
    try {
      const body = useForm ? JSON.stringify({ host: form.host.trim(), port: form.port, timeout_ms: Math.min(form.timeout_ms, 60000) }) : undefined;
      setTest(await api<ClamavTest>('/files/admin/clamav/test', { method: 'POST', ...(body ? { body } : {}) }));
    } catch (reason) {
      setTest({ ok: false, latency_ms: 0, error: errorMessage(reason) });
    } finally {
      setTesting(false);
    }
  };
  const canTestForm = form.host.trim().length > 0 && form.port > 0;

  return <>
    <Section title="État de l’antivirus" icon={<ShieldCheck size={16} aria-hidden="true" />}>
      <dl className="fadm-kv">
        <dt>Analyseur actif</dt>
        <dd>{scanner.configured
          ? <><Badge tone="green">clamd</Badge> {scanner.host}:{scanner.port} · délai {Math.round(scanner.timeout_ms / 1000)} s · {scanner.source === 'settings' ? 'réglage administrateur' : 'variables d’environnement'}</>
          : <Badge tone={data.require_scan ? 'red' : 'neutral'}>Aucun</Badge>}</dd>
        <dt>Variables d’environnement</dt><dd>{data.clamav_env ? <code>CLAMAV_HOST={data.clamav_env.host} CLAMAV_PORT={data.clamav_env.port}</code> : 'Non définies'}</dd>
      </dl>
      <div className="fadm-actions">
        <button type="button" className="button button-primary" onClick={() => runTest(false)} disabled={testing || !scanner.configured}>
          <Zap size={15} aria-hidden="true" />{testing ? 'Test en cours…' : 'Tester avec EICAR'}</button>
      </div>
      <p className="help-text">Le test envoie la chaîne de test standard EICAR (inoffensive) au serveur clamd configuré : elle doit être détectée comme « Eicar-Test-Signature ».</p>
      {test && <TestResult result={test} />}
    </Section>
    <Section title="Analyse obligatoire" icon={<ShieldAlert size={16} aria-hidden="true" />}>
      <label className="fadm-toggle">
        <input type="checkbox" checked={data.require_scan} disabled={saving}
          onChange={(event) => save({ require_scan: event.target.checked }, event.target.checked ? 'Analyse antivirus désormais obligatoire.' : 'Analyse antivirus facultative.')} />
        <span><strong>Exiger une analyse antivirus saine avant tout téléchargement</strong>
          <span className="help-text">Builds, livraisons, pièces jointes de mission et de messagerie, pièces KYC. Recommandé (activé par défaut en production).
            {!scanner.configured && ' Sans antivirus configuré, les nouveaux fichiers resteront en attente et ne pourront pas être téléchargés.'}</span></span>
      </label>
    </Section>
    <Section title="Connexion à clamd" icon={<Activity size={16} aria-hidden="true" />}
      action={data.clamav_setting && <button type="button" className="button button-ghost button-small" disabled={saving}
        onClick={() => save({ clamav: null }, 'Réglage supprimé : les variables d’environnement CLAMAV_HOST / CLAMAV_PORT s’appliquent.')}>
        <RotateCcw size={14} aria-hidden="true" />Revenir aux variables d’environnement</button>}>
      <form className="form" onSubmit={submit}>
        <label className="fadm-toggle">
          <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
          <span><strong>Analyse antivirus activée</strong><span className="help-text">Désactivée, aucun fichier n’est analysé (même si CLAMAV_HOST est défini).</span></span>
        </label>
        <div className="form-grid">
          <div className="field"><label htmlFor="fadm-host">Hôte clamd</label>
            <input id="fadm-host" value={form.host} required={form.enabled} maxLength={253} pattern="[A-Za-z0-9.\-:\[\]]+" placeholder="clamav"
              onChange={(event) => setForm({ ...form, host: event.target.value })} /></div>
          <div className="field"><label htmlFor="fadm-port">Port TCP</label>
            <input id="fadm-port" type="number" min={1} max={65535} required value={form.port} onChange={(event) => setForm({ ...form, port: Number(event.target.value) })} /></div>
          <div className="field"><label htmlFor="fadm-timeout">Délai maximal (ms)</label>
            <input id="fadm-timeout" type="number" min={500} max={600000} step={500} required value={form.timeout_ms}
              onChange={(event) => setForm({ ...form, timeout_ms: Number(event.target.value) })} />
            <p className="help-text">Les gros builds (200 Mo) peuvent demander plus d’une minute d’analyse.</p></div>
        </div>
        <div className="fadm-actions">
          <button type="submit" className="button button-primary" disabled={saving || (form.enabled && !form.host.trim())}><Save size={15} aria-hidden="true" />Enregistrer</button>
          <button type="button" className="button button-secondary" disabled={testing || !canTestForm} onClick={() => runTest(true)}>
            <Zap size={15} aria-hidden="true" />Tester ces paramètres avec EICAR</button>
        </div>
      </form>
      {message && <div className="alert alert-success" role="status">{message}</div>}
      <ErrorState message={error} />
    </Section>
  </>;
}

function TestResult({ result }: { result: ClamavTest }) {
  if (!result.ok) {
    return <div className="alert alert-error" role="alert">{result.error ?? result.message ?? 'Le test a échoué.'}{result.version && <> · {result.version}</>}</div>;
  }
  return <div className="alert alert-success" role="status">
    {result.message} <span className="fadm-sub">{result.version ? `${result.version} · ` : ''}{result.target ? `${result.target} · ` : ''}{result.latency_ms} ms</span>
  </div>;
}

interface PolicyDraft { max_mb: number; kinds: string[] }

function RulesPanel({ data, reload }: { data: Overview; reload: () => void }) {
  const editable = data.policies.filter((policy) => !policy.internal);
  const initialDrafts = () => Object.fromEntries(data.policies.map((policy) => [policy.purpose, { max_mb: +(policy.max_bytes / MB).toFixed(2), kinds: policy.kind_ids }])) as Record<string, PolicyDraft>;
  const [quotaMb, setQuotaMb] = useState(Math.round(data.quota_bytes / MB));
  const [retention, setRetention] = useState(data.kyc_retention_days);
  const [drafts, setDrafts] = useState<Record<string, PolicyDraft>>(initialDrafts);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const hardMaxMb = Math.floor(data.hard_max_bytes / MB);

  const setDraft = (purpose: string, patch: Partial<PolicyDraft>) => setDrafts((current) => ({ ...current, [purpose]: { ...current[purpose], ...patch } }));
  const toggleKind = (purpose: string, kind: string) => {
    const kinds = drafts[purpose].kinds;
    setDraft(purpose, { kinds: kinds.includes(kind) ? kinds.filter((item) => item !== kind) : [...kinds, kind] });
  };
  const overrides = () => {
    const result: Record<string, { max_bytes?: number; kinds?: string[] }> = {};
    for (const policy of data.policies) {
      const draft = drafts[policy.purpose];
      const maxBytes = Math.round(draft.max_mb * MB);
      const sameKinds = draft.kinds.length === policy.default_kinds.length && draft.kinds.every((kind) => policy.default_kinds.includes(kind));
      const entry: { max_bytes?: number; kinds?: string[] } = {};
      if (maxBytes !== policy.default_max_bytes) entry.max_bytes = maxBytes;
      if (!sameKinds) entry.kinds = draft.kinds;
      if (Object.keys(entry).length) result[policy.purpose] = entry;
    }
    return result;
  };
  const invalid = editable.find((policy) => !drafts[policy.purpose].kinds.length || !(drafts[policy.purpose].max_mb > 0) || drafts[policy.purpose].max_mb > hardMaxMb);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true); setMessage(''); setError('');
    try {
      await api('/files/admin/settings', { method: 'PUT', body: JSON.stringify({ quota_bytes: Math.round(quotaMb * MB), kyc_retention_days: retention, policies: overrides() }) });
      setMessage('Règles enregistrées. Elles s’appliquent aux prochains envois.');
      reload();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  return <form className="stack" onSubmit={submit}>
    <Section title="Quota & conservation">
      <div className="form-grid">
        <div className="field"><label htmlFor="fadm-quota">Quota de stockage par utilisateur (Mo)</label>
          <input id="fadm-quota" type="number" min={1} max={1048576} required value={quotaMb} onChange={(event) => setQuotaMb(Number(event.target.value))} />
          <p className="help-text">Les exports RGPD et artefacts du bac à sable ne sont pas décomptés. Actuel : {formatFileSize(data.quota_bytes)}.</p></div>
        <div className="field"><label htmlFor="fadm-retention">Conservation des pièces KYC (jours)</label>
          <input id="fadm-retention" type="number" min={30} max={36500} required value={retention} onChange={(event) => setRetention(Number(event.target.value))} />
          <p className="help-text">Durée légale après la clôture du compte (LCB-FT : 5 ans, soit 1 825 jours).</p></div>
      </div>
    </Section>
    <Section title="Règles par usage">
      <p className="help-text">Taille maximale et formats acceptés. Le contenu réel (signature binaire) est toujours vérifié en plus de l’extension. Plafond absolu : {formatFileSize(data.hard_max_bytes)}.</p>
      {editable.map((policy) => {
        const draft = drafts[policy.purpose];
        const fieldId = `fadm-max-${policy.purpose}`;
        return <details key={policy.purpose} className="fadm-policy" open={policy.overridden}>
          <summary><strong>{policy.label}</strong> <span className="fadm-muted">{formatFileSize(policy.max_bytes)} · {policy.kinds.length} format(s)</span>
            {policy.overridden && <Badge tone="purple">Personnalisée</Badge>}</summary>
          <div className="stack fadm-policy-body">
            <div className="field fadm-narrow"><label htmlFor={fieldId}>Taille maximale (Mo)</label>
              <input id={fieldId} type="number" min={0.01} max={hardMaxMb} step="any" required value={draft.max_mb}
                onChange={(event) => setDraft(policy.purpose, { max_mb: Number(event.target.value) })} />
              <p className="help-text">Par défaut : {formatFileSize(policy.default_max_bytes)}.</p></div>
            <fieldset className="fadm-kinds">
              <legend>Formats acceptés</legend>
              {data.kinds.map((kind) => <label key={kind.id} className="fadm-kind">
                <input type="checkbox" checked={draft.kinds.includes(kind.id)} onChange={() => toggleKind(policy.purpose, kind.id)} />
                <span>{kind.label} <span className="fadm-muted">{kind.extensions.join(' ')}</span></span>
              </label>)}
            </fieldset>
            {!draft.kinds.length && <p className="fu-error" role="alert">Sélectionnez au moins un format.</p>}
            <button type="button" className="button button-ghost button-small fadm-self-start"
              onClick={() => setDraft(policy.purpose, { max_mb: +(policy.default_max_bytes / MB).toFixed(2), kinds: policy.default_kinds })}>
              <RotateCcw size={14} aria-hidden="true" />Valeurs par défaut</button>
          </div>
        </details>;
      })}
    </Section>
    {message && <div className="alert alert-success" role="status">{message}</div>}
    <ErrorState message={error} />
    <div className="fadm-actions">
      <button type="submit" className="button button-primary" disabled={saving || !!invalid}><Save size={15} aria-hidden="true" />{saving ? 'Enregistrement…' : 'Enregistrer les règles'}</button>
      <button type="button" className="button button-secondary" disabled={saving} onClick={() => { setDrafts(initialDrafts()); setQuotaMb(Math.round(data.quota_bytes / MB)); setRetention(data.kyc_retention_days); }}>Annuler les modifications</button>
    </div>
  </form>;
}

const accessLabels: Record<string, string> = {
  metadata: 'Consultation des métadonnées', download: 'Téléchargement', list: 'Affichage dans une liste', read: 'Lecture par un service interne',
};

function AccessLogPanel() {
  const [fileId, setFileId] = useState('');
  const [applied, setApplied] = useState('');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const log = useAdminData<AccessEntry[]>(`/files/admin/access-log?limit=200${applied ? `&file_id=${encodeURIComponent(applied)}` : ''}`);
  const submit = (event: FormEvent) => { event.preventDefault(); setApplied(fileId.trim()); };
  const invalid = fileId.trim() !== '' && !uuid.test(fileId.trim());
  return <Section title="Journal d’accès aux pièces KYC" icon={<KeyRound size={16} aria-hidden="true" />}
    action={<button type="button" className="button button-ghost button-small" onClick={log.reload}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>}>
    <p className="help-text">Tout accès d’un administrateur (ou d’un service agissant pour lui) à une pièce d’identité d’un autre utilisateur est inscrit ici, avec son motif. Ce journal n’est pas modifiable.</p>
    <form className="fadm-filters" onSubmit={submit} role="search">
      <div className="field fadm-search"><label htmlFor="fadm-log-file">Identifiant du fichier</label>
        <input id="fadm-log-file" value={fileId} onChange={(event) => setFileId(event.target.value)} aria-invalid={invalid} placeholder="UUID (laisser vide pour tout afficher)" /></div>
      <button type="submit" className="button button-secondary" disabled={invalid}>Filtrer</button>
    </form>
    <ErrorState message={log.error} />
    {!log.data ? <Loading /> : log.data.length === 0 ? <EmptyState title="Aucun accès journalisé" description="Aucun administrateur n’a consulté de pièce KYC." /> :
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Administrateur</th><th scope="col">Action</th><th scope="col">Motif</th><th scope="col">Titulaire</th><th scope="col">Fichier</th></tr></thead>
        <tbody>{log.data.map((entry) => <tr key={entry.id}>
          <td className="fadm-nowrap">{dateTime(entry.at)}</td>
          <td>{entry.actor_name ?? 'Service'}{entry.actor_email && <span className="fadm-sub">{entry.actor_email}</span>}</td>
          <td>{accessLabels[entry.action] ?? entry.action}</td>
          <td>{entry.reason}</td>
          <td>{entry.owner_name ?? <span className="fadm-muted">Compte supprimé</span>}</td>
          <td><button type="button" className="fadm-link" onClick={() => { setFileId(entry.file_id); setApplied(entry.file_id); }} title="Filtrer sur ce fichier"><code>{entry.file_id.slice(0, 8)}</code></button></td>
        </tr>)}</tbody>
      </table></div>}
  </Section>;
}
