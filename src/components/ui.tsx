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
