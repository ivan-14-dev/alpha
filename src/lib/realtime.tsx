import { createContext, useContext, type ReactNode } from 'react';

/**
 * Realtime client (SSE). OWNER: realtime module.
 * Contract used by App.tsx and pages:
 *  - <RealtimeProvider> wraps the app (inside AuthProvider).
 *  - useRealtimeEvent(type, handler) subscribes to server events (e.g. 'notification.created', 'message.created').
 *  - useUnreadNotifications() returns the live unread count or null when unknown.
 */
type Handler = (data: unknown) => void;
interface RealtimeState { subscribe: (type: string, handler: Handler) => () => void; unread: number | null; connected: boolean }
const Context = createContext<RealtimeState>({ subscribe: () => () => undefined, unread: null, connected: false });

export function RealtimeProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={{ subscribe: () => () => undefined, unread: null, connected: false }}>{children}</Context.Provider>;
}

export function useRealtime() { return useContext(Context); }
export function useRealtimeEvent(_type: string, _handler: Handler) { /* implemented by the realtime module */ }
export function useUnreadNotifications(): number | null { return useContext(Context).unread; }
