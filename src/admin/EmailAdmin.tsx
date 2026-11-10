import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BellRing, Eye, KeyRound, Mail, RefreshCw, RotateCcw, Save, Send, Trash2, X } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Loading, Modal, useApi } from '../components/ui';
import { api, dateTime, errorMessage } from '../lib/api';
import '../styles/realtime.css';

/** Admin console — e-mail (SMTP, outbox), Web Push and global notification switches. OWNER: realtime module. */

interface SmtpSettings { host: string; port: number; secure: boolean; user: string; from: string }
interface SmtpDescription {
  configured: boolean;
  source: 'env' | 'settings' | 'none';
  env_override: { host: string; port: number | null; secure: boolean } | null;
  mail_from_env: boolean;
  from: string;
  settings: SmtpSettings | null;
  password: { configured: boolean; mask: string };
  updated_at: string | null;
  production_without_transport: boolean;
}
interface OutboxStats { queued: number; failed: number; sent: number; logged: number }
interface PushStatus {
  enabled: boolean; subject: string; effective_subject: string; ttl_seconds: number;
  public_key: string | null; private_key: { configured: boolean; mask: string }; keys_created_at: string | null;
  subscriptions: number; users: number; failing: number;
  hosts: { endpoint_host: string; count: number }[];
  outbox: { queued: number; sent: number; failed: number };
  recent_failures: { id: string; endpoint_host: string; last_error: string; created_at: string }[];
}
interface Channels { email_notifications: boolean; push: boolean }
interface Status {
  smtp: SmtpDescription; outbox: OutboxStats; push: PushStatus; channels: Channels;
  streams: { connections: number; users: number; max_per_user: number; heartbeat_ms: number };
}
type EmailStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'logged' | 'cancelled';
interface OutboxEmail {
  id: string; to_address: string; user_id: string | null; category: string; subject: string; sensitive: boolean; status: EmailStatus;
  attempts: number; last_error: string; send_after: string; sent_at: string | null; created_at: string;
}
interface OutboxPage { emails: OutboxEmail[]; has_more: boolean; stats: OutboxStats; categories: { category: string; count: number }[] }
interface EmailDetail extends Omit<OutboxEmail, 'user_id'> { text_body: string | null; body_hidden: boolean }
type Notice = { tone: 'success' | 'error'; message: string } | null;

const statusLabels: Record<EmailStatus, string> = {
  queued: 'En file', sending: 'Envoi…', sent: 'Envoyé', failed: 'Échec', logged: 'Journalisé (dév.)', cancelled: 'Annulé',
};
const statusTones: Record<EmailStatus, string> = { queued: 'blue', sending: 'blue', sent: 'green', failed: 'red', logged: 'neutral', cancelled: 'neutral' };
const PAGE = 50;

function NoticeLine({ notice }: { notice: Notice }) {
  return <div aria-live="polite">{notice && (notice.tone === 'success'
    ? <p className="alert alert-success" role="status">{notice.message}</p>
    : <ErrorState message={notice.message} />)}</div>;
}

function Overview({ status }: { status: Status }) {
  const { smtp, outbox, push, streams } = status;
  return <div className="stat-grid realtime-admin-stats">
    <div className="stat-card"><p className="stat-label">Transport e-mail</p><p className="stat-value">{smtp.configured ? 'SMTP' : 'Journal'}</p>
      <p className="stat-note">{smtp.source === 'env' ? 'Défini par SMTP_URL' : smtp.source === 'settings' ? 'Configuré dans la console' : 'Aucun SMTP : e-mails journalisés'}</p></div>
    <div className="stat-card"><p className="stat-label">File d’envoi</p><p className="stat-value">{outbox.queued}</p>
      <p className="stat-note">{outbox.failed} en échec · {outbox.sent} envoyés · {outbox.logged} journalisés</p></div>
    <div className="stat-card"><p className="stat-label">Abonnements push</p><p className="stat-value">{push.subscriptions}</p>
      <p className="stat-note">{push.users} membre{push.users > 1 ? 's' : ''} · {streams.connections} flux temps réel ouvert{streams.connections > 1 ? 's' : ''}</p></div>
  </div>;
}

