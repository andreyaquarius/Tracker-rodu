begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(22);

select has_function(
  'security_private',
  'zagulyaky_commit_recovery_eligible_v1',
  array['public.zagulyaky_ingestion_batches'],
  'private recovery eligibility helper exists'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'security_private.zagulyaky_commit_recovery_eligible_v1(public.zagulyaky_ingestion_batches)'::regprocedure,
    'EXECUTE'
  ),
  'the recovery eligibility helper stays private while the authorized definer begin RPC can use it'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '8b000000-0000-0000-0000-000000000002',
  'authenticated', 'authenticated', 'zagulyaky-stage0-recovery-admin@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
)
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles (user_id, email, display_name) values
  ('8b000000-0000-0000-0000-000000000002', 'zagulyaky-stage0-recovery-admin@example.test', 'Zagulyaky Stage 0 Recovery Admin')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by) values
  ('8b000000-0000-0000-0000-000000000002', '8b000000-0000-0000-0000-000000000002')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by) values
  ('8b000000-0000-0000-0000-000000000002', 'content_admin', '8b000000-0000-0000-0000-000000000002')
on conflict (user_id, role_code) do nothing;

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status,
  requested_by, processed_item_count, staged_item_count, duplicate_item_count,
  quarantined_item_count, failed_item_count, completed_at
) values (
  '20000000-0000-4000-8000-000000000003',
  'pgtap-stage0-recovery.json', repeat('9', 64), 2, 'commit', 'completed_with_errors',
  '8b000000-0000-0000-0000-000000000002', 2, 1, 0, 0, 1, now()
);

insert into public.zagulyaky_ingestion_items(
  id, source_platform, external_id, idempotency_key, first_seen_batch_id, last_seen_batch_id,
  raw_payload, stage_status
) values (
  '30000000-0000-4000-8000-000000000003',
  'facebook_group_json', 'pgtap-recovery-existing', 'facebook_group_post:pgtap-recovery-existing',
  '20000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003',
  '{"postId":"pgtap-recovery-existing"}'::jsonb, 'staged'
);

insert into public.zagulyaky_ingestion_batch_items(batch_id, item_id, source_item_index)
values (
  '20000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000003', 0
);

insert into public.zagulyaky_ingestion_chunks(
  batch_id, import_mode, chunk_index, item_count, payload_checksum, status,
  processed_item_count, staged_item_count, failed_item_count
) values
  ('20000000-0000-4000-8000-000000000003', 'commit', 0, 2, repeat('a', 64), 'processed', 2, 1, 1),
  ('20000000-0000-4000-8000-000000000003', 'dry_run', 0, 2, repeat('b', 64), 'processed', 2, 0, 0);

insert into public.zagulyaky_ingestion_item_errors(
  batch_id, import_mode, chunk_index, source_item_index, external_id_hint, error_code, error_detail
) values (
  '20000000-0000-4000-8000-000000000003', 'commit', 0, 1,
  'pgtap-recovery-attached', 'INGESTION_ITEM_REJECTED', 'Item rejected by the private import contract.'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000002","role":"authenticated","email":"zagulyaky-stage0-recovery-admin@example.test"}',
  true
);

select is(
  (public.admin_begin_zagulyaky_facebook_import_v1(
    'pgtap-stage0-recovery.json', repeat('9', 64), now(), null, 2, 'dry_run', '{}'::jsonb
  ) ->> 'recoveryAvailable')::boolean,
  true,
  'a terminal same-checksum commit with the exact recovery invariants exposes recovery availability'
);

create temporary table pgtap_stage0_recovery_begin_result as
select public.admin_begin_zagulyaky_facebook_import_v1(
  'pgtap-stage0-recovery.json', repeat('9', 64), now(), null, 2, 'commit', '{}'::jsonb
) as result;

reset role;

