import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../server/auth/session.js';
import {
  createConversationsHandler,
  createCustomersHandler,
  createOrdersHandler,
  createOverviewHandler,
  type DashboardDeps,
} from '../../server/dashboard/handlers.js';
import { DashboardStore } from '../../server/dashboard/store.js';
import { createTestDb, pgliteRpc, seedTwoTenants, type Db } from './harness.js';

let db: Db;
let s: Awaited<ReturnType<typeof seedTwoTenants>>;
let deps: DashboardDeps;
let replies: { businessId: string; conversationId: string; body: string }[];

beforeEach(async () => {
  db = await createTestDb();
  s = await seedTwoTenants(db);
  replies = [];
  await db.query(
    `insert into public.messages (business_id, conversation_id, direction, sender, body, wa_message_id, status)
     values ($1, $2, 'inbound', 'customer', 'Do you deliver?', 'wamid.D1', 'received')`,
    [s.bizA, s.conversationA],
  );
  await db.query(`update public.customers set last_message_at = now()`);
  await db.query(`insert into public.leads (business_id, customer_id) values ($1, $2), ($3, $4)`, [s.bizA, s.customerA, s.bizB, s.customerB]);
  deps = {
    // Bearer token "token-<userId>" stands in for a verified Supabase session.
    authenticate: async (req) => {
      const m = /^Bearer token-(.+)$/.exec(req.headers.get('authorization') ?? '');
      return m ? ({ user: { id: m[1]!, email: null }, db: undefined as never } satisfies Session) : null;
    },
    storeFor: (session) => new DashboardStore(pgliteRpc(db, 'authenticated', session.user.id)),
    sendAgentReply: async (input) => {
      replies.push(input);
      return { ok: true, messageId: 'm1', waMessageId: 'wamid.R1' };
    },
  };
});

