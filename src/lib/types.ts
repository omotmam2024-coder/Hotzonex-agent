// Shapes returned by /api endpoints (see server/*/schema.ts).

export type MemberRole = 'owner' | 'admin' | 'agent';

export interface Membership {
  business_id: string;
  business_name: string;
  role: MemberRole;
}

export interface Me {
  user: { id: string; email: string | null };
  memberships: Membership[];
}

export interface Business {
  id: string;
  name: string;
  description: string;
  ai_knowledge: string;
  ai_enabled: boolean;
  handover_message: string;
  currency: string;
  timezone: string;
  status: 'active' | 'suspended';
  monthly_ai_request_limit: number;
  monthly_outbound_message_limit: number;
}

export interface Product {
  id: string;
  business_id: string;
  name: string;
  description: string;
  sku: string | null;
  category: string | null;
  kind: 'product' | 'service';
  price_minor: number;
  is_available: boolean;
  stock_quantity: number | null;
  archived_at: string | null;
}

export const canManage = (role: MemberRole) => role === 'owner' || role === 'admin';

export interface Overview {
  conversations_open: number;
  conversations_handover: number;
  orders_pending: number;
  orders_confirmed_this_month: number;
  leads_new: number;
  customers_total: number;
  messages_in_this_month: number;
  messages_out_this_month: number;
  ai_requests_this_month: number;
  ai_tokens_this_month: number;
  monthly_ai_request_limit: number;
  monthly_outbound_message_limit: number;
  whatsapp_connected: boolean;
  ai_enabled: boolean;
  recent_errors: { action: string; created_at: string }[];
}

export type ConversationStatus = 'open' | 'handover' | 'closed';

export interface CustomerRef {
  id: string;
  name: string | null;
  wa_id: string;
}

export interface ConversationSummary {
  id: string;
  status: ConversationStatus;
  handover_reason: string | null;
  last_message_at: string | null;
  customer: CustomerRef;
  last_message: { body: string; direction: 'inbound' | 'outbound'; sender: string } | null;
}

export interface ChatMessage {
  id: string;
  direction: 'inbound' | 'outbound';
  sender: 'customer' | 'ai' | 'agent' | 'system';
  body: string;
  status: string;
  error_code: string | null;
  created_at: string;
}

export interface ConversationDetail {
  id: string;
  status: ConversationStatus;
  handover_reason: string | null;
  customer: CustomerRef & { last_message_at: string | null };
  can_reply: boolean;
  messages: ChatMessage[];
  orders: { id: string; status: OrderStatus; total_minor: number; currency: string; created_at: string }[];
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'won' | 'lost';

export interface CustomerRow extends CustomerRef {
  last_message_at: string | null;
  orders_count: number;
  lead: { id: string; status: LeadStatus; notes: string } | null;
}

export type OrderStatus = 'pending_confirmation' | 'confirmed' | 'cancelled' | 'fulfilled';
export type PaymentStatus = 'unpaid' | 'paid' | 'refunded';

export interface OrderRow {
  id: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  currency: string;
  total_minor: number;
  customer_note: string;
  conversation_id: string | null;
  created_at: string;
  customer: CustomerRef;
  items: { product_name: string; quantity: number; unit_price_minor: number; line_total_minor: number }[];
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_confirmation: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  cancelled: 'Cancelled',
  fulfilled: 'Fulfilled',
};

export function customerLabel(c: CustomerRef): string {
  return c.name ? `${c.name} (+${c.wa_id})` : `+${c.wa_id}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
