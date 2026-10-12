-- WhatsApp messaging: durable webhook inbox, inbound/outbound messages,
-- delivery statuses. All functions are for trusted server code only
-- (service role). They take the business id that the server resolved from
-- the verified webhook (or from an authorized dashboard request) and always
-- scope every statement to it.

-- At most one active WhatsApp number per business keeps outbound routing
-- unambiguous.
create unique index business_integrations_one_active_whatsapp
  on public.business_integrations (business_id)
  where provider = 'whatsapp' and status = 'active';

-- ---------------------------------------------------------------------------
-- tenant resolution
-- ---------------------------------------------------------------------------
create or replace function public.resolve_whatsapp_business(p_phone_number_id text)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select i.business_id
  from public.business_integrations i
  join public.businesses b on b.id = i.business_id
  where i.provider = 'whatsapp'
    and i.phone_number_id = p_phone_number_id
    and i.status = 'active'
    and b.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- webhook inbox
-- ---------------------------------------------------------------------------

-- p_events: [{business_id|null, event_key, event_type, payload}]
-- Inserts new events and skips ones already stored. Returns the ids of the
-- newly inserted events that belong to a business (to process now).
create or replace function public.store_webhook_events(p_events jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with inserted as (
    insert into public.webhook_events (business_id, provider, event_key, event_type, payload, status)
    select
      nullif(e ->> 'business_id', '')::uuid,
      'whatsapp',
      e ->> 'event_key',
      e ->> 'event_type',
      e -> 'payload',
      case when nullif(e ->> 'business_id', '') is null then 'ignored' else 'pending' end
    from jsonb_array_elements(p_events) as e
    on conflict (provider, event_key) do nothing
    returning id, status
  )
  select jsonb_build_object(
    'inserted', (select count(*) from inserted),
    'to_process', coalesce((select jsonb_agg(id) from inserted where status = 'pending'), '[]'::jsonb)
  );
$$;

-- Claims events for processing. A row is claimable when pending, or when a
-- previous attempt failed (after its back-off) or crashed (lock expired).
-- SKIP LOCKED lets concurrent workers share the queue safely.
create or replace function public.claim_webhook_events(
  p_ids jsonb default null,
  p_limit integer default 20,
  p_lock_seconds integer default 120,
  p_max_attempts integer default 5
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with candidates as (
    select id
    from public.webhook_events
    where business_id is not null
      and attempts < p_max_attempts
      and (p_ids is null or id in (select (x #>> '{}')::uuid from jsonb_array_elements(p_ids) x))
      and (
        status = 'pending'
        or (status in ('failed', 'processing') and locked_until < now())
      )
    order by received_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  ),
  claimed as (
    update public.webhook_events e
    set status = 'processing',
        attempts = e.attempts + 1,
        locked_until = now() + make_interval(secs => p_lock_seconds)
    from candidates c
    where e.id = c.id
    returning e.id, e.business_id, e.event_type, e.payload, e.attempts
  )
  select coalesce(jsonb_agg(to_jsonb(claimed) order by claimed.id), '[]'::jsonb) from claimed;
$$;

-- Marks an attempt as finished. Retryable failures back off exponentially;
-- permanent failures (or exhausted attempts) are parked with an infinite
-- lock so they stay visible for investigation but are never retried.
create or replace function public.finish_webhook_event(
  p_id uuid,
  p_ok boolean,
  p_error text default null,
  p_retryable boolean default true,
  p_max_attempts integer default 5
)
returns void
language sql
security invoker
set search_path = ''
as $$
  update public.webhook_events
  set status = case when p_ok then 'processed' else 'failed' end,
      processed_at = case when p_ok then now() else processed_at end,
      last_error = case when p_ok then null else left(p_error, 2000) end,
      locked_until = case
        when p_ok then null
        when p_retryable and attempts < p_max_attempts then now() + make_interval(mins => least(power(2, attempts)::int, 60))
        else 'infinity'::timestamptz
      end
  where id = p_id and status = 'processing';
$$;

-- ---------------------------------------------------------------------------
-- inbound messages
-- ---------------------------------------------------------------------------

-- Records one inbound customer message atomically: customer upsert, active
-- conversation, message (deduplicated by WhatsApp message id), first lead,
-- usage. Returns {duplicate, message_id, conversation_id, customer_id,
-- conversation_status, ai_enabled, business_status}.
create or replace function public.record_inbound_message(
  p_business_id uuid,
  p_wa_id text,
  p_profile_name text,
  p_wa_message_id text,
  p_body text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_customer_id uuid;
  v_conversation_id uuid;
  v_conversation_status text;
  v_message_id uuid;
  v_existing record;
begin
  select m.id, m.conversation_id into v_existing
  from public.messages m
  where m.business_id = p_business_id and m.wa_message_id = p_wa_message_id;
  if found then
    return jsonb_build_object('duplicate', true, 'message_id', v_existing.id, 'conversation_id', v_existing.conversation_id);
  end if;

  insert into public.customers (business_id, wa_id, display_name, last_message_at)
  values (p_business_id, p_wa_id, nullif(left(btrim(p_profile_name), 200), ''), now())
  on conflict (business_id, wa_id) do update
    set display_name = coalesce(excluded.display_name, public.customers.display_name),
        last_message_at = now()
  returning id into v_customer_id;

  select id, status into v_conversation_id, v_conversation_status
  from public.conversations
  where business_id = p_business_id and customer_id = v_customer_id and status <> 'closed'
  for update;

  if not found then
    insert into public.conversations (business_id, customer_id, status, last_message_at)
    values (p_business_id, v_customer_id, 'open', now())
    on conflict (business_id, customer_id) where status <> 'closed' do nothing
    returning id, status into v_conversation_id, v_conversation_status;

    if v_conversation_id is null then
      select id, status into v_conversation_id, v_conversation_status
      from public.conversations
      where business_id = p_business_id and customer_id = v_customer_id and status <> 'closed'
      for update;
    end if;
  end if;

  insert into public.messages (business_id, conversation_id, direction, sender, body, wa_message_id, status)
  values (p_business_id, v_conversation_id, 'inbound', 'customer', left(p_body, 4096), p_wa_message_id, 'received')
  on conflict (business_id, wa_message_id) where wa_message_id is not null do nothing
  returning id into v_message_id;

  if v_message_id is null then
    -- concurrent delivery of the same message won the race
    return jsonb_build_object('duplicate', true, 'conversation_id', v_conversation_id);
  end if;

  update public.conversations set last_message_at = now() where id = v_conversation_id;

  insert into public.leads (business_id, customer_id)
  select p_business_id, v_customer_id
  where not exists (select 1 from public.leads l where l.business_id = p_business_id and l.customer_id = v_customer_id)
  on conflict do nothing;

  insert into public.usage_records (business_id, kind) values (p_business_id, 'whatsapp_inbound');

  return (
    select jsonb_build_object(
      'duplicate', false,
      'message_id', v_message_id,
      'conversation_id', v_conversation_id,
      'customer_id', v_customer_id,
      'conversation_status', v_conversation_status,
      'ai_enabled', b.ai_enabled,
      'business_status', b.status
    )
    from public.businesses b
    where b.id = p_business_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- delivery statuses
-- ---------------------------------------------------------------------------

-- Applies a WhatsApp status to an outbound message. Statuses can arrive out
-- of order, so only forward progress is applied (sent < delivered < read);
-- failed is applied unless the message was already delivered or read.
-- Returns 'updated', 'unchanged' or 'not_found'.
create or replace function public.apply_message_status(
  p_business_id uuid,
  p_wa_message_id text,
  p_status text,
  p_error_code text default null,
  p_error_message text default null
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_id uuid;
  v_current text;
  v_rank_current int;
  v_rank_new int;
begin
  if p_status not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;

  select id, status into v_id, v_current
  from public.messages
  where business_id = p_business_id and wa_message_id = p_wa_message_id and direction = 'outbound'
  for update;
  if not found then
    return 'not_found';
  end if;

  v_rank_current := case v_current when 'queued' then 0 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else -1 end;
  v_rank_new := case p_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else -1 end;

  if p_status = 'failed' then
    if v_current in ('delivered', 'read', 'failed') then
      return 'unchanged';
    end if;
  elsif v_current = 'failed' or v_rank_new <= v_rank_current then
    return 'unchanged';
  end if;

  update public.messages
  set status = p_status,
      status_updated_at = now(),
      error_code = case when p_status = 'failed' then left(p_error_code, 64) else error_code end,
      error_message = case when p_status = 'failed' then left(p_error_message, 1000) else error_message end
  where id = v_id;
  return 'updated';
end;
$$;

-- ---------------------------------------------------------------------------
-- outbound messages
-- ---------------------------------------------------------------------------

-- Reserves an outbound message before calling the Graph API. Checks the
-- business is active, the conversation belongs to it, WhatsApp's 24-hour
-- customer service window is open, and the monthly outbound limit is not
-- reached (serialised per business with a row lock).
-- Returns {ok, message_id, to, phone_number_id} or {ok:false, error}.
create or replace function public.begin_outbound_message(
  p_business_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_sender text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_business public.businesses%rowtype;
  v_wa_id text;
  v_last_inbound timestamptz;
  v_phone_number_id text;
  v_sent_this_month integer;
  v_message_id uuid;
begin
  if p_sender not in ('ai', 'agent', 'system') then
    raise exception 'invalid_sender' using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) = 0 or char_length(p_body) > 4096 then
    raise exception 'invalid_body' using errcode = '22023';
  end if;

  select * into v_business from public.businesses where id = p_business_id for update;
  if not found or v_business.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'business_inactive');
  end if;

  select cu.wa_id, cu.last_message_at into v_wa_id, v_last_inbound
  from public.conversations c
  join public.customers cu on cu.id = c.customer_id and cu.business_id = c.business_id
  where c.id = p_conversation_id and c.business_id = p_business_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'conversation_not_found');
  end if;

  if v_last_inbound is null or v_last_inbound < now() - interval '24 hours' then
    return jsonb_build_object('ok', false, 'error', 'outside_service_window');
  end if;

  select phone_number_id into v_phone_number_id
  from public.business_integrations
  where business_id = p_business_id and provider = 'whatsapp' and status = 'active';
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_whatsapp_integration');
  end if;

  select count(*) into v_sent_this_month
  from public.messages
  where business_id = p_business_id
    and direction = 'outbound'
    and status <> 'failed'
    and created_at >= date_trunc('month', now());
  if v_sent_this_month >= v_business.monthly_outbound_message_limit then
    insert into public.audit_logs (business_id, level, actor_type, action, metadata)
    values (p_business_id, 'warn', 'system', 'limit.outbound_messages',
            jsonb_build_object('limit', v_business.monthly_outbound_message_limit));
    return jsonb_build_object('ok', false, 'error', 'monthly_limit_reached');
  end if;

  insert into public.messages (business_id, conversation_id, direction, sender, body, status)
  values (p_business_id, p_conversation_id, 'outbound', p_sender, p_body, 'queued')
  returning id into v_message_id;

  return jsonb_build_object('ok', true, 'message_id', v_message_id, 'to', v_wa_id, 'phone_number_id', v_phone_number_id);
end;
$$;

-- Records the Graph API result for a reserved outbound message.
create or replace function public.complete_outbound_message(
  p_business_id uuid,
  p_message_id uuid,
  p_wa_message_id text default null,
  p_error_code text default null,
  p_error_message text default null
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_wa_message_id is not null then
    update public.messages
    set wa_message_id = p_wa_message_id, status = 'sent', status_updated_at = now()
    where id = p_message_id and business_id = p_business_id and status = 'queued';

    update public.conversations c
    set last_message_at = now()
    from public.messages m
    where m.id = p_message_id and m.business_id = p_business_id and c.id = m.conversation_id;

    insert into public.usage_records (business_id, kind) values (p_business_id, 'whatsapp_outbound');
  else
    update public.messages
    set status = 'failed', status_updated_at = now(),
        error_code = left(coalesce(p_error_code, 'send_failed'), 64),
        error_message = left(p_error_message, 1000)
    where id = p_message_id and business_id = p_business_id and status = 'queued';

    insert into public.audit_logs (business_id, level, actor_type, action, entity_type, entity_id, metadata)
    values (p_business_id, 'error', 'system', 'whatsapp.send_failed', 'message', p_message_id,
            jsonb_build_object('code', left(p_error_code, 64)));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- error log helper
-- ---------------------------------------------------------------------------
create or replace function public.log_event(
  p_business_id uuid,
  p_level text,
  p_action text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.audit_logs (business_id, level, actor_type, action, metadata)
  values (p_business_id, p_level, 'system', left(p_action, 100), coalesce(p_metadata, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- privileges: service role only
-- ---------------------------------------------------------------------------
revoke all on function public.resolve_whatsapp_business(text) from public, anon, authenticated;
revoke all on function public.store_webhook_events(jsonb) from public, anon, authenticated;
revoke all on function public.claim_webhook_events(jsonb, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.finish_webhook_event(uuid, boolean, text, boolean, integer) from public, anon, authenticated;
revoke all on function public.record_inbound_message(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.apply_message_status(uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.begin_outbound_message(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.complete_outbound_message(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.log_event(uuid, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.resolve_whatsapp_business(text) to service_role;
grant execute on function public.store_webhook_events(jsonb) to service_role;
grant execute on function public.claim_webhook_events(jsonb, integer, integer, integer) to service_role;
grant execute on function public.finish_webhook_event(uuid, boolean, text, boolean, integer) to service_role;
grant execute on function public.record_inbound_message(uuid, text, text, text, text) to service_role;
grant execute on function public.apply_message_status(uuid, text, text, text, text) to service_role;
grant execute on function public.begin_outbound_message(uuid, uuid, text, text) to service_role;
grant execute on function public.complete_outbound_message(uuid, uuid, text, text, text) to service_role;
grant execute on function public.log_event(uuid, text, text, jsonb) to service_role;
