begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

select has_table('public', 'zagulyaky_tabular_import_batches', 'private tabular batches exist');
select has_table('public', 'zagulyaky_tabular_import_source_posts', 'private source posts exist');
select has_table('public', 'zagulyaky_tabular_import_events', 'private event rows exist');
select has_table('public', 'zagulyaky_tabular_import_participants', 'private participant rows exist');
select has_table('public', 'zagulyaky_tabular_import_event_sources', 'private event-source rows exist');
select has_table('public', 'zagulyaky_tabular_import_cards', 'private card rows exist');
select has_table('public', 'zagulyaky_tabular_import_qc', 'private QC rows exist');
select has_table('public', 'zagulyaky_tabular_import_chunks', 'private chunk receipts exist');

select ok(
  (
    select bool_and(relrowsecurity)
    from pg_class
    where oid = any(array[
      'public.zagulyaky_tabular_import_batches'::regclass,
      'public.zagulyaky_tabular_import_source_posts'::regclass,
      'public.zagulyaky_tabular_import_events'::regclass,
      'public.zagulyaky_tabular_import_participants'::regclass,
      'public.zagulyaky_tabular_import_event_sources'::regclass,
      'public.zagulyaky_tabular_import_cards'::regclass,
      'public.zagulyaky_tabular_import_qc'::regclass,
      'public.zagulyaky_tabular_import_chunks'::regclass
    ])
  ),
  'every workbook ledger table has RLS enabled'
);

select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_tabular_import_source_posts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zagulyaky_tabular_import_source_posts', 'INSERT')
  and has_table_privilege('service_role', 'public.zagulyaky_tabular_import_source_posts', 'INSERT'),
  'browser roles cannot read or mutate private raw source posts'
);

select has_column('public', 'zagulyaky_participants', 'social_estate_text', 'participant social estate survives safe materialization');
select has_column('public', 'zagulyaky_participants', 'occupation_or_rank_text', 'participant rank survives safe materialization');
select has_column('public', 'zagulyaky_participants', 'marital_status_text', 'participant marital state survives safe materialization');
select has_column('public', 'zagulyaky_participants', 'relation_original', 'participant source relation survives safe materialization');
select has_column('public', 'zagulyaky_participants', 'evidence_excerpt', 'participant evidence excerpt survives safe materialization');

select has_function(
  'public', 'admin_begin_zagulyaky_tabular_event_import_v1', array['text', 'text', 'jsonb', 'text'],
  'admin begin facade exists'
);
select has_function(
  'public', 'admin_get_zagulyaky_tabular_event_import_v1', array['uuid'],
  'admin summary facade exists'
);
select has_function(
  'public', 'admin_list_zagulyaky_tabular_event_imports_v1', array['text', 'integer', 'integer'],
  'admin list facade exists'
);
select has_function(
  'public', 'service_ingest_zagulyaky_tabular_event_import_chunk_v1', array['uuid', 'jsonb', 'text', 'integer', 'text'],
  'server chunk facade exists'
);
select has_function(
  'public', 'service_finalize_zagulyaky_tabular_event_import_v1', array['uuid', 'text', 'integer'],
  'server finalization facade exists'
);

select lives_ok(
  $$
    select security_private.zagulyaky_tabular_import_raw_text_v1(
      jsonb_build_object('event_date_original', repeat('д', 501)),
      'event_date_original',
      4000,
      false
    )
  $$,
  'a source-faithful event date description longer than 500 characters is accepted privately'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text)'::regprocedure,
    'EXECUTE'
  ),
  'only service_role can submit a private workbook chunk'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer)'::regprocedure,
    'EXECUTE'
  ),
  'only service_role can finalize a private workbook batch'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '8b000000-0000-0000-0000-000000000026',
  'authenticated', 'authenticated', 'tabular-import-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles (user_id, email, display_name) values
  ('8b000000-0000-0000-0000-000000000026', 'tabular-import-admin@example.test', 'Tabular Import Admin')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by) values
  ('8b000000-0000-0000-0000-000000000026', '8b000000-0000-0000-0000-000000000026')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by) values
  ('8b000000-0000-0000-0000-000000000026', 'content_admin', '8b000000-0000-0000-0000-000000000026')
on conflict (user_id, role_code) do nothing;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000026","role":"authenticated","email":"tabular-import-admin@example.test"}',
  true
);

select lives_ok(
  $$
    select public.admin_begin_zagulyaky_tabular_event_import_v1(
      'pgtap-tabular-event-import.xlsx',
      repeat('e', 64),
      '{"sourcePosts":1,"events":1,"participants":2,"eventSources":0,"cards":2,"qc":0,"eventsWithoutCards":0}'::jsonb,
      'dry_run'
    )
  $$,
  'an import-capable admin can begin a private workbook dry run'
);
select lives_ok(
  $$
    select public.admin_begin_zagulyaky_tabular_event_import_v1(
      'ordinary-workbook.xlsx',
      repeat('d', 64),
      '{"sourcePosts":0,"events":0,"participants":0,"eventSources":0,"cards":0,"qc":0,"eventsWithoutCards":0}'::jsonb,
      'dry_run'
    )
  $$,
  'an ordinary .xlsx filename reaches the protected dry-run begin path after the NUL regression fix'
);

reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$
    select public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(
      (select id from public.zagulyaky_tabular_import_batches where source_checksum = repeat('e', 64)),
      '{
        "sourcePosts":[{
          "post_key":"pgtap-post-001","source_platform":"facebook",
          "post_original_text":"A private Facebook source post."
        }],
        "events":[{
          "event_key":"pgtap-event-001","post_key":"pgtap-post-001",
          "event_sequence":1,"event_type_code":"birth","event_type_original":"Народження",
          "event_year":1902,"date_precision":"year","event_original_text":"Народження дитини."
        }],
        "participants":[{
          "participant_key":"pgtap-person-001","person_card_key":"pgtap-card-001",
          "event_key":"pgtap-event-001","post_key":"pgtap-post-001",
          "participant_sequence":1,"full_name_original":"Тестова Особа",
          "role_code":"newborn","social_estate_text":"селянин",
          "occupation_or_rank_text":"козак","marital_status_text":"неодружений",
          "relation_original":"дитина","evidence_excerpt":"Народження дитини."
        },{
          "participant_key":"pgtap-person-002","person_card_key":"pgtap-card-002",
          "event_key":"pgtap-event-001","post_key":"pgtap-post-001",
          "participant_sequence":2,"full_name_original":"Тестовий Свідок",
          "role_code":"witness","possible_living_person":true,"evidence_excerpt":"Присутній при записі."
        }],
        "eventSources":[],
        "cards":[{
          "card_key":"pgtap-card-001","post_key":"pgtap-post-001",
          "event_key":"pgtap-event-001","card_sequence":1,"card_kind":"person",
          "primary_participant_key":"pgtap-person-001","copy_event_participants":false,"card_title_original":"Тестова Особа",
          "card_original_text":"Народження дитини."
        },{
          "card_key":"pgtap-card-003","post_key":"pgtap-post-001",
          "event_key":"pgtap-event-001","card_sequence":2,"card_kind":"person",
          "primary_participant_key":"pgtap-person-001","copy_event_participants":true,"card_title_original":"Тестова Особа з учасниками",
          "card_original_text":"Народження дитини."
        }],
        "qc":[]
      }'::jsonb,
      'dry_run', 0, repeat('f', 64)
    )
  $$,
  'the service role can stage one event-centric private dry-run chunk'
);

select lives_ok(
  $$
    select public.service_finalize_zagulyaky_tabular_event_import_v1(
      (select id from public.zagulyaky_tabular_import_batches where source_checksum = repeat('e', 64)),
      'dry_run', 250
    )
  $$,
  'the service role can finish a matching private dry run without creating catalogue records'
);

reset role;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000026","role":"authenticated","email":"tabular-import-admin@example.test"}',
  true
);

select lives_ok(
  $$
    select public.admin_begin_zagulyaky_tabular_event_import_v1(
      'pgtap-tabular-event-import.xlsx',
      repeat('e', 64),
      '{"sourcePosts":1,"events":1,"participants":2,"eventSources":0,"cards":2,"qc":0,"eventsWithoutCards":0}'::jsonb,
      'commit'
    )
  $$,
  'the completed dry run can be explicitly promoted to a private commit'
);

reset role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$
    select public.service_finalize_zagulyaky_tabular_event_import_v1(
      (select id from public.zagulyaky_tabular_import_batches where source_checksum = repeat('e', 64)),
      'commit', 250
    )
  $$,
  'the checked private ledger can materialize one reviewable draft card'
);

select is(
  (select status from public.zagulyaky_tabular_import_batches where source_checksum = repeat('e', 64)),
  'completed',
  'the commit completes after both private cards are materialized'
);
select is(
  (select status from public.zagulyaky_records record_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = record_row.id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'),
  'draft',
  'materialization creates a draft only'
);
select is(
  (select verification_status from public.zagulyaky_records record_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = record_row.id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'),
  'unverified',
  'materialization preserves unverified status'
);
select is(
  (select role from public.zagulyaky_participants participant_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = participant_row.record_id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'),
  'subject',
  'the card primary participant becomes the structural subject'
);
select is(
  (select count(*)::integer from public.zagulyaky_participants participant_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = participant_row.record_id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'),
  1,
  'a card with copy_event_participants=false materializes only its primary participant'
);
select is(
  (select privacy_status from public.zagulyaky_records record_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = record_row.id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'),
  'pending',
  'an un-copied potentially living participant does not change the privacy of a copy=false card'
);
select is(
  (select privacy_status from public.zagulyaky_records record_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = record_row.id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-003'),
  'requires_consent',
  'a copied potentially living event participant requires consent even when not primary'
);
select is(
  (select count(*)::integer from public.zagulyaky_participants participant_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = participant_row.record_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-003'),
  2,
  'the consent-protected card copies both event participants before applying its privacy state'
);
select is(
  (select record_row.lock_version from public.zagulyaky_records record_row
   join public.zagulyaky_tabular_import_card_records map on map.record_id = record_row.id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'),
  2,
  'the completed import touches the record once after child materialization for a complete audit revision'
);
select is(
  (select jsonb_array_length(version.snapshot -> 'participants')
   from public.zagulyaky_record_versions version
   join public.zagulyaky_tabular_import_card_records map on map.record_id = version.record_id
   join public.zagulyaky_tabular_import_batches batch_row on batch_row.id = map.batch_id
   join public.zagulyaky_tabular_import_cards card_row on card_row.id = map.card_id
   where batch_row.source_checksum = repeat('e', 64) and card_row.card_key = 'pgtap-card-001'
   order by version.revision_no desc
   limit 1),
  1,
  'the final record-version snapshot contains the materialized primary participant'
);

select * from finish();
rollback;
