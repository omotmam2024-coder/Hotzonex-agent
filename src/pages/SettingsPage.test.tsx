import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { FakeApi, FakeAuth, renderApp } from '../test/fakes';

const BIZ = '11111111-1111-4111-8111-111111111111';
const business = {
  id: BIZ,
  name: 'Shop A',
  description: '',
  ai_knowledge: 'Open 9-5',
  ai_enabled: true,
  handover_message: 'A person will reply soon.',
  currency: 'UGX',
  timezone: 'Africa/Kampala',
  status: 'active',
  monthly_ai_request_limit: 2000,
  monthly_outbound_message_limit: 1500,
};

function fakeApi(role: 'owner' | 'agent') {
  return new FakeApi({
    'GET /api/me': () => ({ user: { id: 'u', email: 'o@example.com' }, memberships: [{ business_id: BIZ, business_name: 'Shop A', role }] }),
    'GET /api/business': () => ({ business, role }),
    'PATCH /api/business': (body) => ({ business: { ...business, ...(body as object) }, role }),
  });
}

beforeEach(() => {
  // System status card calls /api/health with fetch.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
});

describe('settings page', () => {
  it('loads settings and shows operator-controlled limits as read-only facts', async () => {
    renderApp('/settings', new FakeAuth({ accessToken: 't', email: null }), fakeApi('owner'));
    expect(await screen.findByDisplayValue('Open 9-5')).toBeInTheDocument();
    expect(screen.getByText('1500')).toBeInTheDocument();
    expect(screen.getByText('UGX')).toBeInTheDocument();
  });

  it('saves only editable fields', async () => {
    const api = fakeApi('owner');
    const user = userEvent.setup();
    renderApp('/settings', new FakeAuth({ accessToken: 't', email: null }), api);
    const desc = await screen.findByLabelText('Description');
    await user.type(desc, 'Fresh coffee');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeInTheDocument();
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(Object.keys(patch.body as object).sort()).toEqual(
      ['ai_enabled', 'ai_knowledge', 'description', 'handover_message', 'name', 'timezone'].sort(),
    );
  });

  it('validates required fields before saving', async () => {
    const api = fakeApi('owner');
    const user = userEvent.setup();
    renderApp('/settings', new FakeAuth({ accessToken: 't', email: null }), api);
    await user.clear(await screen.findByLabelText('Business name'));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('shows server validation errors next to the field', async () => {
    const api = fakeApi('owner');
    api.routes['PATCH /api/business'] = () => {
      throw new ApiError(400, 'validation_failed', 'Some fields are invalid', [{ path: 'timezone', message: 'Unknown time zone' }]);
    };
    const user = userEvent.setup();
    renderApp('/settings', new FakeAuth({ accessToken: 't', email: null }), api);
    await user.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Unknown time zone')).toBeInTheDocument();
  });

  it('agents see a disabled form', async () => {
    renderApp('/settings', new FakeAuth({ accessToken: 't', email: null }), fakeApi('agent'));
    await waitFor(() => expect(screen.getByLabelText('Business name')).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });
});
