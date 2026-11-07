import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowUpRight, Bell, Check, CheckCheck, ChevronLeft, ChevronRight, LockKeyhole, Mail, Plus, RefreshCw, Search, Send, X } from 'lucide-react';
import { Avatar, Badge, EmptyState, ErrorState, Loading, LoginNotice, Modal, PageHeader, useApi } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Person {
  id: string;
  name: string;
  title: string;
  avatar_color: string;
}
interface Conversation {
  id: string;
  subject: string;
  created_by: string;
  created_at: string;
  participants: Person[];
  last_message_at?: string | null;
  last_message_body?: string | null;
  last_sender_id?: string | null;
}
interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}
interface Thread {
  conversation: Conversation;
  messages: Message[];
  has_more: boolean;
  next_before: string | null;
}
interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: string | null;
  created_at: string;
}

const styles = `
.communication-inbox{display:grid;grid-template-columns:minmax(260px,330px) minmax(0,1fr);overflow:hidden;min-height:600px}
.communication-sidebar{border-right:1px solid var(--border,#e8e8f0);min-width:0;display:flex;flex-direction:column}
.communication-search{padding:20px;border-bottom:1px solid var(--border,#e8e8f0)}
.communication-search .field{margin:0}
.communication-list{list-style:none;padding:0;margin:0;max-height:650px;overflow:auto;flex:1}
.communication-item{width:100%;border:0;border-bottom:1px solid var(--border,#e8e8f0);background:transparent;text-align:left;color:inherit;padding:20px;display:flex;align-items:flex-start;gap:12px;cursor:pointer}
.communication-item:hover{background:#f8f7ff}
.communication-item[aria-current=true]{background:#f1eeff;box-shadow:inset 3px 0 #7563ed}
.communication-item-main{min-width:0;flex:1}
.communication-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}
.communication-item-subject{font-weight:650;margin:5px 0}
.communication-pane{display:flex;flex-direction:column;min-width:0}
.communication-thread-heading{padding:22px;border-bottom:1px solid var(--border,#e8e8f0)}
.communication-thread-heading h2{margin:0 0 10px;overflow-wrap:anywhere;font-size:1.2rem}
.communication-participants{display:flex;gap:12px;flex-wrap:wrap}
.communication-profile{display:inline-flex;align-items:center;gap:7px;font-size:.85rem}
.communication-history{padding:24px;min-height:300px;max-height:570px;overflow:auto;flex:1;background:#fcfcfe}
.communication-messages{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:20px}
.communication-message{max-width:85%;align-self:flex-start;min-width:0}
.communication-message.own{align-self:flex-end}
.communication-message-meta{display:flex;gap:10px;align-items:center;font-size:.75rem;margin-bottom:7px;flex-wrap:wrap;color:#737183}
.communication-message.own .communication-message-meta{justify-content:flex-end}
.communication-text{padding:14px 18px;border:1px solid #e8e8f0;border-radius:4px 16px 16px;background:white;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}
.communication-message.own .communication-text{background:#eeeaff;border-color:#e4ddff;border-radius:16px 4px 16px 16px}
.communication-compose{padding:20px;border-top:1px solid var(--border,#e8e8f0)}
.communication-compose textarea{min-height:96px;resize:vertical}
.communication-compose-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px}
.communication-back{display:none}
.communication-pagination{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 20px}
.communication-person-list{max-height:245px;overflow:auto;border:1px solid #e8e8f0;border-radius:12px;padding:4px}
.communication-person{display:flex;align-items:center;gap:12px;padding:12px;cursor:pointer;border-radius:8px}
.communication-person:has(input:checked){background:#f1eeff}
.communication-person input{width:auto;flex-shrink:0;accent-color:#7563ed}
.communication-recipient{display:flex;align-items:center;gap:10px;padding:12px;background:#f4f1ff;border-radius:12px}
.communication-notification{display:flex;align-items:flex-start;gap:18px;padding:22px}
.communication-notification.unread{background:#faf9ff;border-left:3px solid #7563ed}
.communication-notification-icon{background:#eeebff;color:#7563ed;padding:12px;border-radius:14px;display:flex;flex-shrink:0}
.communication-notification-main{flex:1;min-width:0}
.communication-notification h2{font-size:1rem;margin:0;overflow-wrap:anywhere}
.communication-notification-body{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;color:#6b687d;line-height:1.6}
.communication-notification-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
.communication-notification+.communication-notification{border-top:1px solid #e8e8f0}
.communication-status{padding:20px}
.communication-private{display:flex;gap:6px;align-items:center;font-size:.75rem;color:#777386}
@media(max-width:800px){
  .communication-inbox{grid-template-columns:minmax(0,1fr);min-height:460px}
  .communication-sidebar{border-right:0}
  .communication-inbox.has-selection .communication-sidebar{display:none}
  .communication-inbox:not(.has-selection) .communication-pane{display:none}
  .communication-back{display:inline-flex;margin-bottom:14px}
  .communication-history{padding:16px;max-height:55vh}
  .communication-thread-heading,.communication-compose{padding:16px}
  .communication-message{max-width:94%}
  .communication-notification{padding:18px;gap:12px}
  .communication-notification-icon{padding:9px}
  .communication-compose-footer{align-items:flex-end}
}
`;

