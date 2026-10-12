-- Core schema for Hotzonex Agent.
--
-- Tenant integrity: every tenant-owned table carries business_id, and child
-- rows reference parents through composite (id, business_id) foreign keys,
-- so a row can never point at another tenant's data even if application
-- code passes a wrong id.
--
-- Money is stored as integer minor units (e.g. cents) in the business
-- currency. Prices are never stored or computed as floating point.

create schema if not exists private;

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- businesses
-- ---------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  -- Approved facts the AI may use (opening hours, delivery areas, policies).
  ai_knowledge text not null default '' check (char_length(ai_knowledge) <= 8000),
  ai_enabled boolean not null default true,
  handover_message text not null default 'Thanks, a member of our team will reply shortly.'
    check (char_length(handover_message) between 1 and 1000),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  timezone text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  status text not null default 'active' check (status in ('active', 'suspended')),
  monthly_ai_request_limit integer not null default 2000 check (monthly_ai_request_limit between 0 and 1000000),
  monthly_outbound_message_limit integer not null default 2000 check (monthly_outbound_message_limit between 0 and 1000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger businesses_updated_at before update on public.businesses
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- business_members: which auth users can access which business
-- ---------------------------------------------------------------------------
create table public.business_members (
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'agent')),
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);

create index business_members_user_id_idx on public.business_members (user_id);

-- ---------------------------------------------------------------------------
-- business_integrations: trusted mapping from a WhatsApp phone-number id to
-- exactly one business. Written only by the operator (service role).
-- Access tokens are NOT stored here.
-- ---------------------------------------------------------------------------
create table public.business_integrations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  provider text not null check (provider in ('whatsapp')),
  phone_number_id text not null check (phone_number_id ~ '^[0-9]{5,32}$'),
  display_phone_number text check (char_length(display_phone_number) <= 32),
  waba_id text check (waba_id ~ '^[0-9]{5,32}$'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, phone_number_id)
);

create index business_integrations_business_id_idx on public.business_integrations (business_id);

create trigger business_integrations_updated_at before update on public.business_integrations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- products (products and services)
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  sku text check (char_length(sku) between 1 and 64),
  category text check (char_length(category) <= 80),
  kind text not null default 'product' check (kind in ('product', 'service')),
  price_minor bigint not null check (price_minor >= 0 and price_minor <= 100000000000),
  is_available boolean not null default true,
  -- null means stock is not tracked
  stock_quantity integer check (stock_quantity >= 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id)
);

create unique index products_business_sku_key on public.products (business_id, sku) where sku is not null;
create index products_business_listing_idx on public.products (business_id, archived_at, is_available);
create index products_business_name_idx on public.products (business_id, lower(name));

create trigger products_updated_at before update on public.products
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- customers (WhatsApp contacts of a business)
-- ---------------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  wa_id text not null check (wa_id ~ '^[0-9]{5,32}$'),
  display_name text check (char_length(display_name) <= 200),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, wa_id),
  unique (id, business_id)
);

create trigger customers_updated_at before update on public.customers
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  status text not null default 'new' check (status in ('new', 'contacted', 'qualified', 'won', 'lost')),
  source text not null default 'whatsapp' check (source in ('whatsapp', 'manual')),
  notes text not null default '' check (char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (customer_id, business_id) references public.customers (id, business_id) on delete cascade
);

create index leads_business_status_idx on public.leads (business_id, status, created_at desc);
create index leads_customer_idx on public.leads (customer_id);
-- at most one open lead per customer
create unique index leads_one_open_per_customer on public.leads (business_id, customer_id)
  where status in ('new', 'contacted', 'qualified');

create trigger leads_updated_at before update on public.leads
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  status text not null default 'open' check (status in ('open', 'handover', 'closed')),
  handover_reason text check (char_length(handover_reason) <= 500),
  handover_requested_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, business_id),
  foreign key (customer_id, business_id) references public.customers (id, business_id) on delete cascade
);

-- at most one active conversation per customer
create unique index conversations_one_active_per_customer on public.conversations (business_id, customer_id)
  where status <> 'closed';
