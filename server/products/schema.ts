import { z } from 'zod';

export const MAX_PRICE_MINOR = 100_000_000_000;

const trimmed = (max: number) => z.string().trim().max(max, `Must be at most ${max} characters`);

export const productInputSchema = z.strictObject({
  name: trimmed(200).min(1, 'Name is required'),
  description: trimmed(2000).default(''),
  sku: trimmed(64).min(1).nullable().default(null),
  category: trimmed(80).nullable().default(null),
  kind: z.enum(['product', 'service']).default('product'),
  price_minor: z
    .number({ error: 'Price is required' })
    .int('Price must be a whole number of minor units')
    .min(0, 'Price cannot be negative')
    .max(MAX_PRICE_MINOR, 'Price is too large'),
  is_available: z.boolean().default(true),
  stock_quantity: z.number().int().min(0, 'Stock cannot be negative').max(1_000_000_000).nullable().default(null),
});

export type ProductInput = z.infer<typeof productInputSchema>;

/** Partial update; business_id and id can never be set through the API. */
export const productPatchSchema = z
  .strictObject({
    name: productInputSchema.shape.name,
    description: trimmed(2000),
    sku: trimmed(64).min(1).nullable(),
    category: trimmed(80).nullable(),
    kind: z.enum(['product', 'service']),
    price_minor: productInputSchema.shape.price_minor,
    is_available: z.boolean(),
    stock_quantity: z.number().int().min(0).max(1_000_000_000).nullable(),
    archived: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type ProductPatch = z.infer<typeof productPatchSchema>;

export const productListQuerySchema = z.object({
  business_id: z.uuid('business_id must be a UUID'),
  q: z.string().trim().max(100).optional(),
  include_archived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const productIdQuerySchema = z.object({
  business_id: z.uuid('business_id must be a UUID'),
  id: z.uuid('id must be a UUID'),
});

export interface Product {
  id: string;
  business_id: string;
  name: string;
  description: string;
  sku: string | null;
  category: string | null;
  kind: 'product' | 'service';
  price_minor: number;
  is_available: boolean;
  stock_quantity: number | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
