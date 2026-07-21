begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

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
    ) - 'relationshipId'
  ),
  jsonb_build_object(
    'deleted', true,
    'kind', 'parent_child',
    'treeId', 'd7300000-0000-0000-0000-000000000001'::uuid,
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

select * from finish();
rollback;
