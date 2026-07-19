begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

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
  'de100000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'person-gedcom-delete-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'de100000-0000-0000-0000-000000000001',
  'person-gedcom-delete-owner@example.test',
  'Person and GEDCOM deletion owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'de200000-0000-0000-0000-000000000001',
  'de100000-0000-0000-0000-000000000001',
  'Person and GEDCOM deletion fixture'
);

insert into public.researches (id, project_id, title, created_by)
values (
  'de250000-0000-0000-0000-000000000001',
  'de200000-0000-0000-0000-000000000001',
  'GEDCOM deletion research',
  'de100000-0000-0000-0000-000000000001'
);

-- Four manual people must survive. Two imported people own the GEDCOM group.
insert into public.persons (
  id,
  project_id,
  research_id,
  full_name,
  custom_fields,
  created_by
) values
  (
    'de400000-0000-0000-0000-000000000001',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Manual root',
    '{}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de400000-0000-0000-0000-000000000002',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Manual child',
    '{}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de400000-0000-0000-0000-000000000003',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Reused person one',
    '{}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de400000-0000-0000-0000-000000000004',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Reused person two',
    '{}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de400000-0000-0000-0000-000000000005',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Imported person one',
    '{"__gedcomImportSourceKey":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de400000-0000-0000-0000-000000000006',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Imported person two',
    '{"__gedcomImportSourceKey":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  );

insert into public.family_trees (
  id,
  project_id,
  research_id,
  title,
  root_person_id,
  is_default,
  privacy_status,
  settings,
  created_by
) values
  (
    'de300000-0000-0000-0000-000000000001',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Manual tree',
    'de400000-0000-0000-0000-000000000001',
    true,
    'project',
    '{}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de300000-0000-0000-0000-000000000002',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Imported tree',
    'de400000-0000-0000-0000-000000000005',
    false,
    'project',
    '{"source":"gedcom_import","import_source_key":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de300000-0000-0000-0000-000000000003',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'Imported tree expanded manually',
    'de400000-0000-0000-0000-000000000005',
    false,
    'project',
    '{"source":"gedcom_import","import_source_key":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  );

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role
) values
  (
    'de200000-0000-0000-0000-000000000001',
    'de300000-0000-0000-0000-000000000001',
    'de400000-0000-0000-0000-000000000001',
    'root'
  ),
  (
    'de200000-0000-0000-0000-000000000001',
    'de300000-0000-0000-0000-000000000001',
    'de400000-0000-0000-0000-000000000002',
    'member'
  ),
  (
    'de200000-0000-0000-0000-000000000001',
    'de300000-0000-0000-0000-000000000002',
    'de400000-0000-0000-0000-000000000005',
    'root'
  ),
  (
    'de200000-0000-0000-0000-000000000001',
    'de300000-0000-0000-0000-000000000002',
    'de400000-0000-0000-0000-000000000006',
    'member'
  ),
  (
    'de200000-0000-0000-0000-000000000001',
    'de300000-0000-0000-0000-000000000003',
    'de400000-0000-0000-0000-000000000005',
    'root'
  ),
  (
    'de200000-0000-0000-0000-000000000001',
    'de300000-0000-0000-0000-000000000003',
    'de400000-0000-0000-0000-000000000002',
    'member'
  );

insert into public.person_relations (
  id,
  project_id,
  person_id,
  related_person_id,
  relation_type,
  import_source_key,
  gedcom_metadata,
  created_by
) values
  (
    'de500000-0000-0000-0000-000000000001',
    'de200000-0000-0000-0000-000000000001',
    'de400000-0000-0000-0000-000000000001',
    'de400000-0000-0000-0000-000000000002',
    'parent',
    '',
    '{}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de500000-0000-0000-0000-000000000002',
    'de200000-0000-0000-0000-000000000001',
    'de400000-0000-0000-0000-000000000005',
    'de400000-0000-0000-0000-000000000006',
    'parent',
    'gedcom:test-a',
    '{"importSourceKey":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de500000-0000-0000-0000-000000000003',
    'de200000-0000-0000-0000-000000000001',
    'de400000-0000-0000-0000-000000000003',
    'de400000-0000-0000-0000-000000000004',
    'spouse',
    'gedcom:test-a',
    '{"importSourceKey":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  );

insert into public.findings (
  id,
  project_id,
  research_id,
  finding_type,
  summary,
  custom_fields,
  created_by
) values
  (
    'de600000-0000-0000-0000-000000000001',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'source',
    'Imported finding',
    '{"__gedcomImportSourceKey":"gedcom:test-a"}'::jsonb,
    'de100000-0000-0000-0000-000000000001'
  ),
  (
    'de600000-0000-0000-0000-000000000002',
    'de200000-0000-0000-0000-000000000001',
    'de250000-0000-0000-0000-000000000001',
    'manual',
    'Manual finding',
    jsonb_build_object(
      '__trackerRoduFindingMeta',
      jsonb_build_object(
        'personIds',
        jsonb_build_array(
          'de400000-0000-0000-0000-000000000005',
          'de400000-0000-0000-0000-000000000001'
        )
      )
    ),
    'de100000-0000-0000-0000-000000000001'
  );

insert into public.finding_participants (
  id,
  project_id,
  finding_id,
  person_id,
  name
) values (
  'de610000-0000-0000-0000-000000000001',
  'de200000-0000-0000-0000-000000000001',
  'de600000-0000-0000-0000-000000000002',
  'de400000-0000-0000-0000-000000000005',
  'Imported participant on a manual finding'
);

insert into public.gedcom_import_batches (
  id,
  project_id,
  tree_id,
  file_name,
  status,
  created_by
) values (
  'de700000-0000-0000-0000-000000000001',
  'de200000-0000-0000-0000-000000000001',
  'de300000-0000-0000-0000-000000000002',
  'fixture.ged',
  'completed',
  'de100000-0000-0000-0000-000000000001'
);

insert into public.gedcom_xref_maps (
  id,
  project_id,
  tree_id,
  import_batch_id,
  gedcom_xref,
  gedcom_record_type,
  internal_table,
  internal_id
) values (
  'de710000-0000-0000-0000-000000000001',
  'de200000-0000-0000-0000-000000000001',
  'de300000-0000-0000-0000-000000000002',
  'de700000-0000-0000-0000-000000000001',
  '@I1@',
  'INDI',
  'persons',
  'de400000-0000-0000-0000-000000000005'
);

-- This is the durable provenance marker created after a successful import.
insert into private.gedcom_import_datasets (
  project_id,
  source_key,
  operation_id,
  created_by
) values (
  'de200000-0000-0000-0000-000000000001',
  'gedcom:test-a',
  null,
  'de100000-0000-0000-0000-000000000001'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"de100000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.delete_project_persons(
    'de200000-0000-0000-0000-000000000001'::uuid,
    array['de400000-0000-0000-0000-000000000001'::uuid]
  )$$,
  '55000',
  'PERSON_IS_TREE_ROOT',
  'a root person cannot be deleted until the tree root is changed'
);

select throws_ok(
  $$select public.start_gedcom_import_operation(
    'de200000-0000-0000-0000-000000000001'::uuid,
    'gedcom:test-b'
  )$$,
  '55000',
  'GEDCOM_IMPORT_ALREADY_EXISTS',
  'a second GEDCOM import is blocked while a dataset already exists'
);

select throws_ok(
  $$select public.delete_project_gedcom_persons(
    'de200000-0000-0000-0000-000000000001'::uuid,
    'gedcom:test-a'
  )$$,
  '55000',
  'PERSON_IS_TREE_ROOT',
  'an imported root cannot be deleted while its GEDCOM tree contains manual members'
);

reset role;
update public.family_trees
set root_person_id = 'de400000-0000-0000-0000-000000000002'
where id = 'de300000-0000-0000-0000-000000000003';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"de100000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.delete_project_gedcom_persons(
    'de200000-0000-0000-0000-000000000001'::uuid,
    'gedcom:test-a'
  ),
  '{"deletedPersons":2,"deletedRelations":2,"deletedFindings":1}'::jsonb,
  'GEDCOM deletion reports all removed imported entities'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.persons
    where project_id = 'de200000-0000-0000-0000-000000000001'
      and custom_fields ->> '__gedcomImportSourceKey' = 'gedcom:test-a'
  ),
  0,
  'GEDCOM-owned persons are removed'
);

