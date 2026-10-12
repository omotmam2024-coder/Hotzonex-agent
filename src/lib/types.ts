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
