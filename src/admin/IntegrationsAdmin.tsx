import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Figma, Github, Gitlab, RefreshCw, RotateCcw, Save } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import '../styles/integrations.css';

/** Integrations administration — OWNER: integrations module. OAuth apps, outgoing webhook settings, delivery stats and logs. */

type ProviderId = 'github' | 'gitlab' | 'figma';
type DeliveryStatus = 'pending' | 'delivering' | 'succeeded' | 'failed' | 'dead';
type InboundStatus = 'received' | 'processed' | 'ignored' | 'failed';
interface ProviderConfig {
  provider: ProviderId; label: string; enabled: boolean; client_id: string; base_url: string; scopes: string[]; private_scopes: string[];
  client_secret: { configured: boolean; mask: string }; ready: boolean; callback_url: string; pkce: boolean; default_scopes: string[]; updated_at: string | null;
}
interface WebhookSettings { enabled: boolean; max_endpoints_per_project: number }
interface ProvidersResponse { providers: ProviderConfig[]; webhooks: WebhookSettings; webhook_defaults: WebhookSettings }
interface Count { total: number }
interface Overview {
  connections: (Count & { provider: ProviderId })[];
  sources: (Count & { provider: ProviderId; setup: 'automatic' | 'manual' })[];
  endpoints: { total: number; active: number; disabled: number } | null;
  deliveries_24h: (Count & { status: DeliveryStatus })[];
  deliveries_7d: (Count & { status: DeliveryStatus })[];
  inbound_7d: (Count & { provider: ProviderId; status: InboundStatus })[];
  disabled_endpoints: { id: string; project_id: string; project_title: string; url: string; disabled_reason: string; consecutive_failures: number; updated_at: string }[];
}
interface AdminDelivery {
  id: string; endpoint_id: string; event_id: string; event_type: string; status: DeliveryStatus; attempts: number; next_attempt_at: string | null;
  response_status: number | null; last_error: string; duration_ms: number | null; created_at: string; updated_at: string;
  url: string; project_id: string; project_title: string;
}
interface InboundEvent {
  id: string; provider: ProviderId; delivery_id: string; event_type: string; status: InboundStatus; summary: string;
  received_at: string; processed_at: string | null; project_id: string | null; project_title: string | null; full_name: string | null;
}
type Flash = { tone: 'success' | 'error'; message: string } | null;

const icons: Record<ProviderId, typeof Github> = { github: Github, gitlab: Gitlab, figma: Figma };
const providerNames: Record<ProviderId, string> = { github: 'GitHub', gitlab: 'GitLab', figma: 'Figma' };
const deliveryLabels: Record<DeliveryStatus, string> = { pending: 'En attente', delivering: 'En cours', succeeded: 'Réussies', failed: 'En échec (réessai prévu)', dead: 'Abandonnées' };
const deliveryTones: Record<DeliveryStatus, string> = { pending: 'blue', delivering: 'blue', succeeded: 'green', failed: 'orange', dead: 'red' };
const inboundLabels: Record<InboundStatus, string> = { received: 'Reçu', processed: 'Traité', ignored: 'Ignoré', failed: 'Erreur' };
const inboundTones: Record<InboundStatus, string> = { received: 'blue', processed: 'green', ignored: 'neutral', failed: 'red' };
const providerHelp: Record<ProviderId, ReactNode> = {
  github: <>GitHub → Settings → Developer settings → <strong>OAuth Apps</strong> → New OAuth App. Collez l’URL de rappel ci-dessous dans « Authorization callback URL ». Scopes par défaut : <code>read:user</code> et <code>admin:repo_hook</code> (création des webhooks) ; <code>repo</code> n’est demandé que si le membre choisit d’inclure ses dépôts privés.</>,
  gitlab: <>GitLab → Préférences → <strong>Applications</strong> (ou Admin → Applications pour une instance). Application confidentielle, URL de rappel ci-dessous, scopes <code>read_api</code> et <code>read_user</code>. Ajoutez <code>api</code> pour permettre la création automatique des webhooks (rôle Maintainer requis). PKCE est toujours utilisé.</>,
  figma: <>Figma → <strong>Developers</strong> → My apps → Create app → OAuth credentials. Ajoutez l’URL de rappel ci-dessous et publiez l’application avec les scopes <code>current_user:read</code>, <code>file_content:read</code>, <code>file_metadata:read</code> et <code>webhooks:write</code>. Figma n’offre pas d’API de révocation des jetons.</>,
};

