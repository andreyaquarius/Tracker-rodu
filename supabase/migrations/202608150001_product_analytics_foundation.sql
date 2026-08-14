begin;

create table if not exists public.admin_roles (
  code text primary key,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.admin_role_permissions (
  role_code text not null references public.admin_roles(code) on delete cascade,
  permission_code text not null,
  created_at timestamptz not null default now(),
  primary key (role_code, permission_code)
);

create table if not exists public.admin_role_assignments (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role_code text not null references public.admin_roles(code) on delete cascade,
  assigned_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role_code)
);

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  admin_actor_id uuid not null references public.profiles(user_id) on delete restrict,
  action_code text not null check (char_length(action_code) between 3 and 100),
  target_type text check (target_type is null or char_length(target_type) between 1 and 80),
  target_id text check (target_id is null or char_length(target_id) between 1 and 160),
  outcome text not null check (outcome in ('success', 'failure', 'denied')),
  sanitized_diff jsonb not null default '{}'::jsonb check (jsonb_typeof(sanitized_diff) = 'object'),
  created_at timestamptz not null default now()
);

insert into public.admin_roles(code, name, description) values
  ('analytics_viewer', 'Перегляд аналітики', 'Агрегована продуктова аналітика без приватного вмісту.'),
  ('support_admin', 'Підтримка', 'Робота з приватними зверненнями користувачів.'),
  ('billing_admin', 'Тарифи й підписки', 'Адміністрування тарифів, підписок і лімітів.'),
  ('content_admin', 'Контент', 'Оголошення та публічний контент.'),
  ('feature_admin', 'Функції та доступ', 'Feature flags і поетапне відкриття функцій.'),
  ('operations_admin', 'Операції', 'Фонові завдання, квоти й стан сервісів.'),
  ('security_admin', 'Безпека', 'Перегляд безпекового аудиту та конфігурації.'),
  ('super_admin', 'Головний адміністратор', 'Усі адміністративні дозволи.')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description;

with role_permissions(role_code, permission_code) as (values
  ('analytics_viewer', 'analytics.view'),
  ('support_admin', 'support.manage'),
  ('billing_admin', 'billing.manage'),
  ('content_admin', 'content.manage'),
  ('feature_admin', 'features.manage'),
  ('operations_admin', 'operations.manage'),
  ('security_admin', 'security.view'),
  ('super_admin', 'analytics.view'),
  ('super_admin', 'support.manage'),
  ('super_admin', 'billing.manage'),
  ('super_admin', 'content.manage'),
  ('super_admin', 'features.manage'),
  ('super_admin', 'operations.manage'),
  ('super_admin', 'security.view'),
  ('super_admin', 'admins.manage')
)
insert into public.admin_role_permissions(role_code, permission_code)
select role_code, permission_code from role_permissions
on conflict (role_code, permission_code) do nothing;

insert into public.admin_role_assignments(user_id, role_code, assigned_by)
select admin.user_id, 'super_admin', admin.granted_by
from public.app_admins admin
on conflict (user_id, role_code) do nothing;