select is(
  (
    select count(*)::integer
    from public.persons
    where project_id = 'de200000-0000-0000-0000-000000000001'
  ),
  4,
  'manual and reused persons survive GEDCOM deletion'
);

select is(
  (
    select count(*)::integer
    from public.person_relations
    where project_id = 'de200000-0000-0000-0000-000000000001'
      and import_source_key = 'gedcom:test-a'
  ),
  0,
  'all source-owned relations are removed, including relations between reused people'
);

select is(
  (
    select count(*)::integer
    from public.person_relations
    where id = 'de500000-0000-0000-0000-000000000001'
  ),
  1,
  'manual relations survive GEDCOM deletion'
);

select is(
  (
    select count(*)::integer
    from public.findings
    where id = 'de600000-0000-0000-0000-000000000001'
  ),
  0,
  'GEDCOM-owned findings are removed'
);

select is(
  (
    select count(*)::integer
    from public.findings
    where id = 'de600000-0000-0000-0000-000000000002'
  ),
  1,
  'manual findings survive GEDCOM deletion'
);

select is(
  (
    select custom_fields #> '{__trackerRoduFindingMeta,personIds}'
    from public.findings
    where id = 'de600000-0000-0000-0000-000000000002'
  ),
  '["de400000-0000-0000-0000-000000000001"]'::jsonb,
  'deleted imported person ids are detached from surviving finding metadata'
);

