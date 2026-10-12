import { describe, expect, it } from 'vitest';
import { TOOL_DEFINITIONS, toolArgs } from './tools.js';

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: unknown; items?: Schema };

function assertStrict(schema: Schema, path: string) {
  if (schema.properties) {
    expect(schema.additionalProperties, `${path} additionalProperties`).toBe(false);
    expect([...(schema.required ?? [])].sort(), `${path} required`).toEqual(Object.keys(schema.properties).sort());
    for (const [k, v] of Object.entries(schema.properties)) assertStrict(v, `${path}.${k}`);
  }
  if (schema.items) assertStrict(schema.items, `${path}[]`);
}

describe('tool definitions', () => {
  it('exposes exactly the three allowed tools', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(['create_order_request', 'request_human_handover', 'search_products']);
    expect(Object.keys(toolArgs).sort()).toEqual(TOOL_DEFINITIONS.map((t) => t.name).sort());
  });

  it.each(TOOL_DEFINITIONS.map((t) => [t.name, t] as const))('%s schema satisfies strict mode', (_n, tool) => {
    expect(tool.strict).toBe(true);
    assertStrict(tool.parameters as unknown as Schema, tool.name);
  });

  it('no tool accepts a business, customer or price from the model', () => {
    const text = JSON.stringify(TOOL_DEFINITIONS.map((t) => t.parameters));
    expect(text).not.toMatch(/business|customer_id|price|total|sql|url/i);
  });
});

describe('tool argument validation', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  it('rejects injected fields', () => {
    expect(toolArgs.create_order_request.safeParse({ items: [{ product_id: id, quantity: 1 }], customer_note: null, business_id: id }).success).toBe(false);
    expect(
      toolArgs.create_order_request.safeParse({ items: [{ product_id: id, quantity: 1, unit_price: 1 }], customer_note: null }).success,
    ).toBe(false);
  });

  it.each([
    [{ items: [], customer_note: null }],
    [{ items: [{ product_id: 'coffee', quantity: 1 }], customer_note: null }],
    [{ items: [{ product_id: id, quantity: 0 }], customer_note: null }],
    [{ items: [{ product_id: id, quantity: 1.5 }], customer_note: null }],
    [{ items: [{ product_id: id, quantity: 101 }], customer_note: null }],
    [{ items: Array.from({ length: 21 }, () => ({ product_id: id, quantity: 1 })), customer_note: null }],
  ])('rejects invalid order arguments %#', (args) => {
    expect(toolArgs.create_order_request.safeParse(args).success).toBe(false);
  });

  it('bounds search queries and handover reasons', () => {
    expect(toolArgs.search_products.safeParse({ query: 'x'.repeat(101) }).success).toBe(false);
    expect(toolArgs.request_human_handover.safeParse({ reason: '' }).success).toBe(false);
  });
});
