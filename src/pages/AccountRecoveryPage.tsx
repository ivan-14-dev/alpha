import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, KeyRound, MailCheck, MailWarning } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorState, Loading } from '../components/ui';
import '../styles/accounts.css';

const tokenPattern = /^[A-Za-z0-9_-]{20,128}$/;

/** Reads the one-time token once, then removes it from the address bar so it does not linger in history or referrers. */
function useOneTimeToken(): string {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => {
    const value = new URLSearchParams(location.search).get('token') ?? '';
    return tokenPattern.test(value) ? value : '';
  });
  useEffect(() => {
    if (location.search) navigate({ pathname: location.pathname }, { replace: true });
  }, []);
  return token;
}

function Shell({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return <div className="acct-recovery">
    <section className="auth-form card stack" aria-labelledby="recovery-title">
      <span className="eyebrow">{eyebrow}</span>
      <h2 id="recovery-title">{title}</h2>
      {children}
    </section>
  </div>;
}

function ForgotPassword() {
  const { user } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      const result = await api<{ message: string }>('/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email: email.trim() }) });
      setSent(result.message);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <Shell eyebrow="MOT DE PASSE OUBLIÉ" title={user?.has_password === false ? 'Définir un mot de passe' : 'Réinitialiser votre mot de passe'}>
    {sent ? <>
      <div className="alert alert-success" role="status"><MailCheck size={16} aria-hidden="true" /> {sent}</div>
      <p className="muted small">Le lien est valable une heure et ne fonctionne qu’une fois. Pensez à vérifier vos courriers indésirables. Aucun e-mail ? Vérifiez l’adresse saisie puis renvoyez la demande.</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="button button-secondary" onClick={() => setSent('')}>Renvoyer une demande</button>
        <Link className="button button-ghost" to={user ? '/settings' : '/login'}>{user ? 'Retour aux paramètres' : 'Retour à la connexion'}</Link>
      </div>
    </> : <>
      <p className="muted">Indiquez l’adresse e-mail de votre compte : si elle est connue, vous recevrez un lien pour choisir un nouveau mot de passe.</p>
      <ErrorState message={error} />
      <form className="form" onSubmit={submit}>
        <label className="field">Adresse e-mail<input type="email" name="email" autoComplete="email" maxLength={254} required placeholder="vous@exemple.fr" value={email} onChange={(event) => setEmail(event.target.value)} autoFocus /></label>
        <button className="button button-primary full-width" disabled={pending}>{pending ? 'Envoi…' : 'Recevoir le lien'}<ArrowRight size={17} /></button>
      </form>
      <p className="auth-switch">Vous vous en souvenez ? <Link to={user ? '/settings' : '/login'}>{user ? 'Retour aux paramètres' : 'Se connecter'}</Link></p>
    </>}
  </Shell>;
}

function ResetPassword() {
  const token = useOneTimeToken();
  const { refresh } = useAuth();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [state, setState] = useState<'form' | 'done' | 'invalid'>(token ? 'form' : 'invalid');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (password !== repeat) { setError('La confirmation ne correspond pas au nouveau mot de passe.'); return; }
    setPending(true); setError('');
    try {
      await api('/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
      setPassword(''); setRepeat('');
      setState('done');
      // Every session was revoked server-side, including this browser's.
      await refresh().catch(() => undefined);
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 400 || failure.status === 410) && /lien/i.test(failure.message)) setState('invalid');
      setError(errorMessage(failure));
    } finally { setPending(false); }
  }
  if (state === 'done') return <Shell eyebrow="MOT DE PASSE" title="Mot de passe modifié">
    <div className="alert alert-success" role="status">Votre nouveau mot de passe est enregistré. Par sécurité, toutes vos sessions ont été fermées et un e-mail de confirmation vous a été envoyé.</div>
    <Link className="button button-primary full-width" to="/login">Se connecter <ArrowRight size={17} /></Link>
  </Shell>;
  if (state === 'invalid') return <Shell eyebrow="MOT DE PASSE" title="Lien inutilisable">
    <div className="alert alert-error" role="alert"><MailWarning size={16} aria-hidden="true" /> {error || 'Ce lien de réinitialisation est incomplet ou invalide.'}</div>
    <p className="muted">Les liens de réinitialisation sont valables une heure et ne fonctionnent qu’une seule fois. Demandez-en un nouveau.</p>
    <Link className="button button-primary full-width" to="/forgot-password">Demander un nouveau lien <ArrowRight size={17} /></Link>
  </Shell>;
  return <Shell eyebrow="MOT DE PASSE" title="Choisissez un nouveau mot de passe">
    <p className="muted">De 10 à 128 caractères. Toutes vos sessions ouvertes seront fermées.</p>
    <ErrorState message={error} />
    <form className="form" onSubmit={submit}>
      <label className="field">Nouveau mot de passe<input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} autoFocus /></label>
      <label className="field">Confirmer le mot de passe<input type="password" autoComplete="new-password" minLength={10} maxLength={128} required value={repeat} onChange={(event) => setRepeat(event.target.value)} /></label>
      <button className="button button-primary full-width" disabled={pending}><KeyRound size={17} /> {pending ? 'Enregistrement…' : 'Enregistrer le mot de passe'}</button>
    </form>
  </Shell>;
}

