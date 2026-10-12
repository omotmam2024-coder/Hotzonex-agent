import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLimits } from '../../server/ai/agent.js';
import { DEFAULT_LIMITS } from '../../server/ai/agent.js';
import type { AiModel, ModelRequest, ModelResponse } from '../../server/ai/model.js';
import { AiResponder, NON_TEXT_REPLY } from '../../server/ai/responder.js';
import { AiStore } from '../../server/ai/store.js';
import { WhatsAppGraphClient } from '../../server/whatsapp/graph.js';
import { sendTextMessage } from '../../server/whatsapp/sender.js';
import { signBody } from '../../server/whatsapp/signature.js';
import { MessagingStore } from '../../server/whatsapp/store.js';
import { createWhatsAppWebhookHandler } from '../../server/whatsapp/webhook.js';
import { createTestDb, pgliteRpc, seedTwoTenants, type Db } from './harness.js';

const APP_SECRET = 'test-app-secret-0123456789';
const PHONE_A = '1000000001';
const CUSTOMER = '15550007777';

type Step = (req: ModelRequest) => ModelResponse | Promise<ModelResponse>;

/** Scripted stand-in for the OpenAI Responses API. */
class ScriptedModel implements AiModel {
  requests: ModelRequest[] = [];
  constructor(private steps: Step[]) {}
  async respond(req: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('ScriptedModel: no more steps');
    return step(req);
  }
}

const usage = { input_tokens: 100, output_tokens: 20 };
const say = (text: string): Step => () => ({ outputText: text, functionCalls: [], usage });
let callSeq = 0;
const call = (name: string, args: unknown): Step => () => ({
  outputText: '',
  functionCalls: [{ call_id: `call_${++callSeq}`, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }],
  usage,
});
/** Last tool output the model was given. */
const lastToolOutput = (m: ScriptedModel) => {
  const input = m.requests.at(-1)!.input;
  const out = [...input].reverse().find((i) => 'type' in i && i.type === 'function_call_output') as { output: string };
  return JSON.parse(out.output);
};

let db: Db;
let s: Awaited<ReturnType<typeof seedTwoTenants>>;
let sent: { to: string; body: string }[];
let model: ScriptedModel;
let limits: AgentLimits;
let deferred: Promise<unknown>[];

beforeEach(async () => {
  db = await createTestDb();
  s = await seedTwoTenants(db);
  await db.query(`insert into public.business_integrations (business_id, provider, phone_number_id) values ($1,'whatsapp',$2)`, [s.bizA, PHONE_A]);
  sent = [];
  deferred = [];
  limits = { ...DEFAULT_LIMITS };
  callSeq = 0;
});

