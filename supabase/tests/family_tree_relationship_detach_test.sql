begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(32);

select has_function(
  'public',
  'detach_family_tree_relationship',
  array['uuid', 'uuid', 'text', 'uuid'],
  'the exact family-tree relationship detach RPC exists'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'd7100000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'family-tree-detach-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'd7100000-0000-0000-0000-000000000001',
  'family-tree-detach-owner@example.test',
  'Family tree detach owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values
  (
    'd7200000-0000-0000-0000-000000000001',
    'd7100000-0000-0000-0000-000000000001',
    'Family tree detach fixture'
  ),
  (
    'd7200000-0000-0000-0000-000000000002',
    'd7100000-0000-0000-0000-000000000001',
    'Foreign project for exact-scope checks'
  );

insert into public.persons (
  id,
  project_id,
  full_name,
  created_by
) values
  (
    'd7400000-0000-0000-0000-000000000001',
    'd7200000-0000-0000-0000-000000000001',
    'Fixture parent',
    'd7100000-0000-0000-0000-000000000001'
  ),
  (
    'd7400000-0000-0000-0000-000000000002',
    'd7200000-0000-0000-0000-000000000001',
    'Fixture child',
    'd7100000-0000-0000-0000-000000000001'
  );

insert into public.family_trees (
  id,
  project_id,
  title,
  root_person_id,
  is_default,
  privacy_status,
  created_by
) values
  (
    'd7300000-0000-0000-0000-000000000001',
    'd7200000-0000-0000-0000-000000000001',
    'Target tree',
    'd7400000-0000-0000-0000-000000000002',
    true,
    'project',
    'd7100000-0000-0000-0000-000000000001'
  ),
  (
    'd7300000-0000-0000-0000-000000000002',
    'd7200000-0000-0000-0000-000000000001',
    'Other tree in the target project',
    null,
    false,
    'project',
    'd7100000-0000-0000-0000-000000000001'
  ),
  (
    'd7300000-0000-0000-0000-000000000003',
    'd7200000-0000-0000-0000-000000000002',
    'Tree in another editable project',
    null,
    true,
    'project',
    'd7100000-0000-0000-0000-000000000001'
  );

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role,
  display_order
) values
  (
    'd7200000-0000-0000-0000-000000000001',
    'd7300000-0000-0000-0000-000000000001',
    'd7400000-0000-0000-0000-000000000001',
    'member',
    1
  ),
  (
    'd7200000-0000-0000-0000-000000000001',
    'd7300000-0000-0000-0000-000000000001',
    'd7400000-0000-0000-0000-000000000002',
    'root',
    0
  );

-- Let the compatibility trigger create two distinct canonical edges and their
-- mappings for the same pair. Deleting the biological edge must not touch the
-- step-parent edge merely because both assertions share the same people.
insert into public.person_relations (
  id,
  project_id,
  person_id,
  related_person_id,
  relation_type,
  created_by
) values
  (
    'd7500000-0000-0000-0000-000000000001',
    'd7200000-0000-0000-0000-000000000001',
    'd7400000-0000-0000-0000-000000000002',
    'd7400000-0000-0000-0000-000000000001',
    'батько',
    'd7100000-0000-0000-0000-000000000001'
  ),
  (
    'd7500000-0000-0000-0000-000000000002',
    'd7200000-0000-0000-0000-000000000001',
    'd7400000-0000-0000-0000-000000000002',
    'd7400000-0000-0000-0000-000000000001',
    'вітчим',
    'd7100000-0000-0000-0000-000000000001'
  );

select is(
  (
    select count(*)::integer
    from public.legacy_person_relation_graph_edges mapping
    where mapping.relation_id in (
      'd7500000-0000-0000-0000-000000000001',
      'd7500000-0000-0000-0000-000000000002'
    )
  ),
  2,
  'the fixture starts with one compatibility mapping per exact assertion'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"d7100000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$
    select public.detach_family_tree_relationship(
      'd7200000-0000-0000-0000-000000000001'::uuid,
      'd7300000-0000-0000-0000-000000000002'::uuid,
      'parent_child',
      (
        select mapping.edge_id
        from public.legacy_person_relation_graph_edges mapping
        where mapping.relation_id = 'd7500000-0000-0000-0000-000000000001'
      )
    )
  $$,
  'P0002',
  'FAMILY_TREE_RELATIONSHIP_NOT_FOUND',
  'an edge id from another tree cannot be detached'
);