create table if not exists public.product_analytics_consents (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  granted boolean not null,
  consent_version smallint not null check (consent_version between 1 and 100),
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_analytics_sessions (
  id uuid primary key,
  actor_key bytea not null,
  is_internal boolean not null default false,
  started_at timestamptz not null,
  last_seen_at timestamptz not null,
  entry_page_code text not null,
  exit_page_code text not null,
  active_seconds integer not null default 0 check (active_seconds >= 0),
  page_views integer not null default 0 check (page_views >= 0),
  plan_code text,
  device_class text not null check (device_class in ('desktop', 'tablet', 'mobile', 'unknown')),
  viewport_bucket text not null check (viewport_bucket in ('xs', 'sm', 'md', 'lg', 'xl', 'unknown')),
  app_version text,
  consent_version smallint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_analytics_events (
  event_id uuid primary key,
  session_id uuid not null references public.product_analytics_sessions(id) on delete cascade,
  actor_key bytea not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  event_name text not null check (
    event_name in ('session_started', 'page_viewed', 'page_active_time')
  ),
  page_code text not null,
  active_seconds integer not null default 0 check (
    (event_name = 'page_active_time' and active_seconds between 1 and 300)
    or (event_name <> 'page_active_time' and active_seconds = 0)
  )
);

create table if not exists public.product_analytics_ingest_limits (
  actor_key bytea primary key,
  window_started_at timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0)
);

create index if not exists product_analytics_sessions_started_idx
  on public.product_analytics_sessions(started_at desc);
create index if not exists product_analytics_sessions_actor_idx
  on public.product_analytics_sessions(actor_key, started_at desc);
create index if not exists product_analytics_events_occurred_idx
  on public.product_analytics_events(occurred_at desc);
create index if not exists product_analytics_events_page_idx
  on public.product_analytics_events(page_code, occurred_at desc);
create index if not exists product_analytics_events_session_idx
  on public.product_analytics_events(session_id, occurred_at);
create index if not exists admin_role_assignments_role_idx
  on public.admin_role_assignments(role_code, user_id);
create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log(created_at desc);
create index if not exists admin_audit_log_actor_idx
  on public.admin_audit_log(admin_actor_id, created_at desc);

alter table public.admin_roles enable row level security;
alter table public.admin_role_permissions enable row level security;
alter table public.admin_role_assignments enable row level security;
alter table public.admin_audit_log enable row level security;
alter table public.product_analytics_consents enable row level security;
alter table public.product_analytics_sessions enable row level security;
alter table public.product_analytics_events enable row level security;
alter table public.product_analytics_ingest_limits enable row level security;

drop policy if exists product_analytics_consents_select_own
  on public.product_analytics_consents;
create policy product_analytics_consents_select_own
  on public.product_analytics_consents
  for select
  to authenticated
  using (user_id = (select auth.uid()));

revoke all on table public.admin_roles from public, anon, authenticated;
revoke all on table public.admin_role_permissions from public, anon, authenticated;
revoke all on table public.admin_role_assignments from public, anon, authenticated;
revoke all on table public.admin_audit_log from public, anon, authenticated;
revoke all on table public.product_analytics_consents from public, anon, authenticated;
revoke all on table public.product_analytics_sessions from public, anon, authenticated;
revoke all on table public.product_analytics_events from public, anon, authenticated;
revoke all on table public.product_analytics_ingest_limits from public, anon, authenticated;
grant all on table public.admin_roles to service_role;
grant all on table public.admin_role_permissions to service_role;
grant all on table public.admin_role_assignments to service_role;
grant all on table public.admin_audit_log to service_role;
grant select on table public.product_analytics_consents to authenticated;
grant all on table public.product_analytics_consents to service_role;
grant all on table public.product_analytics_sessions to service_role;
grant all on table public.product_analytics_events to service_role;
grant all on table public.product_analytics_ingest_limits to service_role;

create or replace function security_private.get_my_product_analytics_consent_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'granted', consent.granted,
    'consentVersion', consent.consent_version,
    'decidedAt', consent.decided_at,
    'updatedAt', consent.updated_at
  )
  into result
  from public.product_analytics_consents consent
  where consent.user_id = current_user_id;

  return result;
end;
$function$;

create or replace function security_private.get_my_admin_capabilities_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not public.is_app_admin(current_user_id) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'isAdmin', true,
    'roles', (
      select coalesce(jsonb_agg(assignment.role_code order by assignment.role_code), '[]'::jsonb)
      from public.admin_role_assignments assignment
      where assignment.user_id = current_user_id
    ),
    'permissions', (
      select coalesce(jsonb_agg(permission.permission_code order by permission.permission_code), '[]'::jsonb)
      from (
        select distinct role_permission.permission_code
        from public.admin_role_assignments assignment
        join public.admin_role_permissions role_permission
          on role_permission.role_code = assignment.role_code
        where assignment.user_id = current_user_id
      ) permission
    )
  ) into result;

  return result;
end;
$function$;

create or replace function security_private.write_admin_audit_v1(
  p_admin_actor_id uuid,
  p_action_code text,
  p_target_type text,
  p_target_id text,
  p_outcome text,
  p_sanitized_diff jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  inserted_id bigint;
begin
  if p_admin_actor_id is null or not public.is_app_admin(p_admin_actor_id) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_action_code is null
    or char_length(p_action_code) not between 3 and 100
    or p_outcome not in ('success', 'failure', 'denied')
    or coalesce(jsonb_typeof(p_sanitized_diff), '') <> 'object'
  then
    raise exception 'INVALID_ADMIN_AUDIT_EVENT' using errcode = '22023';
  end if;

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    p_admin_actor_id,
    p_action_code,
    nullif(left(trim(p_target_type), 80), ''),
    nullif(left(trim(p_target_id), 160), ''),
    p_outcome,
    p_sanitized_diff
  ) returning id into inserted_id;
  return inserted_id;
end;
$function$;

