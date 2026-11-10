import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Check, Copy, Download, ExternalLink, Eye, Figma, Github, Gitlab, KeyRound, Link2, Pencil, Plug, Plus, Power, PowerOff,
  RefreshCw, RotateCcw, Save, ScrollText, Send, Trash2, Unplug, Webhook,
} from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import '../styles/integrations.css';

type Provider = 'github' | 'gitlab' | 'linear' | 'figma';
interface Project { id: string; title: string }
interface Integration { id: string; project_id: string; provider: Provider; url: string; created_at: string }
const providers = [
  { id: 'github', name: 'GitHub', hosts: ['github.com'], example: 'https://github.com/collectif/projet', Icon: Github },
  { id: 'gitlab', name: 'GitLab', hosts: ['gitlab.com'], example: 'https://gitlab.com/collectif/projet', Icon: Gitlab },
  { id: 'linear', name: 'Linear', hosts: ['linear.app'], example: 'https://linear.app/equipe', Icon: Link2 },
  { id: 'figma', name: 'Figma', hosts: ['figma.com', 'www.figma.com'], example: 'https://www.figma.com/design/…', Icon: Figma },
] satisfies { id: Provider; name: string; hosts: string[]; example: string; Icon: typeof Github }[];

function safeProviderUrl(provider: (typeof providers)[number], value: string): string | null {
  try {
    const url = new URL(value);
    const authority = /^https:\/\/([^/?#]+)/i.exec(value)?.[1]?.toLowerCase();
    if (value.length > 2000 || /[\u0000-\u0020\u007f\\]/.test(value)
      || url.protocol !== 'https:' || url.username || url.password || url.port
      || !provider.hosts.includes(url.hostname)
      || !provider.hosts.some((host) => authority === host || authority === `${host}:443`)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function IntegrationCard({ project, provider, initial }: {
  project: Project;
  provider: (typeof providers)[number];
  initial?: Integration;
}) {
  const [saved, setSaved] = useState(initial);
  const [url, setUrl] = useState(initial?.url ?? '');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const safeLink = saved ? safeProviderUrl(provider, saved.url) : null;
  const { Icon } = provider;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(''); setMessage('');
    const validated = safeProviderUrl(provider, url.trim());
    if (!validated) {
      setError(`Saisissez une URL HTTPS sans identifiants sur ${provider.hosts.join(' ou ')}.`);
      return;
    }
    setPending('save');
    try {
      const result = await api<{ integration: Integration }>('/integrations', {
        method: 'POST',
        body: JSON.stringify({ project_id: project.id, provider: provider.id, url: validated }),
      });
      setSaved(result.integration);
      setUrl(result.integration.url);
      setMessage('Lien enregistré. Aucune synchronisation n’est effectuée.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!saved || pending) return;
    setPending('delete'); setError(''); setMessage('');
    try {
      await api<{ deleted: boolean }>(`/integrations/${encodeURIComponent(saved.id)}`, { method: 'DELETE' });
      setSaved(undefined);
      setUrl('');
      setMessage('Lien supprimé de ce projet.');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  return <article className="card">
    <div className="card-header">
      <div className="row gap-sm"><Icon size={24} aria-hidden="true" /><h3>{provider.name}</h3></div>
      <Badge tone={saved ? 'green' : 'neutral'}>{saved ? 'Lien enregistré' : 'Non configuré'}</Badge>
    </div>
    <div className="card-body stack">
      <p className="muted small">Enregistrez un raccourci vers votre espace {provider.name}, sans connexion à votre compte externe.</p>
      {saved && <div className="stack">
        <p className="small" style={{ overflowWrap: 'anywhere' }}>{saved.url}</p>
        {safeLink
          ? <a className="button button-secondary button-small" href={safeLink} target="_blank" rel="noreferrer">Ouvrir le lien <ExternalLink size={15} aria-hidden="true" /></a>
          : <ErrorState message="Ce lien enregistré n’est pas sûr. Remplacez-le ou supprimez-le." />}
      </div>}
      <form className="form" onSubmit={save} aria-busy={pending !== null}>
        <div className="field">
          <label htmlFor={`integration-${provider.id}`}>Lien {provider.name}</label>
          <input id={`integration-${provider.id}`} type="url" required maxLength={2000}
            value={url} onChange={(event) => setUrl(event.target.value)} disabled={pending !== null}
            placeholder={provider.example} aria-describedby={`integration-help-${provider.id}`} />
          <p id={`integration-help-${provider.id}`} className="help-text">HTTPS uniquement · {provider.hosts.join(' ou ')}. Ne saisissez aucun jeton ni secret dans l’URL.</p>
        </div>
        <ErrorState message={error} />
        {message && <p className="small text-success" role="status">{message}</p>}
        <div className="row gap-sm">
          <button className="button button-primary button-small" type="submit" disabled={pending !== null}>
            <Save size={16} aria-hidden="true" />{pending === 'save' ? 'Enregistrement…' : saved ? 'Mettre à jour le lien' : 'Enregistrer le lien'}
          </button>
          {saved && <button className="button button-danger button-small" type="button" onClick={() => void remove()} disabled={pending !== null}>
            <Trash2 size={16} aria-hidden="true" />{pending === 'delete' ? 'Suppression…' : 'Supprimer'}
          </button>}
        </div>
      </form>
    </div>
  </article>;
}

// ---------------------------------------------------------------------------------------------
// V4 — connected accounts, project sources (inbound webhooks) and outgoing webhooks
// ---------------------------------------------------------------------------------------------

type SourceProvider = 'github' | 'gitlab' | 'figma';
type Flash = { tone: 'success' | 'error'; message: string } | null;
interface ApiState<T> { data: T | null; loading: boolean; error: string; reload: () => void }
interface Connection {
  id: string; provider: SourceProvider; label: string; base_url: string; external_id: string; external_login: string;
  scopes: string[]; private_access: boolean; expires_at: string | null; needs_reconnect: boolean; created_at: string; updated_at: string;
}
interface ProviderStatus { provider: SourceProvider; label: string; enabled: boolean; base_url: string; supports_private: boolean; connection: Connection | null }
interface Source {
  id: string; project_id: string; provider: SourceProvider; label: string; external_id: string; full_name: string; url: string;
  default_branch: string; setup: 'automatic' | 'manual'; inbound_url: string; created_at: string; last_event_at: string | null;
}
type InboundStatus = 'received' | 'processed' | 'ignored' | 'failed';
interface InboundEvent { id: string; provider: SourceProvider; event_type: string; status: InboundStatus; summary: string; received_at: string; full_name: string | null }
interface SourceSetup { mode: 'automatic' | 'manual'; url: string; secret?: string; reason?: string | null; instructions?: string[] }
interface Repo { external_id: string; full_name: string; url: string; private: boolean; default_branch: string; can_admin: boolean }
interface CatalogEvent { type: string; group: string; label: string }
interface WebhookSettings { enabled: boolean; max_endpoints_per_project: number }
interface Catalog { events: CatalogEvent[]; signature: { header: string; format: string; tolerance_seconds: number }; settings: WebhookSettings }
interface Endpoint {
  id: string; project_id: string; url: string; description: string; events: string[]; active: boolean; consecutive_failures: number;
  disabled_reason: string; last_success_at: string | null; last_failure_at: string | null; secret: { configured: boolean; rotating: boolean };
  created_at: string; updated_at: string;
}
type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead';
interface Delivery {
  id: string; endpoint_id: string; event_id: string; event_type: string; status: DeliveryStatus; attempts: number;
  next_attempt_at: string | null; response_status: number | null; last_error: string; duration_ms: number | null;
  redelivery_of: string | null; created_at: string; updated_at: string;
}
interface EndpointInput { url: string; description: string; events: string[] }
interface ShownSecret { title: string; value: string; note?: string }

const sourceProviders: { id: SourceProvider; name: string; Icon: typeof Github; pitch: string }[] = [
  { id: 'github', name: 'GitHub', Icon: Github, pitch: 'Choisissez un dépôt : ses push sur la branche par défaut et ses releases publiées remontent dans le projet.' },
  { id: 'gitlab', name: 'GitLab', Icon: Gitlab, pitch: 'Choisissez un projet (gitlab.com ou instance auto-hébergée) : push, tags et releases remontent dans le projet.' },
  { id: 'figma', name: 'Figma', Icon: Figma, pitch: 'Liez un fichier Figma : les nouvelles versions et les commentaires remontent dans le projet.' },
];
const providerName = (provider: string) => sourceProviders.find((item) => item.id === provider)?.name ?? provider;
const callbackErrors: Record<string, string> = {
  session: 'Votre session a expiré pendant la connexion. Reconnectez-vous à Alpha puis recommencez.',
  state: 'La demande de connexion a expiré ou n’est plus valide. Recommencez depuis cette page.',
  denied: 'L’autorisation a été refusée sur le service externe. Aucun compte n’a été connecté.',
  exchange: 'Le service externe n’a pas confirmé la connexion. Réessayez dans quelques instants.',
  disabled: 'Ce service n’est pas activé sur cette instance d’Alpha.',
};
const deliveryTone: Record<DeliveryStatus, string> = { pending: 'blue', delivering: 'blue', succeeded: 'green', failed: 'orange', dead: 'red' };
const deliveryLabel: Record<DeliveryStatus, string> = { pending: 'En attente', delivering: 'En cours', succeeded: 'Réussie', failed: 'Échec, nouvel essai prévu', dead: 'Abandonnée' };
const inboundTone: Record<InboundStatus, string> = { received: 'blue', processed: 'green', ignored: 'neutral', failed: 'red' };
const inboundLabel: Record<InboundStatus, string> = { received: 'Reçu', processed: 'Traité', ignored: 'Ignoré', failed: 'Erreur' };

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function callbackNotice(params: URLSearchParams): Flash {
  const connected = params.get('connected');
  const failure = params.get('integration_error');
  if (connected && sourceProviders.some((item) => item.id === connected)) return { tone: 'success', message: `Compte ${providerName(connected)} connecté.` };
  if (failure) return { tone: 'error', message: callbackErrors[failure] ?? 'La connexion n’a pas abouti. Réessayez.' };
  return null;
}

function FlashMessage({ flash }: { flash: Flash }) {
  return <div aria-live="polite">
    {flash && <div className={`alert alert-${flash.tone}`} role={flash.tone === 'error' ? 'alert' : 'status'}>{flash.message}</div>}
  </div>;
}

function CopyField({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied('ok');
    } catch {
      setCopied('fail');
    }
  }
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="intg-copy">
      <input id={id} readOnly value={value} spellCheck={false} autoComplete="off" onFocus={(event) => event.currentTarget.select()} />
      <button className="button button-secondary button-small" type="button" onClick={() => void copy()}>
        {copied === 'ok' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}{copied === 'ok' ? 'Copié' : 'Copier'}
      </button>
    </div>
    <span className="help-text" aria-live="polite">
      {copied === 'fail' ? 'Copie impossible : sélectionnez le texte puis copiez-le manuellement.' : copied === 'ok' ? `${label} copié dans le presse-papiers.` : ''}
    </span>
  </div>;
}

/** Secrets are returned once by the API: this panel is the only place they are ever displayed. */
function OneTimeSecret({ title, secret, url, reason, instructions, note, onDismiss }: {
  title: string; secret?: string; url?: string; reason?: string | null; instructions?: string[]; note?: string; onDismiss: () => void;
}) {
  return <section className="intg-secret" aria-label={title}>
    <h3>{title}</h3>
    {reason && <p className="small">{reason}</p>}
    {instructions && instructions.length > 0 && <ol>{instructions.map((step, index) => <li key={index}>{step}</li>)}</ol>}
    {url && <CopyField label="URL de réception" value={url} />}
    {secret && <CopyField label="Secret" value={secret} />}
    {note && <p className="small">{note}</p>}
    {secret && <p className="help-text">Ce secret ne sera plus jamais affiché. Conservez-le dans un gestionnaire de secrets ; en cas de perte, régénérez-le.</p>}
    <div><button className="button button-secondary button-small" type="button" onClick={onDismiss}>{secret ? 'J’ai copié le secret' : 'Fermer'}</button></div>
  </section>;
}

// ----- Connected accounts --------------------------------------------------------------------

function AccountCard({ status, returnTo, onNotice, onChanged }: {
  status: ProviderStatus; returnTo: string; onNotice: (flash: Flash) => void; onChanged: () => void;
}) {
  const [pending, setPending] = useState<'public' | 'private' | 'disconnect' | null>(null);
  const meta = sourceProviders.find((item) => item.id === status.provider);
  const Icon = meta?.Icon ?? Plug;
  const { connection } = status;

  async function connect(access: 'public' | 'private') {
    if (pending) return;
    setPending(access);
    onNotice(null);
    try {
      const params = new URLSearchParams({ access, return_to: returnTo });
      const { authorize_url: authorizeUrl } = await api<{ authorize_url: string }>(`/integrations/oauth/${status.provider}/start?${params}`);
      const target = safeHttpUrl(authorizeUrl);
      if (!target) throw new Error('Adresse d’autorisation invalide.');
      window.location.assign(target);
    } catch (error) {
      onNotice({ tone: 'error', message: errorMessage(error) });
      setPending(null);
    }
  }

  async function disconnect() {
    if (!connection || pending) return;
    if (!window.confirm(`Déconnecter votre compte ${status.label} ? Les webhooks déjà créés continuent de fonctionner, mais Alpha ne pourra plus lister vos ${status.provider === 'figma' ? 'fichiers' : 'dépôts'} ni créer de webhook.`)) return;
    setPending('disconnect');
    onNotice(null);
    try {
      const result = await api<{ revoked_at_provider: boolean; manual_revocation_required: boolean }>(
        `/integrations/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
      onNotice({
        tone: 'success',
        message: result.manual_revocation_required
          ? `Compte ${status.label} déconnecté et jetons supprimés d’Alpha. L’accès n’a pas pu être révoqué automatiquement : retirez aussi Alpha des applications autorisées dans les paramètres de votre compte ${status.label}.`
          : `Compte ${status.label} déconnecté : l’accès a été révoqué chez ${status.label}.`,
      });
      onChanged();
    } catch (error) {
      onNotice({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  const canConnect = status.enabled && (!connection || connection.needs_reconnect);
  const canUpgrade = status.enabled && status.supports_private && !!connection && !connection.private_access && !connection.needs_reconnect;
  return <article className="card card-body intg-account" aria-busy={pending !== null}>
    <div className="row-between">
      <div className="intg-account-title"><Icon size={22} aria-hidden="true" /><h3>{status.label}</h3></div>
      {connection
        ? <Badge tone={connection.needs_reconnect ? 'orange' : 'green'}>{connection.needs_reconnect ? 'À reconnecter' : 'Connecté'}</Badge>
        : <Badge tone="neutral">{status.enabled ? 'Non connecté' : 'Indisponible'}</Badge>}
    </div>
    {connection
      ? <div className="stack small" style={{ gap: 6 }}>
        <p>Compte <strong>{connection.external_login || connection.external_id}</strong>{status.provider === 'gitlab' && <> sur <span className="intg-mono">{connection.base_url}</span></>}</p>
        {status.supports_private && <p className="muted">{connection.private_access ? 'Accès aux dépôts privés autorisé.' : 'Dépôts publics uniquement.'}</p>}
        <p className="muted">Autorisations : <span className="intg-mono">{connection.scopes.join(', ') || '—'}</span></p>
        <p className="muted">Connecté le {dateTime(connection.created_at)}</p>
        {connection.needs_reconnect && <p>Le service a refusé le jeton ou son renouvellement a échoué : reconnectez le compte.</p>}
      </div>
      : <p className="muted small">{status.enabled ? meta?.pitch : 'L’administrateur n’a pas encore configuré ce service sur cette instance.'}</p>}
    <div className="intg-account-actions">
      {canConnect && <button className="button button-primary button-small" type="button" disabled={pending !== null}
        onClick={() => void connect(connection?.private_access ? 'private' : 'public')}>
        <Plug size={15} aria-hidden="true" />{pending === 'public' || pending === 'private' ? 'Redirection…' : connection ? 'Reconnecter' : `Connecter ${status.label}`}
      </button>}
      {status.enabled && status.supports_private && !connection && <button className="button button-secondary button-small" type="button"
        disabled={pending !== null} onClick={() => void connect('private')}>Inclure les dépôts privés</button>}
      {canUpgrade && <button className="button button-secondary button-small" type="button" disabled={pending !== null}
        onClick={() => void connect('private')}>{pending === 'private' ? 'Redirection…' : 'Autoriser les dépôts privés'}</button>}
      {connection && <button className="button button-danger button-small" type="button" disabled={pending !== null} onClick={() => void disconnect()}>
        <Unplug size={15} aria-hidden="true" />{pending === 'disconnect' ? 'Déconnexion…' : 'Déconnecter'}
      </button>}
    </div>
  </article>;
}

function ConnectedAccounts({ state, notice, onNotice, returnTo }: {
  state: ApiState<{ providers: ProviderStatus[] }>; notice: Flash; onNotice: (flash: Flash) => void; returnTo: string;
}) {
  return <section className="card" aria-labelledby="intg-accounts-title">
    <div className="card-header">
      <h2 id="intg-accounts-title">Comptes connectés</h2>
      <button className="button button-secondary button-small" type="button" onClick={state.reload} disabled={state.loading}>
        <RefreshCw size={14} aria-hidden="true" />Actualiser
      </button>
    </div>
    <div className="card-body stack">
      <p className="muted small">Connectez vos comptes pour choisir un dépôt ou un fichier dans une liste et créer les webhooks automatiquement. Alpha ne lit ni ne modifie votre code ; les jetons sont chiffrés et ne sont jamais affichés. Les droits demandés sont limités à la lecture de votre profil et des dépôts, et à la gestion des webhooks.</p>
      <FlashMessage flash={notice} />
      {state.loading ? <Loading /> : state.error
        ? <div className="stack"><ErrorState message={state.error} /><div><button className="button button-secondary button-small" type="button" onClick={state.reload}>Réessayer</button></div></div>
        : <div className="intg-accounts">
          {(state.data?.providers ?? []).map((status) => <AccountCard key={status.provider} status={status} returnTo={returnTo}
            onNotice={onNotice} onChanged={state.reload} />)}
        </div>}
    </div>
  </section>;
}

// ----- Project sources -----------------------------------------------------------------------

function parseSourceReference(provider: SourceProvider, raw: string): { full_name?: string; external_id?: string; file_key?: string } | null {
  const value = raw.trim();
  if (!value || value.length > 500) return null;
  if (provider === 'figma') {
    const fromUrl = /figma\.com\/(?:file|design|proto|board|slides|deck|make)\/([a-zA-Z0-9]{10,64})/.exec(value)?.[1];
    const key = fromUrl ?? (/^[a-zA-Z0-9]{10,64}$/.test(value) ? value : null);
    return key ? { file_key: key } : null;
  }
  if (/^\d{1,20}$/.test(value)) return { external_id: value };
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    try { path = new URL(value).pathname; } catch { return null; }
  }
  path = (path.split('/-/')[0] ?? '').replace(/\.git\/?$/i, '');
  const segments = path.split('/').filter(Boolean);
  const name = (provider === 'github' ? segments.slice(0, 2) : segments).join('/');
  if (!/^[\w.-]+(\/[\w.-]+)+$/.test(name) || name.split('/').some((segment) => /^\.+$/.test(segment))) return null;
  return { full_name: name };
}

function RepoPicker({ provider, disabled, onPick }: { provider: 'github' | 'gitlab'; disabled: boolean; onPick: (repo: Repo) => void }) {
  const searchId = useId();
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const path = provider === 'github'
    ? `/integrations/github/repos?page=${page}`
    : `/integrations/gitlab/projects?page=${page}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
  const repos = useApi<{ items: Repo[]; has_more: boolean }>(path);
  const noun = provider === 'github' ? 'dépôt' : 'projet';

  return <div className="stack">
    {provider === 'gitlab' && <form className="intg-inline" role="search" onSubmit={(event) => { event.preventDefault(); setPage(1); setSearch(draft.trim()); }}>
      <div className="field">
        <label htmlFor={searchId}>Rechercher un projet</label>
        <input id={searchId} type="search" maxLength={100} value={draft} onChange={(event) => setDraft(event.target.value)} />
      </div>
      <button className="button button-secondary button-small" type="submit">Rechercher</button>
    </form>}
    {repos.loading ? <Loading /> : repos.error
      ? <div className="stack"><ErrorState message={repos.error} /><div><button className="button button-secondary button-small" type="button" onClick={repos.reload}>Réessayer</button></div></div>
      : !repos.data?.items.length
        ? <p className="muted small">Aucun {noun} trouvé{search ? ' pour cette recherche' : ''}.</p>
        : <ul className="intg-repos" aria-label={provider === 'github' ? 'Vos dépôts GitHub' : 'Vos projets GitLab'}>
          {repos.data.items.map((repo) => <li key={repo.external_id} className="intg-repo">
            <span className="row gap-sm" style={{ flexWrap: 'wrap' }}>
              <strong>{repo.full_name}</strong>
              {repo.private && <Badge tone="purple">Privé</Badge>}
              {provider === 'github' && !repo.can_admin && <Badge tone="orange">Webhook à configurer vous-même</Badge>}
            </span>
            <button className="button button-secondary button-small" type="button" disabled={disabled} onClick={() => onPick(repo)} aria-label={`Lier ${repo.full_name}`}>
              <Plus size={14} aria-hidden="true" />Lier
            </button>
          </li>)}
        </ul>}
    {(page > 1 || !!repos.data?.has_more) && <div className="row gap-sm">
      <button className="button button-secondary button-small" type="button" disabled={page === 1 || repos.loading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Page précédente</button>
      <span className="small muted">Page {page}</span>
      <button className="button button-secondary button-small" type="button" disabled={!repos.data?.has_more || repos.loading} onClick={() => setPage((value) => value + 1)}>Page suivante</button>
    </div>}
  </div>;
}

function AddSource({ projectId, providers, onCreated }: {
  projectId: string; providers: ProviderStatus[]; onCreated: (result: { source: Source; setup: SourceSetup }) => void;
}) {
  const ids = useId();
  const [provider, setProvider] = useState<SourceProvider>('github');
  const [reference, setReference] = useState('');
  const [manual, setManual] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const status = providers.find((item) => item.provider === provider);
  const connection = status?.connection ?? null;
  const meta = sourceProviders.find((item) => item.id === provider) ?? sourceProviders[0]!;

  async function create(body: Record<string, unknown>) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      const result = await api<{ source: Source; setup: SourceSetup }>(`/integrations/projects/${encodeURIComponent(projectId)}/sources`, {
        method: 'POST',
        body: JSON.stringify({ provider, ...body, ...(manual && connection ? { manual: true } : {}) }),
      });
      setReference('');
      setBrowse(false);
      onCreated(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseSourceReference(provider, reference);
    if (!parsed) {
      setError(provider === 'figma'
        ? 'Collez le lien du fichier Figma ou sa clé (10 à 64 lettres et chiffres).'
        : `Indiquez le ${provider === 'github' ? 'dépôt au format propriétaire/nom' : 'projet au format groupe/nom'} ou collez son URL.`);
      return;
    }
    void create(parsed);
  }

  return <section className="card" aria-labelledby={`${ids}-title`}>
    <div className="card-header"><h2 id={`${ids}-title`}>Lier une source</h2></div>
    <div className="card-body stack">
      <div className="field">
        <label htmlFor={`${ids}-provider`}>Service</label>
        <select id={`${ids}-provider`} value={provider} disabled={pending} onChange={(event) => {
          setProvider(event.target.value as SourceProvider); setReference(''); setBrowse(false); setError('');
        }}>
          {sourceProviders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <p className="help-text">{meta.pitch}</p>
      </div>
      {connection
        ? <p className="small">Compte {meta.name} connecté : <strong>{connection.external_login || connection.external_id}</strong>. {provider === 'figma'
          ? 'Les webhooks Figma sont créés automatiquement si votre compte peut gérer les webhooks du fichier ; sinon, des instructions vous sont fournies.'
          : 'Le webhook est créé automatiquement si votre compte en a les droits ; sinon, des instructions vous sont fournies.'}</p>
        : <p className="small muted">{status?.enabled
          ? `Connectez votre compte ${meta.name} (section « Comptes connectés ») pour choisir dans une liste et créer le webhook automatiquement. Sans connexion, vous configurerez le webhook vous-même.`
          : `Vous configurerez le webhook vous-même chez ${meta.name} à l’aide des instructions et du secret affichés après la liaison.`}</p>}
      {connection && provider !== 'figma' && <div className="stack">
        <div>
          <button className="button button-secondary button-small" type="button" aria-expanded={browse} onClick={() => setBrowse((value) => !value)}>
            {browse ? 'Masquer la liste' : provider === 'github' ? 'Parcourir mes dépôts' : 'Parcourir mes projets'}
          </button>
        </div>
        {browse && <RepoPicker key={provider} provider={provider} disabled={pending} onPick={(repo) => void create({ external_id: repo.external_id })} />}
      </div>}
      <form className="form" onSubmit={submit} aria-busy={pending}>
        <div className="field">
          <label htmlFor={`${ids}-reference`}>{provider === 'figma' ? 'Lien ou clé du fichier Figma' : provider === 'github' ? 'Dépôt (propriétaire/nom ou URL)' : 'Projet (groupe/nom ou URL)'}</label>
          <input id={`${ids}-reference`} required maxLength={500} value={reference} disabled={pending} autoComplete="off" spellCheck={false}
            onChange={(event) => setReference(event.target.value)}
            placeholder={provider === 'figma' ? 'https://www.figma.com/design/…' : provider === 'github' ? 'collectif/projet' : 'groupe/sous-groupe/projet'} />
        </div>
        {connection && <label className="intg-checkbox">
          <input type="checkbox" checked={manual} disabled={pending} onChange={(event) => setManual(event.target.checked)} />
          <span>Je configure le webhook moi-même (instructions et secret affichés une seule fois)</span>
        </label>}
        <ErrorState message={error} />
        <div>
          <button className="button button-primary button-small" type="submit" disabled={pending}>
            <Plus size={16} aria-hidden="true" />{pending ? 'Liaison…' : 'Lier la source'}
          </button>
        </div>
      </form>
    </div>
  </section>;
}

function ProjectSources({ projectId, providers }: { projectId: string; providers: ProviderStatus[] }) {
  const base = `/integrations/projects/${encodeURIComponent(projectId)}/sources`;
  const data = useApi<{ sources: Source[]; inbound_events: InboundEvent[] }>(base);
  const [setup, setSetup] = useState<{ title: string; source: Source; setup: SourceSetup } | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [pending, setPending] = useState<string | null>(null);

  function created(result: { source: Source; setup: SourceSetup }) {
    setFlash(result.setup.mode === 'automatic'
      ? { tone: 'success', message: `${result.source.full_name} est lié : le webhook a été créé chez ${providerName(result.source.provider)}.` }
      : null);
    setSetup(result.setup.mode === 'manual' ? { title: `Configurez le webhook de ${result.source.full_name}`, ...result } : null);
    data.reload();
  }

  async function rotate(source: Source) {
    if (pending) return;
    if (!window.confirm(`Générer un nouveau secret pour ${source.full_name} ? L’ancien cesse immédiatement d’être accepté : mettez à jour le webhook chez ${providerName(source.provider)}.`)) return;
    setPending(source.id);
    setFlash(null);
    try {
      const result = await api<{ source: Source; setup: SourceSetup }>(`${base}/${encodeURIComponent(source.id)}/rotate-secret`, { method: 'POST', body: JSON.stringify({}) });
      setSetup({ title: `Nouveau secret pour ${source.full_name}`, ...result });
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  async function remove(source: Source) {
    if (pending) return;
    if (!window.confirm(`Délier ${source.full_name} de ce projet ? Les événements envoyés par ${providerName(source.provider)} ne seront plus acceptés.`)) return;
    setPending(source.id);
    setFlash(null);
    try {
      const result = await api<{ provider_webhook_removed: boolean; manual_cleanup: boolean }>(`${base}/${encodeURIComponent(source.id)}`, { method: 'DELETE' });
      const name = providerName(source.provider);
      setFlash({
        tone: 'success',
        message: result.provider_webhook_removed
          ? `${source.full_name} est délié et son webhook a été supprimé chez ${name}.`
          : result.manual_cleanup
            ? `${source.full_name} est délié, mais le webhook n’a pas pu être supprimé chez ${name} : supprimez-le manuellement.`
            : `${source.full_name} est délié. Supprimez aussi le webhook que vous aviez configuré chez ${name}.`,
      });
      if (setup?.source.id === source.id) setSetup(null);
      data.reload();
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  const sources = data.data?.sources ?? [];
  const events = data.data?.inbound_events ?? [];
  return <div className="stack">
    <AddSource projectId={projectId} providers={providers} onCreated={created} />
    <FlashMessage flash={flash} />
    {setup && <OneTimeSecret title={setup.title} reason={setup.setup.reason} instructions={setup.setup.instructions}
      url={setup.setup.url} secret={setup.setup.secret} onDismiss={() => setSetup(null)} />}
    <section className="card" aria-labelledby="intg-sources-title">
      <div className="card-header">
        <h2 id="intg-sources-title">Sources liées</h2>
        <button className="button button-secondary button-small" type="button" onClick={data.reload} disabled={data.loading}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>
      </div>
      <div className="card-body">
        {data.loading ? <Loading /> : data.error ? <ErrorState message={data.error} /> : !sources.length
          ? <EmptyState title="Aucune source liée" description="Liez un dépôt GitHub ou GitLab, ou un fichier Figma, pour annoncer automatiquement les nouvelles versions aux testeurs." />
          : <ul className="list" aria-label="Sources liées">
            {sources.map((source) => {
              const meta = sourceProviders.find((item) => item.id === source.provider);
              const Icon = meta?.Icon ?? Link2;
              const link = safeHttpUrl(source.url);
              return <li key={source.id} className="intg-item">
                <div className="intg-item-head">
                  <div className="intg-item-title">
                    <Icon size={18} aria-hidden="true" /><strong>{source.full_name}</strong>
                    <Badge tone={source.setup === 'automatic' ? 'green' : 'blue'}>{source.setup === 'automatic' ? 'Webhook automatique' : 'Webhook manuel'}</Badge>
                  </div>
                  <div className="intg-actions">
                    {link && <a className="button button-ghost button-small" href={link} target="_blank" rel="noreferrer noopener">Ouvrir <ExternalLink size={14} aria-hidden="true" /></a>}
                    {source.setup === 'manual' && <button className="button button-secondary button-small" type="button" disabled={pending !== null} onClick={() => void rotate(source)}>
                      <KeyRound size={14} aria-hidden="true" />{pending === source.id ? 'Patientez…' : 'Nouveau secret'}
                    </button>}
                    <button className="button button-danger button-small" type="button" disabled={pending !== null} onClick={() => void remove(source)}>
                      <Trash2 size={14} aria-hidden="true" />Délier
                    </button>
                  </div>
                </div>
                <div className="intg-meta">
                  <span>{providerName(source.provider)}</span>
                  {source.default_branch && <span>Branche par défaut : {source.default_branch}</span>}
                  <span>Liée le {dateTime(source.created_at)}</span>
                  <span>{source.last_event_at ? `Dernier événement : ${dateTime(source.last_event_at)}` : 'Aucun événement reçu pour l’instant'}</span>
                </div>
                {source.setup === 'manual' && <details>
                  <summary className="small">URL de réception du webhook</summary>
                  <CopyField label="URL de réception" value={source.inbound_url} />
                </details>}
              </li>;
            })}
          </ul>}
      </div>
    </section>
    <section className="card" aria-labelledby="intg-inbound-title">
      <div className="card-header"><h2 id="intg-inbound-title">Événements reçus récemment</h2></div>
      <div className="card-body">
        {data.loading ? <Loading /> : !events.length
          ? <p className="muted small">Aucun événement reçu. Les push sur la branche par défaut, les releases, les tags et les versions Figma apparaîtront ici.</p>
          : <div className="table-wrap"><table className="data-table" aria-label="Événements reçus">
            <thead><tr><th scope="col">Reçu le</th><th scope="col">Source</th><th scope="col">Événement</th><th scope="col">Résumé</th><th scope="col">Statut</th></tr></thead>
            <tbody>{events.map((event) => <tr key={event.id}>
              <td>{dateTime(event.received_at)}</td>
              <td>{providerName(event.provider)}{event.full_name ? ` · ${event.full_name}` : ''}</td>
              <td><code>{event.event_type}</code></td>
              <td>{event.summary || '—'}</td>
              <td><Badge tone={inboundTone[event.status]}>{inboundLabel[event.status]}</Badge></td>
            </tr>)}</tbody>
          </table></div>}
      </div>
    </section>
  </div>;
}

// ----- Outgoing webhooks ---------------------------------------------------------------------

function EventPicker({ events, value, onChange, disabled }: { events: CatalogEvent[]; value: string[]; onChange: (next: string[]) => void; disabled: boolean }) {
  const idPrefix = useId();
  const groups = useMemo(() => [...new Set(events.map((event) => event.group))]
    .map((group) => ({ group, items: events.filter((event) => event.group === group) })), [events]);
  const selected = new Set(value);
  const update = (types: string[], checked: boolean) => {
    const next = new Set(value);
    for (const type of types) {
      if (checked) next.add(type); else next.delete(type);
    }
    onChange([...next]);
  };
  return <div className="stack" role="group" aria-label="Événements à envoyer">
    {groups.map(({ group, items }) => {
      const allSelected = items.every((item) => selected.has(item.type));
      return <fieldset key={group} className="intg-check-group" disabled={disabled}>
        <legend>{group}</legend>
        <div>
          <button type="button" className="button button-ghost button-small" onClick={() => update(items.map((item) => item.type), !allSelected)}>
            {allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
          </button>
        </div>
        <div className="intg-checks">
          {items.map((item) => <label key={item.type} className="intg-checkbox" htmlFor={`${idPrefix}-${item.type}`}>
            <input id={`${idPrefix}-${item.type}`} type="checkbox" checked={selected.has(item.type)} onChange={(event) => update([item.type], event.target.checked)} />
            <span>{item.label}<br /><code>{item.type}</code></span>
          </label>)}
        </div>
      </fieldset>;
    })}
  </div>;
}

function EndpointForm({ events, initial, submitLabel, onSubmit, onCancel }: {
  events: CatalogEvent[]; initial?: Endpoint; submitLabel: string; onSubmit: (input: EndpointInput) => Promise<void>; onCancel: () => void;
}) {
  const ids = useId();
  const [url, setUrl] = useState(initial?.url ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [selected, setSelected] = useState<string[]>(initial?.events ?? []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const trimmed = url.trim();
    if (!safeHttpUrl(trimmed)) { setError('Saisissez une URL complète, par exemple https://exemple.fr/webhooks/alpha.'); return; }
    if (!selected.length) { setError('Choisissez au moins un événement.'); return; }
    setPending(true);
    setError('');
    try {
      await onSubmit({ url: trimmed, description: description.trim(), events: selected });
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(false);
    }
  }

  return <form className="form" onSubmit={submit} aria-busy={pending}>
    <div className="form-grid">
      <div className="field">
        <label htmlFor={`${ids}-url`}>URL de destination</label>
        <input id={`${ids}-url`} type="url" required maxLength={2000} value={url} disabled={pending} autoComplete="off" spellCheck={false}
          placeholder="https://exemple.fr/webhooks/alpha" aria-describedby={`${ids}-url-help`} onChange={(event) => setUrl(event.target.value)} />
        <p id={`${ids}-url-help`} className="help-text">HTTPS obligatoire en production (ports 443, 80 ou 8443). Les adresses locales, privées et réservées sont refusées. N’incluez pas de jeton dans l’URL : vérifiez plutôt la signature.</p>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-description`}>Description (facultative)</label>
        <input id={`${ids}-description`} maxLength={200} value={description} disabled={pending} onChange={(event) => setDescription(event.target.value)} placeholder="Ex. : pipeline de déploiement" />
      </div>
    </div>
    <EventPicker events={events} value={selected} onChange={setSelected} disabled={pending} />
    <ErrorState message={error} />
    <div className="row gap-sm">
      <button className="button button-primary button-small" type="submit" disabled={pending}><Save size={15} aria-hidden="true" />{pending ? 'Vérification de l’URL…' : submitLabel}</button>
      <button className="button button-ghost button-small" type="button" disabled={pending} onClick={onCancel}>Annuler</button>
    </div>
  </form>;
}

function DeliveryLog({ endpointId, endpointActive, revision }: { endpointId: string; endpointActive: boolean; revision: number }) {
  const ids = useId();
  const [status, setStatus] = useState<DeliveryStatus | ''>('');
  const [offset, setOffset] = useState(0);
  const [flash, setFlash] = useState<Flash>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ delivery: Delivery; payload: unknown } | null>(null);
  const log = useApi<{ deliveries: Delivery[]; has_more: boolean }>(
    `/integrations/endpoints/${encodeURIComponent(endpointId)}/deliveries?offset=${offset}${status ? `&status=${status}` : ''}`);
  const reload = useRef(log.reload);
  reload.current = log.reload;
  useEffect(() => { if (revision) reload.current(); }, [revision]);

  async function view(delivery: Delivery) {
    if (pending) return;
    setPending(delivery.id);
    setFlash(null);
    try {
      const result = await api<{ delivery: Delivery & { payload: unknown } }>(`/integrations/deliveries/${encodeURIComponent(delivery.id)}`);
      setViewing({ delivery: result.delivery, payload: result.delivery.payload });
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  async function redeliver(delivery: Delivery) {
    if (pending) return;
    setPending(delivery.id);
    setFlash(null);
    try {
      const result = await api<{ delivery: Delivery }>(`/integrations/deliveries/${encodeURIComponent(delivery.id)}/redeliver`, { method: 'POST', body: JSON.stringify({}) });
      setFlash({ tone: result.delivery.status === 'succeeded' ? 'success' : 'error', message: `Livraison renvoyée : ${deliveryLabel[result.delivery.status].toLowerCase()}${result.delivery.response_status ? ` (HTTP ${result.delivery.response_status})` : ''}.` });
      log.reload();
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  return <div className="stack">
    <div className="intg-filters">
      <div className="field">
        <label htmlFor={`${ids}-status`}>Statut</label>
        <select id={`${ids}-status`} value={status} onChange={(event) => { setStatus(event.target.value as DeliveryStatus | ''); setOffset(0); }}>
          <option value="">Tous</option>
          {(Object.keys(deliveryLabel) as DeliveryStatus[]).map((value) => <option key={value} value={value}>{deliveryLabel[value]}</option>)}
        </select>
      </div>
      <button className="button button-secondary button-small" type="button" onClick={log.reload} disabled={log.loading}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>
    </div>
    <FlashMessage flash={flash} />
    {log.loading ? <Loading /> : log.error ? <ErrorState message={log.error} /> : !log.data?.deliveries.length
      ? <p className="muted small">Aucune livraison{status ? ' avec ce statut' : ''}.</p>
      : <div className="table-wrap"><table className="data-table" aria-label="Journal des livraisons">
        <thead><tr><th scope="col">Date</th><th scope="col">Événement</th><th scope="col">Statut</th><th scope="col">Tentatives</th><th scope="col">Réponse</th><th scope="col">Détail</th><th scope="col">Actions</th></tr></thead>
        <tbody>{log.data.deliveries.map((delivery) => <tr key={delivery.id}>
          <td>{dateTime(delivery.created_at)}{delivery.redelivery_of && <><br /><span className="small muted">Renvoi</span></>}</td>
          <td><code>{delivery.event_type}</code></td>
          <td><Badge tone={deliveryTone[delivery.status]}>{deliveryLabel[delivery.status]}</Badge></td>
          <td>{delivery.attempts}</td>
          <td>{delivery.response_status ? `HTTP ${delivery.response_status}` : '—'}{delivery.duration_ms !== null && <span className="small muted"> · {delivery.duration_ms} ms</span>}</td>
          <td>
            {delivery.last_error && <span className="intg-error-text">{delivery.last_error}</span>}
            {delivery.status === 'failed' && delivery.next_attempt_at && <><br /><span className="small muted">Prochain essai : {dateTime(delivery.next_attempt_at)}</span></>}
          </td>
          <td><div className="intg-actions">
            <button className="button button-ghost button-small" type="button" disabled={pending !== null} onClick={() => void view(delivery)} aria-label={`Voir le contenu de la livraison ${delivery.event_type}`}>
              <Eye size={14} aria-hidden="true" />Voir
            </button>
            {endpointActive && delivery.status !== 'pending' && delivery.status !== 'delivering' && <button className="button button-secondary button-small" type="button"
              disabled={pending !== null} onClick={() => void redeliver(delivery)} aria-label={`Renvoyer la livraison ${delivery.event_type}`}>
              <RotateCcw size={14} aria-hidden="true" />{pending === delivery.id ? 'Envoi…' : 'Renvoyer'}
            </button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    {(offset > 0 || !!log.data?.has_more) && <div className="row gap-sm">
      <button className="button button-secondary button-small" type="button" disabled={offset === 0 || log.loading} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Plus récentes</button>
      <button className="button button-secondary button-small" type="button" disabled={!log.data?.has_more || log.loading} onClick={() => setOffset((value) => value + 50)}>Plus anciennes</button>
    </div>}
    {viewing && <Modal title={`Livraison ${viewing.delivery.event_type}`} onClose={() => setViewing(null)}>
      <div className="stack">
        <p className="small muted">Identifiant de livraison (en-tête X-Alpha-Delivery) : <span className="intg-mono">{viewing.delivery.id}</span></p>
        <pre className="intg-payload">{JSON.stringify(viewing.payload, null, 2)}</pre>
      </div>
    </Modal>}
  </div>;
}

function EndpointItem({ endpoint, events, onUpdated, onDeleted, onSecret }: {
  endpoint: Endpoint; events: CatalogEvent[]; onUpdated: (endpoint: Endpoint) => void; onDeleted: (id: string) => void; onSecret: (secret: ShownSecret) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [logRevision, setLogRevision] = useState(0);
  const [pending, setPending] = useState<'test' | 'toggle' | 'rotate' | 'delete' | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const base = `/integrations/endpoints/${encodeURIComponent(endpoint.id)}`;
  const labels = useMemo(() => new Map(events.map((event) => [event.type, event.label])), [events]);

  async function act(name: NonNullable<typeof pending>, work: () => Promise<void>) {
    if (pending) return;
    setPending(name);
    setFlash(null);
    try {
      await work();
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(null);
    }
  }

  const test = () => act('test', async () => {
    const result = await api<{ ok: boolean; status: number | null; error: string | null; duration_ms: number }>(`${base}/test`, { method: 'POST', body: JSON.stringify({}) });
    setFlash(result.ok
      ? { tone: 'success', message: `Ping reçu par votre serveur : HTTP ${result.status} en ${result.duration_ms} ms.` }
      : { tone: 'error', message: `Échec du ping${result.status ? ` (HTTP ${result.status})` : ''} : ${result.error ?? 'réponse invalide'}.` });
    setLogRevision((value) => value + 1);
  });
  const toggle = () => act('toggle', async () => {
    const result = await api<{ endpoint: Endpoint }>(base, { method: 'PATCH', body: JSON.stringify({ active: !endpoint.active }) });
    onUpdated(result.endpoint);
    setFlash({ tone: 'success', message: result.endpoint.active ? 'Webhook réactivé : les livraisons en attente reprennent.' : 'Webhook désactivé : aucun événement ne sera envoyé.' });
  });
  const rotate = () => {
    if (!window.confirm('Générer un nouveau secret ? L’ancien reste accepté pendant 24 heures pour vous laisser le temps de mettre à jour votre serveur.')) return;
    void act('rotate', async () => {
      const result = await api<{ endpoint: Endpoint; secret: string; previous_secret_valid_until: string | null }>(`${base}/rotate-secret`, { method: 'POST', body: JSON.stringify({}) });
      onUpdated(result.endpoint);
      onSecret({
        title: `Nouveau secret pour ${endpoint.url}`,
        value: result.secret,
        note: result.previous_secret_valid_until
          ? `L’ancien secret reste valable jusqu’au ${dateTime(result.previous_secret_valid_until)} : d’ici là, chaque requête porte deux signatures v1 (nouveau et ancien secret).`
          : undefined,
      });
    });
  };
  const remove = () => {
    if (!window.confirm(`Supprimer le webhook vers ${endpoint.url} ? Son journal de livraisons sera supprimé.`)) return;
    void act('delete', async () => {
      await api<{ deleted: boolean }>(base, { method: 'DELETE' });
      onDeleted(endpoint.id);
    });
  };
  async function save(input: EndpointInput) {
    const result = await api<{ endpoint: Endpoint }>(base, { method: 'PATCH', body: JSON.stringify(input) });
    onUpdated(result.endpoint);
    setEditing(false);
    setFlash({ tone: 'success', message: 'Webhook mis à jour.' });
  }

  const failures = endpoint.consecutive_failures;
  return <li className="intg-item" aria-busy={pending !== null}>
    <div className="intg-item-head">
      <div className="intg-item-title">
        <Webhook size={18} aria-hidden="true" /><strong className="intg-mono">{endpoint.url}</strong>
        <Badge tone={endpoint.active ? 'green' : 'red'}>{endpoint.active ? 'Actif' : 'Désactivé'}</Badge>
        {endpoint.secret.rotating && <Badge tone="orange">Rotation du secret en cours</Badge>}
      </div>
      <div className="intg-actions">
        <button className="button button-secondary button-small" type="button" disabled={pending !== null} onClick={() => void test()}>
          <Send size={14} aria-hidden="true" />{pending === 'test' ? 'Envoi…' : 'Tester'}
        </button>
        <button className="button button-secondary button-small" type="button" aria-expanded={showLog} onClick={() => setShowLog((value) => !value)}>
          <ScrollText size={14} aria-hidden="true" />Journal
        </button>
        <button className="button button-secondary button-small" type="button" aria-expanded={editing} disabled={pending !== null} onClick={() => setEditing((value) => !value)}>
          <Pencil size={14} aria-hidden="true" />Modifier
        </button>
        <button className="button button-secondary button-small" type="button" disabled={pending !== null} onClick={() => void toggle()}>
          {endpoint.active ? <PowerOff size={14} aria-hidden="true" /> : <Power size={14} aria-hidden="true" />}{endpoint.active ? 'Désactiver' : 'Réactiver'}
        </button>
        <button className="button button-secondary button-small" type="button" disabled={pending !== null} onClick={rotate}>
          <KeyRound size={14} aria-hidden="true" />Nouveau secret
        </button>
        <button className="button button-danger button-small" type="button" disabled={pending !== null} onClick={remove}>
          <Trash2 size={14} aria-hidden="true" />{pending === 'delete' ? 'Suppression…' : 'Supprimer'}
        </button>
      </div>
    </div>
    <div className="intg-meta">
      {endpoint.description && <span>{endpoint.description}</span>}
      <span>Créé le {dateTime(endpoint.created_at)}</span>
      <span>Dernier succès : {endpoint.last_success_at ? dateTime(endpoint.last_success_at) : 'jamais'}</span>
      {endpoint.last_failure_at && <span>Dernier échec : {dateTime(endpoint.last_failure_at)}</span>}
      {failures > 0 && <span>{failures} échec{failures > 1 ? 's' : ''} consécutif{failures > 1 ? 's' : ''}</span>}
    </div>
    {!endpoint.active && <p className="small">{endpoint.disabled_reason || 'Désactivé.'} Les événements produits pendant la désactivation ne sont pas envoyés ; ceux déjà en attente reprendront à la réactivation (pendant 3 jours au plus).</p>}
    <p className="small muted">Événements : {endpoint.events.map((type) => labels.get(type) ?? type).join(' · ')}</p>
    <FlashMessage flash={flash} />
    {editing && <div className="card card-body">
      <EndpointForm events={events} initial={endpoint} submitLabel="Enregistrer" onSubmit={save} onCancel={() => setEditing(false)} />
    </div>}
    {showLog && <DeliveryLog endpointId={endpoint.id} endpointActive={endpoint.active} revision={logRevision} />}
  </li>;
}

function ProjectWebhooks({ projectId }: { projectId: string }) {
  const endpointsApi = useApi<{ endpoints: Endpoint[]; settings: WebhookSettings }>(`/integrations/projects/${encodeURIComponent(projectId)}/endpoints`);
  const catalog = useApi<Catalog>('/integrations/endpoints/catalog');
  const [list, setList] = useState<Endpoint[] | null>(null);
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [secret, setSecret] = useState<ShownSecret | null>(null);
  const [flash, setFlash] = useState<Flash>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!endpointsApi.data) return;
    setList(endpointsApi.data.endpoints);
    setSettings(endpointsApi.data.settings);
  }, [endpointsApi.data]);

  async function create(input: EndpointInput) {
    const result = await api<{ endpoint: Endpoint; secret: string }>(`/integrations/projects/${encodeURIComponent(projectId)}/endpoints`, {
      method: 'POST', body: JSON.stringify(input),
    });
    setList((items) => [...(items ?? []), result.endpoint]);
    setSecret({ title: `Webhook créé vers ${result.endpoint.url}`, value: result.secret, note: 'Utilisez ce secret pour vérifier l’en-tête X-Alpha-Signature de chaque requête.' });
    setCreating(false);
    setFlash(null);
  }

  if (catalog.loading || (endpointsApi.loading && !list)) return <Loading />;
  const loadError = catalog.error || (!list ? endpointsApi.error : '');
  if (loadError) {
    return <div className="stack">
      <ErrorState message={loadError} />
      <div><button className="button button-secondary" type="button" onClick={() => { catalog.reload(); endpointsApi.reload(); }}>Réessayer</button></div>
    </div>;
  }
  const events = catalog.data?.events ?? [];
  const max = settings?.max_endpoints_per_project ?? catalog.data?.settings.max_endpoints_per_project ?? 10;
  const enabled = (settings ?? catalog.data?.settings)?.enabled !== false;
  const count = list?.length ?? 0;
  const tolerance = Math.round((catalog.data?.signature.tolerance_seconds ?? 300) / 60);

  return <section className="card" aria-labelledby="intg-webhooks-title">
    <div className="card-header">
      <h2 id="intg-webhooks-title">Webhooks sortants</h2>
      <span className="row gap-sm">
        <button className="button button-secondary button-small" type="button" onClick={endpointsApi.reload} disabled={endpointsApi.loading}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>
        {enabled && <button className="button button-primary button-small" type="button" disabled={creating || count >= max} onClick={() => { setCreating(true); setFlash(null); }}>
          <Plus size={15} aria-hidden="true" />Nouveau webhook
        </button>}
      </span>
    </div>
    <div className="card-body stack">
      <p className="muted small">Alpha envoie une requête <code>POST</code> JSON <code>{'{ id, type, created_at, data }'}</code> à chaque événement choisi. Vérifiez l’en-tête <code>X-Alpha-Signature</code> (<code>{catalog.data?.signature.format ?? 't=…,v1=…'}</code>) avec votre secret, refusez les requêtes de plus de {tolerance} minutes et ignorez les identifiants <code>id</code> déjà traités. Les échecs sont retentés 8 fois sur environ 22 heures ; après 20 échecs consécutifs, le webhook est désactivé et vous êtes prévenu.</p>
      {!enabled && <div className="alert alert-error" role="status">Les webhooks sortants sont désactivés sur cette instance par l’administrateur.</div>}
      <FlashMessage flash={flash} />
      {secret && <OneTimeSecret title={secret.title} secret={secret.value} note={secret.note} onDismiss={() => setSecret(null)} />}
      {creating && <div className="card card-body stack">
        <h3>Nouveau webhook</h3>
        <EndpointForm events={events} submitLabel="Créer le webhook" onSubmit={create} onCancel={() => setCreating(false)} />
      </div>}
      {!count
        ? <EmptyState title="Aucun webhook sortant" description="Créez un webhook pour transmettre les événements de ce projet à vos outils (intégration continue, messagerie d’équipe, tableau de bord)." />
        : <ul className="list" aria-label="Webhooks sortants">
          {list!.map((endpoint) => <EndpointItem key={endpoint.id} endpoint={endpoint} events={events} onSecret={setSecret}
            onUpdated={(next) => setList((items) => items?.map((item) => item.id === next.id ? next : item) ?? null)}
            onDeleted={(deletedId) => {
              setList((items) => items?.filter((item) => item.id !== deletedId) ?? null);
              setFlash({ tone: 'success', message: 'Webhook supprimé.' });
            }} />)}
        </ul>}
      <p className="help-text">{count} / {max} webhooks pour ce projet.</p>
    </div>
  </section>;
}

// ----- Project selector and page -------------------------------------------------------------

const projectTabs = [
  { id: 'links', label: 'Liens' },
  { id: 'sources', label: 'Sources' },
  { id: 'webhooks', label: 'Webhooks sortants' },
  { id: 'export', label: 'Export' },
] as const;
type ProjectTab = (typeof projectTabs)[number]['id'];

function ProjectIntegrations({ projectId, accounts }: { projectId: string; accounts: ProviderStatus[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const tab: ProjectTab = projectTabs.find((item) => item.id === requestedTab)?.id ?? 'links';
  const links = useApi<{ project: Project; integrations: Integration[] }>(`/integrations?project_id=${encodeURIComponent(projectId)}`);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportMessage, setExportMessage] = useState('');

  async function download() {
    if (exporting) return;
    setExporting(true); setExportError(''); setExportMessage('');
    try {
      const data = await api<unknown>(`/integrations/export?project_id=${encodeURIComponent(projectId)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }));
      const anchor = document.createElement('a');
      const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'projet';
      anchor.href = url;
      anchor.download = `alpha-export-${safeId}-${new Date().toISOString().slice(0, 10)}.json`;
      try {
        document.body.appendChild(anchor);
        anchor.click();
      } finally {
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setExportMessage('Export JSON préparé. Le téléchargement a été lancé.');
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  if (links.loading) return <Loading />;
  if (links.error) return <div className="stack"><ErrorState message={links.error} /><button className="button button-secondary" type="button" onClick={links.reload}>Réessayer</button></div>;
  if (!links.data) return <ErrorState message="Les liens du projet n’ont pas pu être chargés." />;
  const { project, integrations } = links.data;

  function selectTab(next: ProjectTab) {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = projectTabs.findIndex((item) => item.id === tab);
    const next = projectTabs[(index + (event.key === 'ArrowRight' ? 1 : projectTabs.length - 1)) % projectTabs.length]!.id;
    selectTab(next);
    document.getElementById(`intg-tab-${next}`)?.focus();
  }

  return <div className="stack">
    <h2 className="section-heading">Outils de « {project.title} »</h2>
    <div className="tabs" role="tablist" aria-label="Sections du projet" onKeyDown={onTabKey}>
      {projectTabs.map((item) => <button key={item.id} id={`intg-tab-${item.id}`} type="button" role="tab"
        className={`tab${tab === item.id ? ' active' : ''}`} aria-selected={tab === item.id}
        aria-controls={tab === item.id ? `intg-panel-${item.id}` : undefined} tabIndex={tab === item.id ? 0 : -1}
        onClick={() => selectTab(item.id)}>{item.label}</button>)}
    </div>
    <div id={`intg-panel-${tab}`} role="tabpanel" aria-labelledby={`intg-tab-${tab}`} className="stack">
      {tab === 'links' && <>
        <section aria-label="Liens des outils" className="card-grid">
          {providers.map((provider) => <IntegrationCard key={provider.id} project={project} provider={provider}
            initial={integrations.find((link) => link.provider === provider.id)} />)}
        </section>
        <p className="help-text">Ces liens sont de simples raccourcis. Pour recevoir les push, releases et versions, liez une source dans l’onglet « Sources ».</p>
      </>}
      {tab === 'sources' && <ProjectSources projectId={project.id} providers={accounts} />}
      {tab === 'webhooks' && <ProjectWebhooks projectId={project.id} />}
      {tab === 'export' && <>
        <section className="card card-body stack" aria-labelledby="export-heading">
          <h2 id="export-heading">Exporter les rapports</h2>
          <p className="muted">Téléchargez les campagnes, missions et rapports de « {project.title} » au format JSON. Les comptes, mots de passe et adresses e-mail des utilisateurs ne sont pas inclus. Aucun fichier n’est envoyé à un service externe.</p>
          <p className="help-text">Les récompenses éventuelles sont exprimées en centimes et restent en mode démonstration. Un export est limité à 10 000 éléments par catégorie ; au-delà, aucun fichier partiel n’est généré.</p>
          <ErrorState message={exportError} />
          {exportMessage && <p className="text-success small" role="status">{exportMessage}</p>}
          <div><button className="button button-secondary" type="button" disabled={exporting} onClick={() => void download()} aria-busy={exporting}>
            <Download size={17} aria-hidden="true" />{exporting ? 'Préparation de l’export…' : 'Télécharger l’export JSON'}
          </button></div>
        </section>
      </>}
    </div>
  </div>;
}

function ManagedIntegrations({ accounts }: { accounts: ProviderStatus[] }) {
  const [offset, setOffset] = useState(0);
  const projects = useApi<{ projects: Project[]; has_more: boolean }>(`/integrations/projects?offset=${offset}`);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('project') ?? projects.data?.projects[0]?.id ?? '';
  const selectedInList = projects.data?.projects.some((project) => project.id === selectedId);

  if (projects.loading) return <Loading />;
  if (projects.error) return <div className="stack"><ErrorState message={projects.error} /><button className="button button-secondary" type="button" onClick={projects.reload}>Réessayer</button></div>;
  if (!projects.data) return <ErrorState message="Les projets n’ont pas pu être chargés." />;
  if (!projects.data.projects.length && !selectedId && offset === 0) return <EmptyState title="Aucun projet à gérer" description="Les intégrations et les exports sont réservés aux responsables de projet et aux responsables de leur organisation." />;

  return <div className="stack">
    <div className="card card-body field">
      <label htmlFor="integrations-project">Projet à configurer</label>
      <select id="integrations-project" value={selectedId} onChange={(event) => {
        const next = new URLSearchParams(searchParams);
        next.set('project', event.target.value);
        setSearchParams(next);
      }}>
        <option value="" disabled>Choisir un projet</option>
        {selectedId && !selectedInList && <option value={selectedId}>Projet sélectionné via son lien</option>}
        {projects.data.projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
      </select>
      <p className="help-text">Seuls les projets que vous êtes autorisé à gérer sont proposés.</p>
      {(offset > 0 || projects.data.has_more) && <div className="row gap-sm">
        <button className="button button-secondary button-small" type="button" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - 200))}>Projets précédents</button>
        <button className="button button-secondary button-small" type="button" disabled={!projects.data.has_more} onClick={() => setOffset((value) => value + 200)}>Projets suivants</button>
      </div>}
    </div>
    {selectedId
      ? <ProjectIntegrations key={selectedId} projectId={selectedId} accounts={accounts} />
      : <EmptyState title="Aucun projet sur cette page" description="Revenez à la page précédente pour choisir un projet." />}
  </div>;
}

function AuthenticatedIntegrations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const providers = useApi<{ providers: ProviderStatus[] }>('/integrations/providers');
  const [notice, setNotice] = useState<Flash>(() => callbackNotice(searchParams));
  // The OAuth callback reports its outcome in the query string: show it once, then clean the URL.
  useEffect(() => {
    if (!searchParams.has('connected') && !searchParams.has('integration_error')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('integration_error');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const returnTo = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('connected');
    next.delete('integration_error');
    const query = next.toString();
    const path = `/integrations${query ? `?${query}` : ''}`;
    return path.length <= 300 ? path : '/integrations';
  }, [searchParams]);

  return <>
    <ConnectedAccounts state={providers} notice={notice} onNotice={setNotice} returnTo={returnTo} />
    <ManagedIntegrations accounts={providers.data?.providers ?? []} />
  </>;
}

function AboutIntegrations() {
  return <section className="card card-body stack" aria-labelledby="integrations-roadmap">
    <h2 id="integrations-roadmap">Ce que font les intégrations</h2>
    <p className="muted">Les liens restent de simples raccourcis : ils ne se connectent à aucun service. Linear n’est proposé que sous forme de lien.</p>
    <p className="muted">Les comptes connectés GitHub, GitLab et Figma servent uniquement à lister vos dépôts ou fichiers et à créer les webhooks. Alpha ne lit ni ne modifie votre code ; les jetons sont chiffrés, jamais affichés, et révoqués à la déconnexion lorsque le service le permet.</p>
    <p className="muted">Les sources liées signalent les push sur la branche par défaut, les releases, les tags et les nouvelles versions Figma : le responsable du projet et les testeurs des campagnes en cours sont prévenus des nouvelles versions. Les webhooks sortants transmettent les événements du projet, signés en HMAC-SHA256, à vos propres services.</p>
  </section>;
}

export default function IntegrationsPage() {
  const auth = useAuth();
  return <div className="stack">
    <PageHeader eyebrow="Votre espace de travail" title="Intégrations"
      description="Connectez vos dépôts et fichiers, annoncez les nouvelles versions aux testeurs, diffusez les événements de vos projets et exportez leurs rapports." />
    {auth.loading ? <Loading /> : auth.error ? <ErrorState message={auth.error} /> : !auth.user ? <LoginNotice /> : <AuthenticatedIntegrations key={auth.user.id} />}
    <AboutIntegrations />
  </div>;
}
