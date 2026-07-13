begin;

-- Older GEDCOM imports predate the per-import rollback journal.  Removing one
-- of those imports by project alone is unsafe because a project can contain
-- several unrelated import sources.  This queue snapshots the exact rows
-- attributable to one source key before the first destructive statement.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.legacy_gedcom_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requested_by uuid references public.profiles(user_id) on delete set null,
  source_key text not null check (length(source_key) between 1 and 500),
  expected_person_count integer not null check (expected_person_count > 0),
  target_person_count integer not null check (target_person_count > 0),
  target_finding_count integer not null default 0 check (target_finding_count >= 0),
  target_document_count integer not null default 0 check (target_document_count >= 0),
  preserved_person_count integer not null default 0 check (preserved_person_count >= 0),
  preserved_person_checksum text not null default '',
  deleted_person_count integer not null default 0 check (deleted_person_count >= 0),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'paused', 'failed', 'completed')),
  phase_index integer not null default 0 check (phase_index >= 0),
  processed_rows bigint not null default 0 check (processed_rows >= 0),
  source_created_from timestamptz,
  source_created_to timestamptz,
  error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

create unique index if not exists legacy_gedcom_cleanup_active_project_uq
  on private.legacy_gedcom_cleanup_jobs (project_id)
  where status in ('queued', 'running', 'paused', 'failed');
create index if not exists legacy_gedcom_cleanup_worker_idx
  on private.legacy_gedcom_cleanup_jobs (status, updated_at, created_at);
create index if not exists legacy_gedcom_cleanup_requester_idx
  on private.legacy_gedcom_cleanup_jobs (requested_by, created_at desc);

create table if not exists private.legacy_gedcom_cleanup_entities (
  job_id uuid not null
    references private.legacy_gedcom_cleanup_jobs(id) on delete cascade,
  project_id uuid not null,
  entity_type text not null check (entity_type in (
    'person', 'finding', 'document', 'attachment', 'person_relation',
    'association_relationship', 'parent_child_relationship',
    'partner_relationship', 'parent_set',
    'family_group', 'family_tree', 'gedcom_import_batch'
  )),
  entity_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  primary key (job_id, entity_type, entity_id)
);

create index if not exists legacy_gedcom_cleanup_entities_lookup_idx
  on private.legacy_gedcom_cleanup_entities (job_id, entity_id, entity_type);

-- Storage objects must be removed through the Storage API.  Keeping this
-- queue beside the database job prevents attachment metadata from being
-- deleted while its physical object is still present.
create table if not exists private.legacy_gedcom_cleanup_storage_objects (
  job_id uuid not null
    references private.legacy_gedcom_cleanup_jobs(id) on delete cascade,
  attachment_id uuid not null,
  storage_bucket text not null,
  storage_path text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  primary key (job_id, attachment_id)
);

create index if not exists legacy_gedcom_cleanup_storage_pending_idx
  on private.legacy_gedcom_cleanup_storage_objects (job_id, deleted_at)
  where deleted_at is null;

revoke all on table private.legacy_gedcom_cleanup_jobs,
  private.legacy_gedcom_cleanup_entities,
  private.legacy_gedcom_cleanup_storage_objects
  from public, anon, authenticated;

-- These compact indexes make the exact source preflight and source-owned
-- finding/document cleanup independent of the large trigram search indexes.
create index if not exists persons_gedcom_import_source_idx
  on public.persons (project_id, (custom_fields ->> '__gedcomImportSourceKey'))
  where coalesce(custom_fields ->> '__gedcomImportSourceKey', '') <> '';
create index if not exists findings_gedcom_import_source_idx
  on public.findings (project_id, (custom_fields ->> '__gedcomImportSourceKey'))
  where coalesce(custom_fields ->> '__gedcomImportSourceKey', '') <> '';
create index if not exists documents_gedcom_import_source_idx
  on public.documents (project_id, (custom_fields ->> '__gedcomImportSourceKey'))
  where coalesce(custom_fields ->> '__gedcomImportSourceKey', '') <> '';

