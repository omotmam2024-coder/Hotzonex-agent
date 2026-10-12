/**
 * Last line of defence on model output before it reaches a customer.
 * The model is instructed never to claim payment, confirmation, shipping or
 * delivery; this catches violations and replaces the reply.
 */
const UNVERIFIED_CLAIMS = [
  /\b(payment|deposit|money|transfer)\b[^.!?\n]{0,40}\b(received|confirmed|successful|complete[d]?|went through)\b/i,
  /\b(you(?:'ve| have)|has been|was|is)\s+(fully\s+)?paid\b/i,
  /\border\b[^.!?\n]{0,40}\b(is|has been|was)\s+(confirmed|approved|shipped|dispatched|delivered|on (?:its|the) way)\b/i,
  /\b(we(?:'ve| have)|i(?:'ve| have))\s+(shipped|dispatched|delivered|confirmed your order)\b/i,
  /\b(your|the)\s+(package|parcel|delivery|items?)\b[^.!?\n]{0,30}\b(has been|was|is)\s+(delivered|shipped|dispatched)\b/i,
];

export const MAX_REPLY_CHARS = 1200;

export function containsUnverifiedClaim(text: string): boolean {
  return UNVERIFIED_CLAIMS.some((re) => re.test(text));
}

export type GuardResult = { ok: true; text: string } | { ok: false; reason: 'empty' | 'unverified_claim' };

export function guardReply(text: string | null | undefined): GuardResult {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (containsUnverifiedClaim(trimmed)) return { ok: false, reason: 'unverified_claim' };
  return { ok: true, text: trimmed.length > MAX_REPLY_CHARS ? `${trimmed.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…` : trimmed };
}
