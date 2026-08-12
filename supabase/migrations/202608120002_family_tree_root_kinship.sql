begin;

-- Return one nearest, deterministic relationship for every visible member of
-- a tree relative to the persisted root person. The traversal is independent
-- from the workspace focus and from graph/rendering node limits.
create or replace function security_private.list_family_tree_root_kinship_v1(
  target_tree_id uuid,
  target_root_person_id uuid
)
returns table (
  person_id uuid,
  kinship_kind text,
  up_steps integer,
  down_steps integer,
  partner_steps integer,
  order_path text,
  via_person_id uuid
)
language plpgsql
volatile
security definer
set search_path = pg_temp, public
set statement_timeout = '30s'
as $implementation$
#variable_conflict use_column
declare
  current_project_id uuid;
  persisted_root_person_id uuid;
  inserted_count integer;
begin
  perform public.assert_family_tree_feature_access();

  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if target_tree_id is null or target_root_person_id is null then
    raise exception 'INVALID_ROOT_KINSHIP_REQUEST' using errcode = '22023';
  end if;

  select tree.project_id, tree.root_person_id
    into current_project_id, persisted_root_person_id
  from public.family_trees tree
  where tree.id = target_tree_id
  for share;

  if current_project_id is null
     or not public.is_project_member(current_project_id) then
    raise exception 'TREE_NOT_FOUND_OR_FORBIDDEN' using errcode = '42501';
  end if;
  if persisted_root_person_id is null
     or persisted_root_person_id <> target_root_person_id then
    raise exception 'TREE_ROOT_CHANGED' using errcode = '40001';
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

  drop table if exists pg_temp._root_kinship_parent_edges;
  drop table if exists pg_temp._root_kinship_up_next;
  drop table if exists pg_temp._root_kinship_up_frontier;
  drop table if exists pg_temp._root_kinship_sources;
  drop table if exists pg_temp._root_kinship_down_next;
  drop table if exists pg_temp._root_kinship_down_frontier;
  drop table if exists pg_temp._root_kinship_best;

  create temporary table _root_kinship_parent_edges (
    parent_id uuid not null,
    child_id uuid not null,
    edge_order text not null,
    primary key (parent_id, child_id)
  ) on commit drop;

  -- Keep kinship consistent with the pedigree: for children with several
  -- biological/adoptive parent sets, use the same preferred set selection as
  -- the canonical direct-ancestor order.
  insert into _root_kinship_parent_edges (parent_id, child_id, edge_order)
  select distinct on (relation.parent_id, relation.child_id)
    relation.parent_id,
    relation.child_id,
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
        'genetic_mother', 'gestational_parent', 'birth_parent', 'surrogate'
      ) or lower(parent_person.gender) in (
        'female', 'f', 'жінка', 'жіноча'
      ) then '1'
      else '2'
    end || ':' || relation.id::text
  from public.family_tree_persons child_member
  join lateral (
    select parent_set.id
    from public.parent_sets parent_set
    where parent_set.tree_id = target_tree_id
      and parent_set.child_id = child_member.person_id
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
  join public.parent_child_relationships relation
    on relation.parent_set_id = chosen_parent_set.id
   and relation.tree_id = target_tree_id
   and relation.child_id = child_member.person_id
  join public.family_tree_persons parent_member
    on parent_member.tree_id = target_tree_id
   and parent_member.person_id = relation.parent_id
   and parent_member.member_role <> 'hidden'
  join public.persons parent_person
    on parent_person.id = relation.parent_id
   and parent_person.project_id = current_project_id
  where child_member.tree_id = target_tree_id
    and child_member.member_role <> 'hidden'
    and relation.evidence_status <> 'disproven'
    and (
      relation.privacy_status <> 'confidential'
      or public.can_edit_project(relation.project_id)
    )
  order by
    relation.parent_id,
    relation.child_id,
    relation.is_primary_for_display desc,
    relation.id;

  create temporary table _root_kinship_sources (
    person_id uuid primary key,
    up_steps integer not null,
    order_path text not null
  ) on commit drop;
  create temporary table _root_kinship_up_frontier (
    person_id uuid primary key,
    up_steps integer not null,
    order_path text not null
  ) on commit drop;
  create temporary table _root_kinship_up_next (
    person_id uuid primary key,
    up_steps integer not null,
    order_path text not null
  ) on commit drop;

  insert into _root_kinship_sources (person_id, up_steps, order_path)
  values (target_root_person_id, 0, '');
  insert into _root_kinship_up_frontier (person_id, up_steps, order_path)
  values (target_root_person_id, 0, '');

  loop
    truncate table _root_kinship_up_next;
    with candidates as materialized (
      select distinct on (edge.parent_id)
        edge.parent_id as person_id,
        frontier.up_steps + 1 as up_steps,
        frontier.order_path || '/' || edge.edge_order as order_path
      from _root_kinship_up_frontier frontier
      join _root_kinship_parent_edges edge
        on edge.child_id = frontier.person_id
      where not exists (
        select 1
        from _root_kinship_sources selected
        where selected.person_id = edge.parent_id
      )
      order by edge.parent_id, up_steps, order_path
    ), inserted as (
      insert into _root_kinship_sources (person_id, up_steps, order_path)
      select candidate.person_id, candidate.up_steps, candidate.order_path
      from candidates candidate
      on conflict (person_id) do nothing
      returning person_id, up_steps, order_path
    )
    insert into _root_kinship_up_next (person_id, up_steps, order_path)
    select inserted.person_id, inserted.up_steps, inserted.order_path
    from inserted;

    get diagnostics inserted_count = row_count;
    exit when inserted_count = 0;

    truncate table _root_kinship_up_frontier;
    insert into _root_kinship_up_frontier (person_id, up_steps, order_path)
    select next_item.person_id, next_item.up_steps, next_item.order_path
    from _root_kinship_up_next next_item;
  end loop;

  create temporary table _root_kinship_best (
    person_id uuid primary key,
    up_steps integer not null,
    down_steps integer not null,
    order_path text not null
  ) on commit drop;
  create temporary table _root_kinship_down_frontier (
    person_id uuid primary key,
    up_steps integer not null,
    down_steps integer not null,
    order_path text not null
  ) on commit drop;
  create temporary table _root_kinship_down_next (
    person_id uuid primary key,
    up_steps integer not null,
    down_steps integer not null,
    order_path text not null
  ) on commit drop;

  insert into _root_kinship_best (person_id, up_steps, down_steps, order_path)
  select source.person_id, source.up_steps, 0, source.order_path
  from _root_kinship_sources source;
  insert into _root_kinship_down_frontier (person_id, up_steps, down_steps, order_path)
  select source.person_id, source.up_steps, 0, source.order_path
  from _root_kinship_sources source;

  loop
    truncate table _root_kinship_down_next;
    with candidates as materialized (
      select distinct on (edge.child_id)
        edge.child_id as person_id,
        frontier.up_steps,
        frontier.down_steps + 1 as down_steps,
        frontier.order_path || '>' || edge.edge_order as order_path
      from _root_kinship_down_frontier frontier
      join _root_kinship_parent_edges edge
        on edge.parent_id = frontier.person_id
      order by
        edge.child_id,
        frontier.up_steps + frontier.down_steps + 1,
        greatest(frontier.up_steps, frontier.down_steps + 1),
        frontier.up_steps,
        order_path
    ), inserted as (
      insert into _root_kinship_best (person_id, up_steps, down_steps, order_path)
      select candidate.person_id, candidate.up_steps, candidate.down_steps, candidate.order_path
      from candidates candidate
      on conflict (person_id) do update
      set
        up_steps = excluded.up_steps,
        down_steps = excluded.down_steps,
        order_path = excluded.order_path
      where
        -- A pedigree-collapse ancestor can also be reachable by a shorter
        -- collateral path. Its direct-line status must remain authoritative.
        _root_kinship_best.down_steps <> 0
        and
        (excluded.up_steps + excluded.down_steps,
         greatest(excluded.up_steps, excluded.down_steps),
         excluded.up_steps,
         excluded.order_path)
        <
        (_root_kinship_best.up_steps + _root_kinship_best.down_steps,
         greatest(_root_kinship_best.up_steps, _root_kinship_best.down_steps),
         _root_kinship_best.up_steps,
         _root_kinship_best.order_path)
      returning person_id, up_steps, down_steps, order_path
    )
    insert into _root_kinship_down_next (person_id, up_steps, down_steps, order_path)
    select inserted.person_id, inserted.up_steps, inserted.down_steps, inserted.order_path
    from inserted;

    get diagnostics inserted_count = row_count;
    exit when inserted_count = 0;

    truncate table _root_kinship_down_frontier;
    insert into _root_kinship_down_frontier (person_id, up_steps, down_steps, order_path)
    select next_item.person_id, next_item.up_steps, next_item.down_steps, next_item.order_path
    from _root_kinship_down_next next_item;
  end loop;

  return query
  select
    combined.person_id,
    combined.kinship_kind,
    combined.up_steps,
    combined.down_steps,
    combined.partner_steps,
    combined.order_path,
    combined.via_person_id
  from (
    select
      best.person_id,
      case
        when best.up_steps = 0 and best.down_steps = 0 then 'root'
        when best.down_steps = 0 then 'ancestor'
        when best.up_steps = 0 then 'descendant'
        else 'collateral'
      end as kinship_kind,
      best.up_steps,
      best.down_steps,
      0 as partner_steps,
      best.order_path,
      null::uuid as via_person_id
    from _root_kinship_best best

    union all

    select
      affinal.person_id,
      'affinal'::text as kinship_kind,
      affinal.up_steps,
      affinal.down_steps,
      1 as partner_steps,
      affinal.order_path,
      affinal.via_person_id
    from (
      select distinct on (partner_person.person_id)
        partner_person.person_id,
        blood.up_steps,
        blood.down_steps,
        blood.order_path || '~' || partner.id::text as order_path,
        blood.person_id as via_person_id
      from public.partner_relationships partner
      join _root_kinship_best blood
        on blood.person_id in (partner.person_a_id, partner.person_b_id)
      join lateral (
        select case
          when partner.person_a_id = blood.person_id then partner.person_b_id
          else partner.person_a_id
        end as person_id
      ) partner_person on true
      join public.family_tree_persons member
        on member.tree_id = target_tree_id
       and member.person_id = partner_person.person_id
       and member.member_role <> 'hidden'
      where partner.tree_id = target_tree_id
        and partner.evidence_status <> 'disproven'
        and (
          partner.privacy_status <> 'confidential'
          or public.can_edit_project(partner.project_id)
        )
        and not exists (
          select 1
          from _root_kinship_best already_blood
          where already_blood.person_id = partner_person.person_id
        )
      order by
        partner_person.person_id,
        blood.up_steps + blood.down_steps + 1,
        greatest(blood.up_steps, blood.down_steps),
        blood.up_steps,
        blood.order_path,
        partner.id
    ) affinal
  ) combined
  order by
    combined.up_steps + combined.down_steps + combined.partner_steps,
    combined.order_path,
    combined.person_id;
end;
$implementation$;

revoke all on function security_private.list_family_tree_root_kinship_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_family_tree_root_kinship_v1(uuid, uuid)
  to authenticated, service_role;

create or replace function public.list_family_tree_root_kinship_v1(
  target_tree_id uuid,
  target_root_person_id uuid
)
returns table (
  person_id uuid,
  kinship_kind text,
  up_steps integer,
  down_steps integer,
  partner_steps integer,
  order_path text,
  via_person_id uuid
)
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select *
  from security_private.list_family_tree_root_kinship_v1($1, $2);
$wrapper$;

revoke all on function public.list_family_tree_root_kinship_v1(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_family_tree_root_kinship_v1(uuid, uuid)
  to authenticated, service_role;

comment on function public.list_family_tree_root_kinship_v1(uuid, uuid) is
  'Nearest RLS-aware blood or one-partner kinship to the persisted family-tree root.';

notify pgrst, 'reload schema';

commit;
