begin;

-- Root-person management for the production family-tree UI. Root changes and
-- root-person deletion are executed in one database transaction so a tree can
-- never be left with a deleted or temporarily missing root.

create or replace function security_private.list_project_person_root_requirements(
  target_project_id uuid,
  target_person_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $$
declare
  normalized_person_ids uuid[];
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

  select coalesce(array_agg(person_id order by person_id), array[]::uuid[])
  into normalized_person_ids
  from (
    select distinct requested.person_id
    from unnest(coalesce(target_person_ids, array[]::uuid[])) requested(person_id)
    where requested.person_id is not null
  ) normalized;

  if cardinality(normalized_person_ids) > 1000 then
    raise exception 'PERSON_DELETE_BATCH_TOO_LARGE' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'treeId', tree.id,
        'treeTitle', tree.title,
        'rootPersonId', tree.root_person_id,
        'remainingMemberCount', (
          select count(*)
          from public.family_tree_persons member
          where member.project_id = target_project_id
            and member.tree_id = tree.id
            and not (member.person_id = any(normalized_person_ids))
        ),
        'requiresReplacement', exists (
          select 1
          from public.family_tree_persons member
          where member.project_id = target_project_id
            and member.tree_id = tree.id
            and not (member.person_id = any(normalized_person_ids))
        )
      )
      order by tree.is_default desc, tree.created_at, tree.id
    )
    from public.family_trees tree
    where tree.project_id = target_project_id
      and tree.root_person_id = any(normalized_person_ids)
  ), '[]'::jsonb);
end;
$$;

create or replace function security_private.set_family_tree_root(
  target_project_id uuid,
  target_tree_id uuid,
  target_person_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, security_private, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null or target_tree_id is null or target_person_id is null then
    raise exception 'TREE_ROOT_ARGUMENT_REQUIRED' using errcode = '22023';
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

  if not exists (
    select 1
    from public.family_trees tree
    where tree.project_id = target_project_id
      and tree.id = target_tree_id
  ) then
    raise exception 'FAMILY_TREE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not exists (
    select 1
    from public.persons person
    where person.project_id = target_project_id
      and person.id = target_person_id
  ) then
    raise exception 'ROOT_PERSON_NOT_IN_PROJECT' using errcode = 'P0002';
  end if;

  update public.family_tree_persons member
  set member_role = 'member'
  where member.project_id = target_project_id
    and member.tree_id = target_tree_id
    and member.member_role = 'root'
    and member.person_id <> target_person_id;

  insert into public.family_tree_persons (
    project_id,
    tree_id,
    person_id,
    member_role,
    display_order
  ) values (
    target_project_id,
    target_tree_id,
    target_person_id,
    'root',
    0
  )
  on conflict (tree_id, person_id) do update
  set member_role = 'root';

  update public.family_trees tree
  set root_person_id = target_person_id,
      updated_at = now()
  where tree.project_id = target_project_id
    and tree.id = target_tree_id;

  return jsonb_build_object(
    'treeId', target_tree_id,
    'rootPersonId', target_person_id
  );
end;
$$;

