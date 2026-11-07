import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, ErrorState, Loading, Modal } from './ui';

interface Session {
  id: string;
  created_at: string | null;
  expires_at: string;
  current: boolean;
}
interface SessionPage {
  sessions: Session[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
const pageSize = 10;
const sessionDate = (value: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

export default function AccountSecurity() {
  const { user, refresh } = useAuth();
  const refreshAuth = useRef(refresh);
  refreshAuth.current = refresh;
  const [data, setData] = useState<SessionPage | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [sessionLost, setSessionLost] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmation, setConfirmation] = useState<Session | 'others' | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const busy = pending || loading || sessionLost;

  async function handleFailure(failure: unknown) {
    setSuccess('');
    if (failure instanceof ApiError && failure.status === 401) {
      setError('');
      setData(null);
      setConfirmation(null);
      setSessionLost(true);
      setCurrentPassword(''); setNewPassword(''); setRepeatPassword('');
      try { await refreshAuth.current(); }
      catch (refreshError) { setError(errorMessage(refreshError)); }
      return;
    }
    setError(errorMessage(failure));
    if (failure instanceof ApiError && [404, 409].includes(failure.status)) {
      setConfirmation(null);
      setRevision((value) => value + 1);
    }
  }

  useEffect(() => {
    let active = true;
    if (!user) { setData(null); setLoading(false); return; }
    setLoading(true);
    api<SessionPage>(`/auth/sessions?limit=${pageSize}&offset=${offset}`)
      .then((page) => {
        if (!active) return;
        if (offset > 0 && page.sessions.length === 0) { setOffset(Math.max(0, Math.ceil(page.total / pageSize) - 1) * pageSize); return; }
        setData(page);
        setSessionLost(false);
      })
      .catch(async (failure: unknown) => { if (active) await handleFailure(failure); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [user?.id, offset, revision]);

  async function mutate(path: string, method: 'POST' | 'DELETE', message: string, body?: unknown) {
    if (busy) return;
    setPending(true); setError(''); setSuccess('');
    try {
      await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (path === '/auth/password') {
        setCurrentPassword(''); setNewPassword(''); setRepeatPassword('');
        await refreshAuth.current();
      }
      const page = await api<SessionPage>(`/auth/sessions?limit=${pageSize}&offset=0`);
      setData(page); setOffset(0); setConfirmation(null); setSuccess(message);
    } catch (failure) { await handleFailure(failure); }
    finally { setPending(false); }
  }

  function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(''); setSuccess('');
    if (newPassword !== repeatPassword) { setError('La confirmation ne correspond pas au nouveau mot de passe.'); return; }
    if (currentPassword === newPassword) { setError('Choisissez un mot de passe différent du mot de passe actuel.'); return; }
    void mutate('/auth/password', 'POST', 'Mot de passe modifié. Toutes les anciennes sessions ont été fermées ; cette session a été renouvelée.', {
      current_password: currentPassword, new_password: newPassword,
    });
  }

  if (!user) return null;
  return <section className="stack" aria-labelledby="account-security-title">
    <div><h2 id="account-security-title">Sécurité du compte</h2><p className="muted">Gérez votre mot de passe local et vos connexions à Alpha. Aucune récupération par email n’est proposée ici.</p></div>
    <ErrorState message={error} />
    {sessionLost && <p role="status">Cette session n’est plus active. Votre authentification a été actualisée. {error && <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => { void handleFailure(new ApiError('', 401)); }}>Réessayer</button>}</p>}
    {success && <div className="alert alert-success" role="status">{success}</div>}
    <section className="card card-body stack" aria-labelledby="account-sessions-title" aria-busy={loading || pending}>
      <div className="row-between">
        <h3 id="account-sessions-title">Sessions actives{data ? ` (${data.total})` : ''}</h3>
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { setError(''); setSuccess(''); setRevision((value) => value + 1); }}>Actualiser</button>
      </div>
      <p className="muted small">Seules vos sessions non expirées sont affichées. Aucune adresse IP ni empreinte d’appareil n’est collectée.</p>
      {loading ? <Loading /> : data && <div className="list">
        {data.sessions.map((session, index) => <div key={session.id} className="list-item row-between">
          <div className="stack" style={{ gap: 5, minWidth: 0 }}>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <strong>{session.current ? 'Session actuelle' : `Session ${data.offset + index + 1}`}</strong>
              {session.current && <Badge tone="green">Ce navigateur</Badge>}
            </div>
            <span className="muted small">{session.created_at ? <>Créée le <time dateTime={session.created_at}>{sessionDate(session.created_at)}</time></> : 'Date de création inconnue (ancienne session)'}</span>
            <span className="muted small">Expire le <time dateTime={session.expires_at}>{sessionDate(session.expires_at)}</time></span>
          </div>
          {session.current ? <span className="muted small">Utilisez « Se déconnecter » pour la fermer.</span> : <button type="button" className="button button-secondary button-small" disabled={busy} aria-label={`Révoquer la session ${data.offset + index + 1}`} onClick={() => { setError(''); setSuccess(''); setConfirmation(session); }}>Révoquer</button>}
        </div>)}
      </div>}
      {data && (offset > 0 || data.has_more) && <nav className="row-between" aria-label="Pagination des sessions">
        <button type="button" className="button button-secondary button-small" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>Précédent</button>
        <span className="muted small">Page {Math.floor(offset / pageSize) + 1} sur {Math.max(1, Math.ceil(data.total / pageSize))}</span>
        <button type="button" className="button button-secondary button-small" disabled={busy || !data.has_more} onClick={() => setOffset(offset + pageSize)}>Suivant</button>
      </nav>}
      <div><button type="button" className="button button-secondary" disabled={busy || !data || data.total <= 1} onClick={() => { setError(''); setSuccess(''); setConfirmation('others'); }}>Fermer toutes les autres sessions</button></div>
    </section>
    <form className="card card-body stack" onSubmit={changePassword} aria-labelledby="account-password-title" aria-busy={pending}>
      <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />
      <h3 id="account-password-title">Changer le mot de passe</h3>
      <p id="account-password-help" className="muted small">De 10 à 128 caractères. Ce changement ferme toutes les anciennes sessions, y compris celle-ci, puis vous reconnecte automatiquement avec une nouvelle session.</p>
      <fieldset className="form-grid" disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="field full-width" htmlFor="account-current-password">Mot de passe actuel<input id="account-current-password" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label className="field" htmlFor="account-new-password">Nouveau mot de passe<input id="account-new-password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} aria-describedby="account-password-help" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="field" htmlFor="account-repeat-password">Confirmer le nouveau mot de passe<input id="account-repeat-password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} /></label>
      </fieldset>
      <div><button className="button button-primary" disabled={busy}>{pending ? 'En cours…' : 'Modifier mon mot de passe'}</button></div>
    </form>
    {confirmation && <Modal title={confirmation === 'others' ? 'Fermer les autres sessions ?' : 'Révoquer cette session ?'} onClose={() => { if (!pending) setConfirmation(null); }}>
      <div className="stack">
        <p>{confirmation === 'others' ? 'Toutes vos autres sessions seront fermées. Votre session actuelle restera active.' : `Cette connexion sera fermée immédiatement. ${confirmation.created_at ? `Créée le ${sessionDate(confirmation.created_at)}.` : 'Sa date de création est inconnue.'} Votre session actuelle restera active.`}</p>
        <ErrorState message={error} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="button button-secondary" disabled={pending} onClick={() => setConfirmation(null)}>Annuler</button>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => { void mutate(
            confirmation === 'others' ? '/auth/sessions/revoke-others' : `/auth/sessions/${confirmation.id}`,
            confirmation === 'others' ? 'POST' : 'DELETE',
            confirmation === 'others' ? 'Toutes les autres sessions ont été fermées.' : 'La session a été révoquée.',
          ); }}>{pending ? 'En cours…' : 'Confirmer la révocation'}</button>
        </div>
      </div>
    </Modal>}
  </section>;
}
