-- Database functions for operations that must be atomic.
--
-- Supabase grants EXECUTE on new public functions to anon and authenticated
-- by default, so every function below revokes explicitly and grants only
-- to the role that should call it.

-- ---------------------------------------------------------------------------
-- create_business_with_owner: operator onboarding (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.create_business_with_owner(
  p_name text,
  p_owner_user_id uuid,
  p_currency text default 'USD',
  p_timezone text default 'UTC'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_business_id uuid;
begin
  insert into public.businesses (name, currency, timezone)
  values (btrim(p_name), upper(p_currency), p_timezone)
  returning id into v_business_id;

  insert into public.business_members (business_id, user_id, role)
  values (v_business_id, p_owner_user_id, 'owner');

  insert into public.audit_logs (business_id, actor_type, action, entity_type, entity_id, metadata)
  values (v_business_id, 'operator', 'business.created', 'business', v_business_id,
          jsonb_build_object('owner_user_id', p_owner_user_id));

  return v_business_id;
end;
$$;

revoke all on function public.create_business_with_owner(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.create_business_with_owner(text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- create_order_request: atomic, idempotent order creation (service role only)
--
-- The caller (trusted server code) passes the business it resolved from the
-- verified webhook. Product ids and quantities come from the AI tool call
-- and are treated as untrusted: every product is re-read and locked, must
-- belong to the business, be available and in stock. Prices and totals are
-- computed here from the database. The order is always created as
-- pending_confirmation.
--
-- p_items: [{"product_id": "<uuid>", "quantity": <int 1..100>}, ...] (1..20)
--
-- Returns jsonb:
--   {"ok": true, "created": bool, "order": {...}}
--   {"ok": false, "error": "business_inactive"}
--   {"ok": false, "error": "items_unavailable", "not_found": [...],
--    "unavailable": [...], "insufficient_stock": [...]}
-- ---------------------------------------------------------------------------
create or replace function private.order_summary(p_order_id uuid, p_created boolean)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'ok', true,
    'created', p_created,
    'order', jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'payment_status', o.payment_status,
      'currency', o.currency,
      'subtotal_minor', o.subtotal_minor,
      'total_minor', o.total_minor,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'product_id', i.product_id,
          'product_name', i.product_name,
          'quantity', i.quantity,
          'unit_price_minor', i.unit_price_minor,
          'line_total_minor', i.line_total_minor
        ) order by i.product_name)
        from public.order_items i
        where i.order_id = o.id
      ), '[]'::jsonb)
    )
  )
  from public.orders o
  where o.id = p_order_id;
$$;

revoke all on function private.order_summary(uuid, boolean) from public;
grant execute on function private.order_summary(uuid, boolean) to service_role;

create or replace function public.create_order_request(
  p_business_id uuid,
  p_customer_id uuid,
  p_conversation_id uuid,
  p_idempotency_key text,
  p_items jsonb,
  p_customer_note text default '',
  p_source text default 'whatsapp_ai'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_currency text;
  v_existing_id uuid;
  v_order_id uuid;
  v_ids uuid[];
  v_qtys integer[];
  v_not_found uuid[];
  v_unavailable uuid[];
  v_insufficient uuid[];
  v_subtotal bigint;
begin
  if p_business_id is null or p_customer_id is null or p_idempotency_key is null then
    raise exception 'missing_argument' using errcode = '22023';
  end if;

  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) not between 1 and 20 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  -- Replay of an already-processed request returns the original order.
  select id into v_existing_id
  from public.orders
  where business_id = p_business_id and idempotency_key = p_idempotency_key;
  if found then
    return private.order_summary(v_existing_id, false);
  end if;

  select currency into v_currency
  from public.businesses
  where id = p_business_id and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'business_inactive');
  end if;

  -- Normalise items: merge duplicate product ids, sorted for stable locking.
  select array_agg(product_id order by product_id), array_agg(quantity order by product_id)
  into v_ids, v_qtys
  from (
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::integer)::integer as quantity
    from jsonb_array_elements(p_items) as e
    group by 1
  ) s;

  if exists (select 1 from unnest(v_qtys) q where q is null or q not between 1 and 100)
     or exists (select 1 from unnest(v_ids) i where i is null) then
    raise exception 'invalid_items' using errcode = '22023';
  end if;

  -- Lock this business's requested products in a stable order.
  perform 1
  from public.products
  where business_id = p_business_id and id = any (v_ids)
  order by id
  for update;

  select
    coalesce(array_agg(r.product_id) filter (where p.id is null), '{}'),
    coalesce(array_agg(r.product_id) filter (
      where p.id is not null and (not p.is_available or p.archived_at is not null)), '{}'),
    coalesce(array_agg(r.product_id) filter (
      where p.id is not null and p.is_available and p.archived_at is null
        and p.stock_quantity is not null and p.stock_quantity < r.quantity), '{}'),
    sum(p.price_minor * r.quantity)
  into v_not_found, v_unavailable, v_insufficient, v_subtotal
  from unnest(v_ids, v_qtys) as r (product_id, quantity)
  left join public.products p on p.id = r.product_id and p.business_id = p_business_id;

  if cardinality(v_not_found) + cardinality(v_unavailable) + cardinality(v_insufficient) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'items_unavailable',
      'not_found', to_jsonb(v_not_found),
      'unavailable', to_jsonb(v_unavailable),
      'insufficient_stock', to_jsonb(v_insufficient)
    );
  end if;

  insert into public.orders (
    business_id, customer_id, conversation_id, status, currency,
    subtotal_minor, total_minor, source, idempotency_key, customer_note
  )
  values (
    p_business_id, p_customer_id, p_conversation_id, 'pending_confirmation', v_currency,
    v_subtotal, v_subtotal, p_source, p_idempotency_key, coalesce(left(p_customer_note, 1000), '')
  )
  on conflict (business_id, idempotency_key) do nothing
  returning id into v_order_id;

  if v_order_id is null then
    -- A concurrent call with the same key won the race.
    select id into v_existing_id
    from public.orders
    where business_id = p_business_id and idempotency_key = p_idempotency_key;
    return private.order_summary(v_existing_id, false);
  end if;

  insert into public.order_items (
    business_id, order_id, product_id, product_name, unit_price_minor, quantity, line_total_minor
  )
  select p_business_id, v_order_id, p.id, p.name, p.price_minor, r.quantity, p.price_minor * r.quantity
  from unnest(v_ids, v_qtys) as r (product_id, quantity)
  join public.products p on p.id = r.product_id and p.business_id = p_business_id;

  insert into public.audit_logs (business_id, actor_type, action, entity_type, entity_id, metadata)
  values (p_business_id, case when p_source = 'whatsapp_ai' then 'ai' else 'system' end,
          'order.requested', 'order', v_order_id,
          jsonb_build_object('total_minor', v_subtotal, 'currency', v_currency));

  return private.order_summary(v_order_id, true);
