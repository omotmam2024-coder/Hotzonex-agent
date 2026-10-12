-- Dashboard read models and actions, called with the signed-in user's JWT.
-- SECURITY INVOKER: every query below is filtered by RLS, so a user only ever
-- sees businesses they are a member of. The explicit business_id filters
-- are for correctness and index use, not for authorization.

-- ---------------------------------------------------------------------------
-- my_business_role: the caller's role in a business, or null.
-- ---------------------------------------------------------------------------
create or replace function public.my_business_role(p_business_id uuid)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select role from public.business_members
  where business_id = p_business_id and user_id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- dashboard_overview
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_overview(p_business_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'conversations_open', (select count(*) from public.conversations where business_id = b.id and status = 'open'),
    'conversations_handover', (select count(*) from public.conversations where business_id = b.id and status = 'handover'),
    'orders_pending', (select count(*) from public.orders where business_id = b.id and status = 'pending_confirmation'),
    'orders_confirmed_this_month', (
      select count(*) from public.orders
      where business_id = b.id and status in ('confirmed', 'fulfilled') and confirmed_at >= date_trunc('month', now())
    ),
    'leads_new', (select count(*) from public.leads where business_id = b.id and status = 'new'),
    'customers_total', (select count(*) from public.customers where business_id = b.id),
    'messages_in_this_month', (
      select count(*) from public.usage_records
      where business_id = b.id and kind = 'whatsapp_inbound' and created_at >= date_trunc('month', now())
    ),
    'messages_out_this_month', (
      select count(*) from public.messages
      where business_id = b.id and direction = 'outbound' and status <> 'failed' and created_at >= date_trunc('month', now())
    ),
    'ai_requests_this_month', (
      select count(*) from public.usage_records
      where business_id = b.id and kind = 'ai_request' and created_at >= date_trunc('month', now())
    ),
    'ai_tokens_this_month', (
      select coalesce(sum(input_tokens + output_tokens), 0) from public.usage_records
      where business_id = b.id and kind = 'ai_request' and created_at >= date_trunc('month', now())
    ),
    'monthly_ai_request_limit', b.monthly_ai_request_limit,
    'monthly_outbound_message_limit', b.monthly_outbound_message_limit,
    'whatsapp_connected', exists (
      select 1 from public.business_integrations
      where business_id = b.id and provider = 'whatsapp' and status = 'active'
    ),
    'ai_enabled', b.ai_enabled,
    'recent_errors', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'created_at', a.created_at) order by a.created_at desc)
      from (
        select action, created_at from public.audit_logs
        where business_id = b.id and level = 'error' and created_at >= now() - interval '7 days'
        order by created_at desc limit 5
      ) a
    ), '[]'::jsonb)
  )
  from public.businesses b
  where b.id = p_business_id;
$$;

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
create or replace function public.list_conversations(
  p_business_id uuid,
  p_status text default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(row order by sort_key desc nulls last), '[]'::jsonb)
  from (
    select
      c.last_message_at as sort_key,
      jsonb_build_object(
        'id', c.id,
        'status', c.status,
        'handover_reason', c.handover_reason,
        'last_message_at', c.last_message_at,
        'created_at', c.created_at,
        'customer', jsonb_build_object('id', cu.id, 'name', cu.display_name, 'wa_id', cu.wa_id),
        'last_message', (
          select jsonb_build_object('body', left(m.body, 140), 'direction', m.direction, 'sender', m.sender)
          from public.messages m
          where m.conversation_id = c.id and m.business_id = c.business_id
          order by m.created_at desc, m.id desc
          limit 1
        )
      ) as row
    from public.conversations c
    join public.customers cu on cu.id = c.customer_id and cu.business_id = c.business_id
    where c.business_id = p_business_id
      and (p_status is null or c.status = p_status)
    order by c.last_message_at desc nulls last
    limit least(greatest(coalesce(p_limit, 50), 1), 200)
  ) x;
$$;

create or replace function public.get_conversation(p_business_id uuid, p_conversation_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'status', c.status,
    'handover_reason', c.handover_reason,
    'handover_requested_at', c.handover_requested_at,
    'last_message_at', c.last_message_at,
    'customer', jsonb_build_object(
      'id', cu.id, 'name', cu.display_name, 'wa_id', cu.wa_id, 'last_message_at', cu.last_message_at
    ),
    'can_reply', cu.last_message_at is not null and cu.last_message_at >= now() - interval '24 hours',
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'direction', m.direction, 'sender', m.sender, 'body', m.body,
        'status', m.status, 'error_code', m.error_code, 'created_at', m.created_at
      ) order by m.created_at, m.id)
      from (
        select * from public.messages
        where conversation_id = c.id and business_id = c.business_id
        order by created_at desc, id desc
        limit 200
      ) m
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'total_minor', o.total_minor, 'currency', o.currency, 'created_at', o.created_at)
        order by o.created_at desc)
      from public.orders o
      where o.conversation_id = c.id and o.business_id = c.business_id
    ), '[]'::jsonb)
  )
  from public.conversations c
  join public.customers cu on cu.id = c.customer_id and cu.business_id = c.business_id
  where c.business_id = p_business_id and c.id = p_conversation_id;
$$;

