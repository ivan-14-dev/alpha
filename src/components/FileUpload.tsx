import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { CheckCircle2, UploadCloud, X } from 'lucide-react';
import { api, deviceId, errorMessage } from '../lib/api';
import '../styles/files.css';

/* Secure upload widget (POST /api/files, multipart). OWNER: files module.
 * Never renders a <form>: it is embedded in other modules' forms, so every button is type="button". */

export interface UploadedFile {
  id: string; original_name: string; mime_type: string; size_bytes: number;
  scan_status: 'pending' | 'clean' | 'infected' | 'error' | 'skipped'; purpose: string; created_at: string;
}
export interface FileUploadProps {
  purpose: string;
  resourceType?: string;
  resourceId?: string;
  label?: string;
  accept?: string;
  disabled?: boolean;
  onUploaded: (file: UploadedFile) => void;
}

export interface UploadPolicy {
  purpose: string; label: string; resource_type: string; max_bytes: number;
  kinds: { id: string; label: string }[]; extensions: string[]; accept: string;
}
export interface UploadHints {
  policies: UploadPolicy[];
  quota: { limit_bytes: number; used_bytes: number };
  require_scan: boolean;
  scanner: boolean;
}

const sizeUnits = ['octets', 'Ko', 'Mo', 'Go', 'To'];
/** Human readable size in French binary units (1 Mo = 1 048 576 octets, as enforced by the server). */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) { value /= 1024; unit += 1; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: digits })} ${sizeUnits[unit]}`;
}

let hintsCache: { at: number; promise: Promise<UploadHints> } | null = null;
/** Upload policies are shared by every widget of the page; refreshed after each upload (quota) or after a minute. */
export function loadUploadHints(force = false): Promise<UploadHints> {
  if (force || !hintsCache || Date.now() - hintsCache.at > 60_000) {
    const promise = api<UploadHints>('/files/policies');
    hintsCache = { at: Date.now(), promise };
    promise.catch(() => { if (hintsCache?.promise === promise) hintsCache = null; });
  }
  return hintsCache.promise;
}

function lowerName(file: File) { return file.name.toLowerCase(); }

/** Client-side pre-checks only mirror the server rules to give early feedback; the server re-validates everything. */
function precheck(file: File, policy: UploadPolicy | undefined, hints: UploadHints | null, accept: string | undefined): string | null {
  if (file.size === 0) return 'Ce fichier est vide.';
  const name = lowerName(file);
  if (policy) {
    if (!policy.extensions.some((extension) => name.endsWith(extension))) {
      return `Format non accepté. Formats autorisés : ${policy.extensions.join(', ')}.`;
    }
    if (file.size > policy.max_bytes) return `Fichier trop volumineux (${formatFileSize(file.size)}) : ${formatFileSize(policy.max_bytes)} maximum.`;
  }
  const narrowed = accept?.split(',').map((token) => token.trim().toLowerCase()).filter((token) => token.startsWith('.'));
  if (narrowed?.length && !narrowed.some((extension) => name.endsWith(extension))) return `Format non accepté ici. Formats attendus : ${narrowed.join(', ')}.`;
  if (hints) {
    const remaining = hints.quota.limit_bytes - hints.quota.used_bytes;
    if (file.size > remaining) return `Espace de stockage insuffisant : il vous reste ${formatFileSize(Math.max(0, remaining))}.`;
  }
  return null;
}

interface UploadState { name: string; loaded: number; total: number }

export default function FileUpload({ purpose, resourceType, resourceId, label, accept, disabled, onUploaded }: FileUploadProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const dragDepth = useRef(0);
  const [hints, setHints] = useState<UploadHints | null>(null);
  const [hintsError, setHintsError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let active = true;
    loadUploadHints().then((value) => { if (active) setHints(value); }).catch((reason) => { if (active) setHintsError(errorMessage(reason)); });
    return () => { active = false; };
  }, []);
  useEffect(() => () => request.current?.abort(), []);

  const policy = hints?.policies.find((item) => item.purpose === purpose);
  const busy = !!upload;
  const blocked = disabled || busy;

  const start = (file: File) => {
    setError(''); setSuccess('');
    const problem = precheck(file, policy, hints, accept);
    if (problem) { setError(problem); return; }
    const body = new FormData();
    // Fields must precede the file part: the server validates them before streaming the content.
    body.append('purpose', purpose);
    if (resourceType && resourceId) { body.append('resource_type', resourceType); body.append('resource_id', resourceId); }
    body.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    xhr.open('POST', '/api/files');
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-Alpha-Client', 'web');
    xhr.setRequestHeader('X-Alpha-Device', deviceId());
    setUpload({ name: file.name, loaded: 0, total: file.size });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) setUpload({ name: file.name, loaded: event.loaded, total: event.total });
    };
    const finish = () => { request.current = null; setUpload(null); if (input.current) input.current.value = ''; };
    xhr.onload = () => {
      finish();
      const payload = xhr.response as (UploadedFile & { error?: string }) | null;
      if (xhr.status === 201 && payload?.id) {
        loadUploadHints(true).then(setHints).catch(() => undefined);
        setSuccess(payload.scan_status === 'pending'
          ? `« ${payload.original_name} » est envoyé. Analyse antivirus en cours…`
          : `« ${payload.original_name} » est envoyé.`);
        onUploaded(payload);
        return;
      }
      setError(payload?.error ?? (xhr.status === 413 ? 'Fichier trop volumineux.' : `L’envoi a échoué (erreur ${xhr.status}).`));
    };
    xhr.onerror = () => { finish(); setError('Connexion interrompue pendant l’envoi. Réessayez.'); };
    xhr.ontimeout = () => { finish(); setError('L’envoi a pris trop de temps. Réessayez.'); };
    xhr.onabort = () => { finish(); setError('Envoi annulé.'); };
    xhr.send(body);
  };

  const pick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > 1) { setError('Déposez un seul fichier à la fois.'); return; }
    start(files[0]);
  };

  const onDragEnter = (event: DragEvent) => {
    if (blocked || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (blocked || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (!blocked) pick(event.dataTransfer.files);
  };

  const percent = upload && upload.total ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0;
  const describedBy = [hintId, error ? errorId : ''].filter(Boolean).join(' ');
  const formats = policy ? policy.kinds.map((kind) => kind.label).join(', ') : '';

  return <div className={`fu ${dragging ? 'fu-dragging' : ''} ${blocked ? 'fu-disabled' : ''}`}
    onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
    <input ref={input} id={inputId} className="fu-input" type="file" disabled={blocked} accept={accept ?? policy?.accept}
      aria-describedby={describedBy} aria-invalid={!!error} onChange={(event) => pick(event.target.files)} />
    {upload
      ? <div className="fu-progress" aria-live="polite">
        <div className="fu-progress-head">
          <span className="fu-name" title={upload.name}>{upload.name}</span>
          <button type="button" className="button button-ghost button-small" onClick={() => request.current?.abort()}><X size={14} aria-hidden="true" />Annuler</button>
        </div>
        <progress max={100} value={percent} aria-label={`Envoi de ${upload.name}`}>{percent} %</progress>
        <span className="fu-meta">{percent < 100 ? `${percent} % · ${formatFileSize(upload.loaded)} sur ${formatFileSize(upload.total)}` : 'Chiffrement et vérification du fichier…'}</span>
      </div>
      : <label htmlFor={inputId} className="fu-zone">
        <UploadCloud size={22} aria-hidden="true" />
        <span className="fu-title">{label ?? 'Ajouter un fichier'}</span>
        <span className="fu-cta"><span className="fu-link">Choisissez un fichier</span> ou glissez-le ici</span>
      </label>}
    <p id={hintId} className="fu-hint">
      {policy
        ? <>Formats : {formats} · {formatFileSize(policy.max_bytes)} maximum{hints?.require_scan || hints?.scanner ? ' · analysé par l’antivirus avant partage' : ''}.</>
        : hintsError ? 'Règles d’envoi indisponibles : le serveur vérifiera le fichier.' : 'Chargement des règles d’envoi…'}
      {hints && <> Espace utilisé : {formatFileSize(hints.quota.used_bytes)} sur {formatFileSize(hints.quota.limit_bytes)}.</>}
    </p>
    {error && <p id={errorId} className="fu-error" role="alert">{error}</p>}
    {success && <p className="fu-success" role="status"><CheckCircle2 size={14} aria-hidden="true" />{success}</p>}
  </div>;
}
