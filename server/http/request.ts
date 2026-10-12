import type { z } from 'zod';
import { HttpError } from './errors.js';

const DEFAULT_MAX_BYTES = 64 * 1024;

/** Reads and validates a JSON body. Throws HttpError on any problem. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<z.infer<S>> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request body is too large');

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) throw new HttpError(413, 'payload_too_large', 'Request body is too large');

  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
  return parseOrThrow(schema, data);
}

export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new HttpError(400, 'validation_failed', 'Some fields are invalid', fields);
  }
  return result.data;
}

/** Query parameters as a plain object for schema validation. */
export function queryParams(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}
