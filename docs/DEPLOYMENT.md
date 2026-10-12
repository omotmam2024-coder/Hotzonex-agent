# Deployment and operations

Stack: GitHub → Vercel (Vite static dashboard + Node.js functions in `api/`)
→ Supabase (Postgres, Auth) + OpenAI + Meta WhatsApp Cloud API.

> **Plans and cost.** Vercel's Hobby plan is for personal, non-commercial use.
> Running this as a paid service for clients needs Vercel **Pro**. Hobby also
> limits cron jobs to once a day (the retry job here runs daily). Supabase
> Free pauses projects after a period of inactivity and has no downloadable
> backups; use Pro for production clients. Check each provider's current
> pricing page before committing.

## 1. Supabase (once per environment)

Create two projects: `hotzonex-dev` and `hotzonex-prod`.

1. Apply migrations (see `docs/DATABASE.md`): `supabase link`, then
   `supabase db push --dry-run`, then `supabase db push`. They are numbered
   `…0100` to `…0600` and must run in order.
2. Authentication → Sign In / Providers → Email: **disable new sign-ups**.
3. Authentication → URL Configuration: Site URL = `APP_BASE_URL`; Redirect
   URLs include `<APP_BASE_URL>/overview` and `<APP_BASE_URL>/products`.
4. Authentication → Emails → SMTP: configure a custom SMTP provider before
   inviting clients (the built-in sender is rate-limited).
5. Project Settings → API Keys: copy the URL, publishable key and secret key
   into Vercel (step 3). Never into chat or Git.
6. If you use a custom Supabase domain, add it to `connect-src` in the
   `Content-Security-Policy` header in `vercel.json`.

## 2. GitHub

The repository is already connected. Work on branches; merge to `main` to
deploy production. CI (`.github/workflows/ci.yml`) runs tests and the build
on every push; protect `main` in GitHub settings so it requires CI to pass.

## 3. Vercel project

1. vercel.com → Add New → Project → import the GitHub repository. Framework
   preset: **Vite** (also set in `vercel.json`). Build command
   `npm run build`, output `dist`. Node.js 22 (`package.json` engines).
2. Settings → Environment Variables. Add every variable from
   `docs/CONFIGURATION.md` for **Production** (prod Supabase, production
   Meta token, `APP_ENV=production`, `APP_BASE_URL=https://<your domain>`)
   and **Preview** (dev Supabase, low-budget OpenAI key, `APP_ENV=preview`).
   Mark secrets **Sensitive**. `VITE_*` values are baked in at build time;
   redeploy after changing them.
3. Settings → Functions: region close to your Supabase region.
4. Settings → Deployment Protection: previews are protected by default (Meta
   cannot reach them; keep it that way). Production must be public for the
   webhook.
5. Deploy `main`. Add a custom domain if you have one and update
   `APP_BASE_URL` and the Supabase URL configuration.
6. The cron in `vercel.json` calls `/api/jobs/process-events` daily with
   `Authorization: Bearer $CRON_SECRET`.

## 4. Meta webhook

Follow `docs/WHATSAPP.md`: callback URL
`https://<your domain>/api/webhooks/whatsapp`, verify token
`WHATSAPP_VERIFY_TOKEN`, subscribe to `messages`.

## 5. Production smoke test

Non-destructive, no credentials needed:

```bash
npm run smoke -- --url https://<your domain>
```

Checks: health `ok` with all config groups ready, dashboard and SPA routes
served, API requires sign-in, webhook rejects a wrong verify token and
unsigned events, retry job requires the cron secret, security headers.

Then, manually, with a test business:

1. Sign in as the test owner; add a product with a price and stock.
2. From a test WhatsApp number, message the business number: "What do you
   sell?" → the reply should list that product with the right price.
3. Ask to order 2 → an order appears in **Orders → To confirm** with the
   server-calculated total; the reply must say it awaits confirmation.
4. Ask "can I speak to a person?" → conversation shows **Needs a person**;
   reply from the dashboard; the customer receives it.
5. Confirm the order; check stock decreased. Check Overview usage counters.
6. Check Vercel logs show no errors and `/api/health` stays `ok`.

Only after these pass, point a real client's number at production.

## 6. Rollback

- **App:** Vercel → Deployments → pick the last good deployment →
  **Instant Rollback** (or Promote). Takes seconds; no rebuild.
- **Database:** migrations are forward-only. Take a dump before each
  production migration (below). To undo, write a new migration that reverses
  the change, test it on dev, then push. Restore from a dump only for data
  loss (it overwrites newer data).
- **Bad AI behaviour:** owners can turn off AI replies in Settings at once;
  messages are still recorded. Operator-wide: remove `OPENAI_API_KEY` in
  Vercel and redeploy; the responder disables itself.
- **WhatsApp incident:** in Meta → Configuration, unsubscribe the `messages`
  field to stop deliveries (Meta queues and retries for a limited time).

## 7. Monitoring

- **Uptime:** point a free uptime monitor at `/api/health` (expects 200 and
  `"status":"ok"`).
- **Logs:** Vercel → Logs / Observability. The app logs ids and counts, not
  message text or phone numbers. Search for `[webhook]`, `[ai]`, `[config]`,
  `[unhandled]`.
- **Per-business problems:** Overview → "Recent problems"; SQL:
  `select * from audit_logs where level = 'error' order by created_at desc limit 50;`
- **Stuck events:**
  `select status, count(*) from webhook_events group by 1;` and for parked
  failures `select event_type, last_error, received_at from webhook_events where status = 'failed' and locked_until = 'infinity';`
- **Costs:** OpenAI project usage page (set a monthly budget and alerts);
  `usage_records` per business; Meta WhatsApp Manager → Insights.

## 8. Backups

- Supabase Pro includes daily backups; enable Point-in-Time Recovery if
  needed.
- Regardless of plan, take your own dump before every production migration
  and weekly:
  `npx supabase@2.120.0 db dump --linked -f backups/schema-$(date +%F).sql`
  and `... --data-only -f backups/data-$(date +%F).sql`. Store them outside
  the repository (they contain customer data), encrypted.
- Test a restore into the dev project occasionally.

## 9. Usage limits

| Limit | Where | Change |
| --- | --- | --- |
| AI requests per business per month | `businesses.monthly_ai_request_limit` | SQL (operator), e.g. `update businesses set monthly_ai_request_limit = 5000 where id = '…';` |
| Outbound WhatsApp messages per month | `businesses.monthly_outbound_message_limit` | SQL (operator) |
| AI replies per conversation per hour | `MAX_AI_REPLIES_PER_HOUR` in `server/ai/responder.ts` | code |
| Per-reply model/tool/time limits | `DEFAULT_LIMITS` in `server/ai/agent.ts` | code |
| OpenAI spend | OpenAI project budget | OpenAI dashboard |
| Function duration | `vercel.json` `maxDuration` (30 s) | config |

Owners and admins cannot change limits, status or currency from the
dashboard (column privileges block it).
