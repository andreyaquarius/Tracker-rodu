begin;

create schema if not exists private;
create schema if not exists security_private;

-- Generated GEDCOM files are always private.  Only the service worker writes
-- objects and it distributes short-lived signed URLs after the job completes.
insert into storage.buckets (id, name, public, file_size_limit)
values ('gedcom-exports', 'gedcom-exports', false, 536870912)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

-- Every export page has a unique final ordering key. These indexes keep
-- PostgREST range pagination bounded even when a project has tens of thousands
-- of people and relationships.
create index if not exists gedcom_export_persons_project_id_idx
  on public.persons (project_id, id);
create index if not exists gedcom_export_person_names_project_id_idx
  on public.person_names (project_id, id);
create index if not exists gedcom_export_events_project_id_idx
  on public.person_timeline_events (project_id, id);
create index if not exists gedcom_export_documents_project_id_idx
  on public.documents (project_id, id);
create index if not exists gedcom_export_partner_tree_id_idx
  on public.partner_relationships (tree_id, id);
create index if not exists gedcom_export_parent_child_tree_id_idx
  on public.parent_child_relationships (tree_id, id);
create index if not exists gedcom_export_association_tree_id_idx
  on public.association_relationships (tree_id, id);
create index if not exists gedcom_export_parent_sets_tree_id_idx
  on public.parent_sets (tree_id, id);
create index if not exists gedcom_export_xrefs_batch_created_id_idx
  on public.gedcom_xref_maps (import_batch_id, created_at, id);

create table if not exists private.gedcom_export_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  tree_id uuid not null,
  tree_title text not null default '',
  requested_by uuid not null,
  requester_email text not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'expired')),
  phase text not null default 'queued',
  progress_percent integer not null default 0
    check (progress_percent between 0 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  retryable boolean not null default true,
  next_attempt_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  estimated_person_count integer not null default 0
    check (estimated_person_count >= 0),
  worker_kind text not null default 'edge'
    check (worker_kind in ('edge', 'github')),
  checkpoint jsonb not null default '{}'::jsonb
    check (jsonb_typeof(checkpoint) = 'object'),
  storage_bucket text not null default 'gedcom-exports'
    check (storage_bucket = 'gedcom-exports'),
  storage_path text,
  file_name text,
  file_size bigint check (file_size is null or file_size >= 0),
  person_count integer check (person_count is null or person_count >= 0),
  family_count integer check (family_count is null or family_count >= 0),
  warning_count integer check (warning_count is null or warning_count >= 0),
  download_url text,
  expires_at timestamptz,
  email_status text not null default 'not_ready'
    check (email_status in ('not_ready', 'pending', 'sent', 'failed')),
  email_attempts integer not null default 0 check (email_attempts >= 0),
  email_claimed_at timestamptz,
  email_next_attempt_at timestamptz,
  email_error text,
  email_sent_at timestamptz,
  error text,
  cleanup_status text not null default 'pending'
    check (cleanup_status in ('pending', 'claimed', 'completed')),
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  cleanup_claimed_at timestamptz,
  cleanup_next_attempt_at timestamptz,
  cleanup_error text,
  cleaned_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz
);

comment on table private.gedcom_export_jobs is
  'Durable queue for private asynchronous GEDCOM exports. Generated files are retained for at most seven days.';

create unique index if not exists gedcom_export_jobs_active_request_uq
  on private.gedcom_export_jobs (requested_by, tree_id)
  where status in ('queued', 'processing')
     or (status = 'failed' and retryable);

create index if not exists gedcom_export_jobs_worker_queue_idx
  on private.gedcom_export_jobs
    (worker_kind, status, next_attempt_at, created_at);

create index if not exists gedcom_export_jobs_requester_idx
  on private.gedcom_export_jobs (requested_by, created_at desc);

create index if not exists gedcom_export_jobs_cleanup_idx
  on private.gedcom_export_jobs
    (cleanup_status, expires_at, cleanup_next_attempt_at)
  where status in ('completed', 'failed', 'expired');

