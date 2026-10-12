import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../config/env.js';
import { withErrorHandling } from './errors.js';

describe('withErrorHandling', () => {
  it('turns missing config into 503 without details', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withErrorHandling(async () => {
      throw new ConfigError([{ group: 'supabase', variable: 'SUPABASE_SECRET_KEY', message: 'SUPABASE_SECRET_KEY is required' }]);
    })(new Request('http://localhost/'));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('SUPABASE');
    err.mockRestore();
  });

  it('hides unexpected error messages', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await withErrorHandling(async () => {
      throw new Error('relation "secret_table" does not exist');
    })(new Request('http://localhost/'));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('secret_table');
    err.mockRestore();
  });
});
