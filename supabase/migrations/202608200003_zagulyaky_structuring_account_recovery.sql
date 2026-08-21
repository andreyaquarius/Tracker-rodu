begin;

-- Preserve the existing bounded, explicit recovery workflow when Gemini
-- reports a safe account/billing/region precondition. This migration reads no
-- staged source content and touches only terminal task state plus audit data.
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
      and task.attempt_count < task.max_attempts
      and task.last_error_code in (
        'STRUCTURE_CONFIG_MISSING_KEY',
        'STRUCTURE_GEMINI_AUTH_FAILED',
        'STRUCTURE_GEMINI_ACCOUNT_PRECONDITION',
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
      'attemptCountsPreserved', true,
      'exhaustedTasksExcluded', true
    )
  );

  return jsonb_build_object(
    'runId', p_run_id,
    'requeuedCount', requeued_count,
    'run', security_private.zagulyaky_structuring_run_projection_v1(p_run_id)
  );
end;
$function$;

revoke all on function security_private.admin_retry_zagulyaky_structuring_failed_tasks_v1(uuid,integer,boolean)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_retry_zagulyaky_structuring_failed_tasks_v1(uuid,integer,boolean)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
