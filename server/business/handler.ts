import { MANAGER_ROLES, requireMembership, requireSession, type ApiDeps } from '../auth/context.js';
import { notFound, withErrorHandling } from '../http/errors.js';
import { parseOrThrow, queryParams, readJson } from '../http/request.js';
import { json, methodNotAllowed } from '../http/response.js';
import { businessPatchSchema, businessQuerySchema } from './schema.js';

/**
 * /api/business
 *   GET   ?business_id=   any member
 *   PATCH ?business_id=   owner/admin, profile fields only
 */
export function createBusinessHandler(deps: ApiDeps) {
  return withErrorHandling(async (request) => {
    const ctx = await requireSession(request, deps);
    const { business_id } = parseOrThrow(businessQuerySchema, queryParams(request));

    switch (request.method) {
      case 'GET': {
        const membership = await requireMembership(ctx, business_id);
        const business = await ctx.store.getBusiness(business_id);
        if (!business) throw notFound('Business');
        return json({ business, role: membership.role });
      }
      case 'PATCH': {
        const membership = await requireMembership(ctx, business_id, MANAGER_ROLES);
        const patch = await readJson(request, businessPatchSchema);
        const business = await ctx.store.updateBusiness(business_id, patch);
        if (!business) throw notFound('Business');
        return json({ business, role: membership.role });
      }
      default:
        return methodNotAllowed(['GET', 'PATCH']);
    }
  });
}
