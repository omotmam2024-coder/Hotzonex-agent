import { beforeAll, describe, expect, it } from 'vitest';
import { as, createTestDb, seedTwoTenants, type Db } from './harness.js';

let db: Db;
let s: Awaited<ReturnType<typeof seedTwoTenants>>;

beforeAll(async () => {
  db = await createTestDb();
  s = await seedTwoTenants(db);
});

const TENANT_TABLES = [
  'businesses',
  'business_members',
  'business_integrations',
  'products',
  'customers',
  'leads',
  'conversations',
  'messages',
  'orders',
  'order_items',
  'webhook_events',
  'usage_records',
  'audit_logs',
];

describe('anonymous access', () => {
  it.each(TENANT_TABLES)('anon cannot read %s', async (table) => {
    await expect(as(db, 'anon', null, (tx) => tx.query(`select * from public.${table}`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('anon cannot call order functions', async () => {
    await expect(
      as(db, 'anon', null, (tx) => tx.query(`select public.set_order_status(gen_random_uuid(), 'confirmed')`)),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('tenant isolation for authenticated users', () => {
  it('every table has RLS enabled', async () => {
    const res = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'`,
    );
    expect(res.rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
    expect(res.rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it('a member sees only their own business and its products', async () => {
    const result = await as(db, 'authenticated', s.userA, async (tx) => ({
      businesses: (await tx.query<{ id: string }>('select id from public.businesses')).rows.map((r) => r.id),
      products: (await tx.query<{ business_id: string }>('select business_id from public.products')).rows,
      customers: (await tx.query<{ business_id: string }>('select business_id from public.customers')).rows,
    }));
    expect(result.businesses).toEqual([s.bizA]);
    expect(result.products).toHaveLength(3);
    expect(result.products.every((p) => p.business_id === s.bizA)).toBe(true);
    expect(result.customers.every((c) => c.business_id === s.bizA)).toBe(true);
  });

  it('a user with no membership sees nothing', async () => {
    const counts = await as(db, 'authenticated', s.outsider, async (tx) => {
      const out: Record<string, number> = {};
      for (const t of TENANT_TABLES) out[t] = (await tx.query(`select 1 from public.${t}`)).rows.length;
      return out;
    });
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('cannot read another tenant product by id', async () => {
    const rows = await as(db, 'authenticated', s.userA, (tx) =>
      tx.query('select * from public.products where id = $1', [s.productB]),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('cannot insert a product into another tenant', async () => {
    await expect(
      as(db, 'authenticated', s.userA, (tx) =>
        tx.query(`insert into public.products (business_id, name, price_minor) values ($1, 'Injected', 1)`, [s.bizB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant product (no rows affected)', async () => {
    const affected = await as(db, 'authenticated', s.userA, async (tx) => {
      const u = await tx.query(`update public.products set price_minor = 1 where id = $1`, [s.productB]);
      const d = await tx.query(`delete from public.products where id = $1`, [s.productB]);
      return [u.affectedRows, d.affectedRows];
    });
    expect(affected).toEqual([0, 0]);
    const price = await db.query<{ price_minor: number }>('select price_minor from public.products where id = $1', [
      s.productB,
    ]);
    expect(Number(price.rows[0]!.price_minor)).toBe(300);
  });

  it('cannot move a product to another business', async () => {
    await expect(
      as(db, 'authenticated', s.userA, (tx) =>
        tx.query(`update public.products set business_id = $1 where id = $2`, [s.bizB, s.productA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('an agent can read but not write products', async () => {
    const result = await as(db, 'authenticated', s.agentA, async (tx) => {
      const read = (await tx.query('select 1 from public.products')).rows.length;
      const upd = await tx.query(`update public.products set price_minor = 1 where id = $1`, [s.productA]);
      return { read, updated: upd.affectedRows };
    });
    expect(result).toEqual({ read: 3, updated: 0 });
    await expect(
      as(db, 'authenticated', s.agentA, (tx) =>
        tx.query(`insert into public.products (business_id, name, price_minor) values ($1, 'X', 1)`, [s.bizA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('owners cannot change operator-controlled business fields', async () => {
    await expect(
      as(db, 'authenticated', s.userA, (tx) =>
        tx.query(`update public.businesses set monthly_ai_request_limit = 999999 where id = $1`, [s.bizA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, 'authenticated', s.userA, (tx) => tx.query(`update public.businesses set status = 'active' where id = $1`, [s.bizA])),
    ).rejects.toThrow(/permission denied/);
  });

  it('owners can edit their profile fields', async () => {
    const res = await as(db, 'authenticated', s.userA, (tx) =>
      tx.query(`update public.businesses set description = 'Fresh coffee' where id = $1`, [s.bizA]),
    );
    expect(res.affectedRows).toBe(1);
  });

  it('users cannot grant themselves membership or map phone numbers', async () => {
    await expect(
      as(db, 'authenticated', s.outsider, (tx) =>
        tx.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'owner')`, [
          s.bizA,
          s.outsider,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, 'authenticated', s.userA, (tx) =>
        tx.query(
          `insert into public.business_integrations (business_id, provider, phone_number_id) values ($1, 'whatsapp', '1234567890')`,
          [s.bizA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('authenticated users cannot call service-only functions', async () => {
    await expect(
      as(db, 'authenticated', s.userA, (tx) =>
        tx.query(`select public.create_order_request($1, $2, null, 'idem-key-123', '[]'::jsonb)`, [s.bizA, s.customerA]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(db, 'authenticated', s.userA, (tx) => tx.query(`select public.create_business_with_owner('X', $1)`, [s.userA])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('integrity constraints', () => {
  it('a phone-number id maps to exactly one business', async () => {
    await db.query(
      `insert into public.business_integrations (business_id, provider, phone_number_id) values ($1, 'whatsapp', '111222333')`,
      [s.bizA],
    );
    await expect(
      db.query(
        `insert into public.business_integrations (business_id, provider, phone_number_id) values ($1, 'whatsapp', '111222333')`,
        [s.bizB],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it('child rows cannot reference another tenant (composite foreign keys)', async () => {
    await expect(
      db.query(`insert into public.conversations (business_id, customer_id) values ($1, $2)`, [s.bizA, s.customerB]),
    ).rejects.toThrow(/foreign key/);
  });

  it('webhook event keys are unique per provider', async () => {
    const insert = () =>
      db.query(
        `insert into public.webhook_events (business_id, provider, event_key, event_type, payload)
         values ($1, 'whatsapp', 'wamid.TEST1', 'message', '{}'::jsonb)`,
        [s.bizA],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('rejects negative prices and blank names', async () => {
    await expect(
      db.query(`insert into public.products (business_id, name, price_minor) values ($1, 'X', -1)`, [s.bizA]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      db.query(`insert into public.products (business_id, name, price_minor) values ($1, '   ', 1)`, [s.bizA]),
    ).rejects.toThrow(/check constraint/);
  });
});
