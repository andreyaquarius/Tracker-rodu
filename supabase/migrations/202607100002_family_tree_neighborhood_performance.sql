begin;

-- The global FK-index event trigger must ignore temporary RPC work tables.
-- Public CREATE/ALTER TABLE commands still receive the original coverage audit.
create or replace function public.ensure_foreign_key_covering_indexes_after_ddl()
returns event_trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from pg_catalog.pg_event_trigger_ddl_commands() command
    where command.schema_name = 'public'
  ) then
    perform public.ensure_foreign_key_covering_indexes('public');
  end if;
end;
$$;

revoke execute on function public.ensure_foreign_key_covering_indexes_after_ddl()
  from public, anon, authenticated;

-- Populate every continuation with one set-based pass over the selected
-- neighborhood. Canonicalization happens before cursor filtering, matching
-- family_tree_neighbor_page() exactly.
create or replace function public.family_tree_populate_continuations_v2(
  target_tree_id uuid,
  target_graph_version bigint
)
returns void
language plpgsql
security definer
set search_path = pg_temp, public
as $$
begin
  with
  sources as materialized (
    select selected.person_id
    from pg_temp._family_tree_selected selected
  ),
  visible_members as materialized (
    select member.person_id
    from public.family_tree_persons member
    where member.tree_id = target_tree_id
      and member.member_role <> 'hidden'
  ),
  readable_parent_relations as materialized (
    select
      relation.id,
      relation.tree_id,
      relation.parent_id,
      relation.child_id,
      relation.parent_set_id,
      relation.start_date
    from public.parent_child_relationships relation
    where relation.tree_id = target_tree_id
      and relation.evidence_status <> 'disproven'
      and (
        relation.privacy_status <> 'confidential'
        or public.can_edit_project(relation.project_id)
      )
  ),
  readable_partnerships as materialized (
    select
      partnership.id,
      partnership.tree_id,
      partnership.family_group_id,
      partnership.person_a_id,
      partnership.person_b_id,
      partnership.start_date
    from public.partner_relationships partnership
    where partnership.tree_id = target_tree_id
      and partnership.evidence_status <> 'disproven'
      and (
        partnership.privacy_status <> 'confidential'
        or public.can_edit_project(partnership.project_id)
      )
  ),
  candidates as (
    select
      source.person_id as source_person_id,
      relation.parent_id as person_id,
      'parents'::text as direction,
      'parent-set:' || relation.parent_set_id::text as union_id,
      parent_set.display_order,
      coalesce(relation.start_date, '') as relation_date,
      relation.id as relationship_id
    from sources source
    join readable_parent_relations relation
      on relation.child_id = source.person_id
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id

    union all

    select
      source.person_id,
      relation.child_id,
      'children'::text,
      'parent-set:' || relation.parent_set_id::text,
      coalesce(child_member.display_order, parent_set.display_order, 0),
      coalesce(relation.start_date, ''),
      relation.id
    from sources source
    join readable_parent_relations relation
      on relation.parent_id = source.person_id
    join public.parent_sets parent_set
      on parent_set.id = relation.parent_set_id
     and parent_set.tree_id = relation.tree_id
     and parent_set.child_id = relation.child_id
    left join public.family_group_members child_member
      on child_member.family_group_id = parent_set.family_group_id
     and child_member.person_id = relation.child_id
     and child_member.member_role = 'child'

    union all

    select
      source.person_id,
      partnership.person_b_id,
      'partners'::text,
      'partnership:' || partnership.id::text,
      coalesce(partner_member.display_order, 0),
      coalesce(partnership.start_date, ''),
      partnership.id
    from sources source
    join readable_partnerships partnership
      on partnership.person_a_id = source.person_id
    left join public.family_group_members partner_member
      on partner_member.family_group_id = partnership.family_group_id
     and partner_member.person_id = partnership.person_b_id
     and partner_member.member_role = 'partner'

    union all

    select
      source.person_id,
      partnership.person_a_id,
      'partners'::text,
      'partnership:' || partnership.id::text,
      coalesce(partner_member.display_order, 0),
      coalesce(partnership.start_date, ''),
      partnership.id
    from sources source
    join readable_partnerships partnership
      on partnership.person_b_id = source.person_id
    left join public.family_group_members partner_member
      on partner_member.family_group_id = partnership.family_group_id
     and partner_member.person_id = partnership.person_a_id
     and partner_member.member_role = 'partner'
  ),
  canonical as (
    select distinct on (
      candidate.source_person_id,
      candidate.direction,
      candidate.person_id
    )
      candidate.source_person_id,
      candidate.person_id,
      candidate.direction,
      candidate.union_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id
    from candidates candidate
    join visible_members member
      on member.person_id = candidate.person_id
    order by
      candidate.source_person_id,
      candidate.direction,
      candidate.person_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id
  ),
  after_floor as (
    select canonical.*
    from canonical
    left join pg_temp._family_tree_cursor_floor floor
      on floor.person_id = canonical.source_person_id
     and floor.direction = canonical.direction
    where floor.person_id is null
       or (
         canonical.display_order,
         canonical.relation_date,
         canonical.relationship_id
       ) > (
         floor.display_order,
         floor.relation_date,
         floor.relationship_id
       )
  ),
  ordered as materialized (
    select
      page.*,
      row_number() over (
        partition by page.source_person_id, page.direction
        order by
          page.display_order,
          page.relation_date,
          page.relationship_id,
          page.person_id
      ) as row_number,
      selected.person_id is not null as is_selected
    from after_floor page
    left join pg_temp._family_tree_selected selected
      on selected.person_id = page.person_id
  ),
  boundaries as (
    select
      ordered.source_person_id,
      ordered.direction,
      (count(*) filter (where not ordered.is_selected))::integer as hidden_count,
      min(ordered.row_number) filter (where not ordered.is_selected) as first_hidden_row
    from ordered
    group by ordered.source_person_id, ordered.direction
    having count(*) filter (where not ordered.is_selected) > 0
  ),
  non_sibling_resume_points as (
    select
      boundary.source_person_id,
      boundary.direction,
      boundary.hidden_count,
      missing.union_id,
      coalesce(
        prior.display_order,
        floor.display_order,
        '-2147483648'::integer
      ) as display_order,
      coalesce(prior.relation_date, floor.relation_date, '') as relation_date,
      coalesce(
        prior.relationship_id,
        floor.relationship_id,
        '00000000-0000-0000-0000-000000000000'::uuid
      ) as relationship_id
    from boundaries boundary
    join ordered missing
      on missing.source_person_id = boundary.source_person_id
     and missing.direction = boundary.direction
     and missing.row_number = boundary.first_hidden_row
    left join ordered prior
      on prior.source_person_id = boundary.source_person_id
     and prior.direction = boundary.direction
     and prior.row_number = boundary.first_hidden_row - 1
    left join pg_temp._family_tree_cursor_floor floor
      on floor.person_id = boundary.source_person_id
     and floor.direction = boundary.direction
  ),
  -- A source's sibling list depends only on its distinct readable parents.
  -- Sources with the same parent signature therefore share one canonical list;
  -- the only source-specific difference is that a person is not their own
  -- sibling. Cursor floors are included in the state key.
  sibling_source_floors as materialized (
    select
      source.person_id as source_person_id,
      array_agg(
        distinct own_parent.parent_id
        order by own_parent.parent_id
      ) as parent_ids,
      floor.display_order as floor_display_order,
      floor.relation_date as floor_relation_date,
      floor.relationship_id as floor_relationship_id
    from sources source
    join readable_parent_relations own_parent
      on own_parent.child_id = source.person_id
    left join pg_temp._family_tree_cursor_floor floor
      on floor.person_id = source.person_id
     and floor.direction = 'siblings'
    group by
      source.person_id,
      floor.display_order,
      floor.relation_date,
      floor.relationship_id
  ),
  sibling_signatures as materialized (
    select distinct source.parent_ids
    from sibling_source_floors source
  ),
  sibling_signature_candidates as (
    select
      signature.parent_ids,
      sibling.child_id as person_id,
      'parent-set:' || sibling.parent_set_id::text as union_id,
      coalesce(sibling_member.display_order, sibling_set.display_order, 0)
        as display_order,
      coalesce(sibling.start_date, '') as relation_date,
      sibling.id as relationship_id
    from sibling_signatures signature
    cross join lateral unnest(signature.parent_ids)
      as shared_parent(parent_id)
    join readable_parent_relations sibling
      on sibling.parent_id = shared_parent.parent_id
    join public.parent_sets sibling_set
      on sibling_set.id = sibling.parent_set_id
     and sibling_set.tree_id = sibling.tree_id
     and sibling_set.child_id = sibling.child_id
    left join public.family_group_members sibling_member
      on sibling_member.family_group_id = sibling_set.family_group_id
     and sibling_member.person_id = sibling.child_id
     and sibling_member.member_role = 'child'
    join visible_members member
      on member.person_id = sibling.child_id
  ),
  sibling_signature_canonical as materialized (
    select distinct on (
      candidate.parent_ids,
      candidate.person_id
    )
      candidate.parent_ids,
      candidate.person_id,
      candidate.union_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id
    from sibling_signature_candidates candidate
    order by
      candidate.parent_ids,
      candidate.person_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id
  ),
  sibling_states as materialized (
    select
      row_number() over (
        order by
          state_row.parent_ids,
          state_row.floor_display_order,
          state_row.floor_relation_date,
          state_row.floor_relationship_id
      ) as state_id,
      state_row.parent_ids,
      state_row.floor_display_order,
      state_row.floor_relation_date,
      state_row.floor_relationship_id
    from (
      select distinct
        source.parent_ids,
        source.floor_display_order,
        source.floor_relation_date,
        source.floor_relationship_id
      from sibling_source_floors source
    ) state_row
  ),
  sibling_sources_with_state as materialized (
    select
      source.source_person_id,
      state.state_id
    from sibling_source_floors source
    join sibling_states state
      on state.parent_ids = source.parent_ids
     and state.floor_display_order is not distinct from source.floor_display_order
     and state.floor_relation_date is not distinct from source.floor_relation_date
     and state.floor_relationship_id is not distinct from source.floor_relationship_id
  ),
  sibling_state_ordered as materialized (
    select
      state.state_id,
      candidate.person_id,
      candidate.union_id,
      candidate.display_order,
      candidate.relation_date,
      candidate.relationship_id,
      row_number() over (
        partition by state.state_id
        order by
          candidate.display_order,
          candidate.relation_date,
          candidate.relationship_id,
          candidate.person_id
      ) as row_number,
      selected.person_id is not null as is_selected
    from sibling_states state
    join sibling_signature_canonical candidate
      on candidate.parent_ids = state.parent_ids
    left join pg_temp._family_tree_selected selected
      on selected.person_id = candidate.person_id
    where state.floor_relationship_id is null
       or (
         candidate.display_order,
         candidate.relation_date,
         candidate.relationship_id
       ) > (
         state.floor_display_order,
         state.floor_relation_date,
         state.floor_relationship_id
       )
  ),
  sibling_state_boundaries as (
    select
      ordered_sibling.state_id,
      (count(*) filter (
        where not ordered_sibling.is_selected
      ))::integer as hidden_count,
      min(ordered_sibling.row_number) filter (
        where not ordered_sibling.is_selected
      ) as first_hidden_row
    from sibling_state_ordered ordered_sibling
    group by ordered_sibling.state_id
    having count(*) filter (where not ordered_sibling.is_selected) > 0
  ),
  sibling_state_resume_points as (
    select
      boundary.state_id,
      boundary.hidden_count,
      missing.union_id,
      prior.person_id as prior_person_id,
      prior.display_order as prior_display_order,
      prior.relation_date as prior_relation_date,
      prior.relationship_id as prior_relationship_id,
      second_prior.display_order as second_prior_display_order,
      second_prior.relation_date as second_prior_relation_date,
      second_prior.relationship_id as second_prior_relationship_id,
      state.floor_display_order,
      state.floor_relation_date,
      state.floor_relationship_id
    from sibling_state_boundaries boundary
    join sibling_state_ordered missing
      on missing.state_id = boundary.state_id
     and missing.row_number = boundary.first_hidden_row
    left join sibling_state_ordered prior
      on prior.state_id = boundary.state_id
     and prior.row_number = boundary.first_hidden_row - 1
    left join sibling_state_ordered second_prior
      on second_prior.state_id = boundary.state_id
     and second_prior.row_number = boundary.first_hidden_row - 2
    join sibling_states state
      on state.state_id = boundary.state_id
  ),
  sibling_resume_points as (
    select
      source.source_person_id,
      'siblings'::text as direction,
      resume.hidden_count,
      resume.union_id,
      coalesce(
        case
          when resume.prior_person_id = source.source_person_id
            then resume.second_prior_display_order
          else resume.prior_display_order
        end,
        resume.floor_display_order,
        '-2147483648'::integer
      ) as display_order,
      coalesce(
        case
          when resume.prior_person_id = source.source_person_id
            then resume.second_prior_relation_date
          else resume.prior_relation_date
        end,
        resume.floor_relation_date,
        ''
      ) as relation_date,
      coalesce(
        case
          when resume.prior_person_id = source.source_person_id
            then resume.second_prior_relationship_id
          else resume.prior_relationship_id
        end,
        resume.floor_relationship_id,
        '00000000-0000-0000-0000-000000000000'::uuid
      ) as relationship_id
    from sibling_state_resume_points resume
    join sibling_sources_with_state source
      on source.state_id = resume.state_id
  ),
  resume_points as (
    select
      resume.source_person_id,
      resume.direction,
      resume.hidden_count,
      resume.union_id,
      resume.display_order,
      resume.relation_date,
      resume.relationship_id
    from non_sibling_resume_points resume

    union all

    select
      resume.source_person_id,
      resume.direction,
      resume.hidden_count,
      resume.union_id,
      resume.display_order,
      resume.relation_date,
      resume.relationship_id
    from sibling_resume_points resume
  ),
  tokenized as (
    select
      resume.source_person_id,
      resume.direction,
      resume.hidden_count,
      resume.union_id,
      public.family_tree_cursor_encode(jsonb_build_object(
        'version', 1,
        'treeId', target_tree_id,
        'personId', resume.source_person_id,
        'direction', resume.direction,
        'graphVersion', target_graph_version,
        'displayOrder', resume.display_order,
        'date', resume.relation_date,
        'relationshipId', resume.relationship_id
      )) as token
    from resume_points resume
  )
  insert into pg_temp._family_tree_continuations (
    id,
    person_id,
    direction,
    token,
    hidden_count,
    union_id
  )
  select
    md5(
      tokenized.source_person_id::text || ':' ||
      tokenized.direction || ':' ||
      tokenized.token
    ),
    tokenized.source_person_id,
    tokenized.direction,
    tokenized.token,
    tokenized.hidden_count,
    tokenized.union_id
  from tokenized
  on conflict (id) do update
    set token = excluded.token,
        hidden_count = excluded.hidden_count,
        union_id = excluded.union_id;
end;
$$;

revoke execute on function public.family_tree_populate_continuations_v2(
  uuid,
  bigint
) from public, anon, authenticated;

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
  requested_descendant_depth := greatest(0, coalesce((p_request ->> 'descendantDepth')::integer, 0));
  requested_collateral_depth := greatest(0, coalesce((p_request ->> 'collateralDepth')::integer, 0));
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
  create index _family_tree_queue_unprocessed_seq_idx
    on _family_tree_queue (seq)
    where not processed;
  create index _family_tree_queue_dominance_idx
    on _family_tree_queue (
      person_id,
      ancestor_depth,
      descendant_depth,
      collateral_depth
    );

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
        where requested_descendant_depth > 0

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

  -- Analyze the bounded selected set once, then derive all continuations in
  -- one set-based graph pass instead of invoking the neighbor SRF up to 2,400
  -- times with an unbounded page.
  analyze _family_tree_selected;
  perform public.family_tree_populate_continuations_v2(
    requested_tree_id,
    current_graph_version
  );

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

revoke execute on function public.get_family_tree_neighborhood_v1(jsonb)
  from public, anon;
grant execute on function public.get_family_tree_neighborhood_v1(jsonb)
  to authenticated;

commit;