select is(
  (select (result ->> 'recoveryStarted')::boolean from pgtap_stage0_recovery_begin_result),
  true,
  'authorized same-checksum commit starts a controlled recovery rather than replaying the terminal failure'
);
select is(
  (select (result ->> 'replayed')::boolean from pgtap_stage0_recovery_begin_result),
  false,
  'recovery tells the Edge worker to send its commit chunks again'
);
select ok(
  (
    select status = 'received'
      and processed_item_count = 1
      and staged_item_count = 1
      and duplicate_item_count = 0
      and quarantined_item_count = 0
      and failed_item_count = 0
    from public.zagulyaky_ingestion_batches
    where id = '20000000-0000-4000-8000-000000000003'
  ),
  'recovery preserves the successful membership baseline and resets only retry counters'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_chunks
    where batch_id = '20000000-0000-4000-8000-000000000003' and import_mode = 'commit'),
  0,
  'recovery removes only previous commit receipts'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_item_errors
    where batch_id = '20000000-0000-4000-8000-000000000003' and import_mode = 'commit'),
  0,
  'recovery removes only previous commit error receipts'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_chunks
    where batch_id = '20000000-0000-4000-8000-000000000003' and import_mode = 'dry_run'),
  1,
  'recovery retains the separate dry-run receipt'
);
select ok(
  exists(
    select 1
    from public.zagulyaky_ingestion_audit_events
    where batch_id = '20000000-0000-4000-8000-000000000003'
      and action = 'commit_recovery_started'
      and metadata ?& array['expectedItemCount', 'retainedItemCount', 'retainedQuarantinedItemCount', 'recoveryAttemptCount']
  ),
  'recovery emits a bounded operational audit event without item content'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"20000000-0000-4000-8000-000000000099"}',
  true
);

create temporary table pgtap_stage0_recovery_chunk_result as
select public.service_ingest_zagulyaky_facebook_chunk_v1(
  '20000000-0000-4000-8000-000000000003'::uuid,
  '[
    {
      "externalId":"pgtap-recovery-existing",
      "sourceDatePrecision":"unknown",
      "rawPayload":{"postId":"pgtap-recovery-existing"},
      "candidateYears":[],"declaredAttachmentCount":0,
      "sourceIncomplete":false,"textTruncated":false,"requiresOcr":false,"requiresSourceRefetch":false,
      "missingAuthor":true,"missingPublicationDate":true,"suspectedDuplicate":false,
      "possibleLivingPerson":false,"quarantined":false,"attachments":[],"links":[]
    },
    {
      "externalId":"pgtap-recovery-attached",
      "sourceDatePrecision":"unknown",
      "rawPayload":{"postId":"pgtap-recovery-attached"},
      "candidateYears":[],"declaredAttachmentCount":1,
      "sourceIncomplete":false,"textTruncated":false,"requiresOcr":false,"requiresSourceRefetch":false,
      "missingAuthor":true,"missingPublicationDate":true,"suspectedDuplicate":false,
      "possibleLivingPerson":false,"quarantined":false,
      "attachments":[{
        "facebookPhotoId":"123456789", "sourceUrl":"https://cdn.example.test/recovery.jpg",
        "facebookUrl":"https://www.facebook.com/photo/?fbid=123456789", "alt":"fixture", "width":10, "height":20
      }],
      "links":[]
    }
  ]'::jsonb,
  'commit', 0, repeat('c', 64)
) as result;

select lives_ok(
  $$
    select public.service_finalize_zagulyaky_facebook_import_v1(
      '20000000-0000-4000-8000-000000000003'::uuid,
      'commit'
    )
  $$,
  'recovered service commit can finalize after processing only the formerly failed source slot'
);

reset role;

select is(
  (select (result ->> 'processedItemCount')::integer from pgtap_stage0_recovery_chunk_result),
  1,
  'an exact existing batch/source-index membership is skipped without double-counting it'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_media_assets
    where source_platform = 'facebook' and source_asset_key = 'facebook-photo:123456789'),
  1,
  'a formerly failed attached item inserts its private media asset without an ON CONFLICT ambiguity'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_attachments attachment
    join public.zagulyaky_ingestion_items item on item.id = attachment.item_id
    where item.external_id = 'pgtap-recovery-attached'),
  1,
  'the attached item records one private attachment appearance'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_batch_items
    where batch_id = '20000000-0000-4000-8000-000000000003'),
  2,
  'recovery retains the successful membership and adds the formerly failed source slot'
);
select ok(
  (
    select status = 'completed'
      and processed_item_count = 2
      and staged_item_count = 2
      and duplicate_item_count = 0
      and failed_item_count = 0
    from public.zagulyaky_ingestion_batches
    where id = '20000000-0000-4000-8000-000000000003'
  ),
  'recovery completes with reconciled counters and no public record creation'
);

