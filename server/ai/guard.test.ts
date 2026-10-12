import { describe, expect, it } from 'vitest';
import { guardReply, MAX_REPLY_CHARS } from './guard.js';

describe('guardReply', () => {
  it.each([
    'Great news, your payment has been received!',
    'Your order is confirmed and will arrive tomorrow.',
    "We've shipped your items.",
    'Your package was delivered this morning.',
    'You have paid in full, thanks.',
    'Your order has been dispatched.',
  ])('blocks unverified claim: %s', (text) => {
    expect(guardReply(text)).toEqual({ ok: false, reason: 'unverified_claim' });
  });

  it.each([
    'I have sent your order request to the shop. They will confirm it soon. Total: $25.00.',
    'Coffee beans cost $12.50 and are available.',
    'Delivery takes 2 days according to our policy. I cannot check delivery status, so I will connect you with the team.',
    'Payment options are cash or mobile money when the business confirms.',
  ])('allows normal replies: %s', (text) => {
    expect(guardReply(text).ok).toBe(true);
  });

  it('rejects empty replies and truncates long ones', () => {
    expect(guardReply('  ')).toEqual({ ok: false, reason: 'empty' });
    const r = guardReply('a'.repeat(5000));
    expect(r.ok && r.text.length).toBe(MAX_REPLY_CHARS);
  });
});
