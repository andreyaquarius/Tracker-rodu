begin;

alter table public.person_relations
  add column if not exists import_source_key text not null default '',
  add column if not exists gedcom_metadata jsonb not null default '{}'::jsonb;

create index if not exists person_relations_project_import_source_idx
  on public.person_relations (project_id, import_source_key)
  where import_source_key <> '';

-- A completed import needs a durable dataset marker even when every INDI was
-- reconciled to an already existing person and produced no new person row.
create table if not exists private.gedcom_import_datasets (
  project_id uuid primary key references public.projects(id) on delete cascade,
  source_key text not null,
  operation_id uuid unique
    references private.gedcom_import_operations(id) on delete set null,
  created_by uuid references public.profiles(user_id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, source_key)
);

revoke all on table private.gedcom_import_datasets
  from public, anon, authenticated, service_role;

create or replace function private.capture_completed_gedcom_import_dataset()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if new.status <> 'completed' or old.status = 'completed' then
    return new;
  end if;

  if exists (
    select 1
    from private.gedcom_import_datasets dataset
    where dataset.project_id = new.project_id
      and dataset.source_key <> new.source_key
  ) then
    raise exception 'GEDCOM_IMPORT_ALREADY_EXISTS' using errcode = '55000';
  end if;

  insert into private.gedcom_import_datasets (
    project_id,
    source_key,
    operation_id,
    created_by,
    created_at
  ) values (
    new.project_id,
    new.source_key,
    new.id,
    new.requested_by,
    coalesce(new.completed_at, now())
  )
  on conflict (project_id) do update
  set operation_id = excluded.operation_id,
      created_by = excluded.created_by,
      created_at = excluded.created_at;

  return new;
end;
$$;

revoke execute on function private.capture_completed_gedcom_import_dataset()
  from public, anon, authenticated, service_role;

drop trigger if exists gedcom_import_operations_capture_dataset
  on private.gedcom_import_operations;
create trigger gedcom_import_operations_capture_dataset
after update of status on private.gedcom_import_operations
for each row
execute function private.capture_completed_gedcom_import_dataset();

-- Backfill the latest still-retained successful operation. Older projects are
-- additionally discovered from entity provenance below and become durable on
-- their next successful import.
insert into private.gedcom_import_datasets (
  project_id,
  source_key,
  operation_id,
  created_by,
  created_at
)
select distinct on (operation.project_id)
  operation.project_id,
  operation.source_key,
  operation.id,
  operation.requested_by,
  coalesce(operation.completed_at, operation.updated_at, operation.created_at)
from private.gedcom_import_operations operation
where operation.status = 'completed'
  and nullif(trim(operation.source_key), '') is not null
order by operation.project_id, operation.completed_at desc nulls last, operation.created_at desc
on conflict (project_id) do nothing;