const number = new Intl.NumberFormat('fr-FR');
const sum = (rows: Count[]) => rows.reduce((total, row) => total + row.total, 0);
const parseScopes = (value: string) => [...new Set(value.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean))];

function FlashMessage({ flash }: { flash: Flash }) {
  return <div aria-live="polite">
    {flash && <div className={`alert alert-${flash.tone}`} role={flash.tone === 'error' ? 'alert' : 'status'}>{flash.message}</div>}
  </div>;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const id = useId();
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  async function copy() {
    try { await navigator.clipboard.writeText(value); setCopied('ok'); } catch { setCopied('fail'); }
  }
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    <div className="intg-copy">
      <input id={id} readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
      <button className="button button-secondary button-small" type="button" onClick={() => void copy()}>
        {copied === 'ok' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copied === 'ok' ? 'Copié' : 'Copier'}
      </button>
    </div>
    <span className="help-text" aria-live="polite">{copied === 'fail' ? 'Copie impossible : sélectionnez le texte et copiez-le manuellement.' : ''}</span>
  </div>;
}

function ProviderForm({ config, onSaved }: { config: ProviderConfig; onSaved: (next: ProviderConfig) => void }) {
  const ids = useId();
  const [enabled, setEnabled] = useState(config.enabled);
  const [clientId, setClientId] = useState(config.client_id);
  const [secret, setSecret] = useState('');
  const [removeSecret, setRemoveSecret] = useState(false);
  const [baseUrl, setBaseUrl] = useState(config.base_url);
  const [scopes, setScopes] = useState(config.scopes.join(' '));
  const [privateScopes, setPrivateScopes] = useState(config.private_scopes.join(' '));
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const Icon = icons[config.provider];

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFlash(null);
    try {
      const body: Record<string, unknown> = {
        enabled,
        client_id: clientId.trim(),
        scopes: parseScopes(scopes),
        ...(config.provider === 'gitlab' ? { base_url: baseUrl.trim() } : {}),
        ...(config.provider === 'github' ? { private_scopes: parseScopes(privateScopes) } : {}),
        ...(removeSecret ? { client_secret: null } : secret.trim() ? { client_secret: secret.trim() } : {}),
      };
      const result = await api<{ provider: ProviderConfig }>(`/integrations/admin/providers/${config.provider}`, { method: 'PUT', body: JSON.stringify(body) });
      setSecret('');
      setRemoveSecret(false);
      onSaved(result.provider);
      setFlash({ tone: 'success', message: `Configuration ${config.label} enregistrée.` });
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return <section className="card" aria-labelledby={`${ids}-title`}>
    <div className="card-header">
      <h3 id={`${ids}-title`} className="row gap-sm"><Icon size={20} aria-hidden="true" />{config.label}</h3>
      <span className="row gap-sm">
        <Badge tone={config.ready ? 'green' : config.enabled ? 'orange' : 'neutral'}>{config.ready ? 'Actif' : config.enabled ? 'Incomplet' : 'Désactivé'}</Badge>
        <Badge tone="blue">{config.pkce ? 'PKCE' : 'State uniquement'}</Badge>
      </span>
    </div>
    <form className="card-body intg-provider-form" onSubmit={save} aria-busy={pending}>
      <p className="help-text">{providerHelp[config.provider]}</p>
      <CopyValue label="URL de rappel (callback)" value={config.callback_url} />
      <label className="intg-checkbox"><input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} />
        <span>Permettre aux membres de connecter leur compte {config.label}</span></label>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${ids}-client`}>Identifiant client (client ID)</label>
          <input id={`${ids}-client`} value={clientId} maxLength={200} disabled={pending} autoComplete="off" spellCheck={false} onChange={(event) => setClientId(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${ids}-secret`}>Secret client</label>
          <input id={`${ids}-secret`} type="password" value={secret} minLength={8} maxLength={500} disabled={pending || removeSecret} autoComplete="new-password"
            placeholder={config.client_secret.configured ? `Configuré (${config.client_secret.mask}) — laisser vide pour conserver` : 'Non configuré'}
            onChange={(event) => setSecret(event.target.value)} aria-describedby={`${ids}-secret-help`} />
          <span id={`${ids}-secret-help`} className="help-text">Chiffré au repos, jamais réaffiché. Saisissez une nouvelle valeur pour le remplacer.</span>
          {config.client_secret.configured && <label className="intg-checkbox"><input type="checkbox" checked={removeSecret} disabled={pending}
            onChange={(event) => setRemoveSecret(event.target.checked)} /><span>Supprimer le secret enregistré</span></label>}
        </div>
        {config.provider === 'gitlab' && <div className="field">
          <label htmlFor={`${ids}-base`}>URL de l’instance GitLab</label>
          <input id={`${ids}-base`} type="url" value={baseUrl} maxLength={300} disabled={pending} placeholder="https://gitlab.com" onChange={(event) => setBaseUrl(event.target.value)} />
          <span className="help-text">gitlab.com ou votre instance auto-hébergée (HTTPS). Changer d’instance oblige les membres à se reconnecter.</span>
        </div>}
        <div className="field">
          <label htmlFor={`${ids}-scopes`}>Scopes</label>
          <input id={`${ids}-scopes`} value={scopes} disabled={pending} spellCheck={false} placeholder={config.default_scopes.join(' ')} onChange={(event) => setScopes(event.target.value)} />
          <span className="help-text">Séparés par des espaces. Vide = valeurs par défaut ({config.default_scopes.join(', ')}).</span>
        </div>
        {config.provider === 'github' && <div className="field">
          <label htmlFor={`${ids}-private`}>Scopes supplémentaires pour les dépôts privés</label>
          <input id={`${ids}-private`} value={privateScopes} disabled={pending} spellCheck={false} placeholder="repo" onChange={(event) => setPrivateScopes(event.target.value)} />
          <span className="help-text">Demandés uniquement quand le membre choisit d’inclure ses dépôts privés. Vide = option désactivée.</span>
        </div>}
      </div>
      <FlashMessage flash={flash} />
      <div className="row-between">
        <span className="help-text">{config.updated_at ? `Modifié le ${dateTime(config.updated_at)}` : 'Jamais configuré'}</span>
        <button className="button button-primary button-small" type="submit" disabled={pending}><Save size={14} aria-hidden="true" />{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </form>
  </section>;
}