select throws_ok(
  $$
    select public.detach_family_tree_relationship(
      'd7200000-0000-0000-0000-000000000002'::uuid,
      'd7300000-0000-0000-0000-000000000003'::uuid,
      'parent_child',
      (
        select mapping.edge_id
        from public.legacy_person_relation_graph_edges mapping
        where mapping.relation_id = 'd7500000-0000-0000-0000-000000000001'
      )
    )
  $$,
  'P0002',
  'FAMILY_TREE_RELATIONSHIP_NOT_FOUND',
  'an edge id from another project cannot be detached'
);

select is(
  (
    select count(*)::integer
    from public.parent_child_relationships relationship
    where relationship.project_id = 'd7200000-0000-0000-0000-000000000001'
      and relationship.tree_id = 'd7300000-0000-0000-0000-000000000001'
      and relationship.parent_id = 'd7400000-0000-0000-0000-000000000001'
      and relationship.child_id = 'd7400000-0000-0000-0000-000000000002'
  ),
  2,
  'scope mismatch failures leave both exact edges unchanged'
);

select is(
  (
    public.detach_family_tree_relationship(
      'd7200000-0000-0000-0000-000000000001'::uuid,
      'd7300000-0000-0000-0000-000000000001'::uuid,
      'parent_child',
      (
        select mapping.edge_id
        from public.legacy_person_relation_graph_edges mapping
        where mapping.relation_id = 'd7500000-0000-0000-0000-000000000001'
      )
    ) - 'relationshipId' - 'deletedRelationshipIds'
  ),
  jsonb_build_object(
    'deleted', true,
    'kind', 'parent_child',
    'treeId', 'd7300000-0000-0000-0000-000000000001'::uuid,
    'leftPersonId', 'd7400000-0000-0000-0000-000000000001'::uuid,
    'rightPersonId', 'd7400000-0000-0000-0000-000000000002'::uuid,
    'remainingLogicalEdges', 0,
    'deletedMappings', 1,
    'deletedLegacyRelations', 1,
    'deletedLegacyRelationIds',
      jsonb_build_array('d7500000-0000-0000-0000-000000000001'::uuid)
  ),
  'detaching reports one exact edge, mapping and orphaned legacy assertion'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.parent_child_relationships relationship
    where relationship.project_id = 'd7200000-0000-0000-0000-000000000001'
      and relationship.tree_id = 'd7300000-0000-0000-0000-000000000001'
      and relationship.parent_id = 'd7400000-0000-0000-0000-000000000001'
      and relationship.child_id = 'd7400000-0000-0000-0000-000000000002'
      and relationship.relationship_type = 'biological'
  ),
  0,
  'the requested canonical parent-child edge is deleted'
);

select is(
  (
    select count(*)::integer
    from public.parent_child_relationships relationship
    where relationship.project_id = 'd7200000-0000-0000-0000-000000000001'
      and relationship.tree_id = 'd7300000-0000-0000-0000-000000000001'
      and relationship.parent_id = 'd7400000-0000-0000-0000-000000000001'
      and relationship.child_id = 'd7400000-0000-0000-0000-000000000002'
      and relationship.relationship_type = 'step'
  ),
  1,
  'a different exact edge for the same pair survives'
);

select is(
  (
    select count(*)::integer
    from public.legacy_person_relation_graph_edges mapping
    where mapping.relation_id = 'd7500000-0000-0000-0000-000000000001'
  ),
  0,
  'the deleted edge compatibility mapping is removed'
);

select is(
  (
    select count(*)::integer
    from public.legacy_person_relation_graph_edges mapping
    where mapping.relation_id = 'd7500000-0000-0000-0000-000000000002'
  ),
  1,
  'the other exact edge compatibility mapping survives'
);

select is(
  (
    select count(*)::integer
    from public.person_relations relation
    where relation.id = 'd7500000-0000-0000-0000-000000000001'
  ),
  0,
  'the now-unmapped legacy assertion is removed'
);

select is(
  (
    select count(*)::integer
    from public.person_relations relation
    where relation.id = 'd7500000-0000-0000-0000-000000000002'
  ),
  1,
  'the legacy assertion for the surviving edge remains'
);

select is(
  (
    select count(*)::integer
    from public.persons person
    where person.id in (
      'd7400000-0000-0000-0000-000000000001',
      'd7400000-0000-0000-0000-000000000002'
    )
  ),
  2,
  'detaching a relationship never deletes either person'
);

select is(
  (
    select count(*)::integer
    from public.family_tree_persons membership
    where membership.tree_id = 'd7300000-0000-0000-0000-000000000001'
      and membership.person_id in (
        'd7400000-0000-0000-0000-000000000001',
        'd7400000-0000-0000-0000-000000000002'
      )
  ),
  2,
  'detaching a relationship preserves both tree memberships'
);