revoke all on table private.gedcom_export_jobs
  from public, anon, authenticated, service_role;

create or replace function security_private.gedcom_export_request_authorized(
  target_user_id uuid,
  target_project_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
  select target_user_id is not null
    and target_project_id is not null
    and exists (
      select 1
      from public.projects project
      where project.id = target_project_id
        and not project.deletion_pending
        and (
          project.owner_id = target_user_id
          or public.is_app_admin(target_user_id)
          or exists (
            select 1
            from public.project_members member
            where member.project_id = project.id
              and member.user_id = target_user_id
              and member.role in ('owner', 'editor')
          )
        )
    )
    and (
      public.is_app_admin(target_user_id)
      or exists (
        select 1
        from public.family_tree_feature_access access
        where access.user_id = target_user_id
      )
    );
$implementation$;

create or replace function security_private.gedcom_export_status_payload(
  target_job_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
  select jsonb_build_object(
    'jobId', job.id,
    'projectId', job.project_id,
    'treeId', job.tree_id,
    'treeTitle', job.tree_title,
    'requestedBy', job.requested_by,
    'requesterEmail', job.requester_email,
    'status', job.status,
    'phase', job.phase,
    'progressPercent', job.progress_percent,
    'attempts', job.attempts,
    'retryable', job.retryable,
    'nextAttemptAt', job.next_attempt_at,
    'estimatedPersonCount', job.estimated_person_count,
    'workerKind', job.worker_kind,
    'personCount', job.person_count,
    'familyCount', job.family_count,
    'warningCount', job.warning_count,
    'fileName', job.file_name,
    'fileSize', job.file_size,
    'storagePath', job.storage_path,
    'downloadUrl', case
      when job.status = 'completed'
       and job.expires_at > clock_timestamp()
      then job.download_url
      else null
    end,
    'expiresAt', job.expires_at,
    'emailStatus', job.email_status,
    'emailAttempts', job.email_attempts,
    'emailNextAttemptAt', job.email_next_attempt_at,
    'emailError', job.email_error,
    'error', job.error,
    'createdAt', job.created_at,
    'updatedAt', job.updated_at,
    'startedAt', job.started_at,
    'completedAt', job.completed_at,
    'emailSentAt', job.email_sent_at,
    'cleanedAt', job.cleaned_at
  )
  from private.gedcom_export_jobs job
  where job.id = target_job_id;
$implementation$;

create or replace function security_private.gedcom_export_claim_payload(
  target_job_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
  select jsonb_build_object(
    'jobId', job.id,
    'projectId', job.project_id,
    'treeId', job.tree_id,
    'treeTitle', job.tree_title,
    'requestedBy', job.requested_by,
    'requesterEmail', job.requester_email,
    'status', job.status,
    'attempts', job.attempts,
    'estimatedPersonCount', job.estimated_person_count,
    'workerKind', job.worker_kind,
    'phase', job.phase,
    'progressPercent', job.progress_percent,
    'storageBucket', job.storage_bucket,
    'storagePath', job.storage_path,
    'checkpoint', job.checkpoint
  )
  from private.gedcom_export_jobs job
  where job.id = target_job_id;
$implementation$;

create or replace function security_private.start_gedcom_export(
  target_project_id uuid,
  target_tree_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  current_user_id uuid := auth.uid();
  current_job private.gedcom_export_jobs%rowtype;
  current_tree_title text;
  current_requester_email text;
  current_person_count integer;
  new_job_id uuid := gen_random_uuid();
begin
  if current_user_id is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null or target_tree_id is null then
    raise exception 'GEDCOM_EXPORT_PROJECT_AND_TREE_REQUIRED' using errcode = '22023';
  end if;

  perform public.assert_family_tree_feature_access();

  if not exists (
    select 1
    from public.projects project
    where project.id = target_project_id
  ) then
    raise exception 'PROJECT_NOT_FOUND' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.projects project
    where project.id = target_project_id
      and project.deletion_pending
  ) then
    raise exception 'PROJECT_DELETION_PENDING' using errcode = '55000';
  end if;
  if not public.can_edit_project(target_project_id) then
    raise exception 'GEDCOM_EXPORT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select tree.title
  into current_tree_title
  from public.family_trees tree
  where tree.id = target_tree_id
    and tree.project_id = target_project_id;
  if not found then
    raise exception 'FAMILY_TREE_NOT_FOUND' using errcode = '22023';
  end if;

  select profile.email
  into current_requester_email
  from public.profiles profile
  where profile.user_id = current_user_id;
  if coalesce(btrim(current_requester_email), '') = '' then
    raise exception 'GEDCOM_EXPORT_REQUESTER_EMAIL_REQUIRED' using errcode = '22023';
  end if;

  select count(*)::integer
  into current_person_count
  from public.persons person
  where person.project_id = target_project_id;

  perform pg_advisory_xact_lock(
    hashtextextended(current_user_id::text || ':' || target_tree_id::text, 71901)
  );

  select job.*
  into current_job
  from private.gedcom_export_jobs job
  where job.requested_by = current_user_id
    and job.tree_id = target_tree_id
    and (
      job.status in ('queued', 'processing')
      or (job.status = 'failed' and job.retryable)
    )
  order by job.created_at desc
  limit 1
  for update;

  if current_job.id is not null then
    return security_private.gedcom_export_status_payload(current_job.id);
  end if;

  insert into private.gedcom_export_jobs (
    id,
    project_id,
    tree_id,
    tree_title,
    requested_by,
    requester_email,
    estimated_person_count,
    worker_kind,
    storage_path
  ) values (
    new_job_id,
    target_project_id,
    target_tree_id,
    coalesce(current_tree_title, ''),
    current_user_id,
    current_requester_email,
    coalesce(current_person_count, 0),
    case when coalesce(current_person_count, 0) <= 5000 then 'edge' else 'github' end,
    target_project_id::text || '/' || current_user_id::text || '/' || new_job_id::text || '/attempt-1/family-tree.ged'
  );

  return security_private.gedcom_export_status_payload(new_job_id);
end;
$implementation$;

create or replace function security_private.get_gedcom_export_status(
  target_job_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  current_job private.gedcom_export_jobs%rowtype;
begin
  if target_job_id is null then
    raise exception 'GEDCOM_EXPORT_JOB_ID_REQUIRED' using errcode = '22023';
  end if;

  select job.*
  into current_job
  from private.gedcom_export_jobs job
  where job.id = target_job_id;
  if current_job.id is null then
    raise exception 'GEDCOM_EXPORT_JOB_NOT_FOUND' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not public.is_app_admin(auth.uid())
     and (
       current_job.requested_by <> auth.uid()
       or not security_private.gedcom_export_request_authorized(
         auth.uid(),
         current_job.project_id
       )
     ) then
    raise exception 'GEDCOM_EXPORT_JOB_ACCESS_DENIED' using errcode = '42501';
  end if;

  return security_private.gedcom_export_status_payload(current_job.id);
end;
$implementation$;

create or replace function security_private.claim_gedcom_export(
  target_job_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  selected_job_id uuid;
  now_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  -- Revoke queued work if the requester's entitlement/access disappeared or a
  -- project entered the asynchronous deletion fence after the request.
  update private.gedcom_export_jobs job
  set status = 'failed',
      phase = 'failed',
      retryable = false,
      error = 'GEDCOM_EXPORT_ACCESS_REVOKED_OR_PROJECT_UNAVAILABLE',
      expires_at = least(
        coalesce(job.expires_at, now_at + interval '7 days'),
        now_at + interval '7 days'
      ),
      updated_at = now_at
  where job.status in ('queued', 'processing')
    and not security_private.gedcom_export_request_authorized(
      job.requested_by,
      job.project_id
    );

  update private.gedcom_export_jobs job
  set status = 'failed',
      phase = 'failed',
      retryable = false,
      error = coalesce(job.error, 'GEDCOM_EXPORT_MAX_ATTEMPTS_REACHED'),
      expires_at = least(
        coalesce(job.expires_at, now_at + interval '7 days'),
        now_at + interval '7 days'
      ),
      updated_at = now_at
  where job.status = 'processing'
    and job.attempts >= job.max_attempts
    and coalesce(job.heartbeat_at, job.claimed_at, job.updated_at)
      < now_at - interval '20 minutes';

  select job.id
  into selected_job_id
  from private.gedcom_export_jobs job
  where (target_job_id is null or job.id = target_job_id)
    and job.attempts < job.max_attempts
    and (
      (
        job.status in ('queued', 'failed')
        and job.retryable
        and job.next_attempt_at <= now_at
      )
      or (
        job.status = 'processing'
        and coalesce(job.heartbeat_at, job.claimed_at, job.updated_at)
          < now_at - interval '20 minutes'
      )
    )
    and security_private.gedcom_export_request_authorized(
      job.requested_by,
      job.project_id
    )
  order by
    case when target_job_id is not null and job.id = target_job_id then 0 else 1 end,
    case when job.worker_kind = 'github' then 0 else 1 end,
    job.next_attempt_at,
    job.created_at
  for update skip locked
  limit 1;

  if selected_job_id is null then
    return null;
  end if;

  update private.gedcom_export_jobs job
  set status = 'processing',
      phase = case when job.phase in ('queued', 'failed') then 'loading' else job.phase end,
      progress_percent = case when job.status in ('queued', 'failed') then 0 else job.progress_percent end,
      attempts = job.attempts + 1,
      retryable = true,
      claimed_at = now_at,
      heartbeat_at = now_at,
      started_at = coalesce(job.started_at, now_at),
      storage_path = job.project_id::text || '/' || job.requested_by::text || '/'
        || job.id::text || '/attempt-' || (job.attempts + 1)::text || '/family-tree.ged',
      error = null,
      updated_at = now_at
  where job.id = selected_job_id;

  return security_private.gedcom_export_claim_payload(selected_job_id);
end;
$implementation$;

create or replace function security_private.touch_gedcom_export(
  target_job_id uuid,
  target_attempt integer,
  target_phase text,
  target_progress_percent integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if target_job_id is null
     or target_attempt is null
     or target_attempt < 1
     or coalesce(btrim(target_phase), '') = ''
     or char_length(target_phase) > 80
     or target_progress_percent is null
     or target_progress_percent < 0
     or target_progress_percent > 99 then
    raise exception 'INVALID_GEDCOM_EXPORT_PROGRESS' using errcode = '22023';
  end if;

  update private.gedcom_export_jobs job
  set phase = btrim(target_phase),
      progress_percent = greatest(job.progress_percent, target_progress_percent),
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where job.id = target_job_id
    and job.status = 'processing'
    and job.attempts = target_attempt;
  if not found then
    raise exception 'GEDCOM_EXPORT_LEASE_LOST' using errcode = '55000';
  end if;

  return security_private.gedcom_export_claim_payload(target_job_id);
end;
$implementation$;

create or replace function security_private.complete_gedcom_export(
  target_job_id uuid,
  target_attempt integer,
  target_storage_path text,
  target_file_name text,
  target_file_size bigint,
  target_person_count integer,
  target_family_count integer,
  target_warning_count integer,
  target_download_url text,
  target_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  current_job private.gedcom_export_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
  safe_expires_at timestamptz;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select job.*
  into current_job
  from private.gedcom_export_jobs job
  where job.id = target_job_id
  for update;
  if current_job.id is null then
    raise exception 'GEDCOM_EXPORT_JOB_NOT_FOUND' using errcode = '22023';
  end if;
  if current_job.status <> 'processing' then
    raise exception 'GEDCOM_EXPORT_JOB_NOT_PROCESSING' using errcode = '55000';
  end if;
  if target_attempt is null
     or target_attempt < 1
     or current_job.attempts <> target_attempt then
    raise exception 'GEDCOM_EXPORT_LEASE_LOST' using errcode = '55000';
  end if;
  if not security_private.gedcom_export_request_authorized(
    current_job.requested_by,
    current_job.project_id
  ) then
    raise exception 'GEDCOM_EXPORT_ACCESS_REVOKED_OR_PROJECT_UNAVAILABLE'
      using errcode = '42501';
  end if;
  if target_storage_path is distinct from current_job.storage_path
     or target_storage_path is null then
    raise exception 'GEDCOM_EXPORT_STORAGE_PATH_MISMATCH' using errcode = '22023';
  end if;
  if coalesce(btrim(target_file_name), '') = ''
     or char_length(target_file_name) > 255
     or target_file_name !~* '\.ged$'
     or target_file_size is null
     or target_file_size <= 0
     or target_file_size > 536870912
     or target_person_count is null
     or target_person_count < 0
     or target_family_count is null
     or target_family_count < 0
     or target_warning_count is null
     or target_warning_count < 0
     or coalesce(target_download_url, '') !~ '^https?://'
     or target_expires_at is null
     or target_expires_at <= now_at then
    raise exception 'INVALID_GEDCOM_EXPORT_COMPLETION' using errcode = '22023';
  end if;

  safe_expires_at := least(target_expires_at, now_at + interval '7 days');

  update private.gedcom_export_jobs job
  set status = 'completed',
      phase = 'completed',
      progress_percent = 100,
      retryable = false,
      file_name = btrim(target_file_name),
      file_size = target_file_size,
      person_count = target_person_count,
      family_count = target_family_count,
      warning_count = target_warning_count,
      download_url = target_download_url,
      expires_at = safe_expires_at,
      email_status = 'pending',
      email_attempts = 0,
      email_claimed_at = null,
      email_next_attempt_at = now_at,
      email_error = null,
      error = null,
      heartbeat_at = now_at,
      completed_at = now_at,
      updated_at = now_at
  where job.id = target_job_id;

  return security_private.gedcom_export_status_payload(target_job_id);
end;
$implementation$;

create or replace function security_private.fail_gedcom_export(
  target_job_id uuid,
  target_attempt integer,
  target_error text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  current_job private.gedcom_export_jobs%rowtype;
  now_at timestamptz := clock_timestamp();
  should_retry boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select job.*
  into current_job
  from private.gedcom_export_jobs job
  where job.id = target_job_id
  for update;
  if current_job.id is null then
    raise exception 'GEDCOM_EXPORT_JOB_NOT_FOUND' using errcode = '22023';
  end if;
  if current_job.status <> 'processing' then
    return security_private.gedcom_export_status_payload(current_job.id);
  end if;
  if target_attempt is null
     or target_attempt < 1
     or current_job.attempts <> target_attempt then
    raise exception 'GEDCOM_EXPORT_LEASE_LOST' using errcode = '55000';
  end if;

  should_retry := current_job.attempts < current_job.max_attempts
    and security_private.gedcom_export_request_authorized(
      current_job.requested_by,
      current_job.project_id
    );

  update private.gedcom_export_jobs job
  set status = 'failed',
      phase = 'failed',
      retryable = should_retry,
      error = left(coalesce(nullif(btrim(target_error), ''), 'GEDCOM_EXPORT_FAILED'), 4000),
      next_attempt_at = case
        when should_retry then now_at
          + make_interval(mins => least(60, (2 ^ greatest(0, job.attempts - 1))::integer))
        else job.next_attempt_at
      end,
      expires_at = case
        when should_retry then null
        else now_at + interval '7 days'
      end,
      email_status = case when should_retry then job.email_status else 'not_ready' end,
      updated_at = now_at
  where job.id = target_job_id;

  return security_private.gedcom_export_status_payload(target_job_id);
end;
$implementation$;

create or replace function security_private.claim_gedcom_export_emails(
  batch_size integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 20), 100));
  claimed_job_ids uuid[];
  claimed_jobs jsonb;
  now_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  with candidates as (
    select job.id
    from private.gedcom_export_jobs job
    where job.status = 'completed'
      and job.expires_at is not null
      and job.expires_at > now_at
      and job.download_url is not null
      and job.email_status in ('pending', 'failed')
      and job.email_attempts < 5
      and security_private.gedcom_export_request_authorized(
        job.requested_by,
        job.project_id
      )
      and (
        coalesce(job.email_next_attempt_at, now_at) <= now_at
      )
    order by
      coalesce(job.email_next_attempt_at, job.completed_at, job.created_at),
      job.created_at
    for update skip locked
    limit safe_batch_size
  ), claimed as (
    update private.gedcom_export_jobs job
    set email_status = 'pending',
        email_claimed_at = now_at,
        -- If the worker disappears, another worker can reclaim the delivery.
        email_next_attempt_at = now_at + interval '20 minutes',
        email_error = null,
        updated_at = now_at
    from candidates
    where job.id = candidates.id
    returning job.id
  )
  select array_agg(claimed.id order by claimed.id)
  into claimed_job_ids
  from claimed;

  select coalesce(
    jsonb_agg(
      security_private.gedcom_export_status_payload(claimed_id)
      order by claimed_id
    ),
    '[]'::jsonb
  )
  into claimed_jobs
  from unnest(coalesce(claimed_job_ids, '{}'::uuid[])) as claimed(claimed_id);

  return jsonb_build_object(
    'jobs', claimed_jobs,
    'count', jsonb_array_length(claimed_jobs)
  );
end;
$implementation$;

create or replace function security_private.record_gedcom_export_email(
  target_job_id uuid,
  target_sent boolean,
  target_error text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if target_job_id is null or target_sent is null then
    raise exception 'INVALID_GEDCOM_EXPORT_EMAIL_RESULT' using errcode = '22023';
  end if;

  update private.gedcom_export_jobs job
  set email_status = case when target_sent then 'sent' else 'failed' end,
      email_attempts = job.email_attempts + 1,
      email_error = case
        when target_sent then null
        else left(coalesce(nullif(btrim(target_error), ''), 'GEDCOM_EXPORT_EMAIL_FAILED'), 2000)
      end,
      email_next_attempt_at = case
        when target_sent or job.email_attempts + 1 >= 5 then null
        else clock_timestamp()
          + make_interval(mins => least(60, (2 ^ greatest(0, job.email_attempts))::integer))
      end,
      email_sent_at = case when target_sent then clock_timestamp() else job.email_sent_at end,
      updated_at = clock_timestamp()
  where job.id = target_job_id
    and job.status = 'completed'
    and job.email_status <> 'sent';
  if not found then
    -- Resend uses a stable idempotency key. A delayed duplicate callback must
    -- likewise remain idempotent and must never downgrade a successful send.
    if exists (
      select 1
      from private.gedcom_export_jobs job
      where job.id = target_job_id
        and job.status = 'completed'
        and job.email_status = 'sent'
    ) then
      return security_private.gedcom_export_status_payload(target_job_id);
    end if;
    raise exception 'GEDCOM_EXPORT_JOB_NOT_READY_FOR_EMAIL' using errcode = '55000';
  end if;

  return security_private.gedcom_export_status_payload(target_job_id);
end;
$implementation$;

-- Claim expired object paths.  The service worker must remove these paths via
-- the Storage API; SQL must never delete storage.objects directly because that
-- can leave the physical object orphaned.
create or replace function security_private.cleanup_expired_gedcom_exports(
  batch_size integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
declare
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 100), 500));
  claimed_jobs jsonb;
  now_at timestamptz := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  with candidates as (
    select job.id
    from private.gedcom_export_jobs job
    where job.status in ('completed', 'failed', 'expired')
      and job.expires_at is not null
      and (
        job.expires_at <= now_at
        or not security_private.gedcom_export_request_authorized(
          job.requested_by,
          job.project_id
        )
      )
      and job.storage_path is not null
      and (
        (
          job.cleanup_status = 'pending'
          and coalesce(job.cleanup_next_attempt_at, now_at) <= now_at
        )
        or (
          job.cleanup_status = 'claimed'
          and job.cleanup_claimed_at < now_at - interval '20 minutes'
        )
      )
    order by job.expires_at, job.created_at
    for update skip locked
    limit safe_batch_size
  ), claimed as (
    update private.gedcom_export_jobs job
    set status = 'expired',
        phase = 'expired',
        download_url = null,
        cleanup_status = 'claimed',
        cleanup_attempts = job.cleanup_attempts + 1,
        cleanup_claimed_at = now_at,
        cleanup_error = null,
        updated_at = now_at
    from candidates
    where job.id = candidates.id
    returning job.id, job.storage_bucket, job.storage_path
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'jobId', claimed.id,
      'storageBucket', claimed.storage_bucket,
      'storagePath', claimed.storage_path
    )),
    '[]'::jsonb
  )
  into claimed_jobs
  from claimed;

  return jsonb_build_object(
    'jobs', claimed_jobs,
    'count', jsonb_array_length(claimed_jobs)
  );
end;
$implementation$;

create or replace function security_private.finalize_gedcom_export_cleanup(
  target_job_id uuid,
  target_removed boolean,
  target_error text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $implementation$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if target_job_id is null or target_removed is null then
    raise exception 'INVALID_GEDCOM_EXPORT_CLEANUP_RESULT' using errcode = '22023';
  end if;

  update private.gedcom_export_jobs job
  set cleanup_status = case when target_removed then 'completed' else 'pending' end,
      cleanup_error = case
        when target_removed then null
        else left(coalesce(nullif(btrim(target_error), ''), 'GEDCOM_EXPORT_STORAGE_CLEANUP_FAILED'), 2000)
      end,
      cleanup_next_attempt_at = case
        when target_removed then null
        else clock_timestamp()
          + make_interval(mins => least(360, (2 ^ least(job.cleanup_attempts, 8))::integer))
      end,
      cleaned_at = case when target_removed then clock_timestamp() else job.cleaned_at end,
      storage_path = case when target_removed then null else job.storage_path end,
      file_name = case when target_removed then null else job.file_name end,
      file_size = case when target_removed then null else job.file_size end,
      updated_at = clock_timestamp()
  where job.id = target_job_id
    and job.status = 'expired'
    and job.cleanup_status = 'claimed';
  if not found then
    raise exception 'GEDCOM_EXPORT_CLEANUP_NOT_CLAIMED' using errcode = '55000';
  end if;

  return security_private.gedcom_export_status_payload(target_job_id);
end;
$implementation$;

-- Elevated implementations live outside PostgREST's exposed schemas.
revoke all on function
  security_private.gedcom_export_request_authorized(uuid, uuid),
  security_private.gedcom_export_status_payload(uuid),
  security_private.gedcom_export_claim_payload(uuid),
  security_private.start_gedcom_export(uuid, uuid),
  security_private.get_gedcom_export_status(uuid),
  security_private.claim_gedcom_export(uuid),
  security_private.touch_gedcom_export(uuid, integer, text, integer),
  security_private.complete_gedcom_export(uuid, integer, text, text, bigint, integer, integer, integer, text, timestamptz),
  security_private.fail_gedcom_export(uuid, integer, text),
  security_private.claim_gedcom_export_emails(integer),
  security_private.record_gedcom_export_email(uuid, boolean, text),
  security_private.cleanup_expired_gedcom_exports(integer),
  security_private.finalize_gedcom_export_cleanup(uuid, boolean, text)
  from public, anon, authenticated, service_role;

grant execute on function
  security_private.start_gedcom_export(uuid, uuid),
  security_private.get_gedcom_export_status(uuid)
  to authenticated;

grant execute on function security_private.get_gedcom_export_status(uuid)
  to service_role;

grant execute on function
  security_private.claim_gedcom_export(uuid),
  security_private.touch_gedcom_export(uuid, integer, text, integer),
  security_private.complete_gedcom_export(uuid, integer, text, text, bigint, integer, integer, integer, text, timestamptz),
  security_private.fail_gedcom_export(uuid, integer, text),
  security_private.claim_gedcom_export_emails(integer),
  security_private.record_gedcom_export_email(uuid, boolean, text),
  security_private.cleanup_expired_gedcom_exports(integer),
  security_private.finalize_gedcom_export_cleanup(uuid, boolean, text)
  to service_role;

create or replace function public.start_gedcom_export(
  target_project_id uuid,
  target_tree_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.start_gedcom_export($1, $2);
$wrapper$;

create or replace function public.get_gedcom_export_status(target_job_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_gedcom_export_status($1);
$wrapper$;

create or replace function public.claim_gedcom_export(target_job_id uuid default null)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.claim_gedcom_export($1);
$wrapper$;

create or replace function public.touch_gedcom_export(
  target_job_id uuid,
  target_attempt integer,
  target_phase text,
  target_progress_percent integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.touch_gedcom_export($1, $2, $3, $4);
$wrapper$;

create or replace function public.complete_gedcom_export(
  target_job_id uuid,
  target_attempt integer,
  target_storage_path text,
  target_file_name text,
  target_file_size bigint,
  target_person_count integer,
  target_family_count integer,
  target_warning_count integer,
  target_download_url text,
  target_expires_at timestamptz
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.complete_gedcom_export($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
$wrapper$;

create or replace function public.fail_gedcom_export(
  target_job_id uuid,
  target_attempt integer,
  target_error text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.fail_gedcom_export($1, $2, $3);
$wrapper$;

create or replace function public.record_gedcom_export_email(
  target_job_id uuid,
  target_sent boolean,
  target_error text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.record_gedcom_export_email($1, $2, $3);
$wrapper$;

create or replace function public.claim_gedcom_export_emails(
  batch_size integer default 20
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.claim_gedcom_export_emails($1);
$wrapper$;

create or replace function public.cleanup_expired_gedcom_exports(
  batch_size integer default 100
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.cleanup_expired_gedcom_exports($1);
$wrapper$;

create or replace function public.finalize_gedcom_export_cleanup(
  target_job_id uuid,
  target_removed boolean,
  target_error text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.finalize_gedcom_export_cleanup($1, $2, $3);
$wrapper$;

revoke all on function
  public.start_gedcom_export(uuid, uuid),
  public.get_gedcom_export_status(uuid),
  public.claim_gedcom_export(uuid),
  public.touch_gedcom_export(uuid, integer, text, integer),
  public.complete_gedcom_export(uuid, integer, text, text, bigint, integer, integer, integer, text, timestamptz),
  public.fail_gedcom_export(uuid, integer, text),
  public.claim_gedcom_export_emails(integer),
  public.record_gedcom_export_email(uuid, boolean, text),
  public.cleanup_expired_gedcom_exports(integer),
  public.finalize_gedcom_export_cleanup(uuid, boolean, text)
  from public, anon, authenticated, service_role;

grant execute on function
  public.start_gedcom_export(uuid, uuid),
  public.get_gedcom_export_status(uuid)
  to authenticated;

grant execute on function public.get_gedcom_export_status(uuid)
  to service_role;

grant execute on function
  public.claim_gedcom_export(uuid),
  public.touch_gedcom_export(uuid, integer, text, integer),
  public.complete_gedcom_export(uuid, integer, text, text, bigint, integer, integer, integer, text, timestamptz),
  public.fail_gedcom_export(uuid, integer, text),
  public.claim_gedcom_export_emails(integer),
  public.record_gedcom_export_email(uuid, boolean, text),
  public.cleanup_expired_gedcom_exports(integer),
  public.finalize_gedcom_export_cleanup(uuid, boolean, text)
  to service_role;

notify pgrst, 'reload schema';

commit;
