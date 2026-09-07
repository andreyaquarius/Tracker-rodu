begin;
set local lock_timeout = '5s';

-- The bounded traversal executes the same parameterized neighbor statement
-- once per queued person. Automatic custom planning repeats the expensive
-- multi-direction plan; use a reusable plan only inside this implementation.
-- Public entitlement wrappers, timeouts, graph versions and ACLs are unchanged.
alter function public.get_family_tree_neighborhood_v1_feature_impl(jsonb)
  set plan_cache_mode = 'force_generic_plan';

-- Keep the small selected/ordered/signature CTEs materialized, but allow
-- indexed tree+person predicates through the three whole-tree read CTEs.
-- Membership, confidential/disproven filtering, deduplication, exact hidden
-- counts and cursor floors are deliberately identical to the previous helper.
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
  visible_members as not materialized (
    select member.person_id
    from public.family_tree_persons member
    where member.tree_id = target_tree_id
      and member.member_role <> 'hidden'
  ),
  readable_parent_relations as not materialized (
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
  readable_partnerships as not materialized (
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

revoke execute on function public.family_tree_populate_continuations_v2(uuid,bigint)
  from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;