create or replace function security_private.set_my_product_analytics_consent_v1(
  p_granted boolean,
  p_consent_version smallint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  result jsonb;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_consent_version is null or p_consent_version < 1 or p_consent_version > 100 then
    raise exception 'INVALID_CONSENT_VERSION' using errcode = '22023';
  end if;

  insert into public.product_analytics_consents(
    user_id, granted, consent_version, decided_at, updated_at
  ) values (
    current_user_id, p_granted, p_consent_version, now(), now()
  )
  on conflict (user_id) do update set
    granted = excluded.granted,
    consent_version = excluded.consent_version,
    decided_at = now(),
    updated_at = now();

  select jsonb_build_object(
    'granted', consent.granted,
    'consentVersion', consent.consent_version,
    'decidedAt', consent.decided_at,
    'updatedAt', consent.updated_at
  )
  into result
  from public.product_analytics_consents consent
  where consent.user_id = current_user_id;

  return result;
end;
$function$;

create or replace function security_private.ingest_product_analytics_batch_v1(
  p_actor_key_hex text,
  p_session_id uuid,
  p_is_internal boolean,
  p_plan_code text,
  p_device_class text,
  p_viewport_bucket text,
  p_app_version text,
  p_consent_version smallint,
  p_events jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  actor_key_value bytea;
  event_value jsonb;
  event_id_value uuid;
  event_name_value text;
  page_code_value text;
  occurred_at_value timestamptz;
  active_seconds_value integer;
  inserted_rows integer;
  accepted_count integer := 0;
  page_view_increment integer := 0;
  active_seconds_increment integer := 0;
  first_page text;
  last_page text;
  first_occurred_at timestamptz;
  last_occurred_at timestamptz;
  current_request_count integer;
  allowed_pages constant text[] := array[
    'projects','dashboard','map','persons_list','person_profile','person_edit',
    'family_tree','family_tree_pedigree','ancestor_wheel','tree_statistics',
    'researches','documents','document_viewer','requests','year_matrix','tasks',
    'findings','hypotheses','backup','settings','subscription','feedback',
    'custom_section','unknown'
  ];
begin
  if p_actor_key_hex !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_ACTOR_KEY' using errcode = '22023';
  end if;
  actor_key_value := decode(p_actor_key_hex, 'hex');

  if p_session_id is null
    or p_device_class not in ('desktop', 'tablet', 'mobile', 'unknown')
    or p_viewport_bucket not in ('xs', 'sm', 'md', 'lg', 'xl', 'unknown')
    or p_consent_version < 1
    or jsonb_typeof(p_events) <> 'array'
    or jsonb_array_length(p_events) < 1
    or jsonb_array_length(p_events) > 50
  then
    raise exception 'INVALID_ANALYTICS_BATCH' using errcode = '22023';
  end if;

  insert into public.product_analytics_ingest_limits(
    actor_key, window_started_at, request_count
  ) values (
    actor_key_value, now(), 1
  )
  on conflict (actor_key) do update set
    window_started_at = case
      when public.product_analytics_ingest_limits.window_started_at <= now() - interval '5 minutes'
        then now()
      else public.product_analytics_ingest_limits.window_started_at
    end,
    request_count = case
      when public.product_analytics_ingest_limits.window_started_at <= now() - interval '5 minutes'
        then 1
      else public.product_analytics_ingest_limits.request_count + 1
    end
  returning request_count into current_request_count;

  if current_request_count > 120 then
    raise exception 'ANALYTICS_RATE_LIMIT' using errcode = 'P0001';
  end if;

  for event_value in select value from jsonb_array_elements(p_events)
  loop
    if jsonb_typeof(event_value) <> 'object'
      or exists (
        select 1
        from jsonb_object_keys(event_value) key_name
        where key_name <> all(array['eventId','name','occurredAt','pageCode','activeSeconds'])
      )
    then
      raise exception 'INVALID_ANALYTICS_EVENT' using errcode = '22023';
    end if;

    event_id_value := (event_value->>'eventId')::uuid;
    event_name_value := event_value->>'name';
    page_code_value := event_value->>'pageCode';
    occurred_at_value := (event_value->>'occurredAt')::timestamptz;
    active_seconds_value := coalesce((event_value->>'activeSeconds')::integer, 0);

    if event_name_value not in ('session_started', 'page_viewed', 'page_active_time')
      or not (page_code_value = any(allowed_pages))
      or occurred_at_value < now() - interval '24 hours'
      or occurred_at_value > now() + interval '5 minutes'
      or (
        event_name_value = 'page_active_time'
        and active_seconds_value not between 1 and 300
      )
      or (
        event_name_value <> 'page_active_time'
        and active_seconds_value <> 0
      )
    then
      raise exception 'INVALID_ANALYTICS_EVENT' using errcode = '22023';
    end if;

    if first_page is null or occurred_at_value < first_occurred_at then
      first_page := page_code_value;
      first_occurred_at := occurred_at_value;
    end if;
    if last_page is null or occurred_at_value >= last_occurred_at then
      last_page := page_code_value;
      last_occurred_at := occurred_at_value;
    end if;

    insert into public.product_analytics_sessions(
      id, actor_key, is_internal, started_at, last_seen_at,
      entry_page_code, exit_page_code, plan_code, device_class,
      viewport_bucket, app_version, consent_version
    ) values (
      p_session_id, actor_key_value, coalesce(p_is_internal, false),
      occurred_at_value, occurred_at_value, page_code_value, page_code_value,
      nullif(trim(p_plan_code), ''), p_device_class, p_viewport_bucket,
      nullif(left(trim(p_app_version), 80), ''), p_consent_version
    )
    on conflict (id) do update set
      last_seen_at = greatest(public.product_analytics_sessions.last_seen_at, excluded.last_seen_at),
      exit_page_code = excluded.exit_page_code,
      plan_code = coalesce(excluded.plan_code, public.product_analytics_sessions.plan_code),
      updated_at = now()
    where public.product_analytics_sessions.actor_key = excluded.actor_key;

    if exists (
      select 1 from public.product_analytics_sessions session
      where session.id = p_session_id and session.actor_key <> actor_key_value
    ) then
      raise exception 'SESSION_ACTOR_MISMATCH' using errcode = '22023';
    end if;

    insert into public.product_analytics_events(
      event_id, session_id, actor_key, occurred_at,
      event_name, page_code, active_seconds
    ) values (
      event_id_value, p_session_id, actor_key_value, occurred_at_value,
      event_name_value, page_code_value, active_seconds_value
    )
    on conflict (event_id) do nothing;
    get diagnostics inserted_rows = row_count;

    if inserted_rows = 1 then
      accepted_count := accepted_count + 1;
      if event_name_value = 'page_viewed' then
        page_view_increment := page_view_increment + 1;
      elsif event_name_value = 'page_active_time' then
        active_seconds_increment := active_seconds_increment + active_seconds_value;
      end if;
    end if;
  end loop;

  update public.product_analytics_sessions session set
    started_at = least(session.started_at, coalesce(first_occurred_at, session.started_at)),
    last_seen_at = greatest(session.last_seen_at, coalesce(last_occurred_at, session.last_seen_at)),
    entry_page_code = case
      when coalesce(first_occurred_at, session.started_at) <= session.started_at
        then coalesce(first_page, session.entry_page_code)
      else session.entry_page_code
    end,
    exit_page_code = coalesce(last_page, session.exit_page_code),
    page_views = session.page_views + page_view_increment,
    active_seconds = session.active_seconds + active_seconds_increment,
    updated_at = now()
  where session.id = p_session_id and session.actor_key = actor_key_value;

  return jsonb_build_object('accepted', accepted_count);
end;
$function$;

create or replace function security_private.admin_get_product_analytics_overview_v1(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  actor_count integer;
  result jsonb;
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '370 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  select count(distinct session.actor_key)::integer
  into actor_count
  from public.product_analytics_sessions session
  where not session.is_internal
    and session.started_at >= p_from and session.started_at < p_to;

  if actor_count < 5 then
    return jsonb_build_object(
      'suppressed', true,
      'minimumCohort', 5,
      'users', null,
      'sessions', null,
      'pageViews', null,
      'activeSeconds', null
    );
  end if;

  select jsonb_build_object(
    'suppressed', false,
    'minimumCohort', 5,
    'users', count(distinct session.actor_key),
    'sessions', count(*),
    'pageViews', coalesce(sum(session.page_views), 0),
    'activeSeconds', coalesce(sum(session.active_seconds), 0)
  )
  into result
  from public.product_analytics_sessions session
  where not session.is_internal
    and session.started_at >= p_from and session.started_at < p_to;

  return result;
end;
$function$;

create or replace function security_private.admin_get_product_analytics_pages_v1(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
begin
  if not public.is_app_admin(auth.uid()) then
    raise exception 'ADMIN_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '370 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(page_row) order by page_row.active_seconds desc), '[]'::jsonb)
  into result
  from (
    select
      event.page_code,
      count(distinct event.actor_key)::integer as users,
      count(*) filter (where event.event_name = 'page_viewed')::integer as page_views,
      coalesce(sum(event.active_seconds) filter (where event.event_name = 'page_active_time'), 0)::bigint as active_seconds,
      round(
        coalesce(sum(event.active_seconds) filter (where event.event_name = 'page_active_time'), 0)::numeric
        / nullif(count(distinct event.actor_key), 0),
        1
      ) as average_active_seconds
    from public.product_analytics_events event
    join public.product_analytics_sessions session on session.id = event.session_id
    where not session.is_internal
      and event.occurred_at >= p_from and event.occurred_at < p_to
    group by event.page_code
    having count(distinct event.actor_key) >= 5
  ) page_row;

  return result;
end;
$function$;

create or replace function security_private.cleanup_product_analytics_v1()
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  deleted_events integer;
  deleted_sessions integer;
  deleted_limits integer;
begin
  delete from public.product_analytics_events where occurred_at < now() - interval '90 days';
  get diagnostics deleted_events = row_count;
  delete from public.product_analytics_sessions where last_seen_at < now() - interval '13 months';
  get diagnostics deleted_sessions = row_count;
  delete from public.product_analytics_ingest_limits where window_started_at < now() - interval '1 day';
  get diagnostics deleted_limits = row_count;
  return jsonb_build_object(
    'events', deleted_events,
    'sessions', deleted_sessions,
    'limits', deleted_limits
  );
end;
$function$;

create or replace function public.get_my_product_analytics_consent()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.get_my_product_analytics_consent_v1() $$;

create or replace function public.get_my_admin_capabilities()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.get_my_admin_capabilities_v1() $$;

create or replace function public.set_my_product_analytics_consent(
  p_granted boolean,
  p_consent_version smallint
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.set_my_product_analytics_consent_v1($1, $2) $$;

create or replace function public.ingest_product_analytics_batch(
  p_actor_key_hex text,
  p_session_id uuid,
  p_is_internal boolean,
  p_plan_code text,
  p_device_class text,
  p_viewport_bucket text,
  p_app_version text,
  p_consent_version smallint,
  p_events jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.ingest_product_analytics_batch_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) $$;

create or replace function public.admin_get_product_analytics_overview(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_product_analytics_overview_v1($1,$2) $$;

create or replace function public.admin_get_product_analytics_pages(
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_product_analytics_pages_v1($1,$2) $$;

revoke all on function security_private.get_my_product_analytics_consent_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.get_my_admin_capabilities_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.write_admin_audit_v1(uuid,text,text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.set_my_product_analytics_consent_v1(boolean,smallint) from public, anon, authenticated, service_role;
revoke all on function security_private.ingest_product_analytics_batch_v1(text,uuid,boolean,text,text,text,text,smallint,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_product_analytics_overview_v1(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_product_analytics_pages_v1(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function security_private.cleanup_product_analytics_v1() from public, anon, authenticated, service_role;

grant execute on function security_private.get_my_product_analytics_consent_v1() to authenticated, service_role;
grant execute on function security_private.get_my_admin_capabilities_v1() to authenticated, service_role;
grant execute on function security_private.write_admin_audit_v1(uuid,text,text,text,text,jsonb) to service_role;
grant execute on function security_private.set_my_product_analytics_consent_v1(boolean,smallint) to authenticated, service_role;
grant execute on function security_private.ingest_product_analytics_batch_v1(text,uuid,boolean,text,text,text,text,smallint,jsonb) to service_role;
grant execute on function security_private.admin_get_product_analytics_overview_v1(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function security_private.admin_get_product_analytics_pages_v1(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function security_private.cleanup_product_analytics_v1() to service_role;

revoke all on function public.get_my_product_analytics_consent() from public, anon, authenticated, service_role;
revoke all on function public.get_my_admin_capabilities() from public, anon, authenticated, service_role;
revoke all on function public.set_my_product_analytics_consent(boolean,smallint) from public, anon, authenticated, service_role;
revoke all on function public.ingest_product_analytics_batch(text,uuid,boolean,text,text,text,text,smallint,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_product_analytics_overview(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_product_analytics_pages(timestamptz,timestamptz) from public, anon, authenticated, service_role;

grant execute on function public.get_my_product_analytics_consent() to authenticated, service_role;
grant execute on function public.get_my_admin_capabilities() to authenticated, service_role;
grant execute on function public.set_my_product_analytics_consent(boolean,smallint) to authenticated, service_role;
grant execute on function public.ingest_product_analytics_batch(text,uuid,boolean,text,text,text,text,smallint,jsonb) to service_role;
grant execute on function public.admin_get_product_analytics_overview(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function public.admin_get_product_analytics_pages(timestamptz,timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
