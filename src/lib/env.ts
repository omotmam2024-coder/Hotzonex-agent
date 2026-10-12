import { z } from 'zod';

/**
 * Browser configuration. Everything here is public: it ships in the bundle.
 * Only the Supabase URL and publishable key belong here.
 */
const clientEnvSchema = z.object({
  VITE_SUPABASE_URL: z
    .string({ error: 'VITE_SUPABASE_URL is required' })
    .trim()
    .min(1, 'VITE_SUPABASE_URL is required')
    .refine((v) => /^https?:\/\/[^\s]+$/.test(v), 'VITE_SUPABASE_URL must be an http(s) URL'),
  VITE_SUPABASE_PUBLISHABLE_KEY: z
    .string({ error: 'VITE_SUPABASE_PUBLISHABLE_KEY is required' })
    .trim()
    .min(1, 'VITE_SUPABASE_PUBLISHABLE_KEY is required')
    .refine((v) => !v.startsWith('sb_secret_'), 'VITE_SUPABASE_PUBLISHABLE_KEY is a secret key; use the publishable key')
    .refine((v) => !isServiceRoleJwt(v), 'VITE_SUPABASE_PUBLISHABLE_KEY is a service_role key; use the publishable key'),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

export type ClientEnvResult = { ok: true; env: ClientEnv } | { ok: false; errors: string[] };

export function parseClientEnv(source: Record<string, unknown>): ClientEnvResult {
  const result = clientEnvSchema.safeParse(source);
  if (result.success) return { ok: true, env: result.data };
  return { ok: false, errors: result.error.issues.map((i) => i.message) };
}

function isServiceRoleJwt(value: string): boolean {
  const payload = value.split('.')[1];
  if (!payload) return false;
  try {
    const decoded: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof decoded === 'object' && decoded !== null && (decoded as { role?: unknown }).role === 'service_role';
  } catch {
    return false;
  }
}

export const clientEnv: ClientEnvResult = parseClientEnv(import.meta.env);