end;
$$;

revoke all on function public.create_order_request(uuid, uuid, uuid, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.create_order_request(uuid, uuid, uuid, text, jsonb, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- set_order_status: owner/admin moves an order through its lifecycle.
--   pending_confirmation -> confirmed | cancelled
--   confirmed            -> fulfilled | cancelled
-- Confirming reserves tracked stock; cancelling a confirmed order releases it.
-- ---------------------------------------------------------------------------
create or replace function public.set_order_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
  v_insufficient uuid[];
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  -- Not found and not a member look the same to the caller.
  if not found or not private.is_member(v_order.business_id, array['owner', 'admin']) then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if not (
    (v_order.status = 'pending_confirmation' and p_status in ('confirmed', 'cancelled'))
    or (v_order.status = 'confirmed' and p_status in ('fulfilled', 'cancelled'))
  ) then
    raise exception 'invalid_transition' using errcode = '22023';
  end if;

  if p_status = 'confirmed' then
    perform 1
    from public.products p
    join public.order_items i on i.product_id = p.id and i.business_id = p.business_id
    where i.order_id = v_order.id
    order by p.id
    for update of p;

    select coalesce(array_agg(p.id), '{}') into v_insufficient
    from public.order_items i
    join public.products p on p.id = i.product_id and p.business_id = i.business_id
    where i.order_id = v_order.id
      and p.stock_quantity is not null
      and p.stock_quantity < i.quantity;

    if cardinality(v_insufficient) > 0 then
      return jsonb_build_object('ok', false, 'error', 'insufficient_stock', 'product_ids', to_jsonb(v_insufficient));
    end if;

    update public.products p
    set stock_quantity = p.stock_quantity - i.quantity
    from public.order_items i
    where i.order_id = v_order.id
      and p.id = i.product_id
      and p.business_id = i.business_id
      and p.stock_quantity is not null;

    update public.orders
    set status = 'confirmed', confirmed_by = v_uid, confirmed_at = now()
    where id = v_order.id;
  elsif p_status = 'cancelled' then
    if v_order.status = 'confirmed' then
      update public.products p
      set stock_quantity = p.stock_quantity + i.quantity
      from public.order_items i
      where i.order_id = v_order.id
        and p.id = i.product_id
        and p.business_id = i.business_id
        and p.stock_quantity is not null;
    end if;
    update public.orders set status = 'cancelled', cancelled_at = now() where id = v_order.id;
  else
    update public.orders set status = p_status where id = v_order.id;
  end if;

  insert into public.audit_logs (business_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (v_order.business_id, 'user', v_uid, 'order.' || p_status, 'order', v_order.id,
          jsonb_build_object('from', v_order.status));

  return jsonb_build_object('ok', true, 'order_id', v_order.id, 'status', p_status);
end;
$$;

revoke all on function public.set_order_status(uuid, text) from public, anon;
grant execute on function public.set_order_status(uuid, text) to authenticated, service_role;
