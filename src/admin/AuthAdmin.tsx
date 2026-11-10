import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, KeyRound, MailCheck, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { Badge, ErrorState, Loading, useApi } from '../components/ui';
import { ProviderIcon, type OAuthProviderId } from '../components/OAuthButtons';
import { api, errorMessage } from '../lib/api';
import '../styles/accounts.css';

/** Sign-in & account security administration — OWNER: accounts module. Data from /api/auth/admin/*. */

interface ProviderConfig {
  id: OAuthProviderId;
  name: string;
  enabled: boolean;
  client_id: string;
  client_secret: { configured: boolean; mask: string };
  callback_url: string;
  console_url: string;
  scope: string;
  ready: boolean;
}
interface Stats {
  users: number;
  email_verified: number;
  email_verified_pct: number;
  mfa_enabled: number;
  mfa_pct: number;
  admins: number;
  admins_with_mfa: number;
  passwordless: number;
  identities: Record<string, number>;
  recovery_codes_low: number;
}
interface PolicyResponse { policy: { require_admin_mfa: boolean }; admins_without_mfa: number }

const number = new Intl.NumberFormat('fr-FR');
const percent = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });

function Stat({ icon, tone, label, value, note }: { icon: ReactNode; tone: string; label: string; value: ReactNode; note?: ReactNode }) {
  return <div className="stat-card">
    <div className="row-between"><span className="stat-label">{label}</span><span className={`stat-icon ${tone}`} aria-hidden="true">{icon}</span></div>
    <div className="stat-value">{value}</div>
    {note && <div className="stat-note">{note}</div>}
  </div>;
}

