begin;

-- GEDCOM persistence is intentionally split into bounded browser requests. A
-- failed request therefore cannot be rolled back by the transaction that
-- committed an earlier batch. Keep a small durable journal of the rows that
-- did not exist before this import so a failed or abandoned import can remove
-- exactly those rows without touching pre-existing project data.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.gedcom_import_operations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Recovery must survive account/profile removal. Project deletion still
  -- cascades the whole operation safely through project_id.
  requested_by uuid references public.profiles(user_id) on delete set null,
  source_key text not null default '',
  status text not null default 'preparing'
    check (status in ('preparing', 'importing', 'rolling_back', 'completed', 'rolled_back')),
  registered_rows bigint not null default 0 check (registered_rows >= 0),
  rolled_back_rows bigint not null default 0 check (rolled_back_rows >= 0),
  heartbeat_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);

-- Serialising imports per project prevents two browser tabs from committing
-- overlapping GEDCOM batches and makes recovery deterministic.
create unique index if not exists gedcom_import_operations_active_project_uq
  on private.gedcom_import_operations (project_id)
  where status in ('preparing', 'importing', 'rolling_back');

create index if not exists gedcom_import_operations_recovery_idx
  on private.gedcom_import_operations (status, heartbeat_at, created_at);

create table if not exists private.gedcom_import_operation_entities (
  operation_id uuid not null
    references private.gedcom_import_operations(id) on delete cascade,
  project_id uuid not null,
  entity_type text not null
    check (entity_type in ('gedcom_import_batch', 'family_tree', 'finding', 'person_relation', 'document', 'person')),
  entity_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  rolled_back_at timestamptz,
  primary key (operation_id, entity_type, entity_id)
);

create index if not exists gedcom_import_operation_entities_fence_idx
  on private.gedcom_import_operation_entities (
    project_id,
    entity_type,
    entity_id,
    operation_id
  );

revoke all on table private.gedcom_import_operations,
  private.gedcom_import_operation_entities
  from public, anon, authenticated;

