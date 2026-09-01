begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

select ok(
  has_function_privilege('service_role', 'public.process_next_gedcom_deletion_job(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.process_next_gedcom_deletion_job(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.process_next_gedcom_deletion_job(integer)', 'EXECUTE'),
  'the automatic deletion worker is executable only by service_role'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', 'df100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'gedcom-delete-owner@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'df100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'gedcom-delete-viewer@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'df100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'gedcom-delete-outsider@example.test', '', now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

insert into public.projects (id, owner_id, name) values
  ('df200000-0000-4000-8000-000000000001', 'df100000-0000-4000-8000-000000000001', 'Large resumable GEDCOM delete'),
  ('df200000-0000-4000-8000-000000000002', 'df100000-0000-4000-8000-000000000001', 'GEDCOM root guard'),
  ('df200000-0000-4000-8000-000000000003', 'df100000-0000-4000-8000-000000000001', 'GEDCOM active import guard'),
  ('df200000-0000-4000-8000-000000000004', 'df100000-0000-4000-8000-000000000001', 'GEDCOM retry after failure');

insert into public.project_members (project_id, user_id, role, invited_by) values
  ('df200000-0000-4000-8000-000000000001', 'df100000-0000-4000-8000-000000000002', 'viewer', 'df100000-0000-4000-8000-000000000001');

insert into public.researches (id, project_id, title, created_by) values
  ('df250000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000001', 'Large deletion research', 'df100000-0000-4000-8000-000000000001'),
  ('df250000-0000-4000-8000-000000000002', 'df200000-0000-4000-8000-000000000002', 'Root guard research', 'df100000-0000-4000-8000-000000000001'),
  ('df250000-0000-4000-8000-000000000003', 'df200000-0000-4000-8000-000000000003', 'Active import research', 'df100000-0000-4000-8000-000000000001'),
  ('df250000-0000-4000-8000-000000000004', 'df200000-0000-4000-8000-000000000004', 'Retry research', 'df100000-0000-4000-8000-000000000001');

-- A manual person/tree must survive the large deletion.
insert into public.persons (id, project_id, research_id, full_name, custom_fields, created_by)
values ('df410000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000001', 'df250000-0000-4000-8000-000000000001', 'Manual survivor', '{}'::jsonb, 'df100000-0000-4000-8000-000000000001');

insert into public.persons (id, project_id, research_id, full_name, custom_fields, created_by)
select
  ('df420000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'df200000-0000-4000-8000-000000000001'::uuid,
  'df250000-0000-4000-8000-000000000001'::uuid,
  'Imported person ' || series,
  '{"__gedcomImportSourceKey":"gedcom:large"}'::jsonb,
  'df100000-0000-4000-8000-000000000001'::uuid
from generate_series(1, 205) as series;

insert into public.findings (
  id, project_id, research_id, finding_type, summary, custom_fields, created_by
)
select
  ('df620000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'df200000-0000-4000-8000-000000000001'::uuid,
  'df250000-0000-4000-8000-000000000001'::uuid,
  'source', 'Imported finding ' || series,
  '{"__gedcomImportSourceKey":"gedcom:large"}'::jsonb,
  'df100000-0000-4000-8000-000000000001'::uuid
from generate_series(1, 3) as series;

insert into public.family_trees (
  id, project_id, research_id, title, root_person_id, is_default,
  privacy_status, settings, created_by
) values
  ('df300000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000001', 'df250000-0000-4000-8000-000000000001', 'Manual default tree', 'df410000-0000-4000-8000-000000000001', true, 'project', '{}'::jsonb, 'df100000-0000-4000-8000-000000000001'),
  ('df300000-0000-4000-8000-000000000002', 'df200000-0000-4000-8000-000000000001', 'df250000-0000-4000-8000-000000000001', 'Imported tree', 'df420000-0000-4000-8000-000000000001', false, 'project', '{"source":"gedcom_import","import_source_key":"gedcom:large"}'::jsonb, 'df100000-0000-4000-8000-000000000001');

insert into public.family_tree_persons (project_id, tree_id, person_id, member_role) values
  ('df200000-0000-4000-8000-000000000001', 'df300000-0000-4000-8000-000000000001', 'df410000-0000-4000-8000-000000000001', 'root'),
  ('df200000-0000-4000-8000-000000000001', 'df300000-0000-4000-8000-000000000002', 'df420000-0000-4000-8000-000000000001', 'root');

-- Create the explicit default tree before relation projection runs; otherwise
-- the compatibility trigger would legitimately create its own default tree.
insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type,
  import_source_key, gedcom_metadata, created_by
)
select
  ('df520000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'df200000-0000-4000-8000-000000000001'::uuid,
  ('df420000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  ('df420000-0000-4000-8000-' || lpad((series + 1)::text, 12, '0'))::uuid,
  'parent', 'gedcom:large', '{"importSourceKey":"gedcom:large"}'::jsonb,
  'df100000-0000-4000-8000-000000000001'::uuid
from generate_series(1, 103) as series;

insert into public.gedcom_import_batches (
  id, project_id, tree_id, file_name, status, created_by
) values (
  'df700000-0000-4000-8000-000000000001',
  'df200000-0000-4000-8000-000000000001',
  'df300000-0000-4000-8000-000000000002',
  'large.ged', 'completed',
  'df100000-0000-4000-8000-000000000001'
);

insert into public.gedcom_xref_maps (
  id, project_id, tree_id, import_batch_id, gedcom_xref,
  gedcom_record_type, internal_table, internal_id
) values (
  'df710000-0000-4000-8000-000000000001',
  'df200000-0000-4000-8000-000000000001',
  null,
  'df700000-0000-4000-8000-000000000001',
  '@I1@', 'INDI', 'persons',
  'df420000-0000-4000-8000-000000000001'
), (
  'df710000-0000-4000-8000-000000000002',
  'df200000-0000-4000-8000-000000000001',
  null,
  'df700000-0000-4000-8000-000000000001',
  '@I2@', 'INDI', 'persons',
  'df420000-0000-4000-8000-000000000002'
);

insert into private.gedcom_import_datasets (project_id, source_key, operation_id, created_by)
values ('df200000-0000-4000-8000-000000000001', 'gedcom:large', null, 'df100000-0000-4000-8000-000000000001');

-- Root-guard fixture: a manual tree must never lose its imported root implicitly.
insert into public.persons (id, project_id, research_id, full_name, custom_fields, created_by) values
  ('df430000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000002', 'df250000-0000-4000-8000-000000000002', 'Imported manual-tree root', '{"__gedcomImportSourceKey":"gedcom:root"}'::jsonb, 'df100000-0000-4000-8000-000000000001'),
  ('df431000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000002', 'df250000-0000-4000-8000-000000000002', 'Imported replacement candidate', '{"__gedcomImportSourceKey":"gedcom:root"}'::jsonb, 'df100000-0000-4000-8000-000000000001');

insert into public.family_trees (
  id, project_id, research_id, title, root_person_id, is_default,
  privacy_status, settings, created_by
) values ('df300000-0000-4000-8000-000000000003', 'df200000-0000-4000-8000-000000000002', 'df250000-0000-4000-8000-000000000002', 'Manual tree with imported root', 'df430000-0000-4000-8000-000000000001', true, 'project', '{}'::jsonb, 'df100000-0000-4000-8000-000000000001');

insert into public.family_tree_persons (project_id, tree_id, person_id, member_role) values
  ('df200000-0000-4000-8000-000000000002', 'df300000-0000-4000-8000-000000000003', 'df430000-0000-4000-8000-000000000001', 'root'),
  ('df200000-0000-4000-8000-000000000002', 'df300000-0000-4000-8000-000000000003', 'df431000-0000-4000-8000-000000000001', 'member');

insert into private.gedcom_import_datasets (project_id, source_key, operation_id, created_by)
values ('df200000-0000-4000-8000-000000000002', 'gedcom:root', null, 'df100000-0000-4000-8000-000000000001');

-- Active import fixture.
insert into public.persons (id, project_id, research_id, full_name, custom_fields, created_by)
values ('df440000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000003', 'df250000-0000-4000-8000-000000000003', 'Active import person', '{"__gedcomImportSourceKey":"gedcom:active"}'::jsonb, 'df100000-0000-4000-8000-000000000001');

insert into private.gedcom_import_datasets (project_id, source_key, operation_id, created_by)
values ('df200000-0000-4000-8000-000000000003', 'gedcom:active', null, 'df100000-0000-4000-8000-000000000001');

insert into private.gedcom_import_operations (id, project_id, requested_by, source_key, status)
values ('df800000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000003', 'df100000-0000-4000-8000-000000000001', 'gedcom:active-next', 'importing');

-- Retry fixture: a conflicting root is deliberately introduced after start.
insert into public.persons (id, project_id, research_id, full_name, custom_fields, created_by) values
  ('df450000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000004', 'df250000-0000-4000-8000-000000000004', 'Retry imported person', '{"__gedcomImportSourceKey":"gedcom:retry"}'::jsonb, 'df100000-0000-4000-8000-000000000001'),
  ('df451000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000004', 'df250000-0000-4000-8000-000000000004', 'Retry manual root', '{}'::jsonb, 'df100000-0000-4000-8000-000000000001');

insert into private.gedcom_import_datasets (project_id, source_key, operation_id, created_by)
values ('df200000-0000-4000-8000-000000000004', 'gedcom:retry', null, 'df100000-0000-4000-8000-000000000001');

create temporary table gedcom_deletion_test_state (
  key text primary key,
  payload jsonb not null
) on commit drop;
grant all on table gedcom_deletion_test_state to authenticated;

-- Authentication and edit authorization are checked before a job is created.
set local role authenticated;
select set_config('request.jwt.claims', '{}', true);
select throws_ok(
  $$select public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000001'::uuid, 'gedcom:large')$$,
  '42501', 'AUTH_REQUIRED', 'anonymous callers cannot start a GEDCOM deletion'
);

select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select throws_ok(
  $$select public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000002'::uuid, 'gedcom:root')$$,
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED', 'a viewer cannot start a GEDCOM deletion'
);

select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into gedcom_deletion_test_state (key, payload)
values ('large-start', public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000001', 'gedcom:large'));

select ok(
  (select payload @> '{"status":"pending","phase":"relations","totalPersons":205,"processedPersons":0,"remainingPersons":205,"deletedPersons":0,"deletedRelations":0,"deletedFindings":0,"done":false,"retryable":false}'::jsonb
   from gedcom_deletion_test_state where key = 'large-start'),
  'start snapshots all imported people and returns the initial progress contract'
);

select is(
  (select count(*)::integer from public.persons where project_id = 'df200000-0000-4000-8000-000000000001'),
  206,
  'start is non-destructive and leaves the large dataset plus manual person intact'
);

insert into gedcom_deletion_test_state (key, payload)
values ('large-repeat', public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000001', 'gedcom:large'));
select is(
  (select payload ->> 'jobId' from gedcom_deletion_test_state where key = 'large-repeat'),
  (select payload ->> 'jobId' from gedcom_deletion_test_state where key = 'large-start'),
  'repeating start for the same source returns the active job'
);

-- A project viewer may observe progress, but cannot continue deletion.
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  public.get_project_gedcom_deletion(
    (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'large-start')
  ) ->> 'jobId',
  (select payload ->> 'jobId' from gedcom_deletion_test_state where key = 'large-start'),
  'a project viewer can read deletion progress'
);
select throws_ok(
  (select format(
    'select public.continue_project_gedcom_deletion(%L::uuid, 50)',
    payload ->> 'jobId'
  ) from gedcom_deletion_test_state where key = 'large-start'),
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED', 'a project viewer cannot continue deletion'
);

select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select throws_ok(
  (select format(
    'select public.get_project_gedcom_deletion(%L::uuid)',
    payload ->> 'jobId'
  ) from gedcom_deletion_test_state where key = 'large-start'),
  '42501', 'PROJECT_ACCESS_REQUIRED', 'a non-member cannot read deletion progress'
);

-- Upper batch clamp: 1000 is reduced to 100. Progress is cumulative and monotonic.
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into gedcom_deletion_test_state (key, payload)
select 'large-1', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 1000)
from gedcom_deletion_test_state where key = 'large-start';
select ok(
  (select payload @> '{"status":"running","phase":"relations","deletedRelations":100,"processedPersons":0,"remainingPersons":205}'::jsonb
   from gedcom_deletion_test_state where key = 'large-1'),
  'one oversized call deletes at most 100 relations'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-2', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select is((select (payload ->> 'deletedRelations')::integer from gedcom_deletion_test_state where key = 'large-2'), 103, 'relation progress resumes without recounting deleted rows');

insert into gedcom_deletion_test_state (key, payload)
select 'large-3', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select ok(
  (select payload @> '{"phase":"findings","deletedRelations":103,"deletedFindings":3,"processedPersons":0}'::jsonb
   from gedcom_deletion_test_state where key = 'large-3'),
  'empty relation phase advances and processes the findings batch'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-4', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select is(
  (select count(*)::integer from public.family_trees where id = 'df300000-0000-4000-8000-000000000002'),
  1,
  'tree-child cleanup is bounded separately from deleting the tree'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-5', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select is(
  (select count(*)::integer from public.family_trees where id = 'df300000-0000-4000-8000-000000000002'),
  0,
  'the next tree page removes the fully imported tree'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-6', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select is(
  (select count(*)::integer from public.gedcom_xref_maps where import_batch_id = 'df700000-0000-4000-8000-000000000001'),
  0,
  'archive child cleanup is bounded separately from deleting its batch'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-7', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select is(
  (select count(*)::integer from public.gedcom_import_batches where id = 'df700000-0000-4000-8000-000000000001'),
  0,
  'the next archive page removes its batch'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-8', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select ok(
  (select payload @> '{"phase":"persons","processedPersons":100,"remainingPersons":105,"deletedPersons":100}'::jsonb
   from gedcom_deletion_test_state where key = 'large-8'),
  'the first person page reports bounded progress'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-9', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select ok(
  (select payload @> '{"processedPersons":200,"remainingPersons":5,"deletedPersons":200}'::jsonb
   from gedcom_deletion_test_state where key = 'large-9'),
  'the second person page advances progress monotonically'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-10', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select ok(
  (select payload @> '{"processedPersons":205,"remainingPersons":0,"deletedPersons":205}'::jsonb
   from gedcom_deletion_test_state where key = 'large-10'),
  'the last short person page reaches zero remaining rows'
);

insert into gedcom_deletion_test_state (key, payload)
select 'large-completed', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 100)
from gedcom_deletion_test_state where key = 'large-start';
select ok(
  (select payload @> '{"status":"completed","phase":"completed","processedPersons":205,"remainingPersons":0,"deletedPersons":205,"deletedRelations":103,"deletedFindings":3,"done":true,"retryable":false}'::jsonb
   from gedcom_deletion_test_state where key = 'large-completed'),
  'finalize returns complete cumulative progress'
);

reset role;
select ok(
  (select processed_persons = 205 and deleted_persons = 205
   from private.gedcom_deletion_jobs
   where id = (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'large-start')),
  'processed person progress is stored durably and remains monotonic at completion'
);
select ok(
  not exists (select 1 from private.gedcom_deletion_job_persons owned where owned.job_id = (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'large-start'))
  and not exists (select 1 from private.gedcom_deletion_job_trees owned where owned.job_id = (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'large-start'))
  and not exists (select 1 from private.gedcom_deletion_job_batches owned where owned.job_id = (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'large-start')),
  'completed deletion drains its large private snapshots while retaining the compact job receipt'
);
select is((select count(*)::integer from private.gedcom_import_datasets where project_id = 'df200000-0000-4000-8000-000000000001'), 0, 'dataset marker is removed only after finalize');
select is(
  (select count(*)::integer from public.activity_log where project_id = 'df200000-0000-4000-8000-000000000001' and action = 'gedcom_dataset_deleted'),
  1,
  'resumable batches produce one dataset-level activity event'
);
select is((select count(*)::integer from public.persons where project_id = 'df200000-0000-4000-8000-000000000001' and custom_fields ->> '__gedcomImportSourceKey' = 'gedcom:large'), 0, 'all snapshotted imported persons are deleted');
select ok(
  exists (select 1 from public.persons where id = 'df410000-0000-4000-8000-000000000001')
  and exists (select 1 from public.family_trees where id = 'df300000-0000-4000-8000-000000000001' and is_default),
  'manual person and manual default tree survive'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into gedcom_deletion_test_state (key, payload)
select 'large-completed-repeat', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 1)
from gedcom_deletion_test_state where key = 'large-start';
select is(
  (select payload from gedcom_deletion_test_state where key = 'large-completed-repeat'),
  (select payload from gedcom_deletion_test_state where key = 'large-completed'),
  'continue is idempotent after completion'
);

insert into gedcom_deletion_test_state (key, payload)
values ('large-start-after-complete', public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000001', 'gedcom:large'));
select is(
  (select payload ->> 'jobId' from gedcom_deletion_test_state where key = 'large-start-after-complete'),
  (select payload ->> 'jobId' from gedcom_deletion_test_state where key = 'large-start'),
  'start returns the completed same-source receipt instead of creating a duplicate job'
);

select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(
  public.get_project_gedcom_deletion((select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'large-start')) ->> 'status',
  'completed',
  'completed progress remains readable to a project member'
);

-- A manual/mixed tree root is rejected atomically at start.
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000002'::uuid, 'gedcom:root')$$,
  '55000', 'PERSON_IS_TREE_ROOT', 'an imported root of a manual tree blocks deletion at start'
);
reset role;
select is((select count(*)::integer from private.gedcom_deletion_jobs where project_id = 'df200000-0000-4000-8000-000000000002'), 0, 'root validation does not leave a partial job');
select is((select count(*)::integer from public.persons where id = 'df430000-0000-4000-8000-000000000001'), 1, 'root validation leaves source data untouched');

-- Once a user explicitly turns the replacement into a manual person and moves
-- the root, the source dataset is safe to delete while preserving the tree.
update public.persons
set custom_fields = '{}'::jsonb
where id = 'df431000-0000-4000-8000-000000000001';
update public.family_trees set root_person_id = 'df431000-0000-4000-8000-000000000001' where id = 'df300000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into gedcom_deletion_test_state (key, payload)
values ('root-start', public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000002', 'gedcom:root'));
insert into gedcom_deletion_test_state (key, payload)
select 'root-person', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 0)
from gedcom_deletion_test_state where key = 'root-start';
select ok(
  (select payload @> '{"processedPersons":1,"remainingPersons":0,"deletedPersons":1}'::jsonb from gedcom_deletion_test_state where key = 'root-person'),
  'a zero batch size is clamped to one person after the root is changed'
);
insert into gedcom_deletion_test_state (key, payload)
select 'root-completed', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 1)
from gedcom_deletion_test_state where key = 'root-start';
select is((select payload ->> 'status' from gedcom_deletion_test_state where key = 'root-completed'), 'completed', 'root-safe deletion resumes to completion');
reset role;
select ok(
  exists (select 1 from public.family_trees where id = 'df300000-0000-4000-8000-000000000003' and root_person_id = 'df431000-0000-4000-8000-000000000001')
  and exists (select 1 from public.persons where id = 'df431000-0000-4000-8000-000000000001'),
  'the manual tree and replacement root survive source deletion'
);

-- An active import prevents start and leaves no deletion job or partial data.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select throws_ok(
  $$select public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000003'::uuid, 'gedcom:active')$$,
  '55000', 'PROJECT_GEDCOM_OPERATION_ACTIVE', 'an active import blocks dataset deletion'
);
reset role;
select ok(
  not exists (select 1 from private.gedcom_deletion_jobs where project_id = 'df200000-0000-4000-8000-000000000003')
  and exists (select 1 from public.persons where id = 'df440000-0000-4000-8000-000000000001'),
  'the active-import guard is atomic'
);

-- A transient failure receipt is resumable by the same durable job.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into gedcom_deletion_test_state (key, payload)
values ('retry-start', public.start_project_gedcom_deletion('df200000-0000-4000-8000-000000000004', 'gedcom:retry'));
reset role;
update private.gedcom_deletion_jobs
set status = 'failed',
    last_error_code = '57014',
    last_error = 'canceling statement due to statement timeout'
where id = (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'retry-start');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"df100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select ok(
  (public.get_project_gedcom_deletion(
    (select (payload ->> 'jobId')::uuid from gedcom_deletion_test_state where key = 'retry-start')
  ) @> '{"status":"failed","lastErrorCode":"57014","done":false,"retryable":true}'::jsonb),
  'a transient timeout receipt is explicitly retryable'
);
insert into gedcom_deletion_test_state (key, payload)
select 'retry-person', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 1)
from gedcom_deletion_test_state where key = 'retry-start';
insert into gedcom_deletion_test_state (key, payload)
select 'retry-completed', public.continue_project_gedcom_deletion((payload ->> 'jobId')::uuid, 1)
from gedcom_deletion_test_state where key = 'retry-start';
select ok(
  (select payload @> '{"status":"completed","processedPersons":1,"remainingPersons":0,"deletedPersons":1,"done":true,"retryable":false}'::jsonb
   from gedcom_deletion_test_state where key = 'retry-completed'),
  'a failed job resumes from its durable snapshot after the conflict is fixed'
);

select * from finish();
rollback;