create index conversations_business_recent_idx on public.conversations (business_id, last_message_at desc nulls last);

create trigger conversations_updated_at before update on public.conversations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender text not null check (sender in ('customer', 'ai', 'agent', 'system')),
  body text not null check (char_length(body) <= 4096),
  -- WhatsApp message id (wamid.*), used for dedupe and delivery statuses
  wa_message_id text check (char_length(wa_message_id) between 1 and 256),
  status text not null check (status in ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
  error_code text check (char_length(error_code) <= 64),
  error_message text check (char_length(error_message) <= 1000),
  status_updated_at timestamptz,
  created_at timestamptz not null default now(),
  check ((direction = 'inbound') = (sender = 'customer')),
  foreign key (conversation_id, business_id) references public.conversations (id, business_id) on delete cascade
);

create unique index messages_business_wa_message_id_key on public.messages (business_id, wa_message_id)
  where wa_message_id is not null;
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- orders and order_items
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  conversation_id uuid,
  status text not null default 'pending_confirmation'
    check (status in ('pending_confirmation', 'confirmed', 'cancelled', 'fulfilled')),
  -- Only a business member may set this, from evidence outside the AI.
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'refunded')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_minor bigint not null check (subtotal_minor >= 0),
  total_minor bigint not null check (total_minor >= 0),
  source text not null check (source in ('whatsapp_ai', 'dashboard')),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 200),
  customer_note text not null default '' check (char_length(customer_note) <= 1000),
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, idempotency_key),
  unique (id, business_id),
  foreign key (customer_id, business_id) references public.customers (id, business_id) on delete restrict,
  foreign key (conversation_id, business_id) references public.conversations (id, business_id) on delete set null (conversation_id)
);

create index orders_business_status_idx on public.orders (business_id, status, created_at desc);
create index orders_customer_idx on public.orders (customer_id);

create trigger orders_updated_at before update on public.orders
  for each row execute function private.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  -- snapshot at order time; later product edits do not change history
  product_name text not null check (char_length(product_name) between 1 and 200),
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null check (quantity between 1 and 1000),
  line_total_minor bigint not null,
  check (line_total_minor = unit_price_minor * quantity),
  unique (order_id, product_id),
  foreign key (order_id, business_id) references public.orders (id, business_id) on delete cascade,
  foreign key (product_id, business_id) references public.products (id, business_id) on delete restrict
);

create index order_items_product_idx on public.order_items (product_id);

-- ---------------------------------------------------------------------------
-- webhook_events: durable inbox for verified provider events
-- ---------------------------------------------------------------------------
create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  -- null when the phone-number id is not mapped to any business
  business_id uuid references public.businesses (id) on delete cascade,
  provider text not null check (provider in ('whatsapp')),
  -- provider-unique key, e.g. message wamid or status id + status
  event_key text not null check (char_length(event_key) between 1 and 300),
  event_type text not null check (event_type in ('message', 'status', 'other')),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text check (char_length(last_error) <= 2000),
  locked_until timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, event_key)
);

create index webhook_events_retry_idx on public.webhook_events (status, received_at)
  where status in ('pending', 'failed', 'processing');
create index webhook_events_business_idx on public.webhook_events (business_id, received_at desc);

-- ---------------------------------------------------------------------------
-- usage_records: metering for per-business limits and cost tracking
-- ---------------------------------------------------------------------------
create table public.usage_records (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('ai_request', 'whatsapp_outbound', 'whatsapp_inbound')),
  model text check (char_length(model) <= 100),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  quantity integer not null default 1 check (quantity >= 0),
  created_at timestamptz not null default now()
);

create index usage_records_business_kind_created_idx on public.usage_records (business_id, kind, created_at);

-- ---------------------------------------------------------------------------
-- audit_logs: security-relevant actions and errors
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  business_id uuid references public.businesses (id) on delete cascade,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  actor_type text not null check (actor_type in ('user', 'system', 'ai', 'webhook', 'operator')),
  actor_id uuid,
  action text not null check (char_length(action) between 1 and 100),
  entity_type text check (char_length(entity_type) <= 50),
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_logs_business_created_idx on public.audit_logs (business_id, created_at desc);