select is(
  (
    select person_id
    from public.finding_participants
    where id = 'de610000-0000-0000-0000-000000000001'
  ),
  null::uuid,
  'surviving finding participants are detached from deleted persons'
);

select is(
  (
    select count(*)::integer
    from public.family_trees
    where id = 'de300000-0000-0000-0000-000000000002'
  ),
  0,
  'the GEDCOM-owned family tree is removed'
);

select ok(
  exists (
    select 1
    from public.family_trees
    where id = 'de300000-0000-0000-0000-000000000001'
      and root_person_id = 'de400000-0000-0000-0000-000000000001'
      and is_default
  ),
  'the manual default tree and its root survive'
);

select ok(
  exists (
    select 1
    from public.family_trees
    where id = 'de300000-0000-0000-0000-000000000003'
      and root_person_id = 'de400000-0000-0000-0000-000000000002'
  ),
  'a GEDCOM tree expanded with manual people is preserved after its root is changed'
);

select is(
  (
    select count(*)::integer
    from public.family_tree_persons
    where tree_id = 'de300000-0000-0000-0000-000000000003'
      and person_id = 'de400000-0000-0000-0000-000000000002'
  ),
  1,
  'the manual member remains attached to the preserved expanded tree'
);

select is(
  (
    select count(*)::integer
    from public.gedcom_import_batches
    where id = 'de700000-0000-0000-0000-000000000001'
  ),
  0,
  'the GEDCOM archive batch is removed'
);

select is(
  (
    select count(*)::integer
    from public.gedcom_xref_maps
    where id = 'de710000-0000-0000-0000-000000000001'
  ),
  0,
  'GEDCOM archive xrefs are removed'
);

select is(
  (
    select count(*)::integer
    from private.gedcom_import_datasets
    where project_id = 'de200000-0000-0000-0000-000000000001'
  ),
  0,
  'the durable GEDCOM provenance marker is removed only after cleanup'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"de100000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.list_project_gedcom_import_datasets(
    'de200000-0000-0000-0000-000000000001'::uuid
  ),
  '[]'::jsonb,
  'the project dataset registry is empty through the public API after cleanup'
);

select is(
  public.start_gedcom_import_operation(
    'de200000-0000-0000-0000-000000000001'::uuid,
    'gedcom:test-b'
  ) ->> 'status',
  'preparing',
  'a fresh GEDCOM import can start after the old group is deleted'
);

reset role;

select is(
  (
    select count(*)::integer
    from private.gedcom_import_operations
    where project_id = 'de200000-0000-0000-0000-000000000001'
      and source_key = 'gedcom:test-b'
      and status = 'preparing'
  ),
  1,
  'the post-cleanup import operation is persisted'
);

select * from finish();
rollback;
