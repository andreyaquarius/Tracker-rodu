begin;

alter table public.product_analytics_events
  add column if not exists action_code text,
  add column if not exists outcome text,
  add column if not exists duration_bucket text,
  add column if not exists count_bucket text;

alter table public.product_analytics_events
  drop constraint if exists product_analytics_events_event_name_check,
  drop constraint if exists product_analytics_events_active_seconds_check,
  drop constraint if exists product_analytics_events_semantic_event_check;

alter table public.product_analytics_events
  add constraint product_analytics_events_event_name_check check (
    event_name in (
      'session_started', 'page_viewed', 'page_active_time',
      'action_invoked', 'operation_finished'
    )
  ),
  add constraint product_analytics_events_active_seconds_check check (
    (event_name = 'page_active_time' and active_seconds between 1 and 300)
    or (event_name <> 'page_active_time' and active_seconds = 0)
  ),
  add constraint product_analytics_events_semantic_event_check check (
    (
      event_name in ('session_started', 'page_viewed', 'page_active_time')
      and action_code is null
      and outcome is null
      and duration_bucket is null
      and count_bucket is null
    )
    or (
      event_name = 'action_invoked'
      and action_code is not null
      and outcome is null
      and duration_bucket is null
      and count_bucket is null
    )
    or (
      event_name = 'operation_finished'
      and action_code is not null
      and outcome in ('success', 'failure', 'cancelled')
      and duration_bucket in ('lt_1s', '1_3s', '3_10s', '10_30s', '30_120s', 'gte_120s')
      and (count_bucket is null or count_bucket in (
        '1_100', '101_500', '501_2000', '2001_10000', 'gte_10001'
      ))
    )
  );

create index if not exists product_analytics_events_action_idx
  on public.product_analytics_events(action_code, occurred_at desc)
  where action_code is not null;

create table if not exists public.admin_analytics_preferences (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  period_days smallint not null default 30 check (period_days in (7, 30, 90)),
  funnel_code text not null default 'onboarding' check (
    funnel_code in ('onboarding','gedcom_import','document_research','ai_hypothesis')
  ),
  updated_at timestamptz not null default now()
);

alter table public.admin_analytics_preferences enable row level security;
revoke all on table public.admin_analytics_preferences from public, anon, authenticated;
grant all on table public.admin_analytics_preferences to service_role;

create or replace function security_private.has_admin_permission_v1(
  p_permission_code text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select public.is_app_admin(auth.uid())
    and exists (
      select 1
      from public.admin_role_assignments assignment
      join public.admin_role_permissions permission
        on permission.role_code = assignment.role_code
      where assignment.user_id = auth.uid()
        and permission.permission_code = p_permission_code
    )
$function$;

create or replace function security_private.get_my_admin_analytics_preferences_v1()
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
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'periodDays', preference.period_days,
    'funnelCode', preference.funnel_code
  ) into result
  from public.admin_analytics_preferences preference
  where preference.user_id = current_user_id;

  return coalesce(result, jsonb_build_object(
    'periodDays', 30,
    'funnelCode', 'onboarding'
  ));
end;
$function$;

create or replace function security_private.set_my_admin_analytics_preferences_v1(
  p_period_days smallint,
  p_funnel_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
begin
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_period_days not in (7, 30, 90)
    or p_funnel_code not in ('onboarding','gedcom_import','document_research','ai_hypothesis')
  then
    raise exception 'INVALID_ANALYTICS_PREFERENCE' using errcode = '22023';
  end if;

  insert into public.admin_analytics_preferences(
    user_id, period_days, funnel_code, updated_at
  ) values (
    current_user_id, p_period_days, p_funnel_code, now()
  )
  on conflict (user_id) do update set
    period_days = excluded.period_days,
    funnel_code = excluded.funnel_code,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'periodDays', p_period_days,
    'funnelCode', p_funnel_code
  );
end;
$function$;

-- Replace the foundation reports as well: being present in app_admins is not
-- enough once granular roles exist. Both reports must require analytics.view
-- at the database boundary, even when they are invoked outside the UI.
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
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
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
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
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

