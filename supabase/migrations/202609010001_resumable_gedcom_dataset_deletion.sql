begin;

-- The reverse FK is exercised once for every deleted person. Without this
-- index a large GEDCOM deletion can repeatedly scan all person_relations.
create index if not exists person_relations_related_person_id_idx
  on public.person_relations (related_person_id);

create table if not exists private.gedcom_deletion_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  source_key text not null check (btrim(source_key) <> '' and char_length(source_key) <= 500),
  requested_by uuid references public.profiles(user_id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'failed', 'completed')),
  phase text not null default 'relations'
    check (phase in ('relations', 'findings', 'trees', 'archives', 'persons', 'finalize', 'completed')),
  total_persons integer not null default 0 check (total_persons >= 0),
  processed_persons integer not null default 0 check (processed_persons >= 0),
  deleted_persons integer not null default 0 check (deleted_persons >= 0),
  deleted_relations integer not null default 0 check (deleted_relations >= 0),
  deleted_findings integer not null default 0 check (deleted_findings >= 0),
  last_error_code text not null default '',
  last_error text not null default '',
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

create unique index if not exists gedcom_deletion_jobs_active_project_uq
  on private.gedcom_deletion_jobs (project_id)
  where status in ('pending', 'running')
     or (status = 'failed' and last_error_code in ('57014', '40001', '40P01', '55P03'));

create index if not exists gedcom_deletion_jobs_project_source_idx
  on private.gedcom_deletion_jobs (project_id, source_key, created_at desc);

create table if not exists private.gedcom_deletion_job_persons (
  job_id uuid not null references private.gedcom_deletion_jobs(id) on delete cascade,
  project_id uuid not null,
  person_id uuid not null,
  processed_at timestamptz,
  primary key (job_id, person_id)
);

create index if not exists gedcom_deletion_job_persons_pending_idx
  on private.gedcom_deletion_job_persons (job_id, person_id)
  where processed_at is null;

create table if not exists private.gedcom_deletion_job_trees (
  job_id uuid not null references private.gedcom_deletion_jobs(id) on delete cascade,
  project_id uuid not null,
  tree_id uuid not null,
  processed_at timestamptz,
  primary key (job_id, tree_id)
);

create index if not exists gedcom_deletion_job_trees_pending_idx
  on private.gedcom_deletion_job_trees (job_id, tree_id)
  where processed_at is null;

create table if not exists private.gedcom_deletion_job_batches (
  job_id uuid not null references private.gedcom_deletion_jobs(id) on delete cascade,
  project_id uuid not null,
  import_batch_id uuid not null,
  processed_at timestamptz,
  primary key (job_id, import_batch_id)
);

create index if not exists gedcom_deletion_job_batches_pending_idx
  on private.gedcom_deletion_job_batches (job_id, import_batch_id)
  where processed_at is null;

revoke all on table private.gedcom_deletion_jobs,
  private.gedcom_deletion_job_persons,
  private.gedcom_deletion_job_trees,
  private.gedcom_deletion_job_batches
  from public, anon, authenticated, service_role;

-- The shared person-deletion helper normally writes one activity row per
-- invocation. A resumable dataset deletion may require thousands of small
-- invocations, so suppress only those internal batch rows and write one
-- durable summary event during finalize instead.
create or replace function private.suppress_gedcom_deletion_batch_activity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, private, pg_temp
as $function$
begin
  if pg_catalog.current_setting('app.gedcom_dataset_deletion', true) = 'on'
     and new.action in ('person_deleted', 'persons_bulk_deleted')
     and new.entity_type = 'persons'
     and nullif(btrim(coalesce(new.details ->> 'importSourceKey', '')), '') is null then
    return null;
  end if;
  return new;
end;
$function$;

revoke execute on function private.suppress_gedcom_deletion_batch_activity()
  from public, anon, authenticated, service_role;

drop trigger if exists activity_log_suppress_gedcom_deletion_batch on public.activity_log;
create trigger activity_log_suppress_gedcom_deletion_batch
before insert on public.activity_log
for each row execute function private.suppress_gedcom_deletion_batch_activity();