function VerifyEmail() {
  const token = useOneTimeToken();
  const { user, refresh } = useAuth();
  const started = useRef(false);
  const [state, setState] = useState<'pending' | 'done' | 'expired' | 'invalid'>(token ? 'pending' : 'invalid');
  const [error, setError] = useState('');
  const [resent, setResent] = useState(false);
  const [resending, setResending] = useState(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
      .then(async () => { setState('done'); await refresh().catch(() => undefined); })
      .catch((failure: unknown) => {
        setError(errorMessage(failure));
        setState(failure instanceof ApiError && failure.status === 410 ? 'expired' : 'invalid');
      });
  }, [token]);
  async function resend() {
    setResending(true); setError('');
    try { await api('/auth/verify-email/resend', { method: 'POST' }); setResent(true); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setResending(false); }
  }
  if (state === 'pending') return <Shell eyebrow="ADRESSE E-MAIL" title="Vérification en cours"><Loading /></Shell>;
  if (state === 'done') return <Shell eyebrow="ADRESSE E-MAIL" title="Adresse e-mail confirmée">
    <div className="alert alert-success" role="status"><MailCheck size={16} aria-hidden="true" /> Merci ! Votre adresse e-mail est vérifiée.</div>
    <Link className="button button-primary full-width" to={user ? '/' : '/login'}>{user ? 'Continuer sur Alpha' : 'Se connecter'} <ArrowRight size={17} /></Link>
  </Shell>;
  return <Shell eyebrow="ADRESSE E-MAIL" title={state === 'expired' ? 'Lien expiré' : 'Lien inutilisable'}>
    <ErrorState message={error || 'Ce lien de vérification est incomplet ou invalide.'} />
    {user?.email_verified ? <p className="muted">Votre adresse e-mail est déjà vérifiée : vous n’avez rien d’autre à faire.</p>
      : user ? <>
        <p className="muted">Les liens de vérification sont valables 48 heures et ne fonctionnent qu’une fois. Vous pouvez en recevoir un nouveau à {user.email}.</p>
        {resent ? <div className="alert alert-success" role="status">Un nouveau lien vient de vous être envoyé.</div>
          : <button type="button" className="button button-primary full-width" disabled={resending} onClick={() => { void resend(); }}>{resending ? 'Envoi…' : 'Renvoyer un lien de vérification'}</button>}
      </> : <p className="muted">Connectez-vous pour recevoir un nouveau lien de vérification depuis vos paramètres.</p>}
    <Link className="button button-ghost full-width" to={user ? '/settings' : '/login'}>{user ? 'Mes paramètres' : 'Se connecter'}</Link>
  </Shell>;
}

export default function AccountRecoveryPage() {
  const { pathname } = useLocation();
  const { loading } = useAuth();
  if (loading) return <Loading />;
  if (pathname === '/reset-password') return <ResetPassword />;
  if (pathname === '/verify-email') return <VerifyEmail />;
  return <ForgotPassword />;
}
