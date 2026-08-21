-- Durable private-object cleanup for deleted Zagulyaky drafts.
--
-- Storage deletion is intentionally performed by an Edge Function with a
-- server key.  SQL only records the work before the draft's attachment rows
-- are removed by the record cascade, so a transient Storage failure cannot
-- orphan the only reference to an object path.

begin;

create table if not exists public.zagulyaky_storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  -- These deliberately have no foreign keys.  The record and attachment are
  -- deleted in the transaction that enqueues this task, while the outbox must
  -- survive long enough to retry the physical Storage deletion.
  record_id uuid not null,
  source_attachment_id uuid,
  owner_id uuid not null,
  storage_bucket text not null check (storage_bucket in ('zagulyaky-private', 'zagulyaky-public')),
  storage_path text not null check (
    char_length(storage_path) between 3 and 500
    and position('..' in storage_path) = 0
    and (
      (
        storage_bucket = 'zagulyaky-private'
        and storage_path like (owner_id::text || '/' || record_id::text || '/%')
      )
      or (
        storage_bucket = 'zagulyaky-public'
        and source_attachment_id is not null
        and storage_path like ('catalogue/' || record_id::text || '/' || source_attachment_id::text || '/%')
      )
    )
  ),
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'retry', 'completed', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 1000),
  next_attempt_at timestamptz default clock_timestamp(),
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  last_result_claim_token uuid,
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (storage_bucket, storage_path),
  check (
    (status in ('queued', 'retry') and next_attempt_at is not null)
    or (status = 'processing' and lease_expires_at is not null)
    or status in ('completed', 'failed')
  )
);

-- A public derivative must never reuse the Storage name from a prior
-- publication. A lease-expired worker can legally finish after another worker
-- has finalized its old outbox row, so a status fence alone cannot protect a
-- deterministic name from a stale physical `remove`.
alter table public.zagulyaky_attachments
  add column if not exists public_derivative_generation uuid;

create index if not exists zagulyaky_storage_cleanup_queue_due_idx
  on public.zagulyaky_storage_cleanup_queue(status, next_attempt_at, created_at, id)
  where status in ('queued', 'retry');

create index if not exists zagulyaky_storage_cleanup_queue_owner_due_idx
  on public.zagulyaky_storage_cleanup_queue(owner_id, status, next_attempt_at, created_at, id)
  where status in ('queued', 'retry');

alter table public.zagulyaky_storage_cleanup_queue enable row level security;

-- Browser roles have no direct table access.  They can only ask the protected
-- RPC to claim their own *private* queued paths; public-derivative paths are
-- service-worker-only. The Edge Function receives all paths server-side and
-- uses its service key to remove the object.
revoke all on table public.zagulyaky_storage_cleanup_queue from public, anon, authenticated;
grant all on table public.zagulyaky_storage_cleanup_queue to service_role;

-- 202608190001 audits attachment deletes by inserting a child moderation row.
-- During a record's ON DELETE CASCADE the parent may already be invisible to
-- the immediate FK check. Keep audits for ordinary attachment removal, but do
-- not manufacture a child row when its parent is itself being deleted.
create or replace function security_private.audit_zagulyaky_attachment_change_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  attachment_id uuid;
  parent_record_id uuid;
  attachment_mime text;
  attachment_size bigint;
begin
  if tg_op = 'INSERT' then
    attachment_id := new.id;
    parent_record_id := new.record_id;
    attachment_mime := new.mime_type;
    attachment_size := new.byte_size;
  elsif tg_op = 'DELETE' then
    attachment_id := old.id;
    parent_record_id := old.record_id;
    attachment_mime := old.mime_type;
    attachment_size := old.byte_size;
  else
    return null;
  end if;

  if exists (select 1 from public.zagulyaky_records where id = parent_record_id) then
    insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, metadata)
    values (
      parent_record_id,
      auth.uid(),
      case when tg_op = 'INSERT' then 'attachment_add' else 'attachment_remove' end,
      jsonb_build_object('attachmentId', attachment_id, 'mimeType', attachment_mime, 'byteSize', attachment_size)
    );
  end if;

  if tg_op = 'INSERT' then return new; end if;
  return old;
end;
$function$;