function ProviderForm({ initial }: { initial: ProviderConfig }) {
  const [provider, setProvider] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [clientId, setClientId] = useState(initial.client_id);
  const [secretMode, setSecretMode] = useState<'keep' | 'replace' | 'remove'>(initial.client_secret.configured ? 'keep' : 'replace');
  const [secret, setSecret] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const fieldId = (name: string) => `oauth-${provider.id}-${name}`;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(''); setSuccess('');
    try {
      const body: Record<string, unknown> = { enabled, client_id: clientId.trim() };
      if (secretMode === 'replace' && secret.trim()) body.client_secret = secret.trim();
      if (secretMode === 'remove') body.client_secret = null;
      const result = await api<{ provider: ProviderConfig }>(`/auth/admin/oauth/${provider.id}`, { method: 'PUT', body: JSON.stringify(body) });
      setProvider(result.provider);
      setEnabled(result.provider.enabled);
      setClientId(result.provider.client_id);
      setSecret('');
      setSecretMode(result.provider.client_secret.configured ? 'keep' : 'replace');
      setSuccess('Configuration enregistrée.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }

  async function copyCallback() {
    try { await navigator.clipboard.writeText(provider.callback_url); setSuccess('URL de rappel copiée.'); }
    catch { setError('Copie impossible : sélectionnez l’URL manuellement.'); }
  }

  return <form className="card card-body stack" onSubmit={save} aria-labelledby={fieldId('title')} aria-busy={pending}>
    <div className="row-between" style={{ flexWrap: 'wrap', gap: 8 }}>
      <h3 id={fieldId('title')} className="acct-title-icon"><ProviderIcon provider={provider.id} /> {provider.name}</h3>
      {provider.ready ? <Badge tone="success">Actif</Badge> : provider.enabled ? <Badge tone="warning">Incomplet</Badge> : <Badge tone="neutral">Désactivé</Badge>}
    </div>
    <ErrorState message={error} />
    {success && <div className="alert alert-success" role="status">{success}</div>}
    <div className="stack" style={{ gap: 6 }}>
      <label className="field" htmlFor={fieldId('callback')}>URL de rappel à déclarer chez {provider.name}</label>
      <div className="acct-copy-row">
        <input id={fieldId('callback')} className="acct-mono" value={provider.callback_url} readOnly onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="button button-secondary button-small" onClick={() => { void copyCallback(); }}><Copy size={15} /> Copier</button>
      </div>
      <span className="help-text">Portée demandée : <code>{provider.scope}</code>. Créez l’application dans la <a href={provider.console_url} target="_blank" rel="noopener noreferrer">console {provider.name} <ExternalLink size={11} aria-hidden="true" /></a>. L’URL dépend de APP_ORIGIN : elle doit correspondre exactement à l’adresse publique d’Alpha.</span>
    </div>
    <fieldset className="form-grid" disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label className="field full-width" htmlFor={fieldId('client')}>Identifiant client (client ID)
        <input id={fieldId('client')} className="acct-mono" autoComplete="off" spellCheck={false} maxLength={200} value={clientId} onChange={(event) => setClientId(event.target.value)} />
      </label>
      <div className="field full-width">
        <span>Secret client</span>
        {provider.client_secret.configured && <span className="muted small">Secret enregistré (chiffré) : <code>{provider.client_secret.mask}</code></span>}
        <div className="acct-radio-row" role="radiogroup" aria-label="Secret client">
          {provider.client_secret.configured && <label className="acct-checkbox"><input type="radio" name={fieldId('secret-mode')} checked={secretMode === 'keep'} onChange={() => setSecretMode('keep')} /> <span>Conserver</span></label>}
          <label className="acct-checkbox"><input type="radio" name={fieldId('secret-mode')} checked={secretMode === 'replace'} onChange={() => setSecretMode('replace')} /> <span>{provider.client_secret.configured ? 'Remplacer' : 'Définir'}</span></label>
          {provider.client_secret.configured && <label className="acct-checkbox"><input type="radio" name={fieldId('secret-mode')} checked={secretMode === 'remove'} onChange={() => { setSecretMode('remove'); setEnabled(false); }} /> <span>Supprimer</span></label>}
        </div>
        {secretMode === 'replace' && <input id={fieldId('secret')} aria-label={`Nouveau secret client ${provider.name}`} type="password" className="acct-mono" autoComplete="new-password" spellCheck={false} minLength={8} maxLength={500} placeholder="Collez le secret fourni par la console" value={secret} onChange={(event) => setSecret(event.target.value)} />}
        <span className="help-text">Le secret est chiffré au repos et n’est jamais renvoyé par l’API, même aux administrateurs.</span>
      </div>
      <label className="acct-checkbox full-width"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> <span>Proposer « Continuer avec {provider.name} » sur la page de connexion</span></label>
    </fieldset>
    <div><button className="button button-primary" disabled={pending || (secretMode === 'replace' && !!secret && secret.trim().length < 8)}>{pending ? 'Enregistrement…' : 'Enregistrer'}</button></div>
  </form>;
}

function PolicyForm({ initial }: { initial: PolicyResponse }) {
  const [data, setData] = useState(initial);
  const [requireAdminMfa, setRequireAdminMfa] = useState(initial.policy.require_admin_mfa);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(''); setSuccess('');
    try {
      const result = await api<PolicyResponse>('/auth/admin/policy', { method: 'PUT', body: JSON.stringify({ require_admin_mfa: requireAdminMfa }) });
      setData(result); setRequireAdminMfa(result.policy.require_admin_mfa);
      setSuccess('Politique enregistrée.');
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setPending(false); }
  }
  return <form className="card card-body stack" onSubmit={save} aria-labelledby="auth-policy-title" aria-busy={pending}>
    <h3 id="auth-policy-title" className="acct-title-icon"><ShieldCheck size={18} aria-hidden="true" /> Politique de sécurité</h3>
    <ErrorState message={error} />
    {success && <div className="alert alert-success" role="status">{success}</div>}
    <label className="acct-checkbox"><input type="checkbox" checked={requireAdminMfa} disabled={pending} onChange={(event) => setRequireAdminMfa(event.target.checked)} /> <span>Exiger la double authentification pour les administrateurs</span></label>
    <p className="help-text">Un administrateur sans double authentification garde son compte mais perd ses droits d’administration jusqu’à l’activation. Vous devez l’avoir activée vous-même avant d’imposer cette règle (<Link to="/settings">mes paramètres</Link>). Les membres ne sont pas concernés.</p>
    {data.admins_without_mfa > 0 && <p className="small acct-warning">{data.admins_without_mfa} administrateur{data.admins_without_mfa > 1 ? 's n’ont' : ' n’a'} pas encore activé la double authentification{data.policy.require_admin_mfa ? ' : leurs droits sont suspendus.' : '.'}</p>}
    <div><button className="button button-primary" disabled={pending || requireAdminMfa === data.policy.require_admin_mfa}>{pending ? 'Enregistrement…' : 'Enregistrer la politique'}</button></div>
  </form>;
}

export default function AuthAdmin() {
  const providers = useApi<{ providers: ProviderConfig[] }>('/auth/admin/oauth');
  const policy = useApi<PolicyResponse>('/auth/admin/policy');
  const stats = useApi<{ stats: Stats }>('/auth/admin/stats');
  const error = providers.error || policy.error || stats.error;
  if (error) return <ErrorState message={error} />;
  if (providers.loading || policy.loading || stats.loading || !providers.data || !policy.data || !stats.data) return <Loading />;
  const s = stats.data.stats;
  return <div className="stack acct-admin">
    <div className="stat-grid acct-admin-stats">
      <Stat icon={<Users size={18} />} tone="purple" label="Comptes" value={number.format(s.users)} note={`${number.format(s.passwordless)} sans mot de passe (connexion externe uniquement)`} />
      <Stat icon={<MailCheck size={18} />} tone="green" label="E-mails vérifiés" value={`${percent.format(s.email_verified_pct)} %`} note={`${number.format(s.email_verified)} compte${s.email_verified > 1 ? 's' : ''}`} />
      <Stat icon={<Smartphone size={18} />} tone="blue" label="Double authentification" value={`${percent.format(s.mfa_pct)} %`} note={`${number.format(s.mfa_enabled)} compte${s.mfa_enabled > 1 ? 's' : ''} · ${number.format(s.recovery_codes_low)} avec moins de 3 codes de secours`} />
      <Stat icon={<KeyRound size={18} />} tone="orange" label="Administrateurs protégés" value={`${number.format(s.admins_with_mfa)} / ${number.format(s.admins)}`} note={`GitHub : ${number.format(s.identities.github ?? 0)} · Google : ${number.format(s.identities.google ?? 0)} comptes associés`} />
    </div>
    <PolicyForm initial={policy.data} />
    <div className="stack">
      <div><h2>Connexion avec GitHub et Google</h2><p className="muted small">Flux OAuth 2.0 « authorization code » avec PKCE et paramètre state. Seules les adresses e-mail vérifiées par le fournisseur sont acceptées. Les comptes existants ne sont associés automatiquement que si les deux adresses sont vérifiées.</p></div>
      <div className="acct-admin-providers">{providers.data.providers.map((provider) => <ProviderForm key={provider.id} initial={provider} />)}</div>
    </div>
    <p className="muted small">Les e-mails de vérification et de réinitialisation passent par la file d’envoi configurée dans la section <Link to="/admin/email">E-mails & notifications</Link>.</p>
  </div>;
}
