import type { WhatsAppGraphClient } from './graph.js';
import type { MessagingStore } from './store.js';

export type SendTextResult =
  | { ok: true; messageId: string; waMessageId: string }
  | { ok: false; error: string; retryable: boolean; messageId?: string };

/**
 * Sends a text reply in a conversation. The database reserves the message
 * first (tenant, 24-hour window and monthly limit checks), then the Graph
 * API is called, then the result is recorded. A message is never reported
 * as sent without a WhatsApp message id from Meta.
 */
export async function sendTextMessage(
  deps: { store: MessagingStore; graph: WhatsAppGraphClient },
  input: { businessId: string; conversationId: string; body: string; sender: 'ai' | 'agent' | 'system' },
): Promise<SendTextResult> {
  const body = input.body.trim().slice(0, 4096);
  if (!body) return { ok: false, error: 'empty_body', retryable: false };

  const reserved = await deps.store.beginOutbound({ ...input, body });
  if (!reserved.ok) return { ok: false, error: reserved.error, retryable: false };

  const sent = await deps.graph.sendText({ phoneNumberId: reserved.phone_number_id, to: reserved.to, body });
  if (sent.ok) {
    await deps.store.completeOutbound({ businessId: input.businessId, messageId: reserved.message_id, waMessageId: sent.waMessageId });
    return { ok: true, messageId: reserved.message_id, waMessageId: sent.waMessageId };
  }
  await deps.store.completeOutbound({
    businessId: input.businessId,
    messageId: reserved.message_id,
    errorCode: sent.code,
    errorMessage: sent.message,
  });
  return { ok: false, error: sent.code, retryable: sent.retryable, messageId: reserved.message_id };
}
