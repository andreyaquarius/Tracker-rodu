begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create schema if not exists security_private;
revoke all on schema security_private from public, anon, authenticated, service_role;
grant usage on schema security_private to authenticated, service_role;
revoke create on schema security_private from public, anon, authenticated, service_role;

alter table public.user_genehelp_requests
  add column if not exists provider_updated_at timestamptz;

alter table public.user_genehelp_accounts
  add column if not exists notifications_last_synced_at timestamptz;

create index if not exists user_genehelp_requests_provider_request_idx
  on public.user_genehelp_requests (genehelp_request_id);

create table if not exists security_private.genehelp_integration_events (
  provider_event_id text primary key,
  event_type text not null,
  genehelp_request_id text not null,
  genehelp_user_id text,
  payload_sha256 text not null,
  occurred_at timestamptz not null,
  provider_updated_at timestamptz,
  outcome text not null default 'processing',
  matched_request_row_id uuid references public.user_genehelp_requests(id) on delete set null,
  notification_id uuid,
  received_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  constraint genehelp_integration_events_event_id_length
    check (char_length(provider_event_id) between 1 and 128),
  constraint genehelp_integration_events_event_type_format
    check (
      char_length(event_type) between 1 and 128
      and event_type ~ '^[A-Za-z0-9._:-]+$'
    ),
  constraint genehelp_integration_events_request_id_length
    check (char_length(genehelp_request_id) between 4 and 64),
  constraint genehelp_integration_events_user_id_length
    check (genehelp_user_id is null or char_length(genehelp_user_id) between 1 and 128),
  constraint genehelp_integration_events_payload_hash_format
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint genehelp_integration_events_outcome_allowed
    check (outcome in (
      'processing',
      'applied',
      'duplicate_reply',
      'stale',
      'unmatched',
      'ambiguous'
    ))
);

comment on table security_private.genehelp_integration_events is
  'Transport-neutral idempotency ledger for notifications received from the GeneHelp integration. Raw payloads are deliberately not retained.';

revoke all on table security_private.genehelp_integration_events
  from public, anon, authenticated, service_role;
grant select, insert, update on table security_private.genehelp_integration_events
  to service_role;

create index if not exists genehelp_integration_events_request_received_idx
  on security_private.genehelp_integration_events (genehelp_request_id, received_at desc);

create table if not exists public.user_genehelp_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  genehelp_request_row_id uuid not null
    references public.user_genehelp_requests(id) on delete cascade,
  genehelp_request_id text not null,
  provider_event_id text not null,
  event_type text not null,
  reply_id text,
  title text not null,
  body text not null default '',
  occurred_at timestamptz not null,
  read_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint user_genehelp_notifications_provider_event_unique
    unique (provider_event_id),
  constraint user_genehelp_notifications_event_type_format
    check (
      char_length(event_type) between 1 and 128
      and event_type ~ '^[A-Za-z0-9._:-]+$'
    ),
  constraint user_genehelp_notifications_request_id_length
    check (char_length(genehelp_request_id) between 4 and 64),
  constraint user_genehelp_notifications_reply_id_length
    check (reply_id is null or char_length(reply_id) between 1 and 128),
  constraint user_genehelp_notifications_title_length
    check (char_length(title) between 1 and 200),
  constraint user_genehelp_notifications_body_length
    check (char_length(body) <= 1000)
);

comment on table public.user_genehelp_notifications is
  'Server-created private notifications for status changes and replies to a user''s GeneHelp requests.';

create unique index if not exists user_genehelp_notifications_reply_unique_idx
  on public.user_genehelp_notifications (user_id, genehelp_request_id, reply_id)
  where reply_id is not null;

create index if not exists user_genehelp_notifications_user_created_idx
  on public.user_genehelp_notifications (user_id, occurred_at desc, created_at desc);

create index if not exists user_genehelp_notifications_user_unread_idx
  on public.user_genehelp_notifications (user_id, occurred_at desc)
  where read_at is null;

alter table public.user_genehelp_notifications enable row level security;

revoke all on table public.user_genehelp_notifications
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.user_genehelp_notifications
  to service_role;

drop policy if exists user_genehelp_notifications_no_direct_access
  on public.user_genehelp_notifications;
create policy user_genehelp_notifications_no_direct_access
  on public.user_genehelp_notifications
  for all
  to authenticated
  using (false)
  with check (false);

