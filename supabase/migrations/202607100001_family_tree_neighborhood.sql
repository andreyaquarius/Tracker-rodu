begin;

-- A monotonic version belongs to the tree, not to a renderer cache. It lets a
-- client discard stale neighborhood pages after any structural mutation.
alter table public.family_trees
  add column if not exists graph_version bigint not null default 1;

insert into public.app_feature_flags (key, title, description, is_enabled)
values (
  'family_tree_renderer_v2',
  'Нове родове дерево',
  'Вмикає neighborhood API, Web Worker layout, Canvas-лінії та поступове розкриття гілок.',
  true
)
on conflict (key) do nothing;

create or replace function public.family_tree_bump_graph_version()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_tree_id uuid;
  previous_tree_id uuid;
  target_group_id uuid;
begin
  if tg_table_name = 'family_group_members' then
    target_group_id := case when tg_op = 'DELETE' then old.family_group_id else new.family_group_id end;
    select tree_id into target_tree_id
    from public.family_groups
    where id = target_group_id;
    if tg_op = 'UPDATE' then
      select tree_id into previous_tree_id
      from public.family_groups
      where id = old.family_group_id;
    elsif tg_op = 'DELETE' then
      previous_tree_id := target_tree_id;
    end if;
  else
    target_tree_id := case when tg_op = 'DELETE' then old.tree_id else new.tree_id end;
    previous_tree_id := case when tg_op in ('UPDATE', 'DELETE') then old.tree_id else null end;
  end if;

  update public.family_trees
  set graph_version = graph_version + 1,
      updated_at = now()
  where id in (target_tree_id, previous_tree_id);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.family_tree_bump_person_graph_versions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.family_trees tree
  set graph_version = tree.graph_version + 1,
      updated_at = now()
  where exists (
    select 1
    from public.family_tree_persons member
    where member.tree_id = tree.id
      and member.person_id = new.id
  );
  return new;
end;
$$;

create or replace function public.family_tree_version_root_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.root_person_id is distinct from old.root_person_id then
    new.graph_version := greatest(new.graph_version, old.graph_version + 1);
  end if;
  return new;
end;
$$;

drop trigger if exists family_trees_version_root_change on public.family_trees;
create trigger family_trees_version_root_change
before update of root_person_id on public.family_trees
for each row execute function public.family_tree_version_root_change();

drop trigger if exists family_tree_persons_bump_graph_version on public.family_tree_persons;
create trigger family_tree_persons_bump_graph_version
after insert or update or delete on public.family_tree_persons
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists family_groups_bump_graph_version on public.family_groups;
create trigger family_groups_bump_graph_version
after insert or update or delete on public.family_groups
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists family_group_members_bump_graph_version on public.family_group_members;
create trigger family_group_members_bump_graph_version
after insert or update or delete on public.family_group_members
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists partner_relationships_bump_graph_version on public.partner_relationships;
create trigger partner_relationships_bump_graph_version
after insert or update or delete on public.partner_relationships
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists parent_sets_bump_graph_version on public.parent_sets;
create trigger parent_sets_bump_graph_version
after insert or update or delete on public.parent_sets
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists parent_child_relationships_bump_graph_version on public.parent_child_relationships;
create trigger parent_child_relationships_bump_graph_version
after insert or update or delete on public.parent_child_relationships
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists association_relationships_bump_graph_version on public.association_relationships;
create trigger association_relationships_bump_graph_version
after insert or update or delete on public.association_relationships
for each row execute function public.family_tree_bump_graph_version();

drop trigger if exists persons_bump_family_tree_graph_versions on public.persons;
create trigger persons_bump_family_tree_graph_versions
after update of
  status,
  gender,
  surname,
  given_name,
  patronymic,
  full_name,
  birth_date,
  birth_year_from,
  birth_year_to,
  death_date,
  death_year_from,
  death_year_to,
  is_living,
  privacy_status
on public.persons
for each row execute function public.family_tree_bump_person_graph_versions();

-- Replace the depth-128 guard. UNION over person_id is a visited set, so the
-- traversal terminates on cyclic imported data without a generation ceiling.
create or replace function public.prevent_bloodline_parent_cycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cycle_found boolean;
begin
  -- Every structural write eventually updates this same row through the
  -- version trigger. Taking that row lock first serializes inverse edge checks
  -- without introducing a second lock order that could deadlock.
  -- An edge can move between trees. Lock both rows in UUID order so opposite
  -- concurrent moves cannot acquire A then B / B then A and deadlock.
  if tg_op = 'UPDATE' and old.tree_id is distinct from new.tree_id then
    perform tree.id
    from public.family_trees tree
    where tree.id in (old.tree_id, new.tree_id)
    order by tree.id
    for update;
  else
    perform tree.id
    from public.family_trees tree
    where tree.id = new.tree_id
    for update;
  end if;

  if new.parent_id = new.child_id then
    raise exception 'PARENT_CHILD_SELF_RELATION' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.parent_sets parent_set
    where parent_set.id = new.parent_set_id
      and parent_set.project_id = new.project_id
      and parent_set.tree_id = new.tree_id
      and parent_set.child_id = new.child_id
  ) then
    raise exception 'PARENT_SET_TREE_OR_CHILD_MISMATCH' using errcode = '23514';
  end if;

  if new.family_group_id is not null and not exists (
    select 1
    from public.family_groups family_group
    where family_group.id = new.family_group_id
      and family_group.project_id = new.project_id
      and family_group.tree_id = new.tree_id
  ) then
    raise exception 'FAMILY_GROUP_TREE_MISMATCH' using errcode = '23514';
  end if;

  if new.evidence_status <> 'disproven' then
    with recursive descendants(person_id) as (
      select relation.child_id
      from public.parent_child_relationships relation
      where relation.tree_id = new.tree_id
        and relation.parent_id = new.child_id
        and relation.evidence_status <> 'disproven'
        and relation.id is distinct from new.id

      union

      select relation.child_id
      from public.parent_child_relationships relation
      join descendants on descendants.person_id = relation.parent_id
      where relation.tree_id = new.tree_id
        and relation.evidence_status <> 'disproven'
        and relation.id is distinct from new.id
    )
    select exists (
      select 1
      from descendants
      where person_id = new.parent_id
    ) into cycle_found;

    if cycle_found then
      raise exception 'PARENT_CHILD_CYCLE' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists parent_child_relationships_prevent_cycle
  on public.parent_child_relationships;
