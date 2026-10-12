import { errorResponse, json, methodNotAllowed } from '../http/response.js';
import { withErrorHandling } from '../http/errors.js';
import { safeEqual } from '../whatsapp/signature.js';
import { processWebhookEvents, type InboundResponder } from '../whatsapp/processor.js';
import type { MessagingStore } from '../whatsapp/store.js';

export interface JobDeps {
  cronSecret: string;
  store: MessagingStore;
  responder?: InboundResponder | undefined;
}

/**
 * Retries webhook events left pending, failed (after back-off) or stuck in
 * processing. Called by Vercel Cron (GET with Authorization: Bearer
 * CRON_SECRET) or manually with the same header.
 */
export function createProcessEventsJob(getDeps: () => JobDeps) {
  return withErrorHandling(async (request) => {
    if (request.method !== 'GET' && request.method !== 'POST') return methodNotAllowed(['GET', 'POST']);
    const deps = getDeps();
    const header = request.headers.get('authorization') ?? '';
    if (!safeEqual(header, `Bearer ${deps.cronSecret}`)) {
      return errorResponse(401, 'unauthorized', 'Unauthorized');
    }

    const totals = { claimed: 0, processed: 0, failed: 0 };
    const deadline = Date.now() + 20_000;
    // Drain in batches while there is work and time left.
    while (Date.now() < deadline) {
      const batch = await processWebhookEvents({ store: deps.store, responder: deps.responder }, { limit: 20 });
      totals.claimed += batch.claimed;
      totals.processed += batch.processed;
      totals.failed += batch.failed;
      if (batch.claimed < 20) break;
    }
    return json(totals);
  });
}
