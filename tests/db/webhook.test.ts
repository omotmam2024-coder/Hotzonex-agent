import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processWebhookEvents, type InboundContext } from '../../server/whatsapp/processor.js';
import { signBody } from '../../server/whatsapp/signature.js';
import { MessagingStore } from '../../server/whatsapp/store.js';
import { createWhatsAppWebhookHandler, type WebhookDeps } from '../../server/whatsapp/webhook.js';
import { createTestDb, pgliteRpc, seedTwoTenants, type Db } from './harness.js';

const APP_SECRET = 'test-app-secret-0123456789';
const VERIFY_TOKEN = 'verify-token-0123456789';
const PHONE_A = '1000000001';
const PHONE_B = '1000000002';

let db: Db;
let s: Awaited<ReturnType<typeof seedTwoTenants>>;
let store: MessagingStore;
let deferred: Promise<unknown>[];
let responded: InboundContext[];
let handler: ReturnType<typeof createWhatsAppWebhookHandler>;

beforeEach(async () => {
  db = await createTestDb();
  s = await seedTwoTenants(db);
  await db.query(
    `insert into public.business_integrations (business_id, provider, phone_number_id) values ($1,'whatsapp',$2),($3,'whatsapp',$4)`,
    [s.bizA, PHONE_A, s.bizB, PHONE_B],
  );
  store = new MessagingStore(pgliteRpc(db));
  deferred = [];
  responded = [];
  const deps: WebhookDeps = {
    verifyToken: VERIFY_TOKEN,
    appSecret: APP_SECRET,
    store,
    responder: { onInboundMessage: async (ctx) => void responded.push(ctx) },
    defer: (p) => void deferred.push(p),
  };
  handler = createWhatsAppWebhookHandler(() => deps);
});

function textPayload(opts: { phone?: string; from?: string; id?: string; body?: string; name?: string } = {}) {
  const from = opts.from ?? '15550009999';
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550000000', phone_number_id: opts.phone ?? PHONE_A },
              contacts: [{ wa_id: from, profile: { name: opts.name ?? 'Cara' } }],
              messages: [
                { from, id: opts.id ?? 'wamid.IN1', timestamp: '1760000000', type: 'text', text: { body: opts.body ?? 'Do you have coffee?' } },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(id: string, status: string, phone = PHONE_A, errors?: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phone },
              statuses: [{ id, status, timestamp: '1760000001', recipient_id: '15550009999', ...(errors ? { errors } : {}) }],
            },
          },
        ],
      },
    ],
  };
}

async function post(body: unknown, { signature, secret = APP_SECRET }: { signature?: string | null; secret?: string } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers({ 'content-type': 'application/json' });
  const sig = signature === undefined ? signBody(raw, secret) : signature;
  if (sig !== null) headers.set('x-hub-signature-256', sig);
  const res = await handler(new Request('http://localhost/api/webhooks/whatsapp', { method: 'POST', headers, body: raw }));
  await Promise.all(deferred.splice(0));
  return res;
}

