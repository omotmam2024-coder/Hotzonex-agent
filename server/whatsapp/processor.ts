import { messageText, type MessageEventPayload, type StatusEventPayload } from './payload.js';
import type { ClaimedEvent, MessagingStore } from './store.js';

export interface InboundContext {
  businessId: string;
  conversationId: string;
  customerId: string;
  messageId: string;
  waMessageId: string;
  text: string;
  isText: boolean;
}

/**
 * Reacts to a new inbound message in an open, AI-enabled conversation
 * (Phase 4: the AI agent). Must handle its own failures; errors thrown
 * here are logged and do not cause the webhook event to be retried, so a
 * customer never gets duplicate replies.
 */
export interface InboundResponder {
  onInboundMessage(ctx: InboundContext): Promise<void>;
}

export interface ProcessDeps {
  store: MessagingStore;
  responder?: InboundResponder | undefined;
}

export interface ProcessSummary {
  claimed: number;
  processed: number;
  failed: number;
}

/** Failure that should be retried with back-off. */
class RetryLater extends Error {}

/** Failure that will not succeed on retry. */
export class PermanentError extends Error {}

/** Statuses for messages we never sent (e.g. test sends from Meta's UI) stop retrying after this. */
const STATUS_NOT_FOUND_ATTEMPTS = 3;

export async function processWebhookEvents(
  deps: ProcessDeps,
  opts: { ids?: string[] | null; limit?: number } = {},
): Promise<ProcessSummary> {
  const events = await deps.store.claimEvents(opts.ids ?? null, opts.limit ?? 20);
  const summary: ProcessSummary = { claimed: events.length, processed: 0, failed: 0 };

  for (const event of events) {
    try {
      await processOne(deps, event);
      await deps.store.finishEvent(event.id, { ok: true });
      summary.processed++;
    } catch (err) {
      summary.failed++;
      const retryable = !(err instanceof PermanentError);
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('[webhook] event failed', { id: event.id, type: event.event_type, attempt: event.attempts, retryable, message });
      await deps.store.finishEvent(event.id, { ok: false, error: message, retryable }).catch((e: unknown) => {
        console.error('[webhook] could not record failure', { id: event.id, error: e instanceof Error ? e.message : e });
      });
    }
  }
  return summary;
}

async function processOne(deps: ProcessDeps, event: ClaimedEvent): Promise<void> {
  switch (event.event_type) {
    case 'message':
      return processMessage(deps, event.business_id, event.payload as MessageEventPayload);
    case 'status':
      return processStatus(deps, event, event.payload as StatusEventPayload);
    default:
      throw new PermanentError(`Unsupported event type ${event.event_type}`);
  }
}

async function processMessage(deps: ProcessDeps, businessId: string, payload: MessageEventPayload): Promise<void> {
  const { message, contact_name } = payload;
  const { text, isText } = messageText(message);
  const result = await deps.store.recordInboundMessage({
    businessId,
    waId: message.from,
    profileName: contact_name,
    waMessageId: message.id,
    body: text,
  });
  if (result.duplicate) return;
  if (!deps.responder) return;
  // A person is handling the conversation, or the owner turned the AI off.
  if (result.conversation_status !== 'open' || !result.ai_enabled || result.business_status !== 'active') return;

  try {
    await deps.responder.onInboundMessage({
      businessId,
      conversationId: result.conversation_id,
      customerId: result.customer_id,
      messageId: result.message_id,
      waMessageId: message.id,
      text,
      isText,
    });
  } catch (err) {
    console.error('[webhook] responder failed', { businessId, messageId: result.message_id, error: err instanceof Error ? err.message : err });
    await deps.store
      .log(businessId, 'error', 'responder.failed', { message_id: result.message_id, error: err instanceof Error ? err.message.slice(0, 300) : 'unknown' })
      .catch(() => {});
  }
}

async function processStatus(deps: ProcessDeps, event: ClaimedEvent, payload: StatusEventPayload): Promise<void> {
  const { status } = payload;
  const error = status.errors?.[0];
  const result = await deps.store.applyMessageStatus({
    businessId: event.business_id,
    waMessageId: status.id,
    status: status.status,
    errorCode: error?.code !== undefined ? String(error.code) : null,
    errorMessage: error?.message ?? error?.title ?? null,
  });
  // The send may still be finishing (status arrived before we stored the id).
  if (result === 'not_found' && event.attempts < STATUS_NOT_FOUND_ATTEMPTS) {
    throw new RetryLater('Outbound message not found yet');
  }
}