create trigger parent_child_relationships_prevent_cycle
before insert or update of
  project_id,
  tree_id,
  parent_id,
  child_id,
  parent_set_id,
  family_group_id,
  is_bloodline,
  evidence_status
on public.parent_child_relationships
for each row execute function public.prevent_bloodline_parent_cycle();

create or replace function public.prevent_parent_set_identity_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1
  from public.family_trees tree
  where tree.id = old.tree_id
  for update;

  if (
    new.project_id is distinct from old.project_id
    or new.child_id is distinct from old.child_id
  ) and exists (
    select 1
    from public.parent_child_relationships relation
    where relation.parent_set_id = old.id
  ) then
    raise exception 'PARENT_SET_IDENTITY_IMMUTABLE_WITH_RELATIONS' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists parent_sets_prevent_identity_change on public.parent_sets;
create trigger parent_sets_prevent_identity_change
before update of project_id, child_id on public.parent_sets
for each row execute function public.prevent_parent_set_identity_change();

-- Cursor payloads are opaque to the client but intentionally not secrets. The
-- RPC validates tree, person, direction and graph version before using one.
create or replace function public.family_tree_cursor_encode(payload jsonb)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select encode(convert_to(payload::text, 'UTF8'), 'hex');
$$;

create or replace function public.family_tree_cursor_decode(token text)
returns jsonb
language plpgsql
immutable
strict
set search_path = public, pg_temp
as $$
begin
  return convert_from(decode(token, 'hex'), 'UTF8')::jsonb;
exception when others then
  return null;
end;
$$;

-- One stable, canonical page of direct neighbors. The fourth key is only a
-- deterministic safety tie-break; relationship_id already makes the required
-- display_order + date + relationship_id cursor unique.
create or replace function public.family_tree_neighbor_page(
  target_tree_id uuid,
  target_person_id uuid,
  target_direction text,
  cursor_payload jsonb default null,
  page_size integer default 401
)
returns table (
  person_id uuid,
  direction text,
  union_id text,
  display_order integer,
  relation_date text,
  relationship_id uuid
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      relation.parent_id as person_id,
      'parents'::text as direction,
      'parent-set:' || relation.parent_set_id::text as union_id,
      parent_set.display_order,
      coalesce(relation.start_date, '') as relation_date,
      relation.id as relationship_id
    from public.parent_child_relationships relation
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    where target_direction = 'parents'
      and relation.tree_id = target_tree_id
      and relation.child_id = target_person_id
      and relation.evidence_status <> 'disproven'
      and (
        relation.privacy_status <> 'confidential'
        or public.can_edit_project(relation.project_id)
      )

    union all

    select
      relation.child_id,
      'children'::text,
      'parent-set:' || relation.parent_set_id::text,
      coalesce(child_member.display_order, parent_set.display_order, 0),
      coalesce(relation.start_date, ''),
      relation.id
    from public.parent_child_relationships relation
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    left join public.family_group_members child_member
      on child_member.family_group_id = parent_set.family_group_id
     and child_member.person_id = relation.child_id
     and child_member.member_role = 'child'
    where target_direction = 'children'
      and relation.tree_id = target_tree_id
      and relation.parent_id = target_person_id
      and relation.evidence_status <> 'disproven'
      and (
        relation.privacy_status <> 'confidential'
        or public.can_edit_project(relation.project_id)
      )

    union all

    select
      case
        when partnership.person_a_id = target_person_id then partnership.person_b_id
        else partnership.person_a_id
      end,
      'partners'::text,
      'partnership:' || partnership.id::text,
      coalesce(partner_member.display_order, 0),
      coalesce(partnership.start_date, ''),
      partnership.id
    from public.partner_relationships partnership
    left join public.family_group_members partner_member
      on partner_member.family_group_id = partnership.family_group_id
     and partner_member.person_id = case
       when partnership.person_a_id = target_person_id then partnership.person_b_id
       else partnership.person_a_id
     end
     and partner_member.member_role = 'partner'
    where target_direction = 'partners'
      and partnership.tree_id = target_tree_id
      and target_person_id in (partnership.person_a_id, partnership.person_b_id)
      and partnership.evidence_status <> 'disproven'
      and (
        partnership.privacy_status <> 'confidential'
        or public.can_edit_project(partnership.project_id)
      )

    union all

    select
      sibling.child_id,
      'siblings'::text,
      'parent-set:' || sibling.parent_set_id::text,
      coalesce(sibling_member.display_order, sibling_set.display_order, 0),
      coalesce(sibling.start_date, ''),
      sibling.id
    from public.parent_child_relationships own_parent
    join public.parent_child_relationships sibling
      on sibling.tree_id = own_parent.tree_id
     and sibling.parent_id = own_parent.parent_id
     and sibling.child_id <> own_parent.child_id
     and sibling.evidence_status <> 'disproven'
    join public.parent_sets sibling_set
      on sibling_set.id = sibling.parent_set_id
     and sibling_set.tree_id = sibling.tree_id
     and sibling_set.child_id = sibling.child_id
    left join public.family_group_members sibling_member
      on sibling_member.family_group_id = sibling_set.family_group_id
     and sibling_member.person_id = sibling.child_id
     and sibling_member.member_role = 'child'
    where target_direction = 'siblings'
      and own_parent.tree_id = target_tree_id
      and own_parent.child_id = target_person_id
      and own_parent.evidence_status <> 'disproven'
      and (
        own_parent.privacy_status <> 'confidential'
        or public.can_edit_project(own_parent.project_id)
      )
      and (
        sibling.privacy_status <> 'confidential'
        or public.can_edit_project(sibling.project_id)
      )
  ),
  canonical as (
    select distinct on (candidate.person_id)
      candidate.person_id,
      candidate.direction,
      candidate.union_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id
    from candidates candidate
    join public.family_tree_persons member
      on member.tree_id = target_tree_id
     and member.person_id = candidate.person_id
     and member.member_role <> 'hidden'
    order by
      candidate.person_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id
  )
  select
    canonical.person_id,
    canonical.direction,
    canonical.union_id,
    canonical.display_order,
    canonical.relation_date,
    canonical.relationship_id
  from canonical
  where cursor_payload is null
     or (
       canonical.display_order,
       canonical.relation_date,
       canonical.relationship_id
     ) > (
       (cursor_payload ->> 'displayOrder')::integer,
       coalesce(cursor_payload ->> 'date', ''),
       (cursor_payload ->> 'relationshipId')::uuid
     )
  order by
    canonical.display_order,
    canonical.relation_date,
    canonical.relationship_id,
    canonical.person_id
  limit case
    when page_size is null then null
    else greatest(0, least(page_size, 2000))
  end;
