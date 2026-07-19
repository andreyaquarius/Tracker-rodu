begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(19);

select has_table(
  'private',
  'gedcom_export_jobs',
  'the durable GEDCOM export queue exists'
);
select has_function(
  'public',
  'start_gedcom_export',
  array['uuid', 'uuid'],
  'authenticated clients can enqueue an export through an RPC facade'
);
select ok(
  exists (
    select 1
    from storage.buckets bucket
    where bucket.id = 'gedcom-exports'
      and not bucket.public
  ),
  'generated GEDCOM files use a private Storage bucket'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'e1000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'gedcom-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
) on conflict (id) do nothing;

insert into public.profiles (user_id, email, display_name)
values (
  'e1000000-0000-0000-0000-000000000001',
  'gedcom-owner@example.test',
  'GEDCOM owner'
)
on conflict (user_id) do update
set email = excluded.email,
    display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by)
values (
  'e1000000-0000-0000-0000-000000000001',
  'e1000000-0000-0000-0000-000000000001'
)
on conflict (user_id) do nothing;

insert into public.projects (id, owner_id, name)
values
  (
    'e2000000-0000-0000-0000-000000000001',
    'e1000000-0000-0000-0000-000000000001',
    'GEDCOM 2,480-person regression fixture'
  ),
  (
    'e2000000-0000-0000-0000-000000000002',
    'e1000000-0000-0000-0000-000000000001',
    'GEDCOM large-worker routing fixture'
  );

insert into public.project_members (project_id, user_id, role, invited_by)
values
  (
    'e2000000-0000-0000-0000-000000000001',
    'e1000000-0000-0000-0000-000000000001',
    'owner',
    null
  ),
  (
    'e2000000-0000-0000-0000-000000000002',
    'e1000000-0000-0000-0000-000000000001',
    'owner',
    null
  )
on conflict (project_id, user_id) do update set role = excluded.role;

insert into public.family_trees (
  id, project_id, title, privacy_status, created_by
) values
  (
    'e3000000-0000-0000-0000-000000000001',
    'e2000000-0000-0000-0000-000000000001',
    '2,480-person tree',
    'project',
    'e1000000-0000-0000-0000-000000000001'
  ),
  (
    'e3000000-0000-0000-0000-000000000002',
    'e2000000-0000-0000-0000-000000000002',
    '5,001-person tree',
    'project',
    'e1000000-0000-0000-0000-000000000001'
  );

insert into public.persons (
  id, project_id, full_name, given_name, is_living, privacy_status, created_by
)
select
  ('e4000000-0000-0000-0000-' || lpad(series::text, 12, '0'))::uuid,
  'e2000000-0000-0000-0000-000000000001'::uuid,
  'Small export person ' || series,
  'Person ' || series,
  false,
  'project',
  'e1000000-0000-0000-0000-000000000001'::uuid
from generate_series(1, 2480) series;

insert into public.persons (
  id, project_id, full_name, given_name, is_living, privacy_status, created_by
)
select
  ('e5000000-0000-0000-0000-' || lpad(series::text, 12, '0'))::uuid,
  'e2000000-0000-0000-0000-000000000002'::uuid,
  'Large export person ' || series,
  'Person ' || series,
  false,
  'project',
  'e1000000-0000-0000-0000-000000000001'::uuid
from generate_series(1, 5001) series;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"e1000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select set_config(
  'gedcom.test.small_job_id',
  (
    public.start_gedcom_export(
      'e2000000-0000-0000-0000-000000000001',
      'e3000000-0000-0000-0000-000000000001'
    )->>'jobId'
  ),
  true
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.small_job_id')::uuid
  )->>'status',
  'queued',
  'a 2,480-person export is durably queued'
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.small_job_id')::uuid
  )->>'estimatedPersonCount',
  '2480',
  'the 2,480-person estimate is exact'
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.small_job_id')::uuid
  )->>'workerKind',
  'edge',
  'the bounded 2,480-person export is assigned to Edge processing'
);

select set_config(
  'gedcom.test.large_job_id',
  (
    public.start_gedcom_export(
      'e2000000-0000-0000-0000-000000000002',
      'e3000000-0000-0000-0000-000000000002'
    )->>'jobId'
  ),
  true
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.large_job_id')::uuid
  )->>'status',
  'queued',
  'a large export is durably queued'
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.large_job_id')::uuid
  )->>'estimatedPersonCount',
  '5001',
  'the large-job estimate is exact'
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.large_job_id')::uuid
  )->>'workerKind',
  'github',
  'exports above the Edge threshold are assigned to the large runner'
);
select is(
  public.start_gedcom_export(
    'e2000000-0000-0000-0000-000000000001',
    'e3000000-0000-0000-0000-000000000001'
  )->>'jobId',
  current_setting('gedcom.test.small_job_id'),
  'repeated clicks reuse the active export instead of duplicating work'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_gedcom_export(uuid)',
    'EXECUTE'
  ),
  'an authenticated browser cannot execute the worker claim RPC'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}',
  true
);
select is(
  public.claim_gedcom_export(
    current_setting('gedcom.test.small_job_id')::uuid
  )->>'status',
  'processing',
  'the service worker can claim the queued export'
);
select is(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.small_job_id')::uuid
  )->>'attempts',
  '1',
  'claiming establishes attempt number one'
);
select ok(
  public.get_gedcom_export_status(
    current_setting('gedcom.test.small_job_id')::uuid
  )->>'storagePath' like '%/attempt-1/family-tree.ged',
  'each attempt writes to an isolated Storage object'
);
select is(
  public.touch_gedcom_export(
    current_setting('gedcom.test.small_job_id')::uuid,
    1,
    'serializing',
    37
  )->>'progressPercent',
  '37',
  'the current worker attempt can heartbeat progress'
);
select throws_ok(
  format(
    'select public.touch_gedcom_export(%L::uuid, 2, %L, 50)',
    current_setting('gedcom.test.small_job_id'),
    'stale-worker'
  ),
  '55000',
  'GEDCOM_EXPORT_LEASE_LOST',
  'a stale worker cannot overwrite a newer attempt'
);

reset role;
update public.projects
set deletion_pending = true
where id = 'e2000000-0000-0000-0000-000000000002';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-000000000000","role":"service_role"}',
  true
);
select ok(
  public.claim_gedcom_export(
    current_setting('gedcom.test.large_job_id')::uuid
  ) is null,
  'a job is not claimed after project deletion begins'
);

reset role;
select is(
  (
    select job.status
    from private.gedcom_export_jobs job
    where job.id = current_setting('gedcom.test.large_job_id')::uuid
  ),
  'failed',
  'the deletion fence terminally revokes queued work'
);
select is(
  (
    select job.error
    from private.gedcom_export_jobs job
    where job.id = current_setting('gedcom.test.large_job_id')::uuid
  ),
  'GEDCOM_EXPORT_ACCESS_REVOKED_OR_PROJECT_UNAVAILABLE',
  'revoked work records an auditable terminal reason'
);

select * from finish();
rollback;
