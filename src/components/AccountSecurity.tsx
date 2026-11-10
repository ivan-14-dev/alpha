import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Link2, MailCheck, MailWarning, ShieldAlert, Unlink } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, ErrorState, Loading, Modal } from './ui';
import MfaSettings, { type MfaStatus } from './MfaSettings';
import { oauthErrorMessage, oauthStartUrl, ProviderIcon, type OAuthProviderId } from './OAuthButtons';
import '../styles/accounts.css';

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
interface LinkedIdentity { provider: OAuthProviderId; email: string; created_at: string; last_login_at: string | null }
interface AccountStatus {
  email: string;
  email_verified: boolean;
  email_verified_at: string | null;
  has_password: boolean;
  mfa: MfaStatus;
  identities: LinkedIdentity[];
  oauth_providers: { id: OAuthProviderId; name: string; linked: boolean }[];
  can_unlink: boolean;
  admin_mfa_required: boolean;
  policy: { require_admin_mfa: boolean };
}
const providerNames: Record<OAuthProviderId, string> = { github: 'GitHub', google: 'Google' };
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
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [accountRevision, setAccountRevision] = useState(0);
  const [unlinkTarget, setUnlinkTarget] = useState<OAuthProviderId | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const busy = pending || loading || sessionLost;

  // Result of an OAuth "link" round trip: show it once, then clean the address bar.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const linked = params.get('oauth') === 'linked';
    const failure = params.get('oauth_error');
    if (!linked && !failure) return;
    const provider = params.get('provider');
    if (failure) setError(oauthErrorMessage(failure));
    else setSuccess(`Compte ${provider === 'github' || provider === 'google' ? providerNames[provider] : 'externe'} associé : vous pouvez désormais l’utiliser pour vous connecter.`);
    for (const key of ['oauth', 'oauth_error', 'provider']) params.delete(key);
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
  }, []);

  useEffect(() => {
    let active = true;
    if (!user) { setAccount(null); return; }
    api<AccountStatus>('/auth/account')
      .then((status) => { if (active) setAccount(status); })
      .catch(async (failure: unknown) => { if (active) await handleFailure(failure); });
    return () => { active = false; };
  }, [user?.id, accountRevision]);

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
      if (path.startsWith('/auth/oauth/identities/')) { setUnlinkTarget(null); setAccountRevision((value) => value + 1); }
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

  async function simple(path: string, message: string, body?: unknown) {
    if (busy) return;
    setPending(true); setError(''); setSuccess('');
    try {
      await api(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });
      setSuccess(message);
      if (path === '/auth/verify-email/resend') setAccountRevision((value) => value + 1);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409 && path === '/auth/verify-email/resend') {
        setAccountRevision((value) => value + 1);
        await refreshAuth.current().catch(() => undefined);
      }
      await handleFailure(failure);
    } finally { setPending(false); }
  }

  function securityChanged() {
    setError(''); setAccountRevision((value) => value + 1);
    void refreshAuth.current().catch(() => undefined);
  }

  if (!user) return null;
  const providerIds = account ? [...new Set<OAuthProviderId>([
    ...account.oauth_providers.map((provider) => provider.id),
    ...account.identities.map((identity) => identity.provider),
  ])].sort() : [];
  const hasPassword = account?.has_password ?? user.has_password ?? true;
  return <section className="stack" aria-labelledby="account-security-title">
    <div><h2 id="account-security-title">Sécurité du compte</h2><p className="muted">Gérez votre adresse e-mail, la double authentification, vos comptes associés, votre mot de passe et vos connexions à Alpha.</p></div>
    <ErrorState message={error} />
    {account?.admin_mfa_required && <div className="alert alert-error acct-alert-icon" role="alert"><ShieldAlert size={16} aria-hidden="true" /> La politique de sécurité impose la double authentification aux administrateurs : vos droits d’administration sont suspendus tant qu’elle n’est pas activée ci-dessous.</div>}
    {sessionLost && <p role="status">Cette session n’est plus active. Votre authentification a été actualisée. {error && <button type="button" className="button button-secondary button-small" disabled={pending} onClick={() => { void handleFailure(new ApiError('', 401)); }}>Réessayer</button>}</p>}
    {success && <div className="alert alert-success" role="status">{success}</div>}
    {account && <section className="card card-body stack" aria-labelledby="account-email-title">
      <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h3 id="account-email-title" className="acct-title-icon">{account.email_verified ? <MailCheck size={18} aria-hidden="true" /> : <MailWarning size={18} aria-hidden="true" />} Adresse e-mail</h3>
        {account.email_verified ? <Badge tone="success">Vérifiée</Badge> : <Badge tone="warning">À vérifier</Badge>}
      </div>
      <p className="small"><strong>{account.email}</strong>{account.email_verified && account.email_verified_at && <span className="muted"> — vérifiée le <time dateTime={account.email_verified_at}>{sessionDate(account.email_verified_at)}</time></span>}</p>
      {!account.email_verified && <>
        <p className="muted small">Confirmez votre adresse pour sécuriser la récupération de votre compte et l’association automatique avec GitHub ou Google. Le lien reçu est valable 48 heures.</p>
        <div><button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => { void simple('/auth/verify-email/resend', `Un nouveau lien de vérification a été envoyé à ${account.email}.`); }}>Renvoyer l’e-mail de vérification</button></div>
      </>}
    </section>}
    {account && <MfaSettings
      status={account.mfa}
      email={account.email}
      hasPassword={account.has_password}
      policyLocked={account.policy.require_admin_mfa && user.role === 'admin'}
      onChanged={securityChanged}
      onUnauthorized={() => { void handleFailure(new ApiError('', 401)); }}
    />}
    {account && providerIds.length > 0 && <section className="card card-body stack" aria-labelledby="account-oauth-title">
      <h3 id="account-oauth-title" className="acct-title-icon"><Link2 size={18} aria-hidden="true" /> Comptes associés</h3>
      <p className="muted small">Connectez-vous à Alpha avec un compte externe. Seules votre identité et votre adresse e-mail vérifiée sont lues ; Alpha n’obtient aucun accès à vos dépôts ni à vos fichiers.</p>
      <div className="list">
        {providerIds.map((providerId) => {
          const identity = account.identities.find((item) => item.provider === providerId);
          const available = account.oauth_providers.some((provider) => provider.id === providerId);
          return <div key={providerId} className="list-item row-between" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="stack" style={{ gap: 4, minWidth: 0 }}>
              <strong className="acct-title-icon"><ProviderIcon provider={providerId} /> {providerNames[providerId]}</strong>
              {identity ? <span className="muted small">{identity.email} · associé le <time dateTime={identity.created_at}>{sessionDate(identity.created_at)}</time>{identity.last_login_at && <> · dernière connexion le <time dateTime={identity.last_login_at}>{sessionDate(identity.last_login_at)}</time></>}</span>
                : <span className="muted small">Non associé</span>}
            </div>
            {identity
              ? <button type="button" className="button button-secondary button-small" disabled={busy || !account.can_unlink} title={account.can_unlink ? undefined : 'Définissez d’abord un mot de passe ou associez un autre compte.'} onClick={() => { setError(''); setSuccess(''); setUnlinkTarget(providerId); }}><Unlink size={15} /> Dissocier</button>
              : available && <a className={`button button-secondary button-small${busy ? ' is-disabled' : ''}`} aria-disabled={busy || undefined} onClick={(event) => { if (busy) event.preventDefault(); }} href={oauthStartUrl(providerId, 'link', '/settings')}><Link2 size={15} /> Associer</a>}
          </div>;
        })}
      </div>
      {!account.can_unlink && account.identities.length > 0 && <p className="muted small">Ce compte externe est votre seul moyen de connexion : définissez un mot de passe avant de le dissocier.</p>}
    </section>}
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
    {!hasPassword ? <section className="card card-body stack" aria-labelledby="account-password-title">
      <h3 id="account-password-title">Définir un mot de passe</h3>
      <p className="muted small">Vous vous connectez aujourd’hui uniquement avec un compte externe. Pour ajouter un mot de passe Alpha, recevez un lien sécurisé à {user.email} (valable une heure). Toutes vos sessions seront ensuite fermées.</p>
      <div><button type="button" className="button button-primary" disabled={busy} onClick={() => { void simple('/auth/password/forgot', 'Un lien pour définir votre mot de passe vous a été envoyé.', { email: user.email }); }}>Recevoir le lien par e-mail</button></div>
    </section> : <form className="card card-body stack" onSubmit={changePassword} aria-labelledby="account-password-title" aria-busy={pending}>
      <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />
      <h3 id="account-password-title">Changer le mot de passe</h3>
      <p id="account-password-help" className="muted small">De 10 à 128 caractères. Ce changement ferme toutes les anciennes sessions, y compris celle-ci, puis vous reconnecte automatiquement avec une nouvelle session.</p>
      <fieldset className="form-grid" disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="field full-width" htmlFor="account-current-password">Mot de passe actuel<input id="account-current-password" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
        <label className="field" htmlFor="account-new-password">Nouveau mot de passe<input id="account-new-password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} aria-describedby="account-password-help" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
        <label className="field" htmlFor="account-repeat-password">Confirmer le nouveau mot de passe<input id="account-repeat-password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={repeatPassword} onChange={(event) => setRepeatPassword(event.target.value)} /></label>
      </fieldset>
      <div className="row" style={{ flexWrap: 'wrap' }}><button className="button button-primary" disabled={busy}>{pending ? 'En cours…' : 'Modifier mon mot de passe'}</button><Link className="muted small" to="/forgot-password">Mot de passe actuel oublié ?</Link></div>
    </form>}
    {unlinkTarget && <Modal title={`Dissocier ${providerNames[unlinkTarget]} ?`} onClose={() => { if (!pending) setUnlinkTarget(null); }}>
      <div className="stack">
        <p>Vous ne pourrez plus vous connecter à Alpha avec ce compte {providerNames[unlinkTarget]}. Vous pourrez l’associer à nouveau plus tard.</p>
        <ErrorState message={error} />
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="button button-secondary" disabled={pending} onClick={() => setUnlinkTarget(null)}>Annuler</button>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => { void mutate(`/auth/oauth/identities/${unlinkTarget}`, 'DELETE', `Le compte ${providerNames[unlinkTarget]} a été dissocié.`); }}>{pending ? 'En cours…' : 'Dissocier'}</button>
        </div>
      </div>
    </Modal>}
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
