import { waitUntil } from '@vercel/functions';
import type { JobDeps } from './jobs/process-events.js';
import { loadServerConfig } from './config/env.js';
import { supabaseRpc } from './db/rpc.js';
import { createServiceClient } from './db/supabase.js';
import { WhatsAppGraphClient } from './whatsapp/graph.js';
import type { InboundResponder } from './whatsapp/processor.js';
import { MessagingStore } from './whatsapp/store.js';
import type { WebhookDeps } from './whatsapp/webhook.js';

let store: MessagingStore | undefined;

function messagingStore(): MessagingStore {
  store ??= new MessagingStore(supabaseRpc(createServiceClient(loadServerConfig(['supabase']))));
  return store;
}

export function graphClient(): WhatsAppGraphClient {
  const config = loadServerConfig(['whatsapp']);
  return new WhatsAppGraphClient({ accessToken: config.WHATSAPP_ACCESS_TOKEN, apiVersion: config.WHATSAPP_API_VERSION });
}

/** Phase 4 plugs the AI agent in here. Until then inbound messages are only recorded. */
function responder(): InboundResponder | undefined {
  return undefined;
}

export function webhookDeps(): WebhookDeps {
  const config = loadServerConfig(['supabase', 'whatsapp']);
  return {
    verifyToken: config.WHATSAPP_VERIFY_TOKEN,
    appSecret: config.WHATSAPP_APP_SECRET,
    store: messagingStore(),
    responder: responder(),
    defer: (work) => waitUntil(work),
  };
}

export function jobDeps(): JobDeps {
  const config = loadServerConfig(['supabase', 'jobs']);
  return { cronSecret: config.CRON_SECRET, store: messagingStore(), responder: responder() };
}
