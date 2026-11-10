import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Eye, FileArchive, FileImage, FileText, FileVideo, Paperclip, ShieldAlert, Trash2 } from 'lucide-react';
import { Badge, ErrorState, Modal } from './ui';
import FileUpload, { formatFileSize } from './FileUpload';
import { api, dateTime, errorMessage } from '../lib/api';
import '../styles/files.css';

/* Files attached to a resource, with antivirus status, downloads and uploads. OWNER: files module. */

export interface FileAttachmentsProps {
  resourceType: string;
  resourceId: string;
  purpose: string;
  canUpload?: boolean;
  title?: string;
}

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error' | 'skipped';

/** Metadata returned by GET /api/files (see publicFile in server/modules/files.ts). */
export interface FileInfo {
  id: string; owner_id: string | null; owner_name: string | null; purpose: string; purpose_label: string;
  original_name: string; mime_type: string; size_bytes: number; sha256: string; scan_status: ScanStatus;
  resource_type: string | null; resource_id: string | null; created_at: string; quarantined: boolean;
  available: boolean; unavailable_reason: string | null; download_url: string; preview_url: string | null;
  can_delete: boolean; is_owner: boolean;
}

const scanLabels: Record<ScanStatus, { label: string; tone: string }> = {
  pending: { label: 'Analyse en cours', tone: 'orange' },
  clean: { label: 'Sain', tone: 'green' },
  infected: { label: 'Infecté — mis en quarantaine', tone: 'red' },
  error: { label: 'Erreur d’analyse', tone: 'orange' },
  skipped: { label: 'Non analysé', tone: 'neutral' },
};

export function ScanBadge({ status, quarantined }: { status: ScanStatus; quarantined?: boolean }) {
  if (quarantined && status !== 'infected') return <Badge tone="red"><ShieldAlert size={11} aria-hidden="true" />Mis en quarantaine</Badge>;
  const info = scanLabels[status] ?? scanLabels.skipped;
  return <Badge tone={info.tone}>{status === 'pending' && <span className="fa-pulse" aria-hidden="true" />}{info.label}</Badge>;
}

function FileIcon({ mime }: { mime: string }) {
  if (mime.startsWith('image/')) return <FileImage size={18} aria-hidden="true" />;
  if (mime.startsWith('video/')) return <FileVideo size={18} aria-hidden="true" />;
  if (mime.startsWith('text/') || mime === 'application/pdf' || mime === 'application/json') return <FileText size={18} aria-hidden="true" />;
  return <FileArchive size={18} aria-hidden="true" />;
}

const POLL_MS = 5000;

