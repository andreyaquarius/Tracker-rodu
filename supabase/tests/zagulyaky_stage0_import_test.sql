begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(36);

select has_table('public', 'zagulyaky_ingestion_batches', 'private ingestion batches table exists');
select has_table('public', 'zagulyaky_ingestion_items', 'private canonical ingestion items table exists');
select has_table('public', 'zagulyaky_ingestion_batch_items', 'batch membership table exists');
select has_table('public', 'zagulyaky_ingestion_chunks', 'idempotent chunk receipt table exists');
select has_table('public', 'zagulyaky_ingestion_item_errors', 'sanitized item errors table exists');
select has_table('public', 'zagulyaky_ingestion_media_assets', 'private media asset table exists');
select has_table('public', 'zagulyaky_ingestion_attachments', 'private attachment appearance table exists');
select has_table('public', 'zagulyaky_ingestion_links', 'private links table exists');
select has_table('public', 'zagulyaky_ingestion_item_records', '0..N item-to-record link table exists');
select has_table('public', 'zagulyaky_extraction_jobs', 'private extraction jobs table exists');

select ok(
  (
    select bool_and(relrowsecurity)
    from pg_class
    where oid = any(array[
      'public.zagulyaky_ingestion_batches'::regclass,
      'public.zagulyaky_ingestion_items'::regclass,
      'public.zagulyaky_ingestion_batch_items'::regclass,
      'public.zagulyaky_ingestion_chunks'::regclass,
      'public.zagulyaky_ingestion_item_errors'::regclass,
      'public.zagulyaky_ingestion_media_assets'::regclass,
      'public.zagulyaky_ingestion_attachments'::regclass,
      'public.zagulyaky_ingestion_links'::regclass,
      'public.zagulyaky_ingestion_item_records'::regclass,
      'public.zagulyaky_extraction_jobs'::regclass
    ])
  ),
  'RLS is enabled on every Stage 0 private table'
);

select ok(
  not has_table_privilege('anon', 'public.zagulyaky_ingestion_items', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zagulyaky_ingestion_items', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zagulyaky_ingestion_items', 'INSERT')
  and has_table_privilege('service_role', 'public.zagulyaky_ingestion_items', 'INSERT'),
  'browser roles cannot directly read or write raw staging items'
);

select has_function(
  'public', 'admin_begin_zagulyaky_facebook_import_v1',
  array['text', 'text', 'timestamp with time zone', 'text', 'integer', 'text', 'jsonb'],
  'admin start RPC exists'
);
select has_function(
  'public', 'admin_get_zagulyaky_ingestion_batch_v1', array['uuid'],
  'admin batch summary RPC exists'
);
select has_function(
  'public', 'service_ingest_zagulyaky_facebook_chunk_v1',
  array['uuid', 'jsonb', 'text', 'integer', 'text'],
  'service chunk RPC exists'
);
select has_function(
  'public', 'service_finalize_zagulyaky_facebook_import_v1',
  array['uuid', 'text'],
  'service finalization RPC exists'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text)'::regprocedure,
    'EXECUTE'
  ),
  'only service_role can invoke the chunk ingestion RPC'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.service_finalize_zagulyaky_facebook_import_v1(uuid,text)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_finalize_zagulyaky_facebook_import_v1(uuid,text)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.service_finalize_zagulyaky_facebook_import_v1(uuid,text)'::regprocedure,
    'EXECUTE'
  ),
  'only service_role can finalize an ingestion batch'
);

select ok(
  not (select prosecdef from pg_proc where oid =
    'public.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb)'::regprocedure),
  'browser-facing start RPC is a SECURITY INVOKER facade'
);

-- Exercise the browser-facing begin RPC as a genuinely authorized admin.  A
-- valid ordinary filename previously hit `chr(0)` inside the private function
-- and raised SQLSTATE 54000 before it could create a dry-run batch.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '8b000000-0000-0000-0000-000000000001',
  'authenticated', 'authenticated', 'zagulyaky-stage0-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles (user_id, email, display_name) values
  ('8b000000-0000-0000-0000-000000000001', 'zagulyaky-stage0-admin@example.test', 'Zagulyaky Stage 0 Admin')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by) values
  ('8b000000-0000-0000-0000-000000000001', '8b000000-0000-0000-0000-000000000001')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by) values
  ('8b000000-0000-0000-0000-000000000001', 'content_admin', '8b000000-0000-0000-0000-000000000001')
on conflict (user_id, role_code) do nothing;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000001","role":"authenticated","email":"zagulyaky-stage0-admin@example.test"}',
  true
);

select lives_ok(
  $$
    select public.admin_begin_zagulyaky_facebook_import_v1(
      'pgtap-stage0-admin-begin.json',
      repeat('a', 64),
      now(),
      null,
      1,
      'dry_run',
      '{}'::jsonb
    )
  $$,
  'an authorized admin can begin a dry run with an ordinary source filename'
);

reset role;

select is(
  (select status from public.zagulyaky_ingestion_batches where source_checksum = repeat('a', 64)),
  'received',
  'the successful admin begin call creates only a received private dry-run batch'
);

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status
) values (
  '20000000-0000-4000-8000-000000000001',
  'pgtap-stage0.json', repeat('b', 64), 1, 'dry_run', 'received'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"20000000-0000-4000-8000-000000000099"}',
  true
);

