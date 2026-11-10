import { useEffect, useState } from 'react';
import { Github } from 'lucide-react';
import { api } from '../lib/api';
import '../styles/accounts.css';

export type OAuthProviderId = 'github' | 'google';
export interface OAuthProviderOption { id: OAuthProviderId; name: string }

const oauthErrors: Record<string, string> = {
  access_denied: 'Connexion annulée : l’autorisation n’a pas été accordée chez le fournisseur.',
  state: 'La demande de connexion a expiré ou n’est plus valide. Recommencez depuis Alpha.',
  provider_disabled: 'Ce mode de connexion n’est pas disponible pour le moment.',
  login_required: 'Votre session a expiré : connectez-vous avant d’associer un compte externe.',
  provider_error: 'Le fournisseur de connexion n’a pas répondu correctement. Réessayez dans quelques instants.',
  email_unverified: 'Votre adresse e-mail n’est pas vérifiée chez ce fournisseur. Vérifiez-la chez lui, puis réessayez.',
  account_exists: 'Un compte Alpha utilise déjà cette adresse e-mail. Connectez-vous avec votre mot de passe, puis associez ce compte depuis vos paramètres.',
  identity_taken: 'Ce compte externe est déjà associé à un autre compte Alpha.',
  already_linked: 'Un compte de ce fournisseur est déjà associé à votre profil. Dissociez-le d’abord.',
  restricted: 'L’accès à ce compte est actuellement restreint. Consultez vos e-mails ou contactez la modération.',
};

export function oauthErrorMessage(code: string): string {
  return oauthErrors[code] ?? 'La connexion avec le fournisseur a échoué. Réessayez.';
}

/** Mirrors the server rule: same-site relative paths only, never an API route. */
export function safeNextPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || value.length > 512 || !/^[\x21-\x7e]+$/.test(value)) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /^\/api(\/|$|\?)/.test(value)) return fallback;
  return value;
}

export function oauthStartUrl(provider: OAuthProviderId, mode: 'login' | 'link', redirect: string): string {
  return `/api/auth/oauth/${provider}/start?${new URLSearchParams({ mode, redirect: safeNextPath(redirect) })}`;
}

export function ProviderIcon({ provider }: { provider: OAuthProviderId }) {
  return provider === 'github'
    ? <Github size={17} aria-hidden="true" />
    : <span className="acct-google-mark" aria-hidden="true">G</span>;
}

/** Sign-in buttons for the OAuth providers enabled by the administrators. Renders nothing when none is enabled. */
export default function OAuthButtons({ redirect = '/', disabled = false }: { redirect?: string; disabled?: boolean }) {
  const [providers, setProviders] = useState<OAuthProviderOption[]>([]);
  useEffect(() => {
    let active = true;
    api<{ providers: OAuthProviderOption[] }>('/auth/oauth/providers')
      .then((result) => { if (active) setProviders(result.providers); })
      .catch(() => { if (active) setProviders([]); });
    return () => { active = false; };
  }, []);
  if (!providers.length) return null;
  return <div className="acct-oauth">
    <div className="acct-divider"><span>ou</span></div>
    <div className="acct-oauth-buttons">
      {providers.map((provider) => <a
        key={provider.id}
        className={`button button-secondary full-width acct-oauth-button${disabled ? ' is-disabled' : ''}`}
        href={oauthStartUrl(provider.id, 'login', redirect)}
        aria-disabled={disabled || undefined}
        onClick={(event) => { if (disabled) event.preventDefault(); }}
      ><ProviderIcon provider={provider.id} /> Continuer avec {provider.name}</a>)}
    </div>
    <p className="help-text acct-oauth-terms">
      En continuant avec {providers.map((provider) => provider.name).join(' ou ')}, vous acceptez les{' '}
      <a href="/legal/terms" target="_blank" rel="noopener">conditions générales d’utilisation</a> et la{' '}
      <a href="/legal/privacy" target="_blank" rel="noopener">politique de confidentialité</a> d’Alpha.
      Un compte est créé si votre adresse e-mail n’est pas encore connue.
    </p>
  </div>;
}