create or replace function private.gedcom_deletion_job_payload(target_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, private, pg_temp
as $function$
  select jsonb_build_object(
    'jobId', job.id,
    'projectId', job.project_id,
    'sourceKey', job.source_key,
    'status', job.status,
    'phase', job.phase,
    'totalPersons', job.total_persons,
    'processedPersons', job.processed_persons,
    'remainingPersons', greatest(job.total_persons - job.processed_persons, 0),
    'deletedPersons', job.deleted_persons,
    'deletedRelations', job.deleted_relations,
    'deletedFindings', job.deleted_findings,
    'lastErrorCode', nullif(job.last_error_code, ''),
    'lastError', nullif(job.last_error, ''),
    'createdAt', job.created_at,
    'updatedAt', job.updated_at,
    'completedAt', job.completed_at,
    'done', job.status = 'completed',
    'retryable', job.status = 'failed' and job.last_error_code in ('57014', '40001', '40P01', '55P03')
  )
  from private.gedcom_deletion_jobs job
  where job.id = target_job_id;
$function$;

revoke execute on function private.gedcom_deletion_job_payload(uuid)
  from public, anon, authenticated, service_role;

create or replace function security_private.start_project_gedcom_deletion(
  target_project_id uuid,
  target_source_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, security_private, pg_temp
set lock_timeout = '3s'
set statement_timeout = '15s'
as $function$
declare
  actor_id uuid := auth.uid();
  normalized_source_key text := left(btrim(coalesce(target_source_key, '')), 500);
  existing_job private.gedcom_deletion_jobs%rowtype;
  created_job_id uuid;
  person_count integer;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if normalized_source_key = '' then
    raise exception 'GEDCOM_SOURCE_KEY_REQUIRED' using errcode = '22023';
  end if;
  if not security_private.can_edit_project(target_project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7341)
  ) then
    raise exception 'PROJECT_GEDCOM_DELETION_BUSY' using errcode = '55P03';
  end if;

  select job.* into existing_job
  from private.gedcom_deletion_jobs job
  where job.project_id = target_project_id
    and (
      job.status in ('pending', 'running')
      or (job.status = 'failed' and job.last_error_code in ('57014', '40001', '40P01', '55P03'))
    )
  order by job.created_at desc
  limit 1
  for update;

  if existing_job.id is not null then
    if existing_job.source_key <> normalized_source_key then
      raise exception 'PROJECT_GEDCOM_DELETION_ACTIVE:%', existing_job.id using errcode = '55000';
    end if;
    return private.gedcom_deletion_job_payload(existing_job.id);
  end if;

  if exists (
    select 1 from private.gedcom_import_operations operation
    where operation.project_id = target_project_id
      and operation.status in ('preparing', 'importing', 'rolling_back')
  ) then
    raise exception 'PROJECT_GEDCOM_OPERATION_ACTIVE' using errcode = '55000';
  end if;

  -- Preserve the existing domain rule: an imported person cannot disappear
  -- while remaining the root of a manual or manually expanded tree.
  if exists (
    select 1
    from public.family_trees tree
    join public.persons root on root.id = tree.root_person_id
    where root.project_id = target_project_id
      and root.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key
      and (
        tree.project_id <> target_project_id
        or coalesce(tree.settings ->> 'source', '') <> 'gedcom_import'
        or not (
          coalesce(tree.settings ->> 'import_source_key', '') = normalized_source_key
          or (
            nullif(btrim(coalesce(tree.settings ->> 'import_source_key', '')), '') is null
            and exists (
            select 1
            from public.family_tree_persons imported_member
            join public.persons imported_person on imported_person.id = imported_member.person_id
            where imported_member.tree_id = tree.id
              and imported_member.project_id = target_project_id
              and imported_person.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key
            )
          )
        )
        or exists (
          select 1
          from public.family_tree_persons member
          join public.persons member_person on member_person.id = member.person_id
          where member.tree_id = tree.id
            and member.project_id = target_project_id
            and coalesce(member_person.custom_fields ->> '__gedcomImportSourceKey', '') <> normalized_source_key
        )
      )
  ) then
    raise exception 'PERSON_IS_TREE_ROOT' using errcode = '55000',
      hint = 'Choose another root person or remove manual members from the imported tree first.';
  end if;

  if not exists (
    select 1 from private.gedcom_import_datasets dataset
    where dataset.project_id = target_project_id and dataset.source_key = normalized_source_key
    union all
    select 1 from public.persons person
    where person.project_id = target_project_id
      and person.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key
    union all
    select 1 from public.person_relations relation
    where relation.project_id = target_project_id and relation.import_source_key = normalized_source_key
    union all
    select 1 from public.findings finding
    where finding.project_id = target_project_id
      and finding.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key
  ) then
    select job.* into existing_job
    from private.gedcom_deletion_jobs job
    where job.project_id = target_project_id
      and job.source_key = normalized_source_key
      and job.status = 'completed'
    order by job.completed_at desc nulls last, job.created_at desc
    limit 1;
    if existing_job.id is not null then
      return private.gedcom_deletion_job_payload(existing_job.id);
    end if;
    raise exception 'GEDCOM_DATASET_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into private.gedcom_deletion_jobs (project_id, source_key, requested_by)
  values (target_project_id, normalized_source_key, actor_id)
  returning id into created_job_id;

  insert into private.gedcom_deletion_job_persons (job_id, project_id, person_id)
  select created_job_id, target_project_id, person.id
  from public.persons person
  where person.project_id = target_project_id
    and person.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key
  on conflict do nothing;
  get diagnostics person_count = row_count;

  update private.gedcom_deletion_jobs job
  set total_persons = person_count,
      updated_at = clock_timestamp()
  where job.id = created_job_id;

  -- Snapshot only trees wholly owned by this source. The membership branch
  -- preserves legacy GEDCOM trees that predate settings.import_source_key.
  insert into private.gedcom_deletion_job_trees (job_id, project_id, tree_id)
  select created_job_id, target_project_id, tree.id
  from public.family_trees tree
  where tree.project_id = target_project_id
    and (
      coalesce(tree.settings ->> 'source', '') = 'gedcom_import'
      and (
        coalesce(tree.settings ->> 'import_source_key', '') = normalized_source_key
        or (
          nullif(btrim(coalesce(tree.settings ->> 'import_source_key', '')), '') is null
          and exists (
        select 1
        from public.family_tree_persons imported_member
        join private.gedcom_deletion_job_persons owned
          on owned.job_id = created_job_id and owned.person_id = imported_member.person_id
        where imported_member.tree_id = tree.id
          )
        )
      )
    and not exists (
      select 1 from public.family_tree_persons member
      where member.tree_id = tree.id
        and not exists (
          select 1 from private.gedcom_deletion_job_persons owned
          where owned.job_id = created_job_id and owned.person_id = member.person_id
        )
    )
    )
  on conflict do nothing;

  insert into private.gedcom_deletion_job_batches (job_id, project_id, import_batch_id)
  select created_job_id, target_project_id, batch.id
  from public.gedcom_import_batches batch
  where batch.project_id = target_project_id
    and (
      exists (
        select 1 from private.gedcom_deletion_job_trees owned_tree
        where owned_tree.job_id = created_job_id and owned_tree.tree_id = batch.tree_id
      )
      or (
        exists (
          select 1 from public.gedcom_xref_maps xref
          join private.gedcom_deletion_job_persons owned
            on owned.job_id = created_job_id and owned.person_id = xref.internal_id
          where xref.project_id = target_project_id
            and xref.import_batch_id = batch.id
            and lower(xref.internal_table) in ('person', 'persons')
        )
        and not exists (
          select 1 from public.gedcom_xref_maps xref
          where xref.project_id = target_project_id
            and xref.import_batch_id = batch.id
            and lower(xref.internal_table) in ('person', 'persons')
            and not exists (
              select 1 from private.gedcom_deletion_job_persons owned
              where owned.job_id = created_job_id and owned.person_id = xref.internal_id
            )
        )
      )
    )
  on conflict do nothing;

  return private.gedcom_deletion_job_payload(created_job_id);
end;
$function$;

create or replace function security_private.continue_project_gedcom_deletion(
  target_job_id uuid,
  batch_size integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, security_private, pg_temp
set lock_timeout = '3s'
set statement_timeout = '15s'
as $function$
declare
  actor_id uuid := auth.uid();
  service_worker boolean := coalesce(auth.role(), '') = 'service_role';
  job private.gedcom_deletion_jobs%rowtype;
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 50), 100));
  affected_count integer := 0;
  selected_person_ids uuid[];
  deletion_result jsonb;
  error_message text;
  error_code text;
  error_detail text;
  error_hint text;