function timestamp(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  }).format(parsed);
}

function useDebounced(value: string) {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDelayed(value), 250);
    return () => window.clearTimeout(timer);
  }, [value]);
  return delayed;
}

function internalLink(value: string) {
  return /^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020\u007f]/.test(value) ? value : '/notifications';
}

function Pagination({ offset, hasMore, pending, onChange }: {
  offset: number;
  hasMore: boolean;
  pending: boolean;
  onChange: (offset: number) => void;
}) {
  if (!offset && !hasMore) return null;
  return <nav className="communication-pagination" aria-label="Pagination">
    <button type="button" className="button button-ghost button-small" disabled={pending || !offset} onClick={() => onChange(Math.max(0, offset - 30))}><ChevronLeft size={16} /> Précédent</button>
    <span className="small muted">Page {Math.floor(offset / 30) + 1}</span>
    <button type="button" className="button button-ghost button-small" disabled={pending || !hasMore} onClick={() => onChange(offset + 30)}>Suivant <ChevronRight size={16} /></button>
  </nav>;
}

function NewConversation({ onClose, onCreated }: {
  onClose: () => void;
  onCreated: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const delayedQuery = useDebounced(query);
  const people = useApi<{ people: Person[]; has_more: boolean }>(
    `/communication/people?limit=20&q=${encodeURIComponent(delayedQuery)}`,
  );
  const [recipient, setRecipient] = useState<Person | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !recipient) return;
    setPending(true);
    setError('');
    try {
      const result = await api<{ conversation: Conversation }>('/communication/conversations', {
        method: 'POST', body: JSON.stringify({ subject, body, recipient_id: recipient.id }),
      });
      onCreated(result.conversation.id);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return <Modal title="Nouvelle conversation" onClose={() => { if (!pending) onClose(); }}>
    <form className="form" onSubmit={submit}>
      <p className="muted small">Un espace privé entre vous et le membre choisi. Votre premier message sera envoyé à la création.</p>
      <div className="field">
        <label htmlFor="recipient-search">Rechercher un destinataire</label>
        <input id="recipient-search" type="search" maxLength={120} value={query} disabled={pending}
          placeholder="Nom ou spécialité d’un membre…" onChange={(event) => setQuery(event.target.value)} />
      </div>
      {people.loading && <Loading />}
      {people.error && <div><ErrorState message={people.error} /><button type="button" className="button button-ghost button-small" onClick={people.reload}>Réessayer</button></div>}
      {!people.loading && !people.error && people.data && <>
        {people.data.people.length ? <fieldset className="communication-person-list" disabled={pending}>
          <legend className="small muted">Choisissez un membre</legend>
          {people.data.people.map((person) => <label className="communication-person" key={person.id}>
            <input type="radio" name="recipient" value={person.id} checked={recipient?.id === person.id} onChange={() => setRecipient(person)} />
            <Avatar name={person.name} color={person.avatar_color} size="small" />
            <span><strong>{person.name}</strong><span className="small muted" style={{ display: 'block' }}>{person.title || 'Membre Alpha'}</span></span>
          </label>)}
        </fieldset> : <p className="small muted">Aucun autre membre trouvé. Essayez un autre nom.</p>}
        {people.data.has_more && <p className="help-text">Les 20 premiers résultats sont affichés. Affinez votre recherche pour trouver votre destinataire.</p>}
      </>}
      {recipient && <div className="communication-recipient">
        <Avatar name={recipient.name} color={recipient.avatar_color} size="small" />
        <span style={{ flex: 1 }}><span className="small muted">Destinataire choisi</span><strong style={{ display: 'block' }}>{recipient.name}</strong></span>
        <Link to={`/people/${recipient.id}`} className="button button-ghost button-small">Profil <ArrowUpRight size={14} /></Link>
        <button type="button" disabled={pending} className="icon-button" aria-label="Retirer le destinataire" onClick={() => setRecipient(null)}><X size={16} /></button>
      </div>}
      <div className="field"><label htmlFor="conversation-subject">Objet</label><input id="conversation-subject" value={subject} onChange={(event) => setSubject(event.target.value)} required maxLength={160} disabled={pending} placeholder="Et si nous construisions quelque chose ensemble ?" /></div>
      <div className="field"><label htmlFor="conversation-initial-message">Votre message</label><textarea id="conversation-initial-message" value={body} onChange={(event) => setBody(event.target.value)} required maxLength={10_000} rows={5} disabled={pending} placeholder="Présentez votre idée, votre question ou votre proposition…" /><span className="help-text">{body.length.toLocaleString('fr-FR')} / 10 000 caractères</span></div>
      <ErrorState message={error} />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="button button-secondary" disabled={pending} onClick={onClose}>Annuler</button>
        <button type="submit" className="button button-primary" disabled={pending || !recipient || !subject.trim() || !body.trim()}><Send size={16} /> {pending ? 'Envoi en cours…' : 'Envoyer le message'}</button>
      </div>
    </form>
  </Modal>;
}

function Inbox({ userId }: { userId: string }) {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('conversation') || '';
  const [query, setQuery] = useState('');
  const delayedQuery = useDebounced(query);
  const [offset, setOffset] = useState(0);
  const [creating, setCreating] = useState(false);
  const conversations = useApi<{ conversations: Conversation[]; has_more: boolean }>(
    `/communication/conversations?limit=30&offset=${offset}&q=${encodeURIComponent(delayedQuery)}`,
  );
  const thread = useApi<Thread>(selectedId ? `/communication/conversations/${encodeURIComponent(selectedId)}` : null);
  const activeThread = thread.data?.conversation.id === selectedId ? thread.data : null;
  const [draft, setDraft] = useState({ conversationId: '', body: '' });
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [history, setHistory] = useState<{ conversationId: string; messages: Message[]; next: string | null } | null>(null);
  const [historyPending, setHistoryPending] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const scrollArea = useRef<HTMLDivElement>(null);
  const body = draft.conversationId === selectedId ? draft.body : '';
  const older = history?.conversationId === selectedId ? history : null;
  const nextBefore = older ? older.next : activeThread?.next_before;
  const messages = [...(older?.messages ?? []), ...(activeThread?.messages ?? [])]
    .filter((message, index, combined) => combined.findIndex((other) => other.id === message.id) === index);

  useEffect(() => {
    setDraft({ conversationId: selectedId, body: '' });
    setSendError('');
    setHistory(null);
    setHistoryError('');
  }, [selectedId]);

  useEffect(() => {
    if (activeThread && scrollArea.current) scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [activeThread]);

  function select(conversationId: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (conversationId) next.set('conversation', conversationId);
      else next.delete('conversation');
      return next;
    });
  }

  async function loadOlder() {
    if (!activeThread || !nextBefore || historyPending) return;
    const requestedId = selectedId;
    setHistoryPending(true);
    setHistoryError('');
    try {
      const result = await api<Thread>(`/communication/conversations/${encodeURIComponent(requestedId)}?before=${encodeURIComponent(nextBefore)}`);
      if (selectedRef.current !== requestedId) return;
      setHistory((previous) => ({
        conversationId: requestedId,
        messages: [...result.messages, ...(previous?.conversationId === requestedId ? previous.messages : [])],
        next: result.next_before,
      }));
    } catch (error) {
      if (selectedRef.current === requestedId) setHistoryError(errorMessage(error));
    } finally {
      setHistoryPending(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThread || thread.loading || thread.error || sending || !body.trim()) return;
    const requestedId = activeThread.conversation.id;
    setSending(true);
    setSendError('');
    try {
      await api(`/communication/conversations/${encodeURIComponent(requestedId)}/messages`, {
        method: 'POST', body: JSON.stringify({ body }),
      });
      setDraft((previous) => previous.conversationId === requestedId ? { ...previous, body: '' } : previous);
      if (selectedRef.current === requestedId) {
        setHistory(null);
        thread.reload();
      }
      conversations.reload();
    } catch (error) {
      if (selectedRef.current === requestedId) setSendError(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  return <>
    <PageHeader eyebrow="Votre espace de collaboration" title="Messages" description="Les bonnes idées commencent par une conversation."
      action={<button type="button" className="button button-primary" onClick={() => setCreating(true)}><Plus size={18} /> Nouveau message</button>} />
    <section className={`card communication-inbox ${selectedId ? 'has-selection' : ''}`} aria-label="Messagerie privée">
      <aside className="communication-sidebar" aria-label="Conversations">
        <div className="communication-search">
          <div className="row-between" style={{ marginBottom: 16 }}><strong>Boîte de réception</strong><button type="button" className="icon-button" aria-label="Actualiser les conversations" disabled={conversations.loading} onClick={conversations.reload}><RefreshCw size={16} /></button></div>
          <div className="field"><label htmlFor="conversation-search" className="small muted">Rechercher une conversation</label><div className="search-input"><Search size={16} aria-hidden="true" /><input id="conversation-search" type="search" value={query} maxLength={120} placeholder="Un nom, un objet…" onChange={(event) => { setQuery(event.target.value); setOffset(0); }} /></div></div>
        </div>
        {conversations.loading && <Loading />}
        {conversations.error && <div className="communication-status"><ErrorState message={conversations.error} /><button type="button" className="button button-secondary button-small" onClick={conversations.reload}>Réessayer</button></div>}
        {!conversations.loading && !conversations.error && conversations.data && <>
          {conversations.data.conversations.length ? <ul className="communication-list">
            {conversations.data.conversations.map((conversation) => {
              const peers = conversation.participants.filter((person) => person.id !== userId);
              return <li key={conversation.id}><button type="button" className="communication-item" aria-current={selectedId === conversation.id ? 'true' : undefined} disabled={sending} onClick={() => select(conversation.id)}>
                <Avatar name={peers[0]?.name || 'Conversation'} color={peers[0]?.avatar_color} />
                <span className="communication-item-main">
                  <span className="row-between" style={{ gap: 8 }}><strong className="communication-truncate">{peers.map((peer) => peer.name).join(', ') || 'Conversation privée'}</strong></span>
                  <span className="communication-truncate communication-item-subject">{conversation.subject}</span>
                  <span className="small muted communication-truncate">{conversation.last_sender_id === userId ? 'Vous : ' : ''}{conversation.last_message_body || 'Aucun message'}</span>
                  <time className="small muted" style={{ display: 'block', marginTop: 10 }} dateTime={conversation.last_message_at || conversation.created_at}>{timestamp(conversation.last_message_at || conversation.created_at)}</time>
                </span>
              </button></li>;
            })}
          </ul> : <EmptyState title={query ? 'Aucune conversation trouvée' : 'Tout commence par un bonjour'} description={query ? 'Essayez un autre nom ou objet.' : 'Contactez un membre pour échanger sur vos idées.'} action={!query ? <button type="button" className="button button-secondary" onClick={() => setCreating(true)}>Écrire un message</button> : undefined} />}
          <Pagination offset={offset} hasMore={conversations.data.has_more} pending={conversations.loading} onChange={setOffset} />
        </>}
        <div className="communication-private" style={{ padding: '16px 20px' }}><LockKeyhole size={13} /> Vos échanges restent entre participants.</div>
      </aside>
      <section className="communication-pane" aria-label="Conversation sélectionnée">
        {selectedId && <div style={{ padding: '16px 16px 0' }}><button type="button" className="button button-ghost button-small communication-back" onClick={() => select('')}><ArrowLeft size={16} /> Toutes les conversations</button></div>}
        {!selectedId && <div style={{ margin: 'auto', padding: 28, textAlign: 'center' }}><Mail size={42} strokeWidth={1.3} color="#7563ed" /><EmptyState title="Faites avancer vos idées" description="Choisissez une conversation ou écrivez à un membre du collectif." action={<button type="button" className="button button-secondary" onClick={() => setCreating(true)}><Plus size={16} /> Nouvelle conversation</button>} /></div>}
        {selectedId && thread.loading && <Loading />}
        {selectedId && thread.error && <div className="communication-status"><ErrorState message={thread.error} /><button type="button" className="button button-secondary" onClick={thread.reload}>Réessayer</button></div>}
        {activeThread && !thread.loading && !thread.error && <>
          <header className="communication-thread-heading">
            <div className="row-between" style={{ alignItems: 'flex-start', gap: 12 }}>
              <h2>{activeThread.conversation.subject}</h2>
              <button type="button" className="icon-button" aria-label="Actualiser les messages" disabled={sending || historyPending} onClick={() => { setHistory(null); thread.reload(); }}><RefreshCw size={16} /></button>
            </div>
            <div className="communication-participants">{activeThread.conversation.participants.filter((person) => person.id !== userId).map((person) => <Link className="communication-profile" to={`/people/${person.id}`} key={person.id}><Avatar name={person.name} color={person.avatar_color} size="small" /> {person.name} <ArrowUpRight size={13} /></Link>)}</div>
          </header>
          <div className="communication-history" ref={scrollArea}>
            {nextBefore && <div style={{ textAlign: 'center', marginBottom: 20 }}><button type="button" className="button button-ghost button-small" disabled={historyPending} onClick={() => void loadOlder()}>{historyPending ? 'Chargement…' : 'Afficher les messages précédents'}</button></div>}
            <ErrorState message={historyError} />
            {messages.length ? <ol className="communication-messages" aria-label="Messages">
              {messages.map((message) => {
                const sender = activeThread.conversation.participants.find((person) => person.id === message.sender_id);
                const own = message.sender_id === userId;
                return <li className={`communication-message ${own ? 'own' : ''}`} key={message.id}>
                  <div className="communication-message-meta"><strong>{own ? 'Vous' : sender?.name || 'Membre'}</strong><time dateTime={message.created_at}>{timestamp(message.created_at)}</time></div>
                  <div className="communication-text">{message.body}</div>
                </li>;
              })}
            </ol> : <EmptyState title="Commencez la conversation" description="Envoyez votre premier message ci-dessous." />}
          </div>
          <form className="communication-compose" onSubmit={send}>
            <div className="field"><label htmlFor="message-reply">Votre réponse</label><textarea id="message-reply" placeholder="Écrivez votre message…" maxLength={10_000} rows={3} value={body} disabled={sending} onChange={(event) => setDraft({ conversationId: selectedId, body: event.target.value })} required /></div>
            <ErrorState message={sendError} />
            <div className="communication-compose-footer"><span className="help-text">{body.length.toLocaleString('fr-FR')} / 10 000 caractères · Texte uniquement</span><button type="submit" className="button button-primary" disabled={sending || thread.loading || !body.trim()}><Send size={16} /> {sending ? 'Envoi…' : 'Envoyer'}</button></div>
          </form>
        </>}
      </section>
    </section>
    {creating && <NewConversation onClose={() => setCreating(false)} onCreated={(conversationId) => {
      setCreating(false);
      setQuery('');
      setOffset(0);
      select(conversationId);
      conversations.reload();
    }} />}
  </>;
}

export default function MessagesPage() {
  const { user, loading, error } = useAuth();
  return <><style>{styles}</style>{loading ? <Loading /> : error ? <ErrorState message={error} /> : user ? <Inbox key={user.id} userId={user.id} /> : <><PageHeader title="Messages" description="Échangez en privé avec les membres du collectif." /><LoginNotice /></>}</>;
}

function NotificationInbox() {
  const [offset, setOffset] = useState(0);
  const notifications = useApi<{ notifications: Notification[]; unread_count: number; has_more: boolean }>(
    `/communication/notifications?limit=30&offset=${offset}`,
  );
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function markRead(notificationId?: string) {
    if (pending) return;
    setPending(notificationId || 'all');
    setError('');
    setSuccess('');
    try {
      await api(notificationId ? `/communication/notifications/${encodeURIComponent(notificationId)}/read` : '/communication/notifications/read-all', { method: 'POST' });
      setSuccess(notificationId ? 'Notification marquée comme lue.' : 'Toutes vos notifications sont marquées comme lues.');
      notifications.reload();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending('');
    }
  }

  return <>
    <PageHeader eyebrow="Gardez le fil" title="Notifications" description="Les nouvelles de vos projets, collaborations et conversations, réunies ici."
      action={<button type="button" className="button button-secondary" disabled={!!pending || notifications.loading || !notifications.data?.unread_count} onClick={() => void markRead()}><CheckCheck size={17} /> {pending === 'all' ? 'Mise à jour…' : 'Tout marquer comme lu'}</button>} />
    <div className="row-between" style={{ marginBottom: 20 }}>
      <div className="row gap-sm"><h2 className="section-heading" style={{ margin: 0 }}>Votre activité</h2>{notifications.data && !notifications.loading && <Badge tone={notifications.data.unread_count ? 'purple' : 'neutral'}>{notifications.data.unread_count} non lue{notifications.data.unread_count > 1 ? 's' : ''}</Badge>}</div>
      <button type="button" className="button button-ghost button-small" disabled={notifications.loading || !!pending} onClick={notifications.reload}><RefreshCw size={15} /> Actualiser</button>
    </div>
    <ErrorState message={error} />
    {success && <p className="alert alert-success" role="status">{success}</p>}
    {notifications.loading && <Loading />}
    {notifications.error && <div><ErrorState message={notifications.error} /><button type="button" className="button button-secondary" onClick={notifications.reload}>Réessayer</button></div>}
    {!notifications.loading && !notifications.error && notifications.data && <>
      {notifications.data.notifications.length ? <section className="card" style={{ overflow: 'hidden' }} aria-label="Notifications">
        {notifications.data.notifications.map((notification) => <article className={`communication-notification ${notification.read_at ? '' : 'unread'}`} key={notification.id}>
          <div className="communication-notification-icon">{notification.kind === 'message' ? <Mail size={21} /> : <Bell size={21} />}</div>
          <div className="communication-notification-main">
            <div className="row-between" style={{ alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}><h2>{notification.title}</h2>{!notification.read_at && <Badge tone="purple">Non lue</Badge>}</div>
            {notification.body && <p className="communication-notification-body">{notification.body}</p>}
            <time className="small muted" dateTime={notification.created_at}>{timestamp(notification.created_at)}</time>
            <div className="communication-notification-actions">
              <Link className="button button-secondary button-small" to={internalLink(notification.link)}>Voir {notification.kind === 'message' ? 'la conversation' : 'le détail'} <ArrowUpRight size={14} /></Link>
              {!notification.read_at ? <button type="button" className="button button-ghost button-small" disabled={!!pending} onClick={() => void markRead(notification.id)}><Check size={15} /> {pending === notification.id ? 'Mise à jour…' : 'Marquer comme lu'}</button> : <span className="small muted row gap-sm"><CheckCheck size={14} /> Lue</span>}
            </div>
          </div>
        </article>)}
      </section> : <div className="card"><EmptyState title="Vous êtes à jour" description="Vos prochaines notifications apparaîtront ici. En attendant, poursuivez vos échanges." action={<Link className="button button-primary" to="/messages">Ouvrir la messagerie <ArrowUpRight size={16} /></Link>} /></div>}
      <Pagination offset={offset} hasMore={notifications.data.has_more} pending={!!pending} onChange={setOffset} />
    </>}
    <p className="help-text" style={{ marginTop: 20 }}>Ces notifications sont consultables dans Alpha. Actualisez la page pour retrouver les dernières nouvelles.</p>
  </>;
}

export function NotificationsPage() {
  const { user, loading, error } = useAuth();
  return <><style>{styles}</style>{loading ? <Loading /> : error ? <ErrorState message={error} /> : user ? <NotificationInbox key={user.id} /> : <><PageHeader title="Notifications" description="Retrouvez votre activité sur Alpha." /><LoginNotice /></>}</>;
}
