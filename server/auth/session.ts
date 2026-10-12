import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseConfig } from '../config/env.js';
import { createUserClient } from '../db/supabase.js';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface Session {
  user: AuthUser;
  /** Supabase client scoped to this user (RLS enforced). */
  db: SupabaseClient;
}

export type Authenticator = (request: Request) => Promise<Session | null>;

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/;

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header ? (BEARER.exec(header.trim())?.[1] ?? null) : null;
}

/**
 * Verifies the access token with Supabase Auth (getUser asks the Auth
 * server, so revoked or expired sessions are rejected).
 */
export function supabaseAuthenticator(config: SupabaseConfig): Authenticator {
  return async (request) => {
    const token = bearerToken(request);
    if (!token) return null;
    const db = createUserClient(config, token);
    const { data, error } = await db.auth.getUser(token);
    if (error || !data.user) return null;
    return { user: { id: data.user.id, email: data.user.email ?? null }, db };
  };
}
