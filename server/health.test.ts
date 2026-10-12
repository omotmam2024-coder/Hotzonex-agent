import { describe, expect, it, vi } from 'vitest';
import { handleHealth } from './health.js';

const configured = {
  APP_ENV: 'test',
  APP_BASE_URL: 'http://localhost:5173',
  SUPABASE_URL: 'https://abcd.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdefghij',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789',
};

describe('handleHealth', () => {
  it('returns 200 with per-group booleans when core config is present', async () => {
    const res = handleHealth(new Request('http://localhost/api/health'), configured);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'ok',
      environment: 'test',
      config: { app: true, supabase: true, openai: false, whatsapp: false },
    });
  });

  it('returns 503 degraded when core config is missing and leaks no values or names', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = handleHealth(new Request('http://localhost/api/health'), {
      ...configured,
      SUPABASE_SECRET_KEY: undefined,
    });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).status).toBe('degraded');
    expect(text).not.toContain('SUPABASE_SECRET_KEY');
    expect(text).not.toContain('abcd.supabase.co');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('supports HEAD with no body', async () => {
    const res = handleHealth(new Request('http://localhost/api/health', { method: 'HEAD' }), configured);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('rejects other methods with 405', async () => {
    const res = handleHealth(new Request('http://localhost/api/health', { method: 'POST' }), configured);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});
