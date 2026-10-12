import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import type { ConversationDetail, CustomerRow, OrderRow, Overview } from '../lib/types';
import { FakeApi, FakeAuth, renderApp } from '../test/fakes';

const BIZ = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const ORDER = '44444444-4444-4444-8444-444444444444';
const signedIn = () => new FakeAuth({ accessToken: 't', email: 'o@example.com' });

function baseApi(role: 'owner' | 'agent' = 'owner', routes: Record<string, (b: unknown) => unknown> = {}) {
  return new FakeApi({
    'GET /api/me': () => ({ user: { id: 'u', email: 'o@example.com' }, memberships: [{ business_id: BIZ, business_name: 'Shop A', role }] }),
    ...routes,
  });
}

const overview: Overview = {
  conversations_open: 3,
  conversations_handover: 2,
  orders_pending: 1,
  orders_confirmed_this_month: 4,
  leads_new: 5,
  customers_total: 9,
  messages_in_this_month: 40,
  messages_out_this_month: 1900,
  ai_requests_this_month: 120,
  ai_tokens_this_month: 50000,
  monthly_ai_request_limit: 2000,
  monthly_outbound_message_limit: 2000,
  whatsapp_connected: false,
  ai_enabled: true,
  recent_errors: [{ action: 'whatsapp.send_failed', created_at: '2026-10-12T10:00:00Z' }],
};

afterEach(() => vi.restoreAllMocks());