-- Person removal touches FK-backed links, polymorphic links and GEDCOM archive
-- metadata. Keep it in one transaction so the client can never restore a row
-- that the database has already removed only partially.
create or replace function private.delete_project_person_ids(
  target_project_id uuid,
  requested_person_ids uuid[],
  target_import_source_key text default ''
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  target_person_ids uuid[];
  target_relation_ids uuid[];
  target_finding_ids uuid[];
  target_tree_ids uuid[];
  target_import_batch_ids uuid[];
  deleted_person_count integer := 0;
  deleted_relation_count integer := 0;
  deleted_finding_count integer := 0;
  requested_person_count integer := 0;
begin
  select count(distinct requested_id)::integer
  into requested_person_count
  from unnest(coalesce(requested_person_ids, array[]::uuid[])) requested(requested_id);

  select coalesce(array_agg(person.id order by person.id), array[]::uuid[])
  into target_person_ids
  from public.persons person
  where person.project_id = target_project_id
    and person.id = any(coalesce(requested_person_ids, array[]::uuid[]));

  if cardinality(target_person_ids) = 0 then
    if requested_person_count > 0 then
      raise exception 'PERSON_DELETE_TARGET_MISMATCH' using errcode = 'P0002';
    end if;
    if nullif(trim(coalesce(target_import_source_key, '')), '') is null then
      return jsonb_build_object(
        'deletedPersons', 0,
        'deletedRelations', 0,
        'deletedFindings', 0
      );
    end if;
  end if;

  if cardinality(target_person_ids) <> requested_person_count then
    raise exception 'PERSON_DELETE_TARGET_MISMATCH' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(relation.id order by relation.id), array[]::uuid[])
  into target_relation_ids
  from public.person_relations relation
  where relation.project_id = target_project_id
    and (
      relation.person_id = any(target_person_ids)
      or relation.related_person_id = any(target_person_ids)
      or (
        nullif(trim(coalesce(target_import_source_key, '')), '') is not null
        and relation.import_source_key = trim(target_import_source_key)
      )
    );
  deleted_relation_count := cardinality(target_relation_ids);

  select coalesce(array_agg(finding.id order by finding.id), array[]::uuid[])
  into target_finding_ids
  from public.findings finding
  where finding.project_id = target_project_id
    and nullif(trim(coalesce(target_import_source_key, '')), '') is not null
    and finding.custom_fields ->> '__gedcomImportSourceKey' = trim(target_import_source_key);

  -- Remove a GEDCOM-created tree only when every one of its current members
  -- belongs to the selected imported group. A tree later expanded manually is
  -- preserved and its person references are handled by FK actions instead.
  select coalesce(array_agg(tree.id order by tree.id), array[]::uuid[])
  into target_tree_ids
  from public.family_trees tree
  where tree.project_id = target_project_id
    and nullif(trim(coalesce(target_import_source_key, '')), '') is not null
    and tree.settings ->> 'source' = 'gedcom_import'
    and (
      (
        nullif(trim(coalesce(target_import_source_key, '')), '') is not null
        and tree.settings ->> 'import_source_key' = trim(target_import_source_key)
      )
      or (
        exists (
          select 1
          from public.family_tree_persons member
          where member.project_id = target_project_id
            and member.tree_id = tree.id
            and member.person_id = any(target_person_ids)
        )
        and not exists (
          select 1
          from public.family_tree_persons member
          where member.project_id = target_project_id
            and member.tree_id = tree.id
            and not (member.person_id = any(target_person_ids))
        )
      )
    )
    and not exists (
      select 1
      from public.family_tree_persons member
      where member.project_id = target_project_id
        and member.tree_id = tree.id
        and not (member.person_id = any(target_person_ids))
    );

  select coalesce(array_agg(batch.id order by batch.id), array[]::uuid[])
  into target_import_batch_ids
  from public.gedcom_import_batches batch
  where batch.project_id = target_project_id
    and (
      batch.tree_id = any(target_tree_ids)
      or (
        exists (
          select 1
          from public.gedcom_xref_maps xref
          where xref.project_id = target_project_id
            and xref.import_batch_id = batch.id
            and lower(xref.internal_table) in ('person', 'persons')
            and xref.internal_id = any(target_person_ids)
        )
        and not exists (
          select 1
          from public.gedcom_xref_maps xref
          where xref.project_id = target_project_id
            and xref.import_batch_id = batch.id
            and lower(xref.internal_table) in ('person', 'persons')
            and not (xref.internal_id = any(target_person_ids))
        )
      )
    );

  if exists (
    select 1
    from public.family_trees tree
    where tree.project_id = target_project_id
      and tree.root_person_id = any(target_person_ids)
      and not (tree.id = any(target_tree_ids))
  ) then
    raise exception 'PERSON_IS_TREE_ROOT' using errcode = '55000',
      hint = 'Choose another root person or delete the owning tree first.';
  end if;

  -- The finding junction rows cascade, but the legacy metadata array is also
  -- read by summaries and the UI. Keep both representations consistent.
  update public.findings finding
  set custom_fields = jsonb_set(
    finding.custom_fields,
    '{__trackerRoduFindingMeta,personIds}',
    coalesce((
      select jsonb_agg(person_id.value)
      from jsonb_array_elements_text(
        finding.custom_fields #> '{__trackerRoduFindingMeta,personIds}'
      ) person_id(value)
      where not (person_id.value = any(target_person_ids::text[]))
    ), '[]'::jsonb),
    true
  )
  where finding.project_id = target_project_id
    and not (finding.id = any(target_finding_ids))
    and jsonb_typeof(
      finding.custom_fields #> '{__trackerRoduFindingMeta,personIds}'
    ) = 'array'
    and exists (
      select 1
      from jsonb_array_elements_text(
        finding.custom_fields #> '{__trackerRoduFindingMeta,personIds}'
      ) person_id(value)
      where person_id.value = any(target_person_ids::text[])
    );

  delete from public.hypothesis_links link
  where link.project_id = target_project_id
    and (
      (link.target_type = 'person' and link.target_id = any(target_person_ids))
      or (link.target_type = 'finding' and link.target_id = any(target_finding_ids))
    );

  delete from public.record_links link
  where link.project_id = target_project_id
    and (
      (lower(link.source_type) in ('person', 'persons') and link.source_id = any(target_person_ids))
      or (lower(link.target_type) in ('person', 'persons') and link.target_id = any(target_person_ids))
      or (lower(link.source_type) in ('finding', 'findings') and link.source_id = any(target_finding_ids))
      or (lower(link.target_type) in ('finding', 'findings') and link.target_id = any(target_finding_ids))
    );

  delete from public.attachments attachment
  where attachment.project_id = target_project_id
    and (
      (lower(attachment.owner_type) in ('person', 'persons') and attachment.owner_id = any(target_person_ids))
      or (lower(attachment.owner_type) in ('finding', 'findings') and attachment.owner_id = any(target_finding_ids))
    );

  delete from public.gedcom_xref_maps xref
  where xref.project_id = target_project_id
    and (
      (lower(xref.internal_table) in ('person', 'persons') and xref.internal_id = any(target_person_ids))
      or (lower(xref.internal_table) in ('finding', 'findings') and xref.internal_id = any(target_finding_ids))
    );

  -- A completed rollback journal is diagnostic metadata. Remove entries for
  -- explicitly deleted entities so a later maintenance pass cannot report
  -- them as still owned by the import.
  delete from private.gedcom_import_operation_entities entity
  where entity.project_id = target_project_id
    and (
      (entity.entity_type = 'person' and entity.entity_id = any(target_person_ids))
      or (entity.entity_type = 'person_relation' and entity.entity_id = any(target_relation_ids))
      or (entity.entity_type = 'finding' and entity.entity_id = any(target_finding_ids))
      or (entity.entity_type = 'family_tree' and entity.entity_id = any(target_tree_ids))
      or (entity.entity_type = 'gedcom_import_batch' and entity.entity_id = any(target_import_batch_ids))
    );

  delete from public.gedcom_import_batches batch
  where batch.project_id = target_project_id
    and batch.id = any(target_import_batch_ids);

  delete from public.family_trees tree
  where tree.project_id = target_project_id
    and tree.id = any(target_tree_ids);

  delete from public.person_relations relation
  where relation.project_id = target_project_id
    and relation.id = any(target_relation_ids);

  delete from public.findings finding
  where finding.project_id = target_project_id
    and finding.id = any(target_finding_ids);
  get diagnostics deleted_finding_count = row_count;

  delete from public.persons person
  where person.project_id = target_project_id
    and person.id = any(target_person_ids);
  get diagnostics deleted_person_count = row_count;

  if not exists (
    select 1
    from public.family_trees tree
    where tree.project_id = target_project_id
      and tree.is_default
  ) then
    update public.family_trees tree
    set is_default = true
    where tree.id = (
      select fallback.id
      from public.family_trees fallback
      where fallback.project_id = target_project_id
      order by fallback.created_at, fallback.id
      limit 1
    );
  end if;

  insert into public.activity_log (
    project_id,
    actor_id,
    action,
    entity_type,
    entity_id,
    details
  ) values (
    target_project_id,
    auth.uid(),
    case when deleted_person_count = 1 then 'person_deleted' else 'persons_bulk_deleted' end,
    'persons',
    case when deleted_person_count = 1 then target_person_ids[1] else null end,
    jsonb_build_object(
      'personCount', deleted_person_count,
      'relationCount', deleted_relation_count,
      'findingCount', deleted_finding_count,
      'importSourceKey', nullif(trim(coalesce(target_import_source_key, '')), '')
    )
  );

  return jsonb_build_object(
    'deletedPersons', deleted_person_count,
    'deletedRelations', deleted_relation_count,
    'deletedFindings', deleted_finding_count
  );