begin
  if actor_id is null and not service_worker then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_job_id is null then
    raise exception 'GEDCOM_DELETION_JOB_ID_REQUIRED' using errcode = '22023';
  end if;

  select candidate.* into job
  from private.gedcom_deletion_jobs candidate
  where candidate.id = target_job_id;
  if job.id is null then
    raise exception 'GEDCOM_DELETION_JOB_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not service_worker and not security_private.can_edit_project(job.project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(job.project_id::text, 7341)
  ) then
    raise exception 'PROJECT_GEDCOM_DELETION_BUSY' using errcode = '55P03';
  end if;
  select candidate.* into job
  from private.gedcom_deletion_jobs candidate
  where candidate.id = target_job_id
  for update;

  if job.status = 'completed' then
    return private.gedcom_deletion_job_payload(job.id);
  end if;
  if job.status = 'failed'
     and job.last_error_code not in ('57014', '40001', '40P01', '55P03') then
    return private.gedcom_deletion_job_payload(job.id);
  end if;
  if exists (
    select 1 from private.gedcom_import_operations operation
    where operation.project_id = job.project_id
      and operation.status in ('preparing', 'importing', 'rolling_back')
  ) then
    raise exception 'PROJECT_GEDCOM_OPERATION_ACTIVE' using errcode = '55000';
  end if;

  update private.gedcom_deletion_jobs current_job
  set status = 'running', last_error_code = '', last_error = '', updated_at = clock_timestamp()
  where current_job.id = job.id;

  begin
    loop
      affected_count := 0;

      if job.phase = 'relations' then
        with candidates as (
          select relation.id
          from public.person_relations relation
          where relation.project_id = job.project_id
            and relation.import_source_key = job.source_key
          order by relation.id
          limit safe_batch_size
          for update skip locked
        ), deleted as (
          delete from public.person_relations relation
          using candidates
          where relation.id = candidates.id
          returning relation.id
        )
        select count(*)::integer into affected_count from deleted;

        if affected_count > 0 then
          update private.gedcom_deletion_jobs current_job
          set deleted_relations = deleted_relations + affected_count,
              updated_at = clock_timestamp()
          where current_job.id = job.id;
          exit;
        end if;
        if exists (
          select 1 from public.person_relations relation
          where relation.project_id = job.project_id
            and relation.import_source_key = job.source_key
        ) then
          raise exception 'GEDCOM_DELETION_ROW_BUSY' using errcode = '55P03';
        end if;
        update private.gedcom_deletion_jobs set phase = 'findings', updated_at = clock_timestamp()
        where id = job.id;
        job.phase := 'findings';

      elsif job.phase = 'findings' then
        with candidates as (
          select finding.id
          from public.findings finding
          where finding.project_id = job.project_id
            and finding.custom_fields ->> '__gedcomImportSourceKey' = job.source_key
          order by finding.id
          limit safe_batch_size
          for update skip locked
        ), deleted as (
          delete from public.findings finding
          using candidates
          where finding.id = candidates.id
          returning finding.id
        )
        select count(*)::integer into affected_count from deleted;

        if affected_count > 0 then
          update private.gedcom_deletion_jobs current_job
          set deleted_findings = deleted_findings + affected_count,
              updated_at = clock_timestamp()
          where current_job.id = job.id;
          exit;
        end if;
        if exists (
          select 1 from public.findings finding
          where finding.project_id = job.project_id
            and finding.custom_fields ->> '__gedcomImportSourceKey' = job.source_key
        ) then
          raise exception 'GEDCOM_DELETION_ROW_BUSY' using errcode = '55P03';
        end if;
        update private.gedcom_deletion_jobs set phase = 'trees', updated_at = clock_timestamp()
        where id = job.id;
        job.phase := 'trees';

      elsif job.phase = 'trees' then
        select array[candidate.tree_id]::uuid[]
        into selected_person_ids
        from private.gedcom_deletion_job_trees candidate
        where candidate.job_id = job.id and candidate.processed_at is null
        order by candidate.tree_id
        limit 1
        for update skip locked;

        if cardinality(coalesce(selected_person_ids, array[]::uuid[])) > 0 then
          -- These child rows belong exclusively to a tree that is removed in
          -- this phase, so per-row graph-version bumps have no consumer.
          perform pg_catalog.set_config('app.project_deletion', 'on', true);
          affected_count := private.delete_gedcom_tree_children_batch(
            job.project_id, selected_person_ids, safe_batch_size
          );
          if affected_count > 0 then
            update private.gedcom_deletion_jobs set updated_at = clock_timestamp() where id = job.id;
            exit;
          end if;
          delete from public.family_trees tree
          where tree.project_id = job.project_id and tree.id = selected_person_ids[1];
          delete from private.gedcom_deletion_job_trees owned
          where owned.job_id = job.id and owned.tree_id = selected_person_ids[1];
          affected_count := 1;
        end if;
        if affected_count > 0 then
          update private.gedcom_deletion_jobs set updated_at = clock_timestamp() where id = job.id;
          exit;
        end if;
        update private.gedcom_deletion_jobs set phase = 'archives', updated_at = clock_timestamp()
        where id = job.id;
        job.phase := 'archives';

      elsif job.phase = 'archives' then
        select array[candidate.import_batch_id]::uuid[]
        into selected_person_ids
        from private.gedcom_deletion_job_batches candidate
        where candidate.job_id = job.id and candidate.processed_at is null
        order by candidate.import_batch_id
        limit 1
        for update skip locked;

        if cardinality(coalesce(selected_person_ids, array[]::uuid[])) > 0 then
          affected_count := private.delete_gedcom_archive_children_batch(
            job.project_id, selected_person_ids, safe_batch_size
          );
          if affected_count > 0 then
            update private.gedcom_deletion_jobs set updated_at = clock_timestamp() where id = job.id;
            exit;
          end if;
          delete from public.gedcom_import_batches batch
          where batch.project_id = job.project_id and batch.id = selected_person_ids[1];
          delete from private.gedcom_deletion_job_batches owned
          where owned.job_id = job.id and owned.import_batch_id = selected_person_ids[1];
          affected_count := 1;
        end if;
        if affected_count > 0 then
          update private.gedcom_deletion_jobs set updated_at = clock_timestamp() where id = job.id;
          exit;
        end if;
        update private.gedcom_deletion_jobs set phase = 'persons', updated_at = clock_timestamp()
        where id = job.id;
        job.phase := 'persons';

      elsif job.phase = 'persons' then
        with missing_candidates as (
          select candidate.ctid
          from private.gedcom_deletion_job_persons candidate
          where candidate.job_id = job.id
            and candidate.processed_at is null
            and not exists (
              select 1 from public.persons person
              where person.id = candidate.person_id and person.project_id = candidate.project_id
            )
          order by candidate.person_id
          limit safe_batch_size
        ), removed_missing as (
          delete from private.gedcom_deletion_job_persons owned
          using missing_candidates candidate
          where owned.ctid = candidate.ctid
          returning owned.person_id
        )
        select count(*)::integer into affected_count from removed_missing;
        if affected_count > 0 then
          update private.gedcom_deletion_jobs current_job
          set processed_persons = processed_persons + affected_count,
              updated_at = clock_timestamp()
          where current_job.id = job.id;
          exit;
        end if;

        select coalesce(array_agg(candidate.person_id order by candidate.person_id), array[]::uuid[])
        into selected_person_ids
        from (
          select owned.person_id
          from private.gedcom_deletion_job_persons owned
          join public.persons person
            on person.id = owned.person_id and person.project_id = owned.project_id
          where owned.job_id = job.id and owned.processed_at is null
          order by owned.person_id
          limit safe_batch_size
          for update of person skip locked
        ) candidate;

        if cardinality(selected_person_ids) > 0 then
          perform pg_catalog.set_config('app.gedcom_dataset_deletion', 'on', true);
          deletion_result := private.delete_project_person_ids(job.project_id, selected_person_ids, '');
          delete from private.gedcom_deletion_job_persons owned
          where owned.job_id = job.id and owned.person_id = any(selected_person_ids);
          get diagnostics affected_count = row_count;
          update private.gedcom_deletion_jobs current_job
          set processed_persons = processed_persons + affected_count,
              deleted_persons = deleted_persons + coalesce((deletion_result ->> 'deletedPersons')::integer, 0),
              deleted_relations = deleted_relations + coalesce((deletion_result ->> 'deletedRelations')::integer, 0),
              deleted_findings = deleted_findings + coalesce((deletion_result ->> 'deletedFindings')::integer, 0),
              updated_at = clock_timestamp()
          where current_job.id = job.id;
          exit;
        end if;
        if exists (
          select 1
          from private.gedcom_deletion_job_persons owned
          join public.persons person
            on person.id = owned.person_id and person.project_id = owned.project_id
          where owned.job_id = job.id and owned.processed_at is null
        ) then
          raise exception 'GEDCOM_DELETION_ROW_BUSY' using errcode = '55P03';
        end if;
        update private.gedcom_deletion_jobs set phase = 'finalize', updated_at = clock_timestamp()
        where id = job.id;
        job.phase := 'finalize';

      elsif job.phase = 'finalize' then
        if exists (
          select 1 from public.persons person
          where person.project_id = job.project_id
            and person.custom_fields ->> '__gedcomImportSourceKey' = job.source_key
          union all
          select 1 from public.person_relations relation
          where relation.project_id = job.project_id and relation.import_source_key = job.source_key
          union all
          select 1 from public.findings finding
          where finding.project_id = job.project_id
            and finding.custom_fields ->> '__gedcomImportSourceKey' = job.source_key
        ) then
          raise exception 'GEDCOM_DELETION_SOURCE_CHANGED' using errcode = '55000';
        end if;

        if exists (select 1 from private.gedcom_deletion_job_persons owned where owned.job_id = job.id)
           or exists (select 1 from private.gedcom_deletion_job_trees owned where owned.job_id = job.id)
           or exists (select 1 from private.gedcom_deletion_job_batches owned where owned.job_id = job.id) then
          raise exception 'GEDCOM_DELETION_SNAPSHOT_NOT_DRAINED' using errcode = '55000';
        end if;

        delete from private.gedcom_import_datasets dataset
        where dataset.project_id = job.project_id and dataset.source_key = job.source_key;
        insert into public.activity_log (
          project_id, actor_id, action, entity_type, entity_id, details
        ) values (
          job.project_id, coalesce(actor_id, job.requested_by),
          'gedcom_dataset_deleted', 'persons', null,
          jsonb_build_object(
            'jobId', job.id,
            'importSourceKey', job.source_key,
            'personCount', (select current_job.deleted_persons from private.gedcom_deletion_jobs current_job where current_job.id = job.id),
            'relationCount', (select current_job.deleted_relations from private.gedcom_deletion_jobs current_job where current_job.id = job.id),
            'findingCount', (select current_job.deleted_findings from private.gedcom_deletion_jobs current_job where current_job.id = job.id)
          )
        );
        update private.gedcom_deletion_jobs current_job
        set status = 'completed', phase = 'completed', last_error_code = '', last_error = '',
            updated_at = clock_timestamp(), completed_at = clock_timestamp()
        where current_job.id = job.id;
        exit;
      else
        exit;
      end if;
    end loop;
  exception when others then
    get stacked diagnostics
      error_code = returned_sqlstate,
      error_message = message_text,
      error_detail = pg_exception_detail,
      error_hint = pg_exception_hint;
    update private.gedcom_deletion_jobs current_job
    set status = 'failed',
        last_error_code = coalesce(error_code, ''),
        last_error = left(concat_ws(' | ', error_message, nullif(error_detail, ''), nullif(error_hint, '')), 2000),
        updated_at = clock_timestamp()
    where current_job.id = job.id;
  end;

  return private.gedcom_deletion_job_payload(job.id);