-- Only trusted mutation RPCs call this helper. Its conflict rule preserves an
-- in-flight/retry task, while a completed historical task can be safely
-- reopened for a newly queued physical path.
create or replace function security_private.enqueue_zagulyaky_storage_cleanup_v1(
  p_record_id uuid,
  p_source_attachment_id uuid,
  p_owner_id uuid,
  p_storage_bucket text,
  p_storage_path text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  saved_task public.zagulyaky_storage_cleanup_queue;
begin
  if p_record_id is null or p_source_attachment_id is null or p_owner_id is null
    or p_storage_bucket is null or p_storage_path is null then
    raise exception 'INVALID_ZAGULYAKY_STORAGE_CLEANUP_TASK' using errcode = '22023';
  end if;

  insert into public.zagulyaky_storage_cleanup_queue(
    record_id,
    source_attachment_id,
    owner_id,
    storage_bucket,
    storage_path,
    status,
    next_attempt_at
  ) values (
    p_record_id,
    p_source_attachment_id,
    p_owner_id,
    p_storage_bucket,
    p_storage_path,
    'queued',
    clock_timestamp()
  )
  on conflict (storage_bucket, storage_path) do update
  set record_id = excluded.record_id,
      source_attachment_id = excluded.source_attachment_id,
      owner_id = excluded.owner_id,
      status = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then 'queued'
        else public.zagulyaky_storage_cleanup_queue.status
      end,
      next_attempt_at = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then clock_timestamp()
        else public.zagulyaky_storage_cleanup_queue.next_attempt_at
      end,
      completed_at = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.completed_at
      end,
      failed_at = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.failed_at
      end,
      attempt_count = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then 0
        else public.zagulyaky_storage_cleanup_queue.attempt_count
      end,
      claim_token = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.claim_token
      end,
      claimed_by = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.claimed_by
      end,
      claimed_at = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.claimed_at
      end,
      lease_expires_at = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.lease_expires_at
      end,
      last_result_claim_token = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.last_result_claim_token
      end,
      last_error = case
        when public.zagulyaky_storage_cleanup_queue.status = 'completed' then null
        else public.zagulyaky_storage_cleanup_queue.last_error
      end,
      updated_at = clock_timestamp()
  returning * into saved_task;

  return jsonb_build_object(
    'taskId', saved_task.id,
    'status', saved_task.status
  );
end;
$function$;

create or replace function security_private.claim_my_zagulyaky_storage_cleanup_v1(
  p_limit integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 25);
  now_at timestamptz := clock_timestamp();
  claimed_tasks jsonb;
  exhausted_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  -- Avoid overflowing the table's bounded attempt_count. An expired worker at
  -- its final lease becomes terminal and does not poison the rest of a batch.
  update public.zagulyaky_storage_cleanup_queue task
  set status = 'failed',
      next_attempt_at = null,
      lease_expires_at = null,
      failed_at = now_at,
      last_error = 'ZAGULYAKY_STORAGE_CLEANUP_ATTEMPTS_EXHAUSTED',
      updated_at = now_at
  where task.owner_id = current_user_id
    and task.storage_bucket = 'zagulyaky-private'
    and task.attempt_count >= 1000
    and (
      task.status in ('queued', 'retry')
      or (task.status = 'processing' and task.lease_expires_at <= now_at)
    );
  get diagnostics exhausted_count = row_count;

  with candidates as (
    select task.id
    from public.zagulyaky_storage_cleanup_queue task
    where task.owner_id = current_user_id
      and task.storage_bucket = 'zagulyaky-private'
      and task.attempt_count < 1000
      and (
        (task.status in ('queued', 'retry') and task.next_attempt_at <= now_at)
        or (task.status = 'processing' and task.lease_expires_at <= now_at)
      )
    order by
      case task.status when 'queued' then 0 when 'retry' then 1 else 2 end,
      coalesce(task.next_attempt_at, task.lease_expires_at, task.created_at),
      task.id
    for update skip locked
    limit safe_limit
  ), claimed as (
    update public.zagulyaky_storage_cleanup_queue task
    set status = 'processing',
        attempt_count = task.attempt_count + 1,
        next_attempt_at = null,
        claim_token = gen_random_uuid(),
        claimed_by = 'user:' || current_user_id::text,
        claimed_at = now_at,
        lease_expires_at = now_at + interval '10 minutes',
        failed_at = null,
        last_result_claim_token = null,
        last_error = case
          when task.status = 'processing' then 'ZAGULYAKY_STORAGE_CLEANUP_LEASE_EXPIRED'
          else task.last_error
        end,
        updated_at = now_at
    from candidates
    where task.id = candidates.id
    returning task.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'taskId', claimed.id,
        'storageBucket', claimed.storage_bucket,
        'storagePath', claimed.storage_path,
        'claimToken', claimed.claim_token
      ) order by claimed.created_at, claimed.id
    ),
    '[]'::jsonb
  )
  into claimed_tasks
  from claimed;

  return jsonb_build_object(
    'tasks', claimed_tasks,
    'count', jsonb_array_length(claimed_tasks),
    'exhaustedCount', exhausted_count
  );
end;
$function$;