$$;

create or replace function public.get_family_tree_neighborhood_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_temp, public
as $$
declare
  requested_tree_id uuid;
  requested_focus_id uuid;
  requested_ancestor_depth integer;
  requested_descendant_depth integer;
  requested_collateral_depth integer;
  requested_max_nodes integer;
  current_project_id uuid;
  current_graph_version bigint;
  project_member_role text;
  can_view_private boolean;
  permission_fingerprint text;
  branch_mode boolean;
  selected_count integer := 0;
  inserted_count integer;
  state_inserted_count integer;
  queued_state_count integer := 0;
  state_budget integer;
  current_item record;
  neighbor record;
  connector record;
  has_connector boolean;
  branch jsonb;
  requested_direction text;
  cursor_token text;
  cursor_payload jsonb;
  hidden_count integer;
  prefix_cursor jsonb;
  hidden_union_id text;
  persons_payload jsonb;
  unions_payload jsonb;
  relations_payload jsonb;
  continuations_payload jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_request is null or jsonb_typeof(p_request) <> 'object' then
    raise exception 'INVALID_NEIGHBORHOOD_REQUEST' using errcode = '22023';
  end if;

  if not (p_request ?& array['treeId', 'focusPersonId'])
     or not pg_input_is_valid(coalesce(p_request ->> 'treeId', ''), 'uuid')
     or not pg_input_is_valid(coalesce(p_request ->> 'focusPersonId', ''), 'uuid')
     or (
       p_request ? 'ancestorDepth'
       and not pg_input_is_valid(coalesce(p_request ->> 'ancestorDepth', ''), 'integer')
     )
     or (
       p_request ? 'descendantDepth'
       and not pg_input_is_valid(coalesce(p_request ->> 'descendantDepth', ''), 'integer')
     )
     or (
       p_request ? 'collateralDepth'
       and not pg_input_is_valid(coalesce(p_request ->> 'collateralDepth', ''), 'integer')
     )
     or (
       p_request ? 'maxNodes'
       and not pg_input_is_valid(coalesce(p_request ->> 'maxNodes', ''), 'integer')
     ) then
    raise exception 'INVALID_NEIGHBORHOOD_REQUEST' using errcode = '22023';
  end if;

  requested_tree_id := nullif(p_request ->> 'treeId', '')::uuid;
  requested_focus_id := nullif(p_request ->> 'focusPersonId', '')::uuid;
  requested_ancestor_depth := greatest(0, coalesce((p_request ->> 'ancestorDepth')::integer, 7));
  requested_descendant_depth := greatest(0, coalesce((p_request ->> 'descendantDepth')::integer, 3));
  requested_collateral_depth := greatest(0, coalesce((p_request ->> 'collateralDepth')::integer, 1));
  requested_max_nodes := greatest(1, least(coalesce((p_request ->> 'maxNodes')::integer, 400), 600));
  -- Pedigree collapse can produce several incomparable depth states for one
  -- canonical person. Bound state work independently from the output-node
  -- budget; omitted branches remain discoverable through continuations.
  state_budget := requested_max_nodes * 8;

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

  if requested_focus_id is null or not exists (
    select 1
    from public.family_tree_persons member
    where member.tree_id = requested_tree_id
      and member.person_id = requested_focus_id
      and member.member_role <> 'hidden'
  ) then
    raise exception 'FOCUS_PERSON_NOT_IN_TREE' using errcode = '22023';
  end if;

  drop table if exists pg_temp._family_tree_cursor_floor;
  drop table if exists pg_temp._family_tree_continuations;
  drop table if exists pg_temp._family_tree_queue;
  drop table if exists pg_temp._family_tree_selected;

  create temporary table _family_tree_selected (
    person_id uuid primary key,
    generation integer not null,
    ancestor_depth integer not null,
    descendant_depth integer not null,
    collateral_depth integer not null,
    insert_order bigint generated always as identity
  ) on commit drop;
  create temporary table _family_tree_queue (
    seq bigint generated always as identity primary key,
    person_id uuid not null,
    generation integer not null,
    ancestor_depth integer not null,
    descendant_depth integer not null,
    collateral_depth integer not null,
    processed boolean not null default false
  ) on commit drop;
  create temporary table _family_tree_continuations (
    id text primary key,
    person_id uuid not null,
    direction text not null,
    token text not null,
    hidden_count integer not null,
    union_id text
  ) on commit drop;
  create temporary table _family_tree_cursor_floor (
    person_id uuid not null,
    direction text not null,
    display_order integer not null,
    relation_date text not null,
    relationship_id uuid not null,
    primary key (person_id, direction)
  ) on commit drop;
  if p_request ? 'branches'
     and jsonb_typeof(p_request -> 'branches') <> 'array' then
    raise exception 'INVALID_BRANCH_REQUEST' using errcode = '22023';
  end if;

  branch_mode := case
    when jsonb_typeof(p_request -> 'branches') = 'array'
    then jsonb_array_length(p_request -> 'branches') > 0
    else false
  end;

  if branch_mode and jsonb_array_length(p_request -> 'branches') > requested_max_nodes then
    raise exception 'BRANCH_REQUEST_EXCEEDS_NODE_BUDGET' using errcode = '22023';
  end if;

  if branch_mode and exists (
    select 1
    from jsonb_array_elements(p_request -> 'branches') as branch_rows(branch_item)
    where jsonb_typeof(branch_item) <> 'object'
       or nullif(branch_item ->> 'personId', '') is null
       or not pg_input_is_valid(coalesce(branch_item ->> 'personId', ''), 'uuid')
       or jsonb_typeof(branch_item -> 'directions') <> 'array'
       or jsonb_array_length(branch_item -> 'directions') > 4
  ) then
    raise exception 'INVALID_BRANCH_REQUEST' using errcode = '22023';
  end if;

  -- Repeating the same branch-direction with different cursors would make the
  -- shared cursor floor depend on JSON array order. Reject it up front.
  if branch_mode and exists (
    select 1
    from jsonb_array_elements(p_request -> 'branches') as branch_rows(branch_item)
    cross join lateral jsonb_array_elements_text(branch_item -> 'directions')
      as direction_rows(direction_item)
    group by branch_item ->> 'personId', direction_item
    having count(*) > 1
  ) then
    raise exception 'DUPLICATE_BRANCH_DIRECTION' using errcode = '22023';
  end if;

  if not branch_mode then
    insert into _family_tree_selected (
      person_id, generation, ancestor_depth, descendant_depth, collateral_depth
    ) values (requested_focus_id, 0, 0, 0, 0);
    insert into _family_tree_queue (
      person_id, generation, ancestor_depth, descendant_depth, collateral_depth
    ) values (requested_focus_id, 0, 0, 0, 0);
    selected_count := 1;
    queued_state_count := 1;

    while selected_count < requested_max_nodes loop
      select * into current_item
      from _family_tree_queue
      where not processed
      order by seq
      limit 1;
      exit when not found;

      update _family_tree_queue
      set processed = true
      where seq = current_item.seq;

      for neighbor in
        select
          1 as direction_rank,
          page.*,
          current_item.generation + 1 as next_generation,
          current_item.ancestor_depth + 1 as next_ancestor_depth,
          current_item.descendant_depth as next_descendant_depth,
          current_item.collateral_depth as next_collateral_depth
        from public.family_tree_neighbor_page(
          requested_tree_id, current_item.person_id, 'parents', null, requested_max_nodes
        ) page
        where current_item.ancestor_depth < requested_ancestor_depth

        union all

        select
          2,
          page.*,
          current_item.generation,
          current_item.ancestor_depth,
          current_item.descendant_depth,
          current_item.collateral_depth
        from public.family_tree_neighbor_page(
          requested_tree_id, current_item.person_id, 'partners', null, requested_max_nodes
        ) page

        union all

        select
          3,
          page.*,
          current_item.generation - 1,
          current_item.ancestor_depth,
          current_item.descendant_depth + 1,
          current_item.collateral_depth
        from public.family_tree_neighbor_page(
          requested_tree_id, current_item.person_id, 'children', null, requested_max_nodes
        ) page
        where current_item.descendant_depth < requested_descendant_depth

        union all

        select
          4,
          page.*,
          current_item.generation,
          current_item.ancestor_depth,
          current_item.descendant_depth,
          current_item.collateral_depth + 1
        from public.family_tree_neighbor_page(
          requested_tree_id, current_item.person_id, 'siblings', null, requested_max_nodes
        ) page
        where current_item.collateral_depth < requested_collateral_depth
        order by direction_rank, display_order, relation_date, relationship_id, person_id
      loop
        exit when selected_count >= requested_max_nodes;
        if neighbor.direction = 'siblings' then
          select exists (
            select 1
            from public.parent_child_relationships own_parent
            join public.parent_child_relationships sibling
              on sibling.tree_id = own_parent.tree_id
             and sibling.parent_id = own_parent.parent_id
             and sibling.child_id = neighbor.person_id
             and sibling.evidence_status <> 'disproven'
             and (
               sibling.privacy_status <> 'confidential'
               or public.can_edit_project(sibling.project_id)
             )
            join _family_tree_selected selected
              on selected.person_id = own_parent.parent_id
            where own_parent.tree_id = requested_tree_id
              and own_parent.child_id = current_item.person_id
              and own_parent.evidence_status <> 'disproven'
              and (
                own_parent.privacy_status <> 'confidential'
                or public.can_edit_project(own_parent.project_id)
              )
          ) into has_connector;

          if not has_connector then
            for connector in
              select distinct own_parent.parent_id
              from public.parent_child_relationships own_parent
              join public.parent_child_relationships sibling
                on sibling.tree_id = own_parent.tree_id
               and sibling.parent_id = own_parent.parent_id
               and sibling.child_id = neighbor.person_id
               and sibling.evidence_status <> 'disproven'
               and (
                 sibling.privacy_status <> 'confidential'
                 or public.can_edit_project(sibling.project_id)
               )
              join public.family_tree_persons member
                on member.tree_id = own_parent.tree_id
               and member.person_id = own_parent.parent_id
               and member.member_role <> 'hidden'
              where own_parent.tree_id = requested_tree_id
                and own_parent.child_id = current_item.person_id
                and own_parent.evidence_status <> 'disproven'
                and (
                  own_parent.privacy_status <> 'confidential'
                  or public.can_edit_project(own_parent.project_id)
                )
              order by own_parent.parent_id
            loop
              exit when selected_count >= requested_max_nodes;
              insert into _family_tree_selected (
                person_id, generation, ancestor_depth, descendant_depth, collateral_depth
              ) values (
                connector.parent_id,
                current_item.generation + 1,
                current_item.ancestor_depth + 1,
                current_item.descendant_depth,
                current_item.collateral_depth
              ) on conflict (person_id) do nothing;
              get diagnostics inserted_count = row_count;
              if inserted_count > 0 then
                selected_count := selected_count + 1;
              end if;

              insert into _family_tree_queue (
                person_id, generation, ancestor_depth, descendant_depth, collateral_depth
              )
              select
                connector.parent_id,
                current_item.generation + 1,
                current_item.ancestor_depth + 1,
                current_item.descendant_depth,
                current_item.collateral_depth
              where queued_state_count < state_budget
                and not exists (
                  select 1
                  from _family_tree_queue state
                  where state.person_id = connector.parent_id
                    and state.ancestor_depth <= current_item.ancestor_depth + 1
                    and state.descendant_depth <= current_item.descendant_depth
                    and state.collateral_depth <= current_item.collateral_depth
                );
              get diagnostics state_inserted_count = row_count;
              if state_inserted_count > 0 then
                queued_state_count := queued_state_count + state_inserted_count;
              end if;
            end loop;
          end if;

          select exists (
            select 1
            from public.parent_child_relationships own_parent
            join public.parent_child_relationships sibling
              on sibling.tree_id = own_parent.tree_id
             and sibling.parent_id = own_parent.parent_id
             and sibling.child_id = neighbor.person_id
             and sibling.evidence_status <> 'disproven'
             and (
               sibling.privacy_status <> 'confidential'
               or public.can_edit_project(sibling.project_id)
             )
            join _family_tree_selected selected
              on selected.person_id = own_parent.parent_id
            where own_parent.tree_id = requested_tree_id
              and own_parent.child_id = current_item.person_id
              and own_parent.evidence_status <> 'disproven'
              and (
                own_parent.privacy_status <> 'confidential'
                or public.can_edit_project(own_parent.project_id)
              )
          ) into has_connector;
          if not has_connector or selected_count >= requested_max_nodes then
            continue;
          end if;
        end if;
        insert into _family_tree_selected (
          person_id, generation, ancestor_depth, descendant_depth, collateral_depth
        ) values (
          neighbor.person_id,
          neighbor.next_generation,
          neighbor.next_ancestor_depth,
          neighbor.next_descendant_depth,
          neighbor.next_collateral_depth
        ) on conflict (person_id) do nothing;
        get diagnostics inserted_count = row_count;
        if inserted_count > 0 then
          selected_count := selected_count + 1;
        end if;

        insert into _family_tree_queue (
          person_id, generation, ancestor_depth, descendant_depth, collateral_depth
        )
        select
            neighbor.person_id,
            neighbor.next_generation,
            neighbor.next_ancestor_depth,
            neighbor.next_descendant_depth,
            neighbor.next_collateral_depth
        where queued_state_count < state_budget
          and not exists (
            select 1
            from _family_tree_queue state
            where state.person_id = neighbor.person_id
              and state.ancestor_depth <= neighbor.next_ancestor_depth
              and state.descendant_depth <= neighbor.next_descendant_depth
              and state.collateral_depth <= neighbor.next_collateral_depth
          );
        get diagnostics state_inserted_count = row_count;
        if state_inserted_count > 0 then
          queued_state_count := queued_state_count + state_inserted_count;
        end if;
      end loop;
    end loop;
  else
    if p_request ? 'knownGraphVersion'
       and (p_request ->> 'knownGraphVersion') is distinct from current_graph_version::text then
      raise exception 'TREE_GRAPH_VERSION_CHANGED' using errcode = '40001';
    end if;

    for branch in select value from jsonb_array_elements(p_request -> 'branches') loop
      exit when selected_count >= requested_max_nodes;
      if jsonb_typeof(branch) <> 'object'
         or nullif(branch ->> 'personId', '') is null
         or jsonb_typeof(branch -> 'directions') <> 'array' then
        raise exception 'INVALID_BRANCH_REQUEST' using errcode = '22023';
      end if;
      if jsonb_array_length(branch -> 'directions') > 4
         or (
           select count(*)
           from jsonb_array_elements_text(branch -> 'directions')
         ) <> (
           select count(distinct value)
           from jsonb_array_elements_text(branch -> 'directions')
         ) then
        raise exception 'DUPLICATE_OR_EXCESS_BRANCH_DIRECTIONS' using errcode = '22023';
      end if;
      if not exists (
        select 1
        from public.family_tree_persons member
        where member.tree_id = requested_tree_id
          and member.person_id = (branch ->> 'personId')::uuid
          and member.member_role <> 'hidden'
      ) then
        raise exception 'BRANCH_PERSON_NOT_IN_TREE' using errcode = '22023';
      end if;

      insert into _family_tree_selected (
        person_id, generation, ancestor_depth, descendant_depth, collateral_depth
      ) values ((branch ->> 'personId')::uuid, 0, 0, 0, 0)
      on conflict (person_id) do nothing;
      get diagnostics inserted_count = row_count;
      selected_count := selected_count + inserted_count;

      for requested_direction in
        select direction_item
        from jsonb_array_elements_text(branch -> 'directions') with ordinality
          as direction_rows(direction_item, direction_order)
        order by direction_order
      loop
        if requested_direction not in ('parents', 'children', 'partners', 'siblings') then
          raise exception 'INVALID_BRANCH_DIRECTION' using errcode = '22023';
        end if;
        cursor_token := branch -> 'cursors' ->> requested_direction;
        cursor_payload := case
          when cursor_token is null or cursor_token = '' then null
          when length(cursor_token) > 2048 then null
          else public.family_tree_cursor_decode(cursor_token)
        end;
        if cursor_token is not null and (
          cursor_payload is null
          or length(cursor_token) > 2048
          or not (cursor_payload ?& array[
            'version',
            'treeId',
            'personId',
            'direction',
            'graphVersion',
            'displayOrder',
            'date',
            'relationshipId'
          ])
          or cursor_payload ->> 'version' is distinct from '1'
          or cursor_payload ->> 'treeId' is distinct from requested_tree_id::text
          or cursor_payload ->> 'personId' is distinct from branch ->> 'personId'
          or cursor_payload ->> 'direction' is distinct from requested_direction
          or cursor_payload ->> 'graphVersion' is distinct from current_graph_version::text
          or not pg_input_is_valid(
            coalesce(cursor_payload ->> 'displayOrder', ''),
            'integer'
          )
          or coalesce(cursor_payload ->> 'relationshipId', '') !~
            '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        ) then
          raise exception 'INVALID_OR_STALE_BRANCH_CURSOR' using errcode = '22023';
        end if;

        if cursor_payload is not null then
          insert into _family_tree_cursor_floor (
            person_id, direction, display_order, relation_date, relationship_id
          ) values (
            (branch ->> 'personId')::uuid,
            requested_direction,
            (cursor_payload ->> 'displayOrder')::integer,
            coalesce(cursor_payload ->> 'date', ''),
            (cursor_payload ->> 'relationshipId')::uuid
          ) on conflict (person_id, direction) do update
            set display_order = excluded.display_order,
                relation_date = excluded.relation_date,
                relationship_id = excluded.relationship_id;
        end if;

        for neighbor in
          select *
          from public.family_tree_neighbor_page(
            requested_tree_id,
            (branch ->> 'personId')::uuid,
            requested_direction,
            cursor_payload,
            requested_max_nodes
          )
        loop
          exit when selected_count >= requested_max_nodes;
          if requested_direction = 'siblings' then
            select exists (
              select 1
              from public.parent_child_relationships own_parent
              join public.parent_child_relationships sibling
                on sibling.tree_id = own_parent.tree_id
               and sibling.parent_id = own_parent.parent_id
               and sibling.child_id = neighbor.person_id
               and sibling.evidence_status <> 'disproven'
               and (
                 sibling.privacy_status <> 'confidential'
                 or public.can_edit_project(sibling.project_id)
               )
              join _family_tree_selected selected
                on selected.person_id = own_parent.parent_id
              where own_parent.tree_id = requested_tree_id
                and own_parent.child_id = (branch ->> 'personId')::uuid
                and own_parent.evidence_status <> 'disproven'
                and (
                  own_parent.privacy_status <> 'confidential'
                  or public.can_edit_project(own_parent.project_id)
                )
            ) into has_connector;

            if not has_connector then
              for connector in
                select distinct own_parent.parent_id
                from public.parent_child_relationships own_parent
                join public.parent_child_relationships sibling
                  on sibling.tree_id = own_parent.tree_id
                 and sibling.parent_id = own_parent.parent_id
                 and sibling.child_id = neighbor.person_id
                 and sibling.evidence_status <> 'disproven'
                 and (
                   sibling.privacy_status <> 'confidential'
                   or public.can_edit_project(sibling.project_id)
                 )
                join public.family_tree_persons member
                  on member.tree_id = own_parent.tree_id
                 and member.person_id = own_parent.parent_id
                 and member.member_role <> 'hidden'
                where own_parent.tree_id = requested_tree_id
                  and own_parent.child_id = (branch ->> 'personId')::uuid
                  and own_parent.evidence_status <> 'disproven'
                  and (
                    own_parent.privacy_status <> 'confidential'
                    or public.can_edit_project(own_parent.project_id)
                  )
                order by own_parent.parent_id
              loop
                exit when selected_count >= requested_max_nodes;
                insert into _family_tree_selected (
                  person_id, generation, ancestor_depth, descendant_depth, collateral_depth
                ) values (connector.parent_id, 1, 1, 0, 0)
                on conflict (person_id) do nothing;
                get diagnostics inserted_count = row_count;
                selected_count := selected_count + inserted_count;
              end loop;
            end if;

            select exists (
              select 1
              from public.parent_child_relationships own_parent
              join public.parent_child_relationships sibling
                on sibling.tree_id = own_parent.tree_id
               and sibling.parent_id = own_parent.parent_id
               and sibling.child_id = neighbor.person_id
               and sibling.evidence_status <> 'disproven'
               and (
                 sibling.privacy_status <> 'confidential'
                 or public.can_edit_project(sibling.project_id)
               )
              join _family_tree_selected selected
                on selected.person_id = own_parent.parent_id
              where own_parent.tree_id = requested_tree_id
                and own_parent.child_id = (branch ->> 'personId')::uuid
                and own_parent.evidence_status <> 'disproven'
                and (
                  own_parent.privacy_status <> 'confidential'
                  or public.can_edit_project(own_parent.project_id)
                )
            ) into has_connector;
            if not has_connector or selected_count >= requested_max_nodes then
              continue;
            end if;
          end if;
          insert into _family_tree_selected (
            person_id, generation, ancestor_depth, descendant_depth, collateral_depth
          ) values (
            neighbor.person_id,
            case requested_direction when 'parents' then 1 when 'children' then -1 else 0 end,
            case when requested_direction = 'parents' then 1 else 0 end,
            case when requested_direction = 'children' then 1 else 0 end,
            case when requested_direction = 'siblings' then 1 else 0 end
          ) on conflict (person_id) do nothing;
          get diagnostics inserted_count = row_count;
          selected_count := selected_count + inserted_count;
          insert into _family_tree_cursor_floor (
            person_id, direction, display_order, relation_date, relationship_id
          ) values (
            (branch ->> 'personId')::uuid,
            requested_direction,
            neighbor.display_order,
            neighbor.relation_date,
            neighbor.relationship_id
          ) on conflict (person_id, direction) do update
            set display_order = excluded.display_order,
                relation_date = excluded.relation_date,
                relationship_id = excluded.relationship_id;
        end loop;
      end loop;
    end loop;
  end if;

  -- A continuation is created from the first missing canonical neighbor. The
  -- cursor points to the last contiguous neighbor already in this response.
  for current_item in
    select selected.person_id
    from _family_tree_selected selected
    order by selected.insert_order
  loop
    foreach requested_direction in array array['parents', 'children', 'partners', 'siblings'] loop
      select jsonb_build_object(
        'displayOrder', floor.display_order,
        'date', floor.relation_date,
        'relationshipId', floor.relationship_id
      ) into cursor_payload
      from _family_tree_cursor_floor floor
      where floor.person_id = current_item.person_id
        and floor.direction = requested_direction;

      with ordered as (
        select
          page.*,
          row_number() over (
            order by page.display_order, page.relation_date, page.relationship_id, page.person_id
          ) as row_number,
          exists (
            select 1 from _family_tree_selected selected
            where selected.person_id = page.person_id
          ) as is_selected
        from public.family_tree_neighbor_page(
          requested_tree_id,
          current_item.person_id,
          requested_direction,
          cursor_payload,
          null
        ) page
      ), boundary as (
        select min(row_number) as first_hidden_row
        from ordered
        where not is_selected
      )
      select
        (select count(*)::integer from ordered where not is_selected),
        (
          select jsonb_build_object(
            'displayOrder', previous.display_order,
            'date', previous.relation_date,
            'relationshipId', previous.relationship_id
          )
          from ordered previous, boundary
          where previous.row_number = boundary.first_hidden_row - 1
        ),
        (
          select missing.union_id
          from ordered missing, boundary
          where missing.row_number = boundary.first_hidden_row
        )
      into hidden_count, prefix_cursor, hidden_union_id;

      if hidden_count > 0 then
        prefix_cursor := coalesce(prefix_cursor, cursor_payload);
        cursor_payload := jsonb_build_object(
          'version', 1,
          'treeId', requested_tree_id,
          'personId', current_item.person_id,
          'direction', requested_direction,
          'graphVersion', current_graph_version,
          'displayOrder', coalesce((prefix_cursor ->> 'displayOrder')::integer, -2147483648),
          'date', coalesce(prefix_cursor ->> 'date', ''),
          'relationshipId', coalesce(
            prefix_cursor ->> 'relationshipId',
            '00000000-0000-0000-0000-000000000000'
          )
        );
        cursor_token := public.family_tree_cursor_encode(cursor_payload);
        insert into _family_tree_continuations (
          id, person_id, direction, token, hidden_count, union_id
        ) values (
          md5(current_item.person_id::text || ':' || requested_direction || ':' || cursor_token),
          current_item.person_id,
          requested_direction,
          cursor_token,
          hidden_count,
          hidden_union_id
        ) on conflict (id) do update
          set token = excluded.token,
              hidden_count = excluded.hidden_count,
              union_id = excluded.union_id;
      end if;
    end loop;
  end loop;

  select coalesce(jsonb_agg(person_json order by insert_order), '[]'::jsonb)
    into persons_payload
  from (
    select
      selected.insert_order,
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
    from _family_tree_selected selected
    join public.family_tree_persons member
      on member.tree_id = requested_tree_id
     and member.person_id = selected.person_id
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
      and exists (select 1 from _family_tree_selected where person_id = partnership.person_a_id)
      and exists (select 1 from _family_tree_selected where person_id = partnership.person_b_id)

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
            case relation.parent_role_label when 'father' then 0 when 'mother' then 1 else 2 end,
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
              select 1 from _family_tree_selected selected
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
          and exists (select 1 from _family_tree_selected where person_id = relation.parent_id)
          and exists (select 1 from _family_tree_selected where person_id = relation.child_id)
      )
  )
  select coalesce(jsonb_agg(union_json order by sort_key), '[]'::jsonb)
    into unions_payload
  from union_rows;

  select coalesce(jsonb_agg(relation_json order by sort_key), '[]'::jsonb)
    into relations_payload
  from (
    select
      lpad((parent_set.display_order::bigint + 1000000000)::text, 20, '0') || ':' || relation.id::text as sort_key,
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
      and exists (select 1 from _family_tree_selected where person_id = relation.parent_id)
      and exists (select 1 from _family_tree_selected where person_id = relation.child_id)
  ) payload;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', continuation.id,
    'personId', continuation.person_id,
    'direction', continuation.direction,
    'token', continuation.token,
    'hiddenCount', continuation.hidden_count,
    'unionId', continuation.union_id
  )) order by continuation.person_id, continuation.direction), '[]'::jsonb)
    into continuations_payload
  from _family_tree_continuations continuation;

  return jsonb_build_object(
    'persons', persons_payload,
    'unions', unions_payload,
    'parentChildRelations', relations_payload,
    'continuations', continuations_payload,
    'graphVersion', current_graph_version::text,
    'permissionFingerprint', permission_fingerprint
  );
