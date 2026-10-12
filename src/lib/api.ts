/** Typed client for the app's own /api endpoints. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  request<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
}

export function createApiClient(opts: {
  getAccessToken: () => Promise<string | null>;
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}): ApiClient {
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    async request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
      const token = await opts.getAccessToken();
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';

      let res: Response;
      try {
        res = await doFetch(path, {
          method: init.method ?? 'GET',
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: init.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection.');
      }

      const data: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
        if (res.status === 401) opts.onUnauthorized?.();
        throw new ApiError(
          res.status,
          e?.code ?? 'http_error',
          e?.message ?? `Request failed (HTTP ${res.status})`,
          Array.isArray(e?.details) ? (e.details as { path: string; message: string }[]) : undefined,
        );
      }
      return data as T;
    },
  };
}