end;
$function$;

create or replace function security_private.get_project_gedcom_deletion(target_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, private, security_private, pg_temp
as $function$
declare
  project_id uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select job.project_id into project_id
  from private.gedcom_deletion_jobs job where job.id = target_job_id;
  if project_id is null then
    raise exception 'GEDCOM_DELETION_JOB_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.is_project_member(project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  return private.gedcom_deletion_job_payload(target_job_id);
end;
$function$;

create or replace function security_private.process_next_gedcom_deletion_job(
  batch_size integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, private, security_private, pg_temp
set lock_timeout = '3s'
set statement_timeout = '15s'
as $function$
declare
  target_job_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select job.id into target_job_id
  from private.gedcom_deletion_jobs job
  where job.status in ('pending', 'running')
     or (
       job.status = 'failed'
       and job.last_error_code in ('57014', '40001', '40P01', '55P03')
     )
  order by
    case job.status when 'running' then 0 when 'pending' then 1 else 2 end,
    job.updated_at,
    job.id
  limit 1
  for update skip locked;

  if target_job_id is null then
    return null;
  end if;
  return security_private.continue_project_gedcom_deletion(target_job_id, batch_size);
end;
$function$;

revoke all on function
  security_private.start_project_gedcom_deletion(uuid, text),
  security_private.continue_project_gedcom_deletion(uuid, integer),
  security_private.get_project_gedcom_deletion(uuid),
  security_private.process_next_gedcom_deletion_job(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.start_project_gedcom_deletion(uuid, text),
  security_private.continue_project_gedcom_deletion(uuid, integer),
  security_private.get_project_gedcom_deletion(uuid)
  to authenticated, service_role;
grant execute on function security_private.process_next_gedcom_deletion_job(integer)
  to service_role;

create or replace function public.start_project_gedcom_deletion(
  target_project_id uuid,
  target_source_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.start_project_gedcom_deletion($1, $2);
$wrapper$;

create or replace function public.continue_project_gedcom_deletion(
  target_job_id uuid,
  batch_size integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.continue_project_gedcom_deletion($1, $2);
$wrapper$;

create or replace function public.get_project_gedcom_deletion(target_job_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_project_gedcom_deletion($1);
$wrapper$;

create or replace function public.process_next_gedcom_deletion_job(batch_size integer default 50)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.process_next_gedcom_deletion_job($1);
$wrapper$;

revoke all on function
  public.start_project_gedcom_deletion(uuid, text),
  public.continue_project_gedcom_deletion(uuid, integer),
  public.get_project_gedcom_deletion(uuid),
  public.process_next_gedcom_deletion_job(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.start_project_gedcom_deletion(uuid, text),
  public.continue_project_gedcom_deletion(uuid, integer),
  public.get_project_gedcom_deletion(uuid)
  to authenticated, service_role;
grant execute on function public.process_next_gedcom_deletion_job(integer)
  to service_role;

commit;
