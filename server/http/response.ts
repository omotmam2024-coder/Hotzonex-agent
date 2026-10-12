const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(BASE_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

/** Error response with a stable machine code and a safe, generic message. */
export function errorResponse(status: number, code: string, message: string, init: ResponseInit = {}): Response {
  return json({ error: { code, message } }, { ...init, status });
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return errorResponse(405, 'method_not_allowed', 'Method not allowed', {
    headers: { Allow: allowed.join(', ') },
  });
}
