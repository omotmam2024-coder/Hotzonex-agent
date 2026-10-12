import type { Rpc } from '../db/rpc.js';
import type { MemberRole } from '../data/store.js';

/**
 * Dashboard reads and actions. The Rpc must run as the signed-in user
 * (publishable key + user JWT) so RLS applies to every query.
 */
export class DashboardStore {
  constructor(private readonly rpc: Rpc) {}

  role(businessId: string): Promise<MemberRole | null> {
    return this.rpc('my_business_role', { p_business_id: businessId });
  }
  overview(businessId: string): Promise<Record<string, unknown> | null> {
    return this.rpc('dashboard_overview', { p_business_id: businessId });
  }
  listConversations(businessId: string, status: string | null): Promise<unknown[]> {
    return this.rpc('list_conversations', { p_business_id: businessId, p_status: status, p_limit: 100 });
  }
  getConversation(businessId: string, conversationId: string): Promise<Record<string, unknown> | null> {
    return this.rpc('get_conversation', { p_business_id: businessId, p_conversation_id: conversationId });
  }
  setConversationStatus(businessId: string, conversationId: string, status: string): Promise<{ ok: boolean; error?: string }> {
    return this.rpc('set_conversation_status', { p_business_id: businessId, p_conversation_id: conversationId, p_status: status });
  }
  listCustomers(businessId: string, query: string | null): Promise<unknown[]> {
    return this.rpc('list_customers', { p_business_id: businessId, p_query: query, p_limit: 200 });
  }
  updateLead(businessId: string, leadId: string, status: string | null, notes: string | null): Promise<{ ok: boolean; error?: string }> {
    return this.rpc('update_lead', { p_business_id: businessId, p_lead_id: leadId, p_status: status, p_notes: notes });
  }
  listOrders(businessId: string, status: string | null): Promise<unknown[]> {
    return this.rpc('list_orders', { p_business_id: businessId, p_status: status, p_limit: 200 });
  }
  setOrderStatus(orderId: string, status: string): Promise<{ ok: boolean; error?: string }> {
    return this.rpc('set_order_status', { p_order_id: orderId, p_status: status });
  }
  setOrderPaymentStatus(orderId: string, paymentStatus: string): Promise<{ ok: boolean; error?: string }> {
    return this.rpc('set_order_payment_status', { p_order_id: orderId, p_payment_status: paymentStatus });
  }
}
