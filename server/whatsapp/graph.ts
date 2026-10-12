import { z } from 'zod';

export interface GraphConfig {
  accessToken: string;
  apiVersion: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type SendResult =
  | { ok: true; waMessageId: string }
  | { ok: false; code: string; message: string; retryable: boolean };

const successSchema = z.object({ messages: z.array(z.object({ id: z.string().min(1).max(256) })).min(1) });
const errorSchema = z.object({
  error: z.object({ message: z.string().optional(), code: z.number().optional(), error_subcode: z.number().optional() }),
});

// Graph error codes worth retrying later: throttling and temporary errors.
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131016, 131048, 131056]);

/** Minimal client for the WhatsApp Cloud API messages endpoint. */
export class WhatsAppGraphClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: GraphConfig) {
    this.baseUrl = config.baseUrl ?? 'https://graph.facebook.com';
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.fetchImpl = config.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  }

  async sendText(input: { phoneNumberId: string; to: string; body: string }): Promise<SendResult> {
    if (!/^\d{5,32}$/.test(input.phoneNumberId) || !/^\d{5,32}$/.test(input.to)) {
      return { ok: false, code: 'invalid_recipient', message: 'Invalid phone number id or recipient', retryable: false };
    }
    const url = `${this.baseUrl}/${this.config.apiVersion}/${input.phoneNumberId}/messages`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'text',
          text: { preview_url: false, body: input.body },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timeout = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return { ok: false, code: timeout ? 'timeout' : 'network_error', message: timeout ? 'Graph API timed out' : 'Network error', retryable: true };
    }

    const data: unknown = await res.json().catch(() => null);
    if (res.ok) {
      const parsed = successSchema.safeParse(data);
      if (parsed.success) return { ok: true, waMessageId: parsed.data.messages[0]!.id };
      return { ok: false, code: 'unexpected_response', message: 'Graph API response had no message id', retryable: false };
    }

    const err = errorSchema.safeParse(data);
    const code = err.success ? err.data.error.code : undefined;
    return {
      ok: false,
      code: code !== undefined ? `graph_${code}` : `http_${res.status}`,
      // Graph error messages do not contain the access token; keep them short.
      message: (err.success ? err.data.error.message : undefined)?.slice(0, 500) ?? `HTTP ${res.status}`,
      retryable: res.status >= 500 || res.status === 429 || (code !== undefined && RETRYABLE_CODES.has(code)),
    };
  }
}
