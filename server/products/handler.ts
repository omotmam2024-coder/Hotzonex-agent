import { MANAGER_ROLES, requireMembership, requireSession, type ApiDeps } from '../auth/context.js';
import { ConflictError } from '../data/store.js';
import { HttpError, notFound, withErrorHandling } from '../http/errors.js';
import { parseOrThrow, queryParams, readJson } from '../http/request.js';
import { json, methodNotAllowed } from '../http/response.js';
import { productIdQuerySchema, productInputSchema, productListQuerySchema, productPatchSchema } from './schema.js';

/**
 * /api/products
 *   GET    ?business_id=&q=&include_archived=   any member
 *   POST   ?business_id=                         owner/admin
 *   PATCH  ?business_id=&id=                     owner/admin
 *   DELETE ?business_id=&id=                     owner/admin (archives if ordered before)
 */
export function createProductsHandler(deps: ApiDeps) {
  return withErrorHandling(async (request) => {
    const ctx = await requireSession(request, deps);
    const query = queryParams(request);

    try {
      switch (request.method) {
        case 'GET': {
          const q = parseOrThrow(productListQuerySchema, query);
          await requireMembership(ctx, q.business_id);
          const products = await ctx.store.listProducts(q.business_id, { q: q.q, includeArchived: q.include_archived });
          return json({ products });
        }
        case 'POST': {
          const { business_id } = parseOrThrow(productListQuerySchema.pick({ business_id: true }), query);
          await requireMembership(ctx, business_id, MANAGER_ROLES);
          const input = await readJson(request, productInputSchema);
          const product = await ctx.store.createProduct(business_id, input);
          return json({ product }, { status: 201 });
        }
        case 'PATCH': {
          const { business_id, id } = parseOrThrow(productIdQuerySchema, query);
          await requireMembership(ctx, business_id, MANAGER_ROLES);
          const patch = await readJson(request, productPatchSchema);
          const product = await ctx.store.updateProduct(business_id, id, patch);
          if (!product) throw notFound('Product');
          return json({ product });
        }
        case 'DELETE': {
          const { business_id, id } = parseOrThrow(productIdQuerySchema, query);
          await requireMembership(ctx, business_id, MANAGER_ROLES);
          const result = await ctx.store.deleteProduct(business_id, id);
          if (result === 'not_found') throw notFound('Product');
          return json({ result });
        }
        default:
          return methodNotAllowed(['GET', 'POST', 'PATCH', 'DELETE']);
      }
    } catch (err) {
      if (err instanceof ConflictError) throw new HttpError(409, err.code, err.message);
      throw err;
    }
  });
}