function WebhookSettingsForm({ initial }: { initial: WebhookSettings }) {
  const ids = useId();
  const [enabled, setEnabled] = useState(initial.enabled);
  const [max, setMax] = useState(String(initial.max_endpoints_per_project));
  const [pending, setPending] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const value = Number(max);
    if (!Number.isInteger(value) || value < 1 || value > 50) { setFlash({ tone: 'error', message: 'Indiquez un nombre entier entre 1 et 50.' }); return; }
    setPending(true);
    setFlash(null);
    try {
      const result = await api<{ webhooks: WebhookSettings }>('/integrations/admin/webhooks', { method: 'PUT', body: JSON.stringify({ enabled, max_endpoints_per_project: value }) });
      setEnabled(result.webhooks.enabled);
      setMax(String(result.webhooks.max_endpoints_per_project));
      setFlash({ tone: 'success', message: 'Paramètres des webhooks sortants enregistrés.' });
    } catch (error) {
      setFlash({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  return <section className="card" aria-labelledby={`${ids}-title`}>
    <div className="card-header"><h3 id={`${ids}-title`}>Webhooks sortants</h3></div>
    <form className="card-body stack" onSubmit={save} aria-busy={pending}>
      <div className="intg-inline">
        <label className="intg-checkbox"><input type="checkbox" checked={enabled} disabled={pending} onChange={(event) => setEnabled(event.target.checked)} />
          <span>Autoriser les responsables de projet à créer des webhooks sortants</span></label>
        <div className="field">
          <label htmlFor={`${ids}-max`}>Webhooks maximum par projet</label>
          <input id={`${ids}-max`} type="number" min={1} max={50} step={1} value={max} disabled={pending} onChange={(event) => setMax(event.target.value)} />
        </div>
        <button className="button button-primary button-small" type="submit" disabled={pending}><Save size={14} aria-hidden="true" />{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
      <p className="help-text">Désactiver suspend la création de nouveaux webhooks ; les webhooks existants continuent de recevoir leurs événements. Les livraisons sont retentées 8 fois (1 min → 12 h) puis abandonnées ; un webhook est désactivé après 20 échecs consécutifs et son propriétaire est prévenu.</p>
      <FlashMessage flash={flash} />
    </form>
  </section>;
}

function ProvidersPanel() {
  const { data, loading, error, reload } = useApi<ProvidersResponse>('/integrations/admin/providers');
  const [configs, setConfigs] = useState<ProviderConfig[]>([]);
  useEffect(() => { if (data) setConfigs(data.providers); }, [data]);
  if (loading) return <Loading />;
  if (error || !data) return <div className="stack"><ErrorState message={error || 'Configuration indisponible.'} /><div><button className="button button-secondary button-small" type="button" onClick={reload}>Réessayer</button></div></div>;
  return <div className="stack">
    <p className="muted small">Chaque membre connecte son propre compte. Les URL de rappel dérivent de <code>APP_ORIGIN</code> ; les URL de réception des webhooks entrants dérivent de <code>PUBLIC_API_ORIGIN</code> et doivent être publiques en HTTPS pour que GitHub, GitLab et Figma les acceptent.</p>
    {configs.map((config) => <ProviderForm key={config.provider} config={config}
      onSaved={(next) => setConfigs((items) => items.map((item) => item.provider === next.provider ? next : item))} />)}
    <WebhookSettingsForm initial={data.webhooks} />
  </div>;
}

function StatCard({ label, value, children }: { label: string; value: number; children?: ReactNode }) {
  return <div className="stat-card">
    <span className="stat-label">{label}</span>
    <div className="stat-value">{number.format(value)}</div>
    {children}
  </div>;
}

function OverviewPanel() {
  const { data, loading, error, reload } = useApi<Overview>('/integrations/admin/overview');
  if (loading) return <Loading />;
  if (error || !data) return <div className="stack"><ErrorState message={error || 'Statistiques indisponibles.'} /><div><button className="button button-secondary button-small" type="button" onClick={reload}>Réessayer</button></div></div>;
  const statuses = Object.keys(deliveryLabels) as DeliveryStatus[];
  const byStatus = (rows: Overview['deliveries_24h'], status: DeliveryStatus) => rows.find((row) => row.status === status)?.total ?? 0;
  return <div className="stack">
    <div className="row-between">
      <p className="muted small">Activité des intégrations sur l’instance.</p>
      <button className="button button-secondary button-small" type="button" onClick={reload}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>
    </div>
    <div className="stat-grid intg-stats">
      <StatCard label="Comptes connectés" value={sum(data.connections)}>
        <ul className="intg-stat-list">{data.connections.map((row) => <li key={row.provider}>{providerNames[row.provider]} : {number.format(row.total)}</li>)}</ul>
      </StatCard>
      <StatCard label="Sources liées" value={sum(data.sources)}>
        <ul className="intg-stat-list">{data.sources.map((row) => <li key={`${row.provider}-${row.setup}`}>{providerNames[row.provider]} ({row.setup === 'automatic' ? 'automatique' : 'manuel'}) : {number.format(row.total)}</li>)}</ul>
      </StatCard>
      <StatCard label="Webhooks sortants" value={data.endpoints?.total ?? 0}>
        <ul className="intg-stat-list"><li>Actifs : {number.format(data.endpoints?.active ?? 0)}</li><li>Désactivés : {number.format(data.endpoints?.disabled ?? 0)}</li></ul>
      </StatCard>
      <StatCard label="Événements reçus (7 j)" value={sum(data.inbound_7d)}>
        <ul className="intg-stat-list">{(Object.keys(inboundLabels) as InboundStatus[]).map((status) => {
          const total = data.inbound_7d.filter((row) => row.status === status).reduce((acc, row) => acc + row.total, 0);
          return total ? <li key={status}>{inboundLabels[status]} : {number.format(total)}</li> : null;
        })}</ul>
      </StatCard>
    </div>
    <div className="table-wrap"><table className="data-table" aria-label="Livraisons des webhooks sortants">
      <thead><tr><th scope="col">Statut des livraisons</th><th scope="col">24 heures</th><th scope="col">7 jours</th></tr></thead>
      <tbody>{statuses.map((status) => <tr key={status}>
        <td><Badge tone={deliveryTones[status]}>{deliveryLabels[status]}</Badge></td>
        <td>{number.format(byStatus(data.deliveries_24h, status))}</td>
        <td>{number.format(byStatus(data.deliveries_7d, status))}</td>
      </tr>)}</tbody>
    </table></div>
    <h3>Webhooks désactivés</h3>
    {!data.disabled_endpoints.length ? <p className="muted small">Aucun webhook désactivé.</p>
      : <div className="table-wrap"><table className="data-table" aria-label="Webhooks désactivés">
        <thead><tr><th scope="col">Projet</th><th scope="col">Destination</th><th scope="col">Motif</th><th scope="col">Échecs consécutifs</th><th scope="col">Depuis</th></tr></thead>
        <tbody>{data.disabled_endpoints.map((row) => <tr key={row.id}>
          <td>{row.project_title}</td><td className="intg-mono">{row.url}</td><td>{row.disabled_reason || '—'}</td>
          <td>{number.format(row.consecutive_failures)}</td><td>{dateTime(row.updated_at)}</td>
        </tr>)}</tbody>
      </table></div>}
  </div>;
}

function DeliveriesPanel() {
  const ids = useId();
  const [status, setStatus] = useState<DeliveryStatus>('dead');
  const [offset, setOffset] = useState(0);
  const [flash, setFlash] = useState<Flash>(null);
  const [pending, setPending] = useState<string | null>(null);
  const { data, loading, error, reload } = useApi<{ deliveries: AdminDelivery[]; has_more: boolean }>(`/integrations/admin/deliveries?status=${status}&offset=${offset}`);

  async function redeliver(delivery: AdminDelivery) {
    if (pending) return;
    if (!window.confirm(`Renvoyer l’événement ${delivery.event_type} vers ${delivery.url} ? Le contenu d’origine sera renvoyé avec une nouvelle signature.`)) return;
    setPending(delivery.id);
    setFlash(null);
    try {
      const result = await api<{ delivery: AdminDelivery }>(`/integrations/admin/deliveries/${encodeURIComponent(delivery.id)}/redeliver`, { method: 'POST', body: JSON.stringify({}) });
      setFlash({ tone: result.delivery.status === 'succeeded' ? 'success' : 'error', message: `Livraison renvoyée : ${deliveryLabels[result.delivery.status].toLowerCase()}${result.delivery.response_status ? ` (HTTP ${result.delivery.response_status})` : ''}.` });
      reload();
    } catch (failure) {
      setFlash({ tone: 'error', message: errorMessage(failure) });
    } finally {
      setPending(null);
    }
  }

  return <div className="stack">
    <div className="intg-filters">
      <div className="field">
        <label htmlFor={`${ids}-status`}>Statut</label>
        <select id={`${ids}-status`} value={status} onChange={(event) => { setStatus(event.target.value as DeliveryStatus); setOffset(0); }}>
          {(Object.keys(deliveryLabels) as DeliveryStatus[]).map((value) => <option key={value} value={value}>{deliveryLabels[value]}</option>)}
        </select>
      </div>
      <button className="button button-secondary button-small" type="button" onClick={reload} disabled={loading}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>
    </div>
    <p className="help-text">Les URL sont affichées sans leur chaîne de requête et le contenu des événements n’est pas exposé ici. Un renvoi n’est possible que si le webhook est actif.</p>
    <FlashMessage flash={flash} />
    {loading ? <Loading /> : error ? <ErrorState message={error} /> : !data?.deliveries.length
      ? <EmptyState title="Aucune livraison" description={status === 'dead' ? 'Aucune livraison abandonnée : tout est arrivé à destination.' : 'Aucune livraison avec ce statut.'} />
      : <div className="table-wrap"><table className="data-table" aria-label="Livraisons">
        <thead><tr><th scope="col">Mise à jour</th><th scope="col">Projet</th><th scope="col">Destination</th><th scope="col">Événement</th><th scope="col">Tentatives</th><th scope="col">Dernière erreur</th><th scope="col">Actions</th></tr></thead>
        <tbody>{data.deliveries.map((delivery) => <tr key={delivery.id}>
          <td>{dateTime(delivery.updated_at)}</td>
          <td>{delivery.project_title}</td>
          <td className="intg-mono">{delivery.url}</td>
          <td><code>{delivery.event_type}</code></td>
          <td>{delivery.attempts}</td>
          <td><span className="intg-error-text">{delivery.response_status ? `HTTP ${delivery.response_status} · ` : ''}{delivery.last_error || '—'}</span></td>
          <td>{(delivery.status === 'dead' || delivery.status === 'failed' || delivery.status === 'succeeded') && <button className="button button-secondary button-small" type="button"
            disabled={pending !== null} onClick={() => void redeliver(delivery)} aria-label={`Renvoyer la livraison ${delivery.event_type} du projet ${delivery.project_title}`}>
            <RotateCcw size={14} aria-hidden="true" />{pending === delivery.id ? 'Envoi…' : 'Renvoyer'}
          </button>}</td>
        </tr>)}</tbody>
      </table></div>}
    {(offset > 0 || !!data?.has_more) && <div className="row gap-sm">
      <button className="button button-secondary button-small" type="button" disabled={offset === 0 || loading} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Plus récentes</button>
      <button className="button button-secondary button-small" type="button" disabled={!data?.has_more || loading} onClick={() => setOffset((value) => value + 50)}>Plus anciennes</button>
    </div>}
  </div>;
}

function InboundPanel() {
  const ids = useId();
  const [status, setStatus] = useState<InboundStatus | ''>('');
  const [provider, setProvider] = useState<ProviderId | ''>('');
  const [offset, setOffset] = useState(0);
  const query = new URLSearchParams({ offset: String(offset), ...(status ? { status } : {}), ...(provider ? { provider } : {}) });
  const { data, loading, error, reload } = useApi<{ events: InboundEvent[]; has_more: boolean }>(`/integrations/admin/inbound?${query}`);

  return <div className="stack">
    <div className="intg-filters">
      <div className="field">
        <label htmlFor={`${ids}-provider`}>Service</label>
        <select id={`${ids}-provider`} value={provider} onChange={(event) => { setProvider(event.target.value as ProviderId | ''); setOffset(0); }}>
          <option value="">Tous</option>
          {(Object.keys(providerNames) as ProviderId[]).map((value) => <option key={value} value={value}>{providerNames[value]}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${ids}-status`}>Statut</label>
        <select id={`${ids}-status`} value={status} onChange={(event) => { setStatus(event.target.value as InboundStatus | ''); setOffset(0); }}>
          <option value="">Tous</option>
          {(Object.keys(inboundLabels) as InboundStatus[]).map((value) => <option key={value} value={value}>{inboundLabels[value]}</option>)}
        </select>
      </div>
      <button className="button button-secondary button-small" type="button" onClick={reload} disabled={loading}><RefreshCw size={14} aria-hidden="true" />Actualiser</button>
    </div>
    <p className="help-text">Seuls les événements authentifiés (signature, jeton ou passcode valides) sont enregistrés. Les identifiants de livraison servent à ignorer les renvois en double. Conservation : 90 jours.</p>
    {loading ? <Loading /> : error ? <ErrorState message={error} /> : !data?.events.length
      ? <EmptyState title="Aucun événement reçu" description="Les événements GitHub, GitLab et Figma authentifiés apparaîtront ici." />
      : <div className="table-wrap"><table className="data-table" aria-label="Événements entrants">
        <thead><tr><th scope="col">Reçu le</th><th scope="col">Service</th><th scope="col">Projet / source</th><th scope="col">Événement</th><th scope="col">Résumé</th><th scope="col">Statut</th><th scope="col">Identifiant de livraison</th></tr></thead>
        <tbody>{data.events.map((event) => <tr key={event.id}>
          <td>{dateTime(event.received_at)}</td>
          <td>{providerNames[event.provider] ?? event.provider}</td>
          <td>{event.project_title ?? '—'}{event.full_name ? <><br /><span className="small muted">{event.full_name}</span></> : null}</td>
          <td><code>{event.event_type}</code></td>
          <td>{event.summary || '—'}</td>
          <td><Badge tone={inboundTones[event.status]}>{inboundLabels[event.status]}</Badge></td>
          <td className="intg-mono">{event.delivery_id}</td>
        </tr>)}</tbody>
      </table></div>}
    {(offset > 0 || !!data?.has_more) && <div className="row gap-sm">
      <button className="button button-secondary button-small" type="button" disabled={offset === 0 || loading} onClick={() => setOffset((value) => Math.max(0, value - 50))}>Plus récents</button>
      <button className="button button-secondary button-small" type="button" disabled={!data?.has_more || loading} onClick={() => setOffset((value) => value + 50)}>Plus anciens</button>
    </div>}
  </div>;
}

const sections = [
  { id: 'apps', label: 'Applications OAuth', Panel: ProvidersPanel },
  { id: 'overview', label: 'Statistiques', Panel: OverviewPanel },
  { id: 'deliveries', label: 'Livraisons sortantes', Panel: DeliveriesPanel },
  { id: 'inbound', label: 'Événements entrants', Panel: InboundPanel },
] as const;

export default function IntegrationsAdmin() {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('apps');
  const current = sections.find((section) => section.id === active) ?? sections[0];
  const { Panel } = current;
  return <div className="stack">
    <div className="tabs" role="tablist" aria-label="Sections des intégrations">
      {sections.map((section) => <button key={section.id} id={`intg-admin-tab-${section.id}`} type="button" role="tab"
        className={`tab${active === section.id ? ' active' : ''}`} aria-selected={active === section.id}
        aria-controls={active === section.id ? 'intg-admin-panel' : undefined} onClick={() => setActive(section.id)}>{section.label}</button>)}
    </div>
    <div id="intg-admin-panel" role="tabpanel" aria-labelledby={`intg-admin-tab-${current.id}`}>
      <Panel />
    </div>
  </div>;
}