create or replace function public.service_receive_genehelp_notification_v1(
  p_provider_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_genehelp_request_id text,
  p_genehelp_user_id text,
  p_status jsonb,
  p_reply jsonb,
  p_payload_sha256 text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public, security_private
as $function$
declare
  normalized_event_id text := btrim(coalesce(p_provider_event_id, ''));
  normalized_event_type text := btrim(coalesce(p_event_type, ''));
  normalized_request_id text := btrim(coalesce(p_genehelp_request_id, ''));
  normalized_genehelp_user_id text := nullif(btrim(coalesce(p_genehelp_user_id, '')), '');
  normalized_payload_sha256 text := lower(btrim(coalesce(p_payload_sha256, '')));
  normalized_reply_id text;
  normalized_reply_preview text;
  status_updated_at timestamptz;
  effective_provider_updated_at timestamptz;
  existing_payload_sha256 text;
  target_request_row_id uuid;
  target_user_id uuid;
  target_request_title text;
  match_count integer := 0;
  affected_rows integer := 0;
  created_notification_id uuid;
  notification_title text;
  notification_body text;
begin
  if current_user <> 'service_role'
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  if char_length(normalized_event_id) not between 1 and 128
     or normalized_event_id !~ '^[A-Za-z0-9._:-]+$' then
    raise exception 'INVALID_GENEHELP_EVENT_ID' using errcode = '22023';
  end if;
  if char_length(normalized_event_type) not between 1 and 128
     or normalized_event_type !~ '^[A-Za-z0-9._:-]+$' then
    raise exception 'INVALID_GENEHELP_EVENT_TYPE' using errcode = '22023';
  end if;
  if char_length(normalized_request_id) not between 4 and 64
     or normalized_request_id !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'INVALID_GENEHELP_REQUEST_ID' using errcode = '22023';
  end if;
  if normalized_genehelp_user_id is not null
     and char_length(normalized_genehelp_user_id) > 128 then
    raise exception 'INVALID_GENEHELP_USER_ID' using errcode = '22023';
  end if;
  if normalized_payload_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_GENEHELP_PAYLOAD_HASH' using errcode = '22023';
  end if;
  if p_occurred_at is null
     or not isfinite(p_occurred_at)
     or p_occurred_at > clock_timestamp() + interval '10 minutes' then
    raise exception 'INVALID_GENEHELP_OCCURRED_AT' using errcode = '22023';
  end if;
  if p_status is not null
     and (jsonb_typeof(p_status) <> 'object' or pg_column_size(p_status) > 16384) then
    raise exception 'INVALID_GENEHELP_STATUS' using errcode = '22023';
  end if;
  if p_reply is not null
     and (jsonb_typeof(p_reply) <> 'object' or pg_column_size(p_reply) > 16384) then
    raise exception 'INVALID_GENEHELP_REPLY' using errcode = '22023';
  end if;
  if (p_status is null or p_status = '{}'::jsonb)
     and (p_reply is null or p_reply = '{}'::jsonb) then
    raise exception 'GENEHELP_NOTIFICATION_CONTENT_REQUIRED' using errcode = '22023';
  end if;

  if p_status is not null
     and nullif(btrim(coalesce(p_status ->> 'updated_at', '')), '') is not null then
    begin
      status_updated_at := (p_status ->> 'updated_at')::timestamptz;
    exception when others then
      raise exception 'INVALID_GENEHELP_STATUS_UPDATED_AT' using errcode = '22023';
    end;
    if not isfinite(status_updated_at)
       or status_updated_at > clock_timestamp() + interval '10 minutes' then
      raise exception 'INVALID_GENEHELP_STATUS_UPDATED_AT' using errcode = '22023';
    end if;
  end if;
  effective_provider_updated_at := coalesce(status_updated_at, p_occurred_at);

  if p_reply is not null and p_reply <> '{}'::jsonb then
    normalized_reply_id := nullif(btrim(coalesce(p_reply ->> 'id', '')), '');
    if normalized_reply_id is null
       or char_length(normalized_reply_id) > 128 then
      raise exception 'GENEHELP_REPLY_ID_REQUIRED' using errcode = '22023';
    end if;
    normalized_reply_preview := nullif(btrim(coalesce(
      p_reply ->> 'preview',
      p_reply ->> 'message',
      p_reply ->> 'body',
      ''
    )), '');
    if normalized_reply_preview is not null
       and char_length(normalized_reply_preview) > 1000 then
      normalized_reply_preview := left(normalized_reply_preview, 1000);
    end if;
  end if;

  insert into security_private.genehelp_integration_events (
    provider_event_id,
    event_type,
    genehelp_request_id,
    genehelp_user_id,
    payload_sha256,
    occurred_at,
    provider_updated_at,
    outcome
  ) values (
    normalized_event_id,
    normalized_event_type,
    normalized_request_id,
    normalized_genehelp_user_id,
    normalized_payload_sha256,
    p_occurred_at,
    effective_provider_updated_at,
    'processing'
  )
  on conflict (provider_event_id) do nothing;
  get diagnostics affected_rows = row_count;

  if affected_rows = 0 then
    select event_row.payload_sha256
      into existing_payload_sha256
    from security_private.genehelp_integration_events event_row
    where event_row.provider_event_id = normalized_event_id;

    if existing_payload_sha256 is distinct from normalized_payload_sha256 then
      raise exception 'GENEHELP_EVENT_ID_COLLISION' using errcode = '22000';
    end if;
    return jsonb_build_object(
      'accepted', true,
      'outcome', 'duplicate',
      'providerEventId', normalized_event_id
    );
  end if;

  select count(*)::integer
    into match_count
  from public.user_genehelp_requests request_row
  where request_row.genehelp_request_id = normalized_request_id
    and (
      normalized_genehelp_user_id is null
      or exists (
        select 1
        from public.user_genehelp_accounts account_row
        where account_row.user_id = request_row.user_id
          and account_row.genehelp_user_id = normalized_genehelp_user_id
      )
    );

  if match_count = 0 then
    update security_private.genehelp_integration_events
    set outcome = 'unmatched',
        processed_at = clock_timestamp()
    where provider_event_id = normalized_event_id;
    return jsonb_build_object(
      'accepted', true,
      'outcome', 'unmatched',
      'providerEventId', normalized_event_id
    );
  end if;

  if match_count <> 1 then
    update security_private.genehelp_integration_events
    set outcome = 'ambiguous',
        processed_at = clock_timestamp()
    where provider_event_id = normalized_event_id;
    return jsonb_build_object(
      'accepted', true,
      'outcome', 'ambiguous',
      'providerEventId', normalized_event_id
    );
  end if;

  select request_row.id, request_row.user_id, request_row.title
    into target_request_row_id, target_user_id, target_request_title
  from public.user_genehelp_requests request_row
  where request_row.genehelp_request_id = normalized_request_id
    and (
      normalized_genehelp_user_id is null
      or exists (
        select 1
        from public.user_genehelp_accounts account_row
        where account_row.user_id = request_row.user_id
          and account_row.genehelp_user_id = normalized_genehelp_user_id
      )
    )
  limit 1;

  update security_private.genehelp_integration_events
  set matched_request_row_id = target_request_row_id
  where provider_event_id = normalized_event_id;

  if p_status is not null then
    update public.user_genehelp_requests request_row
    set status = coalesce(request_row.status, '{}'::jsonb) || p_status,
        provider_updated_at = effective_provider_updated_at,
        last_checked_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where request_row.id = target_request_row_id
      and (
        request_row.provider_updated_at is null
        or request_row.provider_updated_at < effective_provider_updated_at
      );
    get diagnostics affected_rows = row_count;

    if normalized_reply_id is null
       and affected_rows = 0 then
      update security_private.genehelp_integration_events
      set outcome = 'stale',
          processed_at = clock_timestamp()
      where provider_event_id = normalized_event_id;
      return jsonb_build_object(
        'accepted', true,
        'outcome', 'stale',
        'providerEventId', normalized_event_id
      );
    end if;
  end if;

  if normalized_reply_id is null then
    notification_title := 'Статус запиту GeneHelp змінено';
    notification_body := left(coalesce(
      nullif(btrim(coalesce(p_status ->> 'message', '')), ''),
      case
        when nullif(btrim(coalesce(target_request_title, '')), '') is not null
          then 'Оновлено статус запиту «' || btrim(target_request_title) || '».'
        else 'Оновлено статус вашого запиту GeneHelp.'
      end
    ), 1000);
  else
    notification_title := 'Нова відповідь у GeneHelp';
    notification_body := left(coalesce(
      normalized_reply_preview,
      case
        when nullif(btrim(coalesce(target_request_title, '')), '') is not null
          then 'Надійшла відповідь на запит «' || btrim(target_request_title) || '».'
        else 'Надійшла відповідь на ваш запит GeneHelp.'
      end
    ), 1000);
  end if;

  insert into public.user_genehelp_notifications (
    user_id,
    genehelp_request_row_id,
    genehelp_request_id,
    provider_event_id,
    event_type,
    reply_id,
    title,
    body,
    occurred_at
  ) values (
    target_user_id,
    target_request_row_id,
    normalized_request_id,
    normalized_event_id,
    normalized_event_type,
    normalized_reply_id,
    notification_title,
    notification_body,
    p_occurred_at
  )
  on conflict do nothing
  returning id into created_notification_id;

  if created_notification_id is null
     and normalized_reply_id is not null then
    update security_private.genehelp_integration_events
    set outcome = 'duplicate_reply',
        processed_at = clock_timestamp()
    where provider_event_id = normalized_event_id;
    return jsonb_build_object(
      'accepted', true,
      'outcome', 'duplicate_reply',
      'providerEventId', normalized_event_id
    );
  end if;

  update security_private.genehelp_integration_events
  set outcome = 'applied',
      notification_id = created_notification_id,
      processed_at = clock_timestamp()
  where provider_event_id = normalized_event_id;

  return jsonb_build_object(
    'accepted', true,
    'outcome', 'applied',
    'providerEventId', normalized_event_id,
    'notificationId', created_notification_id
  );
end;
$function$;

revoke all on function public.service_receive_genehelp_notification_v1(
  text, text, timestamptz, text, text, jsonb, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.service_receive_genehelp_notification_v1(
  text, text, timestamptz, text, text, jsonb, jsonb, text
) to service_role;

create or replace function security_private.list_my_genehelp_notifications_v1(
  p_limit integer default 50
)
returns table (
  id uuid,
  genehelp_request_id text,
  event_type text,
  title text,
  body text,
  occurred_at timestamptz,
  created_at timestamptz,
  read_at timestamptz,
  is_read boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private
as $function$
declare
  caller_user_id uuid := (select auth.uid());
  bounded_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if caller_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  return query
  select
    notification.id,
    notification.genehelp_request_id,
    notification.event_type,
    notification.title,
    notification.body,
    notification.occurred_at,
    notification.created_at,
    notification.read_at,
    notification.read_at is not null as is_read
  from public.user_genehelp_notifications notification
  where notification.user_id = caller_user_id
  order by notification.occurred_at desc, notification.created_at desc
  limit bounded_limit;
end;
$function$;

create or replace function security_private.mark_genehelp_notification_read_v1(
  p_notification_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private
as $function$
declare
  caller_user_id uuid := (select auth.uid());
  affected_rows integer := 0;
begin
  if caller_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_notification_id is null then
    raise exception 'NOTIFICATION_ID_REQUIRED' using errcode = '22023';
  end if;

  update public.user_genehelp_notifications notification
  set read_at = coalesce(notification.read_at, clock_timestamp())
  where notification.id = p_notification_id
    and notification.user_id = caller_user_id;
  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$function$;

create or replace function security_private.mark_all_genehelp_notifications_read_v1()
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private
as $function$
declare
  caller_user_id uuid := (select auth.uid());
  affected_rows integer := 0;
begin
  if caller_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  update public.user_genehelp_notifications notification
  set read_at = clock_timestamp()
  where notification.user_id = caller_user_id
    and notification.read_at is null;
  get diagnostics affected_rows = row_count;
  return affected_rows;
end;
$function$;

revoke all on function
  security_private.list_my_genehelp_notifications_v1(integer),
  security_private.mark_genehelp_notification_read_v1(uuid),
  security_private.mark_all_genehelp_notifications_read_v1()
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.list_my_genehelp_notifications_v1(integer),
  security_private.mark_genehelp_notification_read_v1(uuid),
  security_private.mark_all_genehelp_notifications_read_v1()
  to authenticated, service_role;

create or replace function public.list_my_genehelp_notifications(
  p_limit integer default 50
)
returns table (
  id uuid,
  genehelp_request_id text,
  event_type text,
  title text,
  body text,
  occurred_at timestamptz,
  created_at timestamptz,
  read_at timestamptz,
  is_read boolean
)
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select * from security_private.list_my_genehelp_notifications_v1($1);
$function$;

create or replace function public.mark_genehelp_notification_read(
  p_notification_id uuid
)
returns boolean
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.mark_genehelp_notification_read_v1($1);
$function$;

create or replace function public.mark_all_genehelp_notifications_read()
returns integer
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.mark_all_genehelp_notifications_read_v1();
$function$;

revoke all on function
  public.list_my_genehelp_notifications(integer),
  public.mark_genehelp_notification_read(uuid),
  public.mark_all_genehelp_notifications_read()
  from public, anon, authenticated, service_role;
grant execute on function
  public.list_my_genehelp_notifications(integer),
  public.mark_genehelp_notification_read(uuid),
  public.mark_all_genehelp_notifications_read()
  to authenticated, service_role;

commit;
