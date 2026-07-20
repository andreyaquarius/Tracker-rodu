begin;

-- The regular neighborhood RPC deliberately discovers parents, partners,
-- children, siblings and continuations.  A root-lineage overlay needs none of
-- that breadth: it only needs the focus person and the transitive parent
-- closure.  Keep this implementation separate so a 16-generation overlay
-- cannot spend its statement budget building data that the overlay discards.
create or replace function security_private.get_family_tree_root_lineage_v1(
  p_request jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
set statement_timeout = '15s'
as $implementation$
declare
  requested_tree_id uuid;
  requested_focus_id uuid;
  requested_ancestor_depth integer;
  requested_max_nodes integer;
  current_project_id uuid;
  current_graph_version bigint;
  project_member_role text;
  can_view_private boolean;
  permission_fingerprint text;
  current_depth integer;
  selected_count integer;
  inserted_count integer;
  persons_payload jsonb;
  unions_payload jsonb;
  relations_payload jsonb;
begin
  -- This function is SECURITY DEFINER and therefore must enforce both the
  -- private feature entitlement and the ordinary project read boundary.
  perform public.assert_family_tree_feature_access();

  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;

  if p_request is null
     or jsonb_typeof(p_request) <> 'object'
     or not (p_request ?& array['treeId', 'focusPersonId'])
     or not pg_input_is_valid(coalesce(p_request ->> 'treeId', ''), 'uuid')
     or not pg_input_is_valid(
       coalesce(p_request ->> 'focusPersonId', ''),
       'uuid'
     )
     or (
       p_request ? 'ancestorDepth'
       and not pg_input_is_valid(
         coalesce(p_request ->> 'ancestorDepth', ''),
         'integer'
       )
     )
     or (
       p_request ? 'maxNodes'
       and not pg_input_is_valid(
         coalesce(p_request ->> 'maxNodes', ''),
         'integer'
       )
     ) then
    raise exception 'INVALID_ROOT_LINEAGE_REQUEST' using errcode = '22023';
  end if;

  requested_tree_id := (p_request ->> 'treeId')::uuid;
  requested_focus_id := (p_request ->> 'focusPersonId')::uuid;
  requested_ancestor_depth := greatest(
    0,
    least(coalesce((p_request ->> 'ancestorDepth')::integer, 16), 16)
  );
  requested_max_nodes := greatest(
    1,
    least(coalesce((p_request ->> 'maxNodes')::integer, 600), 600)
  );

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
    from public.family_tree_persons member
    where member.tree_id = requested_tree_id
      and member.person_id = requested_focus_id
      and member.member_role <> 'hidden'
  ) then
    raise exception 'FOCUS_PERSON_NOT_IN_TREE' using errcode = '22023';
  end if;

  drop table if exists pg_temp._root_lineage_next;
  drop table if exists pg_temp._root_lineage_frontier;
  drop table if exists pg_temp._root_lineage_selected;

  create temporary table _root_lineage_selected (
    person_id uuid primary key,
    ancestor_depth integer not null
  ) on commit drop;
  create temporary table _root_lineage_frontier (
    person_id uuid primary key
  ) on commit drop;
  create temporary table _root_lineage_next (
    person_id uuid primary key
  ) on commit drop;

  insert into _root_lineage_selected (person_id, ancestor_depth)
  values (requested_focus_id, 0);
  insert into _root_lineage_frontier (person_id)
  values (requested_focus_id);

  -- Each pass follows only readable parent -> child edges in the upward
  -- direction.  The selected table deduplicates pedigree collapse, and the
  -- frontier plus node budget keeps every pass bounded.
  if requested_ancestor_depth > 0 then
    for current_depth in 1..requested_ancestor_depth loop
      select count(*)::integer
        into selected_count
      from _root_lineage_selected;
      exit when selected_count >= requested_max_nodes;

      truncate table _root_lineage_next;

      with parent_candidates as materialized (
        select distinct on (relation.parent_id)
          relation.parent_id,
          parent_set.display_order,
          coalesce(relation.start_date, '') as relation_date,
          relation.id as relationship_id
        from _root_lineage_frontier frontier
        join public.parent_child_relationships relation
          on relation.tree_id = requested_tree_id
         and relation.child_id = frontier.person_id
        join public.parent_sets parent_set
          on parent_set.id = relation.parent_set_id
         and parent_set.tree_id = relation.tree_id
         and parent_set.child_id = relation.child_id
        join public.family_tree_persons parent_member
          on parent_member.tree_id = requested_tree_id
         and parent_member.person_id = relation.parent_id
         and parent_member.member_role <> 'hidden'
        where relation.evidence_status <> 'disproven'
          and (
            relation.privacy_status <> 'confidential'
            or public.can_edit_project(relation.project_id)
          )
          and not exists (
            select 1
            from _root_lineage_selected selected
            where selected.person_id = relation.parent_id
          )
        order by
          relation.parent_id,
          parent_set.display_order,
          coalesce(relation.start_date, ''),
          relation.id
      ), bounded_candidates as materialized (
        select candidate.parent_id
        from parent_candidates candidate
        order by
          candidate.display_order,
          candidate.relation_date,
          candidate.relationship_id,
          candidate.parent_id
        limit greatest(requested_max_nodes - selected_count, 0)
      ), inserted as (
        insert into _root_lineage_selected (person_id, ancestor_depth)
        select candidate.parent_id, current_depth
        from bounded_candidates candidate
        on conflict (person_id) do nothing
        returning person_id
      )
      insert into _root_lineage_next (person_id)
      select inserted.person_id
      from inserted
      on conflict (person_id) do nothing;

      get diagnostics inserted_count = row_count;
      exit when inserted_count = 0;

      truncate table _root_lineage_frontier;
      insert into _root_lineage_frontier (person_id)
      select next_frontier.person_id
      from _root_lineage_next next_frontier;
    end loop;
  end if;

  select coalesce(jsonb_agg(person_json order by ancestor_depth, display_order, person_id), '[]'::jsonb)
    into persons_payload
  from (
    select
      selected.ancestor_depth,
      member.display_order,
      person.id as person_id,
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
    from _root_lineage_selected selected
    join public.family_tree_persons member
      on member.tree_id = requested_tree_id
     and member.person_id = selected.person_id
     and member.member_role <> 'hidden'
    join public.persons person
      on person.id = selected.person_id
     and person.project_id = current_project_id
  ) payload;

  with union_rows as (
    select
      '0:' || partnership.id::text as sort_key,
      jsonb_strip_nulls(jsonb_build_object(
        'id', 'partnership:' || partnership.id::text,
        'kind', 'partnership',
        'relationshipType', case
          when not can_view_private and (
            (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
            or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
          ) then 'unknown'
          else partnership.relationship_type
        end,
        'memberIds', jsonb_build_array(partnership.person_a_id, partnership.person_b_id),
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
        ) then null else jsonb_build_object(
          'display', partnership.start_date,
          'sort', partnership.start_date
        ) end,
        'endDate', case when partnership.end_date = '' or (
          not can_view_private and (
            (person_a.is_living and person_a.privacy_status in ('private', 'confidential'))
            or (person_b.is_living and person_b.privacy_status in ('private', 'confidential'))
          )
        ) then null else jsonb_build_object(
          'display', partnership.end_date,
          'sort', partnership.end_date
        ) end,
        'displayOrder', lpad((coalesce(partner_order.display_order, 0)::bigint + 1000000000)::text, 20, '0')
      )) as union_json
    from public.partner_relationships partnership
    join public.persons person_a
      on person_a.id = partnership.person_a_id
     and person_a.project_id = partnership.project_id
    join public.persons person_b
      on person_b.id = partnership.person_b_id
     and person_b.project_id = partnership.project_id
    left join lateral (
      select min(member.display_order) as display_order
      from public.family_group_members member
      where member.family_group_id = partnership.family_group_id
        and member.member_role = 'partner'
    ) partner_order on true
    where partnership.tree_id = requested_tree_id
      and partnership.evidence_status <> 'disproven'
      and (
        partnership.privacy_status <> 'confidential'
        or public.can_edit_project(partnership.project_id)
      )
      and exists (
        select 1 from _root_lineage_selected
        where person_id = partnership.person_a_id
      )
      and exists (
        select 1 from _root_lineage_selected
        where person_id = partnership.person_b_id
      )

    union all

    select
      '1:' || parent_set.id::text,
      jsonb_build_object(
        'id', 'parent-set:' || parent_set.id::text,
        'kind', 'parent-set',
        'parentSetType', case
          when not can_view_private and (
            (set_child.is_living and set_child.privacy_status in ('private', 'confidential'))
            or exists (
              select 1
              from public.parent_child_relationships private_relation
              join public.persons private_parent
                on private_parent.id = private_relation.parent_id
               and private_parent.project_id = private_relation.project_id
              where private_relation.parent_set_id = parent_set.id
                and private_parent.is_living
                and private_parent.privacy_status in ('private', 'confidential')
            )
          ) then 'unknown'
          else parent_set.set_type
        end,
        'isPreferredForDisplay', parent_set.is_preferred_for_display,
        'isDefaultForPedigree', parent_set.is_default_for_pedigree,
        'memberIds', coalesce((
          select jsonb_agg(relation.parent_id order by
            case relation.parent_role_label
              when 'father' then 0
              when 'mother' then 1
              else 2
            end,
            relation.id
          )
          from public.parent_child_relationships relation
          where relation.parent_set_id = parent_set.id
            and relation.evidence_status <> 'disproven'
            and (
              relation.privacy_status <> 'confidential'
              or public.can_edit_project(relation.project_id)
            )
            and exists (
              select 1 from _root_lineage_selected selected
              where selected.person_id = relation.parent_id
            )
        ), '[]'::jsonb),
        'displayOrder', lpad((parent_set.display_order::bigint + 1000000000)::text, 20, '0'),
        'expectedParentSlots', 2
      )
    from public.parent_sets parent_set
    join public.persons set_child
      on set_child.id = parent_set.child_id
     and set_child.project_id = parent_set.project_id
    where parent_set.tree_id = requested_tree_id
      and exists (
        select 1
        from public.parent_child_relationships relation
        where relation.parent_set_id = parent_set.id
          and relation.evidence_status <> 'disproven'
          and (
            relation.privacy_status <> 'confidential'
            or public.can_edit_project(relation.project_id)
          )
          and exists (
            select 1 from _root_lineage_selected
            where person_id = relation.parent_id
          )
          and exists (
            select 1 from _root_lineage_selected
            where person_id = relation.child_id
          )
      )
  )
  select coalesce(jsonb_agg(union_json order by sort_key), '[]'::jsonb)
    into unions_payload
  from union_rows;

  select coalesce(jsonb_agg(relation_json order by sort_key), '[]'::jsonb)
    into relations_payload
  from (
    select
      lpad((parent_set.display_order::bigint + 1000000000)::text, 20, '0')
        || ':' || relation.id::text as sort_key,
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
    from public.parent_child_relationships relation
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    join public.persons parent_person
      on parent_person.id = relation.parent_id
     and parent_person.project_id = relation.project_id
    join public.persons child_person
      on child_person.id = relation.child_id
     and child_person.project_id = relation.project_id
    where relation.tree_id = requested_tree_id
      and relation.evidence_status <> 'disproven'
      and (
        relation.privacy_status <> 'confidential'
        or public.can_edit_project(relation.project_id)
      )
      and exists (
        select 1 from _root_lineage_selected
        where person_id = relation.parent_id
      )
      and exists (
        select 1 from _root_lineage_selected
        where person_id = relation.child_id
      )
  ) payload;

  return jsonb_build_object(
    'persons', persons_payload,
    'unions', unions_payload,
    'parentChildRelations', relations_payload,
    'continuations', '[]'::jsonb,
    'familyContinuations', '[]'::jsonb,
    'graphVersion', current_graph_version::text,
    'permissionFingerprint', permission_fingerprint
  );
end;
$implementation$;

-- Follow the post-202607150001 API shape: the elevated implementation lives
-- outside exposed schemas and public contains only an invoker facade.
revoke all on function security_private.get_family_tree_root_lineage_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_family_tree_root_lineage_v1(jsonb)
  to authenticated, service_role;

create or replace function public.get_family_tree_root_lineage_v1(p_request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_family_tree_root_lineage_v1($1);
$wrapper$;

revoke all on function public.get_family_tree_root_lineage_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.get_family_tree_root_lineage_v1(jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
