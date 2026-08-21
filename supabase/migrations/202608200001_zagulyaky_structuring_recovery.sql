begin;

-- A run can have queued work and a terminal task failure at the same time.
-- Persist only the newest safe task code on the run so the protected admin
-- projection explains why a human must repair configuration before continuing.
create or replace function security_private.zagulyaky_structuring_refresh_run_v1(
  p_run_id uuid
)
returns public.zagulyaky_structuring_runs
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  run_row public.zagulyaky_structuring_runs;
  task_total integer := 0;
  queued_total integer := 0;
  processing_total integer := 0;
  succeeded_total integer := 0;
  failed_total integer := 0;
  zero_candidate_total integer := 0;
  candidate_total integer := 0;
  materialized_total integer := 0;
  latest_failed_error_code text;
  next_status text;
begin
  select * into run_row
  from public.zagulyaky_structuring_runs
  where id = p_run_id
  for update;
  if not found then
    raise exception 'STRUCTURING_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;

  select
    count(*),
    count(*) filter (where status in ('queued', 'retry')),
    count(*) filter (where status = 'processing'),
    count(*) filter (where status = 'succeeded'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status = 'succeeded' and result_candidate_count = 0)
  into task_total, queued_total, processing_total, succeeded_total, failed_total, zero_candidate_total
  from public.zagulyaky_structuring_tasks
  where run_id = p_run_id;

  select task.last_error_code
  into latest_failed_error_code
  from public.zagulyaky_structuring_tasks task
  where task.run_id = p_run_id
    and task.status = 'failed'
    and task.last_error_code is not null
  order by task.completed_at desc nulls last, task.updated_at desc, task.id desc
  limit 1;

  select
    count(*),
    count(*) filter (where status = 'materialized')
  into candidate_total, materialized_total
  from public.zagulyaky_ingestion_structured_candidates
  where run_id = p_run_id;

  next_status := case
    when run_row.status = 'cancelled' then 'cancelled'
    when processing_total > 0 then 'processing'
    when queued_total > 0 then 'queued'
    when task_total = 0 then 'queued'
    when failed_total > 0 then 'completed_with_errors'
    else 'completed'
  end;

  update public.zagulyaky_structuring_runs
  set status = next_status,
      selected_item_count = task_total,
      queued_task_count = queued_total,
      processing_task_count = processing_total,
      succeeded_task_count = succeeded_total,
      failed_task_count = failed_total,
      zero_candidate_task_count = zero_candidate_total,
      candidate_count = candidate_total,
      materialized_candidate_count = materialized_total,
      last_error_code = case when failed_total > 0 then latest_failed_error_code else null end,
      completed_at = case
        when next_status in ('completed', 'completed_with_errors') then coalesce(completed_at, now())
        else null
      end,
      updated_at = now()
  where id = p_run_id
  returning * into run_row;

  return run_row;
end;
$function$;

-- This recovery route is intentionally narrow. It never reads source text or
-- changes candidates/catalogue rows. An import administrator must explicitly
-- acknowledge that the external Gemini configuration was repaired first.
create or replace function security_private.admin_retry_zagulyaky_structuring_failed_tasks_v1(
  p_run_id uuid,
  p_limit integer default 25,
  p_explicit_confirmation boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  run_row public.zagulyaky_structuring_runs;
  target_task_ids uuid[] := '{}'::uuid[];
  recovery_codes jsonb := '[]'::jsonb;
  requeued_count integer := 0;
begin
  if current_user_id is null
    or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_explicit_confirmation is not true then
    raise exception 'STRUCTURING_RETRY_CONFIRMATION_REQUIRED' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100 then
    raise exception 'STRUCTURING_INVALID_RETRY_LIMIT' using errcode = '22023';
  end if;

  select * into run_row
  from public.zagulyaky_structuring_runs
  where id = p_run_id
  for update;
  if not found then
    raise exception 'STRUCTURING_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  if run_row.status = 'cancelled' then
    raise exception 'STRUCTURING_RUN_CANCELLED' using errcode = '55000';
  end if;

  select
    coalesce(array_agg(target.id order by target.source_item_index, target.id), '{}'::uuid[]),
    coalesce(jsonb_agg(target.last_error_code order by target.source_item_index, target.id), '[]'::jsonb)
  into target_task_ids, recovery_codes
  from (
    select task.id, task.source_item_index, task.last_error_code
    from public.zagulyaky_structuring_tasks task
    where task.run_id = p_run_id
      and task.status = 'failed'
      and task.last_error_code in (
        'STRUCTURE_CONFIG_MISSING_KEY',
        'STRUCTURE_GEMINI_AUTH_FAILED',
        'STRUCTURE_GEMINI_REQUEST_INVALID',
        'STRUCTURE_GEMINI_MODEL_UNAVAILABLE',
        'STRUCTURE_GEMINI_RATE_LIMITED',
        'STRUCTURE_GEMINI_UNAVAILABLE'
      )
    order by task.source_item_index, task.id
    limit p_limit
    for update skip locked
  ) target;

  if cardinality(target_task_ids) > 0 then
    update public.zagulyaky_structuring_tasks task
    set status = 'retry',
        next_attempt_at = now(),
        claim_token = null,
        claimed_by = null,
        claimed_at = null,
        lease_expires_at = null,
        last_error_code = null,
        completed_at = null,
        updated_at = now()
    where task.id = any(target_task_ids);
    requeued_count := cardinality(target_task_ids);
  end if;

  perform security_private.zagulyaky_structuring_refresh_run_v1(p_run_id);

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id,
    'zagulyaky.structuring.retry_failed_tasks',
    'zagulyaky_structuring_run',
    p_run_id::text,
    'success',
    jsonb_build_object(
      'requeuedCount', requeued_count,
      'recoveryCodes', recovery_codes,
      'attemptCountsPreserved', true
    )
  );

  return jsonb_build_object(
    'runId', p_run_id,
    'requeuedCount', requeued_count,
    'run', security_private.zagulyaky_structuring_run_projection_v1(p_run_id)
  );
end;
$function$;

create or replace function public.admin_retry_zagulyaky_structuring_failed_tasks_v1(
  p_run_id uuid,
  p_limit integer default 25,
  p_explicit_confirmation boolean default false
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_retry_zagulyaky_structuring_failed_tasks_v1($1, $2, $3)
$function$;

revoke all on function security_private.admin_retry_zagulyaky_structuring_failed_tasks_v1(uuid,integer,boolean)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_retry_zagulyaky_structuring_failed_tasks_v1(uuid,integer,boolean)
  to authenticated, service_role;

revoke all on function public.admin_retry_zagulyaky_structuring_failed_tasks_v1(uuid,integer,boolean)
  from public, anon;
grant execute on function public.admin_retry_zagulyaky_structuring_failed_tasks_v1(uuid,integer,boolean)
  to authenticated, service_role;

-- Backfill the safe aggregate error code for existing interrupted runs. This
-- touches only run counters/status metadata, never staged content.
select security_private.zagulyaky_structuring_refresh_run_v1(run_row.id)
from public.zagulyaky_structuring_runs run_row
where run_row.failed_task_count > 0
   or exists (
     select 1
     from public.zagulyaky_structuring_tasks task
     where task.run_id = run_row.id and task.status = 'failed'
   );

notify pgrst, 'reload schema';

commit;
