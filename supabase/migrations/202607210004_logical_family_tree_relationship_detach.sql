begin;

-- GEDCOM imports write the legacy person_relations rows and the canonical
-- family-tree graph in separate, resumable phases. While an import is active,
-- the compatibility trigger is deliberately suppressed, so older imports can
-- legitimately be missing legacy_person_relation_graph_edges rows. Rebuild the
-- bridge narrowly: one import source, one tree, one pair, one semantic type and
-- one GEDCOM family record.
create or replace function security_private.backfill_gedcom_relation_graph_mappings(
  target_project_id uuid,
  target_tree_id uuid
)
returns integer
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  inserted_count integer := 0;
begin
  with tree_source as (
    select
      tree.id,
      tree.project_id,
      nullif(pg_catalog.btrim(tree.settings ->> 'import_source_key'), '') as import_source_key
    from public.family_trees tree
    where tree.id = target_tree_id
      and tree.project_id = target_project_id
      and tree.settings ->> 'source' = 'gedcom_import'
      and nullif(pg_catalog.btrim(tree.settings ->> 'import_source_key'), '') is not null
  ), mapping_candidates as (
    select
      relation.project_id,
      relation.id as relation_id,
      relationship.tree_id,
      'parent_child'::text as edge_kind,
      relationship.id as edge_id,
      pg_catalog.row_number() over (
        partition by relation.id
        order by
          relationship.is_primary_for_display desc,
          relationship.confidence desc,
          relationship.created_at,
          relationship.id
      ) as candidate_order
    from tree_source source
    join public.person_relations relation
      on relation.project_id = source.project_id
     and coalesce(
       nullif(pg_catalog.btrim(relation.import_source_key), ''),
       nullif(pg_catalog.btrim(relation.gedcom_metadata ->> 'importSourceKey'), '')
     ) = source.import_source_key
    join public.parent_child_relationships relationship
      on relationship.project_id = source.project_id
     and relationship.tree_id = source.id
    join public.parent_sets parent_set
      on parent_set.id = relationship.parent_set_id
     and parent_set.project_id = relationship.project_id
    left join public.family_groups family_group
      on family_group.id = relationship.family_group_id
     and family_group.project_id = relationship.project_id
    where coalesce(
      nullif(pg_catalog.btrim(relation.gedcom_metadata ->> 'familyXref'), ''),
      ''
    ) = coalesce(
      nullif(pg_catalog.btrim(relationship.metadata ->> 'familyXref'), ''),
      nullif(pg_catalog.btrim(parent_set.metadata ->> 'familyXref'), ''),
      nullif(pg_catalog.btrim(family_group.metadata ->> 'familyXref'), ''),
      ''
    )
      and (
        (
          relationship.relationship_type = 'biological'
          and (
            (
              relation.person_id = relationship.child_id
              and relation.related_person_id = relationship.parent_id
              and relation.relation_type in ('батько', 'мати')
            )
            or
            (
              relation.person_id = relationship.parent_id
              and relation.related_person_id = relationship.child_id
              and relation.relation_type in ('дитина', 'син', 'донька')
            )
          )
        )
        or (
          relationship.relationship_type = 'presumed'
          and relation.person_id = relationship.child_id
          and relation.related_person_id = relationship.parent_id
          and relation.relation_type = 'батько або мати'
        )
        or (
          relationship.relationship_type = 'step'
          and (
            (
              relation.person_id = relationship.child_id
              and relation.related_person_id = relationship.parent_id
              and relation.relation_type in ('вітчим', 'мачуха')
            )
            or
            (
              relation.person_id = relationship.parent_id
              and relation.related_person_id = relationship.child_id
              and relation.relation_type in ('пасинок', 'падчерка')
            )
          )
        )
        or (
          relationship.relationship_type = 'guardian'
          and (
            (
              relation.person_id = relationship.child_id
              and relation.related_person_id = relationship.parent_id
              and relation.relation_type = 'опікун'
            )
            or
            (
              relation.person_id = relationship.parent_id
              and relation.related_person_id = relationship.child_id
              and relation.relation_type = 'підопічний'
            )
          )
        )
        or (
          relationship.relationship_type = 'adoptive'
          and (
            (
              relation.person_id = relationship.child_id
              and relation.related_person_id = relationship.parent_id
              and relation.relation_type = 'усиновлювач'
            )
            or
            (
              relation.person_id = relationship.parent_id
              and relation.related_person_id = relationship.child_id
              and relation.relation_type = 'усиновлена дитина'
            )
          )
        )
      )
      and not exists (
        select 1
        from public.legacy_person_relation_graph_edges existing
        where existing.relation_id = relation.id
          and existing.tree_id = source.id
          and existing.edge_kind = 'parent_child'
      )

    union all

    select
      relation.project_id,
      relation.id as relation_id,
      relationship.tree_id,
      'partner'::text as edge_kind,
      relationship.id as edge_id,
      pg_catalog.row_number() over (
        partition by relation.id
        order by
          relationship.is_primary_for_display desc,
          relationship.confidence desc,
          relationship.created_at,
          relationship.id
      ) as candidate_order
    from tree_source source
    join public.person_relations relation
      on relation.project_id = source.project_id
     and coalesce(
       nullif(pg_catalog.btrim(relation.import_source_key), ''),
       nullif(pg_catalog.btrim(relation.gedcom_metadata ->> 'importSourceKey'), '')
     ) = source.import_source_key
    join public.partner_relationships relationship
      on relationship.project_id = source.project_id
     and relationship.tree_id = source.id
     and relationship.relationship_type = 'marriage'
     and least(relationship.person_a_id, relationship.person_b_id)
       = least(relation.person_id, relation.related_person_id)
     and greatest(relationship.person_a_id, relationship.person_b_id)
       = greatest(relation.person_id, relation.related_person_id)
    left join public.family_groups family_group
      on family_group.id = relationship.family_group_id
     and family_group.project_id = relationship.project_id
    where relation.relation_type in ('чоловік', 'дружина', 'подружжя')
      and coalesce(
        nullif(pg_catalog.btrim(relation.gedcom_metadata ->> 'familyXref'), ''),
        ''
      ) = coalesce(
        nullif(pg_catalog.btrim(relationship.metadata ->> 'familyXref'), ''),
        nullif(pg_catalog.btrim(family_group.metadata ->> 'familyXref'), ''),
        ''
      )
      and not exists (
        select 1
        from public.legacy_person_relation_graph_edges existing
        where existing.relation_id = relation.id
          and existing.tree_id = source.id
          and existing.edge_kind = 'partner'
      )
  )
  insert into public.legacy_person_relation_graph_edges (
    project_id,
    relation_id,
    tree_id,
    edge_kind,
    edge_id
  )
  select
    candidate.project_id,
    candidate.relation_id,
    candidate.tree_id,
    candidate.edge_kind,
    candidate.edge_id
  from mapping_candidates candidate
  where candidate.candidate_order = 1
  on conflict (relation_id, edge_kind, edge_id) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;

