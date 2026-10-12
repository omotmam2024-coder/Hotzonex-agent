import { randomUUID } from 'node:crypto';
import type { ApiDeps } from '../auth/context.js';
import type { Session } from '../auth/session.js';
import type { Business, BusinessPatch } from '../business/schema.js';
import { ConflictError, type DataStore, type DeleteResult, type Membership } from '../data/store.js';
import type { Product, ProductInput, ProductPatch } from '../products/schema.js';

/** In-memory DataStore for unit tests. Database-level isolation is tested in tests/db. */
export class MemoryStore implements DataStore {
  memberships: (Membership & { user_id: string })[] = [];
  businesses = new Map<string, Business>();
  products = new Map<string, Product>();
  referenced = new Set<string>();

  addBusiness(name: string, owner: string, role: Membership['role'] = 'owner'): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.businesses.set(id, {
      id,
      name,
      description: '',
      ai_knowledge: '',
      ai_enabled: true,
      handover_message: 'A person will reply soon.',
      currency: 'USD',
      timezone: 'UTC',
      status: 'active',
      monthly_ai_request_limit: 2000,
      monthly_outbound_message_limit: 2000,
      created_at: now,
      updated_at: now,
    });
    this.memberships.push({ business_id: id, business_name: name, role, user_id: owner });
    return id;
  }

  async listMemberships(userId: string) {
    return this.memberships.filter((m) => m.user_id === userId).map(({ user_id: _u, ...m }) => m);
  }
  async getMembership(userId: string, businessId: string) {
    return (await this.listMemberships(userId)).find((m) => m.business_id === businessId) ?? null;
  }
  async getBusiness(id: string) {
    return this.businesses.get(id) ?? null;
  }
  async updateBusiness(id: string, patch: BusinessPatch) {
    const b = this.businesses.get(id);
    if (!b) return null;
    const next = { ...b, ...patch } as Business;
    this.businesses.set(id, next);
    return next;
  }
  async listProducts(businessId: string, opts: { q?: string | undefined; includeArchived: boolean }) {
    return [...this.products.values()].filter(
      (p) =>
        p.business_id === businessId &&
        (opts.includeArchived || !p.archived_at) &&
        (!opts.q || p.name.toLowerCase().includes(opts.q.toLowerCase())),
    );
  }
  async createProduct(businessId: string, input: ProductInput) {
    if (input.sku && [...this.products.values()].some((p) => p.business_id === businessId && p.sku === input.sku)) {
      throw new ConflictError('sku_taken', 'Another product already uses this SKU');
    }
    const now = new Date().toISOString();
    const product: Product = { id: randomUUID(), business_id: businessId, archived_at: null, created_at: now, updated_at: now, ...input };
    this.products.set(product.id, product);
    return product;
  }
  async updateProduct(businessId: string, id: string, patch: ProductPatch) {
    const p = this.products.get(id);
    if (!p || p.business_id !== businessId) return null;
    const { archived, ...fields } = patch;
    const next: Product = { ...p, ...fields } as Product;
    if (archived !== undefined) next.archived_at = archived ? new Date().toISOString() : null;
    this.products.set(id, next);
    return next;
  }
  async deleteProduct(businessId: string, id: string): Promise<DeleteResult> {
    const p = this.products.get(id);
    if (!p || p.business_id !== businessId) return 'not_found';
    if (this.referenced.has(id)) {
      await this.updateProduct(businessId, id, { archived: true });
      return 'archived';
    }
    this.products.delete(id);
    return 'deleted';
  }
}

/** Deps where the bearer token is the user id (tokens: "token-<userId>"). */
export function memoryDeps(store: MemoryStore): ApiDeps {
  return {
    authenticate: async (request) => {
      const match = /^Bearer token-(.+)$/.exec(request.headers.get('authorization') ?? '');
      if (!match) return null;
      return { user: { id: match[1]!, email: null }, db: undefined as never } satisfies Session;
    },
    storeFor: () => store,
  };
}

export function apiRequest(
  path: string,
  { method = 'GET', user, body, headers = {} }: { method?: string; user?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const h = new Headers(headers);
  if (user) h.set('authorization', `Bearer token-${user}`);
  if (body !== undefined && !h.has('content-type')) h.set('content-type', 'application/json');
  return new Request(`http://localhost${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Parsed JSON body for assertions in tests. */
export const body = (res: Response): Promise<any> => res.json();
