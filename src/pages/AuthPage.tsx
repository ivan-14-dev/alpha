import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Beaker, Check, Layers3, Users } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorState, Loading } from '../components/ui';

export default function AuthPage() {
  const register = useLocation().pathname === '/register';
  const { user, loading, refresh } = useAuth();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true); setError('');
    try {
      await api(`/auth/${register ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify({ name: form.get('name'), email: form.get('email'), password: form.get('password') }) });
      await refresh();
      navigate('/');
    } catch (error) { setError(errorMessage(error)); }
    finally { setPending(false); }
  }
  if (loading) return <Loading />;
  if (user) return <Navigate to="/" replace />;
  return <div className="auth-layout">
    <div className="auth-story"><span className="eyebrow">LE COLLECTIF DES BUILDERS</span><h1>Les bonnes idées<br />méritent de<br /><span>prendre vie.</span></h1><p>Un projet, un regard neuf, une rencontre.<br />La suite se construit ensemble.</p><div className="auth-benefits"><span><Layers3 size={20} /> Partagez ce que vous construisez</span><span><Beaker size={20} /> Testez et faites la différence</span><span><Users size={20} /> Trouvez votre collectif</span></div><div className="auth-footnote"><Check size={16} /> Un compte, toutes les possibilités.</div></div>
    <section className="auth-form card"><span className="eyebrow">BIENVENUE SUR ALPHA</span><h2>{register ? 'Rejoignez le mouvement.' : 'Heureux de vous revoir.'}</h2><p className="muted">{register ? 'Votre prochain projet commence peut-être ici.' : 'Vos projets et votre communauté vous attendent.'}</p><ErrorState message={error} />
      <form className="form" onSubmit={submit}>{register && <label className="field">Votre nom<input name="name" autoComplete="name" minLength={2} maxLength={80} required placeholder="Comment vous appelle-t-on ?" /></label>}
        <label className="field">Adresse email<input name="email" type="email" autoComplete="email" maxLength={254} required placeholder="vous@exemple.fr" /></label>
        <label className="field">Mot de passe<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={10} maxLength={128} required placeholder="Au moins 10 caractères" /></label>
        {register && <p className="help-text">Les paiements de cette version sont simulés. N’utilisez pas de données confidentielles dans les espaces publics.</p>}
        <button className="button button-primary full-width" disabled={pending}>{pending ? 'Un instant…' : register ? 'Créer mon compte' : 'Se connecter'}<ArrowRight size={17} /></button>
      </form><p className="auth-switch">{register ? 'Déjà dans le collectif ?' : 'Pas encore de compte ?'} <Link to={register ? '/login' : '/register'} onClick={() => setError('')}>{register ? 'Se connecter' : 'Rejoindre Alpha'}</Link></p>
    </section>
  </div>;
}
