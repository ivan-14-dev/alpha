import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Download, FileCheck2, History, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { ApiError, api, date, dateTime, errorMessage } from '../lib/api';
import { Badge, ErrorState, Loading, useApi } from './ui';
import '../styles/privacy.css';

/** Settings › Données personnelles (export, consents, legal acceptances, account deletion). OWNER: privacy module. */

type RequestStatus = 'pending' | 'processing' | 'ready' | 'scheduled' | 'completed' | 'cancelled' | 'rejected';
interface PrivacyRequest {
  id: string; kind: 'export' | 'erasure'; status: RequestStatus; requested_at: string; scheduled_for: string | null;
  processed_at: string | null; expires_at: string | null; downloaded_at: string | null; download_count: number;
  rejection_reason: string; download_url: string | null;
}
interface Consent { purpose: string; label: string; description: string; granted: boolean; policy_version: string | null; updated_at: string | null; outdated: boolean }
interface ConsentEvent { id: string; purpose: string; granted: boolean; policy_version: string; source: string; created_at: string }
interface ConsentState { policy_version: string; consents: Consent[]; history: ConsentEvent[] }
interface Blocker { code: string; message: string }
interface ErasureState {
  request: PrivacyRequest | null; blockers: Blocker[]; requires_password: boolean; recent_login: boolean;
  fresh_login_minutes: number; grace_days: number;
}
interface Acceptance { document: string; version: string; accepted_at: string; current: boolean; title: string }
interface LegalSummary { slug: string; title: string; version: string; required: boolean; acceptable: boolean; url: string; accepted_at: string | null; pending: boolean }
type Notice = { tone: 'success' | 'error'; message: string } | null;

const statusLabels: Record<RequestStatus, string> = {
  pending: 'En préparation', processing: 'En préparation', ready: 'Prêt', scheduled: 'Programmée',
  completed: 'Terminée', cancelled: 'Annulée', rejected: 'Refusée',
};
const statusTones: Record<RequestStatus, string> = {
  pending: 'blue', processing: 'blue', ready: 'green', scheduled: 'orange', completed: 'neutral', cancelled: 'neutral', rejected: 'red',
};
const sourceLabels: Record<string, string> = { settings: 'Paramètres', registration: 'Inscription', admin: 'Administration', erasure: 'Suppression du compte', api: 'API' };

function NoticeLine({ notice }: { notice: Notice }) {
  return <div aria-live="polite">{notice && (notice.tone === 'success'
    ? <p className="alert alert-success" role="status">{notice.message}</p>
    : <ErrorState message={notice.message} />)}</div>;
}

function ExportPanel() {
  const { data, loading, error, reload } = useApi<{ requests: PrivacyRequest[]; export_validity_days: number }>('/privacy/requests');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const exports = (data?.requests ?? []).filter((request) => request.kind === 'export').slice(0, 5);

  async function requestExport() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const { request } = await api<{ request: PrivacyRequest }>('/privacy/exports', { method: 'POST', body: JSON.stringify({}) });
      setNotice({ tone: 'success', message: request.download_url
        ? 'Votre export est prêt. Un e-mail de confirmation vous a été envoyé.'
        : 'Votre demande est enregistrée. Vous serez prévenu dès que l’export sera prêt.' });
      reload();
    } catch (failure) {
      setNotice({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setPending(false);
    }
  }

  return <div className="privacy-panel">
    <div className="row-between privacy-panel-heading">
      <div>
        <h3><Download size={16} aria-hidden="true" /> Télécharger mes données</h3>
        <p className="help-text">Archive JSON de votre compte, de vos contenus, transactions et préférences (RGPD, art. 15 et 20). Une demande par 24 heures ; lien valable {data?.export_validity_days ?? 7} jours. Les mots de passe, jetons et données privées d’autres membres ne sont jamais inclus.</p>
      </div>
      <button type="button" className="button button-secondary button-small" disabled={pending || loading} onClick={() => { void requestExport(); }}>
        {pending ? 'Préparation…' : 'Demander un export'}
      </button>
    </div>
    <NoticeLine notice={notice} />
    {loading && !data && <Loading />}
    {error && <ErrorState message={error} />}
    {exports.length > 0 && <ul className="privacy-list">
      {exports.map((request) => <li key={request.id} className="row-between">
        <span className="small">Demandé le {dateTime(request.requested_at)} <Badge tone={statusTones[request.status]}>{request.status === 'completed' ? 'Expiré' : statusLabels[request.status]}</Badge>
          {request.rejection_reason && <span className="muted"> — {request.rejection_reason}</span>}</span>
        {request.download_url
          ? <a className="button button-primary button-small" href={request.download_url} download onClick={() => window.setTimeout(reload, 1500)}>
            <Download size={14} aria-hidden="true" /> Télécharger{request.expires_at ? ` (jusqu’au ${date(request.expires_at)})` : ''}</a>
          : null}
      </li>)}
    </ul>}
  </div>;
}

