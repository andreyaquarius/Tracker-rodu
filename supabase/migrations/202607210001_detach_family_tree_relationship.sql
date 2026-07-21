begin;

-- Detach exactly one canonical graph edge while keeping the compatibility
-- projection in person_relations coherent. Persons, parent sets and family
-- groups deliberately remain in place: this operation removes a relationship,
-- not either participant or a reusable family container.
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
  locked_relationship_id uuid;
  locked_left_person_id uuid;
  locked_right_person_id uuid;
  mapped_relation_ids uuid[] := array[]::uuid[];
  deleted_legacy_relation_ids uuid[] := array[]::uuid[];
  deleted_mapping_count integer := 0;
  deleted_edge_count integer := 0;
  deleted_legacy_count integer := 0;
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

  -- Read the participant pair first. It is checked again after all pair locks
  -- have been acquired so a concurrent relationship edit cannot change scope.
  if normalized_kind = 'parent_child' then
    select relationship.parent_id, relationship.child_id
      into left_person_id, right_person_id
    from public.parent_child_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  elsif normalized_kind = 'partner' then
    select relationship.person_a_id, relationship.person_b_id
      into left_person_id, right_person_id
    from public.partner_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  else
    select relationship.person_a_id, relationship.person_b_id
      into left_person_id, right_person_id
    from public.association_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  end if;

  if left_person_id is null or right_person_id is null then
    raise exception 'FAMILY_TREE_RELATIONSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Two passes around the participant locks avoid a race with the legacy sync
  -- trigger without reversing its own row-lock order.
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

  locked_relationship_id := null;
  if normalized_kind = 'parent_child' then
    select relationship.id, relationship.parent_id, relationship.child_id
      into locked_relationship_id, locked_left_person_id, locked_right_person_id
    from public.parent_child_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
    for update;
  elsif normalized_kind = 'partner' then
    select relationship.id, relationship.person_a_id, relationship.person_b_id
      into locked_relationship_id, locked_left_person_id, locked_right_person_id
    from public.partner_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
    for update;
  else
    select relationship.id, relationship.person_a_id, relationship.person_b_id
      into locked_relationship_id, locked_left_person_id, locked_right_person_id
    from public.association_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id
    for update;
  end if;

  if locked_relationship_id is null then
    raise exception 'FAMILY_TREE_RELATIONSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;
  if locked_left_person_id is distinct from left_person_id
     or locked_right_person_id is distinct from right_person_id then
    raise exception 'FAMILY_TREE_RELATIONSHIP_CHANGED' using errcode = '40001';
  end if;

  perform 1
  from public.legacy_person_relation_graph_edges mapping
  where mapping.project_id = target_project_id
    and mapping.tree_id = target_tree_id
    and mapping.edge_kind = normalized_kind
    and mapping.edge_id = target_relationship_id
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
    and mapping.edge_id = target_relationship_id;

  -- Mapping first is essential. Deleting person_relations first would run its
  -- trigger against every edge owned by the same legacy assertion.
  delete from public.legacy_person_relation_graph_edges mapping
  where mapping.project_id = target_project_id
    and mapping.tree_id = target_tree_id
    and mapping.edge_kind = normalized_kind
    and mapping.edge_id = target_relationship_id;
  get diagnostics deleted_mapping_count = row_count;

  if normalized_kind = 'parent_child' then
    delete from public.parent_child_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  elsif normalized_kind = 'partner' then
    delete from public.partner_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  else
    delete from public.association_relationships relationship
    where relationship.id = target_relationship_id
      and relationship.project_id = target_project_id
      and relationship.tree_id = target_tree_id;
  end if;
  get diagnostics deleted_edge_count = row_count;

  if deleted_edge_count <> 1 then
    raise exception 'FAMILY_TREE_RELATIONSHIP_DELETE_RACE' using errcode = '40001';
  end if;

  if pg_catalog.cardinality(mapped_relation_ids) > 0 then
    with removed_legacy as (
      delete from public.person_relations relation
      where relation.project_id = target_project_id
        and relation.id = any(mapped_relation_ids)
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
      'legacyRelationIds', pg_catalog.to_jsonb(deleted_legacy_relation_ids)
    )
  );

  return pg_catalog.jsonb_build_object(
    'deleted', true,
    'kind', normalized_kind,
    'relationshipId', target_relationship_id,
    'treeId', target_tree_id,
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
