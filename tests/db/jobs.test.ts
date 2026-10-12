import { beforeEach, describe, expect, it } from 'vitest';
import { createProcessEventsJob } from '../../server/jobs/process-events.js';
import { MessagingStore } from '../../server/whatsapp/store.js';
import { createTestDb, pgliteRpc, seedTwoTenants, type Db } from './harness.js';

const SECRET = 'cron-secret-0123456789-0123456789-abcdef';
let db: Db;
let job: ReturnType<typeof createProcessEventsJob>;

beforeEach(async () => {
  db = await createTestDb();
  const s = await seedTwoTenants(db);
  const store = new MessagingStore(pgliteRpc(db));
  await store.storeEvents([
    {
      business_id: s.bizA,
      event_key: 'msg:wamid.Q',
      event_type: 'message',
      phone_number_id: '1000000001',
      payload: {
        phone_number_id: '1000000001',
        contact_name: 'Q',
        message: { from: '15550003333', id: 'wamid.Q', type: 'text', text: { body: 'queued' } },
      },
    },
  ]);
  job = createProcessEventsJob(() => ({ cronSecret: SECRET, store }));
});

const call = (auth?: string) =>
  job(new Request('http://localhost/api/jobs/process-events', { headers: auth ? { authorization: auth } : {} }));

describe('process-events job', () => {
  it.each([[undefined], ['Bearer wrong'], [SECRET]])('rejects bad credentials %#', async (auth) => {
    expect((await call(auth)).status).toBe(401);
    const pending = await db.query(`select 1 from public.webhook_events where status = 'pending'`);
    expect(pending.rows).toHaveLength(1);
  });

  it('processes pending events with the cron secret', async () => {
    const res = await call(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claimed: 1, processed: 1, failed: 0 });
    const msgs = await db.query(`select body from public.messages`);
    expect(msgs.rows).toEqual([{ body: 'queued' }]);
  });
});
