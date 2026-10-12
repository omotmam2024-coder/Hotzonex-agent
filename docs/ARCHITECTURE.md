# Architecture

Hotzonex Agent is a WhatsApp AI sales agent for small businesses, run as a
low-budget managed service that can host several independent client
businesses (tenants) on one deployment.

## Components

```
                       ┌──────────────────────────────┐
 WhatsApp customer ──▶ │ Meta WhatsApp Cloud API       │
                       └──────────────┬───────────────┘
                                      │ webhook (signed, X-Hub-Signature-256)
                                      ▼
┌──────────────────────── Vercel ─────────────────────────────────────┐
│  /api/webhooks/whatsapp  (Node.js function, Web Request/Response)    │
│    1. verify HMAC over raw bytes  2. validate payload (Zod)          │
│    3. resolve tenant via business_integrations.phone_number_id       │
│    4. persist webhook_events (unique on provider event id) → 200     │
│    5. process after response (waitUntil) + retry job for leftovers   │
│                                                                      │
│  server/ai        OpenAI Responses API, 3 allow-listed tools         │
│  server/whatsapp  Graph API client (send messages)                   │
│  server/db        Supabase client (secret key, server only)          │
│                                                                      │
│  /api/health, /api/* dashboard APIs (Supabase JWT required)          │
│                                                                      │
│  dist/ (React + Vite SPA dashboard, publishable key only)            │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▼
                  Supabase: Postgres + Auth + RLS
```

### Repository layout

| Path | Purpose |
| --- | --- |
| `api/` | Vercel function entry points only. Each file is one function. Thin: parse request, call `server/`. |
| `server/` | All server logic (config, HTTP helpers, DB access, WhatsApp, AI tools). Never imported by `src/`. |
| `src/` | React dashboard (browser). Only `VITE_*` variables reach it. |
| `supabase/migrations/` | SQL migrations (schema, RLS, functions). |
| `scripts/` | Local tooling: env check, local API dev server. |
| `docs/` | Architecture, setup, deployment, runbooks. |

## Key decisions

1. **Vercel Web-standard handlers** (`export function POST(request: Request)`).
   `await request.arrayBuffer()` returns the exact bytes Meta signed, so the
   HMAC check never runs over re-serialized JSON.
2. **Tenant resolution is server-side only.** Webhooks map the verified
   `metadata.phone_number_id` to a business through `business_integrations`.
   Dashboard requests derive the business from the caller's Supabase JWT and
   `business_members`. `business_id` from request bodies or model output is
   never trusted.
3. **Two layers of isolation.** RLS on every tenant table, keyed on
   `business_members` membership, protects the dashboard (publishable key +
   user JWT). Server code that uses the secret key (bypasses RLS) always
   filters by the tenant it resolved itself; Postgres functions used for
   writes (e.g. atomic order creation) take the business id as a parameter
   supplied by trusted server code and re-check ownership of every product.
4. **Durable, idempotent webhooks.** Every verified event is inserted into
   `webhook_events` with a unique key (WhatsApp message id / status id) before
   any side effect. Duplicates are acknowledged with 200 and skipped. Orders
   carry an idempotency key derived from the source message so replays
   cannot create duplicates.
5. **Respond fast, process after.** Meta retries webhooks that are slow or
   not 2xx. The handler persists then returns 200 and continues processing
   with `waitUntil`. Events left `pending`/`failed` are retried by a protected
   job endpoint (Vercel Cron or manual), with attempt limits.
6. **AI is constrained.** The model only gets `search_products`,
   `create_order_request` and `request_human_handover`. Arguments are
   validated with Zod; the server rechecks availability and prices,
   calculates totals and writes orders atomically as
   `pending_confirmation`. No SQL, shell or HTTP tools. Tool-call count,
   context length, timeout and per-business usage are capped.
7. **Config validated per feature group** (`app`, `supabase`, `openai`,
   `whatsapp`). A function only requires the groups it uses and fails closed
   with a generic error if they are missing; errors name variables, never
   values. Browser config is validated separately and the build rejects
   secret-looking `VITE_*` variables.
8. **Credentials per tenant (later).** Phase 3 starts with the single
   WhatsApp number/token from env (one Meta app operated by us). The
   `business_integrations` table stores the phone-number id mapping; storing
   per-tenant access tokens will use Supabase Vault rather than plain columns.

## Phases

1. Scaffold, TypeScript, scripts, env validation, README, health endpoint.
2. Migrations, auth, RLS, tenant isolation, product CRUD.
3. WhatsApp webhook, durable events, dedupe, outbound messages, statuses.
4. OpenAI Responses API integration and the three tools.
5. Dashboard pages, tests, deployment docs, onboarding checklist.
