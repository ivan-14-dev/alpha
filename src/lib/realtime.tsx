import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Bell, X } from 'lucide-react';
import { api } from './api';
import { useAuth } from './auth';
import '../styles/realtime.css';

/**
 * Realtime client (Server-Sent Events). OWNER: realtime module.
 * Contract used by App.tsx and pages:
 *  - <RealtimeProvider> wraps the app (inside AuthProvider).
 *  - useRealtimeEvent(type, handler) subscribes to server events (e.g. 'notification.created', 'message.created').
 *  - useUnreadNotifications() returns the live unread count or null when unknown.
 * One EventSource per tab, opened only while signed in, closed on logout and after a long time in the background.
 */
type Handler = (data: unknown) => void;
export interface RealtimeState {
  subscribe: (type: string, handler: Handler) => () => void;
  unread: number | null;
  connected: boolean;
  /** Re-reads the unread counter from the API (e.g. after a bulk action). */
  refreshUnread?: () => void;
}

export interface LiveNotification { id: string; kind: string; category: string; title: string; body: string; link: string; unread: number; created_at: string }
export interface LiveMessage { id: string; conversation_id: string; sender_id: string; body: string; created_at: string }
export interface MessageCreatedEvent {
  conversation_id: string;
  message: LiveMessage;
  sender: { id: string; name: string; avatar_color: string };
  conversation?: { id: string; subject: string; created_by: string; created_at: string; participants: { id: string; name: string; title: string; avatar_color: string }[] };
}
export interface ConversationReadEvent { conversation_id: string; user_id: string; read_at: string }
export interface TypingEvent { conversation_id: string; user_id: string; name: string }

const Context = createContext<RealtimeState>({ subscribe: () => () => undefined, unread: null, connected: false });

const BUILTIN_TYPES = ['ready', 'notification.created', 'notification.read', 'session.expired'];
const HIDDEN_CLOSE_MS = 2 * 60000;
const MAX_BACKOFF_MS = 60000;
const POLL_MS = 60000;

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { user, refresh } = useAuth();
  const userId = user?.id ?? null;
  const listeners = useRef(new Map<string, Set<Handler>>());
  const source = useRef<EventSource | null>(null);
  const attached = useRef(new Set<string>());
  const refreshAuth = useRef(refresh);
  refreshAuth.current = refresh;
  const [unread, setUnread] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);

  const dispatch = useCallback((type: string, raw: string) => {
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return; }
    for (const handler of [...(listeners.current.get(type) ?? [])]) {
      try { handler(data); } catch (error) { console.error(`Realtime handler for ${type} failed`, error); }
    }
  }, []);

  const attach = useCallback((target: EventSource, type: string) => {
    if (attached.current.has(type)) return;
    attached.current.add(type);
    target.addEventListener(type, (event) => dispatch(type, (event as MessageEvent<string>).data));
  }, [dispatch]);

  const subscribe = useCallback((type: string, handler: Handler) => {
    let set = listeners.current.get(type);
    if (!set) { set = new Set(); listeners.current.set(type, set); }
    set.add(handler);
    if (source.current) attach(source.current, type);
    return () => { set.delete(handler); };
  }, [attach]);

  const refreshUnread = useCallback(() => {
    if (!userId) return;
    api<{ unread: number }>('/realtime/unread').then((value) => setUnread(value.unread)).catch(() => undefined);
  }, [userId]);

  useEffect(() => {
    setUnread(null);
    setConnected(false);
    if (!userId) return;
    let disposed = false;
    let fromEvent = false;
    let attempt = 0;
    let retryTimer: number | undefined;
    let hiddenTimer: number | undefined;
    let pollTimer: number | undefined;
    const supported = typeof window !== 'undefined' && 'EventSource' in window;

    const own: [string, Handler][] = [
      ['ready', (data) => { attempt = 0; fromEvent = true; setConnected(true); setUnread(Number((data as { unread: number }).unread) || 0); }],
      ['notification.created', (data) => { fromEvent = true; setUnread(Number((data as LiveNotification).unread) || 0); }],
      ['notification.read', (data) => { fromEvent = true; setUnread(Number((data as { unread: number }).unread) || 0); }],
      ['session.expired', () => {
        close();
        // The session was revoked or expired: let the auth context update (logout) or reconnect if still valid.
        void refreshAuth.current().catch(() => undefined).finally(() => schedule());
      }],
    ];
    const unsubscribers = own.map(([type, handler]) => subscribe(type, handler));

    function close() {
      source.current?.close();
      source.current = null;
      attached.current = new Set();
      setConnected(false);
    }

    function schedule() {
      if (disposed || source.current || document.visibilityState === 'hidden') return;
      window.clearTimeout(retryTimer);
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
      attempt = Math.min(attempt + 1, 10);
      retryTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      if (disposed || source.current || !supported) return;
      const stream = new EventSource('/api/realtime/stream', { withCredentials: true });
      source.current = stream;
      attached.current = new Set();
      for (const type of new Set([...BUILTIN_TYPES, ...listeners.current.keys()])) attach(stream, type);
      stream.onerror = () => {
        setConnected(false);
        // CONNECTING = the browser retries by itself (server `retry:`); CLOSED = refused (401/429...) → our backoff.
        if (stream.readyState === EventSource.CLOSED && source.current === stream) {
          close();
          if (attempt >= 2) void refreshAuth.current().catch(() => undefined);
          schedule();
        }
      };
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') {
        window.clearTimeout(hiddenTimer);
        hiddenTimer = window.setTimeout(() => { if (document.visibilityState === 'hidden') close(); }, HIDDEN_CLOSE_MS);
        return;
      }
      window.clearTimeout(hiddenTimer);
      if (!source.current) {
        attempt = 0;
        connect();
        api<{ unread: number }>('/realtime/unread').then((value) => setUnread(value.unread)).catch(() => undefined);
      }
    }

    api<{ unread: number }>('/realtime/unread')
      .then((value) => { if (!disposed && !fromEvent) setUnread(value.unread); })
      .catch(() => undefined);
    if (supported) {
      connect();
      document.addEventListener('visibilitychange', onVisibility);
    } else {
      pollTimer = window.setInterval(() => {
        api<{ unread: number }>('/realtime/unread').then((value) => setUnread(value.unread)).catch(() => undefined);
      }, POLL_MS);
    }

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(hiddenTimer);
      window.clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const unsubscribe of unsubscribers) unsubscribe();
      close();
    };
  }, [userId, subscribe, attach]);

  const value = useMemo<RealtimeState>(() => ({ subscribe, unread: userId ? unread : null, connected, refreshUnread }),
    [subscribe, unread, connected, refreshUnread, userId]);
  return <Context.Provider value={value}>{children}{userId && <RealtimeToasts />}</Context.Provider>;
}

