import type { Business, BusinessPatch } from '../business/schema.js';
import type { Product, ProductInput, ProductPatch } from '../products/schema.js';

export type MemberRole = 'owner' | 'admin' | 'agent';

export interface Membership {
  business_id: string;
  business_name: string;
  role: MemberRole;
}

export type DeleteResult = 'deleted' | 'archived' | 'not_found';

/**
 * Data access for dashboard requests. Implementations run as the signed-in
 * user, so the database enforces tenant isolation (RLS) in addition to the
 * membership checks done by the handlers.
 */
export interface DataStore {
  listMemberships(userId: string): Promise<Membership[]>;
  getMembership(userId: string, businessId: string): Promise<Membership | null>;

  getBusiness(businessId: string): Promise<Business | null>;
  updateBusiness(businessId: string, patch: BusinessPatch): Promise<Business | null>;

  listProducts(businessId: string, opts: { q?: string | undefined; includeArchived: boolean }): Promise<Product[]>;
  createProduct(businessId: string, input: ProductInput): Promise<Product>;
  updateProduct(businessId: string, productId: string, patch: ProductPatch): Promise<Product | null>;
  /** Deletes, or archives when the product is referenced by orders. */
  deleteProduct(businessId: string, productId: string): Promise<DeleteResult>;
}

/** Thrown by stores for constraint violations the caller can act on. */
export class ConflictError extends Error {
  constructor(
    readonly code: 'sku_taken',
    message: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}
