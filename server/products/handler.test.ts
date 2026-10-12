import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, apiRequest, body, memoryDeps } from '../testing/memory-store.js';
import { createProductsHandler } from './handler.js';

let store: MemoryStore;
let handler: ReturnType<typeof createProductsHandler>;
let bizA: string;
let bizB: string;

beforeEach(() => {
  store = new MemoryStore();
  bizA = store.addBusiness('Shop A', 'alice');
  bizB = store.addBusiness('Shop B', 'bob');
  store.memberships.push({ business_id: bizA, business_name: 'Shop A', role: 'agent', user_id: 'agent' });
  handler = createProductsHandler(memoryDeps(store));
});

const create = (user: string, business: string, body: unknown) =>
  handler(apiRequest(`/api/products?business_id=${business}`, { method: 'POST', user, body }));

describe('authentication', () => {
  it('rejects requests without a token', async () => {
    const res = await handler(apiRequest(`/api/products?business_id=${bizA}`));
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe('unauthorized');
  });

  it('rejects malformed tokens', async () => {
    const res = await handler(apiRequest(`/api/products?business_id=${bizA}`, { headers: { authorization: 'Basic abc' } }));
    expect(res.status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('returns 404 for a business the user is not a member of', async () => {
    await create('bob', bizB, { name: 'Croissant', price_minor: 300 });
    const res = await handler(apiRequest(`/api/products?business_id=${bizB}`, { user: 'alice' }));
    expect(res.status).toBe(404);
  });

  it('cannot create, update or delete in another business', async () => {
    const created = await body(await create('bob', bizB, { name: 'Croissant', price_minor: 300 }));
    expect((await create('alice', bizB, { name: 'X', price_minor: 1 })).status).toBe(404);

    const id = created.product.id;
    const patch = await handler(
      apiRequest(`/api/products?business_id=${bizB}&id=${id}`, { method: 'PATCH', user: 'alice', body: { price_minor: 1 } }),
    );
    expect(patch.status).toBe(404);
    // Using own business id with another tenant's product id also fails.
    const cross = await handler(
      apiRequest(`/api/products?business_id=${bizA}&id=${id}`, { method: 'PATCH', user: 'alice', body: { price_minor: 1 } }),
    );
    expect(cross.status).toBe(404);
    const del = await handler(apiRequest(`/api/products?business_id=${bizA}&id=${id}`, { method: 'DELETE', user: 'alice' }));
    expect(del.status).toBe(404);
    expect(store.products.get(id)!.price_minor).toBe(300);
  });

  it('ignores business_id inside the body', async () => {
    const res = await create('alice', bizA, { name: 'Mug', price_minor: 800, business_id: bizB });
    expect(res.status).toBe(400);
    expect([...store.products.values()].every((p) => p.business_id !== bizB)).toBe(true);
  });

  it('agents can read but not write', async () => {
    expect((await handler(apiRequest(`/api/products?business_id=${bizA}`, { user: 'agent' }))).status).toBe(200);
    const res = await create('agent', bizA, { name: 'Mug', price_minor: 800 });
    expect(res.status).toBe(403);
  });
});

describe('CRUD', () => {
  it('creates with defaults, lists, searches, updates and deletes', async () => {
    const res = await create('alice', bizA, { name: '  Coffee beans ', price_minor: 1250, stock_quantity: 10 });
    expect(res.status).toBe(201);
    const { product } = await body(res);
    expect(product).toMatchObject({ name: 'Coffee beans', kind: 'product', is_available: true, sku: null });

    await create('alice', bizA, { name: 'Mug', price_minor: 800 });
    const search = await body(await handler(apiRequest(`/api/products?business_id=${bizA}&q=coff`, { user: 'alice' })));
    expect(search.products.map((p: { name: string }) => p.name)).toEqual(['Coffee beans']);

    const upd = await handler(
      apiRequest(`/api/products?business_id=${bizA}&id=${product.id}`, {
        method: 'PATCH',
        user: 'alice',
        body: { price_minor: 1300, is_available: false },
      }),
    );
    expect((await body(upd)).product).toMatchObject({ price_minor: 1300, is_available: false });

    const del = await handler(apiRequest(`/api/products?business_id=${bizA}&id=${product.id}`, { method: 'DELETE', user: 'alice' }));
    expect(await body(del)).toEqual({ result: 'deleted' });
  });

  it('archives instead of deleting products that appear in orders', async () => {
    const { product } = await body(await create('alice', bizA, { name: 'Mug', price_minor: 800 }));
    store.referenced.add(product.id);
    const del = await handler(apiRequest(`/api/products?business_id=${bizA}&id=${product.id}`, { method: 'DELETE', user: 'alice' }));
    expect(await body(del)).toEqual({ result: 'archived' });
    const list = await body(await handler(apiRequest(`/api/products?business_id=${bizA}`, { user: 'alice' })));
    expect(list.products).toHaveLength(0);
  });

  it('returns 409 for a duplicate SKU', async () => {
    await create('alice', bizA, { name: 'A', price_minor: 1, sku: 'SKU-1' });
    const res = await create('alice', bizA, { name: 'B', price_minor: 1, sku: 'SKU-1' });
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe('sku_taken');
  });
});

describe('validation', () => {
  it.each([
    ['negative price', { name: 'X', price_minor: -1 }],
    ['fractional price', { name: 'X', price_minor: 12.5 }],
    ['price as string', { name: 'X', price_minor: '100' }],
    ['blank name', { name: '   ', price_minor: 1 }],
    ['unknown field', { name: 'X', price_minor: 1, owner: 'me' }],
    ['negative stock', { name: 'X', price_minor: 1, stock_quantity: -2 }],
  ])('rejects %s with field errors', async (_label, input) => {
    const res = await create('alice', bizA, input);
    expect(res.status).toBe(400);
    const json = await body(res);
    expect(json.error.code).toBe('validation_failed');
    expect(Array.isArray(json.error.details)).toBe(true);
  });

  it('rejects malformed JSON, wrong content type and bad ids', async () => {
    const bad = await handler(
      apiRequest(`/api/products?business_id=${bizA}`, { method: 'POST', user: 'alice', body: '{"name":' }),
    );
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe('invalid_json');

    const type = await handler(
      apiRequest(`/api/products?business_id=${bizA}`, {
        method: 'POST',
        user: 'alice',
        body: 'name=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(type.status).toBe(415);

    const id = await handler(apiRequest(`/api/products?business_id=not-a-uuid`, { user: 'alice' }));
    expect(id.status).toBe(400);
  });

  it('rejects oversized bodies', async () => {
    const res = await create('alice', bizA, { name: 'X', price_minor: 1, description: 'a'.repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it('rejects an empty patch', async () => {
    const { product } = await body(await create('alice', bizA, { name: 'Mug', price_minor: 800 }));
    const res = await handler(
      apiRequest(`/api/products?business_id=${bizA}&id=${product.id}`, { method: 'PATCH', user: 'alice', body: {} }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 405 for unsupported methods', async () => {
    const res = await handler(apiRequest(`/api/products?business_id=${bizA}`, { method: 'PUT', user: 'alice' }));
    expect(res.status).toBe(405);
  });
});