function ChannelsPanel({ channels, onChange }: { channels: Channels; onChange: (channels: Channels) => void }) {
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  async function update(key: keyof Channels, value: boolean) {
    if (!value && !window.confirm(key === 'push'
      ? 'Suspendre toutes les notifications push de la plateforme ?'
      : 'Suspendre tous les e-mails de notification ? (Les e-mails de sécurité et transactionnels ne sont pas concernés.)')) return;
    setPending(key); setNotice(null);
    try {
      onChange(await api<Channels>('/realtime/admin/channels', { method: 'PUT', body: JSON.stringify({ [key]: value }) }));
      setNotice({ tone: 'success', message: value ? 'Canal réactivé.' : 'Canal suspendu pour tous les membres.' });
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }
  const rows: [keyof Channels, string, string][] = [
    ['email_notifications', 'E-mails de notification', 'Notifications et résumés quotidiens envoyés par e-mail selon les préférences des membres.'],
    ['push', 'Notifications push', 'Notifications Web Push envoyées aux appareils abonnés.'],
  ];
  return <section className="card" aria-labelledby="realtime-channels-title">
    <div className="card-header"><h2 id="realtime-channels-title">Interrupteurs globaux</h2></div>
    <div className="card-body stack">
      <ul className="list">
        {rows.map(([key, label, help]) => <li key={key} className="row-between realtime-switch-row">
          <span><strong>{label}</strong><span className="help-text">{help}</span></span>
          <span className="row gap-sm">
            <Badge tone={channels[key] ? 'green' : 'red'}>{channels[key] ? 'Actif' : 'Suspendu'}</Badge>
            <button type="button" className={`button button-small ${channels[key] ? 'button-secondary' : 'button-primary'}`} disabled={!!pending}
              onClick={() => void update(key, !channels[key])}>{pending === key ? 'Mise à jour…' : channels[key] ? 'Suspendre' : 'Réactiver'}</button>
          </span>
        </li>)}
      </ul>
      <p className="help-text">Les notifications restent toujours visibles dans Alpha. Les e-mails transactionnels (vérification, réinitialisation, sécurité) ne dépendent pas de ces interrupteurs.</p>
      <NoticeLine notice={notice} />
    </div>
  </section>;
}

function SmtpPanel({ smtp, onChange, onTested }: { smtp: SmtpDescription; onChange: (smtp: SmtpDescription) => void; onTested: () => void }) {
  const empty: SmtpSettings = { host: '', port: 587, secure: false, user: '', from: smtp.from || 'Alpha <no-reply@alpha.local>' };
  const [form, setForm] = useState<SmtpSettings>(smtp.settings ?? empty);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState<Notice>(null);

  // Reset only when the stored configuration really changed (not on every status refresh).
  const storedKey = JSON.stringify(smtp.settings);
  useEffect(() => { setForm(smtp.settings ?? empty); }, [storedKey]);
  const set = <K extends keyof SmtpSettings>(key: K, value: SmtpSettings[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending('save'); setNotice(null);
    try {
      const body = { ...form, ...(password ? { password } : {}), ...(clearPassword && !password ? { clear_password: true } : {}) };
      onChange(await api<SmtpDescription>('/realtime/admin/email/smtp', { method: 'PUT', body: JSON.stringify(body) }));
      setPassword(''); setClearPassword(false);
      setNotice({ tone: 'success', message: 'Configuration SMTP enregistrée. Envoyez un e-mail de test pour la valider.' });
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  async function remove() {
    if (pending || !window.confirm('Supprimer la configuration SMTP et son mot de passe ?')) return;
    setPending('remove'); setNotice(null);
    try {
      onChange(await api<SmtpDescription>('/realtime/admin/email/smtp', { method: 'DELETE' }));
      setPassword(''); setClearPassword(false);
      setNotice({ tone: 'success', message: 'Configuration SMTP supprimée.' });
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  async function sendTest() {
    if (pending) return;
    setPending('test'); setNotice(null);
    try {
      const { email } = await api<{ email: { id: string; status: EmailStatus; last_error: string; attempts: number } }>('/realtime/admin/email/test', {
        method: 'POST', body: JSON.stringify(testTo.trim() ? { to: testTo.trim() } : {}),
      });
      const message = email.status === 'sent' ? 'E-mail de test envoyé. Vérifiez la boîte de réception (et les indésirables).'
        : email.status === 'logged' ? 'Aucun SMTP actif : l’e-mail de test a été écrit dans les journaux du serveur.'
          : email.status === 'failed' || email.last_error ? `Échec de l’envoi : ${email.last_error || 'erreur inconnue'}. Une nouvelle tentative est programmée.`
            : 'E-mail de test placé en file d’attente.';
      setNotice({ tone: email.status === 'sent' || email.status === 'logged' || (email.status === 'queued' && !email.last_error) ? 'success' : 'error', message });
      onTested();
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  return <section className="card" aria-labelledby="realtime-smtp-title">
    <div className="card-header">
      <h2 id="realtime-smtp-title">Serveur SMTP</h2>
      <Badge tone={smtp.configured ? 'green' : smtp.production_without_transport ? 'red' : 'orange'}>{smtp.configured ? 'Configuré' : 'Non configuré'}</Badge>
    </div>
    <div className="card-body stack">
      {smtp.env_override && <p className="alert realtime-notice" role="note">La variable d’environnement <code>SMTP_URL</code> est définie ({smtp.env_override.host}{smtp.env_override.port ? `:${smtp.env_override.port}` : ''}) : elle a priorité sur la configuration ci-dessous.</p>}
      {smtp.production_without_transport && <p className="alert alert-error" role="alert">Production sans transport e-mail : les e-mails restent en file d’attente. Configurez un serveur SMTP.</p>}
      {smtp.mail_from_env && <p className="help-text">L’adresse d’expédition est fixée par <code>MAIL_FROM</code> : {smtp.from}</p>}
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <div className="field"><label htmlFor="smtp-host">Serveur (hôte)</label><input id="smtp-host" required maxLength={255} value={form.host} placeholder="smtp.exemple.fr" autoComplete="off" onChange={(event) => set('host', event.target.value)} /></div>
          <div className="field"><label htmlFor="smtp-port">Port</label><input id="smtp-port" type="number" required min={1} max={65535} value={form.port} onChange={(event) => set('port', Number(event.target.value))} /></div>
          <div className="field"><label htmlFor="smtp-user">Identifiant</label><input id="smtp-user" maxLength={255} value={form.user} autoComplete="off" placeholder="Laisser vide si non requis" onChange={(event) => set('user', event.target.value)} /></div>
          <div className="field">
            <label htmlFor="smtp-password">Mot de passe</label>
            <input id="smtp-password" type="password" maxLength={500} value={password} autoComplete="new-password" disabled={clearPassword}
              placeholder={smtp.password.configured ? `${smtp.password.mask} (inchangé)` : 'Aucun mot de passe enregistré'} onChange={(event) => setPassword(event.target.value)} />
            <span className="help-text">Stocké chiffré, jamais réaffiché. Laissez vide pour conserver le mot de passe actuel.</span>
            {smtp.password.configured && <label className="realtime-check"><input type="checkbox" checked={clearPassword} onChange={(event) => { setClearPassword(event.target.checked); if (event.target.checked) setPassword(''); }} /> Supprimer le mot de passe enregistré</label>}
          </div>
          <div className="field"><label htmlFor="smtp-from">Expéditeur</label><input id="smtp-from" required maxLength={255} value={form.from} placeholder="Alpha <no-reply@exemple.fr>" onChange={(event) => set('from', event.target.value)} /></div>
          <div className="field"><span>Sécurité</span><label className="realtime-check"><input type="checkbox" checked={form.secure} onChange={(event) => set('secure', event.target.checked)} /> TLS implicite (SMTPS, généralement port 465)</label><span className="help-text">Décoché : STARTTLS est utilisé lorsque le serveur le propose (port 587).</span></div>
        </div>
        <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
          <button type="submit" className="button button-primary" disabled={!!pending}><Save size={15} aria-hidden="true" /> {pending === 'save' ? 'Enregistrement…' : 'Enregistrer'}</button>
          {smtp.settings && <button type="button" className="button button-ghost" disabled={!!pending} onClick={() => void remove()}><Trash2 size={15} aria-hidden="true" /> Supprimer la configuration</button>}
        </div>
      </form>
      <div className="realtime-test-row">
        <div className="field"><label htmlFor="smtp-test-to">Destinataire du test</label><input id="smtp-test-to" type="email" maxLength={254} value={testTo} placeholder="Votre adresse (par défaut)" onChange={(event) => setTestTo(event.target.value)} /></div>
        <button type="button" className="button button-secondary" disabled={!!pending} onClick={() => void sendTest()}><Send size={15} aria-hidden="true" /> {pending === 'test' ? 'Envoi…' : 'Envoyer un e-mail de test'}</button>
      </div>
      {smtp.updated_at && <p className="help-text">Dernière modification : {dateTime(smtp.updated_at)}</p>}
      <NoticeLine notice={notice} />
    </div>
  </section>;
}

function OutboxPanel({ version, onChanged }: { version: number; onChanged: () => void }) {
  const [status, setStatus] = useState<EmailStatus | ''>('');
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  if (search) params.set('q', search);
  const outbox = useApi<OutboxPage>(`/realtime/admin/email/outbox?${params}`);
  const reloadOutbox = useRef(outbox.reload);
  reloadOutbox.current = outbox.reload;
  const seenVersion = useRef(version);
  useEffect(() => {
    if (seenVersion.current === version) return;
    seenVersion.current = version;
    reloadOutbox.current();
  }, [version]);
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [detail, setDetail] = useState<EmailDetail | null>(null);

  async function act(email: OutboxEmail, action: 'retry' | 'cancel') {
    if (pending) return;
    if (action === 'cancel' && !window.confirm(`Annuler l’envoi de « ${email.subject} » ?`)) return;
    setPending(`${action}:${email.id}`); setNotice(null);
    try {
      await api(`/realtime/admin/email/outbox/${encodeURIComponent(email.id)}/${action}`, { method: 'POST' });
      setNotice({ tone: 'success', message: action === 'retry' ? 'E-mail replacé en file d’attente.' : 'Envoi annulé.' });
      outbox.reload(); onChanged();
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  async function view(email: OutboxEmail) {
    if (pending) return;
    setPending(`view:${email.id}`); setNotice(null);
    try {
      setDetail((await api<{ email: EmailDetail }>(`/realtime/admin/email/outbox/${encodeURIComponent(email.id)}`)).email);
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  return <section className="card" aria-labelledby="realtime-outbox-title">
    <div className="card-header">
      <h2 id="realtime-outbox-title">File d’envoi des e-mails</h2>
      <button type="button" className="button button-secondary button-small" disabled={outbox.loading} onClick={outbox.reload}><RefreshCw size={14} aria-hidden="true" /> Actualiser</button>
    </div>
    <div className="card-body stack">
      <form className="realtime-filters" onSubmit={(event) => { event.preventDefault(); setOffset(0); setSearch(query.trim()); }}>
        <div className="field"><label htmlFor="outbox-status">Statut</label>
          <select id="outbox-status" value={status} onChange={(event) => { setStatus(event.target.value as EmailStatus | ''); setOffset(0); }}>
            <option value="">Tous</option>
            {(Object.keys(statusLabels) as EmailStatus[]).map((value) => <option key={value} value={value}>{statusLabels[value]}</option>)}
          </select></div>
        <div className="field"><label htmlFor="outbox-category">Catégorie</label>
          <select id="outbox-category" value={category} onChange={(event) => { setCategory(event.target.value); setOffset(0); }}>
            <option value="">Toutes</option>
            {outbox.data?.categories.map((item) => <option key={item.category} value={item.category}>{item.category} ({item.count})</option>)}
            {category && !outbox.data?.categories.some((item) => item.category === category) && <option value={category}>{category}</option>}
          </select></div>
        <div className="field"><label htmlFor="outbox-search">Destinataire ou objet</label><input id="outbox-search" type="search" maxLength={120} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <button type="submit" className="button button-secondary button-small">Filtrer</button>
      </form>
      <NoticeLine notice={notice} />
      {outbox.loading ? <Loading /> : outbox.error ? <ErrorState message={outbox.error} /> : outbox.data && (outbox.data.emails.length ? <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th scope="col">Créé</th><th scope="col">Destinataire</th><th scope="col">Catégorie</th><th scope="col">Objet</th><th scope="col">Statut</th><th scope="col">Tentatives</th><th scope="col"><span className="realtime-sr-only">Actions</span></th></tr></thead>
          <tbody>{outbox.data.emails.map((email) => <tr key={email.id}>
            <td>{dateTime(email.created_at)}</td>
            <td className="realtime-cell-wrap">{email.to_address}</td>
            <td><code>{email.category}</code>{email.sensitive && <> <Badge tone="orange">Sensible</Badge></>}</td>
            <td className="realtime-cell-wrap">{email.subject}</td>
            <td><Badge tone={statusTones[email.status]}>{statusLabels[email.status]}</Badge>{email.last_error && <span className="help-text realtime-cell-wrap" title={email.last_error}>{email.last_error.slice(0, 120)}</span>}</td>
            <td>{email.attempts}</td>
            <td><span className="row gap-sm realtime-actions">
              <button type="button" className="icon-button" disabled={!!pending} aria-label={`Voir l’e-mail « ${email.subject} »`} onClick={() => void view(email)}><Eye size={15} /></button>
              {email.status === 'failed' && <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => void act(email, 'retry')}><RotateCcw size={14} aria-hidden="true" /> Relancer</button>}
              {email.status === 'queued' && <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => void act(email, 'cancel')}><X size={14} aria-hidden="true" /> Annuler</button>}
            </span></td>
          </tr>)}</tbody>
        </table>
      </div> : <EmptyState title="Aucun e-mail" description={status || category || search ? 'Aucun e-mail ne correspond à ces filtres.' : 'Les e-mails envoyés par la plateforme apparaîtront ici.'} />)}
      {outbox.data && (offset > 0 || outbox.data.has_more) && <div className="row-between">
        <button type="button" className="button button-ghost button-small" disabled={!offset || outbox.loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Précédent</button>
        <span className="small muted">Page {Math.floor(offset / PAGE) + 1}</span>
        <button type="button" className="button button-ghost button-small" disabled={!outbox.data.has_more || outbox.loading} onClick={() => setOffset(offset + PAGE)}>Suivant</button>
      </div>}
      <p className="help-text">Le contenu des e-mails sensibles (codes, liens de connexion, paiements, messages privés) n’est jamais affiché. Chaque consultation d’un contenu est journalisée.</p>
    </div>
    {detail && <Modal title={detail.subject} onClose={() => setDetail(null)}>
      <div className="stack">
        <p className="small muted">À {detail.to_address} · <code>{detail.category}</code> · {statusLabels[detail.status]} · créé le {dateTime(detail.created_at)}{detail.sent_at ? ` · envoyé le ${dateTime(detail.sent_at)}` : ''}</p>
        {detail.last_error && <p className="alert alert-error">{detail.last_error}</p>}
        {detail.body_hidden ? <p className="alert realtime-notice">Contenu masqué : cet e-mail contient des informations sensibles.</p>
          : <pre className="realtime-email-body">{detail.text_body}</pre>}
      </div>
    </Modal>}
  </section>;
}

function PushPanel({ push, onChange }: { push: PushStatus; onChange: (push: PushStatus) => void }) {
  const [subject, setSubject] = useState(push.subject);
  const [ttlHours, setTtlHours] = useState(Math.round(push.ttl_seconds / 3600));
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  useEffect(() => { setSubject(push.subject); setTtlHours(Math.max(1, Math.round(push.ttl_seconds / 3600))); }, [push.subject, push.ttl_seconds]);

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending('save'); setNotice(null);
    try {
      onChange(await api<PushStatus>('/realtime/admin/push', { method: 'PUT', body: JSON.stringify({ subject: subject.trim(), ttl_seconds: ttlHours * 3600 }) }));
      setNotice({ tone: 'success', message: 'Paramètres push enregistrés.' });
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  async function keys(rotate: boolean) {
    if (pending) return;
    if (rotate && !window.confirm(`Générer de nouvelles clés VAPID ? Les ${push.subscriptions} abonnement(s) existant(s) seront supprimés et les membres devront réactiver les notifications push.`)) return;
    setPending('keys'); setNotice(null);
    try {
      const result = await api<PushStatus & { removed_subscriptions: number }>('/realtime/admin/push/keys', {
        method: 'POST', body: JSON.stringify(rotate ? { rotate: true, confirm: true } : {}),
      });
      onChange(result);
      setNotice({ tone: 'success', message: rotate ? `Nouvelles clés générées. ${result.removed_subscriptions} abonnement(s) supprimé(s).` : 'Clés VAPID prêtes.' });
    } catch (error) {
      setNotice({ tone: 'error', message: errorMessage(error) });
    } finally { setPending(''); }
  }

  async function copyKey() {
    if (!push.public_key) return;
    try { await navigator.clipboard.writeText(push.public_key); setNotice({ tone: 'success', message: 'Clé publique copiée.' }); }
    catch { setNotice({ tone: 'error', message: 'Copie impossible : sélectionnez la clé manuellement.' }); }
  }

  return <section className="card" aria-labelledby="realtime-push-title">
    <div className="card-header">
      <h2 id="realtime-push-title">Notifications push (Web Push)</h2>
      <Badge tone={push.enabled ? 'green' : 'neutral'}>{push.enabled ? 'Actives' : 'Suspendues'}</Badge>
    </div>
    <div className="card-body stack">
      <dl className="realtime-keys">
        <dt>Clé publique VAPID</dt>
        <dd>{push.public_key ? <><code className="realtime-key">{push.public_key}</code> <button type="button" className="button button-ghost button-small" onClick={() => void copyKey()}>Copier</button></> : <span className="muted">Générée automatiquement au premier abonnement.</span>}</dd>
        <dt>Clé privée</dt>
        <dd>{push.private_key.configured ? <><code>{push.private_key.mask}</code> <span className="help-text">chiffrée dans les paramètres, jamais affichée</span></> : <span className="muted">Non générée</span>}</dd>
        {push.keys_created_at && <><dt>Clés créées le</dt><dd>{dateTime(push.keys_created_at)}</dd></>}
        <dt>Sujet VAPID utilisé</dt><dd><code>{push.effective_subject}</code></dd>
      </dl>
      <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
        {!push.public_key && <button type="button" className="button button-secondary button-small" disabled={!!pending} onClick={() => void keys(false)}><KeyRound size={14} aria-hidden="true" /> Générer les clés</button>}
        {push.public_key && <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => void keys(true)}><RotateCcw size={14} aria-hidden="true" /> Renouveler les clés</button>}
      </div>
      <form className="form-grid" onSubmit={saveConfig}>
        <div className="field"><label htmlFor="push-subject">Sujet VAPID (contact)</label><input id="push-subject" maxLength={255} value={subject} placeholder="mailto:contact@exemple.fr ou https://exemple.fr" onChange={(event) => setSubject(event.target.value)} /><span className="help-text">Vide : dérivé de <code>APP_ORIGIN</code>. Les services push l’utilisent pour vous contacter en cas d’abus.</span></div>
        <div className="field"><label htmlFor="push-ttl">Durée de conservation (heures)</label><input id="push-ttl" type="number" min={1} max={672} required value={ttlHours} onChange={(event) => setTtlHours(Number(event.target.value))} /><span className="help-text">Durée pendant laquelle le service push garde une notification pour un appareil hors ligne (max. 28 jours).</span></div>
        <div><button type="submit" className="button button-primary button-small" disabled={!!pending}><Save size={14} aria-hidden="true" /> {pending === 'save' ? 'Enregistrement…' : 'Enregistrer'}</button></div>
      </form>
      <div className="stat-grid realtime-admin-stats">
        <div className="stat-card"><p className="stat-label">Abonnements</p><p className="stat-value">{push.subscriptions}</p><p className="stat-note">{push.failing} avec des échecs récents</p></div>
        <div className="stat-card"><p className="stat-label">En attente</p><p className="stat-value">{push.outbox.queued}</p><p className="stat-note">{push.outbox.sent} envoyées</p></div>
        <div className="stat-card"><p className="stat-label">Échecs</p><p className="stat-value">{push.outbox.failed}</p><p className="stat-note">Abonnements expirés supprimés automatiquement</p></div>
      </div>
      {!!push.hosts.length && <p className="small muted">Services : {push.hosts.map((host) => `${host.endpoint_host} (${host.count})`).join(' · ')}</p>}
      {!!push.recent_failures.length && <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Date</th><th scope="col">Service</th><th scope="col">Erreur</th></tr></thead>
        <tbody>{push.recent_failures.map((failure) => <tr key={failure.id}><td>{dateTime(failure.created_at)}</td><td>{failure.endpoint_host || 'Abonnement supprimé'}</td><td className="realtime-cell-wrap">{failure.last_error}</td></tr>)}</tbody>
      </table></div>}
      <NoticeLine notice={notice} />
    </div>
  </section>;
}

export default function EmailAdmin() {
  const { data, loading, error, reload } = useApi<Status>('/realtime/admin/status');
  const [status, setStatus] = useState<Status | null>(null);
  const [outboxVersion, setOutboxVersion] = useState(0);
  useEffect(() => { if (data) setStatus(data); }, [data]);
  const refreshAll = () => { reload(); setOutboxVersion((value) => value + 1); };
  if (loading && !status) return <Loading />;
  if (error && !status) return <div className="stack"><ErrorState message={error} /><button type="button" className="button button-secondary" onClick={reload}>Réessayer</button></div>;
  if (!status) return null;
  return <div className="stack realtime-admin">
    <div className="row-between">
      <p className="muted small"><Mail size={14} aria-hidden="true" /> E-mails transactionnels et de notification · <BellRing size={14} aria-hidden="true" /> Web Push · flux temps réel</p>
      <button type="button" className="button button-ghost button-small" disabled={loading} onClick={refreshAll}><RefreshCw size={14} aria-hidden="true" /> Actualiser</button>
    </div>
    <Overview status={status} />
    <ChannelsPanel channels={status.channels} onChange={(channels) => setStatus({ ...status, channels, push: { ...status.push, enabled: channels.push } })} />
    <SmtpPanel smtp={status.smtp} onChange={(smtp) => setStatus({ ...status, smtp })} onTested={refreshAll} />
    <OutboxPanel version={outboxVersion} onChanged={reload} />
    <PushPanel push={status.push} onChange={(push) => setStatus({ ...status, push, channels: { ...status.channels, push: push.enabled } })} />
  </div>;
}
