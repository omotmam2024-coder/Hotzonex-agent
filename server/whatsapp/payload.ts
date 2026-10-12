import { z } from 'zod';

/**
 * WhatsApp Cloud API webhook payloads. Only the fields we use are
 * validated; unknown fields are kept (Meta adds fields over time).
 */

const waId = z.string().regex(/^\d{5,32}$/);
const providerId = z.string().min(1).max(256);

const messageSchema = z.looseObject({
  from: waId,
  id: providerId,
  timestamp: z.string().regex(/^\d{1,12}$/).optional(),
  type: z.string().min(1).max(40),
  text: z.looseObject({ body: z.string().max(65536) }).optional(),
  button: z.looseObject({ text: z.string().max(1024) }).optional(),
  interactive: z
    .looseObject({
      button_reply: z.looseObject({ title: z.string().max(1024) }).optional(),
      list_reply: z.looseObject({ title: z.string().max(1024) }).optional(),
    })
    .optional(),
});

const statusSchema = z.looseObject({
  id: providerId,
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  recipient_id: z.string().max(64).optional(),
  errors: z
    .array(z.looseObject({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() }))
    .optional(),
});

const valueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp').optional(),
  metadata: z.looseObject({
    phone_number_id: z.string().regex(/^\d{5,32}$/),
    display_phone_number: z.string().max(32).optional(),
  }),
  contacts: z.array(z.looseObject({ wa_id: z.string().optional(), profile: z.looseObject({ name: z.string().optional() }).optional() })).optional(),
  messages: z.array(z.unknown()).max(1000).optional(),
  statuses: z.array(z.unknown()).max(1000).optional(),
});

export const webhookEnvelopeSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.looseObject({
        id: z.string().optional(),
        changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).max(100),
      }),
    )
    .min(1)
    .max(100),
});

export type InboundMessage = z.infer<typeof messageSchema>;
export type MessageStatus = z.infer<typeof statusSchema>;

export interface MessageEventPayload {
  phone_number_id: string;
  contact_name: string | null;
  message: InboundMessage;
}

export interface StatusEventPayload {
  phone_number_id: string;
  status: MessageStatus;
}

export type ParsedEvent =
  | { event_key: string; event_type: 'message'; phone_number_id: string; payload: MessageEventPayload }
  | { event_key: string; event_type: 'status'; phone_number_id: string; payload: StatusEventPayload };

export interface ExtractResult {
  events: ParsedEvent[];
  /** Items that were present but malformed or unsupported, for logging. */
  skipped: number;
}

/** Splits a verified, envelope-valid payload into individual events. */
export function extractEvents(envelope: z.infer<typeof webhookEnvelopeSchema>): ExtractResult {
  const events: ParsedEvent[] = [];
  let skipped = 0;

  for (const entry of envelope.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') {
        skipped++;
        continue;
      }
      const value = valueSchema.safeParse(change.value);
      if (!value.success) {
        skipped++;
        continue;
      }
      const { metadata, contacts = [], messages = [], statuses = [] } = value.data;
      const phone_number_id = metadata.phone_number_id;

      for (const raw of messages) {
        const parsed = messageSchema.safeParse(raw);
        if (!parsed.success) {
          skipped++;
          continue;
        }
        const message = parsed.data;
        const contact = contacts.find((c) => c.wa_id === message.from) ?? (contacts.length === 1 ? contacts[0] : undefined);
        events.push({
          event_key: `msg:${message.id}`,
          event_type: 'message',
          phone_number_id,
          payload: { phone_number_id, contact_name: contact?.profile?.name?.slice(0, 200) ?? null, message },
        });
      }

      for (const raw of statuses) {
        const parsed = statusSchema.safeParse(raw);
        if (!parsed.success) {
          skipped++;
          continue;
        }
        const status = parsed.data;
        events.push({
          event_key: `status:${status.id}:${status.status}`,
          event_type: 'status',
          phone_number_id,
          payload: { phone_number_id, status },
        });
      }
    }
  }
  return { events, skipped };
}

/** Text the business sees for a message; non-text types get a placeholder. */
export function messageText(message: InboundMessage): { text: string; isText: boolean } {
  if (message.type === 'text' && message.text) return { text: message.text.body, isText: true };
  if (message.type === 'button' && message.button) return { text: message.button.text, isText: true };
  if (message.type === 'interactive') {
    const title = message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
    if (title) return { text: title, isText: true };
  }
  return { text: `[${message.type} message]`, isText: false };
}
