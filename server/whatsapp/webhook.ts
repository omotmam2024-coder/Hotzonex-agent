import { errorResponse, json, methodNotAllowed } from '../http/response.js';
import { withErrorHandling } from '../http/errors.js';
import { extractEvents, webhookEnvelopeSchema } from './payload.js';
import { processWebhookEvents, type InboundResponder } from './processor.js';
import { isValidSignature, safeEqual } from './signature.js';
import type { MessagingStore } from './store.js';

export const MAX_WEBHOOK_BYTES = 1024 * 1024;

export interface WebhookDeps {
  verifyToken: string;
  appSecret: string;
  store: MessagingStore;
  responder?: InboundResponder | undefined;
  /** Keeps work running after the response is sent (Vercel waitUntil). */
  defer: (work: Promise<unknown>) => void;
}

const CHALLENGE = /^[A-Za-z0-9._-]{1,256}$/;

/**
 * GET: Meta's subscription handshake.
 * POST: event delivery. Nothing is parsed or stored until the signature over
 * the exact raw bytes is verified. Events are persisted (deduplicated) before
 * responding 200; processing continues after the response.
 */
export function createWhatsAppWebhookHandler(getDeps: () => WebhookDeps) {
  return withErrorHandling(async (request) => {
    if (request.method === 'GET') return verifySubscription(request, getDeps().verifyToken);
    if (request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);

    const deps = getDeps();

    const declared = Number(request.headers.get('content-length') ?? 0);
    if (declared > MAX_WEBHOOK_BYTES) return errorResponse(413, 'payload_too_large', 'Payload too large');
    const raw = new Uint8Array(await request.arrayBuffer());
    if (raw.byteLength > MAX_WEBHOOK_BYTES) return errorResponse(413, 'payload_too_large', 'Payload too large');

    if (!isValidSignature(raw, request.headers.get('x-hub-signature-256'), deps.appSecret)) {
      console.warn('[webhook] rejected: invalid signature');
      return errorResponse(401, 'invalid_signature', 'Invalid signature');
    }

    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      console.warn('[webhook] rejected: signed body is not valid JSON');
      return errorResponse(400, 'invalid_json', 'Invalid JSON');
    }
    const envelope = webhookEnvelopeSchema.safeParse(data);
    if (!envelope.success) {
      console.warn('[webhook] rejected: unexpected payload shape');
      return errorResponse(400, 'invalid_payload', 'Unexpected payload');
    }

    const { events, skipped } = extractEvents(envelope.data);
    if (skipped > 0) console.warn('[webhook] skipped malformed or unsupported items', { skipped });

    // Resolve each phone-number id through the trusted mapping table.
    const tenants = new Map<string, string | null>();
    for (const id of new Set(events.map((e) => e.phone_number_id))) {
      tenants.set(id, await deps.store.resolveBusiness(id));
    }
    const unknown = [...tenants].filter(([, b]) => b === null).map(([id]) => id);
    if (unknown.length > 0) console.warn('[webhook] events for unmapped phone number ids', { count: unknown.length });

    // A database failure here returns 500 so Meta retries delivery.
    const stored = await deps.store.storeEvents(events.map((e) => ({ ...e, business_id: tenants.get(e.phone_number_id) ?? null })));

    if (stored.to_process.length > 0) {
      deps.defer(
        processWebhookEvents({ store: deps.store, responder: deps.responder }, { ids: stored.to_process }).catch((err: unknown) => {
          // Left pending/processing; the retry job picks them up.
          console.error('[webhook] background processing failed', err instanceof Error ? err.message : err);
        }),
      );
    }

    return json({ received: events.length, stored: stored.inserted });
  });
}

function verifySubscription(request: Request, verifyToken: string): Response {
  const params = new URL(request.url).searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode !== 'subscribe' || !token || !challenge || !CHALLENGE.test(challenge) || !safeEqual(token, verifyToken)) {
    console.warn('[webhook] verification rejected');
    return errorResponse(403, 'verification_failed', 'Verification failed');
  }
  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
