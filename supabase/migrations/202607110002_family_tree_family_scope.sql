begin;

-- Stage 1 of the family-corridor API is additive.  The existing
-- get_family_tree_neighborhood_v1(jsonb) contract is intentionally left
-- unchanged so the renderer can be rolled back without a database rollback.
--
-- Family scope identity rules:
--   family-group:<uuid>       a persisted group wins only for parent sets
--                             compatible with its canonical parent identity;
--   parents:<uuid>,<uuid>...  otherwise, two or more sorted parent ids;
--   parent-set:<uuid>         zero/one-parent sets stay distinct because two
--                             unknown partners cannot safely be conflated.

create index if not exists parent_child_relationships_tree_parent_scope_idx
  on public.parent_child_relationships (
    tree_id,
    parent_id,
    parent_set_id,
    child_id
  )
  where evidence_status <> 'disproven';

create index if not exists parent_child_relationships_tree_set_scope_idx
  on public.parent_child_relationships (
    tree_id,
    parent_set_id,
    child_id,
    parent_id
  )
  where evidence_status <> 'disproven';

create index if not exists parent_child_relationships_tree_family_group_scope_idx
  on public.parent_child_relationships (
    tree_id,
    family_group_id,
    parent_set_id,
    child_id,
    parent_id
  )
  where family_group_id is not null
    and evidence_status <> 'disproven';

create index if not exists parent_sets_tree_family_group_child_idx
  on public.parent_sets (tree_id, family_group_id, child_id, id);

