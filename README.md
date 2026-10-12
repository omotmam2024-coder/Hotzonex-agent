# Hotzonex Agent

A WhatsApp AI sales agent for small businesses, run as a low-budget managed
service that can serve several independent client businesses from one
deployment.

- **Dashboard**: React + Vite + TypeScript (`src/`)
- **API**: Vercel Node.js functions with Web-standard handlers (`api/`), logic in `server/`
- **Data/Auth**: Supabase Postgres with row-level security, Supabase Auth
- **AI**: OpenAI Responses API with three allow-listed, server-validated tools
- **Messaging**: Meta WhatsApp Cloud API (signed webhooks, Graph API sends)

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for every credential.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Scaffold, TypeScript, scripts, env validation, health endpoint | done |
| 2 | Migrations, auth, RLS, tenant isolation, product CRUD | planned |
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

## API

| Route | Description |
| --- | --- |
| `GET /api/health` | Liveness and config readiness. `200 ok` when app + Supabase config is valid, `503 degraded` otherwise. Returns booleans only. |

## Security baseline

- Server secrets are never `VITE_*`; the build fails if one looks like a secret.
- Configuration is validated with Zod; functions fail closed when credentials are missing.
- `business_id` is never accepted from public input or model output (from Phase 2 on).
- Webhooks are verified with HMAC-SHA256 over the raw body before any processing (Phase 3).
