import { createClient } from '@supabase/supabase-js';
import type { AuthClient, AuthSession } from '../auth/AuthContext';
import type { ClientEnv } from './env';

/** Browser Supabase client (publishable key only) adapted to AuthClient. */
export function createSupabaseAuthClient(env: ClientEnv): AuthClient {
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  });
  const toSession = (s: { access_token: string; user: { email?: string } } | null): AuthSession | null =>
    s ? { accessToken: s.access_token, email: s.user.email ?? null } : null;

  return {
    async getSession() {
      const { data } = await supabase.auth.getSession();
      return toSession(data.session);
    },
    onChange(cb) {
      const { data } = supabase.auth.onAuthStateChange((_event, s) => cb(toSession(s)));
      return () => data.subscription.unsubscribe();
    },
    async signInWithPassword(email, password) {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error ? 'Email or password is incorrect.' : null };
    },
    async sendMagicLink(email, redirectTo) {
      // shouldCreateUser: false — only invited owners can sign in.
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
      });
      return { error: error ? 'Could not send a sign-in link. Check the address or try again later.' : null };
    },
    async signOut() {
      await supabase.auth.signOut();
    },
  };
}