create or replace function private.legacy_gedcom_cleanup_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'storage_objects',
    'activity_log',
    'record_links',
    'hypothesis_links',
    'attachments',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'person_relations',
    'association_relationships',
    'parent_child_relationships',
    'partner_relationships',
    'family_group_members',
    'tree_layout_positions',
    'family_tree_research_issues',
    'person_timeline_events',
    'person_names',
    'task_persons',
    'archive_request_persons',
    'finding_participants',
    'parent_sets_for_people',
    'family_tree_persons',
    'family_tree_roots',
    'family_group_partner_refs',
    'findings',
    'documents',
    'persons',
    'orphan_parent_sets',
    'orphan_family_groups',
    'deleted_container_activity_log',
    'deleted_container_record_links',
    'deleted_container_xrefs',
    'gedcom_import_batches',
    'finalize_trees'
  ]::text[];
$$;

revoke execute on function private.legacy_gedcom_cleanup_phase_names()
  from public, anon, authenticated;

create or replace function private.legacy_gedcom_cleanup_payload(target_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  with state as (
    select job.*, private.legacy_gedcom_cleanup_phase_names() phases
    from private.legacy_gedcom_cleanup_jobs job
    where job.id = target_job_id
  )
  select jsonb_build_object(
    'jobId', id,
    'projectId', project_id,
    'sourceKey', source_key,
    'status', status,
    'phase', case
      when status = 'completed' then 'completed'
      when phase_index >= cardinality(phases) then 'finalizing'
      else phases[phase_index + 1]
    end,
    'expectedPersonCount', expected_person_count,
    'targetPersonCount', target_person_count,
    'targetFindingCount', target_finding_count,
    'targetDocumentCount', target_document_count,
    'preservedPersonCount', preserved_person_count,
    'preservedPersonChecksum', preserved_person_checksum,
    'deletedPersonCount', deleted_person_count,
    'processedRows', processed_rows,
    'completedPhases', least(phase_index, cardinality(phases)),
    'totalPhases', cardinality(phases),
    'progressPercent', case
      when status = 'completed' then 100
      else least(99, floor(
        least(phase_index, cardinality(phases))::numeric * 99 /
        greatest(cardinality(phases), 1)
      )::integer)
    end,
    'requiresStorageCleanup', case
      when phase_index < cardinality(phases)
       and phases[phase_index + 1] = 'storage_objects'
      then exists (
        select 1
        from private.legacy_gedcom_cleanup_storage_objects object
        where object.job_id = id and object.deleted_at is null
      )
      else false
    end,
    'error', error,
    'sourceCreatedFrom', source_created_from,
    'sourceCreatedTo', source_created_to,
    'createdAt', created_at,
    'updatedAt', updated_at,
    'completedAt', completed_at
  )
  from state;
$$;

revoke execute on function private.legacy_gedcom_cleanup_payload(uuid)
  from public, anon, authenticated;

create or replace function private.can_manage_legacy_gedcom_cleanup(
  target_job_id uuid,
  actor_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  select actor_id is not null and exists (
    select 1
    from private.legacy_gedcom_cleanup_jobs job
    where job.id = target_job_id
      and (
        public.is_app_admin(actor_id)
        or exists (
          select 1
          from public.project_members member
          where member.project_id = job.project_id
            and member.user_id = actor_id
            and member.role in ('owner', 'editor')
        )
      )
  );
$$;

revoke execute on function private.can_manage_legacy_gedcom_cleanup(uuid, uuid)
  from public, anon, authenticated;

-- Materialize every attributable canonical row and every graph container that
-- may need repair.  The exact person count is a destructive confirmation
-- token: a changed database state aborts before a job row is created.
create or replace function private.create_legacy_gedcom_cleanup_job(
  target_project_id uuid,
  target_source_key text,
  expected_person_count integer,
  requester_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  normalized_source_key text := btrim(coalesce(target_source_key, ''));
  actual_person_count integer;
  finding_count integer;
  document_count integer;
  preserved_count integer;
  preserved_checksum text;
  created_from timestamptz;
  created_to timestamptz;
  created_job_id uuid;
  active_job private.legacy_gedcom_cleanup_jobs%rowtype;
begin
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if normalized_source_key = '' or length(normalized_source_key) > 500 then
    raise exception 'GEDCOM_SOURCE_KEY_INVALID' using errcode = '22023';
  end if;
  if coalesce(expected_person_count, 0) <= 0 then
    raise exception 'EXPECTED_PERSON_COUNT_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7419)
  );

  if not exists (
    select 1 from public.projects project
    where project.id = target_project_id
      and not project.deletion_pending
  ) then
    raise exception 'PROJECT_NOT_FOUND_OR_DELETING' using errcode = '22023';
  end if;

  select job.* into active_job
  from private.legacy_gedcom_cleanup_jobs job
  where job.project_id = target_project_id
    and job.status in ('queued', 'running', 'paused', 'failed')
  order by job.created_at desc
  limit 1
  for update;

  if active_job.id is not null then
    if active_job.source_key <> normalized_source_key
       or active_job.expected_person_count <> expected_person_count then
      raise exception 'LEGACY_GEDCOM_CLEANUP_ALREADY_ACTIVE:%', active_job.id
        using errcode = '55000';
    end if;
    update private.legacy_gedcom_cleanup_jobs
    set status = 'queued', error = null, updated_at = clock_timestamp()
    where id = active_job.id and status in ('paused', 'failed');
    return active_job.id;
  end if;

  if exists (
    select 1
    from private.gedcom_import_operations operation
    where operation.project_id = target_project_id
      and operation.status in ('preparing', 'importing', 'rolling_back')
  ) then
    raise exception 'GEDCOM_IMPORT_ALREADY_ACTIVE' using errcode = '55000';
  end if;

  -- The active job/freeze is invisible to other transactions until commit.
  -- Hold short SHARE locks on every table read or mutated by cleanup while
  -- creating the immutable snapshot.  This drains transactions that started
  -- before the uncommitted job can be seen and makes later writes observe the
  -- cleanup fences.  Failure to acquire every lock is safer than an incomplete
  -- destructive snapshot, so lock_timeout deliberately aborts for retry.
  perform pg_catalog.set_config('lock_timeout', '10s', true);
  lock table public.projects,
    private.gedcom_import_operations,
    storage.objects,
    public.persons,
    public.findings,
    public.documents,
    public.attachments,
    public.person_relations,
    public.association_relationships,
    public.parent_child_relationships,
    public.partner_relationships,
    public.parent_sets,
    public.family_groups,
    public.family_group_members,
    public.family_trees,
    public.family_tree_persons,
    public.gedcom_import_batches,
    public.gedcom_xref_maps,
    public.family_tree_merge_history,
    public.tree_layout_positions,
    public.family_tree_research_issues,
    public.person_timeline_events,
    public.person_names,
    public.task_persons,
    public.archive_request_persons,
    public.finding_participants,
    public.hypothesis_links,
    public.record_links,
    public.activity_log
  in share mode;

  -- Repeat mutable-state preconditions only after all snapshot/phase locks.
  -- The checks above are a fast fail; these are the race-free authority.
  if not exists (
    select 1 from public.projects project
    where project.id = target_project_id
      and not project.deletion_pending
  ) then
    raise exception 'PROJECT_NOT_FOUND_OR_DELETING' using errcode = '22023';
  end if;

  if exists (
    select 1
    from private.gedcom_import_operations operation
    where operation.project_id = target_project_id
      and operation.status in ('preparing', 'importing', 'rolling_back')
  ) then
    raise exception 'GEDCOM_IMPORT_ALREADY_ACTIVE' using errcode = '55000';
  end if;

  select count(*)::integer, min(person.created_at), max(person.created_at)
  into actual_person_count, created_from, created_to
  from public.persons person
  where person.project_id = target_project_id
    and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
    and person.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  if actual_person_count <> expected_person_count then
    raise exception 'GEDCOM_SOURCE_PERSON_COUNT_MISMATCH:expected=%,actual=%',
      expected_person_count, actual_person_count
      using errcode = '22023';
  end if;

  select count(*)::integer into finding_count
  from public.findings finding
  where finding.project_id = target_project_id
    and coalesce(finding.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
    and finding.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  select count(*)::integer into document_count
  from public.documents document
  where document.project_id = target_project_id
    and coalesce(document.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
    and document.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  select count(*)::integer,
         md5(coalesce(string_agg(person.id::text, ',' order by person.id), ''))
  into preserved_count, preserved_checksum
  from public.persons person
  where person.project_id = target_project_id
    and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '')
        <> normalized_source_key;

  insert into private.legacy_gedcom_cleanup_jobs (
    project_id, requested_by, source_key, expected_person_count,
    target_person_count, target_finding_count, target_document_count,
    preserved_person_count, preserved_person_checksum,
    source_created_from, source_created_to
  ) values (
    target_project_id, requester_id, normalized_source_key,
    expected_person_count, actual_person_count, finding_count, document_count,
    preserved_count, preserved_checksum,
    created_from, created_to
  ) returning id into created_job_id;

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select created_job_id, target_project_id, 'person', person.id
  from public.persons person
  where person.project_id = target_project_id
    and coalesce(person.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
    and person.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select created_job_id, target_project_id, 'finding', finding.id
  from public.findings finding
  where finding.project_id = target_project_id
    and coalesce(finding.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
    and finding.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select created_job_id, target_project_id, 'document', document.id
  from public.documents document
  where document.project_id = target_project_id
    and coalesce(document.custom_fields ->> '__gedcomImportSourceKey', '') <> ''
    and document.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id, 'person_relation', relation.id
  from public.person_relations relation
  where relation.project_id = target_project_id
    and (
      exists (
        select 1 from private.legacy_gedcom_cleanup_entities target
        where target.job_id = created_job_id
          and target.entity_type = 'person'
          and target.entity_id = relation.person_id
      )
      or exists (
        select 1 from private.legacy_gedcom_cleanup_entities target
        where target.job_id = created_job_id
          and target.entity_type = 'person'
          and target.entity_id = relation.related_person_id
      )
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id,
         'association_relationship', relation.id
  from public.association_relationships relation
  where relation.project_id = target_project_id
    and exists (
      select 1 from private.legacy_gedcom_cleanup_entities target
      where target.job_id = created_job_id
        and target.entity_type = 'person'
        and target.entity_id in (relation.person_a_id, relation.person_b_id)
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id,
         'parent_child_relationship', relation.id
  from public.parent_child_relationships relation
  where relation.project_id = target_project_id
    and exists (
      select 1 from private.legacy_gedcom_cleanup_entities target
      where target.job_id = created_job_id
        and target.entity_type = 'person'
        and target.entity_id in (relation.parent_id, relation.child_id)
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id,
         'partner_relationship', relation.id
  from public.partner_relationships relation
  where relation.project_id = target_project_id
    and exists (
      select 1 from private.legacy_gedcom_cleanup_entities target
      where target.job_id = created_job_id
        and target.entity_type = 'person'
        and target.entity_id in (relation.person_a_id, relation.person_b_id)
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id, 'parent_set', parent_set.id
  from public.parent_sets parent_set
  where parent_set.project_id = target_project_id
    and (
      exists (
        select 1 from private.legacy_gedcom_cleanup_entities target
        where target.job_id = created_job_id
          and target.entity_type = 'person'
          and target.entity_id = parent_set.child_id
      )
      or exists (
        select 1
        from public.parent_child_relationships relation
        join private.legacy_gedcom_cleanup_entities target
          on target.job_id = created_job_id
         and target.entity_type = 'person'
         and target.entity_id in (relation.parent_id, relation.child_id)
        where relation.project_id = target_project_id
          and relation.parent_set_id = parent_set.id
      )
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id, 'family_group', family_group.id
  from public.family_groups family_group
  where family_group.project_id = target_project_id
    and (
      exists (
        select 1 from private.legacy_gedcom_cleanup_entities target
        where target.job_id = created_job_id
          and target.entity_type = 'person'
          and target.entity_id in (
            family_group.primary_partner_1_id,
            family_group.primary_partner_2_id
          )
      )
      or exists (
        select 1
        from public.family_group_members member
        join private.legacy_gedcom_cleanup_entities target
          on target.job_id = created_job_id
         and target.entity_type = 'person'
         and target.entity_id = member.person_id
        where member.project_id = target_project_id
          and member.family_group_id = family_group.id
      )
      or exists (
        select 1
        from public.parent_sets parent_set
        join private.legacy_gedcom_cleanup_entities target
          on target.job_id = created_job_id
         and target.entity_type = 'parent_set'
         and target.entity_id = parent_set.id
        where parent_set.family_group_id = family_group.id
      )
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select distinct created_job_id, target_project_id, 'family_tree', tree.id
  from public.family_trees tree
  where tree.project_id = target_project_id
    and (
      exists (
        select 1 from private.legacy_gedcom_cleanup_entities target
        where target.job_id = created_job_id
          and target.entity_type = 'person'
          and target.entity_id = tree.root_person_id
      )
      or exists (
        select 1
        from public.family_tree_persons member
        join private.legacy_gedcom_cleanup_entities target
          on target.job_id = created_job_id
         and target.entity_type = 'person'
         and target.entity_id = member.person_id
        where member.project_id = target_project_id
          and member.tree_id = tree.id
      )
      or exists (
        select 1
        from public.family_groups family_group
        join private.legacy_gedcom_cleanup_entities target
          on target.job_id = created_job_id
         and target.entity_type = 'family_group'
         and target.entity_id = family_group.id
        where family_group.tree_id = tree.id
      )
    );

  -- A lossless archive is attributable only when every person XREF belongs to
  -- this exact person snapshot and its declared person count also matches.
  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select created_job_id, target_project_id, 'gedcom_import_batch', batch.id
  from public.gedcom_import_batches batch
  where batch.project_id = target_project_id
    and batch.imported_people = expected_person_count
    and (
      select count(distinct xref.internal_id)::integer
      from public.gedcom_xref_maps xref
      where xref.import_batch_id = batch.id
        and xref.internal_table = 'persons'
    ) = expected_person_count
    and exists (
      select 1
      from public.gedcom_xref_maps xref
      join private.legacy_gedcom_cleanup_entities target
        on target.job_id = created_job_id
       and target.entity_type = 'person'
       and target.entity_id = xref.internal_id
      where xref.import_batch_id = batch.id
        and xref.internal_table = 'persons'
    )
    and not exists (
      select 1
      from public.gedcom_xref_maps xref
      where xref.import_batch_id = batch.id
        and xref.internal_table = 'persons'
        and not exists (
          select 1 from private.legacy_gedcom_cleanup_entities target
          where target.job_id = created_job_id
            and target.entity_type = 'person'
            and target.entity_id = xref.internal_id
        )
    );

  insert into private.legacy_gedcom_cleanup_entities (
    job_id, project_id, entity_type, entity_id
  )
  select created_job_id, target_project_id, 'attachment', attachment.id
  from public.attachments attachment
  where attachment.project_id = target_project_id
    and exists (
      select 1
      from private.legacy_gedcom_cleanup_entities target
      where target.job_id = created_job_id
        and target.entity_id = attachment.owner_id
        and (
          (lower(attachment.owner_type) in ('person', 'persons') and target.entity_type = 'person')
          or (lower(attachment.owner_type) in ('finding', 'findings') and target.entity_type = 'finding')
          or (lower(attachment.owner_type) in ('document', 'documents') and target.entity_type = 'document')
        )
    )
  on conflict do nothing;

  if exists (
    select 1
    from public.attachments attachment
    join private.legacy_gedcom_cleanup_entities target
      on target.job_id = created_job_id
     and target.entity_type = 'attachment'
     and target.entity_id = attachment.id
    where attachment.storage_bucket = 'project-attachments'
      and public.storage_project_id(attachment.storage_path)
          is distinct from target_project_id
  ) then
    raise exception 'LEGACY_GEDCOM_ATTACHMENT_PATH_OUTSIDE_PROJECT'
      using errcode = '22023';
  end if;

  -- Google Drive and other external providers are not Supabase Storage
  -- buckets. Their Tracker metadata is removed later, but the user's external
  -- file is deliberately left untouched. Only project-attachments needs a
  -- physical Storage API acknowledgement.
  insert into private.legacy_gedcom_cleanup_storage_objects (
    job_id, attachment_id, storage_bucket, storage_path
  )
  select created_job_id, attachment.id, attachment.storage_bucket, attachment.storage_path
  from public.attachments attachment
  join private.legacy_gedcom_cleanup_entities target
    on target.job_id = created_job_id
   and target.entity_type = 'attachment'
   and target.entity_id = attachment.id
  where attachment.project_id = target_project_id
    and attachment.storage_bucket = 'project-attachments'
  on conflict do nothing;

  if (
    select count(*) from private.legacy_gedcom_cleanup_entities target
    where target.job_id = created_job_id and target.entity_type = 'person'
  ) <> expected_person_count then
    raise exception 'GEDCOM_CLEANUP_SNAPSHOT_COUNT_MISMATCH' using errcode = '55000';
  end if;

  return created_job_id;
end;
$$;

revoke execute on function private.create_legacy_gedcom_cleanup_job(uuid, text, integer, uuid)
  from public, anon, authenticated;

-- Freeze normal editor writes while a source cleanup is active.  Otherwise a
-- relation or attachment could be created after the immutable target snapshot
-- and escape an already-completed phase.  A paused job deliberately keeps the
-- freeze; resuming/cancelling goes through the dedicated RPCs below.
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
    )
    and not exists (
      select 1
      from private.legacy_gedcom_cleanup_jobs job
      where job.project_id = target_project_id
        and job.status in ('queued', 'running', 'paused', 'failed')
    );
$$;

revoke execute on function public.can_edit_project(uuid) from public, anon;
grant execute on function public.can_edit_project(uuid) to authenticated;

-- Backup restore is a SECURITY DEFINER maintenance path and intentionally
-- bypasses table RLS.  Repeat its current implementation with an explicit
-- cleanup fence so it cannot erase preserved rows between cleanup phases.
create or replace function public.clear_project_records_for_restore(
  target_project_id uuid,
  batch_size integer default 500
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
set statement_timeout = '8s'
as $$
declare
  actor_id uuid := auth.uid();
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 500), 500));
  current_table text;
  current_relation regclass;
  deleted_count integer := 0;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not public.is_project_owner(target_project_id)
     and not public.is_app_admin(actor_id) then
    raise exception 'PROJECT_RESTORE_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7419)
  );
  if exists (
    select 1
    from private.legacy_gedcom_cleanup_jobs job
    where job.project_id = target_project_id
      and job.status in ('queued', 'running', 'paused', 'failed')
  ) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACTIVE' using errcode = '55000';
  end if;
  if exists (
    select 1
    from public.projects project
    where project.id = target_project_id
      and project.deletion_pending
  ) then
    raise exception 'PROJECT_DELETION_IN_PROGRESS' using errcode = '55000';
  end if;

  perform pg_catalog.set_config('app.project_deletion', 'on', true);

  foreach current_table in array private.project_restore_clear_phase_names()
  loop
    current_relation := pg_catalog.to_regclass(format('public.%I', current_table));
    if current_relation is null then continue; end if;

    execute format(
      'with target_rows as (
         select ctid from %s where project_id = $1 limit $2
       ), deleted_rows as (
         delete from %s target using target_rows
         where target.ctid = target_rows.ctid returning 1
       )
       select count(*)::integer from deleted_rows',
      current_relation,
      current_relation
    ) into deleted_count using target_project_id, safe_batch_size;

    if deleted_count > 0 then
      return pg_catalog.jsonb_build_object(
        'complete', false,
        'table', current_table,
        'deletedRows', deleted_count
      );
    end if;
  end loop;

  delete from private.project_dashboard_stats_cache
  where project_id = target_project_id;
  return pg_catalog.jsonb_build_object(
    'complete', true,
    'table', null,
    'deletedRows', 0
  );
end;
$$;

revoke execute on function public.clear_project_records_for_restore(uuid, integer)
  from public, anon;
grant execute on function public.clear_project_records_for_restore(uuid, integer)
  to authenticated;

create or replace function public.start_legacy_gedcom_cleanup(
  target_project_id uuid,
  target_source_key text,
  expected_person_count integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  created_job_id uuid;
  resumable_job_id uuid;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  select job.id into resumable_job_id
  from private.legacy_gedcom_cleanup_jobs job
  where job.project_id = target_project_id
    and job.source_key = btrim(coalesce(target_source_key, ''))
    and job.expected_person_count = expected_person_count
    and job.status in ('queued', 'running', 'paused', 'failed')
  order by job.created_at desc
  limit 1;

  if resumable_job_id is not null
     and not private.can_manage_legacy_gedcom_cleanup(resumable_job_id, actor_id) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if resumable_job_id is null and not public.can_edit_project(target_project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  created_job_id := private.create_legacy_gedcom_cleanup_job(
    target_project_id,
    target_source_key,
    expected_person_count,
    actor_id
  );
  return private.legacy_gedcom_cleanup_payload(created_job_id);
end;
$$;

create or replace function public.get_legacy_gedcom_cleanup_status(target_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not private.can_manage_legacy_gedcom_cleanup(target_job_id, auth.uid()) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1 from private.legacy_gedcom_cleanup_jobs job
    where job.id = target_job_id
  ) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_NOT_FOUND' using errcode = '22023';
  end if;
  return private.legacy_gedcom_cleanup_payload(target_job_id);
end;
$$;

-- Pausing is safer than pretending already-deleted batches can be restored.
-- Calling start again with the same exact parameters resumes the same job.
create or replace function public.cancel_legacy_gedcom_cleanup(target_job_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if not private.can_manage_legacy_gedcom_cleanup(target_job_id, auth.uid()) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  update private.legacy_gedcom_cleanup_jobs
  set status = 'paused', updated_at = clock_timestamp()
  where id = target_job_id
    and status in ('queued', 'running', 'failed');
  return private.legacy_gedcom_cleanup_payload(target_job_id);
end;
$$;

-- Prevent a late browser batch from recreating the same legacy source after
-- its exact snapshot was queued.  A statement-level trigger costs one lookup
-- per import batch rather than one lookup per person.
create or replace function private.enforce_legacy_gedcom_cleanup_source_fence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if exists (
    select 1
    from new_person_rows person
    join private.legacy_gedcom_cleanup_jobs job
      on job.project_id = person.project_id
     and job.source_key = person.custom_fields ->> '__gedcomImportSourceKey'
     and job.status in ('queued', 'running', 'paused', 'failed')
  ) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACTIVE' using errcode = '55000';
  end if;
  return null;
end;
$$;

revoke execute on function private.enforce_legacy_gedcom_cleanup_source_fence()
  from public, anon, authenticated;

drop trigger if exists persons_insert_legacy_gedcom_cleanup_fence on public.persons;
create trigger persons_insert_legacy_gedcom_cleanup_fence
after insert on public.persons
referencing new table as new_person_rows
for each statement execute function private.enforce_legacy_gedcom_cleanup_source_fence();

drop trigger if exists persons_update_legacy_gedcom_cleanup_fence on public.persons;
create trigger persons_update_legacy_gedcom_cleanup_fence
after update on public.persons
referencing new table as new_person_rows
for each statement execute function private.enforce_legacy_gedcom_cleanup_source_fence();

create or replace function private.prevent_project_delete_during_legacy_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if new.deletion_pending and not old.deletion_pending and exists (
    select 1 from private.legacy_gedcom_cleanup_jobs job
    where job.project_id = new.id
      and job.status in ('queued', 'running', 'paused', 'failed')
  ) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACTIVE' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke execute on function private.prevent_project_delete_during_legacy_cleanup()
  from public, anon, authenticated;

drop trigger if exists projects_legacy_gedcom_cleanup_delete_fence on public.projects;
create trigger projects_legacy_gedcom_cleanup_delete_fence
before update of deletion_pending on public.projects
for each row execute function private.prevent_project_delete_during_legacy_cleanup();

create or replace function private.prevent_import_during_legacy_cleanup()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if new.status in ('preparing', 'importing', 'rolling_back') and exists (
    select 1 from private.legacy_gedcom_cleanup_jobs job
    where job.project_id = new.project_id
      and job.status in ('queued', 'running', 'paused', 'failed')
  ) then
    raise exception 'LEGACY_GEDCOM_CLEANUP_ACTIVE' using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke execute on function private.prevent_import_during_legacy_cleanup()
  from public, anon, authenticated;

drop trigger if exists gedcom_import_operations_legacy_cleanup_fence
  on private.gedcom_import_operations;
create trigger gedcom_import_operations_legacy_cleanup_fence
before insert or update of project_id, status
on private.gedcom_import_operations
for each row execute function private.prevent_import_during_legacy_cleanup();

commit;
