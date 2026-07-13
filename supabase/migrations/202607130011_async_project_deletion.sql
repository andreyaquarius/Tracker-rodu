begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

alter table public.projects
  add column if not exists deletion_pending boolean not null default false;

comment on column public.projects.deletion_pending is
  'True while the asynchronous deletion worker owns this project.';

drop policy if exists projects_insert_owner on public.projects;
create policy projects_insert_owner
on public.projects for insert to authenticated
with check (
  owner_id = (select auth.uid())
  and not deletion_pending
);

drop policy if exists projects_update_owner on public.projects;
create policy projects_update_owner
on public.projects for update to authenticated
using (
  public.is_project_owner(id)
  and not deletion_pending
)
with check (
  owner_id = (select auth.uid())
  and not deletion_pending
);

-- Project removal must always go through the resumable RPC/worker below.  A
-- direct PostgREST DELETE would run the full FK cascade in one statement and
-- reintroduce the timeout/orphaned-Storage failure this migration fixes.
revoke delete on table public.projects from public, anon, authenticated;

-- Keep deletion state outside the project cascade. This lets the client poll a
-- completed job after the project and its memberships no longer exist.
create table if not exists private.project_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  project_name text not null default '',
  requested_by uuid not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'failed', 'completed')),
  phase_index integer not null default 0 check (phase_index >= 0),
  processed_rows bigint not null default 0 check (processed_rows >= 0),
  storage_cleaned_at timestamptz,
  error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

-- A failed job is resumable and continues to lock project writes. Starting the
-- operation again reuses it instead of creating two competing deleters.
create unique index if not exists project_deletion_jobs_active_project_uq
  on private.project_deletion_jobs (project_id)
  where status in ('queued', 'running', 'failed');

create index if not exists project_deletion_jobs_requester_idx
  on private.project_deletion_jobs (requested_by, created_at desc);

revoke all on table private.project_deletion_jobs
  from public, anon, authenticated;

create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'legacy_person_relation_graph_edges',
    'ai_hypothesis_reviews',
    'family_tree_research_issues',
    'tree_layout_positions',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'person_timeline_events',
    'person_names',
    'association_relationships',
    'parent_child_relationships',
    'parent_sets',
    'partner_relationships',
    'family_group_members',
    'family_groups',
    'family_tree_persons',
    'gedcom_import_batches',
    'family_trees',
    'finding_participants',
    'task_persons',
    'task_notifications',
    'archive_request_persons',
    'hypothesis_links',
    'record_links',
    'custom_records',
    'custom_section_fields',
    'attachments',
    'activity_log',
    'year_matrix',
    'tasks',
    'findings',
    'hypotheses',
    'archive_requests',
    'person_relations',
    'documents',
    'persons',
    'custom_field_definitions',
    'custom_sections',
    'researches',
    'project_invitations'
  ]::text[];
$$;

revoke execute on function private.project_deletion_phase_names()
  from public, anon, authenticated;

-- Every phase must be able to find its next small batch without scanning the
-- whole table. Reuse an existing index whose leading key is project_id and add
-- only the indexes that older installations are missing.
do $$
declare
  table_name text;
  table_relation regclass;
  deletion_index_name text;
begin
  foreach table_name in array private.project_deletion_phase_names()
  loop
    table_relation := pg_catalog.to_regclass(format('public.%I', table_name));
    if table_relation is null then
      continue;
    end if;

    if exists (
      select 1
      from pg_catalog.pg_index index_record
      join pg_catalog.pg_attribute first_key
        on first_key.attrelid = index_record.indrelid
       and first_key.attnum = index_record.indkey[0]
      where index_record.indrelid = table_relation
        and index_record.indisvalid
        and index_record.indisready
        and first_key.attname = 'project_id'
    ) then
      continue;
    end if;

    deletion_index_name := 'project_delete_'
      || left(table_name, 32)
      || '_'
      || left(md5(table_name), 8)
      || '_idx';
    execute format(
      'create index if not exists %I on %s (project_id)',
      deletion_index_name,
      table_relation
    );
  end loop;
end;
$$;

