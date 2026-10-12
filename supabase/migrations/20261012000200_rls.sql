-- Row-level security and privileges.
--
-- Model:
--   anon           no access to any table.
--   authenticated  dashboard users. Can read data of businesses they are a
--                  member of; writes are limited by role and by column
--                  grants (business_id, limits, status, prices of past
--                  orders etc. cannot be changed by users).
--   service_role   server code (webhooks, AI tools, operator scripts).
--                  Bypasses RLS, so server code always filters by a tenant
--                  it resolved itself.
--
-- Supabase grants broad default privileges on public tables to anon and
-- authenticated; we revoke them all and grant explicitly.

-- ---------------------------------------------------------------------------
-- membership helper
-- ---------------------------------------------------------------------------
create or replace function private.is_member(p_business_id uuid, p_roles text[] default null)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.business_members m
    where m.business_id = p_business_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any (p_roles))
  );
$$;

revoke all on function private.is_member(uuid, text[]) from public;
grant usage on schema private to authenticated, service_role;
grant execute on function private.is_member(uuid, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- baseline privileges
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

grant usage on schema public to authenticated;

-- ---------------------------------------------------------------------------
-- enable RLS everywhere (also protects against a later accidental grant)
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.business_integrations enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.leads enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.webhook_events enable row level security;
alter table public.usage_records enable row level security;
alter table public.audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- businesses: members read; owners/admins edit profile fields only
-- ---------------------------------------------------------------------------
grant select on public.businesses to authenticated;
grant update (name, description, ai_knowledge, ai_enabled, handover_message, timezone)
  on public.businesses to authenticated;

create policy businesses_select on public.businesses
  for select to authenticated
  using ((select private.is_member(id)));

create policy businesses_update on public.businesses
  for update to authenticated
  using ((select private.is_member(id, array['owner', 'admin'])))
  with check ((select private.is_member(id, array['owner', 'admin'])));

-- ---------------------------------------------------------------------------
-- business_members / business_integrations: read-only for members.
-- Managed by the operator (service role).
-- ---------------------------------------------------------------------------
grant select on public.business_members to authenticated;
create policy business_members_select on public.business_members
  for select to authenticated
  using ((select private.is_member(business_id)));

grant select on public.business_integrations to authenticated;
create policy business_integrations_select on public.business_integrations
  for select to authenticated
  using ((select private.is_member(business_id)));

-- ---------------------------------------------------------------------------
-- products: members read; owners/admins write. business_id cannot be
-- changed after insert (no column grant).
-- ---------------------------------------------------------------------------
grant select, delete on public.products to authenticated;
grant insert (business_id, name, description, sku, category, kind, price_minor, is_available, stock_quantity)
  on public.products to authenticated;
grant update (name, description, sku, category, kind, price_minor, is_available, stock_quantity, archived_at)
  on public.products to authenticated;

create policy products_select on public.products
  for select to authenticated
  using ((select private.is_member(business_id)));

create policy products_insert on public.products
  for insert to authenticated
  with check ((select private.is_member(business_id, array['owner', 'admin'])));

create policy products_update on public.products
  for update to authenticated
  using ((select private.is_member(business_id, array['owner', 'admin'])))
  with check ((select private.is_member(business_id, array['owner', 'admin'])));

create policy products_delete on public.products
  for delete to authenticated
  using ((select private.is_member(business_id, array['owner', 'admin'])));

-- ---------------------------------------------------------------------------
-- customers, conversations, messages, orders, order_items: members read.
-- Writes go through server code or security-definer functions.
-- ---------------------------------------------------------------------------
grant select on public.customers to authenticated;
create policy customers_select on public.customers
  for select to authenticated
  using ((select private.is_member(business_id)));

grant select on public.conversations to authenticated;
grant update (status) on public.conversations to authenticated;
create policy conversations_select on public.conversations
  for select to authenticated
  using ((select private.is_member(business_id)));
create policy conversations_update on public.conversations
  for update to authenticated
  using ((select private.is_member(business_id)))
  with check ((select private.is_member(business_id)));

grant select on public.messages to authenticated;
create policy messages_select on public.messages
  for select to authenticated
  using ((select private.is_member(business_id)));

grant select on public.orders to authenticated;
create policy orders_select on public.orders
  for select to authenticated
  using ((select private.is_member(business_id)));

grant select on public.order_items to authenticated;
create policy order_items_select on public.order_items
  for select to authenticated
  using ((select private.is_member(business_id)));

-- ---------------------------------------------------------------------------
-- leads: members read and update status/notes
-- ---------------------------------------------------------------------------
grant select on public.leads to authenticated;
grant update (status, notes) on public.leads to authenticated;
create policy leads_select on public.leads
  for select to authenticated
  using ((select private.is_member(business_id)));
create policy leads_update on public.leads
  for update to authenticated
  using ((select private.is_member(business_id)))
  with check ((select private.is_member(business_id)));

-- ---------------------------------------------------------------------------
-- operational tables: owners/admins read their own business's rows
-- ---------------------------------------------------------------------------
grant select on public.webhook_events to authenticated;
create policy webhook_events_select on public.webhook_events
  for select to authenticated
  using (business_id is not null and (select private.is_member(business_id, array['owner', 'admin'])));

grant select on public.usage_records to authenticated;
create policy usage_records_select on public.usage_records
  for select to authenticated
  using ((select private.is_member(business_id)));

grant select on public.audit_logs to authenticated;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (business_id is not null and (select private.is_member(business_id, array['owner', 'admin'])));
