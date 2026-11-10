import { useState, type FormEvent } from 'react';
import { CheckCircle2, Clock, Gavel, XCircle } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import { capabilityLabels, caseKindLabels, groundLabels, sanctionKindLabels, sanctionTone, type SanctionKind } from './UsersAdmin';
import '../styles/trust.css';

/** Appeals against sanctions (DSA art. 20: human review, reasoned decision) — OWNER: trust module. Data: /api/trust/admin/appeals. */

interface Appeal {
  id: string; status: 'pending' | 'accepted' | 'rejected'; statement: string; decision_note: string; created_at: string; decided_at: string | null;
  user_id: string; user_name: string; user_email: string; reviewer_name: string | null; sla_due_at: string; overdue: boolean; appeals_on_sanction: number;
  sanction: {
    id: string; kind: SanctionKind; kind_label: string; capabilities: string[]; capability_labels: string[]; ground: string; ground_label: string;
    public_reason: string; internal_note: string; starts_at: string; ends_at: string | null; revoked_at: string | null; appealable: boolean;
    automated: boolean; created_by_name: string | null; case: { id: string; kind: string; score: number; summary: string } | null;
  };
}
interface AppealsResponse { appeals: Appeal[]; total: number; limit: number; offset: number; sla_days: number }

const statusLabels: Record<Appeal['status'], string> = { pending: 'En attente', accepted: 'Accepté', rejected: 'Rejeté' };
const statusTone: Record<Appeal['status'], string> = { pending: 'orange', accepted: 'green', rejected: 'red' };
const filters = [
  { value: 'pending', label: 'En attente' }, { value: 'accepted', label: 'Acceptés' }, { value: 'rejected', label: 'Rejetés' }, { value: 'all', label: 'Tous' },
];

function Decision({ appeal, onDone }: { appeal: Appeal; onDone: (message: string) => void }) {
  const [mode, setMode] = useState<'none' | 'accept' | 'reject'>('none');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const length = note.trim().length;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'none') return;
    setPending(true); setError('');
    try {
      await api(`/trust/admin/appeals/${encodeURIComponent(appeal.id)}/${mode}`, { method: 'POST', body: JSON.stringify({ note: note.trim() }) });
      onDone(mode === 'accept' ? `Appel de ${appeal.user_name} accepté : la sanction est levée.` : `Appel de ${appeal.user_name} rejeté : la décision est maintenue.`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  if (mode === 'none') return <div className="tr-actions">
    <button className="button button-primary button-small" type="button" onClick={() => setMode('accept')}><CheckCircle2 size={14} /> Accepter et lever la sanction</button>
    <button className="button button-danger button-small" type="button" onClick={() => setMode('reject')}><XCircle size={14} /> Rejeter</button>
  </div>;
  return <form className="tr-form" onSubmit={submit}>
    <label className="field">{mode === 'accept' ? 'Message au membre (facultatif)' : 'Motivation du rejet (communiquée au membre)'}
      <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} maxLength={2000} minLength={mode === 'reject' ? 10 : undefined}
        required={mode === 'reject'} disabled={pending}
        placeholder={mode === 'accept' ? 'ex. Les éléments fournis lèvent le doute.' : 'Expliquez pourquoi la décision est maintenue, de manière factuelle.'} />
    </label>
    {mode === 'reject' && <span className="tr-counter" data-invalid={length > 0 && length < 10}>{length} / 2000 (10 minimum)</span>}
    <p className="help-text">{mode === 'accept'
      ? 'La sanction est levée immédiatement et le membre est notifié.'
      : 'Le membre est notifié et informé des recours extrajudiciaires et judiciaires.'}</p>
    <ErrorState message={error} />
    <div className="tr-actions">
      <button className={`button button-small ${mode === 'accept' ? 'button-primary' : 'button-danger'}`} type="submit" disabled={pending || (mode === 'reject' && length < 10)}>
        {pending ? 'Envoi…' : mode === 'accept' ? 'Confirmer l’acceptation' : 'Confirmer le rejet'}
      </button>
      <button className="button button-ghost button-small" type="button" onClick={() => { setMode('none'); setError(''); }} disabled={pending}>Annuler</button>
    </div>
  </form>;
}

