import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from './App';
import { ApiError } from './lib/api';
import type { Business, Me, Product } from './lib/types';
import { FakeApi, FakeAuth, renderApp } from './test/fakes';

const BIZ = '11111111-1111-4111-8111-111111111111';

const me = (role: 'owner' | 'agent' = 'owner'): Me => ({
  user: { id: 'u1', email: 'owner@example.com' },
  memberships: [{ business_id: BIZ, business_name: 'Shop A', role }],
});

const business: Business = {
  id: BIZ,
  name: 'Shop A',
  description: '',
  ai_knowledge: '',
  ai_enabled: true,
  handover_message: 'A person will reply soon.',
  currency: 'USD',
  timezone: 'UTC',
  status: 'active',
  monthly_ai_request_limit: 2000,
  monthly_outbound_message_limit: 2000,
};

const product: Product = {
  id: '22222222-2222-4222-8222-222222222222',
  business_id: BIZ,
  name: 'Coffee beans',
  description: '',
  sku: null,
  category: null,
  kind: 'product',
  price_minor: 1250,
  is_available: true,
  stock_quantity: 10,
  archived_at: null,
};

function api(products: Product[] = [product], role: 'owner' | 'agent' = 'owner') {
  return new FakeApi({
    'GET /api/me': () => me(role),
    'GET /api/business': () => ({ business, role }),
    'GET /api/products': () => ({ products }),
  });
}

const signedIn = () => new FakeAuth({ accessToken: 'token', email: 'owner@example.com' });

describe('configuration', () => {
  it('shows a configuration error state when browser env is invalid', () => {
    render(
      <MemoryRouter>
        <App env={{ ok: false, errors: ['VITE_SUPABASE_URL is required'] }} services={null} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Configuration required');
    expect(screen.getByText('VITE_SUPABASE_URL is required')).toBeInTheDocument();
  });
});

describe('authentication', () => {
  it('redirects signed-out users to the login page and loads no data', async () => {
    const fake = api();
    renderApp('/products', new FakeAuth(), fake);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(fake.calls).toHaveLength(0);
  });

  it('validates the email and shows sign-in errors', async () => {
    const user = userEvent.setup();
    renderApp('/login', new FakeAuth(), api());
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('alert')).toHaveTextContent('valid email');

    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('incorrect');
  });

  it('signs in and lands on the products page', async () => {
    const user = userEvent.setup();
    renderApp('/login', new FakeAuth(), api());
    await user.type(await screen.findByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: /Products/ })).toBeInTheDocument();
    expect(await screen.findByText('Coffee beans')).toBeInTheDocument();
  });

  it('signing out returns to the login page', async () => {
    const user = userEvent.setup();
    renderApp('/products', signedIn(), api());
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows an empty state for users without a business', async () => {
    const fake = new FakeApi({ 'GET /api/me': () => ({ user: { id: 'u', email: null }, memberships: [] }) });
    renderApp('/products', signedIn(), fake);
    expect(await screen.findByText('No business is linked to this account yet')).toBeInTheDocument();
  });
});

describe('products page', () => {
  it('lists products with formatted prices', async () => {
    renderApp('/products', signedIn(), api());
    expect(await screen.findByText('Coffee beans')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
  });

  it('shows an empty state', async () => {
    renderApp('/products', signedIn(), api([]));
    expect(await screen.findByText('No products yet')).toBeInTheDocument();
  });

  it('shows an error state and retries', async () => {
    let fail = true;
    const fake = api();
    fake.routes['GET /api/products'] = () => {
      if (fail) throw new ApiError(500, 'internal_error', 'Something went wrong');
      return { products: [product] };
    };
    const user = userEvent.setup();
    renderApp('/products', signedIn(), fake);
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Coffee beans')).toBeInTheDocument();
  });

  it('agents get a read-only view', async () => {
    renderApp('/products', signedIn(), api([product], 'agent'));
    expect(await screen.findByText('Coffee beans')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add product' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByText(/read-only access/)).toBeInTheDocument();
  });

  it('validates the form and sends prices as integer minor units', async () => {
    const fake = api([]);
    fake.routes['POST /api/products'] = (body) => ({ product: { ...product, ...(body as object) } });
    const user = userEvent.setup();
    renderApp('/products', signedIn(), fake);

    await user.click(await screen.findByRole('button', { name: 'Add product' }));
    await user.type(screen.getByLabelText('Price (USD)'), '12.345');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText(/Enter a price like/)).toBeInTheDocument();
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText('Name'), 'Mug');
    await user.clear(screen.getByLabelText('Price (USD)'));
    await user.type(screen.getByLabelText('Price (USD)'), '8.5');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fake.calls.some((c) => c.method === 'POST')).toBe(true));
    const post = fake.calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe(`/api/products?business_id=${BIZ}`);
    expect(post.body).toMatchObject({ name: 'Mug', price_minor: 850, stock_quantity: null });
  });

  it('shows server field errors', async () => {
    const fake = api([]);
    fake.routes['POST /api/products'] = () => {
      throw new ApiError(400, 'validation_failed', 'Some fields are invalid', [
        { path: 'name', message: 'Must be at most 200 characters' },
      ]);
    };
    const user = userEvent.setup();
    renderApp('/products', signedIn(), fake);
    await user.click(await screen.findByRole('button', { name: 'Add product' }));
    await user.type(screen.getByLabelText('Name'), 'Mug');
    await user.type(screen.getByLabelText('Price (USD)'), '1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Must be at most 200 characters')).toBeInTheDocument();
  });
});
