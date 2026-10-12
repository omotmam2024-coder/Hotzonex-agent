import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhatsAppGraphClient } from '../../server/whatsapp/graph.js';
import { sendTextMessage } from '../../server/whatsapp/sender.js';
import { MessagingStore } from '../../server/whatsapp/store.js';
import { createTestDb, pgliteRpc, seedTwoTenants, type Db } from './harness.js';

let db: Db;
let s: Awaited<ReturnType<typeof seedTwoTenants>>;
let store: MessagingStore;
let fetchImpl: ReturnType<typeof vi.fn>;
let graph: WhatsAppGraphClient;

const graphOk = (id = 'wamid.SENT1') =>
  new Response(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id }] }), { status: 200 });

beforeEach(async () => {
  db = await createTestDb();
  s = await seedTwoTenants(db);
  await db.query(`insert into public.business_integrations (business_id, provider, phone_number_id) values ($1,'whatsapp','1000000001')`, [
    s.bizA,
  ]);
  // Customer A wrote recently, so the 24-hour window is open.
  await db.query(`update public.customers set last_message_at = now() where id = $1`, [s.customerA]);
  store = new MessagingStore(pgliteRpc(db));
  fetchImpl = vi.fn(async () => graphOk());
  graph = new WhatsAppGraphClient({ accessToken: 'test-token', apiVersion: 'v23.0', fetchImpl: fetchImpl as unknown as typeof fetch });
});

const send = (overrides: Partial<Parameters<typeof sendTextMessage>[1]> = {}) =>
  sendTextMessage({ store, graph }, { businessId: s.bizA, conversationId: s.conversationA, body: 'Hi there', sender: 'ai', ...overrides });

const message = async () =>
  (await db.query<{ status: string; wa_message_id: string | null; error_code: string | null }>(
    `select status, wa_message_id, error_code from public.messages where direction = 'outbound'`,
  )).rows;

describe('sendTextMessage', () => {
  it('calls the Graph API with the mapped number and records the WhatsApp id', async () => {
    const r = await send();
    expect(r).toMatchObject({ ok: true, waMessageId: 'wamid.SENT1' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/1000000001/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body as string)).toMatchObject({ to: '15550001111', type: 'text', text: { body: 'Hi there' } });
    expect(await message()).toEqual([{ status: 'sent', wa_message_id: 'wamid.SENT1', error_code: null }]);
    const usage = await db.query(`select 1 from public.usage_records where kind = 'whatsapp_outbound'`);
    expect(usage.rows).toHaveLength(1);
  });

  it('marks the message failed and never reports success when the API errors', async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Recipient not on WhatsApp', code: 131026 } }), { status: 400 }),
    );
    const r = await send();
    expect(r).toMatchObject({ ok: false, error: 'graph_131026', retryable: false });
    expect(await message()).toEqual([{ status: 'failed', wa_message_id: null, error_code: 'graph_131026' }]);
  });

  it('treats timeouts and 5xx as retryable', async () => {
    fetchImpl.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    expect(await send()).toMatchObject({ ok: false, error: 'timeout', retryable: true });
    fetchImpl.mockResolvedValueOnce(new Response('oops', { status: 503 }));
    expect(await send()).toMatchObject({ ok: false, error: 'http_503', retryable: true });
  });

  it('refuses outside the 24-hour customer service window without calling the API', async () => {
    await db.query(`update public.customers set last_message_at = now() - interval '25 hours' where id = $1`, [s.customerA]);
    expect(await send()).toMatchObject({ ok: false, error: 'outside_service_window' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces the monthly outbound limit', async () => {
    await db.query(`update public.businesses set monthly_outbound_message_limit = 1 where id = $1`, [s.bizA]);
    expect((await send()).ok).toBe(true);
    expect(await send()).toMatchObject({ ok: false, error: 'monthly_limit_reached' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('cannot send into another tenant conversation', async () => {
    expect(await send({ businessId: s.bizB })).toMatchObject({ ok: false, error: 'conversation_not_found' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses without an active WhatsApp integration or for suspended businesses', async () => {
    await db.query(`update public.business_integrations set status = 'disabled'`);
    expect(await send()).toMatchObject({ ok: false, error: 'no_whatsapp_integration' });
    await db.query(`update public.businesses set status = 'suspended' where id = $1`, [s.bizA]);
    expect(await send()).toMatchObject({ ok: false, error: 'business_inactive' });
  });

  it('rejects empty bodies', async () => {
    expect(await send({ body: '   ' })).toMatchObject({ ok: false, error: 'empty_body' });
  });
});
