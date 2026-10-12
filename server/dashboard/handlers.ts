import { z } from 'zod';
import type { Authenticator, Session } from '../auth/session.js';
import type { MemberRole } from '../data/store.js';
import { DbError } from '../db/rpc.js';
import { HttpError, notFound, unauthorized, withErrorHandling } from '../http/errors.js';
import { parseOrThrow, queryParams, readJson } from '../http/request.js';
import { json, methodNotAllowed } from '../http/response.js';
import type { SendTextResult } from '../whatsapp/sender.js';
import { DashboardStore } from './store.js';

export interface DashboardDeps {
  authenticate: Authenticator;
  storeFor: (session: Session) => DashboardStore;
  /**
   * Sends an agent reply with the service role. Only called after the
   * caller's membership in the business was verified.
   */
  sendAgentReply?: (input: { businessId: string; conversationId: string; body: string }) => Promise<SendTextResult>;
}

const businessQuery = z.object({ business_id: z.uuid('business_id must be a UUID') });
const withId = businessQuery.extend({ id: z.uuid('id must be a UUID') });
const MANAGERS: MemberRole[] = ['owner', 'admin'];

async function authorize(request: Request, deps: DashboardDeps, businessId: string, roles?: MemberRole[]) {
  const session = await deps.authenticate(request);
  if (!session) throw unauthorized();
  const store = deps.storeFor(session);
  const role = await store.role(businessId);
  if (!role) throw notFound('Business');
  if (roles && !roles.includes(role)) throw new HttpError(403, 'forbidden', 'Your role does not allow this action');
  return { store, role };
}

/** Maps errors raised inside SQL functions to HTTP responses. */
function mapDbError(err: unknown): never {
  if (err instanceof DbError) {
    if (/order_not_found/.test(err.message)) throw notFound('Order');
    if (/invalid_transition/.test(err.message)) throw new HttpError(409, 'invalid_transition', 'That change is not allowed for this order');
  }
  throw err;
}

function resultOrThrow(r: { ok: boolean; error?: string }, what: string) {
  if (r.ok) return;
  if (r.error === 'not_found') throw notFound(what);
  throw new HttpError(409, r.error ?? 'conflict', conflictMessage(r.error));
}

function conflictMessage(code?: string): string {
  switch (code) {
    case 'invalid_transition':
      return 'That status change is not allowed';
    case 'insufficient_stock':
      return 'Not enough stock to confirm this order';
    case 'order_not_confirmed':
      return 'Confirm the order before recording payment';
    default:
      return 'The request could not be completed';
  }
}

/** GET /api/overview?business_id= */
export function createOverviewHandler(deps: DashboardDeps) {
  return withErrorHandling(async (request) => {
    if (request.method !== 'GET') return methodNotAllowed(['GET']);
    const { business_id } = parseOrThrow(businessQuery, queryParams(request));
    const { store } = await authorize(request, deps, business_id);
    return json({ overview: await store.overview(business_id) });
  });
}

const conversationList = businessQuery.extend({ status: z.enum(['open', 'handover', 'closed']).optional() });
const conversationPatch = z.strictObject({ status: z.enum(['open', 'handover', 'closed']) });
const replyBody = z.strictObject({ body: z.string().trim().min(1, 'Message is empty').max(4096) });

/**
 * /api/conversations
 *   GET   ?business_id=[&status=]   list
 *   GET   ?business_id=&id=         detail with messages
 *   PATCH ?business_id=&id=         {status}: hand over, resume AI, close
 *   POST  ?business_id=&id=         {body}: agent reply (pauses the AI)
 */
