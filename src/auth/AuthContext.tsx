import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Loading } from '../components/States';

export interface AuthSession {
  accessToken: string;
  email: string | null;
}

/** The parts of Supabase Auth the dashboard uses; injectable for tests. */
export interface AuthClient {
  getSession(): Promise<AuthSession | null>;
  onChange(cb: (session: AuthSession | null) => void): () => void;
  signInWithPassword(email: string, password: string): Promise<{ error: string | null }>;
  sendMagicLink(email: string, redirectTo: string): Promise<{ error: string | null }>;
  signOut(): Promise<void>;
}

interface AuthState {
  client: AuthClient;
  session: AuthSession | null;
  loading: boolean;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    client
      .getSession()
      .then((s) => active && setSession(s))
      .catch(() => active && setSession(null))
      .finally(() => active && setLoading(false));
    const unsubscribe = client.onChange((s) => {
      setSession(s);
      setLoading(false);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [client]);

  const value = useMemo(() => ({ client, session, loading }), [client, session, loading]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="Checking your session…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}