select lives_ok(
  $$
    select public.service_ingest_zagulyaky_facebook_chunk_v1(
      '20000000-0000-4000-8000-000000000001'::uuid,
      '[{
        "externalId":"pgtap-stage0-post-001",
        "sourceDatePrecision":"unknown",
        "rawPayload":{"postId":"pgtap-stage0-post-001"},
        "candidateYears":[1891],
        "declaredAttachmentCount":0,
        "sourceIncomplete":false,
        "textTruncated":false,
        "requiresOcr":false,
        "requiresSourceRefetch":false,
        "missingAuthor":true,
        "missingPublicationDate":true,
        "suspectedDuplicate":false,
        "possibleLivingPerson":false,
        "quarantined":false,
        "attachments":[],
        "links":[]
      }]'::jsonb,
      'dry_run', 0, repeat('c', 64)
    )
  $$,
  'service worker can process one valid dry-run chunk'
);

select lives_ok(
  $$
    select public.service_finalize_zagulyaky_facebook_import_v1(
      '20000000-0000-4000-8000-000000000001'::uuid,
      'dry_run'
    )
  $$,
  'service worker can finalize a complete dry run'
);

reset role;

select is(
  (select status from public.zagulyaky_ingestion_batches where id = '20000000-0000-4000-8000-000000000001'),
  'dry_run_complete',
  'valid dry run reaches dry_run_complete'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_items
    where external_id = 'pgtap-stage0-post-001'),
  0,
  'dry run persists no raw staging item'
);
select is(
  (select failed_item_count from public.zagulyaky_ingestion_batches
    where id = '20000000-0000-4000-8000-000000000001'),
  0,
  'valid dry run has no contract errors'
);
select is(
  (select processed_item_count from public.zagulyaky_ingestion_batches
    where id = '20000000-0000-4000-8000-000000000001'),
  1,
  'dry run records a sanitized processed count'
);

-- Simulate the state transition performed by the admin-only begin RPC after a
-- clean dry run, then execute the service-only commit path. This reaches the
-- actual raw staging insert without granting a browser role table access.
update public.zagulyaky_ingestion_batches set
  import_mode = 'commit',
  status = 'received',
  processed_item_count = 0,
  staged_item_count = 0,
  duplicate_item_count = 0,
  quarantined_item_count = 0,
  failed_item_count = 0,
  completed_at = null,
  updated_at = now()
where id = '20000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"20000000-0000-4000-8000-000000000099"}',
  true
);

select lives_ok(
  $$
    select public.service_ingest_zagulyaky_facebook_chunk_v1(
      '20000000-0000-4000-8000-000000000001'::uuid,
      '[{
        "externalId":"pgtap-stage0-post-001",
        "sourceDatePrecision":"unknown",
        "rawText":"Приватний тестовий текст staging.",
        "rawPayload":{"postId":"pgtap-stage0-post-001"},
        "candidateYears":[1891],
        "declaredAttachmentCount":0,
        "sourceIncomplete":false,
        "textTruncated":false,
        "requiresOcr":false,
        "requiresSourceRefetch":false,
        "missingAuthor":true,
        "missingPublicationDate":true,
        "suspectedDuplicate":false,
        "possibleLivingPerson":false,
        "quarantined":false,
        "attachments":[],
        "links":[]
      }]'::jsonb,
      'commit', 0, repeat('e', 64)
    )
  $$,
  'service worker can stage one commit chunk after a clean dry run'
);

select lives_ok(
  $$
    select public.service_finalize_zagulyaky_facebook_import_v1(
      '20000000-0000-4000-8000-000000000001'::uuid,
      'commit'
    )
  $$,
  'service worker can finalize the committed staging batch'
);

reset role;

select is(
  (select status from public.zagulyaky_ingestion_batches where id = '20000000-0000-4000-8000-000000000001'),
  'completed',
  'commit reaches completed after staging the expected item'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_items
    where external_id = 'pgtap-stage0-post-001'),
  1,
  'commit creates one private raw staging item'
);
select is(
  (select stage_status from public.zagulyaky_ingestion_items
    where external_id = 'pgtap-stage0-post-001'),
  'staged',
  'commit keeps the item private in the staged workflow state'
);

-- A direct service caller is still untrusted input: a one-character
-- validation marker must be recorded with the fixed fallback code instead of
-- violating the error-table CHECK and aborting the whole chunk.
insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status
) values (
  '20000000-0000-4000-8000-000000000002',
  'pgtap-stage0-invalid.json', repeat('f', 64), 1, 'dry_run', 'received'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"20000000-0000-4000-8000-000000000099"}',
  true
);

select lives_ok(
  $$
    select public.service_ingest_zagulyaky_facebook_chunk_v1(
      '20000000-0000-4000-8000-000000000002'::uuid,
      '[{"inputError":"x","externalId":"pgtap-invalid"}]'::jsonb,
      'dry_run', 0, repeat('1', 64)
    )
  $$,
  'malformed direct item is recorded instead of aborting its chunk'
);
select lives_ok(
  $$
    select public.service_finalize_zagulyaky_facebook_import_v1(
      '20000000-0000-4000-8000-000000000002'::uuid,
      'dry_run'
    )
  $$,
  'a dry run with a rejected item can still finalize its audit summary'
);

reset role;

select is(
  (select error_code from public.zagulyaky_ingestion_item_errors
    where batch_id = '20000000-0000-4000-8000-000000000002'),
  'INGESTION_ITEM_REJECTED',
  'short untrusted error text uses the valid fixed fallback code'
);
select is(
  (select failed_item_count from public.zagulyaky_ingestion_batches
    where id = '20000000-0000-4000-8000-000000000002'),
  1,
  'rejected direct item increments only the failed counter'
);

select * from finish();
rollback;