end;
$$;

revoke execute on function private.delete_project_person_ids(uuid, uuid[], text)
  from public, anon, authenticated;

create or replace function security_private.delete_project_persons(
  target_project_id uuid,
  target_person_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not security_private.can_edit_project(target_project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if coalesce(cardinality(target_person_ids), 0) > 1000 then
    raise exception 'PERSON_DELETE_BATCH_TOO_LARGE' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7341)
  );

  if exists (
    select 1
    from private.gedcom_import_operations operation
    where operation.project_id = target_project_id
      and operation.status in ('preparing', 'importing', 'rolling_back')
  ) then
    raise exception 'PROJECT_GEDCOM_OPERATION_ACTIVE' using errcode = '55000';
  end if;

  return private.delete_project_person_ids(target_project_id, target_person_ids, '');
end;
$$;

create or replace function security_private.delete_project_gedcom_persons(
  target_project_id uuid,
  target_source_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  normalized_source_key text := left(trim(coalesce(target_source_key, '')), 500);
  target_person_ids uuid[];
  deletion_result jsonb;
begin
  if auth.uid() is null then
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 7341)
  );

  if exists (
    select 1
    from private.gedcom_import_operations operation
    where operation.project_id = target_project_id
      and operation.status in ('preparing', 'importing', 'rolling_back')
  ) then
    raise exception 'PROJECT_GEDCOM_OPERATION_ACTIVE' using errcode = '55000';
  end if;

  select coalesce(array_agg(person.id order by person.id), array[]::uuid[])
  into target_person_ids
  from public.persons person
  where person.project_id = target_project_id
    and person.custom_fields ->> '__gedcomImportSourceKey' = normalized_source_key;

  deletion_result := private.delete_project_person_ids(
    target_project_id,
    target_person_ids,
    normalized_source_key
  );

  delete from private.gedcom_import_datasets dataset
  where dataset.project_id = target_project_id
    and dataset.source_key = normalized_source_key;

  return deletion_result;