create or replace function private.project_deletion_job_payload(target_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  with job_state as (
    select
      job.*,
      private.project_deletion_phase_names() as phases,
      cardinality(private.project_deletion_phase_names()) as phase_count
    from private.project_deletion_jobs job
    where job.id = target_job_id
  )
  select jsonb_build_object(
    'jobId', id,
    'projectId', project_id,
    'projectName', project_name,
    'status', status,
    'phase', case
      when status = 'completed' then 'completed'
      when phase_index >= phase_count and storage_cleaned_at is null
        then 'storage_cleanup'
      when phase_index >= phase_count then 'finalizing'
      else phases[phase_index + 1]
    end,
    'processedRows', processed_rows,
    'totalRows', null,
    'completedTables', least(phase_index, phase_count),
    'totalTables', phase_count,
    'progressPercent', case
      when status = 'completed' then 100
      else least(99, floor((least(phase_index, phase_count)::numeric * 99) /
        greatest(phase_count, 1))::integer)
    end,
    'error', error,
    'storageCleanedAt', storage_cleaned_at,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'completedAt', completed_at
  )
  from job_state;
$$;

revoke execute on function private.project_deletion_job_payload(uuid)
  from public, anon, authenticated;

-- Graph tables normally bump the tree version after every changed row. During
-- deletion that would update the same family_trees row hundreds of times even
-- though the tree itself is about to be removed. Preserve normal behaviour and
-- skip only inside a transaction explicitly owned by the deletion RPC.
create or replace function public.family_tree_bump_graph_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_tree_id uuid;
  previous_tree_id uuid;
  target_group_id uuid;
begin
  if current_setting('app.project_deletion', true) = 'on' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_table_name = 'family_group_members' then
    target_group_id := case when tg_op = 'DELETE' then old.family_group_id else new.family_group_id end;
    select tree_id into target_tree_id
    from public.family_groups
    where id = target_group_id;
    if tg_op = 'UPDATE' then
      select tree_id into previous_tree_id
      from public.family_groups
      where id = old.family_group_id;
    elsif tg_op = 'DELETE' then
      previous_tree_id := target_tree_id;
    end if;
  else
    target_tree_id := case when tg_op = 'DELETE' then old.tree_id else new.tree_id end;
    previous_tree_id := case when tg_op in ('UPDATE', 'DELETE') then old.tree_id else null end;
  end if;

  update public.family_trees
  set graph_version = graph_version + 1,
      updated_at = now()
  where id in (target_tree_id, previous_tree_id);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.family_tree_bump_graph_version()
  from public, anon, authenticated;

-- Once deletion starts, normal editor mutations are rejected. That guarantees
-- that a phase which has been emptied cannot be repopulated behind the worker.
create or replace function public.can_edit_project(target_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and target_project_id is not null
    and exists (
      select 1
      from public.project_members member
      where member.project_id = target_project_id
        and member.user_id = auth.uid()
        and member.role in ('owner', 'editor')
    )
    and not exists (
      select 1
      from private.project_deletion_jobs job
      where job.project_id = target_project_id
        and job.status in ('queued', 'running', 'failed')
    );
$$;

revoke execute on function public.can_edit_project(uuid) from public, anon;
grant execute on function public.can_edit_project(uuid) to authenticated;

-- Backup uploads previously checked ownership only. Require the edit helper as
-- well so no object can be uploaded after the worker has cleaned the prefix but
-- before the final project-row step. Reads/deletes remain available to owners.
drop policy if exists project_backups_insert_owner on storage.objects;
create policy project_backups_insert_owner
on storage.objects for insert to authenticated
with check (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
  and public.can_edit_project(public.storage_project_id(name))
);

drop policy if exists project_backups_update_owner on storage.objects;
create policy project_backups_update_owner
on storage.objects for update to authenticated
using (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
  and public.can_edit_project(public.storage_project_id(name))
)
with check (
  bucket_id = 'project-backups'
  and public.is_project_owner(public.storage_project_id(name))
  and public.can_edit_project(public.storage_project_id(name))
);

create or replace function public.start_project_deletion(target_project_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  target_name text;
  target_owner_id uuid;
  existing_job private.project_deletion_jobs%rowtype;
  created_job_id uuid;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7311)
  );

  select job.*
  into existing_job
  from private.project_deletion_jobs job
  where job.project_id = target_project_id
  order by job.created_at desc
  limit 1;

  if found and existing_job.status = 'completed' then
    if existing_job.requested_by <> actor_id
       and not public.is_app_admin(actor_id) then
      raise exception 'PROJECT_DELETE_ACCESS_REQUIRED' using errcode = '42501';
    end if;
    return private.project_deletion_job_payload(existing_job.id);
  end if;

  select project.name, project.owner_id
  into target_name, target_owner_id
  from public.projects project
  where project.id = target_project_id;

  if target_owner_id is null then
    raise exception 'PROJECT_NOT_FOUND' using errcode = '22023';
  end if;

  if target_owner_id <> actor_id and not public.is_app_admin(actor_id) then
    raise exception 'PROJECT_DELETE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if existing_job.id is not null then
    update public.projects
    set deletion_pending = true,
        updated_at = clock_timestamp()
    where id = target_project_id;

    update private.project_deletion_jobs
    set status = case when status = 'failed' then 'queued' else status end,
        error = case when status = 'failed' then null else error end,
        updated_at = clock_timestamp()
    where id = existing_job.id;
    return private.project_deletion_job_payload(existing_job.id);
  end if;

  insert into private.project_deletion_jobs (
    project_id,
    project_name,
    requested_by
  ) values (
    target_project_id,
    coalesce(target_name, ''),
    actor_id
  )
  returning id into created_job_id;

  update public.projects
  set deletion_pending = true,
      updated_at = clock_timestamp()
  where id = target_project_id;

  return private.project_deletion_job_payload(created_job_id);
end;
$$;

create or replace function public.get_project_deletion_status(target_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  deletion_job private.project_deletion_jobs%rowtype;
begin
  if actor_id is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  select job.* into deletion_job
  from private.project_deletion_jobs job
  where job.id = target_job_id;

  if deletion_job.id is null then
    raise exception 'PROJECT_DELETION_JOB_NOT_FOUND' using errcode = '22023';
  end if;

  if not caller_is_service
     and deletion_job.requested_by <> actor_id
     and not public.is_app_admin(actor_id)
     and not exists (
       select 1 from public.projects project
       where project.id = deletion_job.project_id
         and project.owner_id = actor_id
     ) then
    raise exception 'PROJECT_DELETE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return private.project_deletion_job_payload(deletion_job.id);
end;
$$;

create or replace function public.process_project_deletion(
  target_job_id uuid,
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  caller_is_service boolean := coalesce(auth.role(), '') = 'service_role';
  deletion_job private.project_deletion_jobs%rowtype;
  phases text[] := private.project_deletion_phase_names();
  phase_count integer := cardinality(phases);
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 250), 500));
  current_table text;
  current_relation regclass;
  deleted_count integer := 0;
