import { requireSession, type ApiDeps } from '../auth/context.js';
import { withErrorHandling } from '../http/errors.js';
import { json, methodNotAllowed } from '../http/response.js';

/** GET /api/me: the signed-in user and the businesses they can access. */
export function createMeHandler(deps: ApiDeps) {
  return withErrorHandling(async (request) => {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const ctx = await requireSession(request, deps);
    const memberships = await ctx.store.listMemberships(ctx.session.user.id);
    return json({ user: ctx.session.user, memberships });
  });
}
