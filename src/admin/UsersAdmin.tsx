import { useState, type FormEvent, type ReactNode } from 'react';
import { Ban, FilePlus2, Fingerprint, Gavel, KeyRound, LogOut, Search, ShieldAlert, UserCog } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, Modal, useApi } from '../components/ui';
import { api, date, dateTime, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import '../styles/trust.css';

/** Members administration (roles, sanctions, sessions, risk) — OWNER: trust module. Data: /api/trust/admin/*. */

export type RiskLevel = 'low' | 'medium' | 'high';
export type SanctionKind = 'warning' | 'restriction' | 'suspension' | 'ban';
export const restrictableCapabilities = ['publish', 'message', 'trade', 'money', 'withdraw', 'review', 'test'] as const;
export type RestrictableCapability = typeof restrictableCapabilities[number];

export const capabilityLabels: Record<string, string> = {
  login: 'Connexion',
  publish: 'Publication (projets, communauté, fichiers)',
  message: 'Messagerie',
  trade: 'Marketplace (achats et ventes)',
  money: 'Paiements',
  withdraw: 'Retraits',
  review: 'Avis',
  test: 'Missions de test et bac à sable',
};
export const sanctionKindLabels: Record<SanctionKind, string> = {
  warning: 'Avertissement', restriction: 'Restriction', suspension: 'Suspension', ban: 'Bannissement',
};
export const sanctionTone: Record<SanctionKind, string> = { warning: 'blue', restriction: 'orange', suspension: 'red', ban: 'red' };
/** Mirrors the server grounds (DSA art. 17(3)(d)-(e)). */
export const groundLabels: Record<string, string> = {
  'terms.fraud': 'Fraude ou tentative de fraude',
  'terms.multi_account': 'Comptes multiples ou usurpation',
  'terms.fake_reviews': 'Avis non authentiques',
  'terms.self_dealing': 'Transactions fictives ou avec soi-même',
  'terms.payment_abuse': 'Abus des moyens de paiement',
  'terms.harassment': 'Harcèlement ou comportement abusif',
  'terms.spam': 'Spam ou sollicitations abusives',
  'terms.security': 'Sécurité du compte — mesure conservatoire',
  'terms.other': 'Autre manquement aux conditions',
  'law.illegal_content': 'Contenu ou activité illicite',
};
export const caseKindLabels: Record<string, string> = {
  multi_account: 'Comptes multiples', collusion: 'Collusion', review_ring: 'Cercle d’avis', velocity: 'Vélocité anormale',
  payment_fraud: 'Fraude au paiement', self_dealing: 'Auto-transaction', manual: 'Dossier manuel',
};
export const caseStatusLabels: Record<string, string> = { open: 'Ouvert', reviewing: 'En examen', actioned: 'Sanctionné', dismissed: 'Classé' };
export const riskLabels: Record<RiskLevel, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé' };
const statusLabels: Record<string, string> = { active: 'Actif', warned: 'Averti', restricted: 'Restreint', suspended: 'Suspendu', banned: 'Banni' };
const statusTone: Record<string, string> = { active: 'green', warned: 'blue', restricted: 'orange', suspended: 'red', banned: 'red' };
const signalLabels: Record<string, string> = {
  register: 'Inscription', login: 'Connexion', login_failed: 'Échec de connexion', oauth_login: 'Connexion OAuth', password_reset: 'Réinitialisation du mot de passe',
  mfa_failed: 'Échec MFA', payment: 'Paiement', payment_failed: 'Paiement refusé', withdrawal: 'Retrait', review: 'Avis', payout: 'Versement reçu',
  listing: 'Annonce', message: 'Message', mission: 'Mission', order: 'Commande',
};
export const signalLabel = (kind: string) => signalLabels[kind] ?? kind;

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={`tr-risk tr-risk-${level}`}>Risque {riskLabels[level].toLowerCase()}</span>;
}

export function ScoreMeter({ score }: { score: number }) {
  const level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
  return <div className="tr-score" title={`Score ${score}/100`}>
    <div className="tr-score-bar" data-level={level} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="Score de risque">
      <span style={{ width: `${score}%` }} />
    </div>
    <strong>{score}</strong>
  </div>;
}

