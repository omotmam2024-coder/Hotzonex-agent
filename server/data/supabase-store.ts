import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import type { Business, BusinessPatch } from '../business/schema.js';
import type { Product, ProductInput, ProductPatch } from '../products/schema.js';
import { ConflictError, type DataStore, type DeleteResult, type Membership, type MemberRole } from './store.js';

const PRODUCT_COLUMNS =
  'id, business_id, name, description, sku, category, kind, price_minor, is_available, stock_quantity, archived_at, created_at, updated_at';
const BUSINESS_COLUMNS =
  'id, name, description, ai_knowledge, ai_enabled, handover_message, currency, timezone, status, monthly_ai_request_limit, monthly_outbound_message_limit, created_at, updated_at';

export class SupabaseDataStore implements DataStore {
  constructor(private readonly db: SupabaseClient) {}

  async listMemberships(userId: string): Promise<Membership[]> {
    const { data, error } = await this.db
      .from('business_members')
      .select('business_id, role, businesses(name)')
      .eq('user_id', userId)
      .order('created_at');
    if (error) throw dbError(error);
    return (data as unknown as MemberRow[]).map(toMembership);
  }

  async getMembership(userId: string, businessId: string): Promise<Membership | null> {
    const { data, error } = await this.db
      .from('business_members')
      .select('business_id, role, businesses(name)')
      .eq('user_id', userId)
      .eq('business_id', businessId)
      .maybeSingle();
    if (error) throw dbError(error);
    return data ? toMembership(data as unknown as MemberRow) : null;
  }

  async getBusiness(businessId: string): Promise<Business | null> {
    const { data, error } = await this.db.from('businesses').select(BUSINESS_COLUMNS).eq('id', businessId).maybeSingle();
    if (error) throw dbError(error);
    return data as Business | null;
  }

  async updateBusiness(businessId: string, patch: BusinessPatch): Promise<Business | null> {
    const { data, error } = await this.db
      .from('businesses')
      .update(patch)
      .eq('id', businessId)
      .select(BUSINESS_COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    return data as Business | null;
  }

  async listProducts(businessId: string, opts: { q?: string | undefined; includeArchived: boolean }): Promise<Product[]> {
    let query = this.db.from('products').select(PRODUCT_COLUMNS).eq('business_id', businessId);
    if (!opts.includeArchived) query = query.is('archived_at', null);
    if (opts.q) query = query.ilike('name', `%${escapeLike(opts.q)}%`);
    const { data, error } = await query.order('name').limit(500);
    if (error) throw dbError(error);
    return (data as Product[]).map(normalizeProduct);
  }

  async createProduct(businessId: string, input: ProductInput): Promise<Product> {
    const { data, error } = await this.db
      .from('products')
      .insert({ ...input, business_id: businessId })
      .select(PRODUCT_COLUMNS)
      .single();
    if (error) throw dbError(error);
    return normalizeProduct(data as Product);
  }

  async updateProduct(businessId: string, productId: string, patch: ProductPatch): Promise<Product | null> {
    const { archived, ...fields } = patch;
    const update: Record<string, unknown> = { ...fields };
    if (archived !== undefined) update.archived_at = archived ? new Date().toISOString() : null;
    const { data, error } = await this.db
      .from('products')
      .update(update)
      .eq('business_id', businessId)
      .eq('id', productId)
      .select(PRODUCT_COLUMNS)
      .maybeSingle();
    if (error) throw dbError(error);
    return data ? normalizeProduct(data as Product) : null;
  }

  async deleteProduct(businessId: string, productId: string): Promise<DeleteResult> {
    const { data, error } = await this.db
      .from('products')
      .delete()
      .eq('business_id', businessId)
      .eq('id', productId)
      .select('id');
    if (!error) return data.length > 0 ? 'deleted' : 'not_found';
    // Referenced by order items: keep history, archive instead.
    if (error.code === '23503') {
      const archived = await this.updateProduct(businessId, productId, { archived: true });
      return archived ? 'archived' : 'not_found';
    }
    throw dbError(error);
  }
}

interface MemberRow {
  business_id: string;
  role: MemberRole;
  businesses: { name: string } | null;
}

function toMembership(row: MemberRow): Membership {
  return { business_id: row.business_id, role: row.role, business_name: row.businesses?.name ?? '' };
}

/** bigint columns arrive as numbers or strings depending on size. */
function normalizeProduct(p: Product): Product {
  return { ...p, price_minor: Number(p.price_minor) };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function dbError(error: PostgrestError): Error {
  if (error.code === '23505' && /sku/.test(error.message)) {
    return new ConflictError('sku_taken', 'Another product already uses this SKU');
  }
  // Never forward database messages to clients; the caller logs this.
  return new Error(`Database error ${error.code}: ${error.message}`);
}
