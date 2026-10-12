-- Data access for the AI agent (service role only). The business and
-- conversation always come from trusted server context, never from the model.

-- ---------------------------------------------------------------------------
-- search_products_for_ai: catalogue lookup for the search_products tool.
-- Returns non-archived products of one business, best matches first.
-- Unavailable products are included (flagged) so the agent can say so
-- instead of claiming they do not exist.
-- ---------------------------------------------------------------------------
create or replace function public.search_products_for_ai(
  p_business_id uuid,
  p_query text,
  p_limit integer default 5
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with words as (
    select distinct replace(replace(replace(w, '\', '\\'), '%', '\%'), '_', '\_') as w
    from regexp_split_to_table(lower(left(coalesce(p_query, ''), 100)), '[^[:alnum:]]+') as w
    where char_length(w) >= 2
    limit 8
  ),
  scored as (
    select
      p.*,
      (select count(*) from words where lower(p.name) like '%' || words.w || '%') * 3
      + (select count(*) from words where lower(coalesce(p.category, '') || ' ' || coalesce(p.sku, '')) like '%' || words.w || '%') * 2
      + (select count(*) from words where lower(p.description) like '%' || words.w || '%') as score
    from public.products p
    where p.business_id = p_business_id and p.archived_at is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', s.id,
    'name', s.name,
    'kind', s.kind,
    'description', left(s.description, 300),
    'category', s.category,
    'price_minor', s.price_minor,
    'available', s.is_available and (s.stock_quantity is null or s.stock_quantity > 0)
  ) order by s.score desc, s.name), '[]'::jsonb)
  from (
    select * from scored
    where not exists (select 1 from words) or score > 0
    order by score desc, name
    limit least(greatest(coalesce(p_limit, 5), 1), 10)
  ) s;
$$;

-- ---------------------------------------------------------------------------
-- get_ai_context: everything the agent needs for one reply, in one call.
-- ---------------------------------------------------------------------------
create or replace function public.get_ai_context(
  p_business_id uuid,
  p_conversation_id uuid,
  p_message_limit integer default 20
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'business', jsonb_build_object(
      'name', b.name,
      'description', b.description,
      'ai_knowledge', b.ai_knowledge,
      'ai_enabled', b.ai_enabled,
      'status', b.status,
      'currency', b.currency,
      'timezone', b.timezone,
      'handover_message', b.handover_message,
      'monthly_ai_request_limit', b.monthly_ai_request_limit
    ),
    'conversation_status', c.status,
    'ai_requests_this_month', (
      select count(*) from public.usage_records u
      where u.business_id = b.id and u.kind = 'ai_request' and u.created_at >= date_trunc('month', now())
    ),
    'ai_replies_last_hour', (
      select count(*) from public.messages m
      where m.business_id = b.id and m.conversation_id = c.id and m.sender = 'ai'
        and m.created_at >= now() - interval '1 hour'
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('direction', x.direction, 'sender', x.sender, 'body', x.body) order by x.created_at, x.id)
      from (
        select m.direction, m.sender, m.body, m.created_at, m.id
        from public.messages m
        where m.business_id = b.id and m.conversation_id = c.id and m.status <> 'failed'
        order by m.created_at desc, m.id desc
        limit least(greatest(p_message_limit, 1), 50)
      ) x
    ), '[]'::jsonb)
  )
  from public.businesses b
  join public.conversations c on c.business_id = b.id and c.id = p_conversation_id
  where b.id = p_business_id;
$$;

-- ---------------------------------------------------------------------------
-- record_ai_usage: one row per model request (tokens for cost tracking).
-- ---------------------------------------------------------------------------
create or replace function public.record_ai_usage(
  p_business_id uuid,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.usage_records (business_id, kind, model, input_tokens, output_tokens)
  values (p_business_id, 'ai_request', left(p_model, 100), greatest(coalesce(p_input_tokens, 0), 0), greatest(coalesce(p_output_tokens, 0), 0));
$$;

-- ---------------------------------------------------------------------------
-- request_handover: moves an open conversation to a human.
-- ---------------------------------------------------------------------------
create or replace function public.request_handover(
  p_business_id uuid,
  p_conversation_id uuid,
  p_reason text,
  p_actor text default 'ai'
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated uuid;
  v_message text;
begin
  if p_actor not in ('ai', 'system') then
    raise exception 'invalid_actor' using errcode = '22023';
  end if;

  update public.conversations
  set status = 'handover',
      handover_reason = left(nullif(btrim(p_reason), ''), 500),
      handover_requested_at = now()
  where id = p_conversation_id and business_id = p_business_id and status = 'open'
  returning id into v_updated;

  select handover_message into v_message from public.businesses where id = p_business_id;

  if v_updated is not null then
    insert into public.audit_logs (business_id, actor_type, action, entity_type, entity_id, metadata)
    values (p_business_id, p_actor, 'conversation.handover', 'conversation', v_updated,
            jsonb_build_object('reason', left(p_reason, 500)));
  end if;

  return jsonb_build_object('ok', v_updated is not null, 'handover_message', v_message);
end;
$$;

revoke all on function public.search_products_for_ai(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.get_ai_context(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.record_ai_usage(uuid, text, integer, integer) from public, anon, authenticated;
revoke all on function public.request_handover(uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.search_products_for_ai(uuid, text, integer) to service_role;
grant execute on function public.get_ai_context(uuid, uuid, integer) to service_role;
grant execute on function public.record_ai_usage(uuid, text, integer, integer) to service_role;
grant execute on function public.request_handover(uuid, uuid, text, text) to service_role;