function ConsentPanel() {
  const { data, loading, error } = useApi<ConsentState>('/privacy/consents');
  const [state, setState] = useState<ConsentState | null>(null);
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => { if (data) setState(data); }, [data]);

  async function toggle(consent: Consent, granted: boolean) {
    if (!state || pending) return;
    setPending(consent.purpose);
    setNotice(null);
    try {
      setState(await api<ConsentState>('/privacy/consents', { method: 'PUT', body: JSON.stringify({ [consent.purpose]: granted }) }));
      setNotice({ tone: 'success', message: `${consent.label} : ${granted ? 'consentement donné' : 'consentement retiré'}.` });
    } catch (failure) {
      setNotice({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setPending('');
    }
  }

  const labels = Object.fromEntries((state?.consents ?? []).map((consent) => [consent.purpose, consent.label]));
  return <div className="privacy-panel">
    <h3><ShieldCheck size={16} aria-hidden="true" /> Consentements</h3>
    <p className="help-text">Facultatifs et désactivés par défaut. Vous pouvez les retirer à tout moment, aussi simplement que vous les avez donnés. Les e-mails nécessaires au service (sécurité, paiements, missions) ne dépendent pas de ces choix.</p>
    {loading && !state && <Loading />}
    {error && !state && <ErrorState message={error} />}
    {state && <>
      <ul className="privacy-consents">
        {state.consents.map((consent) => <li key={consent.purpose}>
          <label className="privacy-toggle">
            <input type="checkbox" checked={consent.granted} disabled={!!pending} onChange={(event) => { void toggle(consent, event.target.checked); }} />
            <span>
              <strong>{consent.label}</strong>
              <span className="help-text">{consent.description}</span>
              {consent.updated_at && <span className="help-text">Dernière modification : {dateTime(consent.updated_at)}</span>}
              {consent.outdated && <span className="privacy-warning">Donné sous une ancienne version de la politique de confidentialité : confirmez-le en le réactivant.
                <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => { void toggle(consent, true); }}>Confirmer</button></span>}
            </span>
          </label>
        </li>)}
      </ul>
      <NoticeLine notice={notice} />
      <p className="help-text">Politique de confidentialité en vigueur : version {state.policy_version}. <Link to="/legal/privacy">La consulter</Link></p>
      {state.history.length > 0 && <details className="privacy-history">
        <summary><History size={14} aria-hidden="true" /> Historique de mes choix</summary>
        <ul>{state.history.map((event) => <li key={event.id} className="small">
          {dateTime(event.created_at)} — {labels[event.purpose] ?? event.purpose} : {event.granted ? 'accordé' : 'retiré'} ({sourceLabels[event.source] ?? event.source}, politique {event.policy_version})
        </li>)}</ul>
      </details>}
    </>}
  </div>;
}

function LegalPanel() {
  const accepted = useApi<{ acceptances: Acceptance[] }>('/privacy/legal/acceptances');
  const documents = useApi<{ documents: LegalSummary[] }>('/privacy/legal');
  const pendingDocuments = (documents.data?.documents ?? []).filter((document) => document.pending);
  return <div className="privacy-panel">
    <h3><FileCheck2 size={16} aria-hidden="true" /> Documents acceptés</h3>
    {(accepted.loading || documents.loading) && <Loading />}
    {accepted.error && <ErrorState message={accepted.error} />}
    {pendingDocuments.length > 0 && <p className="help-text">À consulter : {pendingDocuments.map((document, index) => <span key={document.slug}>{index > 0 && ', '}
      <Link to={document.url}>{document.title}</Link>{document.required ? ' (obligatoire)' : ''}</span>)}.</p>}
    {accepted.data && (accepted.data.acceptances.length === 0
      ? <p className="help-text">Aucune acceptation enregistrée.</p>
      : <ul className="privacy-list">{accepted.data.acceptances.map((acceptance) => <li key={`${acceptance.document}-${acceptance.version}`} className="row-between">
        <span className="small"><Link to={`/legal/${acceptance.document}`}>{acceptance.title}</Link> — version {acceptance.version}</span>
        <span className="small muted">{dateTime(acceptance.accepted_at)} {acceptance.current ? <Badge tone="green">En vigueur</Badge> : <Badge>Ancienne version</Badge>}</span>
      </li>)}</ul>)}
  </div>;
}

