import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite, type Transaction } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(import.meta.dirname, '../../supabase/migrations');
const SHIM = readFileSync(join(import.meta.dirname, 'supabase-shim.sql'), 'utf8');

export type Db = PGlite;
export type Tx = Transaction;
export type Role = 'anon' | 'authenticated' | 'service_role';

let snapshot: Promise<Blob> | undefined;

/**
 * Fresh in-memory Postgres with the Supabase shim and all migrations applied.
 * Migrations run once per test file; later calls clone that snapshot.
 */
export async function createTestDb(): Promise<Db> {
  snapshot ??= (async () => {
    const base = new PGlite();
    await base.exec(SHIM);
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      await base.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
    const dump = await base.dumpDataDir('none');
    await base.close();
    return dump;
  })();
  return PGlite.create({ loadDataDir: await snapshot });
}

/**
 * Runs fn inside a transaction as the given role, with a JWT `sub` claim when
 * userId is set, like PostgREST does for a request. Rolled back afterwards
 * unless commit is true.
 */
export async function as<T>(
  db: Db,
  role: Role,
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
  { commit = false } = {},
): Promise<T> {
  let result!: T;
  try {
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(userId ? { sub: userId, role } : { role }),
      ]);
      await tx.exec(`set local role ${role}`);
      result = await fn(tx);
      if (!commit) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result;
}

class Rollback extends Error {}

/** Seeds two independent businesses, each with an owner and products. */
export async function seedTwoTenants(db: Db) {
  const ids = {
    userA: '00000000-0000-4000-8000-00000000000a',
    userB: '00000000-0000-4000-8000-00000000000b',
    agentA: '00000000-0000-4000-8000-0000000000aa',
    outsider: '00000000-0000-4000-8000-0000000000ff',
  };
  await db.query(
    `insert into auth.users (id, email) values ($1,'a@example.com'),($2,'b@example.com'),($3,'agent@example.com'),($4,'x@example.com')`,
    [ids.userA, ids.userB, ids.agentA, ids.outsider],
  );
  const bizA = await createBusiness(db, 'Shop A', ids.userA, 'USD');
  const bizB = await createBusiness(db, 'Shop B', ids.userB, 'EUR');
  await db.query(`insert into public.business_members (business_id, user_id, role) values ($1, $2, 'agent')`, [
    bizA,
    ids.agentA,
  ]);

  const productA = await insertProduct(db, bizA, { name: 'Coffee beans', price_minor: 1250, stock_quantity: 10 });
  const productA2 = await insertProduct(db, bizA, { name: 'Mug', price_minor: 800 });
  const unavailableA = await insertProduct(db, bizA, { name: 'Seasonal blend', price_minor: 1500, is_available: false });
  const productB = await insertProduct(db, bizB, { name: 'Croissant', price_minor: 300 });

  const customerA = (
    await db.query<{ id: string }>(
      `insert into public.customers (business_id, wa_id, display_name) values ($1, '15550001111', 'Ann') returning id`,
      [bizA],
    )
  ).rows[0]!.id;
  const customerB = (
    await db.query<{ id: string }>(
      `insert into public.customers (business_id, wa_id, display_name) values ($1, '15550002222', 'Ben') returning id`,
      [bizB],
    )
  ).rows[0]!.id;
  const conversationA = (
    await db.query<{ id: string }>(
      `insert into public.conversations (business_id, customer_id) values ($1, $2) returning id`,
      [bizA, customerA],
    )
  ).rows[0]!.id;

  return { ...ids, bizA, bizB, productA, productA2, unavailableA, productB, customerA, customerB, conversationA };
}

async function createBusiness(db: Db, name: string, owner: string, currency: string): Promise<string> {
  const res = await db.query<{ id: string }>(`select public.create_business_with_owner($1, $2, $3) as id`, [
    name,
    owner,
    currency,
  ]);
  return res.rows[0]!.id;
}

async function insertProduct(
  db: Db,
  businessId: string,
  p: { name: string; price_minor: number; stock_quantity?: number; is_available?: boolean },
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into public.products (business_id, name, price_minor, stock_quantity, is_available)
     values ($1, $2, $3, $4, $5) returning id`,
    [businessId, p.name, p.price_minor, p.stock_quantity ?? null, p.is_available ?? true],
  );
  return res.rows[0]!.id;
}

/**
 * Rpc implementation backed by PGlite, running as service_role like the
 * server does. Mirrors supabase-js rpc(): named arguments, JSON results.
 */
export function pgliteRpc(db: Db) {
  return async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    if (!/^[a-z_]+$/.test(fn)) throw new Error(`bad function name ${fn}`);
    const keys = Object.keys(args);
    const params = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
    });
    const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as result`;
    return as(
      db,
      'service_role',
      null,
      async (tx) => ((await tx.query<{ result: unknown }>(call, params)).rows[0]?.result ?? null) as T,
      { commit: true },
    );
  };
}
