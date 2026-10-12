import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = /^sha256=([a-f0-9]{64})$/i;

/**
 * Verifies Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the exact raw
 * request bytes, keyed with the app secret, compared in constant time.
 */
export function isValidSignature(rawBody: Uint8Array, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const match = HEADER.exec(header.trim());
  if (!match) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const provided = Buffer.from(match[1]!, 'hex');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Signature header value for a body; used by tests and local tooling. */
export function signBody(rawBody: Uint8Array | string, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** Constant-time string comparison for shared secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