create or replace function security_private.claim_zagulyaky_storage_cleanup_queue_v1(
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  now_at timestamptz := clock_timestamp();
  claimed_tasks jsonb;
  exhausted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  update public.zagulyaky_storage_cleanup_queue task
  set status = 'failed',
      next_attempt_at = null,
      lease_expires_at = null,
      failed_at = now_at,
      last_error = 'ZAGULYAKY_STORAGE_CLEANUP_ATTEMPTS_EXHAUSTED',
      updated_at = now_at
  where task.attempt_count >= 1000
    and (
      task.status in ('queued', 'retry')
      or (task.status = 'processing' and task.lease_expires_at <= now_at)
    );
  get diagnostics exhausted_count = row_count;

  with candidates as (
    select task.id
    from public.zagulyaky_storage_cleanup_queue task
    where task.attempt_count < 1000
      and (
      (task.status in ('queued', 'retry') and task.next_attempt_at <= now_at)
      or (task.status = 'processing' and task.lease_expires_at <= now_at)
    )
    order by
      case task.status when 'queued' then 0 when 'retry' then 1 else 2 end,
      coalesce(task.next_attempt_at, task.lease_expires_at, task.created_at),
      task.id
    for update skip locked
    limit safe_limit
  ), claimed as (
    update public.zagulyaky_storage_cleanup_queue task
    set status = 'processing',
        attempt_count = task.attempt_count + 1,
        next_attempt_at = null,
        claim_token = gen_random_uuid(),
        claimed_by = 'service_role',
        claimed_at = now_at,
        lease_expires_at = now_at + interval '10 minutes',
        failed_at = null,
        last_result_claim_token = null,
        last_error = case
          when task.status = 'processing' then 'ZAGULYAKY_STORAGE_CLEANUP_LEASE_EXPIRED'
          else task.last_error
        end,
        updated_at = now_at
    from candidates
    where task.id = candidates.id
    returning task.*
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'taskId', claimed.id,
        'storageBucket', claimed.storage_bucket,
        'storagePath', claimed.storage_path,
        'claimToken', claimed.claim_token
      ) order by claimed.created_at, claimed.id
    ),
    '[]'::jsonb
  )
  into claimed_tasks
  from claimed;

  return jsonb_build_object(
    'tasks', claimed_tasks,
    'count', jsonb_array_length(claimed_tasks),
    'exhaustedCount', exhausted_count
  );
end;
$function$;