begin
  if actor_id is null and not caller_is_service then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_job_id is null then
    raise exception 'PROJECT_DELETION_JOB_ID_REQUIRED' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_job_id::text, 7312)
  );

  select job.* into deletion_job
  from private.project_deletion_jobs job
  where job.id = target_job_id
  for update;

  if deletion_job.id is null then
    raise exception 'PROJECT_DELETION_JOB_NOT_FOUND' using errcode = '22023';
  end if;

  if not caller_is_service
     and deletion_job.requested_by <> actor_id
     and not public.is_app_admin(actor_id)
     and not exists (
       select 1 from public.projects project
       where project.id = deletion_job.project_id
         and project.owner_id = actor_id
     ) then
    raise exception 'PROJECT_DELETE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if deletion_job.status = 'completed' then
    return private.project_deletion_job_payload(deletion_job.id);
  end if;

  update private.project_deletion_jobs
  set status = 'running',
      error = null,
      updated_at = clock_timestamp()
  where id = deletion_job.id;

  perform pg_catalog.set_config('app.project_deletion', 'on', true);

  begin
    loop
      if deletion_job.phase_index >= phase_count then
        -- Storage object deletion must go through the Storage API so the
        -- physical objects are removed as well. Keep the project/membership
        -- alive until the service worker confirms both project buckets.
        if deletion_job.storage_cleaned_at is null then
          return private.project_deletion_job_payload(deletion_job.id);
        end if;

        -- The large children are already gone. Only the dashboard cache (one
        -- row), memberships, and any future unknown cascade children remain.
        delete from private.project_dashboard_stats_cache
        where project_id = deletion_job.project_id;

        delete from public.projects
        where id = deletion_job.project_id;

        update private.project_deletion_jobs
        set status = 'completed',
            error = null,
            updated_at = clock_timestamp(),
            completed_at = clock_timestamp()
        where id = deletion_job.id;

        return private.project_deletion_job_payload(deletion_job.id);
      end if;

      current_table := phases[deletion_job.phase_index + 1];
      current_relation := pg_catalog.to_regclass(format('public.%I', current_table));

      -- This makes the migration forward-compatible when an optional module
      -- was not installed in a particular environment.
      if current_relation is null or not exists (
        select 1
        from pg_catalog.pg_attribute attribute
        where attribute.attrelid = current_relation
          and attribute.attname = 'project_id'
          and attribute.attnum > 0
          and not attribute.attisdropped
      ) then
        deletion_job.phase_index := deletion_job.phase_index + 1;
        update private.project_deletion_jobs
        set phase_index = deletion_job.phase_index,
            updated_at = clock_timestamp()
        where id = deletion_job.id;
        continue;
      end if;

      execute format(
        'with target_rows as (
           select ctid
           from %s
           where project_id = $1
           limit $2
         ), deleted_rows as (
           delete from %s target
           using target_rows
           where target.ctid = target_rows.ctid
           returning 1
         )
         select count(*)::integer from deleted_rows',
        current_relation,
        current_relation
      )
      into deleted_count
      using deletion_job.project_id, safe_batch_size;

      deletion_job.processed_rows := deletion_job.processed_rows + deleted_count;

      if deleted_count < safe_batch_size then
        deletion_job.phase_index := deletion_job.phase_index + 1;
      end if;

      update private.project_deletion_jobs
      set phase_index = deletion_job.phase_index,
          processed_rows = deletion_job.processed_rows,
          updated_at = clock_timestamp()
      where id = deletion_job.id;

      -- Empty optional tables are skipped in this call, while any call which
      -- deletes rows stays bounded to at most safe_batch_size rows.
      if deleted_count > 0 then
        return private.project_deletion_job_payload(deletion_job.id);
      end if;
    end loop;
  exception
    -- The caller/worker retries these transient failures with backoff. Raising
    -- keeps the durable job at its prior phase because this RPC rolls back.
    when query_canceled or serialization_failure or deadlock_detected or lock_not_available then
      raise;
    when others then
      update private.project_deletion_jobs
      set status = 'failed',
          error = left(sqlerrm, 2000),
          updated_at = clock_timestamp()
      where id = deletion_job.id;
      return private.project_deletion_job_payload(deletion_job.id);
  end;