-- The same fix must also cover a fresh, ordinary commit.  This fixture does
-- not use recovery membership, so it exercises the normal attachment path
-- that future imports will take.
insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status, requested_by
) values (
  '20000000-0000-4000-8000-000000000005',
  'pgtap-stage0-normal-attached.json', repeat('7', 64), 1, 'commit', 'received',
  '8b000000-0000-0000-0000-000000000002'
);

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"20000000-0000-4000-8000-000000000099"}',
  true
);

create temporary table pgtap_stage0_normal_attachment_chunk_result as
select public.service_ingest_zagulyaky_facebook_chunk_v1(
  '20000000-0000-4000-8000-000000000005'::uuid,
  '[{
    "externalId":"pgtap-normal-attached", "sourceDatePrecision":"unknown",
    "rawPayload":{"postId":"pgtap-normal-attached"},
    "candidateYears":[], "declaredAttachmentCount":1,
    "sourceIncomplete":false, "textTruncated":false, "requiresOcr":false, "requiresSourceRefetch":false,
    "missingAuthor":true, "missingPublicationDate":true, "suspectedDuplicate":false,
    "possibleLivingPerson":false, "quarantined":false,
    "attachments":[{
      "facebookPhotoId":"987654321", "sourceUrl":"https://cdn.example.test/normal.jpg",
      "facebookUrl":"https://www.facebook.com/photo/?fbid=987654321", "alt":"fixture", "width":10, "height":20
    }], "links":[]
  }]'::jsonb,
  'commit', 0, repeat('d', 64)
) as result;

select lives_ok(
  $$
    select public.service_finalize_zagulyaky_facebook_import_v1(
      '20000000-0000-4000-8000-000000000005'::uuid,
      'commit'
    )
  $$,
  'a normal attached commit can finalize without the former source-asset conflict'
);

reset role;

select is(
  (select (result ->> 'processedItemCount')::integer from pgtap_stage0_normal_attachment_chunk_result),
  1,
  'a normal attached commit processes its one source slot'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_media_assets
    where source_platform = 'facebook' and source_asset_key = 'facebook-photo:987654321'),
  1,
  'a normal attached commit stores its private media asset'
);
select is(
  (select count(*)::integer from public.zagulyaky_ingestion_attachments attachment
    join public.zagulyaky_ingestion_items item on item.id = attachment.item_id
    where item.external_id = 'pgtap-normal-attached'),
  1,
  'a normal attached commit stores its private attachment appearance'
);
select ok(
  (
    select status = 'completed'
      and processed_item_count = 1
      and staged_item_count = 1
      and failed_item_count = 0
    from public.zagulyaky_ingestion_batches
    where id = '20000000-0000-4000-8000-000000000005'
  ),
  'a normal attached commit reaches completed with reconciled counters'
);

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status,
  requested_by, processed_item_count, staged_item_count, duplicate_item_count,
  quarantined_item_count, failed_item_count, completed_at
) values (
  '20000000-0000-4000-8000-000000000004',
  'pgtap-stage0-recovery-ineligible.json', repeat('8', 64), 2, 'commit', 'completed_with_errors',
  '8b000000-0000-0000-0000-000000000002', 2, 1, 1, 0, 1, now()
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000002","role":"authenticated","email":"zagulyaky-stage0-recovery-admin@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_begin_zagulyaky_facebook_import_v1(
      'pgtap-stage0-recovery-ineligible.json', repeat('8', 64), now(), null, 2, 'commit', '{}'::jsonb
    )
  $$,
  '23514',
  'COMMIT_RECOVERY_NOT_AVAILABLE',
  'recovery rejects a completed error batch that does not meet the exact invariant set'
);

reset role;

select * from finish();
rollback;
