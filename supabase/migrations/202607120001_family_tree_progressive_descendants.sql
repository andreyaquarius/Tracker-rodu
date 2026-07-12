begin;

-- Progressive descendant traversal reads only direct child edges for the
-- supplied frontier.  This partial index keeps every cursor page bounded even
-- for a very wide family (for example, 2,479 direct children).
create index if not exists parent_child_relationships_descendant_frontier_idx
  on public.parent_child_relationships (
    tree_id,
    parent_id,
    child_id,
    parent_set_id,
    id
  )
  include (privacy_status)
  where evidence_status <> 'disproven';

-- Stateless breadth-first descendant transport.
--
-- Request:
-- {
--   "treeId": uuid,
--   "rootPersonId": uuid,
--   "frontier": {
--     "generation": 0..128,
--     "personIds": uuid[1..200]
--   },
--   "pageSize"?: 1..200,
--   "cursor"?: opaque-string,
--   "knownGraphVersion"?: bigint-as-string,
--   "permissionFingerprint"?: string
-- }
--
-- Response:
-- {
--   persons,
--   unions,
--   parentChildRelations,
--   continuations: [],
--   nextFrontier: { generation, personIds },
--   hasMore,
--   progress: {
--     currentGeneration, nextGeneration, frontierCount, pageSize, pageNumber,
--     returnedDescendantCount, returnedPersonCount, returnedUnionCount,
--     returnedRelationCount, frontierComplete
--   },
--   graphVersion,
--   permissionFingerprint,
--   nextCursor?: opaque-string
-- }
--
-- The client resends the same frontier and nextCursor while hasMore is true,
-- accumulates/deduplicates nextFrontier.personIds, and then submits those ids
-- as generation + 1 in chunks of at most 200.  The client owns the visited set
-- (needed for malformed cyclic genealogies).  Current frontier people are
-- already present in the client graph and are therefore not repeated in
-- persons; connector co-parents can be returned there, but only actual
-- descendants are added to nextFrontier.
create or replace function public.get_family_tree_descendants_frontier_v1(
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
  requested_root_person_id uuid;
  requested_generation integer;
  requested_frontier_ids uuid[];
  requested_page_size integer;
  requested_cursor text;
  current_project_id uuid;
  current_graph_version bigint;
  project_member_role text;
  can_view_private boolean;
  permission_fingerprint text;
  frontier_digest text;
  cursor_payload jsonb;
  cursor_after_child_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  cursor_page_number integer := 0;
  candidate_count integer := 0;
  returned_count integer := 0;
  has_more boolean := false;
  next_cursor text;
  persons_payload jsonb := '[]'::jsonb;
  unions_payload jsonb := '[]'::jsonb;
  relations_payload jsonb := '[]'::jsonb;
  next_frontier_payload jsonb;
  progress_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  if p_request is null
     or jsonb_typeof(p_request) <> 'object'
     or not (p_request ?& array['treeId', 'rootPersonId', 'frontier'])
     or not pg_input_is_valid(coalesce(p_request ->> 'treeId', ''), 'uuid')
     or not pg_input_is_valid(
       coalesce(p_request ->> 'rootPersonId', ''),
       'uuid'
     )
     or jsonb_typeof(p_request -> 'frontier') <> 'object'
     or not ((p_request -> 'frontier') ?& array['generation', 'personIds'])
     or not pg_input_is_valid(
       coalesce(p_request -> 'frontier' ->> 'generation', ''),
       'integer'
     )
     or jsonb_typeof(p_request -> 'frontier' -> 'personIds') <> 'array'
     or (
       p_request ? 'pageSize'
       and not pg_input_is_valid(
         coalesce(p_request ->> 'pageSize', ''),
         'integer'
       )
     ) then
    raise exception 'INVALID_DESCENDANTS_FRONTIER_REQUEST'
      using errcode = '22023';
  end if;

  if jsonb_array_length(p_request -> 'frontier' -> 'personIds') < 1
     or jsonb_array_length(p_request -> 'frontier' -> 'personIds') > 200
     or exists (
       select 1
       from jsonb_array_elements(
         p_request -> 'frontier' -> 'personIds'
       ) frontier_person(value)
       where jsonb_typeof(frontier_person.value) <> 'string'
          or not pg_input_is_valid(
            coalesce(frontier_person.value #>> '{}', ''),
            'uuid'
          )
     ) then
    raise exception 'INVALID_DESCENDANTS_FRONTIER_REQUEST'
      using errcode = '22023';
  end if;

  requested_tree_id := (p_request ->> 'treeId')::uuid;
  requested_root_person_id := (p_request ->> 'rootPersonId')::uuid;
  requested_generation := (p_request -> 'frontier' ->> 'generation')::integer;
  requested_page_size := greatest(
    1,
    least(coalesce((p_request ->> 'pageSize')::integer, 100), 200)
  );
  requested_cursor := nullif(p_request ->> 'cursor', '');

  if requested_generation < 0 or requested_generation > 128 then
    raise exception 'INVALID_DESCENDANTS_FRONTIER_REQUEST'
      using errcode = '22023';
  end if;

  select array_agg(frontier_person_id order by frontier_person_id)
    into requested_frontier_ids
  from (
    select distinct value::uuid as frontier_person_id
    from jsonb_array_elements_text(
      p_request -> 'frontier' -> 'personIds'
    ) frontier_person(value)
  ) normalized_frontier;

  if cardinality(requested_frontier_ids)
       <> jsonb_array_length(p_request -> 'frontier' -> 'personIds') then
    raise exception 'DUPLICATE_DESCENDANTS_FRONTIER_PERSON'
      using errcode = '22023';
  end if;

  if requested_generation = 0 and (
    cardinality(requested_frontier_ids) <> 1
    or requested_frontier_ids[1] <> requested_root_person_id
  ) then
    raise exception 'INVALID_DESCENDANTS_ROOT_FRONTIER'
      using errcode = '22023';
  end if;

  select md5(string_agg(frontier_person_id::text, ',' order by frontier_person_id))
    into frontier_digest
  from unnest(requested_frontier_ids) frontier(frontier_person_id);

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

  if not exists (
    select 1
    from public.family_tree_persons root_member
    where root_member.tree_id = requested_tree_id
      and root_member.person_id = requested_root_person_id
      and root_member.member_role <> 'hidden'
  ) then
    raise exception 'DESCENDANTS_ROOT_NOT_FOUND_OR_FORBIDDEN'
      using errcode = '42501';
  end if;

  if (
    select count(*)::integer
    from public.family_tree_persons frontier_member
    where frontier_member.tree_id = requested_tree_id
      and frontier_member.person_id = any(requested_frontier_ids)
      and frontier_member.member_role <> 'hidden'
  ) <> cardinality(requested_frontier_ids) then
    raise exception 'DESCENDANTS_FRONTIER_NOT_FOUND_OR_FORBIDDEN'
      using errcode = '42501';
  end if;

  cursor_payload := case
    when requested_cursor is null then null
    when length(requested_cursor) > 8192 then null
    else public.family_tree_cursor_decode(requested_cursor)
  end;

  if requested_cursor is not null and (
    cursor_payload is null
    or not (cursor_payload ?& array[
      'version',
      'kind',
      'treeId',
      'rootPersonId',
      'generation',
      'frontierDigest',
      'graphVersion',
      'permissionFingerprint',
      'afterChildId',
      'pageNumber'
    ])
    or cursor_payload ->> 'version' <> '1'
    or cursor_payload ->> 'kind' <> 'descendants-frontier'
    or cursor_payload ->> 'treeId' <> requested_tree_id::text
    or cursor_payload ->> 'rootPersonId' <> requested_root_person_id::text
    or not pg_input_is_valid(
      coalesce(cursor_payload ->> 'generation', ''),
      'integer'
    )
    or (cursor_payload ->> 'generation')::integer <> requested_generation
    or cursor_payload ->> 'frontierDigest' <> frontier_digest
    or cursor_payload ->> 'graphVersion' <> current_graph_version::text
    or cursor_payload ->> 'permissionFingerprint' <> permission_fingerprint
    or not pg_input_is_valid(
      coalesce(cursor_payload ->> 'afterChildId', ''),
      'uuid'
    )
    or not pg_input_is_valid(
      coalesce(cursor_payload ->> 'pageNumber', ''),
      'integer'
    )
    or (cursor_payload ->> 'pageNumber')::integer < 0
  ) then
    raise exception 'INVALID_OR_STALE_DESCENDANTS_CURSOR'
      using errcode = '22023';
  end if;

  if cursor_payload is not null then
    cursor_after_child_id := (cursor_payload ->> 'afterChildId')::uuid;
    cursor_page_number := (cursor_payload ->> 'pageNumber')::integer;
  end if;

  drop table if exists pg_temp._descendants_frontier;
  drop table if exists pg_temp._descendants_candidates;
  drop table if exists pg_temp._descendants_page;
  drop table if exists pg_temp._descendants_parent_sets;
  drop table if exists pg_temp._descendants_relations;

  create temporary table _descendants_frontier (
    person_id uuid primary key
  ) on commit drop;

  insert into _descendants_frontier (person_id)
  select unnest(requested_frontier_ids);

  create temporary table _descendants_candidates (
    child_id uuid primary key
  ) on commit drop;

  -- Each lateral branch reads at most pageSize + 1 index entries.  The outer
  -- DISTINCT merges children shared by multiple frontier parents without ever
  -- recursively walking later generations.
  insert into _descendants_candidates (child_id)
  select candidate.child_id
  from (
    select distinct per_parent.child_id
    from _descendants_frontier frontier
    cross join lateral (
      select distinct relation.child_id
      from public.parent_child_relationships relation
      join public.family_tree_persons child_member
        on child_member.tree_id = requested_tree_id
       and child_member.person_id = relation.child_id
       and child_member.member_role <> 'hidden'
      where relation.tree_id = requested_tree_id
        and relation.parent_id = frontier.person_id
        and (
          cursor_payload is null
          or relation.child_id > cursor_after_child_id
        )
        and relation.evidence_status <> 'disproven'
        and (
          relation.privacy_status <> 'confidential'
          or can_view_private
        )
      order by relation.child_id
      limit requested_page_size + 1
    ) per_parent
    order by per_parent.child_id
    limit requested_page_size + 1
  ) candidate;

  select count(*)::integer
    into candidate_count
  from _descendants_candidates;

  has_more := candidate_count > requested_page_size;

  create temporary table _descendants_page (
    child_id uuid primary key,
    page_order integer not null
  ) on commit drop;

  insert into _descendants_page (child_id, page_order)
  select
    candidate.child_id,
    row_number() over (order by candidate.child_id)::integer
  from _descendants_candidates candidate
  order by candidate.child_id
  limit requested_page_size;

  select count(*)::integer
    into returned_count
  from _descendants_page;

  create temporary table _descendants_parent_sets (
    parent_set_id uuid primary key,
    child_id uuid not null,
    family_group_id uuid,
    set_type text not null,
    is_preferred_for_display boolean not null,
    is_default_for_pedigree boolean not null,
    display_order integer not null
  ) on commit drop;

  insert into _descendants_parent_sets (
    parent_set_id,
    child_id,
    family_group_id,
    set_type,
    is_preferred_for_display,
    is_default_for_pedigree,
    display_order
  )
  select distinct
    parent_set.id,
    parent_set.child_id,
    parent_set.family_group_id,
    parent_set.set_type,
    parent_set.is_preferred_for_display,
    parent_set.is_default_for_pedigree,
    parent_set.display_order
  from _descendants_page page
  join public.parent_sets parent_set
    on parent_set.tree_id = requested_tree_id
   and parent_set.child_id = page.child_id
  join public.parent_child_relationships frontier_relation
    on frontier_relation.tree_id = requested_tree_id
   and frontier_relation.parent_set_id = parent_set.id
   and frontier_relation.child_id = page.child_id
  join _descendants_frontier frontier
    on frontier.person_id = frontier_relation.parent_id
  where frontier_relation.evidence_status <> 'disproven'
    and (
      frontier_relation.privacy_status <> 'confidential'
      or can_view_private
    );

  create temporary table _descendants_relations (
    relation_id uuid primary key,
    parent_set_id uuid not null,
    parent_id uuid not null,
    child_id uuid not null,
    relationship_type text not null,
    parent_role_label text not null,
    is_primary_for_display boolean not null,
    privacy_status text not null
  ) on commit drop;

  insert into _descendants_relations (
    relation_id,
    parent_set_id,
    parent_id,
    child_id,
    relationship_type,
    parent_role_label,
    is_primary_for_display,
    privacy_status
  )
  select
    relation.id,
    relation.parent_set_id,
    relation.parent_id,
    relation.child_id,
    relation.relationship_type,
    relation.parent_role_label,
    relation.is_primary_for_display,
    relation.privacy_status
  from _descendants_parent_sets parent_set
  join public.parent_child_relationships relation
    on relation.tree_id = requested_tree_id
   and relation.parent_set_id = parent_set.parent_set_id
   and relation.child_id = parent_set.child_id
  join public.family_tree_persons parent_member
    on parent_member.tree_id = requested_tree_id
   and parent_member.person_id = relation.parent_id
   and parent_member.member_role <> 'hidden'
  join public.family_tree_persons child_member
    on child_member.tree_id = requested_tree_id
   and child_member.person_id = relation.child_id
   and child_member.member_role <> 'hidden'
  where relation.evidence_status <> 'disproven'
    and (
      relation.privacy_status <> 'confidential'
      or can_view_private
    );

  select coalesce(
    jsonb_agg(person_json order by person_rank, person_order, person_id),
    '[]'::jsonb
  )
    into persons_payload
  from (
    with payload_person_ids as (
      select
        page.child_id as person_id,
        0 as person_rank,
        page.page_order as person_order
      from _descendants_page page

      union all

      select
        relation.parent_id,
        1,
        min(page.page_order)
      from _descendants_relations relation
      join _descendants_page page
        on page.child_id = relation.child_id
      where not exists (
        select 1
        from _descendants_frontier frontier
        where frontier.person_id = relation.parent_id
      )
      group by relation.parent_id
    ), canonical_payload_people as (
      select
        payload_person.person_id,
        min(payload_person.person_rank) as person_rank,
        min(payload_person.person_order) as person_order
      from payload_person_ids payload_person
      group by payload_person.person_id
    )
    select
      payload_person.person_id,
      payload_person.person_rank,
      payload_person.person_order,
      jsonb_strip_nulls(jsonb_build_object(
        'id', person.id,
        'displayName', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private
          then 'Приватна особа'
          else coalesce(
            nullif(person.full_name, ''),
            nullif(trim(concat_ws(
              ' ',
              person.surname,
              person.given_name,
              person.patronymic
            )), ''),
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
          when lower(person.gender) in ('male', 'm', 'чоловік', 'чоловіча')
            then 'male'
          when lower(person.gender) in ('female', 'f', 'жінка', 'жіноча')
            then 'female'
          when lower(person.gender) in ('other', 'інша', 'інше')
            then 'other'
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
            'display', nullif(coalesce(
              nullif(person.birth_date, ''),
              nullif(person.birth_year_from, ''),
              person.birth_year_to
            ), ''),
            'sort', nullif(coalesce(
              nullif(person.birth_year_from, ''),
              nullif(person.birth_date, ''),
              person.birth_year_to
            ), '')
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
            'display', nullif(coalesce(
              nullif(person.death_date, ''),
              nullif(person.death_year_from, ''),
              person.death_year_to
            ), ''),
            'sort', nullif(coalesce(
              nullif(person.death_year_from, ''),
              nullif(person.death_date, ''),
              person.death_year_to
            ), '')
          ))
        end,
        'isLiving', person.is_living,
        'isPrivate', person.privacy_status in ('private', 'confidential'),
        'displayOrder', lpad(
          (member.display_order::bigint + 1000000000)::text,
          20,
          '0'
        ),
        'badges', case
          when person.is_living
           and person.privacy_status in ('private', 'confidential')
           and not can_view_private
          then jsonb_build_object('privacy', 'masked')
          else null
        end
      )) as person_json
    from canonical_payload_people payload_person
    join public.family_tree_persons member
      on member.tree_id = requested_tree_id
     and member.person_id = payload_person.person_id
     and member.member_role <> 'hidden'
    join public.persons person
      on person.id = payload_person.person_id
     and person.project_id = current_project_id
  ) payload;

  with page_parent_pairs as materialized (
    select distinct
      least(relation_a.parent_id, relation_b.parent_id) as parent_a_id,
      greatest(relation_a.parent_id, relation_b.parent_id) as parent_b_id,
      parent_set.family_group_id
    from _descendants_parent_sets parent_set
    join _descendants_relations relation_a
      on relation_a.parent_set_id = parent_set.parent_set_id
    join _descendants_relations relation_b
      on relation_b.parent_set_id = parent_set.parent_set_id
     and relation_a.parent_id < relation_b.parent_id
  ), partnership_unions as (
    select distinct
      '0:' || partnership.id::text as sort_key,
      jsonb_strip_nulls(jsonb_build_object(
        'id', 'partnership:' || partnership.id::text,
        'kind', 'partnership',
        'memberIds', jsonb_build_array(
          partnership.person_a_id,
          partnership.person_b_id
        ),
        'familyGroupId', partnership.family_group_id,
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
          when partnership.relationship_type = 'marriage'
           and partnership.status = 'active' then 'married'
          when partnership.relationship_type = 'separated' then 'separated'
          when partnership.relationship_type = 'divorced' then 'divorced'
          when partnership.status = 'ended' then 'ended'
          when partnership.status = 'active' then 'current'
          else 'unknown'
        end,
        'startDate', case
          when partnership.start_date = '' or (
            not can_view_private and (
              (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
              or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
            )
          ) then null
          else jsonb_build_object(
            'display', partnership.start_date,
            'sort', partnership.start_date
          )
        end,
        'endDate', case
          when partnership.end_date = '' or (
            not can_view_private and (
              (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
              or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
            )
          ) then null
          else jsonb_build_object(
            'display', partnership.end_date,
            'sort', partnership.end_date
          )
        end
      )) as union_json
    from page_parent_pairs parent_pair
    join public.partner_relationships partnership
      on partnership.tree_id = requested_tree_id
     and least(partnership.person_a_id, partnership.person_b_id)
       = parent_pair.parent_a_id
     and greatest(partnership.person_a_id, partnership.person_b_id)
       = parent_pair.parent_b_id
     and (
       parent_pair.family_group_id is null
       or parent_pair.family_group_id = partnership.family_group_id
     )
    join public.persons person_a
      on person_a.id = partnership.person_a_id
     and person_a.project_id = current_project_id
    join public.persons person_b
      on person_b.id = partnership.person_b_id
     and person_b.project_id = current_project_id
    where partnership.evidence_status <> 'disproven'
      and (
        partnership.privacy_status <> 'confidential'
        or can_view_private
      )
  ), parent_set_unions as (
    select
      '1:' || parent_set.parent_set_id::text as sort_key,
      jsonb_strip_nulls(jsonb_build_object(
        'id', 'parent-set:' || parent_set.parent_set_id::text,
        'kind', 'parent-set',
        'parentSetType', case
          when not can_view_private and (
            exists (
              select 1
              from public.persons private_child
              where private_child.id = parent_set.child_id
                and private_child.project_id = current_project_id
                and private_child.is_living
                and private_child.privacy_status in ('private', 'confidential')
            )
            or exists (
              select 1
              from _descendants_relations private_relation
              join public.persons private_parent
                on private_parent.id = private_relation.parent_id
               and private_parent.project_id = current_project_id
              where private_relation.parent_set_id = parent_set.parent_set_id
                and private_parent.is_living
                and private_parent.privacy_status in ('private', 'confidential')
            )
          ) then 'unknown'
          else parent_set.set_type
        end,
        'isPreferredForDisplay', parent_set.is_preferred_for_display,
        'isDefaultForPedigree', parent_set.is_default_for_pedigree,
        'memberIds', coalesce((
          select jsonb_agg(
            relation.parent_id
            order by
              case relation.parent_role_label
                when 'father' then 0
                when 'mother' then 1
                else 2
              end,
              relation.relation_id
          )
          from _descendants_relations relation
          where relation.parent_set_id = parent_set.parent_set_id
        ), '[]'::jsonb),
        'familyGroupId', parent_set.family_group_id,
        'displayOrder', lpad(
          (parent_set.display_order::bigint + 1000000000)::text,
          20,
          '0'
        ),
        'expectedParentSlots', 2
      )) as union_json
    from _descendants_parent_sets parent_set
  ), union_rows as (
    select * from partnership_unions
    union all
    select * from parent_set_unions
  )
  select coalesce(
    jsonb_agg(union_json order by sort_key),
    '[]'::jsonb
  )
    into unions_payload
  from union_rows;

  select coalesce(
    jsonb_agg(relation_json order by page_order, display_order, relation_id),
    '[]'::jsonb
  )
    into relations_payload
  from (
    select
      page.page_order,
      parent_set.display_order,
      relation.relation_id,
      jsonb_strip_nulls(jsonb_build_object(
        'id', relation.relation_id,
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
        'displayOrder', lpad(
          (parent_set.display_order::bigint + 1000000000)::text,
          20,
          '0'
        ),
        'isPreferred', relation.is_primary_for_display
          or parent_set.is_preferred_for_display
          or parent_set.is_default_for_pedigree
      )) as relation_json
    from _descendants_relations relation
    join _descendants_parent_sets parent_set
      on parent_set.parent_set_id = relation.parent_set_id
    join _descendants_page page
      on page.child_id = relation.child_id
    join public.persons parent_person
      on parent_person.id = relation.parent_id
     and parent_person.project_id = current_project_id
    join public.persons child_person
      on child_person.id = relation.child_id
     and child_person.project_id = current_project_id
  ) payload;

  if has_more and returned_count > 0 then
    select public.family_tree_cursor_encode(jsonb_build_object(
      'version', 1,
      'kind', 'descendants-frontier',
      'treeId', requested_tree_id,
      'rootPersonId', requested_root_person_id,
      'generation', requested_generation,
      'frontierDigest', frontier_digest,
      'graphVersion', current_graph_version,
      'permissionFingerprint', permission_fingerprint,
      'afterChildId', page.child_id,
      'pageNumber', cursor_page_number + 1
    ))
      into next_cursor
    from _descendants_page page
    order by page.page_order desc
    limit 1;
  end if;

  select jsonb_build_object(
    'generation', requested_generation + 1,
    'personIds', coalesce(
      jsonb_agg(page.child_id order by page.page_order),
      '[]'::jsonb
    )
  )
    into next_frontier_payload
  from _descendants_page page;

  progress_payload := jsonb_build_object(
    'currentGeneration', requested_generation,
    'nextGeneration', requested_generation + 1,
    'frontierCount', cardinality(requested_frontier_ids),
    'pageSize', requested_page_size,
    'pageNumber', cursor_page_number + 1,
    'returnedDescendantCount', returned_count,
    'returnedPersonCount', jsonb_array_length(persons_payload),
    'returnedUnionCount', jsonb_array_length(unions_payload),
    'returnedRelationCount', jsonb_array_length(relations_payload),
    'frontierComplete', not has_more
  );

  return jsonb_build_object(
    'persons', persons_payload,
    'unions', unions_payload,
    'parentChildRelations', relations_payload,
    'continuations', '[]'::jsonb,
    'nextFrontier', next_frontier_payload,
    'hasMore', has_more,
    'progress', progress_payload,
    'graphVersion', current_graph_version::text,
    'permissionFingerprint', permission_fingerprint
  ) || case
    when next_cursor is not null
      then jsonb_build_object('nextCursor', next_cursor)
    else '{}'::jsonb
  end;
end;
$$;

comment on function public.get_family_tree_descendants_frontier_v1(jsonb) is
  'Authenticated stateless BFS page for one <=200-person descendant frontier; returns <=200 direct descendants plus mergeable graph connectors.';

revoke execute on function public.get_family_tree_descendants_frontier_v1(jsonb)
  from public, anon;
grant execute on function public.get_family_tree_descendants_frontier_v1(jsonb)
  to authenticated;

commit;