end;
$$;

create or replace function public.mark_project_deletion_storage_cleaned(
  target_job_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  deletion_job private.project_deletion_jobs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select job.* into deletion_job
  from private.project_deletion_jobs job
  where job.id = target_job_id
  for update;

  if deletion_job.id is null then
    raise exception 'PROJECT_DELETION_JOB_NOT_FOUND' using errcode = '22023';
  end if;

  if deletion_job.status = 'completed' then
    return private.project_deletion_job_payload(deletion_job.id);
  end if;

  update private.project_deletion_jobs
  set storage_cleaned_at = coalesce(storage_cleaned_at, clock_timestamp()),
      updated_at = clock_timestamp()
  where id = deletion_job.id;

  return private.project_deletion_job_payload(deletion_job.id);
end;
$$;

-- Cron calls this function to resume work even when the browser that started
-- deletion has been closed. Row locking plus the per-job advisory lock prevents
-- two workers from processing the same job concurrently.
create or replace function public.process_next_project_deletion(
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  next_job_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select job.id
  into next_job_id
  from private.project_deletion_jobs job
  where job.status in ('queued', 'running', 'failed')
  order by job.updated_at, job.created_at
  for update skip locked
  limit 1;

  if next_job_id is null then
    return null;
  end if;

  return public.process_project_deletion(next_job_id, batch_size);
end;
$$;

revoke execute on function public.start_project_deletion(uuid)
  from public, anon;
revoke execute on function public.get_project_deletion_status(uuid)
  from public, anon;
revoke execute on function public.process_project_deletion(uuid, integer)
  from public, anon;
revoke execute on function public.process_next_project_deletion(integer)
  from public, anon, authenticated;
revoke execute on function public.mark_project_deletion_storage_cleaned(uuid)
  from public, anon, authenticated;

grant execute on function public.start_project_deletion(uuid)
  to authenticated;
grant execute on function public.get_project_deletion_status(uuid)
  to authenticated;
grant execute on function public.process_project_deletion(uuid, integer)
  to authenticated;
grant execute on function public.process_project_deletion(uuid, integer)
  to service_role;
grant execute on function public.get_project_deletion_status(uuid)
  to service_role;
grant execute on function public.process_next_project_deletion(integer)
  to service_role;
grant execute on function public.mark_project_deletion_storage_cleaned(uuid)
  to service_role;

comment on function public.start_project_deletion(uuid) is
  'Starts or resumes an owner/admin-authorized, resumable project deletion job.';
comment on function public.process_project_deletion(uuid, integer) is
  'Deletes at most one bounded project-data batch and returns polling progress.';
comment on function public.get_project_deletion_status(uuid) is
  'Returns deletion progress only to the requester, project owner, or app admin.';
comment on function public.process_next_project_deletion(integer) is
  'Service-role queue step used by the project-deletion worker and recovery cron.';
comment on function public.mark_project_deletion_storage_cleaned(uuid) is
  'Service-role acknowledgement that project Storage objects were removed through the Storage API.';

commit;
