import type { DataStore, MemberRole, Membership } from '../data/store.js';
import { HttpError, notFound, unauthorized } from '../http/errors.js';
import type { Authenticator, Session } from './session.js';

export interface ApiDeps {
  authenticate: Authenticator;
  storeFor: (session: Session) => DataStore;
}

export interface RequestContext {
  session: Session;
  store: DataStore;
}

export async function requireSession(request: Request, deps: ApiDeps): Promise<RequestContext> {
  const session = await deps.authenticate(request);
  if (!session) throw unauthorized();
  return { session, store: deps.storeFor(session) };
}

/**
 * Authorizes the caller for a business. The business id from the request is
 * only a selector: access comes from the caller's membership, never from the
 * id itself. Non-members get 404 so business ids cannot be probed.
 */
export async function requireMembership(
  ctx: RequestContext,
  businessId: string,
  roles?: readonly MemberRole[],
): Promise<Membership> {
  const membership = await ctx.store.getMembership(ctx.session.user.id, businessId);
  if (!membership) throw notFound('Business');
  if (roles && !roles.includes(membership.role)) {
    throw new HttpError(403, 'forbidden', 'Your role does not allow this action');
  }
  return membership;
}

export const MANAGER_ROLES = ['owner', 'admin'] as const satisfies readonly MemberRole[];