const TOAST_MS = 7000;
const internalPath = (value: string) => /^\/(?!\/)/.test(value) && !/[\\\u0000-\u0020\u007f]/.test(value) ? value : '/notifications';

/** Discreet in-app toasts for new notifications (skipped when the user is already looking at the relevant page). */
function RealtimeToasts() {
  const location = useLocation();
  const here = useRef('');
  here.current = `${location.pathname}${location.search}`;
  const [toasts, setToasts] = useState<LiveNotification[]>([]);
  const timers = useRef(new Map<string, number>());

  const dismiss = useCallback((id: string) => {
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  useRealtimeEvent<LiveNotification>('notification.created', (notification) => {
    const link = internalPath(notification.link);
    // Already visible: the notifications page inserts it live, the inbox updates its list and thread live.
    if (here.current.startsWith('/notifications') || here.current === link
      || (here.current.startsWith('/messages') && link.startsWith('/messages'))) return;
    setToasts((current) => [{ ...notification, link }, ...current.filter((toast) => toast.id !== notification.id)].slice(0, 3));
    timers.current.set(notification.id, window.setTimeout(() => dismiss(notification.id), TOAST_MS));
  });

  useEffect(() => () => { for (const timer of timers.current.values()) window.clearTimeout(timer); }, []);

  return <div className="realtime-toasts" role="status" aria-live="polite" aria-relevant="additions">
    {toasts.map((toast) => <div className="realtime-toast" key={toast.id}>
      <span className="realtime-toast-icon" aria-hidden="true"><Bell size={16} /></span>
      <Link className="realtime-toast-main" to={toast.link} onClick={() => dismiss(toast.id)}>
        <strong>{toast.title}</strong>
        {toast.body && <span>{toast.body.length > 120 ? `${toast.body.slice(0, 119)}…` : toast.body}</span>}
      </Link>
      <button type="button" className="icon-button" aria-label="Fermer la notification" onClick={() => dismiss(toast.id)}><X size={14} /></button>
    </div>)}
  </div>;
}

export function useRealtime() { return useContext(Context); }

/** Subscribes for the lifetime of the component; the latest handler is always called (no resubscription per render). */
export function useRealtimeEvent<T = unknown>(type: string, handler: (data: T) => void) {
  const { subscribe } = useContext(Context);
  const latest = useRef(handler);
  useLayoutEffect(() => { latest.current = handler; });
  useEffect(() => subscribe(type, (data) => latest.current(data as T)), [subscribe, type]);
}

export function useUnreadNotifications(): number | null { return useContext(Context).unread; }
