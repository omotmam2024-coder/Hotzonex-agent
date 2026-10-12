import { supabaseAuthenticator } from './auth/session.js';
import type { ApiDeps } from './auth/context.js';
import { ConfigError, loadServerConfig } from './config/env.js';
import type { DashboardDeps } from './dashboard/handlers.js';
import { DashboardStore } from './dashboard/store.js';
import { SupabaseDataStore } from './data/supabase-store.js';
import { supabaseRpc } from './db/rpc.js';
import { createServiceClient } from './db/supabase.js';
import { WhatsAppGraphClient } from './whatsapp/graph.js';
import { sendTextMessage } from './whatsapp/sender.js';
import { MessagingStore } from './whatsapp/store.js';

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

let dashboard: DashboardDeps | undefined;

/** Wiring for the conversations, customers, orders and overview APIs. */
export function dashboardApiDeps(): DashboardDeps {
  if (!dashboard) {
    const config = loadServerConfig(['supabase']);
    let sendAgentReply: DashboardDeps['sendAgentReply'];
    try {
      const wa = loadServerConfig(['supabase', 'whatsapp']);
      const store = new MessagingStore(supabaseRpc(createServiceClient(wa)));
      const graph = new WhatsAppGraphClient({ accessToken: wa.WHATSAPP_ACCESS_TOKEN, apiVersion: wa.WHATSAPP_API_VERSION });
      sendAgentReply = (input) => sendTextMessage({ store, graph }, { ...input, sender: 'agent' });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
    }
    dashboard = {
      authenticate: supabaseAuthenticator(config),
      storeFor: (session) => new DashboardStore(supabaseRpc(session.db)),
      sendAgentReply,
    };
  }
  return dashboard;
}
