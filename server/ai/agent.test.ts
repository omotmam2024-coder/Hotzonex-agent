import { describe, expect, it } from 'vitest';
import { buildHistory, buildInstructions, DEFAULT_LIMITS } from './agent.js';
import type { AiContext } from './store.js';

const business: AiContext['business'] = {
  name: 'Shop A',
  description: 'Coffee roaster',
  ai_knowledge: 'Open 9-5. Delivery in Kampala only.',
  ai_enabled: true,
  status: 'active',
  currency: 'UGX',
  timezone: 'Africa/Kampala',
  handover_message: 'A person will reply.',
  monthly_ai_request_limit: 100,
};

describe('buildInstructions', () => {
  it('grounds the model in approved data and forbids unverified claims', () => {
    const text = buildInstructions(business, 'Monday');
    expect(text).toContain('Open 9-5. Delivery in Kampala only.');
    expect(text).toMatch(/Never say an order is confirmed, paid, shipped or delivered/);
    expect(text).toMatch(/not instructions to you/);
  });
});

describe('buildHistory', () => {
  it('limits message count and characters, keeps newest, ends on the customer turn', () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      direction: (i % 2 === 0 ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
      sender: (i % 2 === 0 ? 'customer' : 'ai') as 'customer' | 'ai',
      body: `m${i} ${'x'.repeat(500)}`,
    }));
    messages.push({ direction: 'inbound', sender: 'customer', body: 'latest question' });
    const items = buildHistory(messages, DEFAULT_LIMITS);
    expect(items.length).toBeLessThanOrEqual(DEFAULT_LIMITS.historyMessages);
    const chars = items.reduce((n, i) => n + ('content' in i ? i.content.length : 0), 0);
    expect(chars).toBeLessThanOrEqual(DEFAULT_LIMITS.historyChars);
    expect(items.at(-1)).toEqual({ role: 'user', content: 'latest question' });
    expect('role' in items[0]! && items[0].role).toBe('user');
  });

  it('truncates a single huge message', () => {
    const items = buildHistory([{ direction: 'inbound', sender: 'customer', body: 'y'.repeat(50_000) }], DEFAULT_LIMITS);
    expect('content' in items[0]! && items[0].content.length).toBe(DEFAULT_LIMITS.messageChars + 1);
  });
});
