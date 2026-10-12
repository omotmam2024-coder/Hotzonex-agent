import { waitUntil } from '@vercel/functions';
import { OpenAIResponsesModel } from './ai/model.js';
import { AiResponder } from './ai/responder.js';
import { AiStore } from './ai/store.js';
import type { JobDeps } from './jobs/process-events.js';
import { ConfigError, loadServerConfig } from './config/env.js';
import { sendTextMessage } from './whatsapp/sender.js';
import { supabaseRpc } from './db/rpc.js';
import { createServiceClient } from './db/supabase.js';
import { WhatsAppGraphClient } from './whatsapp/graph.js';
import type { InboundResponder } from './whatsapp/processor.js';
import { MessagingStore } from './whatsapp/store.js';
import type { WebhookDeps } from './whatsapp/webhook.js';

let store: MessagingStore | undefined;
let aiStore: AiStore | undefined;

function messagingStore(): MessagingStore {
  store ??= new MessagingStore(supabaseRpc(createServiceClient(loadServerConfig(['supabase']))));
  return store;
}

export function graphClient(): WhatsAppGraphClient {
  const config = loadServerConfig(['whatsapp']);
  return new WhatsAppGraphClient({ accessToken: config.WHATSAPP_ACCESS_TOKEN, apiVersion: config.WHATSAPP_API_VERSION });
}

/**
 * The AI agent, when OpenAI is configured. Without it inbound messages are
 * still recorded and a person can reply from the dashboard.
 */
function responder(): InboundResponder | undefined {
  let config;
  try {
    config = loadServerConfig(['supabase', 'openai', 'whatsapp']);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.warn('[ai] responder disabled: OpenAI/WhatsApp configuration incomplete');
      return undefined;
    }
    throw err;
  }
  aiStore ??= new AiStore(supabaseRpc(createServiceClient(config)));
  const graph = graphClient();
  const messages = messagingStore();
  return new AiResponder({
    model: new OpenAIResponsesModel(config.OPENAI_API_KEY),
    modelName: config.OPENAI_MODEL,
    store: aiStore,
    send: (input) => sendTextMessage({ store: messages, graph }, input),
  });
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
