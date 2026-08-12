begin;

-- The original structural lineage RPC was intentionally capped at 600 nodes.
-- That made a valid tree with more than 599 unique ancestors look incomplete
-- (the root person occupied the 600th slot in the budget). Keep the ordinary
-- interactive tree limit in the client, but let the dedicated 16-generation
-- structural views load up to the occurrence budget they already enforce.
do $migration$
declare
  function_oid oid;
  function_definition text;
  updated_definition text;
  old_limit constant text :=
    'least(coalesce((p_request ->> ''maxNodes'')::integer, 600), 600)';
  new_limit constant text :=
    'least(coalesce((p_request ->> ''maxNodes'')::integer, 2400), 2400)';
begin
  function_oid := to_regprocedure(
    'security_private.get_family_tree_root_lineage_v1(jsonb)'
  )::oid;
  if function_oid is null then
    raise exception 'ROOT_LINEAGE_FUNCTION_MISSING';
  end if;

  select pg_get_functiondef(function_oid)
    into function_definition;
  if position(new_limit in function_definition) = 0 then
    updated_definition := replace(function_definition, old_limit, new_limit);
    if updated_definition = function_definition then
      raise exception 'ROOT_LINEAGE_LIMIT_CONTRACT_CHANGED';
    end if;
    execute updated_definition;
  end if;
end;
$migration$;

comment on function security_private.get_family_tree_root_lineage_v1(jsonb) is
  'Privacy-filtered direct-ancestor graph, depth <= 16 and unique nodes <= 2400.';

-- Catalogue sorting needs the complete unique ancestor closure, not a graph
-- payload bounded for rendering. This RPC returns only IDs plus stable BFS
-- ordering, so even a Researcher plan with thousands of people does not
-- download a second copy of every person record.
create or replace function security_private.list_family_tree_direct_ancestor_order_v1(
  target_tree_id uuid,
  target_root_person_id uuid
)
returns table (
  person_id uuid,
  generation integer,
  order_path text
)
language plpgsql
volatile
security definer
set search_path = pg_temp, public
set statement_timeout = '30s'
as $implementation$
declare
  current_project_id uuid;
  selected_count integer;
  inserted_count integer;
  max_unique_people integer;
