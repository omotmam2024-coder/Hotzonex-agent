import { describe, expect, it } from 'vitest';
import { createTestDb, pgliteRpc, seedTwoTenants } from './harness.js';

describe('offboarding', () => {
  it('deleting a business requires deleting its orders first, then cascades everything else and leaves other tenants intact', async () => {
    const db = await createTestDb();
    const s = await seedTwoTenants(db);
    await pgliteRpc(db)('create_order_request', {
      p_business_id: s.bizA,
      p_customer_id: s.customerA,
      p_conversation_id: s.conversationA,
      p_idempotency_key: 'offboard-1',
      p_items: [{ product_id: s.productA, quantity: 1 }],
    });
    await expect(db.query('delete from public.businesses where id = $1', [s.bizA])).rejects.toThrow(/foreign key/);

    await db.transaction(async (tx) => {
      await tx.query('delete from public.orders where business_id = $1', [s.bizA]);
      await tx.query('delete from public.businesses where id = $1', [s.bizA]);
    });
    for (const table of ['products', 'customers', 'conversations', 'messages', 'orders', 'order_items', 'leads', 'business_members', 'audit_logs']) {
      const left = await db.query(`select 1 from public.${table} where business_id = $1`, [s.bizA]);
      expect(left.rows, table).toHaveLength(0);
    }
    const b = await db.query('select 1 from public.products where business_id = $1', [s.bizB]);
    expect(b.rows.length).toBeGreaterThan(0);
  });
});