const count = async (table: string, where = 'true', params: unknown[] = []) =>
  (await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`, params)).rows[0]!.n;

describe('GET verification', () => {
  const verify = (q: string) => handler(new Request(`http://localhost/api/webhooks/whatsapp?${q}`));

  it('echoes the challenge for a valid token', async () => {
    const res = await verify(`hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await res.text()).toBe('1158201444');
  });

  it.each([
    ['wrong token', `hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`],
    ['wrong mode', `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`],
    ['missing challenge', `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`],
    ['script challenge', `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=%3Cscript%3E`],
  ])('rejects %s with 403', async (_label, q) => {
    expect((await verify(q)).status).toBe(403);
  });
});

describe('POST signature', () => {
  it.each([
    ['missing header', null],
    ['wrong secret', signBody(JSON.stringify(textPayload()), 'another-secret-value-123')],
    ['malformed header', 'sha256=xyz'],
    ['sha1 header', 'sha1=0123456789abcdef0123456789abcdef01234567'],
  ])('rejects %s and stores nothing', async (_label, signature) => {
    const res = await post(textPayload(), { signature });
    expect(res.status).toBe(401);
    expect(await count('webhook_events')).toBe(0);
    expect(await count('messages')).toBe(0);
  });

  it('rejects a body modified after signing', async () => {
    const raw = JSON.stringify(textPayload());
    const sig = signBody(raw, APP_SECRET);
    const res = await post(raw.replace('Do you have coffee?', 'Give me a discount'), { signature: sig });
    expect(res.status).toBe(401);
  });

  it('verifies over raw bytes, not re-serialized JSON', async () => {
    // Same JSON value, different whitespace: only the exact signed bytes pass.
    const raw = JSON.stringify(textPayload(), null, 2);
    expect((await post(raw)).status).toBe(200);
    const compact = JSON.stringify(JSON.parse(raw));
    expect((await post(compact, { signature: signBody(raw, APP_SECRET) })).status).toBe(401);
  });
});

describe('POST payload validation', () => {
  it('rejects signed invalid JSON and unexpected shapes', async () => {
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ object: 'page', entry: [] })).status).toBe(400);
    expect((await post({ object: 'whatsapp_business_account' })).status).toBe(400);
  });

  it('skips malformed items but keeps valid ones', async () => {
    const payload = textPayload();
    const value = payload.entry[0]!.changes[0]!.value as { messages: unknown[] };
    value.messages.push({ from: 'not-a-number', id: 'wamid.BAD', type: 'text' });
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, stored: 1 });
  });

  it('rejects oversized bodies', async () => {
    const res = await post({ ...textPayload(), padding: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe('POST processing', () => {
  it('records the customer, conversation, message and lead for the mapped tenant only', async () => {
    const res = await post(textPayload());
    expect(res.status).toBe(200);
    expect(await count('messages', 'business_id = $1 and direction = $2', [s.bizA, 'inbound'])).toBe(1);
    expect(await count('messages', 'business_id = $1', [s.bizB])).toBe(0);
    expect(await count('customers', `business_id = $1 and wa_id = '15550009999'`, [s.bizA])).toBe(1);
    expect(await count('leads', 'business_id = $1', [s.bizA])).toBe(1);
    expect(await count('webhook_events', `status = 'processed'`)).toBe(1);
    expect(responded).toHaveLength(1);
    expect(responded[0]).toMatchObject({ businessId: s.bizA, text: 'Do you have coffee?', isText: true });
  });

  it('routes by phone-number id to the other tenant', async () => {
    await post(textPayload({ phone: PHONE_B, id: 'wamid.FORB' }));
    expect(await count('messages', 'business_id = $1', [s.bizB])).toBe(1);
    expect(await count('messages', 'business_id = $1', [s.bizA])).toBe(0);
  });

  it('stores events for unknown numbers as ignored and creates no data', async () => {
    const res = await post(textPayload({ phone: '9999999999', id: 'wamid.UNKNOWN' }));
    expect(res.status).toBe(200);
    expect(await count('webhook_events', `status = 'ignored' and business_id is null`)).toBe(1);
    expect(await count('messages')).toBe(0);
    expect(responded).toHaveLength(0);
  });

  it('deduplicates retried deliveries: one event, one message, one reply', async () => {
    const payload = textPayload({ id: 'wamid.DUP' });
    expect((await post(payload)).status).toBe(200);
    const second = await post(payload);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ stored: 0 });
    expect(await count('webhook_events')).toBe(1);
    expect(await count('messages')).toBe(1);
    expect(responded).toHaveLength(1);
  });

  it('a second message reuses the open conversation', async () => {
    await post(textPayload({ id: 'wamid.1' }));
    await post(textPayload({ id: 'wamid.2', body: 'And mugs?' }));
    expect(await count('conversations', 'business_id = $1', [s.bizA])).toBe(2); // seeded one + this customer
    expect(await count('messages')).toBe(2);
    expect(await count('leads', 'business_id = $1', [s.bizA])).toBe(1);
  });

  it('does not call the responder during human handover or when AI is off', async () => {
    await post(textPayload({ id: 'wamid.1' }));
    await db.query(`update public.conversations set status = 'handover' where business_id = $1`, [s.bizA]);
    await post(textPayload({ id: 'wamid.2' }));
    expect(responded).toHaveLength(1);

    await db.query(`update public.conversations set status = 'open'`);
    await db.query(`update public.businesses set ai_enabled = false where id = $1`, [s.bizA]);
    await post(textPayload({ id: 'wamid.3' }));
    expect(responded).toHaveLength(1);
    expect(await count('messages')).toBe(3);
  });

  it('records non-text messages with a placeholder and flags them', async () => {
    const payload = textPayload({ id: 'wamid.IMG' });
    const msg = (payload.entry[0]!.changes[0]!.value as { messages: Record<string, unknown>[] }).messages[0]!;
    delete msg.text;
    msg.type = 'image';
    msg.image = { id: 'media-1', mime_type: 'image/jpeg' };
    await post(payload);
    expect(responded[0]).toMatchObject({ isText: false, text: '[image message]' });
  });

  it('a responder failure is logged and does not cause duplicate processing', async () => {
    const failing: WebhookDeps = {
      verifyToken: VERIFY_TOKEN,
      appSecret: APP_SECRET,
      store,
      responder: { onInboundMessage: async () => Promise.reject(new Error('AI down')) },
      defer: (p) => void deferred.push(p),
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    handler = createWhatsAppWebhookHandler(() => failing);
    await post(textPayload({ id: 'wamid.F' }));
    expect(await count('webhook_events', `status = 'processed'`)).toBe(1);
    expect(await count('audit_logs', `action = 'responder.failed'`)).toBe(1);
    err.mockRestore();
  });
});

describe('delivery statuses', () => {
  async function outbound(wamid: string) {
    const conv = s.conversationA;
    await db.query(
      `insert into public.messages (business_id, conversation_id, direction, sender, body, wa_message_id, status)
       values ($1, $2, 'outbound', 'ai', 'Hello', $3, 'sent')`,
      [s.bizA, conv, wamid],
    );
  }
  const statusOf = async (wamid: string) =>
    (await db.query<{ status: string; error_code: string | null }>('select status, error_code from public.messages where wa_message_id = $1', [wamid]))
      .rows[0]!;

  it('applies forward progress and ignores out-of-order regressions', async () => {
    await outbound('wamid.OUT1');
    await post(statusPayload('wamid.OUT1', 'read'));
    await post(statusPayload('wamid.OUT1', 'delivered'));
    expect((await statusOf('wamid.OUT1')).status).toBe('read');
  });

  it('records failures with the provider error code', async () => {
    await outbound('wamid.OUT2');
    await post(statusPayload('wamid.OUT2', 'failed', PHONE_A, [{ code: 131047, title: 'Re-engagement message' }]));
    expect(await statusOf('wamid.OUT2')).toEqual({ status: 'failed', error_code: '131047' });
  });

  it('cannot update another tenant message even with a known wamid', async () => {
    await outbound('wamid.OUT3');
    // Status arrives on tenant B's number for tenant A's message id.
    await post(statusPayload('wamid.OUT3', 'read', PHONE_B));
    expect((await statusOf('wamid.OUT3')).status).toBe('sent');
  });

  it('retries a status that arrives before the outbound id is stored, then applies it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await post(statusPayload('wamid.LATE', 'delivered'));
    expect(await count('webhook_events', `status = 'failed'`)).toBe(1);
    await outbound('wamid.LATE');
    // Make the back-off elapse, then run the retry job's processing.
    await db.query(`update public.webhook_events set locked_until = now() - interval '1 second'`);
    const summary = await processWebhookEvents({ store });
    expect(summary).toMatchObject({ claimed: 1, processed: 1 });
    expect((await statusOf('wamid.LATE')).status).toBe('delivered');
    err.mockRestore();
  });

  it('statuses do not create orders, messages or customers', async () => {
    await post(statusPayload('wamid.X', 'sent'));
    expect(await count('messages')).toBe(0);
    expect(await count('orders')).toBe(0);
  });
});

describe('event queue', () => {
  it('two workers never claim the same event', async () => {
    await store.storeEvents([
      { business_id: s.bizA, event_key: 'msg:a', event_type: 'message', phone_number_id: PHONE_A, payload: {} as never },
      { business_id: s.bizA, event_key: 'msg:b', event_type: 'message', phone_number_id: PHONE_A, payload: {} as never },
    ]);
    const first = await store.claimEvents(null, 10);
    const second = await store.claimEvents(null, 10);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(0);
  });

  it('parks events after the maximum attempts', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.storeEvents([
      { business_id: s.bizA, event_key: 'status:x:sent', event_type: 'status', phone_number_id: PHONE_A, payload: { status: { id: 'x', status: 'bogus' } } as never },
    ]);
    for (let i = 0; i < 6; i++) {
      await db.query(`update public.webhook_events set locked_until = now() - interval '1 second' where locked_until <> 'infinity'`);
      await processWebhookEvents({ store });
    }
    const row = (await db.query<{ status: string; attempts: number; locked_until: string }>(
      `select status, attempts, locked_until::text from public.webhook_events`,
    )).rows[0]!;
    expect(row).toMatchObject({ status: 'failed', attempts: 5, locked_until: 'infinity' });
    err.mockRestore();
  });
});