-- Keep the legacy app_admins entry point compatible with granular RBAC. Any
-- administrator added after the foundation migration receives the same full
-- role that existing administrators received during the initial backfill.
create or replace function security_private.sync_app_admin_super_role_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  insert into public.admin_role_assignments(user_id, role_code, assigned_by)
  values (new.user_id, 'super_admin', new.granted_by)
  on conflict (user_id, role_code) do nothing;
  return new;
end;
$function$;

drop trigger if exists app_admins_sync_super_role on public.app_admins;
create trigger app_admins_sync_super_role
after insert or update of granted_by on public.app_admins
for each row execute function security_private.sync_app_admin_super_role_v1();

insert into public.admin_role_assignments(user_id, role_code, assigned_by)
select admin.user_id, 'super_admin', admin.granted_by
from public.app_admins admin
on conflict (user_id, role_code) do nothing;

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
  action_code_value text;
  outcome_value text;
  duration_bucket_value text;
  count_bucket_value text;
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
  allowed_actions constant text[] := array[
    'project_open','project_create','person_create','person_edit','person_delete',
    'tree_open','tree_mode_change','tree_branch_expand','tree_search',
    'ancestor_chart_build','ancestor_chart_export','tree_statistics_open',
    'tree_statistics_export','gedcom_import_start','gedcom_import_complete',
    'gedcom_import_fail','gedcom_export_start','gedcom_export_complete',
    'gedcom_export_fail','document_create','document_viewer_open',
    'document_first_page_render','document_page_export','finding_create_from_document',
    'search_use','filter_apply','table_export','ai_hypothesis_check',
    'ai_document_recognition','feedback_create','subscription_page_open'
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
  ) values (actor_key_value, now(), 1)
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
      or jsonb_object_length(event_value) <> 9
      or exists (
        select 1
        from jsonb_object_keys(event_value) key_name
        where key_name <> all(array[
          'eventId','name','occurredAt','pageCode','activeSeconds',
          'actionCode','outcome','durationBucket','countBucket'
        ])
      )
    then
      raise exception 'INVALID_ANALYTICS_EVENT' using errcode = '22023';
    end if;

    event_id_value := (event_value->>'eventId')::uuid;
    event_name_value := event_value->>'name';
    page_code_value := event_value->>'pageCode';
    action_code_value := nullif(event_value->>'actionCode', '');
    outcome_value := nullif(event_value->>'outcome', '');
    duration_bucket_value := nullif(event_value->>'durationBucket', '');
    count_bucket_value := nullif(event_value->>'countBucket', '');
    occurred_at_value := (event_value->>'occurredAt')::timestamptz;
    active_seconds_value := coalesce((event_value->>'activeSeconds')::integer, 0);

    if event_name_value not in (
        'session_started','page_viewed','page_active_time','action_invoked','operation_finished'
      )
      or not (page_code_value = any(allowed_pages))
      or occurred_at_value < now() - interval '24 hours'
      or occurred_at_value > now() + interval '5 minutes'
      or (event_name_value = 'page_active_time' and active_seconds_value not between 1 and 300)
      or (event_name_value <> 'page_active_time' and active_seconds_value <> 0)
      or (
        event_name_value in ('session_started','page_viewed','page_active_time')
        and (action_code_value is not null or outcome_value is not null
          or duration_bucket_value is not null or count_bucket_value is not null)
      )
      or (
        event_name_value = 'action_invoked'
        and (
          not (action_code_value = any(allowed_actions))
          or outcome_value is not null or duration_bucket_value is not null or count_bucket_value is not null
        )
      )
      or (
        event_name_value = 'operation_finished'
        and (
          not (action_code_value = any(allowed_actions))
          or outcome_value not in ('success','failure','cancelled')
          or duration_bucket_value not in ('lt_1s','1_3s','3_10s','10_30s','30_120s','gte_120s')
          or (
            count_bucket_value is not null
            and count_bucket_value not in ('1_100','101_500','501_2000','2001_10000','gte_10001')
          )
        )
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
      event_id, session_id, actor_key, occurred_at, event_name, page_code,
      active_seconds, action_code, outcome, duration_bucket, count_bucket
    ) values (
      event_id_value, p_session_id, actor_key_value, occurred_at_value,
      event_name_value, page_code_value, active_seconds_value,
      action_code_value, outcome_value, duration_bucket_value, count_bucket_value
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

create or replace function security_private.admin_get_product_analytics_actions_v1(
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
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '370 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(action_row) order by action_row.users desc, action_row.action_code), '[]'::jsonb)
  into result
  from (
    select
      event.action_code,
      count(distinct event.actor_key)::integer as users,
      count(*) filter (where event.event_name = 'action_invoked')::integer as invocations,
      count(*) filter (where event.event_name = 'operation_finished')::integer as completions,
      count(*) filter (where event.outcome = 'success')::integer as successes,
      count(*) filter (where event.outcome = 'failure')::integer as failures,
      count(*) filter (where event.outcome = 'cancelled')::integer as cancellations,
      round(
        100 * count(*) filter (where event.outcome = 'success')::numeric
        / nullif(count(*) filter (where event.event_name = 'operation_finished'), 0),
        1
      ) as success_rate,
      jsonb_build_object(
        'lt_1s', count(*) filter (where event.duration_bucket = 'lt_1s'),
        '1_3s', count(*) filter (where event.duration_bucket = '1_3s'),
        '3_10s', count(*) filter (where event.duration_bucket = '3_10s'),
        '10_30s', count(*) filter (where event.duration_bucket = '10_30s'),
        '30_120s', count(*) filter (where event.duration_bucket = '30_120s'),
        'gte_120s', count(*) filter (where event.duration_bucket = 'gte_120s')
      ) as duration_buckets
    from public.product_analytics_events event
    join public.product_analytics_sessions session on session.id = event.session_id
    where not session.is_internal
      and event.action_code is not null
      and event.occurred_at >= p_from and event.occurred_at < p_to
    group by event.action_code
    having count(distinct event.actor_key) >= 5
  ) action_row;

  return result;
end;
$function$;

create or replace function security_private.admin_get_product_analytics_funnel_v1(
  p_from timestamptz,
  p_to timestamptz,
  p_funnel_code text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  entry_actors integer;
begin
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '370 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;
  if p_funnel_code not in ('onboarding','gedcom_import','document_research','ai_hypothesis') then
    raise exception 'INVALID_FUNNEL' using errcode = '22023';
  end if;

  with step_definition as (
    select * from (values
      ('onboarding', 1, 'session_started', null::text, null::text, 'session_start'),
      ('onboarding', 2, 'action_invoked', 'project_open', null::text, 'project_open'),
      ('onboarding', 3, 'action_invoked', 'person_create', null::text, 'person_create'),
      ('onboarding', 4, 'action_invoked', 'tree_open', null::text, 'tree_open'),
      ('gedcom_import', 1, 'action_invoked', 'gedcom_import_start', null::text, 'import_start'),
      ('gedcom_import', 2, 'operation_finished', 'gedcom_import_complete', 'success', 'import_complete'),
      ('gedcom_import', 3, 'action_invoked', 'tree_open', null::text, 'tree_open'),
      ('document_research', 1, 'action_invoked', 'document_create', null::text, 'document_create'),
      ('document_research', 2, 'action_invoked', 'document_viewer_open', null::text, 'viewer_open'),
      ('document_research', 3, 'action_invoked', 'finding_create_from_document', null::text, 'finding_create'),
      ('ai_hypothesis', 1, 'action_invoked', 'ai_hypothesis_check', null::text, 'ai_start'),
      ('ai_hypothesis', 2, 'operation_finished', 'ai_hypothesis_check', 'success', 'ai_success')
    ) definition(funnel_code, ordinal, event_name, action_code, outcome, step_code)
    where funnel_code = p_funnel_code
  ), reached as (
    select
      definition.ordinal,
      definition.step_code,
      count(distinct event.actor_key)::integer as actors
    from step_definition definition
    left join public.product_analytics_events event
      on event.event_name = definition.event_name
      and (definition.action_code is null or event.action_code = definition.action_code)
      and (definition.outcome is null or event.outcome = definition.outcome)
      and event.occurred_at >= p_from and event.occurred_at < p_to
    left join public.product_analytics_sessions session
      on session.id = event.session_id and not session.is_internal
    where event.event_id is null or session.id is not null
    group by definition.ordinal, definition.step_code
  )
  select actors into entry_actors from reached where ordinal = 1;

  if coalesce(entry_actors, 0) < 5 then
    return jsonb_build_object(
      'funnelCode', p_funnel_code,
      'suppressed', true,
      'minimumCohort', 5,
      'steps', '[]'::jsonb
    );
  end if;

  with step_definition as (
    select * from (values
      ('onboarding', 1, 'session_started', null::text, null::text, 'session_start'),
      ('onboarding', 2, 'action_invoked', 'project_open', null::text, 'project_open'),
      ('onboarding', 3, 'action_invoked', 'person_create', null::text, 'person_create'),
      ('onboarding', 4, 'action_invoked', 'tree_open', null::text, 'tree_open'),
      ('gedcom_import', 1, 'action_invoked', 'gedcom_import_start', null::text, 'import_start'),
      ('gedcom_import', 2, 'operation_finished', 'gedcom_import_complete', 'success', 'import_complete'),
      ('gedcom_import', 3, 'action_invoked', 'tree_open', null::text, 'tree_open'),
      ('document_research', 1, 'action_invoked', 'document_create', null::text, 'document_create'),
      ('document_research', 2, 'action_invoked', 'document_viewer_open', null::text, 'viewer_open'),
      ('document_research', 3, 'action_invoked', 'finding_create_from_document', null::text, 'finding_create'),
      ('ai_hypothesis', 1, 'action_invoked', 'ai_hypothesis_check', null::text, 'ai_start'),
      ('ai_hypothesis', 2, 'operation_finished', 'ai_hypothesis_check', 'success', 'ai_success')
    ) definition(funnel_code, ordinal, event_name, action_code, outcome, step_code)
    where funnel_code = p_funnel_code
  ), reached as (
    select
      definition.ordinal,
      definition.step_code,
      count(distinct event.actor_key)::integer as actors
    from step_definition definition
    left join public.product_analytics_events event
      on event.event_name = definition.event_name
      and (definition.action_code is null or event.action_code = definition.action_code)
      and (definition.outcome is null or event.outcome = definition.outcome)
      and event.occurred_at >= p_from and event.occurred_at < p_to
    left join public.product_analytics_sessions session
      on session.id = event.session_id and not session.is_internal
    where event.event_id is null or session.id is not null
    group by definition.ordinal, definition.step_code
  )
  select jsonb_build_object(
    'funnelCode', p_funnel_code,
    'suppressed', false,
    'minimumCohort', 5,
    'steps', coalesce(jsonb_agg(jsonb_build_object(
      'ordinal', reached.ordinal,
      'stepCode', reached.step_code,
      'actors', reached.actors,
      'conversionPercent', round(100 * reached.actors::numeric / nullif(entry_actors, 0), 1)
    ) order by reached.ordinal), '[]'::jsonb)
  ) into result
  from reached;

  return result;
end;
$function$;

create or replace function security_private.admin_get_product_analytics_retention_v1(
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
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_from >= p_to or p_to - p_from > interval '370 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;

  with first_sessions as (
    select distinct on (session.actor_key)
      session.actor_key,
      session.started_at as first_seen_at,
      coalesce(session.plan_code, 'unknown') as plan_code
    from public.product_analytics_sessions session
    where not session.is_internal
    order by session.actor_key, session.started_at
  ), cohorts as (
    select
      first.actor_key,
      date_trunc('week', first.first_seen_at)::date as cohort_week,
      first.first_seen_at,
      first.plan_code
    from first_sessions first
    where first.first_seen_at >= p_from and first.first_seen_at < p_to
  ), cohort_rows as (
    select
      cohort.cohort_week,
      cohort.plan_code,
      count(*)::integer as cohort_size,
      count(*) filter (where exists (
        select 1 from public.product_analytics_sessions later
        where later.actor_key = cohort.actor_key and not later.is_internal
          and later.started_at >= cohort.first_seen_at + interval '1 day'
          and later.started_at < cohort.first_seen_at + interval '2 days'
      ))::integer as d1,
      count(*) filter (where exists (
        select 1 from public.product_analytics_sessions later
        where later.actor_key = cohort.actor_key and not later.is_internal
          and later.started_at >= cohort.first_seen_at + interval '7 days'
          and later.started_at < cohort.first_seen_at + interval '8 days'
      ))::integer as d7,
      count(*) filter (where exists (
        select 1 from public.product_analytics_sessions later
        where later.actor_key = cohort.actor_key and not later.is_internal
          and later.started_at >= cohort.first_seen_at + interval '30 days'
          and later.started_at < cohort.first_seen_at + interval '31 days'
      ))::integer as d30
    from cohorts cohort
    group by cohort.cohort_week, cohort.plan_code
    having count(*) >= 5
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'cohortWeek', cohort_week,
    'planCode', plan_code,
    'cohortSize', cohort_size,
    'd1', d1,
    'd1Percent', round(100 * d1::numeric / cohort_size, 1),
    'd7', case when cohort_week <= current_date - 7 then d7 else null end,
    'd7Percent', case when cohort_week <= current_date - 7 then round(100 * d7::numeric / cohort_size, 1) else null end,
    'd30', case when cohort_week <= current_date - 30 then d30 else null end,
    'd30Percent', case when cohort_week <= current_date - 30 then round(100 * d30::numeric / cohort_size, 1) else null end
  ) order by cohort_week desc, plan_code), '[]'::jsonb)
  into result
  from cohort_rows;

  return result;
end;
$function$;

create or replace function security_private.admin_get_system_health_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, private, pg_temp
as $function$
declare
  result jsonb;
begin
  if not security_private.has_admin_permission_v1('operations.manage') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'checkedAt', now(),
    'analyticsEvents24h', (
      select count(*) from public.product_analytics_events
      where received_at >= now() - interval '24 hours'
    ),
    'gedcomImports', jsonb_build_object(
      'active', count(*) filter (where import_job.status in ('preparing','importing','rolling_back')),
      'stalled', count(*) filter (
        where import_job.status in ('preparing','importing','rolling_back')
          and import_job.heartbeat_at < now() - interval '10 minutes'
      )
    ),
    'gedcomExports', (
      select jsonb_build_object(
        'queued', count(*) filter (where export.status = 'queued'),
        'processing', count(*) filter (where export.status = 'processing'),
        'failed', count(*) filter (where export.status = 'failed')
      ) from private.gedcom_export_jobs export
    ),
    'projectDeletions', (
      select jsonb_build_object(
        'queued', count(*) filter (where deletion.status = 'queued'),
        'running', count(*) filter (where deletion.status = 'running'),
        'failed', count(*) filter (where deletion.status = 'failed')
      ) from private.project_deletion_jobs deletion
    ),
    'storage', (
      select jsonb_build_object(
        'objects', coalesce(sum(bucket_usage.object_count), 0),
        'bytes', coalesce(sum(bucket_usage.total_bytes), 0),
        'buckets', coalesce(jsonb_agg(jsonb_build_object(
          'bucketId', bucket_usage.bucket_id,
          'objects', bucket_usage.object_count,
          'bytes', bucket_usage.total_bytes
        ) order by bucket_usage.total_bytes desc), '[]'::jsonb)
      )
      from (
        select
          stored_object.bucket_id,
          count(*)::integer as object_count,
          coalesce(sum(case
            when stored_object.metadata ->> 'size' ~ '^[0-9]+$'
              then (stored_object.metadata ->> 'size')::bigint
            else 0
          end), 0)::bigint as total_bytes
        from storage.objects stored_object
        group by stored_object.bucket_id
      ) bucket_usage
    )
  ) into result
  from private.gedcom_import_operations import_job;

  return result;
end;
$function$;

create or replace function security_private.admin_get_security_audit_v1(
  p_limit integer default 100
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
  if not security_private.has_admin_permission_v1('security.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'INVALID_LIMIT' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(to_jsonb(audit_row) order by audit_row.created_at desc), '[]'::jsonb)
  into result
  from (
    select audit.action_code, audit.target_type, audit.outcome, audit.created_at
    from public.admin_audit_log audit
    order by audit.created_at desc
    limit p_limit
  ) audit_row;
  return result;
end;
$function$;

create or replace function public.admin_get_product_analytics_actions(
  p_from timestamptz, p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_product_analytics_actions_v1($1,$2) $$;

create or replace function public.get_my_admin_analytics_preferences()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.get_my_admin_analytics_preferences_v1() $$;

create or replace function public.set_my_admin_analytics_preferences(
  p_period_days smallint, p_funnel_code text
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $$ select security_private.set_my_admin_analytics_preferences_v1($1,$2) $$;

create or replace function public.admin_get_product_analytics_funnel(
  p_from timestamptz, p_to timestamptz, p_funnel_code text
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_product_analytics_funnel_v1($1,$2,$3) $$;

create or replace function public.admin_get_product_analytics_retention(
  p_from timestamptz, p_to timestamptz
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_product_analytics_retention_v1($1,$2) $$;

create or replace function public.admin_get_system_health()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_system_health_v1() $$;

create or replace function public.admin_get_security_audit(p_limit integer default 100)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $$ select security_private.admin_get_security_audit_v1($1) $$;

revoke all on function security_private.has_admin_permission_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.get_my_admin_analytics_preferences_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.set_my_admin_analytics_preferences_v1(smallint,text) from public, anon, authenticated, service_role;
revoke all on function security_private.sync_app_admin_super_role_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_product_analytics_actions_v1(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_product_analytics_funnel_v1(timestamptz,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_product_analytics_retention_v1(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_system_health_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_security_audit_v1(integer) from public, anon, authenticated, service_role;

grant execute on function security_private.has_admin_permission_v1(text) to authenticated, service_role;
grant execute on function security_private.get_my_admin_analytics_preferences_v1() to authenticated, service_role;
grant execute on function security_private.set_my_admin_analytics_preferences_v1(smallint,text) to authenticated, service_role;
grant execute on function security_private.sync_app_admin_super_role_v1() to service_role;
grant execute on function security_private.admin_get_product_analytics_actions_v1(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function security_private.admin_get_product_analytics_funnel_v1(timestamptz,timestamptz,text) to authenticated, service_role;
grant execute on function security_private.admin_get_product_analytics_retention_v1(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function security_private.admin_get_system_health_v1() to authenticated, service_role;
grant execute on function security_private.admin_get_security_audit_v1(integer) to authenticated, service_role;

revoke all on function public.admin_get_product_analytics_actions(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.get_my_admin_analytics_preferences() from public, anon, authenticated, service_role;
revoke all on function public.set_my_admin_analytics_preferences(smallint,text) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_product_analytics_funnel(timestamptz,timestamptz,text) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_product_analytics_retention(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_system_health() from public, anon, authenticated, service_role;
revoke all on function public.admin_get_security_audit(integer) from public, anon, authenticated, service_role;

grant execute on function public.admin_get_product_analytics_actions(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function public.get_my_admin_analytics_preferences() to authenticated, service_role;
grant execute on function public.set_my_admin_analytics_preferences(smallint,text) to authenticated, service_role;
grant execute on function public.admin_get_product_analytics_funnel(timestamptz,timestamptz,text) to authenticated, service_role;
grant execute on function public.admin_get_product_analytics_retention(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function public.admin_get_system_health() to authenticated, service_role;
grant execute on function public.admin_get_security_audit(integer) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
