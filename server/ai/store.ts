import type { Rpc } from '../db/rpc.js';

export interface AiContext {
  business: {
    name: string;
    description: string;
    ai_knowledge: string;
    ai_enabled: boolean;
    status: 'active' | 'suspended';
    currency: string;
    timezone: string;
    handover_message: string;
    monthly_ai_request_limit: number;
  };
  conversation_status: 'open' | 'handover' | 'closed';
  ai_requests_this_month: number;
  ai_replies_last_hour: number;
  messages: { direction: 'inbound' | 'outbound'; sender: 'customer' | 'ai' | 'agent' | 'system'; body: string }[];
}

export interface CatalogItem {
  product_id: string;
  name: string;
  kind: 'product' | 'service';
  description: string;
  category: string | null;
  price_minor: number;
  available: boolean;
}

export type OrderRequestResult =
  | {
      ok: true;
      created: boolean;
      order: {
        id: string;
        status: string;
        currency: string;
        total_minor: number;
        items: { product_id: string; product_name: string; quantity: number; unit_price_minor: number; line_total_minor: number }[];
      };
    }
  | { ok: false; error: 'business_inactive' }
  | { ok: false; error: 'items_unavailable'; not_found: string[]; unavailable: string[]; insufficient_stock: string[] };

/** Typed wrappers over the AI SQL functions (service role, tenant-scoped). */
export class AiStore {
  constructor(private readonly rpc: Rpc) {}

  getContext(businessId: string, conversationId: string, messageLimit = 20): Promise<AiContext | null> {
    return this.rpc('get_ai_context', { p_business_id: businessId, p_conversation_id: conversationId, p_message_limit: messageLimit });
  }

  async searchProducts(businessId: string, query: string | null, limit = 5): Promise<CatalogItem[]> {
    const rows = await this.rpc<CatalogItem[]>('search_products_for_ai', { p_business_id: businessId, p_query: query, p_limit: limit });
    return rows.map((r) => ({ ...r, price_minor: Number(r.price_minor) }));
  }

  async createOrderRequest(input: {
    businessId: string;
    customerId: string;
    conversationId: string;
    idempotencyKey: string;
    items: { product_id: string; quantity: number }[];
    note: string | null;
  }): Promise<OrderRequestResult> {
    const r = await this.rpc<OrderRequestResult>('create_order_request', {
      p_business_id: input.businessId,
      p_customer_id: input.customerId,
      p_conversation_id: input.conversationId,
      p_idempotency_key: input.idempotencyKey,
      p_items: input.items,
      p_customer_note: input.note ?? '',
      p_source: 'whatsapp_ai',
    });
    if (r.ok) {
      r.order.total_minor = Number(r.order.total_minor);
      for (const i of r.order.items) {
        i.unit_price_minor = Number(i.unit_price_minor);
        i.line_total_minor = Number(i.line_total_minor);
      }
    }
    return r;
  }

  requestHandover(businessId: string, conversationId: string, reason: string, actor: 'ai' | 'system' = 'ai') {
    return this.rpc<{ ok: boolean; handover_message: string }>('request_handover', {
      p_business_id: businessId,
      p_conversation_id: conversationId,
      p_reason: reason,
      p_actor: actor,
    });
  }

  async recordUsage(businessId: string, model: string, inputTokens: number, outputTokens: number): Promise<void> {
    await this.rpc('record_ai_usage', {
      p_business_id: businessId,
      p_model: model,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
    });
  }
}
