begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(33);

select has_table(
  'private',
  'project_deletion_jobs',
  'project deletion jobs are kept outside the public API schema'
);
select has_column(
  'public',
  'projects',
  'deletion_pending',
  'projects expose their pending-deletion state to workspace loading'
);
select has_function(
  'public',
  'start_project_deletion',
  array['uuid'],
  'an authenticated caller can start a deletion job'
);
select has_function(
  'public',
  'process_project_deletion',
  array['uuid', 'integer'],
  'the client can process one bounded deletion step'
);
select has_function(
  'public',
  'get_project_deletion_status',
  array['uuid'],
  'the client can poll deletion status'
);
select has_function(
  'public',
  'process_next_project_deletion',
  array['integer'],
  'a service worker can claim the next queued deletion step'
);
select has_function(
  'public',
  'mark_project_deletion_storage_cleaned',
  array['uuid'],
  'the service worker can acknowledge Storage API cleanup'
);
select has_function(
  'public',
  'clear_project_records_for_restore',
  array['uuid', 'integer'],
  'backup restore clears project content through a bounded RPC'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.start_project_deletion(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.process_project_deletion(uuid,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.start_project_deletion(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.process_project_deletion(uuid,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.process_next_project_deletion(integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.mark_project_deletion_storage_cleaned(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.process_next_project_deletion(integer)',
    'EXECUTE'
  ),
  'user and worker deletion RPCs have separate least-privilege grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.projects', 'DELETE')
  and not has_table_privilege('anon', 'public.projects', 'DELETE'),
  'direct project deletion cannot bypass the resumable worker'
);
select is(
  (
    select count(*)::integer
    from information_schema.role_table_grants grant_record
    where grant_record.table_schema = 'private'
      and grant_record.table_name = 'project_deletion_jobs'
      and grant_record.grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  0,
  'raw deletion job rows are not exposed to API roles'
);
select ok(
  not exists (
    select 1
    from unnest(private.project_deletion_phase_names()) phase(table_name)
    cross join lateral (
      select pg_catalog.to_regclass(format('public.%I', phase.table_name)) as relation_id
    ) relation
    where relation.relation_id is not null
      and not exists (
        select 1
        from pg_catalog.pg_index index_record
        join pg_catalog.pg_attribute first_key
          on first_key.attrelid = index_record.indrelid
         and first_key.attnum = index_record.indkey[0]
        where index_record.indrelid = relation.relation_id
          and index_record.indisvalid
          and index_record.indisready
          and first_key.attname = 'project_id'
      )
  ),
  'every installed deletion phase has a project_id-leading index'
);
select is(
  private.project_deletion_uncovered_table_names(),
  array[]::text[],
  'every public project-owned table is covered by a deletion phase'
);
select ok(
  pg_catalog.pg_get_functiondef(
    'public.family_tree_bump_graph_version()'::regprocedure
  ) like '%current_setting(''app.project_deletion'', true) = ''on''%',
  'graph version bumping has a deletion-transaction fast path'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'd2000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'deletion-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd2000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'deletion-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd2000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated', 'deletion-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into public.profiles (user_id, email, display_name)
values
  (
    'd2000000-0000-0000-0000-000000000001',
    'deletion-owner@example.test',
    'Deletion owner'
  ),
  (
    'd2000000-0000-0000-0000-000000000002',
    'deletion-outsider@example.test',
    'Deletion outsider'
  ),
  (
    'd2000000-0000-0000-0000-000000000003',
    'deletion-admin@example.test',
    'Deletion admin'
  );

insert into public.app_admins (user_id, granted_by)
values (
  'd2000000-0000-0000-0000-000000000003',
  'd2000000-0000-0000-0000-000000000003'
);

insert into public.projects (id, owner_id, name)
values
  (
    'd2000000-0000-0000-0000-000000000101',
    'd2000000-0000-0000-0000-000000000001',
    'Chunked deletion test'
  ),
  (
    'd2000000-0000-0000-0000-000000000102',
    'd2000000-0000-0000-0000-000000000001',
    'Administrator deletion test'
  ),
  (
    'd2000000-0000-0000-0000-000000000103',
    'd2000000-0000-0000-0000-000000000001',
    'Backup restore clear test'
  );

insert into public.researches (id, project_id, title, created_by)
select
  ('d2000000-0000-0000-0000-' || lpad(series::text, 12, '0'))::uuid,
  'd2000000-0000-0000-0000-000000000101'::uuid,
  'Deletion research ' || series,
  'd2000000-0000-0000-0000-000000000001'::uuid
from generate_series(1, 5) series;

insert into public.researches (id, project_id, title, created_by)
select
  ('d3000000-0000-0000-0000-' || lpad(series::text, 12, '0'))::uuid,
  'd2000000-0000-0000-0000-000000000103'::uuid,
  'Restore research ' || series,
  'd2000000-0000-0000-0000-000000000001'::uuid
from generate_series(1, 3) series;

insert into public.project_invitations (project_id, email, role, invited_by)
values (
  'd2000000-0000-0000-0000-000000000103'::uuid,
  'restore-invite@example.test',
  'editor',
  'd2000000-0000-0000-0000-000000000001'::uuid
);

insert into public.activity_log (
  project_id, actor_id, action, entity_type, details
) values (
  'd2000000-0000-0000-0000-000000000103'::uuid,
  'd2000000-0000-0000-0000-000000000001'::uuid,
  'restore_test',
  'project',
  '{}'::jsonb
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.start_project_deletion(
    'd2000000-0000-0000-0000-000000000101'::uuid
  )$$,
  '42501',
  'PROJECT_DELETE_ACCESS_REQUIRED',
  'a non-owner cannot start project deletion'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  (
    public.clear_project_records_for_restore(
      'd2000000-0000-0000-0000-000000000103'::uuid,
      2
    ) ->> 'deletedRows'
  )::integer,
  2,
  'one backup-restore clear call obeys the requested batch limit'
);
do $$
declare
  payload jsonb;
begin
  loop
    payload := public.clear_project_records_for_restore(
      'd2000000-0000-0000-0000-000000000103'::uuid,
      2
    );
    exit when (payload ->> 'complete')::boolean;
  end loop;
end;
$$;
select is(
  (
    select count(*)::integer
    from public.researches
    where project_id = 'd2000000-0000-0000-0000-000000000103'::uuid
  ),
  0,
  'backup restore removes all prior project content'
);
select ok(
  exists (
    select 1 from public.projects
    where id = 'd2000000-0000-0000-0000-000000000103'::uuid
  )
  and exists (
    select 1 from public.project_members
    where project_id = 'd2000000-0000-0000-0000-000000000103'::uuid
  )
  and exists (
    select 1 from public.project_invitations
    where project_id = 'd2000000-0000-0000-0000-000000000103'::uuid
  )
  and exists (
    select 1 from public.activity_log
    where project_id = 'd2000000-0000-0000-0000-000000000103'::uuid
  ),
  'backup restore preserves workspace access and the audit trail'
);
select set_config(
  'test.project_deletion_job_id',
  public.start_project_deletion(
    'd2000000-0000-0000-0000-000000000101'::uuid
  ) ->> 'jobId',
  true
);
select is(
  public.get_project_deletion_status(
    current_setting('test.project_deletion_job_id')::uuid
  ) ->> 'status',
  'queued',
  'an owner starts a queued job'
);
select is(
  public.can_edit_project(
    'd2000000-0000-0000-0000-000000000101'::uuid
  ),
  false,
  'normal project writes are locked while deletion is active'
);
select is(
  (
    select deletion_pending
    from public.projects
    where id = 'd2000000-0000-0000-0000-000000000101'::uuid
  ),
  true,
  'a deleting project is marked so normal workspace navigation can hide it'
);
select is(
  public.start_project_deletion(
    'd2000000-0000-0000-0000-000000000101'::uuid
  ) ->> 'jobId',
  current_setting('test.project_deletion_job_id'),
  'starting deletion twice reuses the active job'
);

select set_config(
  'test.first_deletion_payload',
  public.process_project_deletion(
    current_setting('test.project_deletion_job_id')::uuid,
    2
  )::text,
  true
);
select is(
  (current_setting('test.first_deletion_payload')::jsonb ->> 'processedRows')::bigint,
  2::bigint,
  'one process call deletes no more than the requested two-row batch'
);
select is(
  (
    select count(*)::integer
    from public.researches
    where project_id = 'd2000000-0000-0000-0000-000000000101'::uuid
  ),
  3,
  'three of five rows remain after the first two-row batch'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  format(
    'select public.get_project_deletion_status(%L::uuid)',
    current_setting('test.project_deletion_job_id')
  ),
  '42501',
  'PROJECT_DELETE_ACCESS_REQUIRED',
  'an unrelated user cannot inspect deletion progress'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
do $$
declare
  payload jsonb;
begin
  loop
    payload := public.process_project_deletion(
      current_setting('test.project_deletion_job_id')::uuid,
      2
    );
    exit when payload ->> 'phase' = 'storage_cleanup';
  end loop;
end;
$$;

select is(
  public.get_project_deletion_status(
    current_setting('test.project_deletion_job_id')::uuid
  ) ->> 'phase',
  'storage_cleanup',
  'database batches stop at the explicit Storage API cleanup phase'
);
select ok(
  exists (
    select 1 from public.projects
    where id = 'd2000000-0000-0000-0000-000000000101'::uuid
  )
  and exists (
    select 1 from public.project_members
    where project_id = 'd2000000-0000-0000-0000-000000000101'::uuid
  ),
  'project and owner membership remain until storage cleanup succeeds'
);

reset role;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);
select is(
  public.mark_project_deletion_storage_cleaned(
    current_setting('test.project_deletion_job_id')::uuid
  ) ->> 'phase',
  'finalizing',
  'only the service worker can acknowledge completed storage cleanup'
);
select is(
  public.process_next_project_deletion(2) ->> 'status',
  'completed',
  'the service queue step finalizes a storage-cleaned project'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  (
    select count(*)::integer from public.projects
    where id = 'd2000000-0000-0000-0000-000000000101'::uuid
  ),
  0,
  'the project row is removed only after child phases finish'
);
select is(
  (
    select count(*)::integer from public.researches
    where project_id = 'd2000000-0000-0000-0000-000000000101'::uuid
  ),
  0,
  'all project research rows were removed'
);
select is(
  public.start_project_deletion(
    'd2000000-0000-0000-0000-000000000101'::uuid
  ) ->> 'jobId',
  current_setting('test.project_deletion_job_id'),
  'a post-completion retry returns the durable completed job'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select is(
  public.start_project_deletion(
    'd2000000-0000-0000-0000-000000000102'::uuid
  ) ->> 'status',
  'queued',
  'an app administrator can start deletion for another owner'
);

select * from finish();
rollback;