create or replace function security_private.claim_zagulyaky_storage_cleanup_task_v1(
  p_task_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  task public.zagulyaky_storage_cleanup_queue;
  claimed_task public.zagulyaky_storage_cleanup_queue;
  now_at timestamptz := clock_timestamp();
  exhausted_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_task_id is null then
    raise exception 'INVALID_ZAGULYAKY_STORAGE_CLEANUP_TASK' using errcode = '22023';
  end if;

  update public.zagulyaky_storage_cleanup_queue queue_task
  set status = 'failed',
      next_attempt_at = null,
      lease_expires_at = null,
      failed_at = now_at,
      last_error = 'ZAGULYAKY_STORAGE_CLEANUP_ATTEMPTS_EXHAUSTED',
      updated_at = now_at
  where queue_task.id = p_task_id
    and queue_task.attempt_count >= 1000
    and (
      queue_task.status in ('queued', 'retry')
      or (queue_task.status = 'processing' and queue_task.lease_expires_at <= now_at)
    );
  get diagnostics exhausted_count = row_count;

  -- A targeted service claim lets an authenticated revoke request trigger its
  -- own public-path cleanup without exposing that path to the browser or
  -- accidentally draining unrelated work from the queue.
  select queue_task.* into task
  from public.zagulyaky_storage_cleanup_queue queue_task
  where queue_task.id = p_task_id
    and queue_task.attempt_count < 1000
    and (
      queue_task.status in ('queued', 'retry')
      or (queue_task.status = 'processing' and queue_task.lease_expires_at <= now_at)
    )
  for update skip locked;

  if not found then
    select * into task
    from public.zagulyaky_storage_cleanup_queue
    where id = p_task_id;
    if not found then
      raise exception 'ZAGULYAKY_STORAGE_CLEANUP_TASK_NOT_FOUND' using errcode = 'P0002';
    end if;
    return jsonb_build_object(
      'task', null,
      'status', task.status,
      'claimed', false,
      'exhausted', exhausted_count > 0
    );
  end if;

  update public.zagulyaky_storage_cleanup_queue queue_task
  set status = 'processing',
      attempt_count = queue_task.attempt_count + 1,
      next_attempt_at = null,
      claim_token = gen_random_uuid(),
      claimed_by = 'service_role',
      claimed_at = now_at,
      lease_expires_at = now_at + interval '10 minutes',
      failed_at = null,
      last_result_claim_token = null,
      last_error = case
        when queue_task.status = 'processing' then 'ZAGULYAKY_STORAGE_CLEANUP_LEASE_EXPIRED'
        else queue_task.last_error
      end,
      updated_at = now_at
  where queue_task.id = task.id
  returning * into claimed_task;

  return jsonb_build_object(
    'task', jsonb_build_object(
      'taskId', claimed_task.id,
      'storageBucket', claimed_task.storage_bucket,
      'storagePath', claimed_task.storage_path,
      'claimToken', claimed_task.claim_token
    ),
    'status', claimed_task.status,
    'claimed', true,
    'exhausted', false
  );
end;
$function$;

create or replace function security_private.finalize_zagulyaky_storage_cleanup_v1(
  p_task_id uuid,
  p_claim_token uuid,
  p_removed boolean,
  p_error text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  task public.zagulyaky_storage_cleanup_queue;
  updated_task public.zagulyaky_storage_cleanup_queue;
  now_at timestamptz := clock_timestamp();
  failure_message text := left(
    coalesce(nullif(btrim(p_error), ''), 'ZAGULYAKY_STORAGE_DELETE_FAILED'),
    2000
  );
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_task_id is null or p_claim_token is null or p_removed is null then
    raise exception 'INVALID_ZAGULYAKY_STORAGE_CLEANUP_RESULT' using errcode = '22023';
  end if;

  select * into task
  from public.zagulyaky_storage_cleanup_queue
  where id = p_task_id
  for update;
  if not found then
    raise exception 'ZAGULYAKY_STORAGE_CLEANUP_TASK_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Delivery can time out after Storage already deleted the object.  Repeating
  -- the same finalization is therefore a successful no-op, not a worker error.
  if task.status in ('completed', 'failed') then
    return jsonb_build_object(
      'taskId', task.id,
      'status', task.status,
      'idempotent', true,
      'completedAt', task.completed_at,
      'failedAt', task.failed_at
    );
  end if;
  if task.last_result_claim_token is not distinct from p_claim_token then
    return jsonb_build_object(
      'taskId', task.id,
      'status', task.status,
      'idempotent', true,
      'nextAttemptAt', task.next_attempt_at
    );
  end if;
  if task.status <> 'processing' or task.claim_token is distinct from p_claim_token then
    raise exception 'ZAGULYAKY_STORAGE_CLEANUP_TASK_NOT_CLAIMED' using errcode = '55000';
  end if;

  if p_removed then
    update public.zagulyaky_storage_cleanup_queue
    set status = 'completed',
        next_attempt_at = null,
        lease_expires_at = null,
        last_result_claim_token = p_claim_token,
        last_error = null,
        completed_at = now_at,
        failed_at = null,
        updated_at = now_at
    where id = task.id
    returning * into updated_task;
  elsif task.attempt_count >= 1000 then
    update public.zagulyaky_storage_cleanup_queue
    set status = 'failed',
        next_attempt_at = null,
        lease_expires_at = null,
        last_result_claim_token = p_claim_token,
        last_error = 'ZAGULYAKY_STORAGE_CLEANUP_ATTEMPTS_EXHAUSTED',
        failed_at = now_at,
        updated_at = now_at
    where id = task.id
    returning * into updated_task;
  else
    update public.zagulyaky_storage_cleanup_queue
    set status = 'retry',
        next_attempt_at = now_at + make_interval(secs => case
          when task.attempt_count <= 1 then 30
          when task.attempt_count = 2 then 60
          when task.attempt_count = 3 then 120
          when task.attempt_count = 4 then 240
          when task.attempt_count = 5 then 480
          when task.attempt_count = 6 then 960
          else 1800
        end),
        lease_expires_at = null,
        last_result_claim_token = p_claim_token,
        last_error = failure_message,
        failed_at = null,
        updated_at = now_at
    where id = task.id
    returning * into updated_task;
  end if;

  return jsonb_build_object(
    'taskId', updated_task.id,
    'status', updated_task.status,
    'idempotent', false,
    'attemptCount', updated_task.attempt_count,
    'nextAttemptAt', updated_task.next_attempt_at,
    'completedAt', updated_task.completed_at,
    'failedAt', updated_task.failed_at
  );
end;
$function$;

-- v3 is intentionally a new contract.  v2 remains available to older
-- browsers while new callers receive a durable queued count instead of private
-- paths and never need direct client-side Storage deletion.
create or replace function public.delete_my_zagulyaka_draft_v3(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  attachment public.zagulyaky_attachments;
  owned_source_ids uuid[] := '{}'::uuid[];
  queued_task_count integer := 0;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select * into existing
  from public.zagulyaky_records
  where id = p_record_id
  for update;
  if not found or existing.created_by is distinct from current_user_id then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then
    raise exception 'ZAGULYAKA_NOT_DELETABLE' using errcode = '55000';
  end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then
    raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001';
  end if;

  -- These queue writes must remain before deleting `existing`: attachments are
  -- ON DELETE CASCADE and would otherwise take the retryable Storage paths
  -- with them. The helper's unique path key makes repeated work safe.
  for attachment in
    select *
    from public.zagulyaky_attachments
    where record_id = existing.id
      and storage_bucket = 'zagulyaky-private'
  loop
    perform security_private.enqueue_zagulyaky_storage_cleanup_v1(
      existing.id,
      attachment.id,
      current_user_id,
      attachment.storage_bucket,
      attachment.storage_path
    );
    queued_task_count := queued_task_count + 1;
  end loop;

  select coalesce(array_agg(record_source.source_id), '{}'::uuid[])
  into owned_source_ids
  from public.zagulyaky_record_sources record_source
  where record_source.record_id = existing.id;

  delete from public.zagulyaky_records where id = existing.id;
  delete from public.zagulyaky_sources source
  where source.id = any(owned_source_ids)
    and source.created_by = current_user_id
    and not exists (
      select 1
      from public.zagulyaky_record_sources record_source
      where record_source.source_id = source.id
    );

  return jsonb_build_object(
    'recordId', existing.id,
    'storageCleanup', jsonb_build_object(
      'action', 'process_mine',
      'queuedTaskCount', queued_task_count
    )
  );
end;
$function$;

-- Individual attachment removal also needs the durable path.  v1 stays for
-- compatibility; callers that use v2 receive no Storage path and should wake
-- the Edge worker with `process_mine` after this transaction commits.
create or replace function public.delete_my_zagulyaka_attachment_v2(
  p_record_id uuid,
  p_attachment_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  removed_attachment public.zagulyaky_attachments;
  updated_record public.zagulyaky_records;
  cleanup_task jsonb;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing
  from public.zagulyaky_records
  where id = p_record_id
  for update;
  if not found or existing.created_by is distinct from current_user_id then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then
    raise exception 'ZAGULYAKA_NOT_EDITABLE' using errcode = '55000';
  end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then
    raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001';
  end if;

  select * into removed_attachment
  from public.zagulyaky_attachments
  where id = p_attachment_id
    and record_id = existing.id
    and storage_bucket = 'zagulyaky-private'
    and is_public_derivative = false
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;

  cleanup_task := security_private.enqueue_zagulyaky_storage_cleanup_v1(
    existing.id,
    removed_attachment.id,
    current_user_id,
    removed_attachment.storage_bucket,
    removed_attachment.storage_path
  );

  delete from public.zagulyaky_attachments where id = removed_attachment.id;
  update public.zagulyaky_records set updated_at = clock_timestamp()
  where id = existing.id returning * into updated_record;

  return jsonb_build_object(
    'recordId', updated_record.id,
    'lockVersion', updated_record.lock_version,
    'storageCleanup', jsonb_build_object(
      'action', 'process_mine',
      'taskId', cleanup_task ->> 'taskId',
      'status', cleanup_task ->> 'status'
    )
  );
end;
$function$;

-- Each publish attempt receives a private, immutable namespace. It survives
-- upload/complete ambiguity on the attachment row, then is cleared only by a
-- successful revoke. Thus a stale worker can remove only its old generation.
create or replace function security_private.zagulyaky_public_attachment_path_v2(
  p_record_id uuid,
  p_attachment_id uuid,
  p_generation uuid,
  p_file_name text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select 'catalogue/' || p_record_id::text || '/' || p_attachment_id::text || '/' ||
    p_generation::text || '/' ||
    coalesce(
      nullif(trim(both '-' from regexp_replace(lower(coalesce(p_file_name, '')), '[^a-z0-9._-]+', '-', 'g')), ''),
      'attachment'
    )
$function$;

-- Publication v2 allocates an immutable public target before the Edge upload.
-- A retry can distinguish a target uploaded before a timeout from one that
-- still needs upload, without any later publication reusing its object name.
create or replace function security_private.admin_prepare_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  target_exists boolean := false;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if attachment.storage_bucket <> 'zagulyaky-private' then
    raise exception 'INVALID_PRIVATE_ATTACHMENT_BUCKET' using errcode = '23514';
  end if;

  if attachment.is_public_derivative then
    if attachment.public_bucket is distinct from 'zagulyaky-public'
      or attachment.public_path is null then
      raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
    end if;
    -- Published legacy derivatives can predate `public_derivative_generation`.
    -- Their recorded path remains valid until revoked; all later publications
    -- receive a fresh v2 path below.
    expected_path := attachment.public_path;
    if exists (
      select 1
      from public.zagulyaky_storage_cleanup_queue cleanup_task
      where cleanup_task.storage_bucket = 'zagulyaky-public'
        and cleanup_task.storage_path = expected_path
        and cleanup_task.status in ('queued', 'retry', 'processing')
    ) then
      raise exception 'PUBLIC_ATTACHMENT_CLEANUP_PENDING' using errcode = '55000';
    end if;
    target_exists := exists (
      select 1
      from storage.objects object
      where object.bucket_id = 'zagulyaky-public'
        and object.name = expected_path
    );
    return jsonb_build_object(
      'attachmentId', attachment.id,
      'recordId', target_record.id,
      'privateBucket', attachment.storage_bucket,
      'privatePath', attachment.storage_path,
      'publicBucket', 'zagulyaky-public',
      'publicPath', expected_path,
      'fileName', attachment.file_name,
      'mimeType', attachment.mime_type,
      'byteSize', attachment.byte_size,
      'publicationState', 'published',
      'targetExists', target_exists
    );
  end if;
  if attachment.public_bucket is not null or attachment.public_path is not null then
    raise exception 'PUBLIC_ATTACHMENT_METADATA_INCONSISTENT' using errcode = '23514';
  end if;
  if target_record.status <> 'published' or target_record.privacy_status <> 'cleared' then
    raise exception 'ATTACHMENT_RECORD_NOT_PUBLIC' using errcode = '23514';
  end if;

  -- Allocation happens in the same locked transaction as prepare. If upload
  -- succeeds but the caller times out before complete, another prepare sees
  -- this exact generation and safely resumes instead of orphaning a copy.
  if attachment.public_derivative_generation is null then
    update public.zagulyaky_attachments
    set public_derivative_generation = gen_random_uuid()
    where id = attachment.id
    returning * into attachment;
  end if;
  expected_path := security_private.zagulyaky_public_attachment_path_v2(
    target_record.id,
    attachment.id,
    attachment.public_derivative_generation,
    attachment.file_name
  );
  if exists (
    select 1
    from public.zagulyaky_storage_cleanup_queue cleanup_task
    where cleanup_task.storage_bucket = 'zagulyaky-public'
      and cleanup_task.storage_path = expected_path
      and cleanup_task.status in ('queued', 'retry', 'processing')
  ) then
    raise exception 'PUBLIC_ATTACHMENT_CLEANUP_PENDING' using errcode = '55000';
  end if;
  target_exists := exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'zagulyaky-public'
      and object.name = expected_path
  );

  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'privateBucket', attachment.storage_bucket,
    'privatePath', attachment.storage_path,
    'publicBucket', 'zagulyaky-public',
    'publicPath', expected_path,
    'fileName', attachment.file_name,
    'mimeType', attachment.mime_type,
    'byteSize', attachment.byte_size,
    'publicDerivativeGeneration', attachment.public_derivative_generation,
    'publicationState', case when target_exists then 'uploaded' else 'ready' end,
    'targetExists', target_exists
  );
end;
$function$;

create or replace function security_private.admin_complete_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid,
  p_public_path text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, storage, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  updated_record public.zagulyaky_records;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;
  if attachment.storage_bucket <> 'zagulyaky-private' then
    raise exception 'INVALID_PRIVATE_ATTACHMENT_BUCKET' using errcode = '23514';
  end if;

  if attachment.is_public_derivative then
    if attachment.public_bucket is distinct from 'zagulyaky-public'
      or attachment.public_path is null then
      raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
    end if;
    expected_path := attachment.public_path;
  else
    if attachment.public_derivative_generation is null then
      raise exception 'PUBLIC_ATTACHMENT_PREPARATION_REQUIRED' using errcode = '55000';
    end if;
    expected_path := security_private.zagulyaky_public_attachment_path_v2(
      target_record.id,
      attachment.id,
      attachment.public_derivative_generation,
      attachment.file_name
    );
  end if;
  if p_public_path is null or p_public_path is distinct from expected_path then
    raise exception 'INVALID_PUBLIC_ATTACHMENT_PATH' using errcode = '22023';
  end if;
  -- A generation is never reused. This check protects the one active
  -- generation while its revocation remains physically in flight.
  if exists (
    select 1
    from public.zagulyaky_storage_cleanup_queue cleanup_task
    where cleanup_task.storage_bucket = 'zagulyaky-public'
      and cleanup_task.storage_path = expected_path
      and cleanup_task.status in ('queued', 'retry', 'processing')
  ) then
    raise exception 'PUBLIC_ATTACHMENT_CLEANUP_PENDING' using errcode = '55000';
  end if;

  if attachment.is_public_derivative then
    return jsonb_build_object(
      'attachmentId', attachment.id,
      'recordId', target_record.id,
      'publicBucket', 'zagulyaky-public',
      'publicPath', expected_path,
      'alreadyPublished', true
    );
  end if;
  if target_record.status <> 'published' or target_record.privacy_status <> 'cleared' then
    raise exception 'ATTACHMENT_RECORD_NOT_PUBLIC' using errcode = '23514';
  end if;
  if attachment.public_bucket is not null or attachment.public_path is not null then
    raise exception 'PUBLIC_ATTACHMENT_METADATA_INCONSISTENT' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from storage.objects object
    where object.bucket_id = 'zagulyaky-public'
      and object.name = expected_path
  ) then
    raise exception 'PUBLIC_ATTACHMENT_OBJECT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.zagulyaky_attachments
  set public_bucket = 'zagulyaky-public',
      public_path = expected_path,
      is_public_derivative = true
  where id = attachment.id;
  update public.zagulyaky_records set updated_at = clock_timestamp()
  where id = target_record.id returning * into updated_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (
    target_record.id,
    current_user_id,
    'attachment_publish',
    target_record.status,
    updated_record.status,
    jsonb_build_object('attachmentId', attachment.id, 'mimeType', attachment.mime_type, 'byteSize', attachment.byte_size)
  );
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (
    current_user_id,
    'zagulyaky.attachment.publish',
    'zagulyaky_attachment',
    attachment.id::text,
    'success',
    jsonb_build_object('recordId', target_record.id, 'mimeType', attachment.mime_type, 'byteSize', attachment.byte_size)
  );

  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'publicBucket', 'zagulyaky-public',
    'publicPath', expected_path,
    'alreadyPublished', false
  );
end;
$function$;

-- The public object is enqueued first and its metadata is cleared only in the
-- same successful transaction. A repeat call finds the durable task by its
-- attachment id and reports its current state instead of losing the path.
create or replace function security_private.admin_revoke_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  attachment public.zagulyaky_attachments;
  target_record public.zagulyaky_records;
  expected_path text;
  cleanup_task jsonb;
  cleanup_task_id uuid;
  cleanup_status text;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select a into attachment
  from public.zagulyaky_attachments a
  where a.id = p_attachment_id
  for update;
  if not found then raise exception 'ZAGULYAKA_ATTACHMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select r into target_record
  from public.zagulyaky_records r
  where r.id = attachment.record_id
  for update;
  if not found then raise exception 'ZAGULYAKA_RECORD_NOT_FOUND' using errcode = 'P0002'; end if;

  if not attachment.is_public_derivative or attachment.public_bucket is null or attachment.public_path is null then
    select task.id, task.status into cleanup_task_id, cleanup_status
    from public.zagulyaky_storage_cleanup_queue task
    where task.source_attachment_id = attachment.id
      and task.storage_bucket = 'zagulyaky-public'
    -- A stale worker can update an older generation after a later revoke.
    -- The most recently *created* public task is the current generation.
    order by task.created_at desc, task.id desc
    limit 1;
    if found then
      return jsonb_build_object(
        'attachmentId', attachment.id,
        'recordId', target_record.id,
        'cleanupTaskId', cleanup_task_id,
        'cleanupStatus', cleanup_status,
        'alreadyRevoked', true
      );
    end if;
    raise exception 'ATTACHMENT_NOT_PUBLISHED' using errcode = '55000';
  end if;

  expected_path := attachment.public_path;
  if attachment.public_bucket is distinct from 'zagulyaky-public' then
    raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
  end if;
  if attachment.public_derivative_generation is not null
    and expected_path is distinct from security_private.zagulyaky_public_attachment_path_v2(
      target_record.id,
      attachment.id,
      attachment.public_derivative_generation,
      attachment.file_name
    ) then
    raise exception 'PUBLIC_ATTACHMENT_PATH_MISMATCH' using errcode = '23514';
  end if;

  cleanup_task := security_private.enqueue_zagulyaky_storage_cleanup_v1(
    target_record.id,
    attachment.id,
    coalesce(target_record.created_by, current_user_id),
    attachment.public_bucket,
    attachment.public_path
  );
  cleanup_task_id := (cleanup_task ->> 'taskId')::uuid;
  cleanup_status := cleanup_task ->> 'status';

  update public.zagulyaky_attachments
  set public_bucket = null,
      public_path = null,
      public_derivative_generation = null,
      is_public_derivative = false
  where id = attachment.id;
  update public.zagulyaky_records set updated_at = clock_timestamp()
  where id = target_record.id returning * into target_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (
    target_record.id,
    current_user_id,
    'attachment_revoke',
    target_record.status,
    target_record.status,
    jsonb_build_object('attachmentId', attachment.id, 'cleanupTaskId', cleanup_task_id)
  );
  insert into public.admin_audit_log(admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff)
  values (
    current_user_id,
    'zagulyaky.attachment.revoke',
    'zagulyaky_attachment',
    attachment.id::text,
    'success',
    jsonb_build_object('recordId', target_record.id, 'cleanupTaskId', cleanup_task_id)
  );

  return jsonb_build_object(
    'attachmentId', attachment.id,
    'recordId', target_record.id,
    'cleanupTaskId', cleanup_task_id,
    'cleanupStatus', cleanup_status,
    'alreadyRevoked', false
  );
end;
$function$;

create or replace function public.admin_prepare_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_prepare_zagulyaka_attachment_publication_v2($1)
$function$;

create or replace function public.admin_complete_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid,
  p_public_path text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_complete_zagulyaka_attachment_publication_v2($1, $2)
$function$;

create or replace function public.admin_revoke_zagulyaka_attachment_publication_v2(
  p_attachment_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_revoke_zagulyaka_attachment_publication_v2($1)
$function$;

create or replace function public.claim_my_zagulyaky_storage_cleanup_v1(
  p_limit integer default 20
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.claim_my_zagulyaky_storage_cleanup_v1($1)
$function$;

create or replace function public.claim_zagulyaky_storage_cleanup_queue_v1(
  p_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.claim_zagulyaky_storage_cleanup_queue_v1($1)
$function$;

create or replace function public.claim_zagulyaky_storage_cleanup_task_v1(
  p_task_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.claim_zagulyaky_storage_cleanup_task_v1($1)
$function$;

create or replace function public.finalize_zagulyaky_storage_cleanup_v1(
  p_task_id uuid,
  p_claim_token uuid,
  p_removed boolean,
  p_error text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.finalize_zagulyaky_storage_cleanup_v1($1, $2, $3, $4)
$function$;

revoke all on function security_private.audit_zagulyaky_attachment_change_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.enqueue_zagulyaky_storage_cleanup_v1(uuid,uuid,uuid,text,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_public_attachment_path_v2(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.claim_my_zagulyaky_storage_cleanup_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.claim_zagulyaky_storage_cleanup_queue_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.claim_zagulyaky_storage_cleanup_task_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_prepare_zagulyaka_attachment_publication_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_revoke_zagulyaka_attachment_publication_v2(uuid)
  from public, anon, authenticated, service_role;
-- v1 publish/revoke has no durable public-object cleanup contract. The live
-- Edge function uses v2, so revoke every API route that could otherwise
-- bypass the queue and leave an exposed derivative behind.
revoke all on function security_private.admin_prepare_zagulyaka_attachment_publication_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_complete_zagulyaka_attachment_publication_v1(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_revoke_zagulyaka_attachment_publication_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function security_private.claim_my_zagulyaky_storage_cleanup_v1(integer)
  to authenticated;
grant execute on function security_private.claim_zagulyaky_storage_cleanup_queue_v1(integer)
  to service_role;
grant execute on function security_private.claim_zagulyaky_storage_cleanup_task_v1(uuid)
  to service_role;
grant execute on function security_private.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)
  to service_role;
grant execute on function security_private.admin_prepare_zagulyaka_attachment_publication_v2(uuid)
  to authenticated, service_role;
grant execute on function security_private.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)
  to authenticated, service_role;
grant execute on function security_private.admin_revoke_zagulyaka_attachment_publication_v2(uuid)
  to authenticated, service_role;

-- Legacy deletion APIs either return direct Storage paths or delete attachment
-- metadata without this migration's durable outbox. The UI uses draft v3 and
-- attachment v2, so revoke every old mutation route from every API role.
revoke all on function public.delete_my_zagulyaka_draft_v1(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_draft_v2(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_attachment_v1(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_draft_v3(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_prepare_zagulyaka_attachment_publication_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_zagulyaka_attachment_publication_v2(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_my_zagulyaky_storage_cleanup_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_zagulyaky_storage_cleanup_queue_v1(integer)
  from public, anon, authenticated, service_role;
revoke all on function public.claim_zagulyaky_storage_cleanup_task_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_prepare_zagulyaka_attachment_publication_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_complete_zagulyaka_attachment_publication_v1(uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_revoke_zagulyaka_attachment_publication_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.delete_my_zagulyaka_draft_v3(uuid,integer)
  to authenticated, service_role;
grant execute on function public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)
  to authenticated, service_role;
grant execute on function public.admin_prepare_zagulyaka_attachment_publication_v2(uuid)
  to authenticated, service_role;
grant execute on function public.admin_complete_zagulyaka_attachment_publication_v2(uuid,text)
  to authenticated, service_role;
grant execute on function public.admin_revoke_zagulyaka_attachment_publication_v2(uuid)
  to authenticated, service_role;
grant execute on function public.claim_my_zagulyaky_storage_cleanup_v1(integer)
  to authenticated;
grant execute on function public.claim_zagulyaky_storage_cleanup_queue_v1(integer)
  to service_role;
grant execute on function public.claim_zagulyaky_storage_cleanup_task_v1(uuid)
  to service_role;
grant execute on function public.finalize_zagulyaky_storage_cleanup_v1(uuid,uuid,boolean,text)
  to service_role;

comment on table public.zagulyaky_storage_cleanup_queue is
  'Durable outbox for private Zagulyaky and revoked public-derivative Storage paths. Rows intentionally outlive the deleted record or cleared attachment metadata so the service worker can retry physical object deletion.';
comment on function public.delete_my_zagulyaka_draft_v3(uuid,integer) is
  'Deletes an owned editable draft only after durable private Storage cleanup tasks have been queued. The client should invoke the zagulyaky-storage-cleanup Edge Function with action process_mine.';

notify pgrst, 'reload schema';

commit;