function ErasurePanel() {
  const { data, loading, error, reload } = useApi<ErasureState>('/privacy/erasure');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || !data) return;
    setPending(true);
    setNotice(null);
    try {
      await api('/privacy/erasure', { method: 'POST', body: JSON.stringify({ confirmation, reason, ...(data.requires_password ? { password } : {}) }) });
      setNotice({ tone: 'success', message: 'Suppression programmée. Un e-mail de confirmation vous a été envoyé ; vous pouvez annuler jusqu’à la date indiquée.' });
      setPassword(''); setConfirmation(''); setReason(''); setOpen(false);
      reload();
    } catch (failure) {
      setNotice({ tone: 'error', message: errorMessage(failure) });
      if (failure instanceof ApiError && failure.status === 409) reload();
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      await api('/privacy/erasure', { method: 'DELETE' });
      setNotice({ tone: 'success', message: 'La suppression de votre compte est annulée.' });
      reload();
    } catch (failure) {
      setNotice({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setPending(false);
    }
  }

  const request = data?.request;
  const blocked = !!data && data.blockers.length > 0;
  const needsLogin = !!data && !data.requires_password && !data.recent_login;
  return <div className="privacy-panel privacy-danger-zone">
    <h3><Trash2 size={16} aria-hidden="true" /> Supprimer mon compte</h3>
    {loading && !data && <Loading />}
    {error && <ErrorState message={error} />}
    {data && request?.status === 'scheduled' && request.scheduled_for && <div className="privacy-scheduled">
      <p>La suppression de votre compte est programmée pour le <strong>{dateTime(request.scheduled_for)}</strong>. D’ici là, votre compte fonctionne normalement et vous pouvez annuler.</p>
      {blocked && <p className="privacy-warning">Elle ne pourra être exécutée que lorsque ces points seront réglés :</p>}
      {blocked && <ul className="privacy-blockers">{data.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul>}
      <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => { void cancel(); }}><Undo2 size={14} aria-hidden="true" /> Annuler la suppression</button>
    </div>}
    {data && !request && <>
      <p className="help-text">Après un délai de rétractation de {data.grace_days} jours, votre profil est anonymisé, vos sessions, abonnements, favoris et notifications sont supprimés, et le texte de vos messages, publications et commentaires est remplacé par « supprimé ». Les pièces comptables et journaux exigés par la loi sont conservés sous un identifiant anonyme. Pensez à <strong>télécharger vos données</strong> avant.</p>
      {blocked && <>
        <p className="privacy-warning" role="note">Votre compte ne peut pas encore être supprimé :</p>
        <ul className="privacy-blockers">{data.blockers.map((blocker) => <li key={blocker.code}>{blocker.message}</li>)}</ul>
      </>}
      {!open && <button type="button" className="button button-danger button-small" disabled={blocked} onClick={() => setOpen(true)}>Supprimer mon compte…</button>}
      {open && <form className="form privacy-erasure-form" onSubmit={(event) => { void submit(event); }}>
        {data.requires_password
          ? <label className="field">Mot de passe actuel<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          : <p className={needsLogin ? 'privacy-warning' : 'help-text'}>{needsLogin
            ? `Votre compte n’a pas de mot de passe : pour confirmer votre identité, déconnectez-vous puis reconnectez-vous (connexion de moins de ${data.fresh_login_minutes} minutes requise).`
            : 'Connexion récente vérifiée.'}</p>}
        <label className="field">Raison (facultatif)<textarea rows={2} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
        <label className="field">Pour confirmer, saisissez SUPPRIMER<input value={confirmation} autoComplete="off" spellCheck={false} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="erasure-confirm-help" /></label>
        <p id="erasure-confirm-help" className="help-text">La suppression sera effective le {date(new Date(Date.now() + data.grace_days * 86400000).toISOString())}, sauf annulation de votre part.</p>
        <div className="row gap-sm">
          <button type="submit" className="button button-danger" disabled={pending || blocked || needsLogin || confirmation.trim() !== 'SUPPRIMER' || (data.requires_password && !password)}>
            {pending ? 'Enregistrement…' : 'Programmer la suppression'}</button>
          <button type="button" className="button button-ghost" disabled={pending} onClick={() => setOpen(false)}>Annuler</button>
        </div>
      </form>}
    </>}
    <NoticeLine notice={notice} />
  </div>;
}

export default function PrivacyControls() {
  const section = useRef<HTMLElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash !== '#privacy') return;
    const frame = requestAnimationFrame(() => {
      section.current?.focus({ preventScroll: true });
      section.current?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash]);

  return <section className="card privacy-controls" id="privacy" ref={section} tabIndex={-1} aria-labelledby="privacy-controls-title">
    <div className="card-header">
      <div>
        <h2 id="privacy-controls-title">Données personnelles</h2>
        <p className="muted small">Exercez vos droits RGPD : accès, portabilité, consentements et suppression. <Link to="/legal/privacy">Politique de confidentialité</Link></p>
      </div>
    </div>
    <div className="card-body stack">
      <ExportPanel />
      <ConsentPanel />
      <LegalPanel />
      <ErasurePanel />
    </div>
  </section>;
}
