# Hotzonex Agent

A WhatsApp AI sales agent for small businesses, run as a low-budget managed
service that can serve several independent client businesses from one
deployment.

- **Dashboard**: React + Vite + TypeScript (`src/`)
- **API**: Vercel Node.js functions with Web-standard handlers (`api/`), logic in `server/`
- **Data/Auth**: Supabase Postgres with row-level security, Supabase Auth
- **AI**: OpenAI Responses API with three allow-listed, server-validated tools
- **Messaging**: Meta WhatsApp Cloud API (signed webhooks, Graph API sends)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design,
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every credential and
[docs/DATABASE.md](docs/DATABASE.md) for migrations, RLS and onboarding.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Scaffold, TypeScript, scripts, env validation, health endpoint | done |
| 2 | Migrations, auth, RLS, tenant isolation, product CRUD | done |
| 3 | WhatsApp webhook, durable events, dedupe, outbound, statuses | planned |
| 4 | OpenAI Responses API + tools | planned |
| 5 | Dashboard, deployment docs, onboarding checklist | planned |

## Requirements

- Node.js 22 (`.nvmrc`), npm 10

## Getting started

```bash
npm install
cp .env.example .env.local   # then fill in values; see docs/CONFIGURATION.md
npm run check:env
# apply database migrations: see docs/DATABASE.md

npm run dev:api   # terminal 1: local runner for api/* on :3001
npm run dev       # terminal 2: dashboard on :5173 (proxies /api)
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server for the dashboard |
| `npm run dev:api` | Local runner for `api/*.ts` functions (passes raw request bytes through) |
| `npm run build` | Type-check server and app, then build the dashboard to `dist/` |
| `npm run typecheck` | `tsc` for server (`tsconfig.json`) and app (`tsconfig.app.json`) |
| `npm test` | Vitest: `server` project (node) and `app` project (jsdom) |
| `npm run check:env` | Validate local configuration without printing values |
| `npm run onboard` | Operator: create a business, invite its owner, map a WhatsApp number (dry run unless `--confirm`) |

## API

| Route | Description |
| --- | --- |
| `GET /api/health` | Liveness and config readiness. `200 ok` when app + Supabase config is valid, `503 degraded` otherwise. Returns booleans only. |
| `GET /api/me` | Signed-in user and their business memberships |
| `GET, PATCH /api/business?business_id=` | Business profile and settings (PATCH: owner/admin, profile fields only) |
| `GET, POST, PATCH, DELETE /api/products?business_id=[&id=]` | Product/service CRUD (writes: owner/admin; delete archives products that appear in orders) |

All endpoints except health require `Authorization: Bearer <Supabase access token>`.

## Security baseline

- Server secrets are never `VITE_*`; the build fails if one looks like a secret.
- Configuration is validated with Zod; functions fail closed when credentials are missing.
- Tenant access comes from membership, never from a `business_id` alone; RLS on every table, tested against real SQL.
- Webhooks are verified with HMAC-SHA256 over the raw body before any processing (Phase 3).
