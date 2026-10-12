import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseConfig } from '../config/env.js';

const SERVER_AUTH = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/**
 * Client that acts as the signed-in user: every query is subject to RLS.
 * Use for all dashboard requests.
 */
export function createUserClient(config: SupabaseConfig, accessToken: string): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: SERVER_AUTH,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Client with the secret key: bypasses RLS. Only for trusted server flows
 * (webhooks, AI tools, operator scripts) that resolve the tenant themselves
 * and always filter by it.
 */
export function createServiceClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, { auth: SERVER_AUTH });
}
