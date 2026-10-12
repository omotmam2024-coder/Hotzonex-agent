# Configuration and credentials

Never paste secrets into chat, issues, commits or screenshots. Put them in
`.env.local` (git-ignored) for local work and in Vercel project settings for
deployments.

## Variables

| Variable | Exposed to browser | Required by | Where to get it |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | yes | dashboard | Supabase dashboard → Project Settings → API → Project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | yes | dashboard, server | Supabase → Project Settings → API Keys → **Publishable key** (`sb_publishable_…`). Legacy projects: the `anon` key. Safe in the browser only because RLS protects every table. The server also uses it to run dashboard queries as the signed-in user. |
| `APP_ENV` | no | all functions | You choose: `development`, `test`, `preview`, `production`. |
| `APP_BASE_URL` | no | all functions | Public URL of the app, e.g. `http://localhost:5173` locally or `https://your-app.vercel.app`. Must be https in production. |
| `SUPABASE_URL` | no | server | Same value as `VITE_SUPABASE_URL`. |
| `SUPABASE_SECRET_KEY` | **no** | server | Supabase → Project Settings → API Keys → **Secret key** (`sb_secret_…`). Bypasses RLS: server only. Legacy projects: `service_role` key. |
| `OPENAI_API_KEY` | **no** | AI agent | platform.openai.com → API keys. Create a project-scoped key and set a monthly budget limit on the project. |
| `OPENAI_MODEL` | no | AI agent | A model id from platform.openai.com/docs/models that supports the Responses API and function calling. Pick a small, low-cost model to start. |
| `WHATSAPP_ACCESS_TOKEN` | **no** | WhatsApp | developers.facebook.com → your app → WhatsApp → API Setup. The temporary token there expires in ~24h; for production create a System User in Meta Business Settings with `whatsapp_business_messaging` and `whatsapp_business_management` permissions and generate a permanent token. |
| `WHATSAPP_PHONE_NUMBER_ID` | no | WhatsApp | WhatsApp → API Setup → **Phone number ID** (a numeric id, not the phone number). |
| `WHATSAPP_VERIFY_TOKEN` | **no** | WhatsApp | A random string you generate (≥16 chars), e.g. `openssl rand -hex 32`. Enter the same value as the "Verify token" in WhatsApp → Configuration → Webhook. |
| `WHATSAPP_APP_SECRET` | **no** | WhatsApp | developers.facebook.com → your app → App settings → Basic → **App secret**. Used to verify `X-Hub-Signature-256` on every webhook. |
| `CRON_SECRET` | **no** | retry job | A random value you generate (≥32 chars), e.g. `openssl rand -hex 32`. Vercel Cron sends it as a bearer token to `/api/jobs/process-events`. |
| `WHATSAPP_API_VERSION` | no | WhatsApp | Graph API version such as `v23.0`. Use the latest listed at developers.facebook.com/docs/graph-api/changelog and review it when Meta deprecates versions. |

Rules enforced in code:

- `server/config/env.ts` validates server variables in groups (`app`,
  `supabase`, `openai`, `whatsapp`, `jobs`). Each function requires only the groups
  it uses and fails closed if they are missing. Errors list variable names,
  never values.
- `src/lib/env.ts` validates the browser variables and rejects a Supabase
  secret or `service_role` key.
- `vite.config.ts` refuses to build if any `VITE_*` variable has a
  secret-looking name (`SECRET`, `TOKEN`, `OPENAI`, `PASSWORD`, …) or value
  (`sb_secret_…`, `sk-…`, a `service_role` JWT).
- `/api/health` reports only `true/false` per group.

## Local setup

```bash
cp .env.example .env.local
# edit .env.local in your editor
npm run check:env                               # app + supabase + browser
npm run check:env -- --require=openai,whatsapp  # everything
```

`check:env` prints which variables are missing or invalid, never their
values, and exits non-zero on failure.

## Vercel setup

Vercel → Project → Settings → Environment Variables. Add every variable
above. Recommended scoping:

- **Production**: real production values, `APP_ENV=production`.
- **Preview**: a separate Supabase project (or branch), a separate OpenAI
  project key with a low budget, and Meta test credentials;
  `APP_ENV=preview`.
- **Development**: only if you use `vercel env pull`; otherwise use
  `.env.local`.

Mark server secrets as **Sensitive** so their values cannot be read back in
the dashboard. `VITE_*` values are baked into the frontend at build time:
redeploy after changing them.
