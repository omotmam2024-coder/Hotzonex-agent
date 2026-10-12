import { describe, expect, it } from 'vitest';
import { extractEvents, messageText, webhookEnvelopeSchema } from './payload.js';

const envelope = (value: unknown, field = 'messages') =>
  webhookEnvelopeSchema.parse({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field, value }] }] });

describe('extractEvents', () => {
  it('splits messages and statuses with stable keys', () => {
    const { events, skipped } = extractEvents(
      envelope({
        metadata: { phone_number_id: '12345' },
        contacts: [{ wa_id: '15550001111', profile: { name: 'Ann' } }],
        messages: [{ from: '15550001111', id: 'wamid.A', type: 'text', text: { body: 'hi' } }],
        statuses: [{ id: 'wamid.B', status: 'delivered' }],
      }),
    );
    expect(skipped).toBe(0);
    expect(events.map((e) => [e.event_key, e.event_type])).toEqual([
      ['msg:wamid.A', 'message'],
      ['status:wamid.B:delivered', 'status'],
    ]);
    expect(events[0]!.payload).toMatchObject({ contact_name: 'Ann', phone_number_id: '12345' });
  });

  it('skips other fields, bad metadata and malformed items', () => {
    expect(extractEvents(envelope({}, 'account_update')).skipped).toBe(1);
    expect(extractEvents(envelope({ metadata: { phone_number_id: 'abc' } })).skipped).toBe(1);
    const r = extractEvents(
      envelope({ metadata: { phone_number_id: '12345' }, messages: [{ id: 'x' }], statuses: [{ id: 'y', status: 'weird' }] }),
    );
    expect(r).toEqual({ events: [], skipped: 2 });
  });
});

describe('messageText', () => {
  it.each([
    [{ from: '1', id: 'a', type: 'text', text: { body: 'hello' } }, 'hello', true],
    [{ from: '1', id: 'a', type: 'button', button: { text: 'Yes' } }, 'Yes', true],
    [{ from: '1', id: 'a', type: 'interactive', interactive: { list_reply: { title: 'Mug' } } }, 'Mug', true],
    [{ from: '1', id: 'a', type: 'audio' }, '[audio message]', false],
  ])('%#', (msg, text, isText) => {
    expect(messageText(msg as never)).toEqual({ text, isText });
  });
});