const evidenceLabels: Record<string, string> = {
  pattern: 'Motif détecté', device_hash: 'Empreinte d’appareil', ip_hash: 'Empreinte réseau', accounts: 'Comptes concernés',
  first_seen: 'Première occurrence', last_seen: 'Dernière occurrence', window_days: 'Fenêtre (jours)', window_hours: 'Fenêtre (heures)',
  owner_id: 'Propriétaire de campagne', tester_id: 'Testeur', paid_missions: 'Missions payées', mission_ids: 'Missions', last_paid: 'Dernier versement',
  shared_devices: 'Appareils partagés', shared_ips: 'Réseaux partagés', seller_id: 'Vendeur', buyer_id: 'Acheteur', orders: 'Commandes',
  order_ids: 'Commandes', last_order: 'Dernière commande', members: 'Membres du groupe', reciprocal_pairs: 'Paires réciproques',
  new_accounts: 'Comptes récents', review_ids: 'Avis', reviews: 'Avis', authors: 'Auteurs distincts', first_at: 'Début', last_at: 'Fin',
  attempts: 'Tentatives', sources: 'Sources distinctes', withdrawals: 'Retraits', failures: 'Échecs', opened_by_admin: 'Ouvert par un administrateur',
};
const patternLabels: Record<string, string> = {
  shared_device: 'Appareil partagé entre comptes', ip_registrations: 'Inscriptions en série depuis un même réseau',
  owner_tester: 'Propriétaire et testeur liés', buyer_seller: 'Acheteur et vendeur liés', reciprocal: 'Avis positifs réciproques',
  burst: 'Rafale d’avis de comptes récents', failed_auth: 'Échecs de connexion répétés', withdrawal_after_funding: 'Retrait juste après un financement',
  payment_failures: 'Échecs de paiement répétés',
};
const isoLike = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function evidenceValue(key: string, value: unknown): ReactNode {
  if (Array.isArray(value)) {
    if (!value.length) return '—';
    const shown = value.slice(0, 20).map((item, index) => <code key={index}>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</code>);
    return value.length > 20 ? <>{shown}<span className="small muted">+{value.length - 20}</span></> : shown;
  }
  if (value && typeof value === 'object') return <code>{JSON.stringify(value)}</code>;
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (key === 'pattern' && typeof value === 'string') return patternLabels[value] ?? value;
  if (typeof value === 'string' && isoLike.test(value)) return dateTime(value);
  if (typeof value === 'string' && /(_id|_hash)$/.test(key)) return <code>{value}</code>;
  return String(value ?? '—');
}

/** Evidence only contains hash prefixes, resource ids and counts (never raw IPs or device identifiers). */
export function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence);
  if (!entries.length) return <p className="small muted">Aucun élément de preuve structuré.</p>;
  return <dl className="tr-evidence">{entries.map(([key, value]) => <div key={key} style={{ display: 'contents' }}>
    <dt>{evidenceLabels[key] ?? key.replace(/_/g, ' ')}</dt><dd>{evidenceValue(key, value)}</dd>
  </div>)}</dl>;
}

const durations = [
  { value: 'none', label: 'Sans date de fin' }, { value: '1', label: '24 heures' }, { value: '3', label: '3 jours' }, { value: '7', label: '7 jours' },
  { value: '14', label: '14 jours' }, { value: '30', label: '30 jours' }, { value: '90', label: '90 jours' }, { value: '365', label: '1 an' },
  { value: 'custom', label: 'Date précise…' },
];
const feminine = (kind: SanctionKind) => kind === 'restriction' || kind === 'suspension';

export interface CaseSubject { user_id: string; name: string; user_role?: string; role?: string }

