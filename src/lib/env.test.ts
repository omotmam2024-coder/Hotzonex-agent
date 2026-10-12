import { describe, expect, it } from 'vitest';
import { parseClientEnv } from './env';

const jwt = (payload: object) => `e30.${btoa(JSON.stringify(payload))}.sig`;

describe('parseClientEnv', () => {
  it('accepts a URL and publishable key', () => {
    const r = parseClientEnv({
      VITE_SUPABASE_URL: 'https://abcd.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc',
    });
    expect(r.ok).toBe(true);
  });

  it('reports missing variables', () => {
    const r = parseClientEnv({});
    expect(r).toEqual({
      ok: false,
      errors: ['VITE_SUPABASE_URL is required', 'VITE_SUPABASE_PUBLISHABLE_KEY is required'],
    });
  });

  it.each([['sb_secret_abc'], [jwt({ role: 'service_role' })]])('rejects server secret %#', (key) => {
    const r = parseClientEnv({ VITE_SUPABASE_URL: 'https://abcd.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: key });
    expect(r.ok).toBe(false);
  });

  it('accepts a legacy anon JWT', () => {
    const r = parseClientEnv({
      VITE_SUPABASE_URL: 'https://abcd.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon' }),
    });
    expect(r.ok).toBe(true);
  });
});
