# Database, auth and tenant isolation

## Migrations

| File | Contents |
| --- | --- |
| `supabase/migrations/20261012000100_schema.sql` | Tables, constraints, indexes, `updated_at` triggers |
| `supabase/migrations/20261012000200_rls.sql` | Privileges, RLS policies, `private.is_member()` |
| `supabase/migrations/20261012000300_functions.sql` | `create_business_with_owner`, `create_order_request`, `set_order_status` |
| `supabase/migrations/20261012000400_messaging.sql` | Webhook inbox, inbound/outbound messages, delivery statuses |
| `supabase/migrations/20261012000500_ai.sql` | AI catalogue search, context, usage, handover |
| `supabase/migrations/20261012000600_dashboard.sql` | Dashboard read models and actions (run as the user, RLS applies) |

### Applying to a Supabase project

Use a separate **dev** project first. Applying migrations to production is a
deliberate step; take a backup first (see below).

Option A, Supabase CLI (recommended):

```bash
npx supabase@2.120.0 login                  # opens a browser; no secrets in chat
npx supabase@2.120.0 link --project-ref <your-project-ref>
npx supabase@2.120.0 db push --dry-run      # review what will run
npx supabase@2.120.0 db push
```

Option B, dashboard: open **SQL Editor** and run the files in order.

### Auth settings on the hosted project

`supabase/config.toml` only affects a local Supabase stack. On the hosted
project set, under **Authentication**:

- **Sign In / Providers → Email**: keep enabled; **disable "Allow new users to sign up"**.
  Owners are invited by the operator (`npm run onboard`).
- **URL Configuration**: Site URL = your `APP_BASE_URL`; add
  `<APP_BASE_URL>/overview` and `<APP_BASE_URL>/products` (and the
  `http://localhost:5173/…` equivalents for dev) to Redirect URLs.
- **Password policy**: minimum length 10 or more.
- **Emails**: the built-in email sender is heavily rate-limited; configure
  custom SMTP before onboarding real clients.

## Tenant model

- A **business** is a tenant. `business_members` links Supabase Auth users to
  businesses with a role: `owner`, `admin` (manage), `agent` (read, handle
  conversations).
- Every tenant table has `business_id`. Child tables reference parents with
  composite `(id, business_id)` foreign keys, so a row cannot point at another
  tenant's customer, conversation, order or product.
- `business_integrations (provider, phone_number_id)` is unique: one WhatsApp
  number maps to exactly one business. Only the operator (service role) can
  write it. Webhooks resolve the tenant through this table only.

## Enforcement layers

| Layer | What it does |
| --- | --- |
| Postgres privileges | `anon` has none. `authenticated` gets `select` plus column-level `insert`/`update` only where users may write. Operator-controlled columns (`status`, limits, `currency`, `business_id`) are not writable. |
| RLS | Every table enabled. Policies call `private.is_member(business_id, roles)`. |
| API handlers | Verify the Supabase session (`auth.getUser`), check membership and role, validate input with Zod (strict: unknown fields such as `business_id` in a body are rejected), then query **as the user** so RLS also applies. Non-members get 404. |
| Functions | Service-only functions have `EXECUTE` revoked from `anon`/`authenticated`. `set_order_status` re-checks membership inside the database. |

The secret key (bypasses RLS) is used only by trusted server flows (webhooks,
AI tools, operator scripts) that resolve the tenant themselves.

## Orders

`create_order_request(business, customer, conversation, idempotency_key, items)`:

- Accepts only product ids and quantities (1–100 each, 1–20 lines). Any price
  or total in the input is ignored.
- Locks the products, requires each to belong to the business, be available,
  not archived and in stock. Another tenant's product is reported as
  `not_found`.
- Computes line totals and the total from database prices, snapshots product
  name and unit price, and inserts the order and items in one transaction.
- Always creates `pending_confirmation`. The idempotency key (the source
  WhatsApp message id) is unique per business; a replay returns the original
  order with `created: false`.

`set_order_status(order, status)` (owner/admin): `pending_confirmation →
confirmed | cancelled`, `confirmed → fulfilled | cancelled`. Confirming
re-checks and decrements tracked stock; cancelling a confirmed order restores
it. `payment_status` is never set by the AI.

## Tests

`tests/db/*.test.ts` run the real migrations on PGlite (Postgres compiled to
WebAssembly, no server needed) with a small shim for Supabase's `auth` schema
and roles (`tests/db/supabase-shim.sql`). They cover anonymous access,
cross-tenant reads and writes, role limits, column grants, composite foreign
keys, idempotent orders, server-side totals, unavailable/archived/out-of-stock
products and order status transitions.

The migrations were also applied to PostgreSQL 16. Supabase runs 15 or 17;
re-run them on a Supabase dev project before production.

## Onboarding a client

```bash
npm run onboard -- --email owner@client.com --business "Client Shop" \
  --currency UGX --timezone Africa/Kampala --phone-number-id <id>   # dry run
npm run onboard -- ... --confirm                                    # apply
```

Invites the owner if needed, creates the business and owner membership
atomically, and maps the WhatsApp phone-number id.

## Backups

Free-tier projects have no downloadable automatic backups. Before migrations on
production, run `npx supabase@2.120.0 db dump --linked -f backup.sql` (and
`--data-only` for data) and store the files outside the repository.
