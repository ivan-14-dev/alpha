import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Beaker, Check, KeyRound, Layers3, ShieldCheck, Users } from 'lucide-react';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth, type User } from '../lib/auth';
import { ErrorState, Loading } from '../components/ui';
import OAuthButtons, { oauthErrorMessage, safeNextPath } from '../components/OAuthButtons';
import { usePaymentMode } from '../components/CheckoutStatus';
import '../styles/accounts.css';

type LoginResult = { user: User } | { mfa_required: true; challenge: string };
interface MfaStep { challenge: string; next: string }

const authPaths = ['/login', '/register', '/forgot-password', '/reset-password', '/verify-email'];
/** Destination after sign-in: a safe relative path that is not itself an authentication page. */
function postLoginPath(value: string | null): string {
  const path = safeNextPath(value);
  return authPaths.some((prefix) => path === prefix || path.startsWith(`${prefix}?`) || path.startsWith(`${prefix}/`)) ? '/' : path;
}
const challengePattern = /^[A-Za-z0-9_-]{20,128}$/;

export default function AuthPage() {
  const location = useLocation();
  const register = location.pathname === '/register';
  const paymentMode = usePaymentMode();
  const { user, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [initial] = useState(() => {
    const params = new URLSearchParams(location.search);
    const next = postLoginPath(params.get('next'));
    const challenge = params.get('mfa');
    const oauthError = params.get('oauth_error');
    return {
      next,
      mfa: challenge && challengePattern.test(challenge) ? { challenge, next } : null,
      error: oauthError ? oauthErrorMessage(oauthError) : '',
    };
  });
  const [next] = useState(initial.next);
  const [mfa, setMfa] = useState<MfaStep | null>(initial.mfa);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initial.error);

  // One-time values (MFA challenge, OAuth error) must not stay in the address bar or the history.
  useEffect(() => {
    if (location.search) navigate({ pathname: location.pathname }, { replace: true });
  }, []);

  async function finish(destination: string) {
    await refresh();
    navigate(destination, { replace: true });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      if (register) {
        await api('/auth/register', { method: 'POST', body: JSON.stringify({
          name: form.get('name'), email: form.get('email'), password: form.get('password'), accept_terms: form.get('accept_terms') === 'on',
        }) });
        await finish(next);
        return;
      }
      const result = await api<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      if ('mfa_required' in result) {
        setMfa({ challenge: result.challenge, next });
        setCode(''); setUseRecovery(false);
        return;
      }
      await finish(next);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mfa || pending) return;
    const value = code.trim();
    if (!value) return;
    setPending(true); setError('');
    try {
      await api('/auth/mfa/verify', { method: 'POST', body: JSON.stringify(useRecovery ? { challenge: mfa.challenge, recovery_code: value } : { challenge: mfa.challenge, code: value }) });
      await finish(mfa.next);
    } catch (failure) {
      setCode('');
      if (failure instanceof ApiError && (failure.status === 410 || failure.status === 403)) setMfa(null);
      setError(errorMessage(failure));
    } finally { setPending(false); }
  }

  function cancelMfa() {
    setMfa(null); setCode(''); setError(''); setUseRecovery(false);
  }

  if (loading) return <Loading />;
  if (user) return <Navigate to={mfa?.next ?? next} replace />;
  return <div className="auth-layout">
    <div className="auth-story"><span className="eyebrow">LE COLLECTIF DES BUILDERS</span><h1>Les bonnes idées<br />méritent de<br /><span>prendre vie.</span></h1><p>Un projet, un regard neuf, une rencontre.<br />La suite se construit ensemble.</p><div className="auth-benefits"><span><Layers3 size={20} /> Partagez ce que vous construisez</span><span><Beaker size={20} /> Testez et faites la différence</span><span><Users size={20} /> Trouvez votre collectif</span></div><div className="auth-footnote"><Check size={16} /> Un compte, toutes les possibilités.</div></div>
    {mfa ? <section className="auth-form card" aria-labelledby="mfa-title">
      <span className="eyebrow">VÉRIFICATION EN DEUX ÉTAPES</span>
      <h2 id="mfa-title" className="acct-title-icon"><ShieldCheck size={22} aria-hidden="true" /> Encore une étape.</h2>
      <p className="muted">{useRecovery
        ? 'Saisissez l’un des codes de récupération que vous avez enregistrés lors de l’activation. Chaque code ne fonctionne qu’une fois.'
        : 'Ouvrez votre application d’authentification (Google Authenticator, Authy, 1Password…) et saisissez le code à 6 chiffres affiché pour Alpha.'}</p>
      <ErrorState message={error} />
      <form className="form" onSubmit={verify}>
        {useRecovery
          ? <label className="field">Code de récupération<input key="recovery" name="recovery_code" autoComplete="off" autoCapitalize="none" spellCheck={false} minLength={6} maxLength={32} required placeholder="xxxx-xxxx-xxxx-xxxx" value={code} onChange={(event) => setCode(event.target.value)} autoFocus /></label>
          : <label className="field">Code de vérification<input key="totp" name="code" className="acct-code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required placeholder="123456" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus /></label>}
        <button className="button button-primary full-width" disabled={pending || !code.trim()}>{pending ? 'Vérification…' : 'Vérifier et me connecter'}<ArrowRight size={17} /></button>
      </form>
      <div className="acct-mfa-actions">
        <button type="button" className="button button-ghost button-small" disabled={pending} onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>
          <KeyRound size={15} /> {useRecovery ? 'Utiliser plutôt l’application' : 'Utiliser un code de récupération'}
        </button>
        <button type="button" className="button button-ghost button-small" disabled={pending} onClick={cancelMfa}>Annuler</button>
      </div>
      <p className="help-text">Cette étape expire au bout de 5 minutes et après 5 codes incorrects. Plus d’accès à votre application ni à vos codes ? Contactez la modération depuis l’adresse e-mail de votre compte.</p>
    </section> : <section className="auth-form card"><span className="eyebrow">BIENVENUE SUR ALPHA</span><h2>{register ? 'Rejoignez le mouvement.' : 'Heureux de vous revoir.'}</h2><p className="muted">{register ? 'Votre prochain projet commence peut-être ici.' : 'Vos projets et votre communauté vous attendent.'}</p><ErrorState message={error} />
      <form className="form" onSubmit={submit}>{register && <label className="field">Votre nom<input name="name" autoComplete="name" minLength={2} maxLength={80} required placeholder="Comment vous appelle-t-on ?" /></label>}
        <label className="field">Adresse e-mail<input name="email" type="email" autoComplete={register ? 'email' : 'username'} maxLength={254} required placeholder="vous@exemple.fr" /></label>
        <label className="field">Mot de passe<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required placeholder="Au moins 10 caractères" /></label>
        {!register && <div className="acct-forgot"><Link to="/forgot-password">Mot de passe oublié ?</Link></div>}
        {register && <label className="acct-checkbox"><input type="checkbox" name="accept_terms" required /><span>J’accepte les <a href="/legal/terms" target="_blank" rel="noopener">conditions générales d’utilisation</a> et la <a href="/legal/privacy" target="_blank" rel="noopener">politique de confidentialité</a>.</span></label>}
        {register && <p className="help-text">Un e-mail de vérification vous sera envoyé ; vous pourrez utiliser Alpha immédiatement. {paymentMode && paymentMode !== 'demo' ? 'Les paiements passent par des prestataires agréés.' : 'Les paiements sont actuellement simulés.'} N’utilisez pas de données confidentielles dans les espaces publics.</p>}
        <button className="button button-primary full-width" disabled={pending}>{pending ? 'Un instant…' : register ? 'Créer mon compte' : 'Se connecter'}<ArrowRight size={17} /></button>
      </form>
      <OAuthButtons redirect={next} disabled={pending} />
      <p className="auth-switch">{register ? 'Déjà dans le collectif ?' : 'Pas encore de compte ?'} <Link to={register ? '/login' : '/register'} onClick={() => setError('')}>{register ? 'Se connecter' : 'Rejoindre Alpha'}</Link></p>
    </section>}
  </div>;
}