export function createConversationsHandler(deps: DashboardDeps) {
  return withErrorHandling(async (request) => {
    const query = queryParams(request);
    switch (request.method) {
      case 'GET': {
        if (query.id) {
          const { business_id, id } = parseOrThrow(withId, query);
          const { store } = await authorize(request, deps, business_id);
          const conversation = await store.getConversation(business_id, id);
          if (!conversation) throw notFound('Conversation');
          return json({ conversation });
        }
        const q = parseOrThrow(conversationList, query);
        const { store } = await authorize(request, deps, q.business_id);
        return json({ conversations: await store.listConversations(q.business_id, q.status ?? null) });
      }
      case 'PATCH': {
        const { business_id, id } = parseOrThrow(withId, query);
        const { store } = await authorize(request, deps, business_id);
        const { status } = await readJson(request, conversationPatch);
        resultOrThrow(await store.setConversationStatus(business_id, id, status), 'Conversation');
        return json({ ok: true, status });
      }
      case 'POST': {
        const { business_id, id } = parseOrThrow(withId, query);
        const { store } = await authorize(request, deps, business_id);
        const { body } = await readJson(request, replyBody);
        const conversation = await store.getConversation(business_id, id);
        if (!conversation) throw notFound('Conversation');
        if (conversation.status === 'closed') throw new HttpError(409, 'conversation_closed', 'This conversation is closed');
        if (!deps.sendAgentReply) throw new HttpError(503, 'whatsapp_not_configured', 'WhatsApp sending is not configured');

        // A person is now handling this chat: pause the AI first.
        if (conversation.status === 'open') await store.setConversationStatus(business_id, id, 'handover');
        const result = await deps.sendAgentReply({ businessId: business_id, conversationId: id, body });
        if (!result.ok) {
          const messages: Record<string, string> = {
            outside_service_window: 'WhatsApp only allows replies within 24 hours of the customer’s last message.',
            monthly_limit_reached: 'The monthly message limit has been reached.',
            no_whatsapp_integration: 'No WhatsApp number is connected to this business.',
          };
          throw new HttpError(result.retryable ? 502 : 409, result.error, messages[result.error] ?? 'The message could not be sent');
        }
        return json({ ok: true, message_id: result.messageId }, { status: 201 });
      }
      default:
        return methodNotAllowed(['GET', 'PATCH', 'POST']);
    }
  });
}

const customerList = businessQuery.extend({ q: z.string().trim().max(100).optional() });
const leadQuery = businessQuery.extend({ lead_id: z.uuid('lead_id must be a UUID') });
const leadPatch = z
  .strictObject({
    status: z.enum(['new', 'contacted', 'qualified', 'won', 'lost']),
    notes: z.string().trim().max(4000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide status or notes');

/** /api/customers  GET ?business_id=[&q=]  PATCH ?business_id=&lead_id= {status?, notes?} */
export function createCustomersHandler(deps: DashboardDeps) {
  return withErrorHandling(async (request) => {
    const query = queryParams(request);
    switch (request.method) {
      case 'GET': {
        const q = parseOrThrow(customerList, query);
        const { store } = await authorize(request, deps, q.business_id);
        return json({ customers: await store.listCustomers(q.business_id, q.q || null) });
      }
      case 'PATCH': {
        const { business_id, lead_id } = parseOrThrow(leadQuery, query);
        const { store } = await authorize(request, deps, business_id);
        const patch = await readJson(request, leadPatch);
        resultOrThrow(await store.updateLead(business_id, lead_id, patch.status ?? null, patch.notes ?? null), 'Lead');
        return json({ ok: true });
      }
      default:
        return methodNotAllowed(['GET', 'PATCH']);
    }
  });
}

const orderList = businessQuery.extend({
  status: z.enum(['pending_confirmation', 'confirmed', 'cancelled', 'fulfilled']).optional(),
});
const orderPatch = z.union([
  z.strictObject({ status: z.enum(['confirmed', 'cancelled', 'fulfilled']) }),
  z.strictObject({ payment_status: z.enum(['unpaid', 'paid', 'refunded']) }),
]);

/** /api/orders  GET ?business_id=[&status=]  PATCH ?business_id=&id= {status} | {payment_status} (owner/admin) */
export function createOrdersHandler(deps: DashboardDeps) {
  return withErrorHandling(async (request) => {
    const query = queryParams(request);
    switch (request.method) {
      case 'GET': {
        const q = parseOrThrow(orderList, query);
        const { store } = await authorize(request, deps, q.business_id);
        return json({ orders: await store.listOrders(q.business_id, q.status ?? null) });
      }
      case 'PATCH': {
        const { business_id, id } = parseOrThrow(withId, query);
        const { store } = await authorize(request, deps, business_id, MANAGERS);
        const patch = await readJson(request, orderPatch);
        // set_order_status / set_order_payment_status re-check that the caller
        // is owner/admin of the order's own business (404 otherwise).
        try {
          const r =
            'status' in patch ? await store.setOrderStatus(id, patch.status) : await store.setOrderPaymentStatus(id, patch.payment_status);
          resultOrThrow(r, 'Order');
        } catch (err) {
          if (err instanceof HttpError) throw err;
          mapDbError(err);
        }
        return json({ ok: true });
      }
      default:
        return methodNotAllowed(['GET', 'PATCH']);
    }
  });
}