end;
$$;

create or replace function security_private.list_project_gedcom_import_datasets(
  target_project_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, security_private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null then
    raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023';
  end if;
  if not security_private.is_project_member(target_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'sourceKey', dataset.source_key,
        'importedAt', dataset.created_at
      )
      order by dataset.created_at desc
    )
    from private.gedcom_import_datasets dataset
    where dataset.project_id = target_project_id
  ), '[]'::jsonb);
end;
$$;

-- A project intentionally owns at most one imported GEDCOM dataset. Existing
-- legacy projects with two datasets can use delete_project_gedcom_persons to
-- remove one group before a new import is accepted.
create or replace function security_private.start_gedcom_import_operation(
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
  if not security_private.can_edit_project(target_project_id) then
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

  if exists (
    select 1
    from private.gedcom_import_datasets dataset
    where dataset.project_id = target_project_id

    union all

    select 1
    from public.persons person
    where person.project_id = target_project_id
      and nullif(trim(person.custom_fields ->> '__gedcomImportSourceKey'), '') is not null

    union all

    select 1
    from public.person_relations relation
    where relation.project_id = target_project_id
      and nullif(trim(relation.import_source_key), '') is not null

    union all

    select 1
    from public.findings finding
    where finding.project_id = target_project_id
      and nullif(trim(finding.custom_fields ->> '__gedcomImportSourceKey'), '') is not null
  ) then
    raise exception 'GEDCOM_IMPORT_ALREADY_EXISTS'
      using errcode = '55000',
            hint = 'Delete the existing GEDCOM group before importing another file.';
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

revoke all on function
  security_private.delete_project_persons(uuid, uuid[]),
  security_private.delete_project_gedcom_persons(uuid, text),
  security_private.list_project_gedcom_import_datasets(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.delete_project_persons(uuid, uuid[]),
  security_private.delete_project_gedcom_persons(uuid, text),
  security_private.list_project_gedcom_import_datasets(uuid)
  to authenticated, service_role;

-- Expose only SECURITY INVOKER facades through PostgREST. The elevated
-- implementations stay in the non-exposed security_private schema, matching
-- the Security Advisor isolation used by the rest of the application.
create or replace function public.delete_project_persons(
  target_project_id uuid,
  target_person_ids uuid[]
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.delete_project_persons($1, $2);
$wrapper$;

create or replace function public.delete_project_gedcom_persons(
  target_project_id uuid,
  target_source_key text
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.delete_project_gedcom_persons($1, $2);
$wrapper$;

create or replace function public.list_project_gedcom_import_datasets(
  target_project_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_project_gedcom_import_datasets($1);
$wrapper$;

revoke all on function
  public.delete_project_persons(uuid, uuid[]),
  public.delete_project_gedcom_persons(uuid, text),
  public.list_project_gedcom_import_datasets(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.delete_project_persons(uuid, uuid[]),
  public.delete_project_gedcom_persons(uuid, text),
  public.list_project_gedcom_import_datasets(uuid)
  to authenticated, service_role;

-- Preserve the existing hardened implementation/facade ACLs after replacing
-- the GEDCOM guard.
revoke all on function security_private.start_gedcom_import_operation(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.start_gedcom_import_operation(uuid, text)
  to authenticated, service_role;

commit;