create or replace function security_private.replace_tree_roots_and_delete_project_persons(
  target_project_id uuid,
  target_person_ids uuid[],
  root_replacements jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, security_private, pg_temp
as $$
declare
  normalized_person_ids uuid[];
  requested_person_count integer := 0;
  affected_tree record;
  replacement_text text;
  replacement_person_id uuid;
  deletion_result jsonb;
  replaced_root_count integer := 0;
  deleted_tree_count integer := 0;
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
  if jsonb_typeof(coalesce(root_replacements, '{}'::jsonb)) <> 'object' then
    raise exception 'ROOT_REPLACEMENTS_INVALID' using errcode = '22023';
  end if;

  select coalesce(array_agg(person_id order by person_id), array[]::uuid[])
  into normalized_person_ids
  from (
    select distinct requested.person_id
    from unnest(coalesce(target_person_ids, array[]::uuid[])) requested(person_id)
    where requested.person_id is not null
  ) normalized;
  requested_person_count := cardinality(normalized_person_ids);

  if requested_person_count = 0 then
    return jsonb_build_object(
      'deletedPersons', 0,
      'deletedRelations', 0,
      'deletedFindings', 0,
      'replacedRoots', 0,
      'deletedTrees', 0
    );
  end if;
  if requested_person_count > 1000 then
    raise exception 'PERSON_DELETE_BATCH_TOO_LARGE' using errcode = '22023';
  end if;
  if (
    select count(*)
    from public.persons person
    where person.project_id = target_project_id
      and person.id = any(normalized_person_ids)
  ) <> requested_person_count then
    raise exception 'PERSON_DELETE_TARGET_MISMATCH' using errcode = 'P0002';
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

  for affected_tree in
    select
      tree.id,
      tree.title,
      (
        select count(*)
        from public.family_tree_persons member
        where member.project_id = target_project_id
          and member.tree_id = tree.id
          and not (member.person_id = any(normalized_person_ids))
      )::integer as remaining_member_count
    from public.family_trees tree
    where tree.project_id = target_project_id
      and tree.root_person_id = any(normalized_person_ids)
    order by tree.id
    for update
  loop
    if affected_tree.remaining_member_count = 0 then
      delete from public.family_trees tree
      where tree.project_id = target_project_id
        and tree.id = affected_tree.id;
      deleted_tree_count := deleted_tree_count + 1;
      continue;
    end if;

    replacement_text := nullif(trim(coalesce(
      root_replacements ->> affected_tree.id::text,
      ''
    )), '');
    if replacement_text is null then
      raise exception 'ROOT_REPLACEMENT_REQUIRED:%', affected_tree.id
        using errcode = '55000',
              hint = 'Choose a replacement root for every surviving tree.';
    end if;

    begin
      replacement_person_id := replacement_text::uuid;
    exception when invalid_text_representation then
      raise exception 'ROOT_REPLACEMENT_INVALID:%', affected_tree.id
        using errcode = '22023';
    end;

    if replacement_person_id = any(normalized_person_ids) then
      raise exception 'ROOT_REPLACEMENT_IS_BEING_DELETED:%', affected_tree.id
        using errcode = '22023';
    end if;
    if not exists (
      select 1
      from public.persons person
      where person.project_id = target_project_id
        and person.id = replacement_person_id
    ) then
      raise exception 'ROOT_REPLACEMENT_NOT_IN_PROJECT:%', affected_tree.id
        using errcode = 'P0002';
    end if;

    update public.family_tree_persons member
    set member_role = 'member'
    where member.project_id = target_project_id
      and member.tree_id = affected_tree.id
      and member.member_role = 'root'
      and member.person_id <> replacement_person_id;

    insert into public.family_tree_persons (
      project_id,
      tree_id,
      person_id,
      member_role,
      display_order
    ) values (
      target_project_id,
      affected_tree.id,
      replacement_person_id,
      'root',
      0
    )
    on conflict (tree_id, person_id) do update
    set member_role = 'root';

    update public.family_trees tree
    set root_person_id = replacement_person_id,
        updated_at = now()
    where tree.project_id = target_project_id
      and tree.id = affected_tree.id;

    replaced_root_count := replaced_root_count + 1;
  end loop;

  deletion_result := private.delete_project_person_ids(
    target_project_id,
    normalized_person_ids,
    ''
  );

  return deletion_result || jsonb_build_object(
    'replacedRoots', replaced_root_count,
    'deletedTrees', deleted_tree_count
  );
end;
$$;

revoke all on function
  security_private.list_project_person_root_requirements(uuid, uuid[]),
  security_private.set_family_tree_root(uuid, uuid, uuid),
  security_private.replace_tree_roots_and_delete_project_persons(uuid, uuid[], jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.list_project_person_root_requirements(uuid, uuid[]),
  security_private.set_family_tree_root(uuid, uuid, uuid),
  security_private.replace_tree_roots_and_delete_project_persons(uuid, uuid[], jsonb)
  to authenticated, service_role;

create or replace function public.list_project_person_root_requirements(
  target_project_id uuid,
  target_person_ids uuid[]
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_project_person_root_requirements($1, $2);
$wrapper$;

create or replace function public.set_family_tree_root(
  target_project_id uuid,
  target_tree_id uuid,
  target_person_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.set_family_tree_root($1, $2, $3);
$wrapper$;

create or replace function public.replace_tree_roots_and_delete_project_persons(
  target_project_id uuid,
  target_person_ids uuid[],
  root_replacements jsonb default '{}'::jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.replace_tree_roots_and_delete_project_persons($1, $2, $3);
$wrapper$;

revoke all on function
  public.list_project_person_root_requirements(uuid, uuid[]),
  public.set_family_tree_root(uuid, uuid, uuid),
  public.replace_tree_roots_and_delete_project_persons(uuid, uuid[], jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.list_project_person_root_requirements(uuid, uuid[]),
  public.set_family_tree_root(uuid, uuid, uuid),
  public.replace_tree_roots_and_delete_project_persons(uuid, uuid[], jsonb)
  to authenticated, service_role;

commit;