revoke all on function security_private.backfill_gedcom_relation_graph_mappings(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Repair mappings for already completed GEDCOM trees. The same helper is also
-- called lazily by detach, covering imports completed after this migration.
do $backfill$
declare
  target record;
begin
  for target in
    select tree.project_id, tree.id as tree_id
    from public.family_trees tree
    where tree.settings ->> 'source' = 'gedcom_import'
      and nullif(pg_catalog.btrim(tree.settings ->> 'import_source_key'), '') is not null
    order by tree.project_id, tree.id
  loop
    perform security_private.backfill_gedcom_relation_graph_mappings(
      target.project_id,
      target.tree_id
    );
  end loop;
end;
$backfill$;

create or replace function security_private.detach_family_tree_relationship(
  target_project_id uuid,
  target_tree_id uuid,
  target_kind text,
  target_relationship_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  normalized_kind text := pg_catalog.lower(pg_catalog.btrim(coalesce(target_kind, '')));
  left_person_id uuid;
  right_person_id uuid;
  logical_relationship_type text;
  target_family_xref text := '';
  tree_import_source_key text := '';
  logical_edge_ids uuid[] := array[]::uuid[];
  mapped_relation_ids uuid[] := array[]::uuid[];
  fallback_relation_ids uuid[] := array[]::uuid[];
  candidate_relation_ids uuid[] := array[]::uuid[];
  deleted_relationship_ids uuid[] := array[]::uuid[];
  deleted_legacy_relation_ids uuid[] := array[]::uuid[];
  deleted_mapping_count integer := 0;
  deleted_edge_count integer := 0;
  deleted_legacy_count integer := 0;
  remaining_logical_edges integer := 0;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if target_project_id is null or target_tree_id is null or target_relationship_id is null then
    raise exception 'FAMILY_TREE_RELATIONSHIP_TARGET_REQUIRED' using errcode = '22023';
  end if;
  if normalized_kind not in ('parent_child', 'partner', 'association') then
    raise exception 'INVALID_FAMILY_TREE_RELATIONSHIP_KIND' using errcode = '22023';
  end if;
  if not security_private.can_edit_project(target_project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  if normalized_kind = 'parent_child' then
    select
      relationship.parent_id,
      relationship.child_id,
      relationship.relationship_type,
      coalesce(
        nullif(pg_catalog.btrim(relationship.metadata ->> 'familyXref'), ''),
        nullif(pg_catalog.btrim(parent_set.metadata ->> 'familyXref'), ''),
        nullif(pg_catalog.btrim(family_group.metadata ->> 'familyXref'), ''),
        ''
      )
      into left_person_id, right_person_id, logical_relationship_type, target_family_xref
    from public.parent_child_relationships relationship
    join public.parent_sets parent_set
      on parent_set.id = relationship.parent_set_id
     and parent_set.project_id = relationship.project_id
    left join public.family_groups family_group
      on family_group.id = relationship.family_group_id
     and family_group.project_id = relationship.project_id
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  elsif normalized_kind = 'partner' then
    select
      relationship.person_a_id,
      relationship.person_b_id,
      relationship.relationship_type,
      coalesce(
        nullif(pg_catalog.btrim(relationship.metadata ->> 'familyXref'), ''),
        nullif(pg_catalog.btrim(family_group.metadata ->> 'familyXref'), ''),
        ''
      )
      into left_person_id, right_person_id, logical_relationship_type, target_family_xref
    from public.partner_relationships relationship
    left join public.family_groups family_group
      on family_group.id = relationship.family_group_id
     and family_group.project_id = relationship.project_id
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  else
    select
      relationship.person_a_id,
      relationship.person_b_id,
      relationship.association_type,
      coalesce(nullif(pg_catalog.btrim(relationship.metadata ->> 'familyXref'), ''), '')
      into left_person_id, right_person_id, logical_relationship_type, target_family_xref
    from public.association_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  end if;

  if left_person_id is null or right_person_id is null or logical_relationship_type is null then
    raise exception 'FAMILY_TREE_RELATIONSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(nullif(pg_catalog.btrim(tree.settings ->> 'import_source_key'), ''), '')
    into tree_import_source_key
  from public.family_trees tree
  where tree.id = target_tree_id
    and tree.project_id = target_project_id;

  -- Preserve the compatibility trigger's relation/person lock order on both
  -- sides of the participant lock. This closes the update race without
  -- reversing the order used by the legacy projection.
  perform 1
  from public.person_relations relation
  where relation.project_id = target_project_id
    and (
      (relation.person_id = left_person_id and relation.related_person_id = right_person_id)
      or
      (relation.person_id = right_person_id and relation.related_person_id = left_person_id)
    )
  order by relation.id
  for update;

  perform 1
  from public.persons person
  where person.project_id = target_project_id
    and person.id in (left_person_id, right_person_id)
  order by person.id
  for update;

  perform 1
  from public.person_relations relation
  where relation.project_id = target_project_id
    and (
      (relation.person_id = left_person_id and relation.related_person_id = right_person_id)
      or
      (relation.person_id = right_person_id and relation.related_person_id = left_person_id)
    )
  order by relation.id
  for update;

  perform security_private.backfill_gedcom_relation_graph_mappings(
    target_project_id,
    target_tree_id
  );

  if normalized_kind = 'parent_child' then
    perform 1
    from public.parent_child_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and relationship.parent_id = left_person_id
      and relationship.child_id = right_person_id
      and relationship.relationship_type = logical_relationship_type
    order by relationship.id
    for update;

    select coalesce(
      pg_catalog.array_agg(relationship.id order by relationship.id),
      array[]::uuid[]
    )
      into logical_edge_ids
    from public.parent_child_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and relationship.parent_id = left_person_id
      and relationship.child_id = right_person_id
      and relationship.relationship_type = logical_relationship_type;
  elsif normalized_kind = 'partner' then
    perform 1
    from public.partner_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and least(relationship.person_a_id, relationship.person_b_id)
        = least(left_person_id, right_person_id)
      and greatest(relationship.person_a_id, relationship.person_b_id)
        = greatest(left_person_id, right_person_id)
      and relationship.relationship_type = logical_relationship_type
    order by relationship.id
    for update;

    select coalesce(
      pg_catalog.array_agg(relationship.id order by relationship.id),
      array[]::uuid[]
    )
      into logical_edge_ids
    from public.partner_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and least(relationship.person_a_id, relationship.person_b_id)
        = least(left_person_id, right_person_id)
      and greatest(relationship.person_a_id, relationship.person_b_id)
        = greatest(left_person_id, right_person_id)
      and relationship.relationship_type = logical_relationship_type;
  else
    perform 1
    from public.association_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and relationship.person_a_id = left_person_id
      and relationship.person_b_id = right_person_id
      and relationship.association_type = logical_relationship_type
    order by relationship.id
    for update;

    select coalesce(
      pg_catalog.array_agg(relationship.id order by relationship.id),
      array[]::uuid[]
    )
      into logical_edge_ids
    from public.association_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and relationship.person_a_id = left_person_id
      and relationship.person_b_id = right_person_id
      and relationship.association_type = logical_relationship_type;
  end if;

  if not (target_relationship_id = any(logical_edge_ids)) then
    raise exception 'FAMILY_TREE_RELATIONSHIP_CHANGED' using errcode = '40001';
  end if;

  perform 1
  from public.legacy_person_relation_graph_edges mapping
  where mapping.project_id = target_project_id
    and mapping.tree_id = target_tree_id
    and mapping.edge_kind = normalized_kind
    and mapping.edge_id = any(logical_edge_ids)
  order by mapping.relation_id, mapping.id
  for update;

  select coalesce(
    pg_catalog.array_agg(distinct mapping.relation_id order by mapping.relation_id),
    array[]::uuid[]
  )
    into mapped_relation_ids
  from public.legacy_person_relation_graph_edges mapping
  where mapping.project_id = target_project_id
    and mapping.tree_id = target_tree_id
    and mapping.edge_kind = normalized_kind
    and mapping.edge_id = any(logical_edge_ids);

  -- Defensive fallback for an imported relationship that predates the mapping
  -- backfill or could not be matched to a single preferred duplicate. It is
  -- intentionally unavailable to ordinary/manual rows and never crosses a
  -- GEDCOM source or family record.
  if tree_import_source_key <> '' and normalized_kind in ('parent_child', 'partner') then
    select coalesce(
      pg_catalog.array_agg(distinct relation.id order by relation.id),
      array[]::uuid[]
    )
      into fallback_relation_ids
    from public.person_relations relation
    where relation.project_id = target_project_id
      and coalesce(
        nullif(pg_catalog.btrim(relation.import_source_key), ''),
        nullif(pg_catalog.btrim(relation.gedcom_metadata ->> 'importSourceKey'), '')
      ) = tree_import_source_key
      and coalesce(
        nullif(pg_catalog.btrim(relation.gedcom_metadata ->> 'familyXref'), ''),
        ''
      ) = target_family_xref
      and (
        (
          normalized_kind = 'parent_child'
          and (
            (
              logical_relationship_type = 'biological'
              and (
                (
                  relation.person_id = right_person_id
                  and relation.related_person_id = left_person_id
                  and relation.relation_type in ('батько', 'мати')
                )
                or
                (
                  relation.person_id = left_person_id
                  and relation.related_person_id = right_person_id
                  and relation.relation_type in ('дитина', 'син', 'донька')
                )
              )
            )
            or (
              logical_relationship_type = 'presumed'
              and relation.person_id = right_person_id
              and relation.related_person_id = left_person_id
              and relation.relation_type = 'батько або мати'
            )
            or (
              logical_relationship_type = 'step'
              and (
                (
                  relation.person_id = right_person_id
                  and relation.related_person_id = left_person_id
                  and relation.relation_type in ('вітчим', 'мачуха')
                )
                or
                (
                  relation.person_id = left_person_id
                  and relation.related_person_id = right_person_id
                  and relation.relation_type in ('пасинок', 'падчерка')
                )
              )
            )
            or (
              logical_relationship_type = 'guardian'
              and (
                (
                  relation.person_id = right_person_id
                  and relation.related_person_id = left_person_id
                  and relation.relation_type = 'опікун'
                )
                or
                (
                  relation.person_id = left_person_id
                  and relation.related_person_id = right_person_id
                  and relation.relation_type = 'підопічний'
                )
              )
            )
            or (
              logical_relationship_type = 'adoptive'
              and (
                (
                  relation.person_id = right_person_id
                  and relation.related_person_id = left_person_id
                  and relation.relation_type = 'усиновлювач'
                )
                or
                (
                  relation.person_id = left_person_id
                  and relation.related_person_id = right_person_id
                  and relation.relation_type = 'усиновлена дитина'
                )
              )
            )
          )
        )
        or (
          normalized_kind = 'partner'
          and logical_relationship_type = 'marriage'
          and relation.relation_type in ('чоловік', 'дружина', 'подружжя')
          and least(relation.person_id, relation.related_person_id)
            = least(left_person_id, right_person_id)
          and greatest(relation.person_id, relation.related_person_id)
            = greatest(left_person_id, right_person_id)
        )
      );
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct ids.relation_id order by ids.relation_id),
    array[]::uuid[]
  )
    into candidate_relation_ids
  from pg_catalog.unnest(mapped_relation_ids || fallback_relation_ids) as ids(relation_id);

  perform 1
  from public.person_relations relation
  where relation.project_id = target_project_id
    and relation.id = any(candidate_relation_ids)
  order by relation.id
  for update;

  delete from public.legacy_person_relation_graph_edges mapping
  where mapping.project_id = target_project_id
    and mapping.tree_id = target_tree_id
    and mapping.edge_kind = normalized_kind
    and mapping.edge_id = any(logical_edge_ids);
  get diagnostics deleted_mapping_count = row_count;

  if normalized_kind = 'parent_child' then
    with removed as (
      delete from public.parent_child_relationships relationship
      where relationship.project_id = target_project_id
        and relationship.tree_id = target_tree_id
        and relationship.id = any(logical_edge_ids)
      returning relationship.id
    )
    select
      coalesce(pg_catalog.array_agg(removed.id order by removed.id), array[]::uuid[]),
      pg_catalog.count(*)::integer
      into deleted_relationship_ids, deleted_edge_count
    from removed;
  elsif normalized_kind = 'partner' then
    with removed as (
      delete from public.partner_relationships relationship
      where relationship.project_id = target_project_id
        and relationship.tree_id = target_tree_id
        and relationship.id = any(logical_edge_ids)
      returning relationship.id
    )
    select
      coalesce(pg_catalog.array_agg(removed.id order by removed.id), array[]::uuid[]),
      pg_catalog.count(*)::integer
      into deleted_relationship_ids, deleted_edge_count
    from removed;
  else
    with removed as (
      delete from public.association_relationships relationship
      where relationship.project_id = target_project_id
        and relationship.tree_id = target_tree_id
        and relationship.id = any(logical_edge_ids)
      returning relationship.id
    )
    select
      coalesce(pg_catalog.array_agg(removed.id order by removed.id), array[]::uuid[]),
      pg_catalog.count(*)::integer
      into deleted_relationship_ids, deleted_edge_count
    from removed;
  end if;

  if deleted_edge_count <> pg_catalog.cardinality(logical_edge_ids)
     or not (target_relationship_id = any(deleted_relationship_ids)) then
    raise exception 'FAMILY_TREE_RELATIONSHIP_DELETE_RACE' using errcode = '40001';
  end if;

  if pg_catalog.cardinality(candidate_relation_ids) > 0 then
    with removed_legacy as (
      delete from public.person_relations relation
      where relation.project_id = target_project_id
        and relation.id = any(candidate_relation_ids)
        and not exists (
          select 1
          from public.legacy_person_relation_graph_edges remaining
          where remaining.relation_id = relation.id
        )
      returning relation.id
    )
    select
      coalesce(
        pg_catalog.array_agg(removed_legacy.id order by removed_legacy.id),
        array[]::uuid[]
      ),
      pg_catalog.count(*)::integer
      into deleted_legacy_relation_ids, deleted_legacy_count
    from removed_legacy;
  end if;

  if normalized_kind = 'parent_child' then
    select pg_catalog.count(*)::integer
      into remaining_logical_edges
    from public.parent_child_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and relationship.parent_id = left_person_id
      and relationship.child_id = right_person_id
      and relationship.relationship_type = logical_relationship_type;
  elsif normalized_kind = 'partner' then
    select pg_catalog.count(*)::integer
      into remaining_logical_edges
    from public.partner_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and least(relationship.person_a_id, relationship.person_b_id)
        = least(left_person_id, right_person_id)
      and greatest(relationship.person_a_id, relationship.person_b_id)
        = greatest(left_person_id, right_person_id)
      and relationship.relationship_type = logical_relationship_type;
  else
    select pg_catalog.count(*)::integer
      into remaining_logical_edges
    from public.association_relationships relationship
    where relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
      and relationship.person_a_id = left_person_id
      and relationship.person_b_id = right_person_id
      and relationship.association_type = logical_relationship_type;
  end if;

  if remaining_logical_edges <> 0 then
    raise exception 'FAMILY_TREE_LOGICAL_RELATIONSHIP_DELETE_RACE' using errcode = '40001';
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
    'family_tree_relationship_detached',
    'persons',
    target_relationship_id,
    pg_catalog.jsonb_build_object(
      'module', 'persons',
      'entityId', target_relationship_id,
      'treeId', target_tree_id,
      'kind', normalized_kind,
      'relationshipType', logical_relationship_type,
      'leftPersonId', left_person_id,
      'rightPersonId', right_person_id,
      'deletedRelationshipIds', pg_catalog.to_jsonb(deleted_relationship_ids),
      'legacyRelationIds', pg_catalog.to_jsonb(deleted_legacy_relation_ids)
    )
  );

  return pg_catalog.jsonb_build_object(
    'deleted', true,
    'kind', normalized_kind,
    'relationshipId', target_relationship_id,
    'treeId', target_tree_id,
    'leftPersonId', left_person_id,
    'rightPersonId', right_person_id,
    'deletedRelationshipIds', pg_catalog.to_jsonb(deleted_relationship_ids),
    'remainingLogicalEdges', remaining_logical_edges,
    'deletedMappings', deleted_mapping_count,
    'deletedLegacyRelations', deleted_legacy_count,
    'deletedLegacyRelationIds', pg_catalog.to_jsonb(deleted_legacy_relation_ids)
  );
end;
$function$;

revoke all on function security_private.detach_family_tree_relationship(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.detach_family_tree_relationship(uuid, uuid, text, uuid)
  to authenticated, service_role;

create or replace function public.detach_family_tree_relationship(
  target_project_id uuid,
  target_tree_id uuid,
  target_kind text,
  target_relationship_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.detach_family_tree_relationship($1, $2, $3, $4);
$wrapper$;

revoke all on function public.detach_family_tree_relationship(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.detach_family_tree_relationship(uuid, uuid, text, uuid)
  to authenticated, service_role;

commit;
