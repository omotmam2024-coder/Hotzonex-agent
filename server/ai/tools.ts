import { z } from 'zod';
import { formatMinor } from './money.js';
import type { AiStore } from './store.js';

/**
 * The only three capabilities the model has. Each tool:
 *  - has a strict JSON schema sent to the model, and
 *  - re-validates the model's arguments with Zod (strict: unknown fields
 *    such as business_id or prices are rejected), then
 *  - runs with tenant/customer ids taken from trusted server context.
 */

export interface ToolContext {
  businessId: string;
  customerId: string;
  conversationId: string;
  currency: string;
  /** WhatsApp id of the inbound message; makes order creation idempotent. */
  sourceMessageId: string;
}

export type ToolOutcome =
  | { kind: 'result'; output: Record<string, unknown> }
  | { kind: 'handover'; reason: string; output: Record<string, unknown> };

const uuid = z.uuid('product_id must be an id returned by search_products');

export const toolArgs = {
  search_products: z.strictObject({
    query: z.string().trim().max(100).nullable(),
  }),
  create_order_request: z.strictObject({
    items: z
      .array(z.strictObject({ product_id: uuid, quantity: z.number().int().min(1).max(100) }))
      .min(1)
      .max(20),
    customer_note: z.string().trim().max(500).nullable(),
  }),
  request_human_handover: z.strictObject({
    reason: z.string().trim().min(1).max(300),
  }),
} as const;

export type ToolName = keyof typeof toolArgs;

/** Function tool definitions for the Responses API (strict mode). */
export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    name: 'search_products',
    description:
      'Search this business catalogue. Use it before mentioning any product, price or availability. ' +
      'Pass null to list a few items. Returns product ids, names, prices and availability.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: ['string', 'null'], description: 'Words to search for, e.g. "coffee beans". Null to list items.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'create_order_request',
    description:
      'Record an order request after the customer clearly agreed to the items and quantities. ' +
      'Only use product ids returned by search_products. The business must confirm it; it is not a confirmed order and no payment is taken.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'product_id from search_products' },
              quantity: { type: 'integer', minimum: 1, maximum: 100 },
            },
            required: ['product_id', 'quantity'],
            additionalProperties: false,
          },
        },
        customer_note: { type: ['string', 'null'], description: 'Delivery details or notes from the customer, or null.' },
      },
      required: ['items', 'customer_note'],
      additionalProperties: false,
    },
  },
  {
    type: 'function' as const,
    name: 'request_human_handover',
    description:
      'Hand the conversation to a person at the business. Use when the customer asks for a person, complains, ' +
      'asks about payment, refunds or delivery status, or when you cannot answer from the provided information.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Short reason for the team.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(toolArgs, name);
}

/**
 * Validates and executes one tool call. Never throws for bad model input:
 * returns an error result the model can read and recover from.
 */
export async function executeTool(store: AiStore, ctx: ToolContext, name: string, rawArgs: string): Promise<ToolOutcome> {
  if (!isToolName(name)) return error('unknown_tool', `There is no tool named ${name}.`);

  let json: unknown;
  try {
    json = JSON.parse(rawArgs);
  } catch {
    return error('invalid_arguments', 'Arguments were not valid JSON.');
  }
  const parsed = toolArgs[name].safeParse(json);
  if (!parsed.success) {
    return error('invalid_arguments', parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '));
  }

  switch (name) {
    case 'search_products': {
      const { query } = parsed.data as z.infer<typeof toolArgs.search_products>;
      const items = await store.searchProducts(ctx.businessId, query || null, 5);
      return {
        kind: 'result',
        output: {
          products: items.map((p) => ({
            product_id: p.product_id,
            name: p.name,
            kind: p.kind,
            description: p.description,
            category: p.category,
            price: formatMinor(p.price_minor, ctx.currency),
            available: p.available,
          })),
          note: items.length === 0 ? 'No matching products. Do not invent any.' : 'Prices are from the catalogue; quote them exactly.',
        },
      };
    }
    case 'create_order_request': {
      const args = parsed.data as z.infer<typeof toolArgs.create_order_request>;
      const result = await store.createOrderRequest({
        businessId: ctx.businessId,
        customerId: ctx.customerId,
        conversationId: ctx.conversationId,
        idempotencyKey: `wa:${ctx.sourceMessageId}`,
        items: args.items,
        note: args.customer_note,
      });
      if (!result.ok) {
        if (result.error === 'items_unavailable') {
          return error(
            'items_unavailable',
            'Some items cannot be ordered. Tell the customer which ones and offer alternatives from search_products.',
            { not_found: result.not_found, unavailable: result.unavailable, insufficient_stock: result.insufficient_stock },
          );
        }
        return error(result.error, 'Orders cannot be taken right now. Offer to hand over to a person.');
      }
      const o = result.order;
      return {
        kind: 'result',
        output: {
          order_reference: o.id.slice(0, 8).toUpperCase(),
          status: 'pending_confirmation',
          already_existed: !result.created,
          items: o.items.map((i) => ({
            name: i.product_name,
            quantity: i.quantity,
            unit_price: formatMinor(i.unit_price_minor, o.currency),
            line_total: formatMinor(i.line_total_minor, o.currency),
          })),
          total: formatMinor(o.total_minor, o.currency),
          instructions:
            'Tell the customer the request was sent to the business for confirmation, with this total. ' +
            'It is NOT confirmed, NOT paid and NOT shipped. Do not ask for or accept payment.',
        },
      };
    }
    case 'request_human_handover': {
      const { reason } = parsed.data as z.infer<typeof toolArgs.request_human_handover>;
      await store.requestHandover(ctx.businessId, ctx.conversationId, reason, 'ai');
      return { kind: 'handover', reason, output: { ok: true } };
    }
  }
}

function error(code: string, message: string, details?: Record<string, unknown>): ToolOutcome {
  return { kind: 'result', output: { error: code, message, ...(details ?? {}) } };
}
