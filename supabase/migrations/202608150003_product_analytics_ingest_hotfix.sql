begin;

-- Replace the unsupported JSON object-length check with an implementation that
-- validates the exact key set
-- through jsonb_object_keys(), after first proving that the value is an object.
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

commit;
