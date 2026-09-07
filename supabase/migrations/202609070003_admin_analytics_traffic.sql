begin;

-- Global, consent-based analytics. No project filters, identities or raw URLs.
-- Keep this closed catalogue in sync with the collector and the frontend registry.
create or replace function security_private.product_analytics_page_codes_v1()
returns text[] language sql immutable security invoker set search_path = pg_catalog
as $function$
  select array['projects','dashboard','map','persons_list','person_profile','person_edit','person_social','person_ritual','person_documentary','person_research','places','place_profile','place_edit','family_tree','family_tree_pedigree','ancestor_wheel','family_constellation','family_fan','tree_statistics','researches','documents','document_viewer','requests','year_matrix','tasks','findings','hypotheses','backup','settings','subscription','feedback','notes','zagulyaky_mine','custom_section','unknown' ]::text[];
$function$;
revoke all on function security_private.product_analytics_page_codes_v1() from public, anon, authenticated;
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
  allowed_pages constant text[] := security_private.product_analytics_page_codes_v1();
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
    if jsonb_typeof(event_value) <> 'object' then
      raise exception 'INVALID_ANALYTICS_EVENT' using errcode = '22023';
    end if;

    if (select count(*) from jsonb_object_keys(event_value)) <> 9
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

revoke all on function security_private.ingest_product_analytics_batch_v1(
  text, uuid, boolean, text, text, text, text, smallint, jsonb
) from public, anon, authenticated, service_role;
grant execute on function security_private.ingest_product_analytics_batch_v1(
  text, uuid, boolean, text, text, text, text, smallint, jsonb
) to service_role;

-- Zero activity is not a suppressed cohort. Never turn 1..4 actors into zero.
create or replace function security_private.product_analytics_metrics_v1(
  users bigint, sessions bigint, views bigint, seconds numeric
) returns jsonb language sql immutable security invoker set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'suppressed', users between 1 and 4, 'minimumCohort', 5,
    'users', case when users not between 1 and 4 then users end,
    'sessions', case when users not between 1 and 4 then sessions end,
    'pageViews', case when users not between 1 and 4 then views end,
    'activeSeconds', case when users not between 1 and 4 then seconds end,
    'averageSessionSeconds', case when users not between 1 and 4
      then coalesce(round(seconds / nullif(sessions, 0), 1), 0) end,
    'averageUserSeconds', case when users not between 1 and 4
      then coalesce(round(seconds / nullif(users, 0), 1), 0) end
  );
$function$;
revoke all on function security_private.product_analytics_metrics_v1(bigint,bigint,bigint,numeric)
  from public, anon, authenticated;

-- Already ingested active-time events act as a heartbeat: no extra writes,
-- no expensive full-history scan and no realtime subscription per visitor.
create index if not exists product_analytics_events_presence_idx
  on public.product_analytics_events (occurred_at desc)
  include (actor_key, session_id) where event_name = 'page_active_time';

create or replace function security_private.admin_get_product_analytics_online_v1()
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare actor_count bigint;
begin
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select count(distinct e.actor_key) into actor_count
  from public.product_analytics_events e
  join public.product_analytics_sessions s on s.id = e.session_id
  where not s.is_internal and e.event_name = 'page_active_time'
    and e.occurred_at >= now() - interval '2 minutes' and e.occurred_at <= now();
  return jsonb_build_object(
    'checkedAt', now(), 'windowSeconds', 120, 'minimumCohort', 5,
    'suppressed', actor_count between 1 and 4,
    'users', case when actor_count not between 1 and 4 then actor_count end
  );
end;
$function$;