/** Shared sanction form (member detail and risk case decision). The server re-validates every rule. */
export function SanctionForm({ endpoint, targetIsAdmin = false, subjects, onDone, submitLabel = 'Appliquer la sanction', caseNote = false }: {
  endpoint: string; targetIsAdmin?: boolean; subjects?: CaseSubject[]; onDone: (message: string) => void; submitLabel?: string; caseNote?: boolean;
}) {
  const [kind, setKind] = useState<SanctionKind>('warning');
  const [capabilities, setCapabilities] = useState<RestrictableCapability[]>([]);
  const [ground, setGround] = useState('terms.other');
  const [reason, setReason] = useState('');
  const [internal, setInternal] = useState('');
  const [duration, setDuration] = useState('7');
  const [customEnd, setCustomEnd] = useState('');
  const [appealable, setAppealable] = useState(true);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [subject, setSubject] = useState(subjects?.find((item) => item.role === 'primary')?.user_id ?? subjects?.[0]?.user_id ?? '');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const adminTarget = subjects ? subjects.find((item) => item.user_id === subject)?.user_role === 'admin' : targetIsAdmin;
  const reasonLength = reason.trim().length;

  function toggle(capability: RestrictableCapability) {
    setCapabilities((current) => current.includes(capability) ? current.filter((item) => item !== capability) : [...current, capability]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError('');
    if (kind === 'restriction' && !capabilities.length) { setError('Choisissez au moins une capacité à restreindre.'); return; }
    if (duration === 'custom' && !customEnd) { setError('Indiquez la date de fin.'); return; }
    if (kind === 'ban' && !appealable && !window.confirm('Un bannissement non contestable empêche toute connexion. Confirmer ?')) return;
    setPending(true);
    try {
      const body: Record<string, unknown> = {
        kind, capabilities: kind === 'restriction' ? capabilities : [], ground, public_reason: reason.trim(), internal_note: internal.trim(),
        appealable: kind === 'ban' ? appealable : true, confirm_admin: adminTarget && confirmAdmin,
      };
      if (duration === 'custom') body.ends_at = new Date(customEnd).toISOString();
      else if (duration !== 'none') body.duration_days = Number(duration);
      if (subjects) { body.user_id = subject; body.note = note.trim(); }
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      setReason(''); setInternal(''); setNote(''); setConfirmAdmin(false);
      onDone(`${sanctionKindLabels[kind]} appliqué${feminine(kind) ? 'e' : ''} et notifié${feminine(kind) ? 'e' : ''} au membre.`);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  return <form className="tr-form" onSubmit={submit}>
    {subjects && <label className="field">Membre visé<select value={subject} onChange={(event) => setSubject(event.target.value)} disabled={pending}>
      {subjects.map((item) => <option key={item.user_id} value={item.user_id}>
        {item.name}{item.role === 'primary' ? ' (sujet principal)' : ''}{item.user_role === 'admin' ? ' — administrateur' : ''}
      </option>)}
    </select></label>}
    <div className="form-grid">
      <label className="field">Mesure<select value={kind} onChange={(event) => setKind(event.target.value as SanctionKind)} disabled={pending}>
        {(Object.keys(sanctionKindLabels) as SanctionKind[]).map((value) => <option key={value} value={value}>{sanctionKindLabels[value]}</option>)}
      </select></label>
      <label className="field">Fondement<select value={ground} onChange={(event) => setGround(event.target.value)} disabled={pending}>
        {Object.entries(groundLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
    </div>
    {kind === 'restriction' && <fieldset>
      <legend>Capacités restreintes</legend>
      <div className="tr-checks">{restrictableCapabilities.map((capability) => <label key={capability} className="tr-check">
        <input type="checkbox" checked={capabilities.includes(capability)} onChange={() => toggle(capability)} disabled={pending} />{capabilityLabels[capability]}
      </label>)}</div>
    </fieldset>}
    {(kind === 'suspension' || kind === 'ban') && <p className="tr-notice tr-notice-warning"><ShieldAlert size={16} />
      {kind === 'ban'
        ? 'Le bannissement bloque toutes les actions et révoque immédiatement toutes les sessions du membre.'
        : 'La suspension bloque toutes les actions ; le membre peut encore se connecter pour lire la décision et la contester.'}
    </p>}
    <label className="field">Motif communiqué au membre (exposé des motifs)
      <textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={10} maxLength={2000} rows={3} disabled={pending}
        placeholder="Faits reprochés, de façon factuelle et compréhensible. Ne citez pas d’autres membres." />
    </label>
    <span className="tr-counter" data-invalid={reasonLength > 0 && reasonLength < 10}>{reasonLength} / 2000 (10 minimum)</span>
    <label className="field">Note interne (jamais communiquée)
      <textarea value={internal} onChange={(event) => setInternal(event.target.value)} maxLength={4000} rows={2} disabled={pending} />
    </label>
    <div className="form-grid">
      <label className="field">Durée<select value={duration} onChange={(event) => setDuration(event.target.value)} disabled={pending}>
        {durations.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      {duration === 'custom' && <label className="field">Fin de la mesure
        <input type="datetime-local" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} required disabled={pending} />
      </label>}
    </div>
    {kind === 'ban' && <label className="tr-check"><input type="checkbox" checked={appealable} onChange={(event) => setAppealable(event.target.checked)} disabled={pending} />
      Contestable (décochez uniquement pour une fraude avérée : la connexion sera alors bloquée)</label>}
    {adminTarget && <label className="tr-check"><input type="checkbox" checked={confirmAdmin} onChange={(event) => setConfirmAdmin(event.target.checked)} disabled={pending} required />
      Je confirme sanctionner un autre administrateur.</label>}
    {caseNote && <label className="field">Conclusion du dossier (interne)
      <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} rows={2} disabled={pending} />
    </label>}
    <ErrorState message={error} />
    <div className="tr-actions"><button className="button button-primary" type="submit" disabled={pending || reasonLength < 10}>
      <Gavel size={15} /> {pending ? 'Application…' : submitLabel}
    </button></div>
  </form>;
}

interface UserRow {
  id: string; name: string; email: string; role: 'member' | 'admin'; avatar_color: string; created_at: string;
  email_verified: boolean; sanctions_count: number; status: string; risk_level: RiskLevel;
}
interface UsersResponse { users: UserRow[]; total: number; limit: number; offset: number; has_more: boolean }
export interface SanctionView {
  id: string; kind: SanctionKind; kind_label: string; capabilities: string[]; ground: string; public_reason: string; internal_note: string;
  starts_at: string; ends_at: string | null; appealable: boolean; automated: boolean; case_id: string | null; revoked_at: string | null;
  revoked_reason: string; created_by_name?: string | null; revoked_by_name?: string | null; active?: boolean; created_at: string;
}
interface CaseView {
  id: string; kind: string; score: number; status: string; summary: string; evidence: Record<string, unknown>; subject_role: string;
  created_at: string; last_detected_at: string; detections: number;
}
interface AppealView {
  id: string; sanction_id: string; status: string; statement: string; decision_note: string; created_at: string; decided_at: string | null; reviewer_name: string | null;
}
interface Detail {
  user: { id: string; name: string; email: string; title: string; role: 'member' | 'admin'; avatar_color: string; created_at: string; email_verified: boolean };
  risk_level: RiskLevel; active_sessions: number; appeal_sla_days: number;
  signals: {
    by_kind: { kind: string; total: number; last_30_days: number; last_at: string }[];
    hashes: { devices: number; ips: number; user_agents: number; first_at: string | null; last_at: string | null } | null;
    linked_accounts: { user_id: string; name: string; role: string; via: string[]; hashes: string[]; last_seen: string }[];
  };
  cases: CaseView[]; sanctions: (SanctionView & { active: boolean })[]; appeals: AppealView[];
}

function RevokeSanction({ sanction, onDone }: { sanction: SanctionView; onDone: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError('');
    try {
      await api(`/trust/admin/sanctions/${encodeURIComponent(sanction.id)}/revoke`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      setOpen(false); setReason('');
      onDone('Sanction levée et membre notifié.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  if (!open) return <div className="tr-actions"><button className="button button-secondary button-small" type="button" onClick={() => setOpen(true)}>Lever la sanction</button></div>;
  return <form className="tr-form" onSubmit={submit}>
    <label className="field">Motif de la levée (communiqué au membre)
      <textarea value={reason} onChange={(event) => setReason(event.target.value)} required minLength={10} maxLength={2000} rows={2} disabled={pending} />
    </label>
    <ErrorState message={error} />
    <div className="tr-actions">
      <button className="button button-primary button-small" type="submit" disabled={pending || reason.trim().length < 10}>Confirmer la levée</button>
      <button className="button button-ghost button-small" type="button" onClick={() => setOpen(false)} disabled={pending}>Annuler</button>
    </div>
  </form>;
}

export function SanctionCard({ sanction, onDone }: { sanction: SanctionView; onDone?: (message: string) => void }) {
  const active = sanction.active ?? (!sanction.revoked_at && (!sanction.ends_at || Date.parse(sanction.ends_at) > Date.now()));
  return <article className={`tr-card ${active ? 'tr-card-active' : ''}`}>
    <div className="tr-card-head">
      <h3><Badge tone={sanctionTone[sanction.kind]}>{sanctionKindLabels[sanction.kind]}</Badge>{groundLabels[sanction.ground] ?? sanction.ground}</h3>
      <div className="tr-badges">
        {active ? <Badge tone="red">En vigueur</Badge> : sanction.revoked_at ? <Badge tone="neutral">Levée</Badge> : <Badge tone="neutral">Expirée</Badge>}
        {sanction.automated && <Badge tone="purple">Mesure automatique</Badge>}
        {!sanction.appealable && <Badge tone="red">Non contestable</Badge>}
      </div>
    </div>
    {sanction.kind === 'restriction' && sanction.capabilities.length > 0 && <ul className="tr-chips">
      {sanction.capabilities.map((capability) => <li key={capability} className="tr-chip-danger">{capabilityLabels[capability] ?? capability}</li>)}
    </ul>}
    <p className="tr-quote">{sanction.public_reason}</p>
    {sanction.internal_note && <p className="tr-quote tr-internal">{sanction.internal_note}</p>}
    <p className="tr-card-meta">
      Du {dateTime(sanction.starts_at)} {sanction.ends_at ? `au ${dateTime(sanction.ends_at)}` : '— sans date de fin'}
      {sanction.created_by_name !== undefined && <> · par {sanction.created_by_name ?? 'le système'}</>}
      {sanction.revoked_at && <> · levée le {dateTime(sanction.revoked_at)}{sanction.revoked_by_name ? ` par ${sanction.revoked_by_name}` : ''} : {sanction.revoked_reason}</>}
    </p>
    {active && onDone && <RevokeSanction sanction={sanction} onDone={onDone} />}
  </article>;
}

function RoleForm({ detail, self, onDone }: { detail: Detail; self: boolean; onDone: (message: string) => void }) {
  const [role, setRole] = useState(detail.user.role);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (role === detail.user.role) return;
    if (role === 'admin' && !window.confirm(`Accorder les droits d’administration à ${detail.user.name} ?`)) return;
    setPending(true); setError('');
    try {
      await api(`/trust/admin/users/${encodeURIComponent(detail.user.id)}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      onDone(role === 'admin' ? 'Droits d’administration accordés.' : 'Droits d’administration retirés.');
    } catch (failure) { setError(errorMessage(failure)); setRole(detail.user.role); }
    finally { setPending(false); }
  }
  return <form className="tr-form" onSubmit={submit}>
    <div className="tr-toolbar">
      <label className="field tr-grow">Rôle<select value={role} onChange={(event) => setRole(event.target.value as typeof role)} disabled={pending || self}>
        <option value="member">Membre</option><option value="admin">Administrateur</option>
      </select></label>
      <button className="button button-secondary" type="submit" disabled={pending || self || role === detail.user.role}><UserCog size={15} /> Modifier</button>
    </div>
    {self && <p className="help-text">Vous ne pouvez pas modifier votre propre rôle.</p>}
    <ErrorState message={error} />
  </form>;
}

function ManualCase({ userId, onDone }: { userId: string; onDone: (message: string) => void }) {
  const [summary, setSummary] = useState('');
  const [score, setScore] = useState(50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true); setError('');
    try {
      await api(`/trust/admin/users/${encodeURIComponent(userId)}/cases`, { method: 'POST', body: JSON.stringify({ summary: summary.trim(), score }) });
      setSummary('');
      onDone('Dossier manuel ouvert et assigné à vous.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <details className="tr-history"><summary>Ouvrir un dossier manuel</summary><form className="tr-form" onSubmit={submit}>
    <label className="field">Résumé du soupçon (interne)
      <textarea value={summary} onChange={(event) => setSummary(event.target.value)} required minLength={10} maxLength={500} rows={2} disabled={pending} />
    </label>
    <div className="tr-toolbar">
      <label className="field">Score initial
        <input type="number" min={0} max={100} value={score} onChange={(event) => setScore(Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))))} disabled={pending} />
      </label>
      <button className="button button-secondary" type="submit" disabled={pending || summary.trim().length < 10}><FilePlus2 size={15} /> Ouvrir le dossier</button>
    </div>
    <ErrorState message={error} />
  </form></details>;
}

const appealStatusLabels: Record<string, string> = { pending: 'En attente', accepted: 'Accepté', rejected: 'Rejeté' };

function UserDetail({ userId, onClose, onChanged }: { userId: string; onClose: () => void; onChanged: () => void }) {
  const { user: me } = useAuth();
  const detail = useApi<Detail>(`/trust/admin/users/${encodeURIComponent(userId)}`);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const done = (message: string) => { setNotice(message); setError(''); detail.reload(); onChanged(); };
  async function revokeSessions() {
    if (!window.confirm('Déconnecter ce membre de tous ses appareils ?')) return;
    try {
      const result = await api<{ revoked: number }>(`/trust/admin/users/${encodeURIComponent(userId)}/sessions/revoke`, { method: 'POST' });
      done(result.revoked > 1 ? `${result.revoked} sessions révoquées.` : `${result.revoked} session révoquée.`);
    } catch (failure) { setError(errorMessage(failure)); }
  }
  const data = detail.data;
  const self = me?.id === userId;
  return <Modal title={data ? `Membre — ${data.user.name}` : 'Fiche membre'} onClose={onClose}>
    {notice && <p className="alert alert-success" role="status">{notice}</p>}
    <ErrorState message={error} />
    {detail.loading ? <Loading /> : detail.error ? <ErrorState message={detail.error} /> : data && <div className="tr-detail">
      <div className="tr-card-head">
        <div className="tr-user"><Avatar name={data.user.name} color={data.user.avatar_color} />
          <div><strong>{data.user.name}</strong><small>{data.user.email}</small>{data.user.title && <small>{data.user.title}</small>}</div></div>
        <div className="tr-badges"><RiskBadge level={data.risk_level} />{data.user.role === 'admin' && <Badge tone="purple">Administrateur</Badge>}
          <Badge tone={data.user.email_verified ? 'green' : 'neutral'}>{data.user.email_verified ? 'E-mail vérifié' : 'E-mail non vérifié'}</Badge></div>
      </div>
      <dl className="tr-dl">
        <dt>Inscription</dt><dd>{date(data.user.created_at)}</dd>
        <dt>Sessions actives</dt><dd>{data.active_sessions}</dd>
        <dt>Identifiant</dt><dd className="tr-mono">{data.user.id}</dd>
      </dl>

      <div className="tr-detail-grid">
        <section className="tr-detail-section"><h3><UserCog size={15} /> Rôle</h3><RoleForm key={data.user.role} detail={data} self={self} onDone={done} /></section>
        <section className="tr-detail-section"><h3><LogOut size={15} /> Sessions</h3>
          <p className="small muted">Déconnecte immédiatement tous les appareils (automatique en cas de bannissement).</p>
          <div className="tr-actions"><button className="button button-secondary" type="button" onClick={() => void revokeSessions()} disabled={!data.active_sessions || self}>
            <KeyRound size={15} /> Révoquer les sessions
          </button></div>
        </section>
      </div>

      <section className="tr-detail-section"><h3><Fingerprint size={15} /> Signaux (empreintes chiffrées uniquement)</h3>
        {data.signals.hashes && <dl className="tr-dl">
          <dt>Appareils distincts</dt><dd>{data.signals.hashes.devices}</dd>
          <dt>Réseaux publics distincts</dt><dd>{data.signals.hashes.ips}</dd>
          <dt>Navigateurs distincts</dt><dd>{data.signals.hashes.user_agents}</dd>
          <dt>Période</dt><dd>{data.signals.hashes.first_at && data.signals.hashes.last_at
            ? `${dateTime(data.signals.hashes.first_at)} → ${dateTime(data.signals.hashes.last_at)}` : 'Aucun signal conservé'}</dd>
        </dl>}
        {data.signals.by_kind.length > 0 && <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Type</th><th>Total</th><th>30 jours</th><th>Dernier</th></tr></thead>
          <tbody>{data.signals.by_kind.map((row) => <tr key={row.kind}>
            <td>{signalLabel(row.kind)}</td><td className="tr-num">{row.total}</td><td className="tr-num">{row.last_30_days}</td><td>{dateTime(row.last_at)}</td>
          </tr>)}</tbody>
        </table></div>}
        <h3>Comptes liés (appareil ou réseau public partagé)</h3>
        {data.signals.linked_accounts.length ? <ul className="tr-list">{data.signals.linked_accounts.map((account) => <li key={account.user_id}>
          <span><strong>{account.name}</strong> {account.role === 'admin' && <Badge tone="purple">Admin</Badge>}<br /><span className="tr-mono">{account.hashes.join(' · ')}</span></span>
          <span className="tr-badges">
            {account.via.map((via) => <Badge key={via} tone={via === 'device' ? 'red' : 'orange'}>{via === 'device' ? 'Même appareil' : 'Même réseau'}</Badge>)}
            <span className="small muted">{dateTime(account.last_seen)}</span>
          </span>
        </li>)}</ul> : <p className="small muted">Aucun compte ne partage ces empreintes.</p>}
        <p className="help-text">Un réseau partagé (entreprise, VPN, opérateur mobile) n’est pas en soi un indice de fraude : croisez toujours plusieurs éléments.</p>
      </section>

      <section className="tr-detail-section"><h3><ShieldAlert size={15} /> Dossiers de risque</h3>
        {data.cases.length ? <div className="tr-cards">{data.cases.map((item) => <article key={item.id} className="tr-card">
          <div className="tr-card-head">
            <h3>{caseKindLabels[item.kind] ?? item.kind}<Badge tone={['open', 'reviewing'].includes(item.status) ? 'orange' : 'neutral'}>{caseStatusLabels[item.status] ?? item.status}</Badge></h3>
            <ScoreMeter score={item.score} />
          </div>
          <p className="small">{item.summary}</p>
          <p className="tr-card-meta">{item.subject_role === 'primary' ? 'Sujet principal' : 'Compte lié'} · ouvert le {dateTime(item.created_at)} · {item.detections} détection{item.detections > 1 ? 's' : ''}</p>
        </article>)}</div> : <p className="small muted">Aucun dossier.</p>}
        <ManualCase userId={data.user.id} onDone={done} />
      </section>

      <section className="tr-detail-section"><h3><Ban size={15} /> Sanctions</h3>
        {data.sanctions.length ? <div className="tr-cards">{data.sanctions.map((sanction) => <SanctionCard key={sanction.id} sanction={sanction} onDone={done} />)}</div>
          : <p className="small muted">Aucune sanction.</p>}
        {self ? <p className="help-text">Vous ne pouvez pas vous sanctionner vous-même.</p>
          : <details className="tr-history"><summary>Nouvelle sanction</summary>
            <SanctionForm endpoint={`/trust/admin/users/${encodeURIComponent(data.user.id)}/sanctions`} targetIsAdmin={data.user.role === 'admin'} onDone={done} />
          </details>}
      </section>

      <section className="tr-detail-section"><h3><Gavel size={15} /> Appels</h3>
        {data.appeals.length ? <ul className="tr-timeline">{data.appeals.map((appeal) => <li key={appeal.id}>
          <strong>{appealStatusLabels[appeal.status] ?? appeal.status}</strong> · {dateTime(appeal.created_at)}
          <p className="tr-quote">{appeal.statement}</p>
          {appeal.decision_note && <p className="small muted">Décision{appeal.reviewer_name ? ` de ${appeal.reviewer_name}` : ''} : {appeal.decision_note}</p>}
        </li>)}</ul> : <p className="small muted">Aucun appel.</p>}
      </section>
    </div>}
  </Modal>;
}

const PAGE = 25;

export default function UsersAdmin() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [risk, setRisk] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (query) params.set('q', query);
  if (role) params.set('role', role);
  if (status) params.set('status', status);
  if (risk) params.set('risk', risk);
  const users = useApi<UsersResponse>(`/trust/admin/users?${params}`);
  const filter = (setter: (value: string) => void) => (value: string) => { setter(value); setOffset(0); };

  return <div className="tr-page">
    <form className="tr-toolbar" role="search" onSubmit={(event) => { event.preventDefault(); setQuery(draft.trim()); setOffset(0); }}>
      <label className="field tr-grow">Rechercher (nom ou e-mail)
        <input type="search" value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={100} placeholder="ex. Camille ou camille@exemple.fr" />
      </label>
      <label className="field">Rôle<select value={role} onChange={(event) => filter(setRole)(event.target.value)}>
        <option value="">Tous</option><option value="member">Membres</option><option value="admin">Administrateurs</option>
      </select></label>
      <label className="field">Statut<select value={status} onChange={(event) => filter(setStatus)(event.target.value)}>
        <option value="">Tous</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="field">Risque<select value={risk} onChange={(event) => filter(setRisk)(event.target.value)}>
        <option value="">Tous</option>{Object.entries(riskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button className="button button-primary" type="submit"><Search size={15} /> Rechercher</button>
    </form>
    <section className="card">
      {users.loading ? <Loading /> : users.error ? <div className="card-body"><ErrorState message={users.error} /></div> : users.data?.users.length ? <>
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Membre</th><th>Rôle</th><th>Statut</th><th>Risque</th><th>E-mail</th><th>Sanctions</th><th>Inscription</th><th><span className="tr-sr-only">Actions</span></th></tr></thead>
          <tbody>{users.data.users.map((row) => <tr key={row.id}>
            <td><div className="tr-user"><Avatar name={row.name} color={row.avatar_color} size="small" /><div><strong>{row.name}</strong><small>{row.email}</small></div></div></td>
            <td>{row.role === 'admin' ? <Badge tone="purple">Admin</Badge> : 'Membre'}</td>
            <td><Badge tone={statusTone[row.status] ?? 'neutral'}>{statusLabels[row.status] ?? row.status}</Badge></td>
            <td><RiskBadge level={row.risk_level} /></td>
            <td>{row.email_verified ? <Badge tone="green">Vérifié</Badge> : <Badge tone="neutral">Non vérifié</Badge>}</td>
            <td className="tr-num">{row.sanctions_count}</td>
            <td>{date(row.created_at)}</td>
            <td><button className="button button-secondary button-small" type="button" onClick={() => setSelected(row.id)} aria-label={`Ouvrir la fiche de ${row.name}`}>Ouvrir</button></td>
          </tr>)}</tbody>
        </table></div>
        <div className="tr-pager card-body">
          <span>{users.data.offset + 1}–{users.data.offset + users.data.users.length} sur {users.data.total}</span>
          <span className="tr-actions">
            <button className="button button-secondary button-small" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
            <button className="button button-secondary button-small" type="button" disabled={!users.data.has_more} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
          </span>
        </div>
      </> : <div className="card-body"><EmptyState title="Aucun membre" description="Aucun compte ne correspond à ces critères." /></div>}
    </section>
    {selected && <UserDetail userId={selected} onClose={() => setSelected(null)} onChanged={users.reload} />}
  </div>;
}
