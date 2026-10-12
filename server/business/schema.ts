import { z } from 'zod';

export const businessQuerySchema = z.object({
  business_id: z.uuid('business_id must be a UUID'),
});

/** Fields owners/admins may edit. Limits, status and currency are operator-controlled. */
export const businessPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1, 'Name is required').max(120),
    description: z.string().trim().max(2000),
    ai_knowledge: z.string().trim().max(8000),
    ai_enabled: z.boolean(),
    handover_message: z.string().trim().min(1).max(1000),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(isValidTimeZone, 'Unknown time zone'),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Provide at least one field to update');

export type BusinessPatch = z.infer<typeof businessPatchSchema>;

export interface Business {
  id: string;
  name: string;
  description: string;
  ai_knowledge: string;
  ai_enabled: boolean;
  handover_message: string;
  currency: string;
  timezone: string;
  status: 'active' | 'suspended';
  monthly_ai_request_limit: number;
  monthly_outbound_message_limit: number;
  created_at: string;
  updated_at: string;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