export default function FileAttachments({ resourceType, resourceId, purpose, canUpload, title }: FileAttachmentsProps) {
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [confirm, setConfirm] = useState<FileInfo | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const previous = useRef(new Map<string, ScanStatus>());
  const path = `/files?resource_type=${encodeURIComponent(resourceType)}&resource_id=${encodeURIComponent(resourceId)}`;

  const apply = useCallback((list: FileInfo[]) => {
    const changes: string[] = [];
    for (const file of list) {
      const before = previous.current.get(file.id);
      if (before === 'pending' && file.scan_status !== 'pending') {
        changes.push(`${file.original_name} : ${file.scan_status === 'clean' ? 'analyse terminée, fichier sain' : scanLabels[file.scan_status]?.label ?? file.scan_status}.`);
      }
    }
    previous.current = new Map(list.map((file) => [file.id, file.scan_status]));
    if (changes.length) setAnnouncement(changes.join(' '));
    setFiles(list);
  }, []);

  const load = useCallback(async (signal?: { active: boolean }) => {
    try {
      const list = await api<FileInfo[]>(path);
      if (signal && !signal.active) return;
      setError('');
      apply(list);
    } catch (reason) {
      if (signal && !signal.active) return;
      setError(errorMessage(reason));
    }
  }, [path, apply]);

  useEffect(() => {
    const signal = { active: true };
    previous.current = new Map();
    setFiles(null);
    void load(signal);
    return () => { signal.active = false; };
  }, [load]);

  const waiting = !!files?.some((file) => file.scan_status === 'pending' && !file.quarantined);
  useEffect(() => {
    if (!waiting) return;
    const signal = { active: true };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(signal); }, POLL_MS);
    return () => { signal.active = false; window.clearInterval(timer); };
  }, [waiting, load]);

  const remove = async () => {
    if (!confirm) return;
    setDeleting(true); setDeleteError('');
    try {
      await api(`/files/${encodeURIComponent(confirm.id)}`, { method: 'DELETE' });
      setFiles((list) => list?.filter((file) => file.id !== confirm.id) ?? null);
      setAnnouncement(`${confirm.original_name} a été supprimé.`);
      setConfirm(null);
    } catch (reason) {
      setDeleteError(errorMessage(reason));
    } finally {
      setDeleting(false);
    }
  };

  const heading = title ?? 'Fichiers joints';
  return <section className="fa" aria-label={heading}>
    <div className="fa-head">
      <h3><Paperclip size={15} aria-hidden="true" />{heading}</h3>
      {files && files.length > 0 && <span className="fa-count">{files.length} fichier{files.length > 1 ? 's' : ''}</span>}
    </div>
    <ErrorState message={error} />
    {files === null && !error && <p className="fa-empty" role="status">Chargement des fichiers…</p>}
    {files && files.length === 0 && <p className="fa-empty">Aucun fichier pour l’instant.</p>}
    {files && files.length > 0 && <ul className="fa-list">
      {files.map((file) => <li key={file.id} className={`fa-item ${file.quarantined ? 'fa-item-quarantined' : ''}`}>
        <span className="fa-icon"><FileIcon mime={file.mime_type} /></span>
        <div className="fa-main">
          <span className="fa-title-row">
            <span className="fa-name" title={file.original_name}>{file.original_name}</span>
            <ScanBadge status={file.scan_status} quarantined={file.quarantined} />
          </span>
          <span className="fa-meta">
            {formatFileSize(file.size_bytes)} · {file.owner_name ? `${file.owner_name} · ` : ''}{dateTime(file.created_at)}
          </span>
          {!file.available && file.unavailable_reason && <span className="fa-reason">{file.unavailable_reason}</span>}
        </div>
        <div className="fa-actions">
          {file.preview_url && <a className="button button-ghost button-small" href={file.preview_url} target="_blank" rel="noopener noreferrer"
            aria-label={`Aperçu de ${file.original_name} (nouvel onglet)`}><Eye size={14} aria-hidden="true" />Aperçu</a>}
          {file.available && <a className="button button-secondary button-small" href={file.download_url} download
            aria-label={`Télécharger ${file.original_name}`}><Download size={14} aria-hidden="true" />Télécharger</a>}
          {file.can_delete && <button type="button" className="button button-danger button-small" onClick={() => { setDeleteError(''); setConfirm(file); }}
            aria-label={`Supprimer ${file.original_name}`}><Trash2 size={14} aria-hidden="true" />Supprimer</button>}
        </div>
      </li>)}
    </ul>}
    {canUpload && <FileUpload purpose={purpose} resourceType={resourceType} resourceId={resourceId}
      label={files?.length ? 'Ajouter un autre fichier' : 'Ajouter un fichier'} onUploaded={() => void load()} />}
    <p className="fa-sr" aria-live="polite">{announcement}</p>
    {confirm && <Modal title="Supprimer ce fichier ?" onClose={() => !deleting && setConfirm(null)}>
      <div className="stack">
        <p>« {confirm.original_name} » sera retiré et son contenu chiffré définitivement effacé. Cette action est irréversible.</p>
        <ErrorState message={deleteError} />
        <div className="row-between">
          <button type="button" className="button button-secondary" onClick={() => setConfirm(null)} disabled={deleting}>Annuler</button>
          <button type="button" className="button button-danger" onClick={remove} disabled={deleting}><Trash2 size={15} aria-hidden="true" />{deleting ? 'Suppression…' : 'Supprimer'}</button>
        </div>
      </div>
    </Modal>}
  </section>;
}