select is(
  (
    select count(*)::integer
    from public.parent_sets parent_set
    where parent_set.project_id = 'd7200000-0000-0000-0000-000000000001'
      and parent_set.tree_id = 'd7300000-0000-0000-0000-000000000001'
      and parent_set.child_id = 'd7400000-0000-0000-0000-000000000002'
  ),
  2,
  'reusable parent sets remain after the exact edge is detached'
);

select is(
  (
    select count(*)::integer
    from public.activity_log log_entry
    where log_entry.project_id = 'd7200000-0000-0000-0000-000000000001'
      and log_entry.action = 'family_tree_relationship_detached'
      and log_entry.entity_type = 'persons'
  ),
  1,
  'the successful detach is recorded once in the project activity log'
);

-- A resumable GEDCOM import writes person_relations while its compatibility
-- projection trigger is suppressed, then writes the canonical graph in a
-- separate phase. Reproduce that historical state by removing the generated
-- bridge row, and add a same-type edge in another parent set. The renderer
-- collapses those rows visually, but logical detach must remove both of them.
update public.family_trees
set settings = jsonb_build_object(
  'source', 'gedcom_import',
  'import_source_key', 'fixture-gedcom-source'
)
where id = 'd7300000-0000-0000-0000-000000000001';

insert into public.persons (
  id,
  project_id,
  full_name,
  created_by
) values
  (
    'd7400000-0000-0000-0000-000000000003',
    'd7200000-0000-0000-0000-000000000001',
    'Imported fixture parent',
    'd7100000-0000-0000-0000-000000000001'
  ),
  (
    'd7400000-0000-0000-0000-000000000004',
    'd7200000-0000-0000-0000-000000000001',
    'Imported fixture child',
    'd7100000-0000-0000-0000-000000000001'
  );

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role,
  display_order
) values
  (
    'd7200000-0000-0000-0000-000000000001',
    'd7300000-0000-0000-0000-000000000001',
    'd7400000-0000-0000-0000-000000000003',
    'member',
    2
  ),
  (
    'd7200000-0000-0000-0000-000000000001',
    'd7300000-0000-0000-0000-000000000001',
    'd7400000-0000-0000-0000-000000000004',
    'member',
    3
  )
on conflict (tree_id, person_id) do nothing;

insert into public.person_relations (
  id,
  project_id,
  person_id,
  related_person_id,
  relation_type,
  import_source_key,
  gedcom_metadata,
  created_by
) values (
  'd7500000-0000-0000-0000-000000000003',
  'd7200000-0000-0000-0000-000000000001',
  'd7400000-0000-0000-0000-000000000004',
  'd7400000-0000-0000-0000-000000000003',
  'батько',
  'fixture-gedcom-source',
  jsonb_build_object(
    'importSourceKey', 'fixture-gedcom-source',
    'familyXref', '@F-LOGICAL@'
  ),
  'd7100000-0000-0000-0000-000000000001'
);

create temporary table logical_detach_target as
select mapping.edge_id
from public.legacy_person_relation_graph_edges mapping
where mapping.relation_id = 'd7500000-0000-0000-0000-000000000003'
  and mapping.edge_kind = 'parent_child'
limit 1;

update public.parent_child_relationships relationship
set metadata = relationship.metadata || jsonb_build_object('familyXref', '@F-LOGICAL@')
where relationship.id = (select edge_id from logical_detach_target);

update public.parent_sets parent_set
set metadata = parent_set.metadata || jsonb_build_object('familyXref', '@F-LOGICAL@')
where parent_set.id = (
  select relationship.parent_set_id
  from public.parent_child_relationships relationship
  where relationship.id = (select edge_id from logical_detach_target)
);

delete from public.legacy_person_relation_graph_edges mapping
where mapping.relation_id = 'd7500000-0000-0000-0000-000000000003'
  and mapping.edge_kind = 'parent_child';

insert into public.parent_sets (
  id,
  project_id,
  tree_id,
  child_id,
  set_type,
  is_preferred_for_display,
  is_default_for_pedigree,
  display_order,
  metadata,
  created_by
) values (
  'd7600000-0000-0000-0000-000000000003',
  'd7200000-0000-0000-0000-000000000001',
  'd7300000-0000-0000-0000-000000000001',
  'd7400000-0000-0000-0000-000000000004',
  'biological',
  false,
  false,
  1,
  jsonb_build_object('source', 'gedcom_import', 'familyXref', '@F-LOGICAL@'),
  'd7100000-0000-0000-0000-000000000001'
);