-- Internal helper retained for contract tests and diagnostics.  It observes
-- the same relationship visibility boundary as the neighborhood RPC.  The
-- returned value is an opaque identity, not a display label.
create or replace function public.family_tree_parent_set_scope_id_v1(
  target_tree_id uuid,
  target_parent_set_id uuid
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with target_set as (
    select
      parent_set.id,
      parent_set.project_id,
      parent_set.family_group_id
    from public.parent_sets parent_set
    where parent_set.tree_id = target_tree_id
      and parent_set.id = target_parent_set_id
      and public.is_project_member(parent_set.project_id)
  ), target_relations as (
    select relation.*
    from target_set
    join public.parent_child_relationships relation
      on relation.tree_id = target_tree_id
     and relation.parent_set_id = target_set.id
    join public.family_tree_persons parent_member
      on parent_member.tree_id = target_tree_id
     and parent_member.person_id = relation.parent_id
     and parent_member.member_role <> 'hidden'
    where relation.evidence_status <> 'disproven'
      and (
        relation.privacy_status <> 'confidential'
        or public.can_edit_project(relation.project_id)
      )
  ), parent_list as (
    select array_agg(distinct parent_id order by parent_id) as parent_ids
    from target_relations
  ), group_set_rows as (
    select
      parent_set.id,
      array_agg(distinct relation.parent_id order by relation.parent_id)
        as parent_ids
    from target_set
    join public.parent_sets parent_set
      on parent_set.tree_id = target_tree_id
     and target_set.family_group_id is not null
     and (
       parent_set.family_group_id = target_set.family_group_id
       or exists (
         select 1
         from public.parent_child_relationships group_relation
         where group_relation.tree_id = target_tree_id
           and group_relation.parent_set_id = parent_set.id
           and group_relation.family_group_id = target_set.family_group_id
           and group_relation.evidence_status <> 'disproven'
       )
     )
    join public.parent_child_relationships relation
      on relation.tree_id = target_tree_id
     and relation.parent_set_id = parent_set.id
     and relation.evidence_status <> 'disproven'
    join public.family_tree_persons parent_member
      on parent_member.tree_id = target_tree_id
     and parent_member.person_id = relation.parent_id
     and parent_member.member_role <> 'hidden'
    join public.family_tree_persons child_member
      on child_member.tree_id = target_tree_id
     and child_member.person_id = relation.child_id
     and child_member.member_role <> 'hidden'
    where relation.privacy_status <> 'confidential'
       or public.can_edit_project(relation.project_id)
    group by parent_set.id
  ), signature_counts as (
    select parent_ids, count(*)::integer as signature_count
    from group_set_rows
    group by parent_ids
  ), dominant_signature as (
    select parent_ids
    from signature_counts
    order by
      cardinality(parent_ids) desc,
      signature_count desc,
      array_to_string(parent_ids, ',')
    limit 1
  ), group_identity as (
    select case
      when cardinality(primary_parents.parent_ids) >= 2
        then primary_parents.parent_ids
      else dominant_signature.parent_ids
    end as parent_ids
    from target_set
    left join public.family_groups family_group
      on family_group.id = target_set.family_group_id
     and family_group.tree_id = target_tree_id
    left join lateral (
      select coalesce(array_agg(parent_id order by parent_id), '{}'::uuid[])
        as parent_ids
      from (
        select distinct parent_id
        from unnest(array[
          family_group.primary_partner_1_id,
          family_group.primary_partner_2_id
        ]) parent_row(parent_id)
        where parent_id is not null
      ) canonical_parent
    ) primary_parents on true
    left join dominant_signature on true
  )
  select case
    when target_set.family_group_id is not null
      and coalesce(parent_list.parent_ids, '{}'::uuid[])
        <@ coalesce(group_identity.parent_ids, '{}'::uuid[])
      then 'family-group:' || target_set.family_group_id::text
    when cardinality(coalesce(parent_list.parent_ids, '{}'::uuid[])) >= 2
      then 'parents:' || array_to_string(parent_list.parent_ids, ',')
    else 'parent-set:' || target_set.id::text
  end
  from target_set
  cross join parent_list
  left join group_identity on true;
$$;

revoke execute on function public.family_tree_parent_set_scope_id_v1(uuid, uuid)
  from public, anon, authenticated;

-- Request:
-- {
--   "treeId": uuid,
--   "scope": {
--     "id": "family-group:<uuid>" | "parents:<sorted uuids>" |
--           "parent-set:<uuid>",
--     "parentIds": uuid[],
--     "unionIds"?: string[],
--     "familyGroupId"?: uuid
--   },
--   "cursor"?: opaque-string,
--   "pageSize"?: 1..200,
--   "knownGraphVersion"?: bigint-as-string,
--   "permissionFingerprint"?: string
-- }
--
-- Response is a mergeable graph page:
-- {
--   persons, unions, parentChildRelations, continuations: [],
--   familyContinuations: [{id, scope, token, hiddenCount}] | [],
--   nextCursor?: opaque-string,
--   scope, graphVersion, permissionFingerprint
-- }
-- familyContinuations is authoritative for the requested scope: [] means the
-- stale continuation for that scope must be removed by the client.
create or replace function public.get_family_tree_family_children_v1(
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $$
declare
  requested_tree_id uuid;
  requested_scope jsonb;
  requested_scope_id text;
  requested_parent_ids uuid[];
  requested_family_group_id uuid;
  requested_parent_set_id uuid;
  requested_page_size integer;
  requested_cursor text;
  cursor_payload jsonb;
  cursor_birth_missing boolean := false;
  cursor_birth_sort text := '';
  cursor_child_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  cursor_excluded_child_ids uuid[] := '{}'::uuid[];
  cursor_excluded_child_digest text;
  current_project_id uuid;
  current_graph_version bigint;
  project_member_role text;
  can_view_private boolean;
  permission_fingerprint text;
  actual_parent_ids uuid[];
  actual_family_group_id uuid;
  actual_union_ids text[];
  returned_count integer;
  remaining_count integer;
  next_cursor text;
  next_birth_missing boolean;
  next_birth_sort text;
  next_child_id uuid;
  scope_payload jsonb;
  persons_payload jsonb;
  unions_payload jsonb;
  relations_payload jsonb;
  family_continuations_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  if p_request is null
     or jsonb_typeof(p_request) <> 'object'
     or not (p_request ?& array['treeId', 'scope'])
     or not pg_input_is_valid(coalesce(p_request ->> 'treeId', ''), 'uuid')
     or jsonb_typeof(p_request -> 'scope') <> 'object'
     or nullif(p_request -> 'scope' ->> 'id', '') is null
     or jsonb_typeof(p_request -> 'scope' -> 'parentIds') is distinct from 'array'
     or (
       p_request ? 'pageSize'
       and not pg_input_is_valid(coalesce(p_request ->> 'pageSize', ''), 'integer')
     ) then
    raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
  end if;

  if jsonb_array_length(p_request -> 'scope' -> 'parentIds') < 1
     or jsonb_array_length(p_request -> 'scope' -> 'parentIds') > 8 then
    raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_request -> 'scope' -> 'parentIds') parent_id(value)
    where jsonb_typeof(parent_id.value) is distinct from 'string'
       or not pg_input_is_valid(coalesce(parent_id.value #>> '{}', ''), 'uuid')
  ) then
    raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
  end if;

  if p_request -> 'scope' ? 'unionIds' then
    if jsonb_typeof(p_request -> 'scope' -> 'unionIds') <> 'array' then
      raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
    end if;
    if jsonb_array_length(p_request -> 'scope' -> 'unionIds') > 600 then
      raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_request -> 'scope' -> 'unionIds') union_id(value)
      where jsonb_typeof(union_id.value) is distinct from 'string'
         or length(coalesce(union_id.value #>> '{}', '')) > 256
    ) then
      raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
    end if;
  end if;

  if p_request -> 'scope' ? 'familyGroupId'
     and not pg_input_is_valid(
       coalesce(p_request -> 'scope' ->> 'familyGroupId', ''),
       'uuid'
     ) then
    raise exception 'INVALID_FAMILY_CHILDREN_REQUEST' using errcode = '22023';
  end if;

  requested_tree_id := (p_request ->> 'treeId')::uuid;
  requested_scope := p_request -> 'scope';
  requested_scope_id := requested_scope ->> 'id';
  requested_page_size := greatest(
    1,
    least(coalesce((p_request ->> 'pageSize')::integer, 50), 200)
  );
  requested_cursor := nullif(p_request ->> 'cursor', '');

  select array_agg(parent_id order by parent_id)
    into requested_parent_ids
  from (
    select distinct value::uuid as parent_id
    from jsonb_array_elements_text(requested_scope -> 'parentIds') item(value)
  ) requested_parents;

  if cardinality(requested_parent_ids) <>
     jsonb_array_length(requested_scope -> 'parentIds') then
    raise exception 'DUPLICATE_FAMILY_SCOPE_PARENT' using errcode = '22023';
  end if;

  if requested_scope_id !~ '^(family-group|parents|parent-set):' then
    raise exception 'INVALID_FAMILY_SCOPE' using errcode = '22023';
  end if;

  if requested_scope_id like 'family-group:%' and (
    not pg_input_is_valid(substring(requested_scope_id from 14), 'uuid')
    or (
      requested_scope ? 'familyGroupId'
      and requested_scope ->> 'familyGroupId'
        is distinct from substring(requested_scope_id from 14)
    )
  ) then
    raise exception 'INVALID_FAMILY_SCOPE' using errcode = '22023';
  end if;

  if requested_scope_id like 'parent-set:%'
     and not pg_input_is_valid(substring(requested_scope_id from 12), 'uuid') then
    raise exception 'INVALID_FAMILY_SCOPE' using errcode = '22023';
  end if;

  if requested_scope_id like 'parents:%'
     and requested_scope_id is distinct from
       'parents:' || array_to_string(requested_parent_ids, ',') then
    raise exception 'INVALID_FAMILY_SCOPE' using errcode = '22023';
  end if;

  requested_family_group_id := case
    when requested_scope_id like 'family-group:%'
      then substring(requested_scope_id from 14)::uuid
    else null
  end;
  requested_parent_set_id := case
    when requested_scope_id like 'parent-set:%'
      then substring(requested_scope_id from 12)::uuid
    else null
  end;

  select tree.project_id, tree.graph_version
    into current_project_id, current_graph_version
  from public.family_trees tree
  where tree.id = requested_tree_id
  for share;

  if current_project_id is null
     or not public.is_project_member(current_project_id) then
    raise exception 'TREE_NOT_FOUND_OR_FORBIDDEN' using errcode = '42501';
  end if;

  select member.role::text
    into project_member_role
  from public.project_members member
  where member.project_id = current_project_id
    and member.user_id = auth.uid();

  can_view_private := project_member_role in ('owner', 'editor');
  permission_fingerprint := case
    when can_view_private then 'project-editor:private-visible:v1'
    else 'project-viewer:living-masked:v1'
  end;

  if p_request ? 'knownGraphVersion'
     and (p_request ->> 'knownGraphVersion')
       is distinct from current_graph_version::text then
    raise exception 'TREE_GRAPH_VERSION_CHANGED' using errcode = '40001';
  end if;

  if p_request ? 'permissionFingerprint'
     and (p_request ->> 'permissionFingerprint')
       is distinct from permission_fingerprint then
    raise exception 'TREE_PERMISSION_SCOPE_CHANGED' using errcode = '40001';
  end if;

  cursor_payload := case
    when requested_cursor is null then null
    -- A family-specific cursor may carry the bounded set of already visible
    -- children.  v1 never selects more than 600 people, so 64 KiB keeps this
    -- transport bounded while allowing every visible child id to be excluded.
    when length(requested_cursor) > 65536 then null
    else public.family_tree_cursor_decode(requested_cursor)
  end;

  if requested_cursor is not null and (
    cursor_payload is null
    or not (cursor_payload ?& array[
      'version',
      'kind',
      'treeId',
      'familyScopeId',
      'graphVersion',
      'permissionFingerprint',
      'birthMissing',
      'birthSort',
      'childId'
    ])
    or cursor_payload ->> 'version' is distinct from '1'
    or cursor_payload ->> 'kind' is distinct from 'family-children'
    or cursor_payload ->> 'treeId' is distinct from requested_tree_id::text
    or cursor_payload ->> 'familyScopeId' is distinct from requested_scope_id
    or cursor_payload ->> 'graphVersion' is distinct from current_graph_version::text
    or cursor_payload ->> 'permissionFingerprint'
      is distinct from permission_fingerprint
    or jsonb_typeof(cursor_payload -> 'birthMissing') is distinct from 'boolean'
    or jsonb_typeof(cursor_payload -> 'birthSort') is distinct from 'string'
    or (
      cursor_payload ->> 'birthSort' <> ''
      and cursor_payload ->> 'birthSort' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    )
    or jsonb_typeof(cursor_payload -> 'childId') is distinct from 'string'
    or not pg_input_is_valid(coalesce(cursor_payload ->> 'childId', ''), 'uuid')
  ) then
    raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
  end if;

  if cursor_payload is not null and cursor_payload ? 'excludedChildIds' then
    if jsonb_typeof(cursor_payload -> 'excludedChildIds') <> 'array' then
      raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
    end if;
    if jsonb_array_length(cursor_payload -> 'excludedChildIds') > 600 then
      raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(cursor_payload -> 'excludedChildIds') child_id(value)
      where jsonb_typeof(child_id.value) is distinct from 'string'
         or not pg_input_is_valid(coalesce(child_id.value #>> '{}', ''), 'uuid')
    ) then
      raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
    end if;
    if (
      select count(distinct child_id.value #>> '{}')
      from jsonb_array_elements(cursor_payload -> 'excludedChildIds') child_id(value)
    ) <> jsonb_array_length(cursor_payload -> 'excludedChildIds') then
      raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
    end if;
    if jsonb_typeof(cursor_payload -> 'excludedChildDigest')
         is distinct from 'string' then
      raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
    end if;
  elsif cursor_payload is not null and cursor_payload ? 'excludedChildDigest' then
    raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
  end if;

  if cursor_payload is not null then
    cursor_birth_missing := (cursor_payload ->> 'birthMissing')::boolean;
    cursor_birth_sort := coalesce(cursor_payload ->> 'birthSort', '');
    cursor_child_id := (cursor_payload ->> 'childId')::uuid;
    select coalesce(
      array_agg(
        (child_id.value #>> '{}')::uuid
        order by (child_id.value #>> '{}')::uuid
      ),
      '{}'::uuid[]
    )
      into cursor_excluded_child_ids
    from jsonb_array_elements(
      coalesce(cursor_payload -> 'excludedChildIds', '[]'::jsonb)
    ) child_id(value);
    select md5(coalesce(string_agg(child_id::text, ',' order by child_id), ''))
      into cursor_excluded_child_digest
    from unnest(cursor_excluded_child_ids) child_id;
    if cursor_payload ? 'excludedChildIds'
       and cursor_payload ->> 'excludedChildDigest'
         is distinct from cursor_excluded_child_digest then
      raise exception 'INVALID_OR_STALE_FAMILY_CURSOR' using errcode = '22023';
    end if;
  end if;

  drop table if exists pg_temp._family_scope_parent_sets;
  drop table if exists pg_temp._family_scope_children;
  drop table if exists pg_temp._family_scope_page;

  create temporary table _family_scope_parent_sets (
    parent_set_id uuid primary key,
    child_id uuid not null,
    family_group_id uuid,
    parent_ids uuid[] not null,
    display_order integer not null,
    set_type text not null,
    is_preferred_for_display boolean not null,
    is_default_for_pedigree boolean not null
  ) on commit drop;

  with seed_candidate_set_ids as materialized (
    select parent_set.id
    from public.parent_sets parent_set
    where parent_set.tree_id = requested_tree_id
      and (
        (
          requested_family_group_id is not null
          and parent_set.family_group_id = requested_family_group_id
        )
        or (
          requested_family_group_id is not null
          and exists (
            select 1
            from public.parent_child_relationships relation
            where relation.tree_id = requested_tree_id
              and relation.parent_set_id = parent_set.id
              and relation.family_group_id = requested_family_group_id
          )
        )
        or (
          requested_parent_set_id is not null
          and parent_set.id = requested_parent_set_id
        )
        or (
          requested_scope_id like 'parents:%'
          and exists (
            select 1
            from public.parent_child_relationships relation
            where relation.tree_id = requested_tree_id
              and relation.parent_set_id = parent_set.id
              and relation.parent_id = any(requested_parent_ids)
              and relation.evidence_status <> 'disproven'
          )
        )
      )
  ), candidate_family_groups as materialized (
    select distinct seed_scope.family_group_id
    from (
      select coalesce(
        parent_set.family_group_id,
        (array_agg(relation.family_group_id order by relation.family_group_id)
          filter (where relation.family_group_id is not null))[1]
      ) as family_group_id
      from seed_candidate_set_ids seed
      join public.parent_sets parent_set
        on parent_set.id = seed.id
       and parent_set.tree_id = requested_tree_id
      join public.parent_child_relationships relation
        on relation.tree_id = requested_tree_id
       and relation.parent_set_id = parent_set.id
       and relation.evidence_status <> 'disproven'
      where relation.privacy_status <> 'confidential'
         or public.can_edit_project(relation.project_id)
      group by parent_set.id, parent_set.family_group_id
    ) seed_scope
    where seed_scope.family_group_id is not null
  ), candidate_sets as materialized (
    select parent_set.*
    from public.parent_sets parent_set
    where parent_set.tree_id = requested_tree_id
      and (
        parent_set.id in (select seed.id from seed_candidate_set_ids seed)
        or parent_set.family_group_id in (
          select family_group.family_group_id
          from candidate_family_groups family_group
        )
        or exists (
          select 1
          from public.parent_child_relationships relation
          join candidate_family_groups family_group
            on family_group.family_group_id = relation.family_group_id
          where relation.tree_id = requested_tree_id
            and relation.parent_set_id = parent_set.id
            and relation.evidence_status <> 'disproven'
            and (
              relation.privacy_status <> 'confidential'
              or public.can_edit_project(relation.project_id)
            )
        )
      )
  ), readable_relations as materialized (
    select relation.*
    from public.parent_child_relationships relation
    join candidate_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.child_id = relation.child_id
    join public.family_tree_persons parent_member
      on parent_member.tree_id = requested_tree_id
     and parent_member.person_id = relation.parent_id
     and parent_member.member_role <> 'hidden'
    join public.family_tree_persons child_member
      on child_member.tree_id = requested_tree_id
     and child_member.person_id = relation.child_id
     and child_member.member_role <> 'hidden'
    where relation.tree_id = requested_tree_id
      and relation.evidence_status <> 'disproven'
      and (
        relation.privacy_status <> 'confidential'
        or public.can_edit_project(relation.project_id)
      )
  ), grouped_sets as (
    select
      parent_set.id as parent_set_id,
      parent_set.child_id,
      coalesce(
        parent_set.family_group_id,
        (array_agg(relation.family_group_id order by relation.family_group_id)
          filter (where relation.family_group_id is not null))[1]
      )
        as family_group_id,
      array_agg(distinct relation.parent_id order by relation.parent_id)
        as parent_ids,
      parent_set.display_order,
      parent_set.set_type,
      parent_set.is_preferred_for_display,
      parent_set.is_default_for_pedigree
    from candidate_sets parent_set
    join readable_relations relation
      on relation.parent_set_id = parent_set.id
    group by
      parent_set.id,
      parent_set.child_id,
      parent_set.family_group_id,
      parent_set.display_order,
      parent_set.set_type,
      parent_set.is_preferred_for_display,
      parent_set.is_default_for_pedigree
  ), signature_counts as (
    select
      grouped_set.family_group_id,
      grouped_set.parent_ids,
      count(*)::integer as signature_count
    from grouped_sets grouped_set
    where grouped_set.family_group_id is not null
    group by grouped_set.family_group_id, grouped_set.parent_ids
  ), dominant_signatures as (
    select distinct on (signature.family_group_id)
      signature.family_group_id,
      signature.parent_ids
    from signature_counts signature
    order by
      signature.family_group_id,
      cardinality(signature.parent_ids) desc,
      signature.signature_count desc,
      array_to_string(signature.parent_ids, ',')
  ), family_group_identities as (
    select
      family_group_id.family_group_id,
      case
        when cardinality(primary_parents.parent_ids) >= 2
          then primary_parents.parent_ids
        else dominant.parent_ids
      end as canonical_parent_ids
    from (
      select distinct grouped_set.family_group_id
      from grouped_sets grouped_set
      where grouped_set.family_group_id is not null
    ) family_group_id
    left join public.family_groups family_group
      on family_group.id = family_group_id.family_group_id
     and family_group.tree_id = requested_tree_id
    left join lateral (
      select coalesce(array_agg(parent_id order by parent_id), '{}'::uuid[])
        as parent_ids
      from (
        select distinct parent_id
        from unnest(array[
          family_group.primary_partner_1_id,
          family_group.primary_partner_2_id
        ]) parent_row(parent_id)
        where parent_id is not null
      ) canonical_parent
    ) primary_parents on true
    left join dominant_signatures dominant
      on dominant.family_group_id = family_group_id.family_group_id
  ), scoped_sets as (
    select
      grouped_set.*,
      case
        when grouped_set.family_group_id is not null
         and grouped_set.parent_ids
           <@ coalesce(family_identity.canonical_parent_ids, '{}'::uuid[])
          then 'family-group:' || grouped_set.family_group_id::text
        when cardinality(grouped_set.parent_ids) >= 2
          then 'parents:' || array_to_string(grouped_set.parent_ids, ',')
        else 'parent-set:' || grouped_set.parent_set_id::text
      end as scope_id
    from grouped_sets grouped_set
    left join family_group_identities family_identity
      on family_identity.family_group_id = grouped_set.family_group_id
  )
  insert into _family_scope_parent_sets (
    parent_set_id,
    child_id,
    family_group_id,
    parent_ids,
    display_order,
    set_type,
    is_preferred_for_display,
    is_default_for_pedigree
  )
  select
    scoped_set.parent_set_id,
    scoped_set.child_id,
    case
      when scoped_set.scope_id like 'family-group:%'
        then scoped_set.family_group_id
      else null
    end,
    scoped_set.parent_ids,
    scoped_set.display_order,
    scoped_set.set_type,
    scoped_set.is_preferred_for_display,
    scoped_set.is_default_for_pedigree
  from scoped_sets scoped_set
  where scoped_set.scope_id = requested_scope_id;

  if not exists (select 1 from _family_scope_parent_sets) then
    raise exception 'FAMILY_SCOPE_NOT_FOUND_OR_FORBIDDEN' using errcode = '42501';
  end if;

  select array_agg(distinct parent_id order by parent_id)
    into actual_parent_ids
  from _family_scope_parent_sets parent_set
  cross join lateral unnest(parent_set.parent_ids) parent_row(parent_id);

  select family_group_id
    into actual_family_group_id
  from _family_scope_parent_sets
  where family_group_id is not null
  order by family_group_id
  limit 1;

  select array_agg(
    'parent-set:' || parent_set_id::text
    order by display_order, parent_set_id
  )
    into actual_union_ids
  from _family_scope_parent_sets;

  if actual_parent_ids is distinct from requested_parent_ids then
    raise exception 'FAMILY_SCOPE_PARENT_MISMATCH' using errcode = '22023';
  end if;

  if requested_scope ? 'familyGroupId'
     and (requested_scope ->> 'familyGroupId')::uuid
       is distinct from actual_family_group_id then
    raise exception 'FAMILY_SCOPE_GROUP_MISMATCH' using errcode = '22023';
  end if;

  if requested_scope ? 'unionIds' and exists (
    select 1
    from jsonb_array_elements_text(requested_scope -> 'unionIds') item(value)
    where item.value <> all(actual_union_ids)
  ) then
    raise exception 'FAMILY_SCOPE_UNION_MISMATCH' using errcode = '22023';
  end if;

  create temporary table _family_scope_children (
    child_id uuid primary key,
    parent_set_id uuid not null,
    birth_missing boolean not null,
    birth_sort text not null
  ) on commit drop;

  insert into _family_scope_children (
    child_id,
    parent_set_id,
    birth_missing,
    birth_sort
  )
  select distinct on (candidate.child_id)
    candidate.child_id,
    candidate.parent_set_id,
    candidate.birth_sort is null as birth_missing,
    coalesce(candidate.birth_sort, '') as birth_sort
  from (
    select
      parent_set.child_id,
      parent_set.parent_set_id,
      parent_set.is_default_for_pedigree,
      parent_set.is_preferred_for_display,
      parent_set.display_order,
      normalized_birth.birth_sort
    from _family_scope_parent_sets parent_set
    join public.persons person
      on person.id = parent_set.child_id
     and person.project_id = current_project_id
    left join lateral (
      select case
        when birth_candidate.raw_birth ~ '^[0-9]{4}$'
          then birth_candidate.raw_birth || '-00-00'
        when birth_candidate.raw_birth ~ '^[0-9]{4}-[0-9]{2}$'
          then birth_candidate.raw_birth || '-00'
        when birth_candidate.raw_birth ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
          then substring(birth_candidate.raw_birth from 1 for 10)
        else translate(
          substring(birth_candidate.raw_birth from 1 for 10),
          './',
          '--'
        )
      end as birth_sort
      from (values
        (nullif(person.birth_date, ''), 0),
        (nullif(person.birth_year_from, ''), 1),
        (nullif(person.birth_year_to, ''), 2)
      ) birth_candidate(raw_birth, source_order)
      where birth_candidate.raw_birth ~ '^[0-9]{4}$'
         or birth_candidate.raw_birth ~ '^[0-9]{4}-[0-9]{2}$'
         or birth_candidate.raw_birth ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
         or birth_candidate.raw_birth ~ '^[0-9]{4}[./][0-9]{2}[./][0-9]{2}'
      order by birth_candidate.source_order
      limit 1
    ) normalized_birth on true
  ) candidate
  where candidate.child_id <> all(cursor_excluded_child_ids)
  order by
    candidate.child_id,
    candidate.is_default_for_pedigree desc,
    candidate.is_preferred_for_display desc,
    candidate.display_order,
    candidate.parent_set_id;

  create temporary table _family_scope_page (
    child_id uuid primary key,
    parent_set_id uuid not null,
    birth_missing boolean not null,
    birth_sort text not null,
    page_order integer not null
  ) on commit drop;

  insert into _family_scope_page (
    child_id,
    parent_set_id,
    birth_missing,
    birth_sort,
    page_order
  )
  select
    page.child_id,
    page.parent_set_id,
    page.birth_missing,
    page.birth_sort,
    page.row_number::integer
  from (
    select
      child.*,
      row_number() over (
        order by child.birth_missing, child.birth_sort, child.child_id
      ) as row_number
    from _family_scope_children child
    where (
      child.birth_missing,
      child.birth_sort,
      child.child_id
    ) > (
      cursor_birth_missing,
      cursor_birth_sort,
      cursor_child_id
    )
  ) page
  where page.row_number <= requested_page_size;

  select count(*)::integer into returned_count
  from _family_scope_page;

  select
    page.birth_missing,
    page.birth_sort,
    page.child_id
    into next_birth_missing, next_birth_sort, next_child_id
  from _family_scope_page page
  order by page.page_order desc
  limit 1;

  next_birth_missing := coalesce(next_birth_missing, cursor_birth_missing);
  next_birth_sort := coalesce(next_birth_sort, cursor_birth_sort);
  next_child_id := coalesce(next_child_id, cursor_child_id);

  select count(*)::integer into remaining_count
  from _family_scope_children child
  where (
    child.birth_missing,
    child.birth_sort,
    child.child_id
  ) > (
    next_birth_missing,
    next_birth_sort,
    next_child_id
  );

  select public.family_tree_cursor_encode(jsonb_strip_nulls(jsonb_build_object(
    'version', 1,
    'kind', 'family-children',
    'treeId', requested_tree_id,
    'familyScopeId', requested_scope_id,
    'graphVersion', current_graph_version,
    'permissionFingerprint', permission_fingerprint,
    'birthMissing', page.birth_missing,
    'birthSort', page.birth_sort,
    'childId', page.child_id,
    'excludedChildIds', case
      when cardinality(cursor_excluded_child_ids) > 0
        then to_jsonb(cursor_excluded_child_ids)
      else null
    end,
    'excludedChildDigest', case
      when cardinality(cursor_excluded_child_ids) > 0
        then cursor_excluded_child_digest
      else null
    end
  )))
    into next_cursor
  from _family_scope_page page
  order by page.page_order desc
  limit 1;

  select jsonb_strip_nulls(jsonb_build_object(
    'id', requested_scope_id,
    'parentIds', to_jsonb(actual_parent_ids),
    'unionIds', to_jsonb(coalesce((
      select array_agg(
        'parent-set:' || page.parent_set_id::text
        order by page.page_order
      )
      from _family_scope_page page
    ), '{}'::text[])),
    'familyGroupId', actual_family_group_id
  )) into scope_payload;

  select coalesce(jsonb_agg(person_json order by person_rank, person_order), '[]'::jsonb)
    into persons_payload
  from (
    select
      case when person.id = any(actual_parent_ids) then 0 else 1 end as person_rank,
      coalesce(page.page_order, parent_position.position::integer, 0) as person_order,
      jsonb_strip_nulls(jsonb_build_object(
        'id', person.id,
        'displayName', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private
          then 'Приватна особа'
          else coalesce(
            nullif(person.full_name, ''),
            nullif(trim(concat_ws(' ', person.surname, person.given_name, person.patronymic)), ''),
            'Особа'
          )
        end,
        'givenName', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private then null
          else nullif(person.given_name, '')
        end,
        'surname', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private then null
          else nullif(person.surname, '')
        end,
        'sex', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private then 'unknown'
          when lower(person.gender) in ('male', 'm', 'чоловік', 'чоловіча') then 'male'
          when lower(person.gender) in ('female', 'f', 'жінка', 'жіноча') then 'female'
          when lower(person.gender) in ('other', 'інша', 'інше') then 'other'
          else 'unknown'
        end,
        'birth', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private then null
          when coalesce(
            nullif(person.birth_date, ''),
            nullif(person.birth_year_from, ''),
            nullif(person.birth_year_to, ''),
            ''
          ) = '' then null
          else jsonb_strip_nulls(jsonb_build_object(
            'display', nullif(coalesce(nullif(person.birth_date, ''), nullif(person.birth_year_from, ''), person.birth_year_to), ''),
            'sort', nullif(coalesce(nullif(person.birth_year_from, ''), nullif(person.birth_date, ''), person.birth_year_to), '')
          ))
        end,
        'death', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private then null
          when coalesce(
            nullif(person.death_date, ''),
            nullif(person.death_year_from, ''),
            nullif(person.death_year_to, ''),
            ''
          ) = '' then null
          else jsonb_strip_nulls(jsonb_build_object(
            'display', nullif(coalesce(nullif(person.death_date, ''), nullif(person.death_year_from, ''), person.death_year_to), ''),
            'sort', nullif(coalesce(nullif(person.death_year_from, ''), nullif(person.death_date, ''), person.death_year_to), '')
          ))
        end,
        'isLiving', person.is_living,
        'isPrivate', person.privacy_status in ('private', 'confidential'),
        'displayOrder', lpad((member.display_order::bigint + 1000000000)::text, 20, '0'),
        'badges', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private
          then jsonb_build_object('privacy', 'masked')
          else null
        end
      )) as person_json
    from public.persons person
    join public.family_tree_persons member
      on member.tree_id = requested_tree_id
     and member.person_id = person.id
     and member.member_role <> 'hidden'
    left join _family_scope_page page
      on page.child_id = person.id
    left join lateral (
      select position
      from unnest(actual_parent_ids) with ordinality parent_id(value, position)
      where parent_id.value = person.id
    ) parent_position on true
    where person.project_id = current_project_id
      and (
        person.id = any(actual_parent_ids)
        or page.child_id is not null
      )
  ) payload;

  with partnership_unions as (
    select
      '0:' || partnership.id::text as sort_key,
      jsonb_strip_nulls(jsonb_build_object(
        'id', 'partnership:' || partnership.id::text,
        'kind', 'partnership',
        'memberIds', jsonb_build_array(partnership.person_a_id, partnership.person_b_id),
        'familyGroupId', coalesce(partnership.family_group_id::text, requested_scope_id),
        'familyScopeId', requested_scope_id,
        'relationshipType', case
          when not can_view_private and (
            (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
            or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
          ) then 'unknown'
          else partnership.relationship_type
        end,
        'status', case
          when not can_view_private and (
            (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
            or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
          ) then 'unknown'
          when partnership.relationship_type = 'marriage' and partnership.status = 'active' then 'married'
          when partnership.relationship_type = 'separated' then 'separated'
          when partnership.relationship_type = 'divorced' then 'divorced'
          when partnership.status = 'ended' then 'ended'
          when partnership.status = 'active' then 'current'
          else 'unknown'
        end,
        'startDate', case when partnership.start_date = '' or (
          not can_view_private and (
            (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
            or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
          )
        ) then null
          else jsonb_build_object('display', partnership.start_date, 'sort', partnership.start_date)
        end,
        'endDate', case when partnership.end_date = '' or (
          not can_view_private and (
            (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
            or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
          )
        ) then null
          else jsonb_build_object('display', partnership.end_date, 'sort', partnership.end_date)
        end
      )) as union_json
    from public.partner_relationships partnership
    join public.persons person_a
      on person_a.id = partnership.person_a_id
     and person_a.project_id = current_project_id
    join public.persons person_b
      on person_b.id = partnership.person_b_id
     and person_b.project_id = current_project_id
    where partnership.tree_id = requested_tree_id
      and partnership.evidence_status <> 'disproven'
      and (
        partnership.privacy_status <> 'confidential'
        or public.can_edit_project(partnership.project_id)
      )
      and partnership.person_a_id = any(actual_parent_ids)
      and partnership.person_b_id = any(actual_parent_ids)
      and (
        (
          actual_family_group_id is not null
          and partnership.family_group_id = actual_family_group_id
        )
        or (
          actual_family_group_id is null
          and partnership.family_group_id is null
        )
      )
  ), parent_set_unions as (
    select
      '1:' || parent_set.parent_set_id::text as sort_key,
      jsonb_build_object(
        'id', 'parent-set:' || parent_set.parent_set_id::text,
        'kind', 'parent-set',
        'parentSetType', case
          when not can_view_private and (
            exists (
              select 1
              from public.persons private_child
              where private_child.id = parent_set.child_id
                and private_child.is_living
                and private_child.privacy_status in ('private', 'confidential')
            )
            or exists (
              select 1
              from unnest(parent_set.parent_ids) parent_id
              join public.persons private_parent on private_parent.id = parent_id
              where private_parent.is_living
                and private_parent.privacy_status in ('private', 'confidential')
            )
          ) then 'unknown'
          else parent_set.set_type
        end,
        'isPreferredForDisplay', parent_set.is_preferred_for_display,
        'isDefaultForPedigree', parent_set.is_default_for_pedigree,
        'memberIds', to_jsonb(parent_set.parent_ids),
        'familyGroupId', coalesce(parent_set.family_group_id::text, requested_scope_id),
        'familyScopeId', requested_scope_id,
        'displayOrder', lpad((parent_set.display_order::bigint + 1000000000)::text, 20, '0'),
        'expectedParentSlots', 2
      ) as union_json
    from _family_scope_parent_sets parent_set
    where exists (
      select 1
      from _family_scope_page page
      where page.parent_set_id = parent_set.parent_set_id
    )
  ), union_rows as (
    select * from partnership_unions
    union all
    select * from parent_set_unions
  )
  select coalesce(jsonb_agg(union_json order by sort_key), '[]'::jsonb)
    into unions_payload
  from union_rows;

  select coalesce(
    jsonb_agg(relation_json order by page_order, relation_id),
    '[]'::jsonb
  )
    into relations_payload
  from (
    select
      page.page_order,
      relation.id as relation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'id', relation.id,
        'parentId', relation.parent_id,
        'childId', relation.child_id,
        'unionId', 'parent-set:' || relation.parent_set_id::text,
        'kind', case
          when not can_view_private and (
            (parent_person.is_living and parent_person.privacy_status in ('private', 'confidential'))
            or (child_person.is_living and child_person.privacy_status in ('private', 'confidential'))
          ) then 'unknown'
          else relation.relationship_type
        end,
        'role', case
          when not can_view_private and (
            (parent_person.is_living and parent_person.privacy_status in ('private', 'confidential'))
            or (child_person.is_living and child_person.privacy_status in ('private', 'confidential'))
          ) then 'unknown'
          when relation.relationship_type = 'donor' then 'donor'
          when relation.relationship_type = 'surrogate' then 'surrogate'
          else relation.parent_role_label
        end,
        'displayOrder', lpad((parent_set.display_order::bigint + 1000000000)::text, 20, '0'),
        'isPreferred', relation.is_primary_for_display
          or parent_set.is_preferred_for_display
          or parent_set.is_default_for_pedigree
      )) as relation_json
    from _family_scope_page page
    join public.parent_child_relationships relation
      on relation.tree_id = requested_tree_id
     and relation.parent_set_id = page.parent_set_id
     and relation.child_id = page.child_id
     and relation.evidence_status <> 'disproven'
    join _family_scope_parent_sets parent_set
      on parent_set.parent_set_id = relation.parent_set_id
    join public.persons parent_person
      on parent_person.id = relation.parent_id
     and parent_person.project_id = current_project_id
    join public.persons child_person
      on child_person.id = relation.child_id
     and child_person.project_id = current_project_id
    where relation.privacy_status <> 'confidential'
       or public.can_edit_project(relation.project_id)
  ) payload;

  if remaining_count > 0 and returned_count > 0 then
    family_continuations_payload := jsonb_build_array(jsonb_build_object(
      'id', md5(requested_tree_id::text || ':' || requested_scope_id),
      'scope', scope_payload,
      'token', next_cursor,
      'hiddenCount', remaining_count
    ));
  else
    family_continuations_payload := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'persons', persons_payload,
    'unions', unions_payload,
    'parentChildRelations', relations_payload,
    'continuations', '[]'::jsonb,
    'familyContinuations', family_continuations_payload,
    'scope', scope_payload,
    'graphVersion', current_graph_version::text,
    'permissionFingerprint', permission_fingerprint
  ) || case
    when remaining_count > 0 and returned_count > 0
      then jsonb_build_object('nextCursor', next_cursor)
    else '{}'::jsonb
  end;
end;
$$;

revoke execute on function public.get_family_tree_family_children_v1(jsonb)
  from public, anon;
grant execute on function public.get_family_tree_family_children_v1(jsonb)
  to authenticated;

-- Neighborhood v2 delegates graph traversal to v1, enriches every visual
-- union with its family identity and replaces duplicate per-parent child
-- continuations with one continuation per exact family scope.
-- Its request is the unchanged v1 request.  A client expands
-- NeighborhoodRequest.familyBranches by calling
-- get_family_tree_family_children_v1 once per requested family scope; keeping
-- that bounded RPC separate prevents one wide family from consuming the
-- pedigree neighborhood's 600-node budget.
create or replace function public.get_family_tree_neighborhood_v2(
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $$
declare
  base_response jsonb;
  requested_tree_id uuid;
  current_graph_version text;
  permission_fingerprint text;
  enriched_unions jsonb;
  legacy_continuations jsonb;
  family_continuations jsonb;
begin
  -- v1 remains the sole authority for authentication, request validation,
  -- initial pedigree selection, masking and graph-version checks.
  base_response := public.get_family_tree_neighborhood_v1(p_request);
  requested_tree_id := (p_request ->> 'treeId')::uuid;
  current_graph_version := base_response ->> 'graphVersion';
  permission_fingerprint := base_response ->> 'permissionFingerprint';

  drop table if exists pg_temp._family_scope_v2_parent_sets;
  create temporary table _family_scope_v2_parent_sets (
    parent_set_id uuid primary key,
    child_id uuid not null,
    family_group_id uuid,
    parent_ids uuid[] not null,
    display_order integer not null,
    scope_id text not null
  ) on commit drop;

  -- Start from parent edges of the bounded v1 selection.  Only after those
  -- seed sets are known do we fan out to other child sets in the same persisted
  -- family group.  This preserves exact family-group semantics without ever
  -- grouping every parent edge in the tree.
  with selected_people as materialized (
    select (person ->> 'id')::uuid as person_id
    from jsonb_array_elements(base_response -> 'persons') person
  ), seed_parent_set_ids as materialized (
    select distinct relation.parent_set_id
    from selected_people selected
    join public.parent_child_relationships relation
      on relation.tree_id = requested_tree_id
     and relation.parent_id = selected.person_id
     and relation.evidence_status <> 'disproven'
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    join public.family_tree_persons parent_member
      on parent_member.tree_id = requested_tree_id
     and parent_member.person_id = relation.parent_id
     and parent_member.member_role <> 'hidden'
    join public.family_tree_persons child_member
      on child_member.tree_id = requested_tree_id
     and child_member.person_id = relation.child_id
     and child_member.member_role <> 'hidden'
    where relation.privacy_status <> 'confidential'
       or public.can_edit_project(relation.project_id)
  ), seed_readable_relations as materialized (
    select relation.*
    from seed_parent_set_ids seed
    join public.parent_child_relationships relation
      on relation.tree_id = requested_tree_id
     and relation.parent_set_id = seed.parent_set_id
     and relation.evidence_status <> 'disproven'
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    join public.family_tree_persons parent_member
      on parent_member.tree_id = requested_tree_id
     and parent_member.person_id = relation.parent_id
     and parent_member.member_role <> 'hidden'
    join public.family_tree_persons child_member
      on child_member.tree_id = requested_tree_id
     and child_member.person_id = relation.child_id
     and child_member.member_role <> 'hidden'
    where relation.privacy_status <> 'confidential'
       or public.can_edit_project(relation.project_id)
  ), seed_family_groups as materialized (
    select distinct seed_scope.family_group_id
    from (
      select coalesce(
        parent_set.family_group_id,
        (array_agg(relation.family_group_id order by relation.family_group_id)
          filter (where relation.family_group_id is not null))[1]
      ) as family_group_id
      from seed_parent_set_ids seed
      join public.parent_sets parent_set
        on parent_set.id = seed.parent_set_id
       and parent_set.tree_id = requested_tree_id
      join seed_readable_relations relation
        on relation.parent_set_id = seed.parent_set_id
      group by parent_set.id, parent_set.family_group_id
    ) seed_scope
    where seed_scope.family_group_id is not null
  ), candidate_parent_set_ids as materialized (
    select seed.parent_set_id
    from seed_parent_set_ids seed

    union

    select parent_set.id
    from public.parent_sets parent_set
    join seed_family_groups family_group
      on family_group.family_group_id = parent_set.family_group_id
    where parent_set.tree_id = requested_tree_id

    union

    select relation.parent_set_id
    from seed_family_groups family_group
    join public.parent_child_relationships relation
      on relation.tree_id = requested_tree_id
     and relation.family_group_id = family_group.family_group_id
     and relation.evidence_status <> 'disproven'
    where relation.privacy_status <> 'confidential'
       or public.can_edit_project(relation.project_id)
  ), readable_relations as materialized (
    select relation.*
    from candidate_parent_set_ids candidate
    join public.parent_child_relationships relation
      on relation.tree_id = requested_tree_id
     and relation.parent_set_id = candidate.parent_set_id
     and relation.evidence_status <> 'disproven'
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    join public.family_tree_persons parent_member
      on parent_member.tree_id = requested_tree_id
     and parent_member.person_id = relation.parent_id
     and parent_member.member_role <> 'hidden'
    join public.family_tree_persons child_member
      on child_member.tree_id = requested_tree_id
     and child_member.person_id = relation.child_id
     and child_member.member_role <> 'hidden'
    where relation.privacy_status <> 'confidential'
       or public.can_edit_project(relation.project_id)
  ), parent_set_rows as (
    select
      parent_set.id as parent_set_id,
      parent_set.child_id,
      coalesce(
        parent_set.family_group_id,
        (array_agg(relation.family_group_id order by relation.family_group_id)
          filter (where relation.family_group_id is not null))[1]
      ) as family_group_id,
      array_agg(distinct relation.parent_id order by relation.parent_id)
        as parent_ids,
      parent_set.display_order
    from candidate_parent_set_ids candidate
    join public.parent_sets parent_set
      on parent_set.id = candidate.parent_set_id
     and parent_set.tree_id = requested_tree_id
    join readable_relations relation
      on relation.parent_set_id = parent_set.id
    group by
      parent_set.id,
      parent_set.child_id,
      parent_set.family_group_id,
      parent_set.display_order
  ), signature_counts as (
    select
      parent_set.family_group_id,
      parent_set.parent_ids,
      count(*)::integer as signature_count
    from parent_set_rows parent_set
    where parent_set.family_group_id is not null
    group by parent_set.family_group_id, parent_set.parent_ids
  ), dominant_signatures as (
    select distinct on (signature.family_group_id)
      signature.family_group_id,
      signature.parent_ids
    from signature_counts signature
    order by
      signature.family_group_id,
      cardinality(signature.parent_ids) desc,
      signature.signature_count desc,
      array_to_string(signature.parent_ids, ',')
  ), family_group_identities as (
    select
      family_group_id.family_group_id,
      case
        when cardinality(primary_parents.parent_ids) >= 2
          then primary_parents.parent_ids
        else dominant.parent_ids
      end as canonical_parent_ids
    from (
      select distinct parent_set.family_group_id
      from parent_set_rows parent_set
      where parent_set.family_group_id is not null
    ) family_group_id
    left join public.family_groups family_group
      on family_group.id = family_group_id.family_group_id
     and family_group.tree_id = requested_tree_id
    left join lateral (
      select coalesce(array_agg(parent_id order by parent_id), '{}'::uuid[])
        as parent_ids
      from (
        select distinct parent_id
        from unnest(array[
          family_group.primary_partner_1_id,
          family_group.primary_partner_2_id
        ]) parent_row(parent_id)
        where parent_id is not null
      ) canonical_parent
    ) primary_parents on true
    left join dominant_signatures dominant
      on dominant.family_group_id = family_group_id.family_group_id
  ), scoped_parent_set_rows as (
    select
      parent_set.*,
      case
        when parent_set.family_group_id is not null
         and parent_set.parent_ids
           <@ coalesce(family_identity.canonical_parent_ids, '{}'::uuid[])
          then 'family-group:' || parent_set.family_group_id::text
        when cardinality(parent_set.parent_ids) >= 2
          then 'parents:' || array_to_string(parent_set.parent_ids, ',')
        else 'parent-set:' || parent_set.parent_set_id::text
      end as scope_id
    from parent_set_rows parent_set
    left join family_group_identities family_identity
      on family_identity.family_group_id = parent_set.family_group_id
  )
  insert into _family_scope_v2_parent_sets (
    parent_set_id,
    child_id,
    family_group_id,
    parent_ids,
    display_order,
    scope_id
  )
  select
    parent_set.parent_set_id,
    parent_set.child_id,
    case
      when parent_set.scope_id like 'family-group:%'
        then parent_set.family_group_id
      else null
    end,
    parent_set.parent_ids,
    parent_set.display_order,
    parent_set.scope_id
  from scoped_parent_set_rows parent_set;

  with source_unions as (
    select union_row, ordinal
    from jsonb_array_elements(base_response -> 'unions')
      with ordinality source(union_row, ordinal)
  ), metadata as (
    select
      source.ordinal,
      source.union_row,
      case
        when source.union_row ->> 'kind' = 'parent-set' then
          parent_set.scope_id
        when source.union_row ->> 'kind' = 'partnership' then
          case
            when partnership.family_group_id is not null
              then 'family-group:' || partnership.family_group_id::text
            else 'parents:' || least(
              partnership.person_a_id,
              partnership.person_b_id
            )::text || ',' || greatest(
              partnership.person_a_id,
              partnership.person_b_id
            )::text
          end
      end as scope_id,
      case
        when source.union_row ->> 'kind' = 'parent-set'
          then parent_set.family_group_id
        when source.union_row ->> 'kind' = 'partnership'
          then partnership.family_group_id
      end as persisted_family_group_id
    from source_unions source
    left join _family_scope_v2_parent_sets parent_set
      on parent_set.parent_set_id = case
       when source.union_row ->> 'kind' = 'parent-set'
         then substring(source.union_row ->> 'id' from 12)::uuid
       else null
      end
    left join public.partner_relationships partnership
      on partnership.id = case
       when source.union_row ->> 'kind' = 'partnership'
         then substring(source.union_row ->> 'id' from 13)::uuid
       else null
     end
     and partnership.tree_id = requested_tree_id
  )
  select coalesce(jsonb_agg(
    metadata.union_row || jsonb_strip_nulls(jsonb_build_object(
      'familyGroupId', coalesce(
        metadata.persisted_family_group_id::text,
        metadata.scope_id
      ),
      'familyScopeId', metadata.scope_id
    ))
    order by metadata.ordinal
  ), '[]'::jsonb)
    into enriched_unions
  from metadata;

  select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
    into legacy_continuations
  from jsonb_array_elements(base_response -> 'continuations')
    with ordinality continuation(item, ordinal)
  where item ->> 'direction' <> 'children';

  with selected_people as materialized (
    select (person ->> 'id')::uuid as person_id
    from jsonb_array_elements(base_response -> 'persons') person
  ), scope_rows as (
    select
      parent_set.scope_id,
      (array_agg(parent_set.family_group_id order by parent_set.family_group_id)
        filter (where parent_set.family_group_id is not null))[1]
        as family_group_id,
      array_agg(distinct parent_row.parent_id order by parent_row.parent_id)
        as parent_ids,
      coalesce(
        array_agg(distinct parent_set.child_id order by parent_set.child_id)
          filter (where selected_child.person_id is not null),
        '{}'::uuid[]
      ) as visible_child_ids,
      count(distinct parent_set.child_id) filter (
        where selected_child.person_id is null
      )::integer as hidden_count
    from _family_scope_v2_parent_sets parent_set
    cross join lateral unnest(parent_set.parent_ids) parent_row(parent_id)
    left join selected_people selected_child
      on selected_child.person_id = parent_set.child_id
    group by parent_set.scope_id
    having count(distinct parent_set.child_id) filter (
      where selected_child.person_id is null
    ) > 0
  ), expandable_scope_rows as (
    select
      scope.*,
      md5(coalesce(array_to_string(scope.visible_child_ids, ','), ''))
        as visible_child_digest
    from scope_rows scope
    where cardinality(scope.parent_ids) between 1 and 8
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', md5(requested_tree_id::text || ':' || scope.scope_id),
    'scope', jsonb_strip_nulls(jsonb_build_object(
      'id', scope.scope_id,
      'parentIds', to_jsonb(scope.parent_ids),
      'familyGroupId', scope.family_group_id
    )),
    'token', public.family_tree_cursor_encode(jsonb_strip_nulls(jsonb_build_object(
      'version', 1,
      'kind', 'family-children',
      'treeId', requested_tree_id,
      'familyScopeId', scope.scope_id,
      'graphVersion', current_graph_version,
      'permissionFingerprint', permission_fingerprint,
      'birthMissing', false,
      'birthSort', '',
      'childId', '00000000-0000-0000-0000-000000000000',
      'excludedChildIds', case
        when cardinality(scope.visible_child_ids) > 0
          then to_jsonb(scope.visible_child_ids)
        else null
      end,
      'excludedChildDigest', case
        when cardinality(scope.visible_child_ids) > 0
          then scope.visible_child_digest
        else null
      end
    ))),
    'hiddenCount', scope.hidden_count
  ) order by scope.scope_id), '[]'::jsonb)
    into family_continuations
  from expandable_scope_rows scope;

  return base_response || jsonb_build_object(
    'unions', enriched_unions,
    'continuations', legacy_continuations,
    'familyContinuations', family_continuations
  );
end;
$$;

revoke execute on function public.get_family_tree_neighborhood_v2(jsonb)
  from public, anon;
grant execute on function public.get_family_tree_neighborhood_v2(jsonb)
  to authenticated;

commit;