-- Count activity INSIDE the requested period, including sessions begun earlier.
-- Lifetime session totals would leak time from outside the period into reports.
create or replace function security_private.admin_get_product_analytics_overview_v1(
  p_from timestamptz, p_to timestamptz
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_from >= p_to or p_to - p_from > interval '370 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;
  select security_private.product_analytics_metrics_v1(
    count(distinct e.actor_key), count(distinct e.session_id),
    count(*) filter (where e.event_name = 'page_viewed'),
    coalesce(sum(e.active_seconds), 0)::numeric
  ) into result
  from public.product_analytics_events e
  join public.product_analytics_sessions s on s.id = e.session_id
  where not s.is_internal and e.occurred_at >= p_from and e.occurred_at < p_to
    and e.event_name in ('session_started','page_viewed','page_active_time');
  return result;
end;
$function$;

create or replace function security_private.admin_get_product_analytics_pages_v1(
  p_from timestamptz, p_to timestamptz
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_from >= p_to or p_to - p_from > interval '91 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;
  with totals as (
    select e.page_code, count(distinct e.actor_key) as users,
      count(*) filter (where e.event_name = 'page_viewed') as views,
      coalesce(sum(e.active_seconds), 0) as seconds
    from public.product_analytics_events e
    join public.product_analytics_sessions s on s.id = e.session_id
    where not s.is_internal and e.occurred_at >= p_from and e.occurred_at < p_to
      and e.event_name in ('session_started','page_viewed','page_active_time')
    group by e.page_code
  ), catalogue as (
    select code, coalesce(t.users,0) as users, coalesce(t.views,0) as views,
      coalesce(t.seconds,0) as seconds
    from unnest(security_private.product_analytics_page_codes_v1()) code
    left join totals t on t.page_code = code
  )
  select jsonb_agg(jsonb_build_object(
    'page_code', code, 'suppressed', users between 1 and 4,
    'users', case when users not between 1 and 4 then users end,
    'page_views', case when users not between 1 and 4 then views end,
    'active_seconds', case when users not between 1 and 4 then seconds end,
    'average_active_seconds', case when users not between 1 and 4
      then coalesce(round(seconds::numeric / nullif(users,0),1),0) end
  ) order by case when users not between 1 and 4 then seconds else -1 end desc, code)
  into result from catalogue;
  return coalesce(result, '[]'::jsonb);
end;
$function$;

create or replace function security_private.admin_get_product_analytics_traffic_v1(
  p_from timestamptz, p_to timestamptz
) returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if not security_private.has_admin_permission_v1('analytics.view') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_from >= p_to or p_to - p_from > interval '91 days' then
    raise exception 'INVALID_DATE_RANGE' using errcode = '22023';
  end if;
  -- Materialize the bounded, indexed interval once for all three breakdowns.
  with activity as materialized (
    select e.actor_key, e.session_id, e.event_name, e.active_seconds,
      (e.occurred_at at time zone 'Europe/Kyiv')::date as day,
      extract(hour from e.occurred_at at time zone 'Europe/Kyiv')::integer as hour,
      s.device_class
    from public.product_analytics_events e
    join public.product_analytics_sessions s on s.id = e.session_id
    where not s.is_internal and e.occurred_at >= p_from and e.occurred_at < p_to
      and e.event_name in ('session_started','page_viewed','page_active_time')
  ), daily as (
    select day, security_private.product_analytics_metrics_v1(
      count(distinct actor_key), count(distinct session_id),
      count(*) filter (where event_name = 'page_viewed'),
      coalesce(sum(active_seconds),0)::numeric
    ) as metrics from activity group by day
  ), hourly as (
    select hour, security_private.product_analytics_metrics_v1(
      count(distinct actor_key), count(distinct session_id),
      count(*) filter (where event_name = 'page_viewed'),
      coalesce(sum(active_seconds),0)::numeric
    ) as metrics from activity group by hour
  ), devices as (
    select device_class, security_private.product_analytics_metrics_v1(
      count(distinct actor_key), count(distinct session_id),
      count(*) filter (where event_name = 'page_viewed'),
      coalesce(sum(active_seconds),0)::numeric
    ) as metrics from activity group by device_class
  ), calendar as (
    select ((p_from at time zone 'Europe/Kyiv')::date + offset_day) as day
    from generate_series(0,
      ((p_to - interval '1 microsecond') at time zone 'Europe/Kyiv')::date
        - (p_from at time zone 'Europe/Kyiv')::date
    ) offset_day
  )
  select jsonb_build_object(
    'timezone', 'Europe/Kyiv', 'from', p_from, 'to', p_to, 'minimumCohort', 5,
    'daily', (select jsonb_agg(
      jsonb_build_object('day', calendar.day) ||
      coalesce(daily.metrics, security_private.product_analytics_metrics_v1(0,0,0,0))
      order by calendar.day) from calendar left join daily using(day)),
    'hourly', (select jsonb_agg(
      jsonb_build_object('hour', h) ||
      coalesce(hourly.metrics, security_private.product_analytics_metrics_v1(0,0,0,0))
      order by h) from generate_series(0,23) h left join hourly on hourly.hour = h),
    'devices', (select jsonb_agg(
      jsonb_build_object('device', d) ||
      coalesce(devices.metrics, security_private.product_analytics_metrics_v1(0,0,0,0))
      order by d) from unnest(array['desktop','tablet','mobile','unknown']) d
      left join devices on devices.device_class = d)
  ) into result;
  return result;
end;
$function$;

create or replace function public.admin_get_product_analytics_online()
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $function$ select security_private.admin_get_product_analytics_online_v1(); $function$;
create or replace function public.admin_get_product_analytics_traffic(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $function$ select security_private.admin_get_product_analytics_traffic_v1(p_from, p_to); $function$;

revoke all on function security_private.admin_get_product_analytics_online_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_product_analytics_traffic_v1(timestamptz,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_product_analytics_online() from public, anon, authenticated, service_role;
revoke all on function public.admin_get_product_analytics_traffic(timestamptz,timestamptz) from public, anon, authenticated, service_role;
grant execute on function security_private.admin_get_product_analytics_online_v1() to authenticated, service_role;
grant execute on function security_private.admin_get_product_analytics_traffic_v1(timestamptz,timestamptz) to authenticated, service_role;
grant execute on function public.admin_get_product_analytics_online() to authenticated, service_role;
grant execute on function public.admin_get_product_analytics_traffic(timestamptz,timestamptz) to authenticated, service_role;

notify pgrst, 'reload schema';
commit;