insert into public.parent_child_relationships (
  id,
  project_id,
  tree_id,
  parent_id,
  child_id,
  parent_set_id,
  relationship_type,
  parent_role_label,
  evidence_status,
  confidence,
  is_primary_for_display,
  metadata,
  created_by
) values (
  'd7700000-0000-0000-0000-000000000003',
  'd7200000-0000-0000-0000-000000000001',
  'd7300000-0000-0000-0000-000000000001',
  'd7400000-0000-0000-0000-000000000003',
  'd7400000-0000-0000-0000-000000000004',
  'd7600000-0000-0000-0000-000000000003',
  'biological',
  'father',
  'proven',
  100,
  true,
  jsonb_build_object('source', 'gedcom_import', 'familyXref', '@F-LOGICAL@'),
  'd7100000-0000-0000-0000-000000000001'
);

select is(
  (
    select count(*)::integer
    from public.legacy_person_relation_graph_edges mapping
    where mapping.relation_id = 'd7500000-0000-0000-0000-000000000003'
  ),
  0,
  'the GEDCOM fixture starts without a compatibility mapping'
);

create temporary table logical_detach_result (payload jsonb);
grant select, insert on logical_detach_result to authenticated;
grant select on logical_detach_target to authenticated;

set local role authenticated;
insert into logical_detach_result (payload)
select public.detach_family_tree_relationship(
  'd7200000-0000-0000-0000-000000000001'::uuid,
  'd7300000-0000-0000-0000-000000000001'::uuid,
  'parent_child',
  (select edge_id from logical_detach_target)
);
reset role;

select is(
  jsonb_array_length((select payload -> 'deletedRelationshipIds' from logical_detach_result)),
  2,
  'logical detach removes every same-pair same-type canonical duplicate'
);

select ok(
  exists (
    select 1
    from logical_detach_result result,
      jsonb_array_elements_text(result.payload -> 'deletedRelationshipIds') deleted_id
    where deleted_id = (select edge_id::text from logical_detach_target)
  ),
  'deletedRelationshipIds includes the requested relationship id'
);

select is(
  (select payload ->> 'leftPersonId' from logical_detach_result),
  'd7400000-0000-0000-0000-000000000003',
  'the response identifies the logical left participant'
);

select is(
  (select payload ->> 'rightPersonId' from logical_detach_result),
  'd7400000-0000-0000-0000-000000000004',
  'the response identifies the logical right participant'
);

select is(
  ((select payload ->> 'remainingLogicalEdges' from logical_detach_result))::integer,
  0,
  'the response confirms that no logical duplicate remains'
);

select is(
  (select payload -> 'deletedLegacyRelationIds' from logical_detach_result),
  jsonb_build_array('d7500000-0000-0000-0000-000000000003'::uuid),
  'the response returns the previously unmapped GEDCOM legacy relation id'
);

select is(
  ((select payload ->> 'deletedMappings' from logical_detach_result))::integer,
  1,
  'detach lazily backfills and removes the narrow GEDCOM compatibility mapping'
);

select is(
  (
    select count(*)::integer
    from public.parent_child_relationships relationship
    where relationship.project_id = 'd7200000-0000-0000-0000-000000000001'
      and relationship.tree_id = 'd7300000-0000-0000-0000-000000000001'
      and relationship.parent_id = 'd7400000-0000-0000-0000-000000000003'
      and relationship.child_id = 'd7400000-0000-0000-0000-000000000004'
      and relationship.relationship_type = 'biological'
  ),
  0,
  'the database contains no hidden canonical duplicate after logical detach'
);

select is(
  (
    select count(*)::integer
    from public.person_relations relation
    where relation.id = 'd7500000-0000-0000-0000-000000000003'
  ),
  0,
  'the Persons-module legacy relation is deleted with its logical edge'
);

insert into public.parent_sets (
  id,
  project_id,
  tree_id,
  child_id,
  set_type,
  is_preferred_for_display,
  is_default_for_pedigree,
  display_order,
  created_by
) values (
  'd7600000-0000-0000-0000-000000000004',
  'd7200000-0000-0000-0000-000000000001',
  'd7300000-0000-0000-0000-000000000001',
  'd7400000-0000-0000-0000-000000000004',
  'biological',
  false,
  false,
  2,
  'd7100000-0000-0000-0000-000000000001'
);

select lives_ok(
  $$
    insert into public.parent_child_relationships (
      id,
      project_id,
      tree_id,
      parent_id,
      child_id,
      parent_set_id,
      relationship_type,
      parent_role_label,
      created_by
    ) values (
      'd7700000-0000-0000-0000-000000000004',
      'd7200000-0000-0000-0000-000000000001',
      'd7300000-0000-0000-0000-000000000001',
      'd7400000-0000-0000-0000-000000000003',
      'd7400000-0000-0000-0000-000000000004',
      'd7600000-0000-0000-0000-000000000004',
      'biological',
      'father',
      'd7100000-0000-0000-0000-000000000001'
    )
  $$,
  'the same logical relationship can be attached again after detach'
);

