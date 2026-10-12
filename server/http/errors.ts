import { ConfigError } from '../config/env.js';
import { errorResponse } from './response.js';

/** An error whose message is safe to show to the caller. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = () => new HttpError(401, 'unauthorized', 'Sign in required');
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = () => new HttpError(403, 'forbidden', 'You do not have permission to do this');

type Handler = (request: Request) => Promise<Response>;

/**
 * Converts thrown errors into safe JSON responses. Unknown errors are
 * logged server-side and reported generically.
 */
export function withErrorHandling(handler: Handler): Handler {
  return async (request) => {
    try {
      return await handler(request);
    } catch (err) {
      if (err instanceof HttpError) {
        const res = errorResponse(err.status, err.code, err.message);
        if (err.details === undefined) return res;
        return new Response(JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }), {
          status: err.status,
          headers: res.headers,
        });
      }
      if (err instanceof ConfigError) {
        console.error('[config]', err.message);
        return errorResponse(503, 'service_unavailable', 'Service is not configured');
      }
      console.error('[unhandled]', err);
      return errorResponse(500, 'internal_error', 'Something went wrong');
    }
  };
}