begin
  perform public.assert_family_tree_feature_access();

  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if target_tree_id is null or target_root_person_id is null then
    raise exception 'INVALID_DIRECT_ANCESTOR_ORDER_REQUEST'
      using errcode = '22023';
  end if;

  select tree.project_id
    into current_project_id
  from public.family_trees tree
  where tree.id = target_tree_id
  for share;

  if current_project_id is null
     or not public.is_project_member(current_project_id) then
    raise exception 'TREE_NOT_FOUND_OR_FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.family_tree_persons member
    where member.tree_id = target_tree_id
      and member.person_id = target_root_person_id
      and member.member_role <> 'hidden'
  ) then
    raise exception 'ROOT_PERSON_NOT_IN_TREE' using errcode = '22023';
  end if;

  select count(*)::integer
    into max_unique_people
  from public.family_tree_persons member
  where member.tree_id = target_tree_id
    and member.member_role <> 'hidden';

  drop table if exists pg_temp._ancestor_order_next;
  drop table if exists pg_temp._ancestor_order_frontier;
  drop table if exists pg_temp._ancestor_order_selected;

  create temporary table _ancestor_order_selected (
    person_id uuid primary key,
    generation integer not null,
    order_path text not null
  ) on commit drop;
  create temporary table _ancestor_order_frontier (
    person_id uuid primary key,
    generation integer not null,
    order_path text not null
  ) on commit drop;
  create temporary table _ancestor_order_next (
    person_id uuid primary key,
    generation integer not null,
    order_path text not null
  ) on commit drop;

  insert into _ancestor_order_selected (person_id, generation, order_path)
  values (target_root_person_id, 0, '');
  insert into _ancestor_order_frontier (person_id, generation, order_path)
  values (target_root_person_id, 0, '');

  loop
    select count(*)::integer
      into selected_count
    from _ancestor_order_selected;
    -- The tree membership count is the natural hard bound. This keeps the
    -- traversal complete for every tariff while cycles are still finite.
    exit when selected_count >= max_unique_people;

    truncate table _ancestor_order_next;
    with chosen_parent_sets as materialized (
      select
        frontier.person_id as child_id,
        frontier.generation,
        frontier.order_path,
        chosen_parent_set.id as parent_set_id
      from _ancestor_order_frontier frontier
      join lateral (
        select parent_set.id
        from public.parent_sets parent_set
        where parent_set.tree_id = target_tree_id
          and parent_set.child_id = frontier.person_id
          and exists (
            select 1
            from public.parent_child_relationships candidate_relation
            join public.family_tree_persons candidate_parent
              on candidate_parent.tree_id = target_tree_id
             and candidate_parent.person_id = candidate_relation.parent_id
             and candidate_parent.member_role <> 'hidden'
            where candidate_relation.parent_set_id = parent_set.id
              and candidate_relation.evidence_status <> 'disproven'
              and (
                candidate_relation.privacy_status <> 'confidential'
                or public.can_edit_project(candidate_relation.project_id)
              )
          )
        order by
          parent_set.is_default_for_pedigree desc,
          exists (
            select 1
            from public.parent_child_relationships preferred_relation
            where preferred_relation.parent_set_id = parent_set.id
              and preferred_relation.is_primary_for_display
              and preferred_relation.evidence_status <> 'disproven'
              and (
                preferred_relation.privacy_status <> 'confidential'
                or public.can_edit_project(preferred_relation.project_id)
              )
          ) desc,
          parent_set.is_preferred_for_display desc,
          coalesce((
            select min(case relation_kind.relationship_type
              when 'biological' then 0
              when 'genetic_father' then 1
              when 'genetic_mother' then 1
              when 'gestational_parent' then 1
              when 'birth_parent' then 1
              when 'presumed' then 2
              when 'adoptive' then 3
              when 'legal_parent' then 4
              when 'social_parent' then 5
              when 'foster' then 6
              when 'guardian' then 7
              when 'step' then 8
              when 'donor' then 9
              when 'surrogate' then 10
              when 'unknown' then 11
              else 12
            end)
            from public.parent_child_relationships relation_kind
            where relation_kind.parent_set_id = parent_set.id
              and relation_kind.evidence_status <> 'disproven'
          ), 2147483647),
          parent_set.display_order,
          parent_set.id
        limit 1
      ) chosen_parent_set on true
    ), parent_candidates as materialized (
      select distinct on (relation.parent_id)
        relation.parent_id,
        chosen.generation + 1 as generation,
        chosen.order_path || '/' ||
          case
            when relation.parent_role_label in (
              'father', 'adoptive_father', 'stepfather'
            ) or relation.relationship_type = 'genetic_father'
              or lower(parent_person.gender) in (
                'male', 'm', 'чоловік', 'чоловіча'
              ) then '0'
            when relation.parent_role_label in (
              'mother', 'adoptive_mother', 'stepmother'
            ) or relation.relationship_type in (
              'genetic_mother', 'gestational_parent', 'birth_parent',
              'surrogate'
            ) or lower(parent_person.gender) in (
              'female', 'f', 'жінка', 'жіноча'
            ) then '1'
            else '2'
          end || ':' || relation.id::text as order_path,
        relation.id as relationship_id
      from chosen_parent_sets chosen
      join public.parent_child_relationships relation
        on relation.parent_set_id = chosen.parent_set_id
       and relation.tree_id = target_tree_id
       and relation.child_id = chosen.child_id
      join public.family_tree_persons parent_member
        on parent_member.tree_id = target_tree_id
       and parent_member.person_id = relation.parent_id
       and parent_member.member_role <> 'hidden'
      join public.persons parent_person
        on parent_person.id = relation.parent_id
       and parent_person.project_id = current_project_id
      where relation.evidence_status <> 'disproven'
        and (
          relation.privacy_status <> 'confidential'
          or public.can_edit_project(relation.project_id)
        )
        and not exists (
          select 1
          from _ancestor_order_selected selected
          where selected.person_id = relation.parent_id
        )
      order by
        relation.parent_id,
        order_path,
        relation.is_primary_for_display desc,
        relation.id
    ), bounded_candidates as materialized (
      select
        candidate.parent_id,
        candidate.generation,
        candidate.order_path
      from parent_candidates candidate
      order by candidate.generation, candidate.order_path, candidate.parent_id
      limit greatest(max_unique_people - selected_count, 0)
    ), inserted as (
      insert into _ancestor_order_selected (person_id, generation, order_path)
      select
        candidate.parent_id,
        candidate.generation,
        candidate.order_path
      from bounded_candidates candidate
      on conflict (person_id) do nothing
      returning person_id, generation, order_path
    )
    insert into _ancestor_order_next (person_id, generation, order_path)
    select inserted.person_id, inserted.generation, inserted.order_path
    from inserted
    on conflict (person_id) do nothing;

    get diagnostics inserted_count = row_count;
    exit when inserted_count = 0;

    truncate table _ancestor_order_frontier;
    insert into _ancestor_order_frontier (person_id, generation, order_path)
    select next_item.person_id, next_item.generation, next_item.order_path
    from _ancestor_order_next next_item;
  end loop;

  return query
  select selected.person_id, selected.generation, selected.order_path
  from _ancestor_order_selected selected
  order by selected.generation, selected.order_path, selected.person_id;
end;
$implementation$;

revoke all on function security_private.list_family_tree_direct_ancestor_order_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_family_tree_direct_ancestor_order_v1(uuid, uuid)
  to authenticated, service_role;

create or replace function public.list_family_tree_direct_ancestor_order_v1(
  target_tree_id uuid,
  target_root_person_id uuid
)
returns table (
  person_id uuid,
  generation integer,
  order_path text
)
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select *
  from security_private.list_family_tree_direct_ancestor_order_v1($1, $2);
$wrapper$;

revoke all on function public.list_family_tree_direct_ancestor_order_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_family_tree_direct_ancestor_order_v1(uuid, uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