describe('overview page', () => {
  it('shows stats, usage meters, setup notices and recent problems', async () => {
    renderApp('/overview', signedIn(), baseApi('owner', { 'GET /api/overview': () => ({ overview }) }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('Need a person').previousSibling).toHaveTextContent('2');
    expect(screen.getByText(/No WhatsApp number is connected/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Messages sent' })).toHaveAttribute('aria-valuenow', '1900');
    expect(screen.getByText(/whatsapp.send_failed/)).toBeInTheDocument();
  });

  it('shows an error state with retry', async () => {
    const api = baseApi('owner', {
      'GET /api/overview': () => {
        throw new ApiError(503, 'service_unavailable', 'Service is not configured');
      },
    });
    renderApp('/overview', signedIn(), api);
    expect(await screen.findByText('Service is not configured')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('is the default page after sign-in', async () => {
    renderApp('/', signedIn(), baseApi('owner', { 'GET /api/overview': () => ({ overview }) }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });
});

describe('conversations', () => {
  const detail = (over: Partial<ConversationDetail> = {}): ConversationDetail => ({
    id: CONV,
    status: 'open',
    handover_reason: null,
    customer: { id: 'c', name: 'Ann', wa_id: '15550001111', last_message_at: '2026-10-12T10:00:00Z' },
    can_reply: true,
    messages: [
      { id: 'm1', direction: 'inbound', sender: 'customer', body: 'Do you deliver?', status: 'received', error_code: null, created_at: '2026-10-12T10:00:00Z' },
      { id: 'm2', direction: 'outbound', sender: 'ai', body: 'Yes, in Kampala.', status: 'read', error_code: null, created_at: '2026-10-12T10:01:00Z' },
    ],
    orders: [],
    ...over,
  });

  it('lists conversations and filters by status', async () => {
    const api = baseApi('owner', {
      'GET /api/conversations': () => ({
        conversations: [
          { id: CONV, status: 'handover', handover_reason: 'asked for a person', last_message_at: '2026-10-12T10:00:00Z', customer: { id: 'c', name: 'Ann', wa_id: '15550001111' }, last_message: { body: 'Hello?', direction: 'inbound', sender: 'customer' } },
        ],
      }),
    });
    const user = userEvent.setup();
    renderApp('/conversations', signedIn(), api);
    expect(await screen.findByText('Ann (+15550001111)')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Need a person' }));
    await waitFor(() => expect(api.calls.at(-1)!.path).toBe(`/api/conversations?business_id=${BIZ}&status=handover`));
  });

  it('shows an empty state', async () => {
    renderApp('/conversations', signedIn(), baseApi('owner', { 'GET /api/conversations': () => ({ conversations: [] }) }));
    expect(await screen.findByText('No conversations here')).toBeInTheDocument();
  });

  it('shows the chat and sends a team reply', async () => {
    const api = baseApi('owner', {
      'GET /api/conversations': () => ({ conversation: detail() }),
      'POST /api/conversations': () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp(`/conversations/${CONV}`, signedIn(), api);
    const chat = await screen.findByRole('list', { name: 'Messages' });
    expect(within(chat).getByText('Do you deliver?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Type a message first.');
    await user.type(screen.getByLabelText('Reply as your team'), 'We deliver tomorrow.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ body: 'We deliver tomorrow.' });
  });

  it('disables replies outside the 24-hour window', async () => {
    renderApp(`/conversations/${CONV}`, signedIn(), baseApi('owner', { 'GET /api/conversations': () => ({ conversation: detail({ can_reply: false }) }) }));
    expect(await screen.findByText(/only allows replies within 24 hours/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('takes over and resumes the AI', async () => {
    const api = baseApi('owner', {
      'GET /api/conversations': () => ({ conversation: detail() }),
      'PATCH /api/conversations': () => ({ ok: true }),
    });
    const user = userEvent.setup();
    renderApp(`/conversations/${CONV}`, signedIn(), api);
    await user.click(await screen.findByRole('button', { name: 'Take over (pause AI)' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ status: 'handover' }));
  });
});

describe('orders', () => {
  const order: OrderRow = {
    id: ORDER,
    status: 'pending_confirmation',
    payment_status: 'unpaid',
    currency: 'USD',
    total_minor: 2500,
    customer_note: 'Deliver at 5pm',
    conversation_id: CONV,
    created_at: '2026-10-12T10:00:00Z',
    customer: { id: 'c', name: 'Ann', wa_id: '15550001111' },
    items: [{ product_name: 'Coffee beans', quantity: 2, unit_price_minor: 1250, line_total_minor: 2500 }],
  };

  it('lists pending orders by default and confirms one', async () => {
    const api = baseApi('owner', { 'GET /api/orders': () => ({ orders: [order] }), 'PATCH /api/orders': () => ({ ok: true }) });
    const user = userEvent.setup();
    renderApp('/orders', signedIn(), api);
    expect(await screen.findByText('Total: $25.00')).toBeInTheDocument();
    expect(api.calls.find((c) => c.path.startsWith('/api/orders'))!.path).toContain('status=pending_confirmation');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/api/orders?business_id=${BIZ}&id=${ORDER}`, body: { status: 'confirmed' } }));
  });

  it('asks before marking an order paid', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = baseApi('owner', { 'GET /api/orders': () => ({ orders: [{ ...order, status: 'confirmed' }] }) });
    const user = userEvent.setup();
    renderApp('/orders?status=confirmed', signedIn(), api);
    await user.click(await screen.findByRole('button', { name: 'Mark paid' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/verified the payment/));
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows server errors such as insufficient stock', async () => {
    const api = baseApi('owner', {
      'GET /api/orders': () => ({ orders: [order] }),
      'PATCH /api/orders': () => {
        throw new ApiError(409, 'insufficient_stock', 'Not enough stock to confirm this order');
      },
    });
    const user = userEvent.setup();
    renderApp('/orders', signedIn(), api);
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough stock');
  });

  it('agents see orders read-only', async () => {
    renderApp('/orders', signedIn(), baseApi('agent', { 'GET /api/orders': () => ({ orders: [order] }) }));
    expect(await screen.findByText('Total: $25.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  });
});

describe('customers', () => {
  const customers: CustomerRow[] = [
    { id: 'c', name: 'Ann', wa_id: '15550001111', last_message_at: null, orders_count: 2, lead: { id: 'l1', status: 'new', notes: '' } },
  ];

  it('lists customers and updates a lead status', async () => {
    const api = baseApi('owner', { 'GET /api/customers': () => ({ customers }), 'PATCH /api/customers': () => ({ ok: true }) });
    const user = userEvent.setup();
    renderApp('/customers', signedIn(), api);
    const select = await screen.findByLabelText('Lead status for Ann (+15550001111)');
    await user.selectOptions(select, 'qualified');
    await waitFor(() =>
      expect(api.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/api/customers?business_id=${BIZ}&lead_id=l1`, body: { status: 'qualified' } }),
    );
    expect(select).toHaveValue('qualified');
  });

  it('shows an empty state', async () => {
    renderApp('/customers', signedIn(), baseApi('owner', { 'GET /api/customers': () => ({ customers: [] }) }));
    expect(await screen.findByText('No customers yet')).toBeInTheDocument();
  });
});