create or replace function private.gedcom_import_operation_payload(target_operation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
  select jsonb_build_object(
    'operationId', operation.id,
    'projectId', operation.project_id,
    'status', operation.status,
    'registeredRows', operation.registered_rows,
    'rolledBackRows', operation.rolled_back_rows,
    'remainingRows', (
      select count(*)
      from private.gedcom_import_operation_entities entity
      where entity.operation_id = operation.id
        and entity.rolled_back_at is null
    ),
    'heartbeatAt', operation.heartbeat_at,
    'createdAt', operation.created_at,
    'updatedAt', operation.updated_at,
    'completedAt', operation.completed_at
  )
  from private.gedcom_import_operations operation
  where operation.id = target_operation_id;
$$;

revoke execute on function private.gedcom_import_operation_payload(uuid)
  from public, anon, authenticated;

create or replace function private.can_manage_gedcom_import_operation(
  target_operation_id uuid,
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
    from private.gedcom_import_operations operation
    where operation.id = target_operation_id
      and (
        public.is_app_admin(actor_id)
        or exists (
          select 1
          from public.project_members member
          where member.project_id = operation.project_id
            and member.user_id = actor_id
            and member.role in ('owner', 'editor')
        )
      )
  );
$$;

revoke execute on function private.can_manage_gedcom_import_operation(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.start_gedcom_import_operation(
  target_project_id uuid,
  target_source_key text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  created_operation_id uuid;
  active_operation private.gedcom_import_operations%rowtype;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not public.can_edit_project(target_project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7341)
  );

  select operation.*
  into active_operation
  from private.gedcom_import_operations operation
  where operation.project_id = target_project_id
    and operation.status in ('preparing', 'importing', 'rolling_back')
  order by operation.created_at desc
  limit 1
  for update;

  if active_operation.id is not null then
    raise exception 'GEDCOM_IMPORT_ALREADY_ACTIVE:%', active_operation.id
      using errcode = '55000';
  end if;

  insert into private.gedcom_import_operations (
    project_id,
    requested_by,
    source_key
  ) values (
    target_project_id,
    actor_id,
    left(coalesce(target_source_key, ''), 500)
  )
  returning id into created_operation_id;

  return private.gedcom_import_operation_payload(created_operation_id);
end;
$$;

create or replace function public.register_gedcom_import_entities(
  target_operation_id uuid,
  target_entity_type text,
  target_entity_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  operation private.gedcom_import_operations%rowtype;
  inserted_count integer := 0;
  target_table text;
  already_exists boolean := false;
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if target_entity_type not in ('finding', 'person_relation', 'document', 'person') then
    raise exception 'GEDCOM_IMPORT_ENTITY_TYPE_INVALID' using errcode = '22023';
  end if;
  if coalesce(cardinality(target_entity_ids), 0) > 1000 then
    raise exception 'GEDCOM_IMPORT_ENTITY_BATCH_TOO_LARGE' using errcode = '22023';
  end if;

  select candidate.* into operation
  from private.gedcom_import_operations candidate
  where candidate.id = target_operation_id
  for update;

  if operation.id is null then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_FOUND' using errcode = '22023';
  end if;
  if operation.status <> 'preparing' then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_PREPARING' using errcode = '55000';
  end if;

  target_table := case target_entity_type
    when 'finding' then 'findings'
    when 'person_relation' then 'person_relations'
    when 'document' then 'documents'
    when 'person' then 'persons'
    else null
  end;
  execute format(
    'select exists (select 1 from public.%I where project_id = $1 and id = any($2))',
    target_table
  ) into already_exists using operation.project_id, target_entity_ids;
  if already_exists then
    raise exception 'GEDCOM_IMPORT_ENTITY_ALREADY_EXISTS'
      using errcode = '23505';
  end if;

  insert into private.gedcom_import_operation_entities (
    operation_id,
    project_id,
    entity_type,
    entity_id
  )
  select operation.id, operation.project_id, target_entity_type, candidate_id
  from unnest(coalesce(target_entity_ids, array[]::uuid[])) candidate_id
  where candidate_id is not null
  on conflict do nothing;
  get diagnostics inserted_count = row_count;

  update private.gedcom_import_operations
  set registered_rows = registered_rows + inserted_count,
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = operation.id;

  return private.gedcom_import_operation_payload(operation.id);
end;
$$;

create or replace function public.seal_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  update private.gedcom_import_operations
  set status = 'importing',
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = target_operation_id
    and status = 'preparing';

  if not found then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_PREPARING' using errcode = '55000';
  end if;
  return private.gedcom_import_operation_payload(target_operation_id);
end;
$$;

create or replace function public.touch_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  update private.gedcom_import_operations
  set heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = target_operation_id
    and status in ('preparing', 'importing');

  if not found then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_ACTIVE' using errcode = '55000';
  end if;

  return private.gedcom_import_operation_payload(target_operation_id);
end;
$$;

-- Direct REST upserts remain bounded browser requests. One AFTER STATEMENT
-- trigger checks the whole PostgREST batch through a transition table. This
-- gives an atomic operation-row lock without adding one SQL lookup per person
-- or finding.
create or replace function private.enforce_gedcom_import_write_fence()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  target_entity_type text := case tg_table_name
    when 'findings' then 'finding'
    when 'person_relations' then 'person_relation'
    when 'documents' then 'document'
    when 'persons' then 'person'
    else null
  end;
  operation_status text;
begin
  if target_entity_type is null then
    raise exception 'GEDCOM_IMPORT_FENCE_TABLE_INVALID' using errcode = '55000';
  end if;

  execute $query$
    select operation.status
    from private.gedcom_import_operations operation
    where exists (
      select 1
      from private.gedcom_import_operation_entities entity
      join gedcom_changed_rows changed
        on changed.project_id = entity.project_id
       and changed.id = entity.entity_id
      where entity.operation_id = operation.id
        and entity.entity_type = $1
    )
    order by operation.created_at desc
    limit 1
    for share of operation
  $query$
  into operation_status
  using target_entity_type;

  if operation_status is not null
     and operation_status not in ('importing', 'completed') then
    raise exception 'GEDCOM_IMPORT_OPERATION_FENCED'
      using errcode = '55000';
  end if;
  return null;
end;
$$;

revoke execute on function private.enforce_gedcom_import_write_fence()
  from public, anon, authenticated;

drop trigger if exists findings_gedcom_import_write_fence on public.findings;
drop trigger if exists findings_insert_gedcom_import_write_fence on public.findings;
drop trigger if exists findings_update_gedcom_import_write_fence on public.findings;
create trigger findings_insert_gedcom_import_write_fence
after insert on public.findings
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();
create trigger findings_update_gedcom_import_write_fence
after update on public.findings
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();

drop trigger if exists person_relations_gedcom_import_write_fence on public.person_relations;
drop trigger if exists person_relations_insert_gedcom_import_write_fence on public.person_relations;
drop trigger if exists person_relations_update_gedcom_import_write_fence on public.person_relations;
create trigger person_relations_insert_gedcom_import_write_fence
after insert on public.person_relations
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();
create trigger person_relations_update_gedcom_import_write_fence
after update on public.person_relations
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();

drop trigger if exists documents_gedcom_import_write_fence on public.documents;
drop trigger if exists documents_insert_gedcom_import_write_fence on public.documents;
drop trigger if exists documents_update_gedcom_import_write_fence on public.documents;
create trigger documents_insert_gedcom_import_write_fence
after insert on public.documents
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();
create trigger documents_update_gedcom_import_write_fence
after update on public.documents
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();

drop trigger if exists persons_gedcom_import_write_fence on public.persons;
drop trigger if exists persons_insert_gedcom_import_write_fence on public.persons;
drop trigger if exists persons_update_gedcom_import_write_fence on public.persons;
create trigger persons_insert_gedcom_import_write_fence
after insert on public.persons
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();
create trigger persons_update_gedcom_import_write_fence
after update on public.persons
referencing new table as gedcom_changed_rows
for each statement execute function private.enforce_gedcom_import_write_fence();

-- person_relations has an older AFTER ROW compatibility trigger that projects
-- every legacy relation into the default family-tree graph. GEDCOM relations
-- are persisted before their rollback-owned tree is created, so allowing that
-- trigger to run here would create a different default tree plus unjournaled
-- parent sets, family groups and graph edges. Apart from duplicating the later
-- explicit GEDCOM projection, those rows can keep imported people referenced
-- after a failed import.
--
-- Take a SHARE lock on the matching operation while each relation statement is
-- running. Completion/rollback therefore cannot race the predicate between the
-- row trigger and the statement-level write fence. The exact journal key keeps
-- ordinary edits (including relations in the same project) on the legacy sync
-- path. Completed imports use that path again for later manual edits.
create or replace function private.should_project_legacy_relation_to_family_graph(
  target_project_id uuid,
  target_relation_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  operation_status text;
begin
  select operation.status
  into operation_status
  from private.gedcom_import_operation_entities entity
  join private.gedcom_import_operations operation
    on operation.id = entity.operation_id
   and operation.project_id = entity.project_id
  where entity.project_id = target_project_id
    and entity.entity_type = 'person_relation'
    and entity.entity_id = target_relation_id
  order by operation.created_at desc
  limit 1
  for share of operation;

  return operation_status is null or operation_status = 'completed';
end;
$$;

revoke execute on function private.should_project_legacy_relation_to_family_graph(uuid, uuid)
  from public, anon;
grant execute on function private.should_project_legacy_relation_to_family_graph(uuid, uuid)
  to authenticated, service_role;

-- Preserve the existing DELETE trigger without a guard: it only removes graph
-- rows already mapped to the deleted relation. INSERT/UPDATE is where the
-- compatibility trigger can create an unowned graph, so only that trigger is
-- replaced with the exact import-journal predicate.
drop trigger if exists person_relations_family_graph_sync on public.person_relations;
create trigger person_relations_family_graph_sync
after insert or update of person_id, related_person_id, relation_type, status, evidence_text, notes
on public.person_relations
for each row
when (private.should_project_legacy_relation_to_family_graph(new.project_id, new.id))
execute function public.family_tree_sync_legacy_relation();

create or replace function public.register_gedcom_import_tree(
  target_operation_id uuid,
  target_tree_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  operation private.gedcom_import_operations%rowtype;
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select candidate.* into operation
  from private.gedcom_import_operations candidate
  where candidate.id = target_operation_id
  for update;

  if operation.id is null then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_FOUND' using errcode = '22023';
  end if;
  if operation.status <> 'importing' then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_IMPORTING' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.family_trees tree
    where tree.id = target_tree_id
      and tree.project_id = operation.project_id
      and tree.created_at >= operation.created_at
      and tree.created_by = operation.requested_by
      and tree.settings ->> 'source' = 'gedcom_import'
      and tree.settings ->> 'rollback_operation_id' = operation.id::text
  ) then
    raise exception 'GEDCOM_IMPORT_TREE_NOT_FOUND' using errcode = '22023';
  end if;

  insert into private.gedcom_import_operation_entities (
    operation_id,
    project_id,
    entity_type,
    entity_id
  ) values (
    operation.id,
    operation.project_id,
    'family_tree',
    target_tree_id
  )
  on conflict do nothing;

  if found then
    update private.gedcom_import_operations
    set registered_rows = registered_rows + 1,
        heartbeat_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = operation.id;
  end if;

  return private.gedcom_import_operation_payload(operation.id);
end;
$$;

create or replace function public.register_gedcom_import_archive(
  target_operation_id uuid,
  target_import_batch_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  operation private.gedcom_import_operations%rowtype;
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select candidate.* into operation
  from private.gedcom_import_operations candidate
  where candidate.id = target_operation_id
  for update;

  if operation.id is null then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_FOUND' using errcode = '22023';
  end if;
  if operation.status <> 'importing' then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_IMPORTING' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.gedcom_import_batches import_batch
    where import_batch.id = target_import_batch_id
      and import_batch.project_id = operation.project_id
      and import_batch.created_at >= operation.created_at
      and import_batch.created_by = operation.requested_by
      and import_batch.status = 'importing'
      and import_batch.raw_metadata ->> 'rollback_operation_id' = operation.id::text
  ) then
    raise exception 'GEDCOM_IMPORT_ARCHIVE_NOT_FOUND' using errcode = '22023';
  end if;

  insert into private.gedcom_import_operation_entities (
    operation_id,
    project_id,
    entity_type,
    entity_id
  ) values (
    operation.id,
    operation.project_id,
    'gedcom_import_batch',
    target_import_batch_id
  )
  on conflict do nothing;

  if found then
    update private.gedcom_import_operations
    set registered_rows = registered_rows + 1,
        heartbeat_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = operation.id;
  end if;

  return private.gedcom_import_operation_payload(operation.id);
end;
$$;

create or replace function public.complete_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_operation_id::text, 7342)
  );

  update private.gedcom_import_operations
  set status = 'completed',
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      completed_at = clock_timestamp()
  where id = target_operation_id
    and status = 'importing';

  if not found and not exists (
    select 1 from private.gedcom_import_operations operation
    where operation.id = target_operation_id
      and operation.status = 'completed'
  ) then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_IMPORTING' using errcode = '55000';
  end if;

  update public.family_trees tree
  set settings = tree.settings - 'rollback_operation_id'
  from private.gedcom_import_operation_entities entity
  where entity.operation_id = target_operation_id
    and entity.entity_type = 'family_tree'
    and tree.project_id = entity.project_id
    and tree.id = entity.entity_id;

  update public.gedcom_import_batches import_batch
  set raw_metadata = import_batch.raw_metadata - 'rollback_operation_id'
  from private.gedcom_import_operation_entities entity
  where entity.operation_id = target_operation_id
    and entity.entity_type = 'gedcom_import_batch'
    and import_batch.project_id = entity.project_id
    and import_batch.id = entity.entity_id;

  -- Remove only one cheap batch here. The scheduled worker clears the rest of
  -- a very large successful journal without turning completion into another
  -- timeout-prone 100k-row statement.
  delete from private.gedcom_import_operation_entities entity
  where entity.ctid in (
    select candidate.ctid
    from private.gedcom_import_operation_entities candidate
    where candidate.operation_id = target_operation_id
    order by candidate.entity_type, candidate.entity_id
    limit 500
  );

  return private.gedcom_import_operation_payload(target_operation_id);
end;
$$;

create or replace function private.delete_gedcom_archive_children_batch(
  target_project_id uuid,
  target_import_batch_ids uuid[],
  batch_size integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  deleted_count integer := 0;
begin
  delete from public.gedcom_xref_maps child
  where child.ctid in (
    select candidate.ctid
    from public.gedcom_xref_maps candidate
    where candidate.project_id = target_project_id
      and candidate.import_batch_id = any(target_import_batch_ids)
    order by candidate.id
    limit greatest(1, least(coalesce(batch_size, 250), 500))
  );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke execute on function private.delete_gedcom_archive_children_batch(uuid, uuid[], integer)
  from public, anon, authenticated;

-- Delete at most one bounded child-table page. Repeated worker calls drain
-- every tree-owned table before the parent row is removed, avoiding a single
-- huge ON DELETE CASCADE transaction.
create or replace function private.delete_gedcom_tree_children_batch(
  target_project_id uuid,
  target_tree_ids uuid[],
  batch_size integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 250), 500));
  deleted_count integer := 0;
begin
  delete from public.legacy_person_relation_graph_edges child
  where child.ctid in (
    select candidate.ctid from public.legacy_person_relation_graph_edges candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.family_tree_research_issues child
  where child.ctid in (
    select candidate.ctid from public.family_tree_research_issues candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.family_tree_merge_history child
  where child.ctid in (
    select candidate.ctid from public.family_tree_merge_history candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.gedcom_xref_maps child
  where child.ctid in (
    select candidate.ctid from public.gedcom_xref_maps candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.tree_layout_positions child
  where child.ctid in (
    select candidate.ctid from public.tree_layout_positions candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.association_relationships child
  where child.ctid in (
    select candidate.ctid from public.association_relationships candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.parent_child_relationships child
  where child.ctid in (
    select candidate.ctid from public.parent_child_relationships candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.parent_sets child
  where child.ctid in (
    select candidate.ctid from public.parent_sets candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.partner_relationships child
  where child.ctid in (
    select candidate.ctid from public.partner_relationships candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.family_group_members child
  where child.ctid in (
    select candidate.ctid
    from public.family_group_members candidate
    join public.family_groups family_group
      on family_group.project_id = candidate.project_id
     and family_group.id = candidate.family_group_id
    where candidate.project_id = target_project_id
      and family_group.tree_id = any(target_tree_ids)
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.family_groups child
  where child.ctid in (
    select candidate.ctid from public.family_groups candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  if deleted_count > 0 then return deleted_count; end if;

  delete from public.family_tree_persons child
  where child.ctid in (
    select candidate.ctid from public.family_tree_persons candidate
    where candidate.project_id = target_project_id
      and candidate.tree_id = any(target_tree_ids)
    order by candidate.person_id
    limit safe_batch_size
  );
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke execute on function private.delete_gedcom_tree_children_batch(uuid, uuid[], integer)
  from public, anon, authenticated;

create or replace function private.process_gedcom_import_rollback(
  target_operation_id uuid,
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  operation private.gedcom_import_operations%rowtype;
  safe_batch_size integer := greatest(1, least(coalesce(batch_size, 250), 500));
  current_entity_type text;
  current_table text;
  target_ids uuid[];
  journal_count integer := 0;
  recovered_count integer := 0;
  child_count integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_operation_id::text, 7342)
  );

  select candidate.* into operation
  from private.gedcom_import_operations candidate
  where candidate.id = target_operation_id
  for update;

  if operation.id is null then
    raise exception 'GEDCOM_IMPORT_OPERATION_NOT_FOUND' using errcode = '22023';
  end if;
  if operation.status = 'completed' then
    -- Completed data is never rolled back. Only discard its temporary journal
    -- in bounded batches so future imports do not retain bookkeeping rows.
    delete from private.gedcom_import_operation_entities entity
    where entity.ctid in (
      select candidate.ctid
      from private.gedcom_import_operation_entities candidate
      where candidate.operation_id = operation.id
      order by candidate.entity_type, candidate.entity_id
      limit safe_batch_size
    );
    return private.gedcom_import_operation_payload(operation.id);
  end if;
  if operation.status = 'rolled_back' then
    -- Keep processed journal rows briefly as write-fence tombstones. This
    -- blocks a browser request that was suspended while rollback began. The
    -- scheduled worker removes them later in bounded pages.
    if operation.completed_at < clock_timestamp() - interval '24 hours' then
      delete from private.gedcom_import_operation_entities entity
      where entity.ctid in (
        select candidate.ctid
        from private.gedcom_import_operation_entities candidate
        where candidate.operation_id = operation.id
        order by candidate.entity_type, candidate.entity_id
        limit safe_batch_size
      );
      if not exists (
        select 1 from private.gedcom_import_operation_entities entity
        where entity.operation_id = operation.id
      ) then
        delete from private.gedcom_import_operations finished
        where finished.id = operation.id;
        return null;
      end if;
    end if;
    return private.gedcom_import_operation_payload(operation.id);
  end if;

  update private.gedcom_import_operations
  set status = 'rolling_back',
      updated_at = clock_timestamp()
  where id = operation.id;

  -- Suppress graph-version churn for every cleanup statement, including the
  -- crash-window recovery below.
  perform pg_catalog.set_config('app.project_deletion', 'on', true);

  -- Cover the narrow create -> register crash window without guessing from
  -- the root person. Both rows carry the exact operation UUID from the insert
  -- payload, so retries rooted in a pre-existing person are recoverable too.
  insert into private.gedcom_import_operation_entities (
    operation_id, project_id, entity_type, entity_id
  )
  select operation.id, operation.project_id, 'family_tree', tree.id
  from public.family_trees tree
  where tree.project_id = operation.project_id
    and tree.created_at >= operation.created_at
    and tree.settings ->> 'source' = 'gedcom_import'
    and tree.settings ->> 'rollback_operation_id' = operation.id::text
  on conflict do nothing;
  get diagnostics recovered_count = row_count;

  insert into private.gedcom_import_operation_entities (
    operation_id, project_id, entity_type, entity_id
  )
  select operation.id, operation.project_id, 'gedcom_import_batch', import_batch.id
  from public.gedcom_import_batches import_batch
  where import_batch.project_id = operation.project_id
    and import_batch.created_at >= operation.created_at
    and import_batch.raw_metadata ->> 'rollback_operation_id' = operation.id::text
  on conflict do nothing;
  get diagnostics child_count = row_count;
  recovered_count := recovered_count + child_count;
  if recovered_count > 0 then
    update private.gedcom_import_operations
    set registered_rows = registered_rows + recovered_count,
        updated_at = clock_timestamp()
    where id = operation.id;
  end if;

  select entity.entity_type,
         array_agg(entity.entity_id order by entity.entity_id)
  into current_entity_type, target_ids
  from (
    select candidate.entity_type, candidate.entity_id
    from private.gedcom_import_operation_entities candidate
    where candidate.operation_id = operation.id
      and candidate.rolled_back_at is null
    order by case candidate.entity_type
      when 'gedcom_import_batch' then 1
      when 'family_tree' then 2
      when 'finding' then 3
      when 'person_relation' then 4
      when 'document' then 5
      when 'person' then 6
      else 99
    end, candidate.entity_id
    limit safe_batch_size
  ) entity
  group by entity.entity_type
  order by case entity.entity_type
    when 'gedcom_import_batch' then 1
    when 'family_tree' then 2
    when 'finding' then 3
    when 'person_relation' then 4
    when 'document' then 5
    when 'person' then 6
    else 99
  end
  limit 1;

  if coalesce(cardinality(target_ids), 0) = 0 then
    update private.gedcom_import_operations
    set status = 'rolled_back',
        heartbeat_at = clock_timestamp(),
        updated_at = clock_timestamp(),
        completed_at = clock_timestamp()
    where id = operation.id;
    return private.gedcom_import_operation_payload(operation.id);
  end if;

  current_table := case current_entity_type
    when 'gedcom_import_batch' then 'gedcom_import_batches'
    when 'family_tree' then 'family_trees'
    when 'finding' then 'findings'
    when 'person_relation' then 'person_relations'
    when 'document' then 'documents'
    when 'person' then 'persons'
    else null
  end;
  if current_table is null then
    raise exception 'GEDCOM_IMPORT_ENTITY_TYPE_INVALID' using errcode = '22023';
  end if;

  if current_entity_type = 'gedcom_import_batch' then
    child_count := private.delete_gedcom_archive_children_batch(
      operation.project_id,
      target_ids,
      safe_batch_size
    );
  elsif current_entity_type = 'family_tree' then
    child_count := private.delete_gedcom_tree_children_batch(
      operation.project_id,
      target_ids,
      safe_batch_size
    );
  else
    child_count := 0;
  end if;

  if child_count > 0 then
    update private.gedcom_import_operations
    set heartbeat_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = operation.id;
    return private.gedcom_import_operation_payload(operation.id);
  end if;

  execute format(
    'delete from public.%I where project_id = $1 and id = any($2)',
    current_table
  ) using operation.project_id, target_ids;

  if current_entity_type = 'family_tree' and not exists (
    select 1 from public.family_trees tree
    where tree.project_id = operation.project_id
      and tree.is_default
  ) then
    update public.family_trees tree
    set is_default = true
    where tree.id = (
      select fallback.id
      from public.family_trees fallback
      where fallback.project_id = operation.project_id
      order by fallback.created_at, fallback.id
      limit 1
    );
  end if;

  update private.gedcom_import_operation_entities entity
  set rolled_back_at = clock_timestamp()
  where entity.operation_id = operation.id
    and entity.entity_type = current_entity_type
    and entity.entity_id = any(target_ids)
    and entity.rolled_back_at is null;
  get diagnostics journal_count = row_count;

  update private.gedcom_import_operations
  set rolled_back_rows = rolled_back_rows + journal_count,
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = operation.id;

  if not exists (
    select 1 from private.gedcom_import_operation_entities entity
    where entity.operation_id = operation.id
      and entity.rolled_back_at is null
  ) then
    update private.gedcom_import_operations
    set status = 'rolled_back',
        completed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    where id = operation.id;
  end if;

  return private.gedcom_import_operation_payload(operation.id);
end;
$$;

revoke execute on function private.process_gedcom_import_rollback(uuid, integer)
  from public, anon, authenticated;

create or replace function public.rollback_gedcom_import_operation(
  target_operation_id uuid,
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if not private.can_manage_gedcom_import_operation(target_operation_id, auth.uid()) then
    raise exception 'GEDCOM_IMPORT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  return private.process_gedcom_import_rollback(target_operation_id, batch_size);
end;
$$;

-- Called by the scheduled service worker. It converts abandoned imports to a
-- resumable rollback after 15 minutes without a browser heartbeat and advances
-- one bounded batch per call.
create or replace function public.process_next_stale_gedcom_import_rollback(
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  target_operation_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  -- Completed operation headers have no recovery value after their journal
  -- has been drained. Retain seven days for diagnostics, then prune cheaply.
  delete from private.gedcom_import_operations finished
  where finished.ctid in (
    select candidate.ctid
    from private.gedcom_import_operations candidate
    where candidate.status = 'completed'
      and candidate.completed_at < clock_timestamp() - interval '7 days'
      and not exists (
        select 1 from private.gedcom_import_operation_entities entity
        where entity.operation_id = candidate.id
      )
    order by candidate.completed_at
    limit 50
  );

  select operation.id into target_operation_id
  from private.gedcom_import_operations operation
  where (
       operation.status = 'rolling_back'
    or (
      operation.status = 'rolled_back'
      and operation.completed_at < clock_timestamp() - interval '24 hours'
      and exists (
        select 1
        from private.gedcom_import_operation_entities rolled_back_entry
        where rolled_back_entry.operation_id = operation.id
      )
    )
    or (
      operation.status = 'completed'
      and exists (
        select 1
        from private.gedcom_import_operation_entities completed_entry
        where completed_entry.operation_id = operation.id
      )
    )
     or (
       operation.status in ('preparing', 'importing')
       and operation.heartbeat_at < clock_timestamp() - interval '15 minutes'
     )
  )
  order by case
             when operation.status = 'rolling_back' then 0
             when operation.status in ('preparing', 'importing') then 1
             when operation.status = 'rolled_back' then 2
             else 3
           end,
           operation.heartbeat_at,
           operation.created_at
  limit 1;

  if target_operation_id is null then
    return null;
  end if;
  return private.process_gedcom_import_rollback(target_operation_id, batch_size);
end;
$$;

revoke execute on function public.start_gedcom_import_operation(uuid, text),
  public.register_gedcom_import_entities(uuid, text, uuid[]),
  public.seal_gedcom_import_operation(uuid),
  public.touch_gedcom_import_operation(uuid),
  public.register_gedcom_import_tree(uuid, uuid),
  public.register_gedcom_import_archive(uuid, uuid),
  public.complete_gedcom_import_operation(uuid),
  public.rollback_gedcom_import_operation(uuid, integer),
  public.process_next_stale_gedcom_import_rollback(integer)
  from public, anon;

grant execute on function public.start_gedcom_import_operation(uuid, text),
  public.register_gedcom_import_entities(uuid, text, uuid[]),
  public.seal_gedcom_import_operation(uuid),
  public.touch_gedcom_import_operation(uuid),
  public.register_gedcom_import_tree(uuid, uuid),
  public.register_gedcom_import_archive(uuid, uuid),
  public.complete_gedcom_import_operation(uuid),
  public.rollback_gedcom_import_operation(uuid, integer)
  to authenticated;

revoke execute on function public.process_next_stale_gedcom_import_rollback(integer)
  from authenticated;
grant execute on function public.process_next_stale_gedcom_import_rollback(integer)
  to service_role;

commit;
