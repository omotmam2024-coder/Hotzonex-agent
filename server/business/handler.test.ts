import { beforeEach, describe, expect, it } from 'vitest';
import { createMeHandler } from '../me/handler.js';
import { MemoryStore, apiRequest, body, memoryDeps } from '../testing/memory-store.js';
import { createBusinessHandler } from './handler.js';

let store: MemoryStore;
let bizA: string;
let bizB: string;

beforeEach(() => {
  store = new MemoryStore();
  bizA = store.addBusiness('Shop A', 'alice');
  bizB = store.addBusiness('Shop B', 'bob');
  store.memberships.push({ business_id: bizA, business_name: 'Shop A', role: 'agent', user_id: 'agent' });
});

describe('/api/business', () => {
  const handler = () => createBusinessHandler(memoryDeps(store));

  it('requires authentication', async () => {
    expect((await handler()(apiRequest(`/api/business?business_id=${bizA}`))).status).toBe(401);
  });

  it('returns the business and the caller role', async () => {
    const res = await handler()(apiRequest(`/api/business?business_id=${bizA}`, { user: 'alice' }));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ business: { id: bizA, name: 'Shop A' }, role: 'owner' });
  });

  it('hides other businesses', async () => {
    const res = await handler()(apiRequest(`/api/business?business_id=${bizB}`, { user: 'alice' }));
    expect(res.status).toBe(404);
  });

  it('owners update profile fields', async () => {
    const res = await handler()(
      apiRequest(`/api/business?business_id=${bizA}`, {
        method: 'PATCH',
        user: 'alice',
        body: { description: 'Fresh coffee', timezone: 'Africa/Kampala' },
      }),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).business).toMatchObject({ description: 'Fresh coffee', timezone: 'Africa/Kampala' });
  });

  it.each([
    ['usage limits', { monthly_ai_request_limit: 1_000_000 }],
    ['status', { status: 'active' }],
    ['currency', { currency: 'EUR' }],
    ['invalid time zone', { timezone: 'Mars/Base' }],
  ])('rejects changes to %s', async (_label, body) => {
    const res = await handler()(apiRequest(`/api/business?business_id=${bizA}`, { method: 'PATCH', user: 'alice', body }));
    expect(res.status).toBe(400);
  });

  it('agents cannot edit settings', async () => {
    const res = await handler()(
      apiRequest(`/api/business?business_id=${bizA}`, { method: 'PATCH', user: 'agent', body: { name: 'Hacked' } }),
    );
    expect(res.status).toBe(403);
    expect(store.businesses.get(bizA)!.name).toBe('Shop A');
  });
});

describe('/api/me', () => {
  it('requires authentication', async () => {
    expect((await createMeHandler(memoryDeps(store))(apiRequest('/api/me'))).status).toBe(401);
  });

  it('lists only the caller memberships', async () => {
    const res = await createMeHandler(memoryDeps(store))(apiRequest('/api/me', { user: 'alice' }));
    const json = await body(res);
    expect(json.user.id).toBe('alice');
    expect(json.memberships).toEqual([{ business_id: bizA, business_name: 'Shop A', role: 'owner' }]);
  });
});
