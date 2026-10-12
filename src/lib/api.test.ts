import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './api';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('createApiClient', () => {
  it('sends the bearer token and JSON body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const api = createApiClient({ getAccessToken: async () => 'abc', fetchImpl });
    await api.request('/api/x', { method: 'POST', body: { a: 1 } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc');
    expect(init.body).toBe('{"a":1}');
  });

  it('calls onUnauthorized on 401 and throws ApiError', async () => {
    const onUnauthorized = vi.fn();
    const api = createApiClient({
      getAccessToken: async () => 'expired',
      onUnauthorized,
      fetchImpl: async () => jsonResponse(401, { error: { code: 'unauthorized', message: 'Sign in required' } }),
    });
    await expect(api.request('/api/me')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('maps network failures to a friendly error', async () => {
    const api = createApiClient({
      getAccessToken: async () => null,
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const err = await api.request('/api/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network_error');
  });
});