-- open <-> handover; open|handover -> closed. Closed is final (a new
-- customer message starts a new conversation).
create or replace function public.set_conversation_status(p_business_id uuid, p_conversation_id uuid, p_status text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_current text;
begin
  if p_status not in ('open', 'handover', 'closed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select status into v_current from public.conversations
  where id = p_conversation_id and business_id = p_business_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_current = 'closed' or v_current = p_status then
    return jsonb_build_object('ok', false, 'error', 'invalid_transition');
  end if;

  update public.conversations set status = p_status
  where id = p_conversation_id and business_id = p_business_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'status', p_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- customers and leads
-- ---------------------------------------------------------------------------
create or replace function public.list_customers(p_business_id uuid, p_query text default null, p_limit integer default 100)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(row order by sort_key desc nulls last), '[]'::jsonb)
  from (
    select
      cu.last_message_at as sort_key,
      jsonb_build_object(
        'id', cu.id,
        'name', cu.display_name,
        'wa_id', cu.wa_id,
        'last_message_at', cu.last_message_at,
        'created_at', cu.created_at,
        'orders_count', (select count(*) from public.orders o where o.customer_id = cu.id and o.business_id = cu.business_id),
        'lead', (
          select jsonb_build_object('id', l.id, 'status', l.status, 'notes', l.notes, 'updated_at', l.updated_at)
          from public.leads l
          where l.customer_id = cu.id and l.business_id = cu.business_id
          order by l.created_at desc
          limit 1
        )
      ) as row
    from public.customers cu
    where cu.business_id = p_business_id
      and (
        p_query is null or btrim(p_query) = ''
        or cu.display_name ilike '%' || replace(replace(replace(left(p_query, 100), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        or cu.wa_id like '%' || regexp_replace(left(p_query, 32), '[^0-9]', '', 'g') || '%' and regexp_replace(p_query, '[^0-9]', '', 'g') <> ''
      )
    order by cu.last_message_at desc nulls last
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) x;
$$;

create or replace function public.update_lead(p_business_id uuid, p_lead_id uuid, p_status text, p_notes text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.leads
  set status = coalesce(p_status, status),
      notes = coalesce(p_notes, notes)
  where id = p_lead_id and business_id = p_business_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
create or replace function public.list_orders(p_business_id uuid, p_status text default null, p_limit integer default 100)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(row order by sort_key desc), '[]'::jsonb)
  from (
    select
      o.created_at as sort_key,
      jsonb_build_object(
        'id', o.id,
        'status', o.status,
        'payment_status', o.payment_status,
        'currency', o.currency,
        'total_minor', o.total_minor,
        'source', o.source,
        'customer_note', o.customer_note,
        'conversation_id', o.conversation_id,
        'created_at', o.created_at,
        'confirmed_at', o.confirmed_at,
        'customer', jsonb_build_object('id', cu.id, 'name', cu.display_name, 'wa_id', cu.wa_id),
        'items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'product_name', i.product_name, 'quantity', i.quantity,
            'unit_price_minor', i.unit_price_minor, 'line_total_minor', i.line_total_minor
          ) order by i.product_name)
          from public.order_items i where i.order_id = o.id and i.business_id = o.business_id
        ), '[]'::jsonb)
      ) as row
    from public.orders o
    join public.customers cu on cu.id = o.customer_id and cu.business_id = o.business_id
    where o.business_id = p_business_id
      and (p_status is null or o.status = p_status)
    order by o.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500)
  ) x;
$$;

-- Payment is recorded by a person who checked it outside this system.
create or replace function public.set_order_payment_status(p_order_id uuid, p_payment_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_order public.orders%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_payment_status not in ('unpaid', 'paid', 'refunded') then
    raise exception 'invalid_payment_status' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found or not private.is_member(v_order.business_id, array['owner', 'admin']) then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;
  if v_order.status not in ('confirmed', 'fulfilled') then
    return jsonb_build_object('ok', false, 'error', 'order_not_confirmed');
  end if;

  update public.orders set payment_status = p_payment_status where id = v_order.id;
  insert into public.audit_logs (business_id, actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (v_order.business_id, 'user', v_uid, 'order.payment_' || p_payment_status, 'order', v_order.id,
          jsonb_build_object('from', v_order.payment_status));
  return jsonb_build_object('ok', true, 'payment_status', p_payment_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- privileges
-- ---------------------------------------------------------------------------
revoke all on function public.my_business_role(uuid) from public, anon;
revoke all on function public.dashboard_overview(uuid) from public, anon;
revoke all on function public.list_conversations(uuid, text, integer) from public, anon;
revoke all on function public.get_conversation(uuid, uuid) from public, anon;
revoke all on function public.set_conversation_status(uuid, uuid, text) from public, anon;
revoke all on function public.list_customers(uuid, text, integer) from public, anon;
revoke all on function public.update_lead(uuid, uuid, text, text) from public, anon;
revoke all on function public.list_orders(uuid, text, integer) from public, anon;
revoke all on function public.set_order_payment_status(uuid, text) from public, anon;

grant execute on function public.my_business_role(uuid) to authenticated;
grant execute on function public.dashboard_overview(uuid) to authenticated;
grant execute on function public.list_conversations(uuid, text, integer) to authenticated;
grant execute on function public.get_conversation(uuid, uuid) to authenticated;
grant execute on function public.set_conversation_status(uuid, uuid, text) to authenticated;
grant execute on function public.list_customers(uuid, text, integer) to authenticated;
grant execute on function public.update_lead(uuid, uuid, text, text) to authenticated;
grant execute on function public.list_orders(uuid, text, integer) to authenticated;
grant execute on function public.set_order_payment_status(uuid, text) to authenticated;
