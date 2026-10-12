import { beforeEach, describe, expect, it } from 'vitest';
import { as, createTestDb, seedTwoTenants, type Db } from './harness.js';

let db: Db;
let s: Awaited<ReturnType<typeof seedTwoTenants>>;

beforeEach(async () => {
  db = await createTestDb();
  s = await seedTwoTenants(db);
});

type OrderResult = {
  ok: boolean;
  created?: boolean;
  error?: string;
  not_found?: string[];
  unavailable?: string[];
  insufficient_stock?: string[];
  order?: {
    id: string;
    status: string;
    currency: string;
    total_minor: number;
    items: { product_id: string; quantity: number; unit_price_minor: number; line_total_minor: number }[];
  };
};

function createOrder(
  items: unknown,
  { key = 'wamid.ORDER-1', business = s.bizA, customer = s.customerA, conversation = s.conversationA as string | null } = {},
) {
  return as(
    db,
    'service_role',
    null,
    async (tx) =>
      (
        await tx.query<{ r: OrderResult }>(
          `select public.create_order_request($1, $2, $3, $4, $5::jsonb) as r`,
          [business, customer, conversation, key, JSON.stringify(items)],
        )
      ).rows[0]!.r,
    { commit: true },
  );
}

describe('create_order_request', () => {
  it('calculates totals from database prices and ignores any client-sent price', async () => {
    const r = await createOrder([
      { product_id: s.productA, quantity: 2, unit_price_minor: 1 },
      { product_id: s.productA2, quantity: 3, total: 0 },
    ]);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(r.order!.status).toBe('pending_confirmation');
    expect(r.order!.currency).toBe('USD');
    expect(Number(r.order!.total_minor)).toBe(2 * 1250 + 3 * 800);
  });

  it('merges duplicate lines for the same product', async () => {
    const r = await createOrder([
      { product_id: s.productA2, quantity: 1 },
      { product_id: s.productA2, quantity: 2 },
    ]);
    expect(r.order!.items).toHaveLength(1);
    expect(r.order!.items[0]!.quantity).toBe(3);
  });

  it('is idempotent: the same key returns the original order and creates nothing new', async () => {
    const first = await createOrder([{ product_id: s.productA, quantity: 1 }]);
    const replay = await createOrder([{ product_id: s.productA, quantity: 5 }]);
    expect(replay.ok).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.order!.id).toBe(first.order!.id);
    expect(Number(replay.order!.total_minor)).toBe(1250);
    const count = await db.query<{ n: number }>('select count(*)::int as n from public.orders');
    expect(count.rows[0]!.n).toBe(1);
  });

  it('rejects unavailable products without creating an order', async () => {
    const r = await createOrder([
      { product_id: s.productA, quantity: 1 },
      { product_id: s.unavailableA, quantity: 1 },
    ]);
    expect(r).toMatchObject({ ok: false, error: 'items_unavailable', unavailable: [s.unavailableA] });
    const count = await db.query<{ n: number }>('select count(*)::int as n from public.orders');
    expect(count.rows[0]!.n).toBe(0);
  });

  it('rejects archived products', async () => {
    await db.query('update public.products set archived_at = now() where id = $1', [s.productA2]);
    const r = await createOrder([{ product_id: s.productA2, quantity: 1 }]);
    expect(r).toMatchObject({ ok: false, unavailable: [s.productA2] });
  });

  it('rejects quantities above tracked stock', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 11 }]);
    expect(r).toMatchObject({ ok: false, insufficient_stock: [s.productA] });
  });

  it('treats another tenant product as not found', async () => {
    const r = await createOrder([{ product_id: s.productB, quantity: 1 }]);
    expect(r).toMatchObject({ ok: false, error: 'items_unavailable', not_found: [s.productB] });
  });

  it('cannot attach an order to another tenant customer', async () => {
    await expect(createOrder([{ product_id: s.productA, quantity: 1 }], { customer: s.customerB })).rejects.toThrow(
      /foreign key/,
    );
  });

  it.each([
    ['empty list', []],
    ['zero quantity', [{ product_id: '00000000-0000-4000-8000-000000000001', quantity: 0 }]],
    ['too many units', [{ product_id: '00000000-0000-4000-8000-000000000001', quantity: 101 }]],
    ['not an array', { product_id: 'x' }],
  ])('rejects malformed items: %s', async (_name, items) => {
    await expect(createOrder(items)).rejects.toThrow(/invalid_items/);
  });

  it('rejects suspended businesses', async () => {
    await db.query(`update public.businesses set status = 'suspended' where id = $1`, [s.bizA]);
    const r = await createOrder([{ product_id: s.productA, quantity: 1 }]);
    expect(r).toEqual({ ok: false, error: 'business_inactive' });
  });

  it('snapshots name and price so later edits do not change the order', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 1 }]);
    await db.query(`update public.products set price_minor = 9999, name = 'Renamed' where id = $1`, [s.productA]);
    const item = await db.query<{ product_name: string; unit_price_minor: number }>(
      'select product_name, unit_price_minor from public.order_items where order_id = $1',
      [r.order!.id],
    );
    expect(item.rows[0]!.product_name).toBe('Coffee beans');
    expect(Number(item.rows[0]!.unit_price_minor)).toBe(1250);
  });
});

describe('set_order_status', () => {
  const setStatus = (user: string, orderId: string, status: string) =>
    as(
      db,
      'authenticated',
      user,
      async (tx) =>
        (await tx.query<{ r: { ok: boolean; error?: string } }>(`select public.set_order_status($1, $2) as r`, [orderId, status]))
          .rows[0]!.r,
      { commit: true },
    );

  const stock = async () =>
    Number(
      (await db.query<{ q: number }>('select stock_quantity as q from public.products where id = $1', [s.productA])).rows[0]!.q,
    );

  it('owner confirms, which reserves stock; cancelling releases it', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 4 }]);
    expect(await setStatus(s.userA, r.order!.id, 'confirmed')).toMatchObject({ ok: true, status: 'confirmed' });
    expect(await stock()).toBe(6);
    expect(await setStatus(s.userA, r.order!.id, 'cancelled')).toMatchObject({ ok: true });
    expect(await stock()).toBe(10);
  });

  it('another tenant cannot confirm the order and learns nothing', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 1 }]);
    await expect(setStatus(s.userB, r.order!.id, 'confirmed')).rejects.toThrow(/order_not_found/);
  });

  it('agents cannot confirm orders', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 1 }]);
    await expect(setStatus(s.agentA, r.order!.id, 'confirmed')).rejects.toThrow(/order_not_found/);
  });

  it('rejects invalid transitions', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 1 }]);
    await expect(setStatus(s.userA, r.order!.id, 'fulfilled')).rejects.toThrow(/invalid_transition/);
  });

  it('does not confirm when stock ran out after the request', async () => {
    const r = await createOrder([{ product_id: s.productA, quantity: 5 }]);
    await db.query('update public.products set stock_quantity = 2 where id = $1', [s.productA]);
    expect(await setStatus(s.userA, r.order!.id, 'confirmed')).toMatchObject({ ok: false, error: 'insufficient_stock' });
    const order = await db.query<{ status: string }>('select status from public.orders where id = $1', [r.order!.id]);
    expect(order.rows[0]!.status).toBe('pending_confirmation');
  });
});
