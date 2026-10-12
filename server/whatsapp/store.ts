import type { Rpc } from '../db/rpc.js';
import type { ParsedEvent } from './payload.js';

export interface ClaimedEvent {
  id: string;
  business_id: string;
  event_type: 'message' | 'status' | 'other';
  payload: unknown;
  attempts: number;
}

export type InboundResult =
  | { duplicate: true; message_id?: string; conversation_id?: string }
  | {
      duplicate: false;
      message_id: string;
      conversation_id: string;
      customer_id: string;
      conversation_status: 'open' | 'handover' | 'closed';
      ai_enabled: boolean;
      business_status: 'active' | 'suspended';
    };

export type BeginOutboundResult =
  | { ok: true; message_id: string; to: string; phone_number_id: string }
  | {
      ok: false;
      error:
        | 'business_inactive'
        | 'conversation_not_found'
        | 'outside_service_window'
        | 'no_whatsapp_integration'
        | 'monthly_limit_reached';
    };

/** Typed wrappers over the messaging SQL functions (service role). */
export class MessagingStore {
  constructor(private readonly rpc: Rpc) {}

  resolveBusiness(phoneNumberId: string): Promise<string | null> {
    return this.rpc<string | null>('resolve_whatsapp_business', { p_phone_number_id: phoneNumberId });
  }

  async storeEvents(events: (ParsedEvent & { business_id: string | null })[]): Promise<{ inserted: number; to_process: string[] }> {
    if (events.length === 0) return { inserted: 0, to_process: [] };
    const rows = events.map((e) => ({
      business_id: e.business_id,
      event_key: e.event_key,
      event_type: e.event_type,
      payload: e.payload,
    }));
    return this.rpc('store_webhook_events', { p_events: rows });
  }

  claimEvents(ids: string[] | null, limit = 20): Promise<ClaimedEvent[]> {
    return this.rpc('claim_webhook_events', { p_ids: ids, p_limit: limit });
  }

  async finishEvent(id: string, result: { ok: true } | { ok: false; error: string; retryable: boolean }): Promise<void> {
    await this.rpc('finish_webhook_event', {
      p_id: id,
      p_ok: result.ok,
      p_error: result.ok ? null : result.error,
      p_retryable: result.ok ? false : result.retryable,
    });
  }

  recordInboundMessage(input: {
    businessId: string;
    waId: string;
    profileName: string | null;
    waMessageId: string;
    body: string;
  }): Promise<InboundResult> {
    return this.rpc('record_inbound_message', {
      p_business_id: input.businessId,
      p_wa_id: input.waId,
      p_profile_name: input.profileName,
      p_wa_message_id: input.waMessageId,
      p_body: input.body,
    });
  }

  applyMessageStatus(input: {
    businessId: string;
    waMessageId: string;
    status: 'sent' | 'delivered' | 'read' | 'failed';
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<'updated' | 'unchanged' | 'not_found'> {
    return this.rpc('apply_message_status', {
      p_business_id: input.businessId,
      p_wa_message_id: input.waMessageId,
      p_status: input.status,
      p_error_code: input.errorCode ?? null,
      p_error_message: input.errorMessage ?? null,
    });
  }

  beginOutbound(input: {
    businessId: string;
    conversationId: string;
    body: string;
    sender: 'ai' | 'agent' | 'system';
  }): Promise<BeginOutboundResult> {
    return this.rpc('begin_outbound_message', {
      p_business_id: input.businessId,
      p_conversation_id: input.conversationId,
      p_body: input.body,
      p_sender: input.sender,
    });
  }

  async completeOutbound(input: {
    businessId: string;
    messageId: string;
    waMessageId?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<void> {
    await this.rpc('complete_outbound_message', {
      p_business_id: input.businessId,
      p_message_id: input.messageId,
      p_wa_message_id: input.waMessageId ?? null,
      p_error_code: input.errorCode ?? null,
      p_error_message: input.errorMessage ?? null,
    });
  }

  async log(businessId: string | null, level: 'info' | 'warn' | 'error', action: string, metadata: Record<string, unknown> = {}) {
    await this.rpc('log_event', { p_business_id: businessId, p_level: level, p_action: action, p_metadata: metadata });
  }
}