-- A global legacy assertion can still project into another tree. Detaching it
-- from this tree must preserve both that assertion and the other tree's edge.
insert into public.person_relations (
  id,
  project_id,
  person_id,
  related_person_id,
  relation_type,
  created_by
) values (
  'd7500000-0000-0000-0000-000000000004',
  'd7200000-0000-0000-0000-000000000001',
  'd7400000-0000-0000-0000-000000000004',
  'd7400000-0000-0000-0000-000000000003',
  'батько',
  'd7100000-0000-0000-0000-000000000001'
);

insert into public.parent_sets (
  id,
  project_id,
  tree_id,
  child_id,
  set_type,
  is_preferred_for_display,
  is_default_for_pedigree,
  display_order,
  created_by
) values (
  'd7600000-0000-0000-0000-000000000005',
  'd7200000-0000-0000-0000-000000000001',
  'd7300000-0000-0000-0000-000000000002',
  'd7400000-0000-0000-0000-000000000004',
  'biological',
  true,
  true,
  0,
  'd7100000-0000-0000-0000-000000000001'
);

insert into public.parent_child_relationships (
  id,
  project_id,
  tree_id,
  parent_id,
  child_id,
  parent_set_id,
  relationship_type,
  parent_role_label,
  created_by
) values (
  'd7700000-0000-0000-0000-000000000005',
  'd7200000-0000-0000-0000-000000000001',
  'd7300000-0000-0000-0000-000000000002',
  'd7400000-0000-0000-0000-000000000003',
  'd7400000-0000-0000-0000-000000000004',
  'd7600000-0000-0000-0000-000000000005',
  'biological',
  'father',
  'd7100000-0000-0000-0000-000000000001'
);

insert into public.legacy_person_relation_graph_edges (
  project_id,
  relation_id,
  tree_id,
  edge_kind,
  edge_id
) values (
  'd7200000-0000-0000-0000-000000000001',
  'd7500000-0000-0000-0000-000000000004',
  'd7300000-0000-0000-0000-000000000002',
  'parent_child',
  'd7700000-0000-0000-0000-000000000005'
);

create temporary table cross_tree_detach_target as
select mapping.edge_id
from public.legacy_person_relation_graph_edges mapping
where mapping.relation_id = 'd7500000-0000-0000-0000-000000000004'
  and mapping.tree_id = 'd7300000-0000-0000-0000-000000000001';

create temporary table cross_tree_detach_result (payload jsonb);
grant select, insert on cross_tree_detach_result to authenticated;
grant select on cross_tree_detach_target to authenticated;

set local role authenticated;
insert into cross_tree_detach_result (payload)
select public.detach_family_tree_relationship(
  'd7200000-0000-0000-0000-000000000001'::uuid,
  'd7300000-0000-0000-0000-000000000001'::uuid,
  'parent_child',
  (select edge_id from cross_tree_detach_target)
);
reset role;

select is(
  (select payload -> 'deletedLegacyRelationIds' from cross_tree_detach_result),
  '[]'::jsonb,
  'a legacy assertion mapped to another tree is not reported as deleted'
);

select is(
  (
    select count(*)::integer
    from public.person_relations relation
    where relation.id = 'd7500000-0000-0000-0000-000000000004'
  ),
  1,
  'a legacy assertion mapped to another tree survives logical detach'
);

select is(
  (
    select count(*)::integer
    from public.legacy_person_relation_graph_edges mapping
    where mapping.relation_id = 'd7500000-0000-0000-0000-000000000004'
      and mapping.tree_id = 'd7300000-0000-0000-0000-000000000002'
      and mapping.edge_id = 'd7700000-0000-0000-0000-000000000005'
  ),
  1,
  'the compatibility mapping for the other tree survives'
);

select is(
  (
    select count(*)::integer
    from public.parent_child_relationships relationship
    where relationship.id = 'd7700000-0000-0000-0000-000000000005'
      and relationship.tree_id = 'd7300000-0000-0000-0000-000000000002'
  ),
  1,
  'the canonical relationship in the other tree survives'
);

select is(
  ((select payload ->> 'remainingLogicalEdges' from cross_tree_detach_result))::integer,
  0,
  'the selected tree still reports zero remaining logical edges'
);

select * from finish();
rollback;
