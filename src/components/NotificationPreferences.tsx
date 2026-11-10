import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { BellRing, BellOff, Mail, MonitorSmartphone, RotateCcw, Trash2 } from 'lucide-react';
import { Badge, ErrorState, Loading, useApi } from './ui';
import { api, ApiError, date, errorMessage } from '../lib/api';
import '../styles/realtime.css';

/** Notification channels per category (in-app always on, e-mail, Web Push) — OWNER: realtime module. Rendered in Settings. */

interface Category {
  id: string; label: string; description: string; in_app: true; email: boolean; push: boolean;
  defaults: { email: boolean; push: boolean };
}
interface Subscription { id: string; endpoint_host: string; user_agent: string; failures: number; last_success_at: string | null; created_at: string }
interface Preferences {
  categories: Category[];
  email_frequency: 'immediate' | 'daily';
  email_verified: boolean;
  email_verification_available: boolean;
  channels: { email_notifications: boolean; push: boolean };
  push_subscriptions: Subscription[];
}
type Channel = 'email' | 'push';
type PushSupport = 'checking' | 'unsupported' | 'insecure' | 'ready';

function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window ? 'ready' : 'unsupported';
}

/** VAPID public keys are base64url; PushManager wants raw bytes. */
function base64UrlToBytes(value: string) {
  const padded = `${value}${'='.repeat((4 - (value.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function sameKey(buffer: ArrayBuffer | null, expected: Uint8Array) {
  if (!buffer) return false;
  const actual = new Uint8Array(buffer);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

const services: [RegExp, string][] = [
  [/fcm\.googleapis\.com$/, 'Chrome, Edge ou Android'],
  [/push\.services\.mozilla\.com$/, 'Firefox'],
  [/notify\.windows\.com$/, 'Windows'],
  [/push\.apple\.com$/, 'Safari (Apple)'],
];
function deviceLabel(subscription: Subscription) {
  const service = services.find(([pattern]) => pattern.test(subscription.endpoint_host))?.[1] ?? subscription.endpoint_host;
  const agent = subscription.user_agent;
  const platform = /iPhone|iPad/.test(agent) ? 'iPhone / iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac'
    : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return platform && !service.includes(platform) ? `${service} · ${platform}` : service;
}

async function currentRegistration() {
  if (pushSupport() !== 'ready') return null;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

export default function NotificationPreferences() {
  const { data, loading, error, reload } = useApi<Preferences>('/realtime/preferences');
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [pending, setPending] = useState('');
  const [status, setStatus] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [support] = useState<PushSupport>(pushSupport);
  const [permission, setPermission] = useState<NotificationPermission | 'unknown'>(() => support === 'ready' ? Notification.permission : 'unknown');
  const [deviceSubscribed, setDeviceSubscribed] = useState<boolean | null>(null);
  const section = useRef<HTMLElement>(null);
  const { hash } = useLocation();

  useEffect(() => { if (data) setPreferences(data); }, [data]);

  const loaded = !!preferences;
  useEffect(() => {
    if (hash !== '#notifications' || !loaded) return;
    const frame = requestAnimationFrame(() => {
      section.current?.focus({ preventScroll: true });
      section.current?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, loaded]);

  useEffect(() => {
    let active = true;
    currentRegistration()
      .then((registration) => registration?.pushManager.getSubscription() ?? null)
      .then((subscription) => { if (active) setDeviceSubscribed(!!subscription); })
      .catch(() => { if (active) setDeviceSubscribed(false); });
    return () => { active = false; };
  }, []);

  async function save(change: { categories?: Record<string, Partial<Record<Channel, boolean>>>; email_frequency?: 'immediate' | 'daily' }, key: string, message: string) {
    if (!preferences || pending) return;
    const previous = preferences;
    // Optimistic update, rolled back on error.
    setPreferences({
      ...preferences,
      email_frequency: change.email_frequency ?? preferences.email_frequency,
      categories: preferences.categories.map((category) => ({ ...category, ...change.categories?.[category.id] })),
    });
    setPending(key);
    setStatus(null);
    try {
      setPreferences(await api<Preferences>('/realtime/preferences', { method: 'PUT', body: JSON.stringify(change) }));
      setStatus({ tone: 'success', message });
    } catch (error) {
      setPreferences(previous);
      setStatus({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending('');
    }
  }

  function toggle(category: Category, channel: Channel, value: boolean) {
    const label = channel === 'email' ? 'par e-mail' : 'en push';
    void save({ categories: { [category.id]: { [channel]: value } } }, `${category.id}:${channel}`,
      `${category.label} : notifications ${label} ${value ? 'activées' : 'désactivées'}.`);
  }

  function resetDefaults() {
    if (!preferences) return;
    void save({ categories: Object.fromEntries(preferences.categories.map((category) => [category.id, { ...category.defaults }])) },
      'defaults', 'Réglages par défaut rétablis.');
  }

  async function enablePush() {
    if (pending || support !== 'ready') return;
    setPending('push');
    setStatus(null);
    try {
      const { enabled, public_key: publicKey } = await api<{ enabled: boolean; public_key: string | null }>('/realtime/push/public-key');
      if (!enabled || !publicKey) throw new Error('Les notifications push sont désactivées sur la plateforme.');
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result !== 'granted') {
        setStatus({ tone: 'error', message: result === 'denied'
          ? 'Les notifications sont bloquées pour Alpha. Autorisez-les dans les réglages du site de votre navigateur, puis réessayez.'
          : 'Autorisation non accordée. Vous pourrez réessayer à tout moment.' });
        return;
      }
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const key = base64UrlToBytes(publicKey);
      let subscription = await registration.pushManager.getSubscription();
      // A subscription made with a previous (rotated) VAPID key can no longer be used.
      if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
        await subscription.unsubscribe().catch(() => false);
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('Abonnement push incomplet renvoyé par le navigateur.');
      try {
        await api('/realtime/push/subscriptions', {
          method: 'POST', body: JSON.stringify({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }),
        });
      } catch (error) {
        await subscription.unsubscribe().catch(() => false);
        throw error;
      }
      setDeviceSubscribed(true);
      setStatus({ tone: 'success', message: 'Notifications push activées sur cet appareil.' });
      reload();
    } catch (error) {
      setStatus({ tone: 'error', message: error instanceof DOMException
        ? 'Votre navigateur a refusé l’abonnement push. Vérifiez qu’il n’est pas en navigation privée et réessayez.'
        : errorMessage(error) });
    } finally {
      setPending('');
    }
  }

  async function disablePush() {
    if (pending) return;
    setPending('push');
    setStatus(null);
    try {
      const subscription = await (await currentRegistration())?.pushManager.getSubscription();
      if (subscription) {
        await api('/realtime/push/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) })
          .catch((error) => { if (!(error instanceof ApiError && error.status === 404)) throw error; });
        await subscription.unsubscribe().catch(() => false);
      }
      setDeviceSubscribed(false);
      setStatus({ tone: 'success', message: 'Notifications push désactivées sur cet appareil.' });
      reload();
    } catch (error) {
      setStatus({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending('');
    }
  }

  async function removeDevice(subscription: Subscription) {
    if (pending) return;
    setPending(`device:${subscription.id}`);
    setStatus(null);
    try {
      await api(`/realtime/push/subscriptions/${encodeURIComponent(subscription.id)}`, { method: 'DELETE' });
      setPreferences((current) => current && { ...current, push_subscriptions: current.push_subscriptions.filter((item) => item.id !== subscription.id) });
      setStatus({ tone: 'success', message: 'Appareil retiré. Il ne recevra plus de notifications push.' });
    } catch (error) {
      setStatus({ tone: 'error', message: errorMessage(error) });
    } finally {
      setPending('');
    }
  }

  const emailBlocked = !!preferences && (!preferences.channels.email_notifications || !preferences.email_verified);
  const pushBlocked = !!preferences && !preferences.channels.push;

  return <section className="card realtime-preferences" id="notifications" ref={section} tabIndex={-1} aria-labelledby="notification-preferences-title">
    <div className="card-header">
      <div>
        <h2 id="notification-preferences-title">Notifications</h2>
        <p className="muted small">Choisissez comment Alpha vous prévient. Les notifications restent toujours consultables dans l’application.</p>
      </div>
      {preferences && <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={resetDefaults}><RotateCcw size={14} aria-hidden="true" /> Réglages par défaut</button>}
    </div>
    <div className="card-body stack">
      {loading && !preferences && <Loading />}
      {error && !preferences && <div><ErrorState message={error} /><button type="button" className="button button-secondary button-small" onClick={reload}>Réessayer</button></div>}
      {preferences && <>
        {!preferences.channels.email_notifications && <p className="alert realtime-notice" role="note"><Mail size={14} aria-hidden="true" /> Les e-mails de notification sont temporairement suspendus par l’équipe Alpha. Vos choix seront appliqués à leur reprise.</p>}
        {preferences.channels.email_notifications && !preferences.email_verified && <p className="alert realtime-notice" role="note"><Mail size={14} aria-hidden="true" /> {preferences.email_verification_available
          ? 'Confirmez votre adresse e-mail pour recevoir les notifications par e-mail. Vos choix ci-dessous seront appliqués dès la confirmation.'
          : 'Les notifications par e-mail nécessitent une adresse vérifiée ; la vérification n’est pas encore disponible.'}</p>}
        {pushBlocked && <p className="alert realtime-notice" role="note"><BellOff size={14} aria-hidden="true" /> Les notifications push sont désactivées sur la plateforme pour le moment.</p>}

        <div className="table-wrap">
          <table className="data-table realtime-preferences-table">
            <caption className="realtime-sr-only">Canaux de notification par catégorie</caption>
            <thead><tr><th scope="col">Catégorie</th><th scope="col">Dans Alpha</th><th scope="col">E-mail</th><th scope="col">Push</th></tr></thead>
            <tbody>
              {preferences.categories.map((category) => <tr key={category.id}>
                <th scope="row"><strong>{category.label}</strong><span className="help-text">{category.description}</span></th>
                <td><label className="realtime-toggle" title="Toujours actif"><input type="checkbox" checked disabled aria-label={`${category.label} dans Alpha (toujours actif)`} /><span aria-hidden="true" /></label></td>
                {(['email', 'push'] as const).map((channel) => <td key={channel}>
                  <label className={`realtime-toggle ${(channel === 'email' ? emailBlocked : pushBlocked) ? 'is-muted' : ''}`}>
                    <input type="checkbox" checked={category[channel]} disabled={!!pending}
                      aria-label={`${category.label} ${channel === 'email' ? 'par e-mail' : 'en notification push'}`}
                      onChange={(event) => toggle(category, channel, event.target.checked)} />
                    <span aria-hidden="true" />
                  </label>
                </td>)}
              </tr>)}
            </tbody>
          </table>
        </div>

        <div className="field realtime-frequency">
          <label htmlFor="notification-email-frequency">Fréquence des e-mails</label>
          <select id="notification-email-frequency" value={preferences.email_frequency} disabled={!!pending}
            onChange={(event) => void save({ email_frequency: event.target.value as 'immediate' | 'daily' }, 'frequency',
              event.target.value === 'daily' ? 'Vous recevrez un résumé quotidien.' : 'Vous recevrez un e-mail à chaque notification.')}>
            <option value="immediate">À chaque notification</option>
            <option value="daily">Résumé quotidien (un e-mail par jour au plus)</option>
          </select>
          <span className="help-text">Les alertes de sécurité du compte sont toujours envoyées immédiatement.</span>
        </div>

        <div className="realtime-push-panel">
          <div className="row gap-sm"><MonitorSmartphone size={18} aria-hidden="true" /><strong>Notifications push sur cet appareil</strong>
            {deviceSubscribed && permission === 'granted' && <Badge tone="green">Activées</Badge>}</div>
          {support === 'unsupported' && <p className="muted small">Votre navigateur ne prend pas en charge les notifications push. Sur iPhone ou iPad (iOS 16.4 et plus), ajoutez d’abord Alpha à l’écran d’accueil depuis Safari.</p>}
          {support === 'insecure' && <p className="muted small">Les notifications push nécessitent une connexion sécurisée (HTTPS).</p>}
          {support === 'ready' && permission === 'denied' && <p className="muted small">Les notifications sont bloquées pour Alpha dans votre navigateur. Autorisez-les dans les réglages du site (icône à gauche de l’adresse), puis réessayez.</p>}
          {support === 'ready' && <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
            {deviceSubscribed && permission === 'granted'
              ? <button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => void disablePush()}><BellOff size={15} aria-hidden="true" /> {pending === 'push' ? 'Désactivation…' : 'Désactiver sur cet appareil'}</button>
              : <button type="button" className="button button-primary button-small" disabled={!!pending || pushBlocked || permission === 'denied' || deviceSubscribed === null} onClick={() => void enablePush()}><BellRing size={15} aria-hidden="true" /> {pending === 'push' ? 'Activation…' : 'Activer les notifications push'}</button>}
          </div>}
          <p className="help-text">Le contenu des messages privés, paiements et alertes de sécurité n’est jamais inclus dans une notification push : seul un résumé générique s’affiche.</p>
          {!!preferences.push_subscriptions.length && <>
            <h3 className="realtime-subtitle">Appareils abonnés ({preferences.push_subscriptions.length})</h3>
            <ul className="list realtime-devices">
              {preferences.push_subscriptions.map((subscription) => <li key={subscription.id} className="row-between">
                <span><strong>{deviceLabel(subscription)}</strong><span className="help-text">Ajouté le {date(subscription.created_at)}{subscription.last_success_at ? ` · dernier envoi le ${date(subscription.last_success_at)}` : ''}{subscription.failures ? ` · ${subscription.failures} échec${subscription.failures > 1 ? 's' : ''}` : ''}</span></span>
                <button type="button" className="icon-button" disabled={!!pending} aria-label={`Retirer ${deviceLabel(subscription)}`} onClick={() => void removeDevice(subscription)}><Trash2 size={15} /></button>
              </li>)}
            </ul>
          </>}
        </div>
      </>}
      <div aria-live="polite">{status && (status.tone === 'success'
        ? <p className="alert alert-success" role="status">{status.message}</p>
        : <ErrorState message={status.message} />)}</div>
    </div>
  </section>;
}