end;
$$;

-- Column-level masking cannot be expressed by RLS. Viewer roles therefore do
-- not receive exact private-living rows from the base tables at all; the
-- neighborhood RPC is the only read path that returns a masked placeholder.
create or replace function public.can_read_exact_family_tree_person(
  target_project_id uuid,
  target_person_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_project_member(target_project_id)
    and (
      public.can_edit_project(target_project_id)
      or exists (
        select 1
        from public.persons person
        where person.project_id = target_project_id
          and person.id = target_person_id
          and not (
            person.is_living
            and person.privacy_status in ('private', 'confidential')
          )
      )
    );
$$;

create or replace function public.can_read_exact_family_group(
  target_project_id uuid,
  target_family_group_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_project_member(target_project_id)
    and (
      public.can_edit_project(target_project_id)
      or exists (
        select 1
        from public.family_groups family_group
        where family_group.project_id = target_project_id
          and family_group.id = target_family_group_id
          and (
            family_group.primary_partner_1_id is null
            or public.can_read_exact_family_tree_person(
              target_project_id,
              family_group.primary_partner_1_id
            )
          )
          and (
            family_group.primary_partner_2_id is null
            or public.can_read_exact_family_tree_person(
              target_project_id,
              family_group.primary_partner_2_id
            )
          )
          and not exists (
            select 1
            from public.family_group_members member
            where member.project_id = target_project_id
              and member.family_group_id = target_family_group_id
              and not public.can_read_exact_family_tree_person(
                target_project_id,
                member.person_id
              )
          )
      )
    );
$$;

create or replace function public.can_read_exact_parent_set(
  target_project_id uuid,
  target_parent_set_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_project_member(target_project_id)
    and (
      public.can_edit_project(target_project_id)
      or exists (
        select 1
        from public.parent_sets parent_set
        where parent_set.project_id = target_project_id
          and parent_set.id = target_parent_set_id
          and public.can_read_exact_family_tree_person(
            target_project_id,
            parent_set.child_id
          )
          and not exists (
            select 1
            from public.parent_child_relationships relation
            where relation.parent_set_id = parent_set.id
              and relation.evidence_status <> 'disproven'
              and not public.can_read_exact_family_tree_person(
                target_project_id,
                relation.parent_id
              )
          )
      )
    );
$$;

drop policy if exists persons_select on public.persons;
create policy persons_select on public.persons
for select to authenticated
using (public.can_read_exact_family_tree_person(project_id, id));

drop policy if exists person_relations_select on public.person_relations;
create policy person_relations_select on public.person_relations
for select to authenticated
using (
  public.can_read_exact_family_tree_person(project_id, person_id)
  and public.can_read_exact_family_tree_person(project_id, related_person_id)
);

drop policy if exists person_names_select_members on public.person_names;
create policy person_names_select_members on public.person_names
for select to authenticated
using (public.can_read_exact_family_tree_person(project_id, person_id));

drop policy if exists person_timeline_events_select_members on public.person_timeline_events;
create policy person_timeline_events_select_members on public.person_timeline_events
for select to authenticated
using (public.can_read_exact_family_tree_person(project_id, person_id));

drop policy if exists family_tree_persons_select_members on public.family_tree_persons;
create policy family_tree_persons_select_members on public.family_tree_persons
for select to authenticated
using (
  public.can_edit_project(project_id)
  or (
    member_role <> 'hidden'
    and public.can_read_exact_family_tree_person(project_id, person_id)
  )
);

drop policy if exists family_groups_select_members on public.family_groups;
create policy family_groups_select_members on public.family_groups
for select to authenticated
using (public.can_read_exact_family_group(project_id, id));

drop policy if exists family_group_members_select_members on public.family_group_members;
create policy family_group_members_select_members on public.family_group_members
for select to authenticated
using (
  public.can_read_exact_family_group(project_id, family_group_id)
  and public.can_read_exact_family_tree_person(project_id, person_id)
);

drop policy if exists partner_relationships_select_members on public.partner_relationships;
create policy partner_relationships_select_members on public.partner_relationships
for select to authenticated
using (
  public.is_project_member(project_id)
  and (privacy_status <> 'confidential' or public.can_edit_project(project_id))
  and public.can_read_exact_family_tree_person(project_id, person_a_id)
  and public.can_read_exact_family_tree_person(project_id, person_b_id)
);

drop policy if exists parent_sets_select_members on public.parent_sets;
create policy parent_sets_select_members on public.parent_sets
for select to authenticated
using (public.can_read_exact_parent_set(project_id, id));

drop policy if exists parent_child_relationships_select_members on public.parent_child_relationships;
create policy parent_child_relationships_select_members on public.parent_child_relationships
for select to authenticated
using (
  public.is_project_member(project_id)
  and (privacy_status <> 'confidential' or public.can_edit_project(project_id))
  and public.can_read_exact_family_tree_person(project_id, parent_id)
  and public.can_read_exact_family_tree_person(project_id, child_id)
);

drop policy if exists association_relationships_select_members on public.association_relationships;
create policy association_relationships_select_members on public.association_relationships
for select to authenticated
using (
  public.is_project_member(project_id)
  and (privacy_status <> 'confidential' or public.can_edit_project(project_id))
  and public.can_read_exact_family_tree_person(project_id, person_a_id)
  and public.can_read_exact_family_tree_person(project_id, person_b_id)
);

drop policy if exists legacy_person_relation_graph_edges_select_members
  on public.legacy_person_relation_graph_edges;
create policy legacy_person_relation_graph_edges_select_members
on public.legacy_person_relation_graph_edges
for select to authenticated
using (
  public.can_edit_project(project_id)
  or exists (
    select 1
    from public.person_relations relation
    where relation.id = relation_id
      and relation.project_id = legacy_person_relation_graph_edges.project_id
  )
);

revoke execute on function public.family_tree_bump_graph_version() from public, anon, authenticated;
revoke execute on function public.family_tree_bump_person_graph_versions() from public, anon, authenticated;
revoke execute on function public.family_tree_version_root_change() from public, anon, authenticated;
revoke execute on function public.prevent_bloodline_parent_cycle() from public, anon, authenticated;
revoke execute on function public.prevent_parent_set_identity_change() from public, anon, authenticated;
revoke execute on function public.family_tree_cursor_encode(jsonb) from public, anon, authenticated;
revoke execute on function public.family_tree_cursor_decode(text) from public, anon, authenticated;
revoke execute on function public.family_tree_neighbor_page(uuid, uuid, text, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.get_family_tree_neighborhood_v1(jsonb) from public, anon;
revoke execute on function public.can_read_exact_family_tree_person(uuid, uuid) from public, anon;
revoke execute on function public.can_read_exact_family_group(uuid, uuid) from public, anon;
revoke execute on function public.can_read_exact_parent_set(uuid, uuid) from public, anon;
grant execute on function public.can_read_exact_family_tree_person(uuid, uuid) to authenticated;
grant execute on function public.can_read_exact_family_group(uuid, uuid) to authenticated;
grant execute on function public.can_read_exact_parent_set(uuid, uuid) to authenticated;
grant execute on function public.get_family_tree_neighborhood_v1(jsonb) to authenticated;

commit;