function handlerWith(steps: Step[]) {
  model = new ScriptedModel(steps);
  const rpc = pgliteRpc(db);
  const messaging = new MessagingStore(rpc);
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ to: body.to, body: body.text.body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT${sent.length}` }] }), { status: 200 });
  });
  const graph = new WhatsAppGraphClient({ accessToken: 't', apiVersion: 'v23.0', fetchImpl: fetchImpl as unknown as typeof fetch });
  const responder = new AiResponder({
    model,
    modelName: 'test-model',
    store: new AiStore(rpc),
    limits,
    send: (input) => sendTextMessage({ store: messaging, graph }, input),
    today: () => 'Monday 12 October 2026',
  });
  return createWhatsAppWebhookHandler(() => ({
    verifyToken: 'verify-token-0123456789',
    appSecret: APP_SECRET,
    store: messaging,
    responder,
    defer: (p) => void deferred.push(p),
  }));
}

async function customerSays(handler: ReturnType<typeof handlerWith>, text: string, id = `wamid.IN${Math.random()}`, type = 'text') {
  const message: Record<string, unknown> = { from: CUSTOMER, id, timestamp: '1760000000', type };
  if (type === 'text') message.text = { body: text };
  else message[type] = { id: 'media' };
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'W',
        changes: [
          {
            field: 'messages',
            value: { metadata: { phone_number_id: PHONE_A }, contacts: [{ wa_id: CUSTOMER, profile: { name: 'Dee' } }], messages: [message] },
          },
        ],
      },
    ],
  });
  const res = await handler(
    new Request('http://localhost/api/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signBody(raw, APP_SECRET) },
      body: raw,
    }),
  );
  expect(res.status).toBe(200);
  await Promise.all(deferred.splice(0));
}

const orders = async () =>
  (await db.query<{ total_minor: number; status: string; business_id: string }>('select total_minor, status, business_id from public.orders')).rows;
const conversationStatus = async () =>
  (
    await db.query<{ status: string }>(
      `select c.status from public.conversations c join public.customers cu on cu.id = c.customer_id where cu.wa_id = $1`,
      [CUSTOMER],
    )
  ).rows[0]!.status;

describe('AI agent: product lookup', () => {
  it('searches the catalogue and replies with catalogue prices', async () => {
    const h = handlerWith([call('search_products', { query: 'coffee' }), (req) => say(`Coffee beans are ${JSON.stringify(req.input.length)}`)(req)]);
    await customerSays(h, 'How much is coffee?');
    const output = lastToolOutput(model);
    expect(output.products).toEqual([expect.objectContaining({ product_id: s.productA, name: 'Coffee beans', price: '$12.50', available: true })]);
    // tenant B's catalogue is never visible
    expect(JSON.stringify(output)).not.toContain('Croissant');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(CUSTOMER);
    // the request carried grounded instructions, tools and the customer's text
    const req = model.requests[0]!;
    expect(req.instructions).toContain('Shop A');
    expect(req.tools.map((t) => t.name)).toEqual(['search_products', 'create_order_request', 'request_human_handover']);
    expect(req.input.at(-1)).toEqual({ role: 'user', content: 'How much is coffee?' });
    const usageRows = await db.query(`select 1 from public.usage_records where kind = 'ai_request'`);
    expect(usageRows.rows).toHaveLength(2);
  });

  it('flags unavailable products and refuses to order them', async () => {
    const h = handlerWith([
      call('search_products', { query: 'seasonal blend' }),
      call('create_order_request', { items: [{ product_id: s.unavailableA, quantity: 1 }], customer_note: null }),
      say('Sorry, the Seasonal blend is not available right now. Would you like Coffee beans instead?'),
    ]);
    await customerSays(h, 'I want the seasonal blend');
    const search = JSON.parse((model.requests[1]!.input.at(-1) as { output: string }).output);
    expect(search.products[0]).toMatchObject({ name: 'Seasonal blend', available: false });
    expect(lastToolOutput(model)).toMatchObject({ error: 'items_unavailable', unavailable: [s.unavailableA] });
    expect(await orders()).toHaveLength(0);
  });
});

describe('AI agent: orders', () => {
  it('creates a pending order with server-calculated totals', async () => {
    const h = handlerWith([
      call('create_order_request', { items: [{ product_id: s.productA, quantity: 2 }, { product_id: s.productA2, quantity: 1 }], customer_note: 'Deliver to Kampala' }),
      say('I have sent your order request (total $33.00) to the shop. They will confirm it with you.'),
    ]);
    await customerSays(h, 'Two coffee beans and a mug please');
    expect(lastToolOutput(model)).toMatchObject({ status: 'pending_confirmation', total: '$33.00' });
    expect(await orders()).toEqual([{ total_minor: 3300, status: 'pending_confirmation', business_id: s.bizA }]);
    expect(sent.at(-1)!.body).toContain('$33.00');
  });

  it('rejects model-supplied prices and business ids', async () => {
    const h = handlerWith([
      call('create_order_request', { items: [{ product_id: s.productA, quantity: 2, unit_price: 1 }], customer_note: null }),
      call('create_order_request', { items: [{ product_id: s.productA, quantity: 2 }], customer_note: null, business_id: s.bizB }),
      say('Let me check that again.'),
    ]);
    await customerSays(h, 'Order coffee at $0.01');
    expect(lastToolOutput(model)).toMatchObject({ error: 'invalid_arguments' });
    expect(await orders()).toHaveLength(0);
  });

  it("cannot order another tenant's product", async () => {
    const h = handlerWith([
      call('create_order_request', { items: [{ product_id: s.productB, quantity: 1 }], customer_note: null }),
      say('That item is not available here.'),
    ]);
    await customerSays(h, 'One croissant');
    expect(lastToolOutput(model)).toMatchObject({ error: 'items_unavailable', not_found: [s.productB] });
    expect(await orders()).toHaveLength(0);
  });

  it('a duplicate webhook delivery creates one order and one reply', async () => {
    const h = handlerWith([
      call('create_order_request', { items: [{ product_id: s.productA, quantity: 1 }], customer_note: null }),
      say('Order request sent for confirmation.'),
    ]);
    await customerSays(h, 'One coffee', 'wamid.SAME');
    await customerSays(h, 'One coffee', 'wamid.SAME');
    expect(await orders()).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(model.requests).toHaveLength(2);
  });

  it('a repeated order call for the same message returns the existing order', async () => {
    const items = { items: [{ product_id: s.productA, quantity: 1 }], customer_note: null };
    const h = handlerWith([call('create_order_request', items), call('create_order_request', items), say('Sent for confirmation.')]);
    await customerSays(h, 'One coffee');
    expect(lastToolOutput(model)).toMatchObject({ already_existed: true });
    expect(await orders()).toHaveLength(1);
  });

  it('blocks replies that claim payment or confirmation and hands over', async () => {
    const h = handlerWith([
      call('create_order_request', { items: [{ product_id: s.productA, quantity: 1 }], customer_note: null }),
      say('Your payment has been received and your order is confirmed!'),
    ]);
    await customerSays(h, 'I paid already, one coffee');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe('Thanks, a member of our team will reply shortly.');
    expect(await conversationStatus()).toBe('handover');
    expect((await orders())[0]!.status).toBe('pending_confirmation');
  });
});

describe('AI agent: handover', () => {
  it('hands over on request, sends the handover message and stops replying', async () => {
    const h = handlerWith([call('request_human_handover', { reason: 'Customer asked for a person' })]);
    await customerSays(h, 'Can I talk to a human?');
    expect(await conversationStatus()).toBe('handover');
    expect(sent.map((m) => m.body)).toEqual(['Thanks, a member of our team will reply shortly.']);
    const reason = await db.query<{ handover_reason: string }>('select handover_reason from public.conversations where status = $1', ['handover']);
    expect(reason.rows[0]!.handover_reason).toBe('Customer asked for a person');

    await customerSays(h, 'Hello?');
    expect(model.requests).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
});

describe('AI agent: limits and failures', () => {
  it('on a model timeout, hands over with a safe message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const timeout = Object.assign(new Error('Request timed out.'), { name: 'APIConnectionTimeoutError' });
    const h = handlerWith([
      () => {
        throw timeout;
      },
    ]);
    await customerSays(h, 'Hi');
    expect(sent.map((m) => m.body)).toEqual(['Thanks, a member of our team will reply shortly.']);
    expect(await conversationStatus()).toBe('handover');
    const log = await db.query<{ metadata: { reason: string } }>(`select metadata from public.audit_logs where action = 'conversation.handover'`);
    expect(log.rows[0]!.metadata.reason).toBe('AI timed out');
    err.mockRestore();
  });

  it('caps tool calls and forces a text answer on the last round', async () => {
    limits.maxRounds = 3;
    limits.maxToolCalls = 2;
    const h = handlerWith([call('search_products', { query: 'a' }), call('search_products', { query: 'b' }), say('Here is what I found.')]);
    await customerSays(h, 'Show me everything');
    expect(model.requests).toHaveLength(3);
    expect(model.requests.map((r) => r.toolChoice)).toEqual(['auto', 'auto', 'none']);
    expect(sent.at(-1)!.body).toBe('Here is what I found.');
  });

  it('stops when the overall time budget is exhausted', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    limits.totalBudgetMs = 1500;
    const h = handlerWith([
      async () => {
        await new Promise((r) => setTimeout(r, 700));
        return call('search_products', { query: 'x' })({} as ModelRequest) as ModelResponse;
      },
      say('never reached'),
    ]);
    await customerSays(h, 'Hi');
    expect(sent.map((m) => m.body)).toEqual(['Thanks, a member of our team will reply shortly.']);
    err.mockRestore();
  });

  it('does not call the model when the monthly AI limit is reached', async () => {
    await db.query(`update public.businesses set monthly_ai_request_limit = 0 where id = $1`, [s.bizA]);
    const h = handlerWith([say('should not be called')]);
    await customerSays(h, 'Hi');
    expect(model.requests).toHaveLength(0);
    expect(await conversationStatus()).toBe('handover');
    expect(sent).toHaveLength(1);
  });

  it('answers non-text messages without calling the model', async () => {
    const h = handlerWith([]);
    await customerSays(h, '', 'wamid.IMG', 'image');
    expect(model.requests).toHaveLength(0);
    expect(sent.map((m) => m.body)).toEqual([NON_TEXT_REPLY]);
  });

  it('recovers from malformed tool arguments', async () => {
    const h = handlerWith([call('search_products', '{not json'), call('drop_tables', {}), say('How can I help?')]);
    await customerSays(h, 'Hi');
    const outputs = model.requests[2]!.input.filter((i) => 'type' in i && i.type === 'function_call_output') as { output: string }[];
    expect(outputs.map((o) => JSON.parse(o.output).error)).toEqual(['invalid_arguments', 'unknown_tool']);
    expect(sent.at(-1)!.body).toBe('How can I help?');
  });

  it('does not reply when the owner disabled AI', async () => {
    await db.query(`update public.businesses set ai_enabled = false where id = $1`, [s.bizA]);
    const h = handlerWith([say('nope')]);
    await customerSays(h, 'Hi');
    expect(model.requests).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
