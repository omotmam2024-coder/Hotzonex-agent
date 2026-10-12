import { webhookDeps } from '../../server/messaging-deps.js';
import { createWhatsAppWebhookHandler } from '../../server/whatsapp/webhook.js';

const handle = createWhatsAppWebhookHandler(webhookDeps);

export const GET = handle;
export const POST = handle;
