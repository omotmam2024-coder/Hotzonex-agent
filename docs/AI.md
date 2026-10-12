# AI agent

The agent replies to WhatsApp customers using the OpenAI **Responses API**
(`openai` Node SDK 7.32) with three function tools. Code: `server/ai/`.

## Flow per customer message

```
inbound message recorded (Phase 3)
  └─ AiResponder (only if conversation open, AI enabled, business active)
       ├─ non-text message      → fixed "please type" reply, no model call
       ├─ monthly AI limit hit  → hand over, send handover message
       ├─ >20 AI replies/hour   → hand over (flood/cost protection)
       └─ runAgent
            loop (≤4 model requests, ≤6 tool calls, 12 s per request, 20 s total)
              model → function_call → Zod validation → tool runs with server context
            final text → guard → send via WhatsApp
            handover tool → conversation = handover, send handover message
            timeout/error → hand over, send handover message
```

## Tools

| Tool | Arguments (strict JSON schema + Zod) | What the server does |
| --- | --- | --- |
| `search_products` | `query: string \| null` (≤100 chars) | Searches **this business's** non-archived products (`search_products_for_ai`), ≤5 results, with formatted prices and an `available` flag. |
| `create_order_request` | `items: [{product_id, quantity 1–100}]` (1–20), `customer_note: string \| null` | Calls `create_order_request` with business, customer and conversation from server context and idempotency key `wa:<inbound wamid>`. Re-checks ownership, availability and stock, computes totals from database prices, creates `pending_confirmation` atomically. |
| `request_human_handover` | `reason: string` (1–300) | Sets the conversation to `handover`; the AI stops replying until a person reopens it. |

There are no SQL, shell, HTTP, payment or messaging tools. Schemas use
`additionalProperties: false`, so the model cannot pass `business_id`,
prices or totals; Zod rejects them again on the server. Bad arguments
produce an error result the model can recover from; they never throw.

## Grounding and safety

- Instructions limit answers to the business profile, the owner's
  "approved information" text and tool results, and require
  `search_products` before quoting any product, price or availability.
- Customer messages are user input, never instructions.
- Orders are always requests awaiting owner confirmation. The model is told
  it cannot know payment or delivery status.
- `server/ai/guard.ts` blocks replies that claim payment received or an order
  confirmed, shipped or delivered. A blocked reply becomes a handover with
  the business's handover message.
- `store: false`: conversation content is not stored at OpenAI by this
  request. A hashed `safety_identifier` (business + customer, no phone
  number) is sent for abuse monitoring.

## Limits and usage

| Limit | Default | Where |
| --- | --- | --- |
| Model requests per customer message | 4 | `DEFAULT_LIMITS.maxRounds` |
| Tool calls per customer message | 6 | `maxToolCalls` (last round forces a text answer) |
| Timeout per model request / total | 12 s / 20 s | `perRequestTimeoutMs`, `totalBudgetMs` (function max 30 s) |
| Output tokens per request | 500 | `maxOutputTokens` |
| History sent | last 20 messages, 6,000 chars, 1,000 per message | `historyMessages`, `historyChars`, `messageChars` |
| AI requests per business per month | `businesses.monthly_ai_request_limit` (default 2000) | operator-controlled |
| AI replies per conversation per hour | 20 | `MAX_AI_REPLIES_PER_HOUR` |

Every model request writes a `usage_records` row with the model and token
counts. Set a monthly budget on the OpenAI project as a hard cap.

## Setup

1. platform.openai.com → create a **project** for this app, then an API key
   in that project → `OPENAI_API_KEY` (server only).
2. Project → Limits: set a monthly budget and alert.
3. `OPENAI_MODEL`: a model that supports the Responses API and function
   calling; start with a small, low-cost one and test replies before going
   live. Check the models page for current names and prices.
4. Without OpenAI configuration the webhook still records messages; the
   responder is disabled and a person can reply from the dashboard.

## Tests

`tests/db/ai.test.ts` runs the full path (signed webhook → processor →
responder → tools → real SQL on PGlite → sender) with a scripted model in
place of OpenAI and a mocked Graph API. No test calls OpenAI. A live check
with your key is a manual step (see the deployment checklist).
