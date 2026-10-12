import { supabaseAuthenticator } from './auth/session.js';
import type { ApiDeps } from './auth/context.js';
import { loadServerConfig } from './config/env.js';
import { SupabaseDataStore } from './data/supabase-store.js';

let cached: ApiDeps | undefined;

/**
 * Production wiring for dashboard APIs. Config is validated on first use
 * (per cold start); a ConfigError becomes a 503 via withErrorHandling.
 */
export function dashboardDeps(): ApiDeps {
  if (!cached) {
    const config = loadServerConfig(['supabase']);
    cached = {
      authenticate: supabaseAuthenticator(config),
      storeFor: (session) => new SupabaseDataStore(session.db),
    };
  }
  return cached;
}
