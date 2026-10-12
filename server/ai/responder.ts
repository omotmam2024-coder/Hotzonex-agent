import type { InboundContext, InboundResponder } from '../whatsapp/processor.js';
import type { SendTextResult } from '../whatsapp/sender.js';
import { runAgent, type AgentDeps } from './agent.js';
import { guardReply } from './guard.js';
import type { AiStore } from './store.js';

export const NON_TEXT_REPLY = 'Sorry, I can only read text messages. Please type your question and I will help.';
/** Replies per conversation per hour before a person takes over. */
export const MAX_AI_REPLIES_PER_HOUR = 20;

export interface AiResponderDeps extends AgentDeps {
  store: AiStore;
  send: (input: { businessId: string; conversationId: string; body: string; sender: 'ai' | 'system' }) => Promise<SendTextResult>;
  today?: (timezone: string) => string;
}

/**
 * Replies to a customer message with the AI agent, or hands the
 * conversation to a person when the AI cannot or should not answer.
 * Every failure path ends in a safe message, never a made-up answer.
 */
export class AiResponder implements InboundResponder {
  constructor(private readonly deps: AiResponderDeps) {}

  async onInboundMessage(msg: InboundContext): Promise<void> {
    const { store } = this.deps;
    const context = await store.getContext(msg.businessId, msg.conversationId);
    if (!context) return;
    const { business } = context;
    if (context.conversation_status !== 'open' || !business.ai_enabled || business.status !== 'active') return;

    const reply = (body: string, sender: 'ai' | 'system') => this.send(msg, body, sender);
    const handover = async (reason: string, actor: 'ai' | 'system' = 'system') => {
      const r = await store.requestHandover(msg.businessId, msg.conversationId, reason, actor);
      await reply(r.handover_message || business.handover_message, 'system');
    };

    if (!msg.isText) return reply(NON_TEXT_REPLY, 'system');
    if (context.ai_requests_this_month >= business.monthly_ai_request_limit) return handover('Monthly AI request limit reached');
    if (context.ai_replies_last_hour >= MAX_AI_REPLIES_PER_HOUR) return handover('Too many messages in a short time');

    const today = (this.deps.today ?? defaultToday)(business.timezone);
    const result = await runAgent(
      this.deps,
      {
        businessId: msg.businessId,
        customerId: msg.customerId,
        conversationId: msg.conversationId,
        currency: business.currency,
        sourceMessageId: msg.waMessageId,
      },
      context,
      today,
    );

    switch (result.kind) {
      case 'reply': {
        const guarded = guardReply(result.text);
        if (guarded.ok) return reply(guarded.text, 'ai');
        console.warn('[ai] reply blocked', { businessId: msg.businessId, reason: guarded.reason });
        return handover(guarded.reason === 'unverified_claim' ? 'AI reply blocked: unverified claim' : 'AI returned an empty reply');
      }
      case 'handover':
        // The tool already moved the conversation to handover.
        return reply(business.handover_message, 'system');
      case 'error':
        console.error('[ai] agent failed', { businessId: msg.businessId, error: result.error, detail: result.detail });
        return handover(result.error === 'timeout' ? 'AI timed out' : 'AI unavailable');
    }
  }

  private async send(msg: InboundContext, body: string, sender: 'ai' | 'system'): Promise<void> {
    const r = await this.deps.send({ businessId: msg.businessId, conversationId: msg.conversationId, body, sender });
    if (!r.ok) console.error('[ai] reply not sent', { businessId: msg.businessId, error: r.error });
  }
}

function defaultToday(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'full' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