function AppealCard({ appeal, onDone }: { appeal: Appeal; onDone: (message: string) => void }) {
  const sanction = appeal.sanction;
  return <article className={`tr-card ${appeal.overdue ? 'tr-card-active' : appeal.status === 'pending' ? 'tr-card-warning' : ''}`}>
    <div className="tr-card-head">
      <h3><Gavel size={15} /> {appeal.user_name}<span className="small muted">{appeal.user_email}</span></h3>
      <div className="tr-badges">
        <Badge tone={statusTone[appeal.status]}>{statusLabels[appeal.status]}</Badge>
        <Badge tone="neutral">{appeal.appeals_on_sanction} appel{appeal.appeals_on_sanction > 1 ? 's' : ''} sur cette sanction (2 max)</Badge>
        {appeal.status === 'pending' && <span className={`small ${appeal.overdue ? 'tr-overdue' : 'muted'}`}><Clock size={12} /> {appeal.overdue ? 'Hors délai depuis le' : 'À traiter avant le'} {dateTime(appeal.sla_due_at)}</span>}
      </div>
    </div>
    <div className="tr-detail-section">
      <h3><Badge tone={sanctionTone[sanction.kind]}>{sanctionKindLabels[sanction.kind] ?? sanction.kind_label}</Badge>{groundLabels[sanction.ground] ?? sanction.ground_label}</h3>
      {sanction.kind === 'restriction' && sanction.capabilities.length > 0 && <ul className="tr-chips">
        {sanction.capabilities.map((capability) => <li key={capability} className="tr-chip-danger">{capabilityLabels[capability] ?? capability}</li>)}
      </ul>}
      <p className="tr-quote">{sanction.public_reason}</p>
      {sanction.internal_note && <p className="tr-quote tr-internal">{sanction.internal_note}</p>}
      <p className="tr-card-meta">
        Du {dateTime(sanction.starts_at)} {sanction.ends_at ? `au ${dateTime(sanction.ends_at)}` : '— sans date de fin'} · décidée par {sanction.created_by_name ?? 'le système (mesure automatique)'}
        {sanction.revoked_at && ` · levée le ${dateTime(sanction.revoked_at)}`}
      </p>
      {sanction.case && <p className="small muted">Dossier lié : {caseKindLabels[sanction.case.kind] ?? sanction.case.kind} (score {sanction.case.score}) — {sanction.case.summary}</p>}
    </div>
    <div>
      <p className="small muted">Contestation déposée le {dateTime(appeal.created_at)} :</p>
      <p className="tr-quote">{appeal.statement}</p>
    </div>
    {appeal.status !== 'pending' && <p className="small">
      <strong>Décision{appeal.reviewer_name ? ` de ${appeal.reviewer_name}` : ''}{appeal.decided_at ? ` le ${dateTime(appeal.decided_at)}` : ''} :</strong> {appeal.decision_note}
    </p>}
    {appeal.status === 'pending' && <Decision appeal={appeal} onDone={onDone} />}
  </article>;
}

const PAGE = 20;

export default function AppealsAdmin() {
  const [status, setStatus] = useState('pending');
  const [offset, setOffset] = useState(0);
  const [notice, setNotice] = useState('');
  const appeals = useApi<AppealsResponse>(`/trust/admin/appeals?status=${status}&limit=${PAGE}&offset=${offset}`);
  const done = (message: string) => { setNotice(message); appeals.reload(); };

  return <div className="tr-page">
    <p className="tr-notice"><Gavel size={16} />
      Chaque appel doit être examiné par une personne qui n’a pas pris la décision initiale, sans s’appuyer uniquement sur des moyens automatisés (DSA, art. 20).
      {appeals.data ? ` Délai de traitement affiché aux membres : ${appeals.data.sla_days} jours.` : ''}
    </p>
    <div className="tabs" role="tablist" aria-label="Statut des appels">
      {filters.map((item) => <button key={item.value} type="button" role="tab" aria-selected={status === item.value} className={`tab ${status === item.value ? 'active' : ''}`}
        onClick={() => { setStatus(item.value); setOffset(0); setNotice(''); }}>{item.label}</button>)}
    </div>
    {notice && <p className="alert alert-success" role="status">{notice}</p>}
    {appeals.loading ? <Loading /> : appeals.error ? <ErrorState message={appeals.error} /> : appeals.data?.appeals.length ? <>
      <div className="tr-cards">{appeals.data.appeals.map((appeal) => <AppealCard key={appeal.id} appeal={appeal} onDone={done} />)}</div>
      <div className="tr-pager">
        <span>{appeals.data.offset + 1}–{appeals.data.offset + appeals.data.appeals.length} sur {appeals.data.total}</span>
        <span className="tr-actions">
          <button className="button button-secondary button-small" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
          <button className="button button-secondary button-small" type="button" disabled={offset + appeals.data.appeals.length >= appeals.data.total} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
        </span>
      </div>
    </> : <EmptyState title={status === 'pending' ? 'Aucun appel en attente' : 'Aucun appel'} description="Les contestations des membres apparaîtront ici." />}
  </div>;
}
