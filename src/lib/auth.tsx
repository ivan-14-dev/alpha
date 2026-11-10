import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, errorMessage } from './api';

export type LegalDocumentKey = 'terms' | 'privacy' | 'payments' | 'tester_charter' | 'seller_terms';

export interface User {
  id: string; name: string; email: string; title: string; bio: string;
  skills: string; avatar_color: string; role: 'member' | 'admin'; created_at: string;
  /** Account security flags returned by /api/auth/me (V4). Optional so older fixtures keep compiling. */
  email_verified?: boolean;
  mfa_enabled?: boolean;
  has_password?: boolean;
  pending_legal?: LegalDocumentKey[];
  /** True when the admin MFA policy suspends this administrator's rights until MFA is enabled. */
  admin_mfa_required?: boolean;
}
interface AuthState {
  user: User | null; loading: boolean; error: string;
  refresh: () => Promise<void>; logout: () => Promise<void>;
}
const Context = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  async function refresh() {
    try { setUser((await api<{ user: User | null }>('/auth/me')).user); setError(''); }
    catch (error) { setError(errorMessage(error)); throw error; }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  async function logout() { await api('/auth/logout', { method: 'POST' }); setUser(null); }
  return <Context.Provider value={{ user, loading, error, refresh, logout }}>{children}</Context.Provider>;
}

export function useAuth() {
  const context = useContext(Context);
  if (!context) throw new Error('AuthProvider manquant');
  return context;
}