const req = (path: string, user?: string, method = 'GET', body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(user ? { authorization: `Bearer token-${user}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (res: Response) => (await res.json()) as any;

async function createOrder(qty = 2) {
  const r = await pgliteRpc(db)<{ order: { id: string } }>('create_order_request', {
    p_business_id: s.bizA,
    p_customer_id: s.customerA,
    p_conversation_id: s.conversationA,
    p_idempotency_key: `test-key-${qty}`,
    p_items: [{ product_id: s.productA, quantity: qty }],
  });
  return r.order.id;
}

describe('unauthorized access', () => {
  const handlers = () => [
    ['overview', createOverviewHandler(deps)],
    ['conversations', createConversationsHandler(deps)],
    ['customers', createCustomersHandler(deps)],
    ['orders', createOrdersHandler(deps)],
  ] as const;

  it('requires a session on every endpoint', async () => {
    for (const [name, h] of handlers()) {
      const res = await h(req(`/api/${name}?business_id=${s.bizA}`));
      expect(res.status, name).toBe(401);
    }
  });

  it("returns 404 for another tenant's business on every endpoint", async () => {
    for (const [name, h] of handlers()) {
      const res = await h(req(`/api/${name}?business_id=${s.bizB}`, s.userA));
      expect(res.status, name).toBe(404);
    }
  });
});

describe('overview', () => {
  it('returns counts for the business', async () => {
    await createOrder();
    const res = await createOverviewHandler(deps)(req(`/api/overview?business_id=${s.bizA}`, s.userA));
    const { overview } = await json(res);
    expect(overview).toMatchObject({ conversations_open: 1, orders_pending: 1, leads_new: 1, customers_total: 1, whatsapp_connected: false });
  });
});

describe('conversations', () => {
  const h = () => createConversationsHandler(deps);

  it('lists and shows conversations with messages', async () => {
    const list = await json(await h()(req(`/api/conversations?business_id=${s.bizA}`, s.userA)));
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]).toMatchObject({ status: 'open', customer: { wa_id: '15550001111' }, last_message: { body: 'Do you deliver?' } });

    const detail = await json(await h()(req(`/api/conversations?business_id=${s.bizA}&id=${s.conversationA}`, s.userA)));
    expect(detail.conversation).toMatchObject({ can_reply: true, messages: [expect.objectContaining({ body: 'Do you deliver?' })] });
  });

  it("cannot read another tenant's conversation by id", async () => {
    const res = await h()(req(`/api/conversations?business_id=${s.bizA}&id=${s.conversationA}`, s.userB));
    expect(res.status).toBe(404);
    // own business id + foreign conversation id
    const conv = await db.query<{ id: string }>(`insert into public.conversations (business_id, customer_id) values ($1, $2) returning id`, [s.bizB, s.customerB]);
    const cross = await h()(req(`/api/conversations?business_id=${s.bizA}&id=${conv.rows[0]!.id}`, s.userA));
    expect(cross.status).toBe(404);
  });

  it('agents hand over, resume and close; closed is final', async () => {
    const patch = (status: string) =>
      h()(req(`/api/conversations?business_id=${s.bizA}&id=${s.conversationA}`, s.agentA, 'PATCH', { status }));
    expect((await patch('handover')).status).toBe(200);
    expect((await patch('open')).status).toBe(200);
    expect((await patch('closed')).status).toBe(200);
    expect((await patch('open')).status).toBe(409);
  });

  it('an agent reply pauses the AI and sends through the server sender', async () => {
    const res = await h()(req(`/api/conversations?business_id=${s.bizA}&id=${s.conversationA}`, s.agentA, 'POST', { body: 'Yes, we deliver.' }));
    expect(res.status).toBe(201);
    expect(replies).toEqual([{ businessId: s.bizA, conversationId: s.conversationA, body: 'Yes, we deliver.' }]);
    const status = await db.query<{ status: string }>('select status from public.conversations where id = $1', [s.conversationA]);
    expect(status.rows[0]!.status).toBe('handover');
  });

  it("cannot reply into another tenant's conversation", async () => {
    const res = await h()(req(`/api/conversations?business_id=${s.bizB}&id=${s.conversationA}`, s.userB, 'POST', { body: 'hi' }));
    expect(res.status).toBe(404);
    expect(replies).toHaveLength(0);
  });

  it('reports the 24-hour window clearly', async () => {
    deps.sendAgentReply = async () => ({ ok: false, error: 'outside_service_window', retryable: false });
    const res = await h()(req(`/api/conversations?business_id=${s.bizA}&id=${s.conversationA}`, s.userA, 'POST', { body: 'hi' }));
    expect(res.status).toBe(409);
    expect((await json(res)).error.message).toMatch(/24 hours/);
  });

  it('rejects empty replies', async () => {
    const res = await h()(req(`/api/conversations?business_id=${s.bizA}&id=${s.conversationA}`, s.userA, 'POST', { body: '  ' }));
    expect(res.status).toBe(400);
  });
});

describe('customers and leads', () => {
  const h = () => createCustomersHandler(deps);

  it('lists customers with their lead and searches by name or number', async () => {
    const all = await json(await h()(req(`/api/customers?business_id=${s.bizA}`, s.userA)));
    expect(all.customers).toEqual([expect.objectContaining({ name: 'Ann', lead: expect.objectContaining({ status: 'new' }) })]);
    expect((await json(await h()(req(`/api/customers?business_id=${s.bizA}&q=ann`, s.userA)))).customers).toHaveLength(1);
    expect((await json(await h()(req(`/api/customers?business_id=${s.bizA}&q=0001111`, s.userA)))).customers).toHaveLength(1);
    expect((await json(await h()(req(`/api/customers?business_id=${s.bizA}&q=zzz`, s.userA)))).customers).toHaveLength(0);
  });

  it("updates own leads but not another tenant's", async () => {
    const leads = await db.query<{ id: string; business_id: string }>('select id, business_id from public.leads');
    const leadA = leads.rows.find((l) => l.business_id === s.bizA)!.id;
    const leadB = leads.rows.find((l) => l.business_id === s.bizB)!.id;
    const ok = await h()(req(`/api/customers?business_id=${s.bizA}&lead_id=${leadA}`, s.agentA, 'PATCH', { status: 'qualified', notes: 'Wants 5kg' }));
    expect(ok.status).toBe(200);
    const cross = await h()(req(`/api/customers?business_id=${s.bizA}&lead_id=${leadB}`, s.userA, 'PATCH', { status: 'lost' }));
    expect(cross.status).toBe(404);
    const b = await db.query<{ status: string }>('select status from public.leads where id = $1', [leadB]);
    expect(b.rows[0]!.status).toBe('new');
  });

  it('validates lead updates', async () => {
    const res = await h()(req(`/api/customers?business_id=${s.bizA}&lead_id=${s.customerA}`, s.userA, 'PATCH', { status: 'won-big' }));
    expect(res.status).toBe(400);
  });
});

describe('orders', () => {
  const h = () => createOrdersHandler(deps);
  const patch = (user: string, id: string, body: unknown, business = s.bizA) =>
    h()(req(`/api/orders?business_id=${business}&id=${id}`, user, 'PATCH', body));

  it('lists orders with items and customer', async () => {
    await createOrder();
    const { orders } = await json(await h()(req(`/api/orders?business_id=${s.bizA}`, s.userA)));
    expect(orders[0]).toMatchObject({ status: 'pending_confirmation', total_minor: 2500, items: [expect.objectContaining({ product_name: 'Coffee beans', quantity: 2 })] });
  });

  it('owner confirms, fulfils and records payment; payment requires confirmation', async () => {
    const id = await createOrder();
    expect((await patch(s.userA, id, { payment_status: 'paid' })).status).toBe(409);
    expect((await patch(s.userA, id, { status: 'confirmed' })).status).toBe(200);
    expect((await patch(s.userA, id, { payment_status: 'paid' })).status).toBe(200);
    expect((await patch(s.userA, id, { status: 'fulfilled' })).status).toBe(200);
    const row = await db.query<{ status: string; payment_status: string }>('select status, payment_status from public.orders where id = $1', [id]);
    expect(row.rows[0]).toEqual({ status: 'fulfilled', payment_status: 'paid' });
  });

  it('agents cannot change orders', async () => {
    const id = await createOrder();
    expect((await patch(s.agentA, id, { status: 'confirmed' })).status).toBe(403);
  });

  it("another tenant cannot confirm the order, even via their own business id", async () => {
    const id = await createOrder();
    expect((await patch(s.userB, id, { status: 'confirmed' }, s.bizB)).status).toBe(404);
    const row = await db.query<{ status: string }>('select status from public.orders where id = $1', [id]);
    expect(row.rows[0]!.status).toBe('pending_confirmation');
  });

  it('rejects invalid transitions and bodies', async () => {
    const id = await createOrder();
    expect((await patch(s.userA, id, { status: 'fulfilled' })).status).toBe(409);
    expect((await patch(s.userA, id, { status: 'confirmed', payment_status: 'paid' })).status).toBe(400);
    expect((await patch(s.userA, id, { status: 'pending_confirmation' })).status).toBe(400);
  });

  it('reports insufficient stock on confirmation', async () => {
    const id = await createOrder(5);
    await db.query('update public.products set stock_quantity = 1 where id = $1', [s.productA]);
    const res = await patch(s.userA, id, { status: 'confirmed' });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe('insufficient_stock');
  });
});

describe('database-level isolation of dashboard functions', () => {
  it('a non-member gets nothing from any read function', async () => {
    const rpc = pgliteRpc(db, 'authenticated', s.outsider);
    expect(await rpc('my_business_role', { p_business_id: s.bizA })).toBeNull();
    expect(await rpc('dashboard_overview', { p_business_id: s.bizA })).toBeNull();
    expect(await rpc('list_conversations', { p_business_id: s.bizA, p_status: null, p_limit: 50 })).toEqual([]);
    expect(await rpc('list_customers', { p_business_id: s.bizA, p_query: null, p_limit: 50 })).toEqual([]);
    expect(await rpc('list_orders', { p_business_id: s.bizA, p_status: null, p_limit: 50 })).toEqual([]);
    expect(await rpc('get_conversation', { p_business_id: s.bizA, p_conversation_id: s.conversationA })).toBeNull();
  });

  it('anon cannot call dashboard functions', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(pgliteRpc(db, 'anon', null)('list_orders', { p_business_id: s.bizA, p_status: null, p_limit: 5 })).rejects.toThrow(
      /permission denied/,
    );
    err.mockRestore();
  });
});
