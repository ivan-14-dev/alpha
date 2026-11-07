import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, LoaderCircle, X } from 'lucide-react';
import { api, errorMessage } from '../lib/api';

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</header>;
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Avatar({ name, color = '#6658e8', size = 'normal' }: { name: string; color?: string; size?: 'small' | 'normal' | 'large' }) {
  return <span className={`avatar avatar-${size}`} style={{ backgroundColor: color }} aria-label={name}>{name.split(' ').map((word) => word[0]).slice(0, 2).join('').toUpperCase()}</span>;
}
export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-symbol">✦</div><h3>{title}</h3>{description && <p>{description}</p>}{action}</div>;
}
export function ErrorState({ message }: { message: string }) {
  return message ? <div className="alert alert-error" role="alert">{message}</div> : null;
}
export function Loading() { return <div className="loading" role="status"><LoaderCircle className="spin" size={22} /> Chargement…</div>; }
export function DemoNotice() { return <div className="demo-notice"><span className="status-dot" /> Mode démonstration — aucun argent réel n’est débité ou versé.</div>; }
export function LoginNotice() { return <EmptyState title="Rejoignez le collectif" description="Connectez-vous pour participer et retrouver votre activité." action={<Link className="button button-primary" to="/login">Se connecter <ArrowUpRight size={16} /></Link>} />; }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])];
    focusable()[0]?.focus();
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={dialog} className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Fermer"><X size={20} /></button></div>{children}</section></div>;
}
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    if (!path) { setData(null); setLoading(false); setError(''); return; }
    setLoading(true); setData(null); setError('');
    api<T>(path).then((value) => { if (active) setData(value); }).catch((error) => { if (active) setError(errorMessage(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, revision]);
  return { data, loading, error, reload: () => setRevision((value) => value + 1) };
}
