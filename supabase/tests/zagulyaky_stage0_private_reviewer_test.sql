begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

select has_function(
  'public',
  'admin_list_zagulyaky_ingestion_batches_v1',
  array['text', 'integer', 'integer'],
  'private reviewer exposes a paginated batch-list facade'
);
select has_function(
  'public',
  'admin_list_zagulyaky_ingestion_items_v1',
  array['uuid', 'text', 'text', 'boolean', 'text', 'integer', 'integer'],
  'private reviewer exposes a filtered item-list facade'
);
select has_function(
  'public',
  'admin_get_zagulyaky_ingestion_item_v1',
  array['uuid', 'uuid'],
  'private reviewer exposes an explicitly selected item detail facade'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)'::regprocedure,
    'EXECUTE'
  ),
  'anonymous callers cannot list private ingestion batches'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)'::regprocedure,
    'EXECUTE'
  ),
  'anonymous callers cannot list private ingestion items'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'anonymous callers cannot open private ingestion item detail'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated facades are available only for their in-function authorization check'
);
select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_ingestion_items', 'SELECT'),
  'the reviewer does not restore direct table access to staging items'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '8b000000-0000-0000-0000-000000000008',
    'authenticated', 'authenticated', 'stage0-reviewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '8b000000-0000-0000-0000-000000000009',
    'authenticated', 'authenticated', 'stage0-not-reviewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  )
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles (user_id, email, display_name) values
  ('8b000000-0000-0000-0000-000000000008', 'stage0-reviewer@example.test', 'Stage 0 Reviewer'),
  ('8b000000-0000-0000-0000-000000000009', 'stage0-not-reviewer@example.test', 'Stage 0 Not Reviewer')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by) values
  ('8b000000-0000-0000-0000-000000000008', '8b000000-0000-0000-0000-000000000008')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by) values
  ('8b000000-0000-0000-0000-000000000008', 'content_admin', '8b000000-0000-0000-0000-000000000008')
on conflict (user_id, role_code) do nothing;

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status,
  requested_by, processed_item_count, staged_item_count, quarantined_item_count,
  completed_at
) values (
  '20000000-0000-4000-8000-000000000008',
  'pgtap-stage0-private-reviewer.json', repeat('6', 64), 2, 'commit', 'completed',
  '8b000000-0000-0000-0000-000000000008', 2, 2, 1, now()
);

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status, requested_by
) values (
  '20000000-0000-4000-8000-000000000009',
  'pgtap-stage0-private-reviewer-other-batch.json', repeat('5', 64), 1, 'commit', 'received',
  '8b000000-0000-0000-0000-000000000008'
);

insert into public.zagulyaky_ingestion_items(
  id, source_platform, external_id, idempotency_key, first_seen_batch_id, last_seen_batch_id,
  source_url, source_collection_url, source_author_label, source_date_text, source_published_at,
  source_date_precision, raw_text, raw_payload, candidate_years, declared_attachment_count,
  requires_source_refetch, rights_review_required, stage_status
) values
  (
    '30000000-0000-4000-8000-000000000008',
    'facebook_group_json', 'pgtap-review-alpha', 'facebook_group_post:pgtap-review-alpha',
    '20000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000008',
    'https://www.facebook.com/groups/example/posts/alpha', 'https://www.facebook.com/groups/example',
    'Fixture author', '1 січня 1900', '1900-01-01T10:00:00+00', 'exact',
    'Reviewer fixture alpha https://example.test/list-hidden text.', '{"postId":"pgtap-review-alpha"}'::jsonb, array[1900], 1,
    false, true, 'staged'
  ),
  (
    '30000000-0000-4000-8000-000000000009',
    'facebook_group_json', 'pgtap-review-beta', 'facebook_group_post:pgtap-review-beta',
    '20000000-0000-4000-8000-000000000008', '20000000-0000-4000-8000-000000000008',
    null, null, null, null, null, 'unknown',
    'Reviewer fixture beta OCR text.', '{"postId":"pgtap-review-beta"}'::jsonb, '{}', 0,
    true, true, 'quarantined'
  ),
  (
    '30000000-0000-4000-8000-000000000010',
    'facebook_group_json', 'pgtap-review-outside', 'facebook_group_post:pgtap-review-outside',
    '20000000-0000-4000-8000-000000000009', '20000000-0000-4000-8000-000000000009',
    null, null, null, null, null, 'unknown',
    'Reviewer fixture outside batch text.', '{"postId":"pgtap-review-outside"}'::jsonb, '{}', 0,
    false, true, 'staged'
  );

update public.zagulyaky_ingestion_items
set quarantined = true, requires_ocr = true
where id = '30000000-0000-4000-8000-000000000009';

insert into public.zagulyaky_ingestion_batch_items(batch_id, item_id, source_item_index) values
  ('20000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000008', 0),
  ('20000000-0000-4000-8000-000000000008', '30000000-0000-4000-8000-000000000009', 1),
  ('20000000-0000-4000-8000-000000000009', '30000000-0000-4000-8000-000000000010', 0);

insert into public.zagulyaky_ingestion_media_assets(
  id, source_platform, source_asset_key, facebook_photo_id, original_cdn_url, photo_page_url
) values (
  '40000000-0000-4000-8000-000000000008',
  'facebook', 'facebook-photo:800000008', '800000008',
  'https://cdn.example.test/private-reviewer.jpg',
  'https://www.facebook.com/photo/?fbid=800000008'
);

insert into public.zagulyaky_ingestion_attachments(
  id, item_id, asset_id, source_index, original_cdn_url, photo_page_url, alt_text, width, height
) values (
  '50000000-0000-4000-8000-000000000008',
  '30000000-0000-4000-8000-000000000008', '40000000-0000-4000-8000-000000000008', 0,
  'https://cdn.example.test/private-reviewer.jpg',
  'https://www.facebook.com/photo/?fbid=800000008', 'Fixture image', 10, 20
);

insert into public.zagulyaky_ingestion_links(
  item_id, source_index, raw_url, normalized_url, label, link_kind, requires_safe_fetch
) values (
  '30000000-0000-4000-8000-000000000008', 0,
  'https://www.facebook.com/groups/example/posts/alpha',
  'https://www.facebook.com/groups/example/posts/alpha', 'Fixture source', 'facebook_other', true
);

insert into public.zagulyaky_extraction_jobs(item_id, job_type, status, requested_by) values
  ('30000000-0000-4000-8000-000000000009', 'ocr', 'queued', '8b000000-0000-0000-0000-000000000008');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000009","role":"authenticated","email":"stage0-not-reviewer@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_list_zagulyaky_ingestion_batches_v1(null, 25, 0)
  $$,
  '42501',
  'ADMIN_PERMISSION_REQUIRED',
  'an authenticated user without zagulyaky.import is denied by the reviewer RPC'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000008","role":"authenticated","email":"stage0-reviewer@example.test"}',
  true
);

create temporary table pgtap_stage0_reviewer_batches as
select public.admin_list_zagulyaky_ingestion_batches_v1('completed', 25, 0) as result;

select ok(
  exists (
    select 1
    from jsonb_array_elements((select result -> 'items' from pgtap_stage0_reviewer_batches)) item
    where item ->> 'batchId' = '20000000-0000-4000-8000-000000000008'
  ),
  'the authorized reviewer can list the completed private batch among other private batches'
);
select ok(
  not ((select result from pgtap_stage0_reviewer_batches) -> 'items' -> 0 ? 'profileSummary'),
  'batch list does not return profile summary payloads'
);

create temporary table pgtap_stage0_reviewer_items as
select public.admin_list_zagulyaky_ingestion_items_v1(
  '20000000-0000-4000-8000-000000000008'::uuid, null, null, null, null, 25, 0
) as result;

select is(
  (select (result -> 'items' -> 0 ->> 'sourceItemIndex')::integer from pgtap_stage0_reviewer_items),
  0,
  'item list is stably ordered by the original source item index'
);
select ok(
  not ((select result from pgtap_stage0_reviewer_items) -> 'items' -> 0 ? 'rawText')
  and not ((select result from pgtap_stage0_reviewer_items) -> 'items' -> 0 ? 'sourceUrl')
  and not ((select result from pgtap_stage0_reviewer_items) -> 'items' -> 0 ? 'rawPayload'),
  'item list returns only a short preview and omits full text, URLs, and the JSON source blob'
);
select is(
  (select result -> 'items' -> 0 ->> 'textPreview' from pgtap_stage0_reviewer_items),
  'Reviewer fixture alpha [посилання приховано] text.',
  'item-list preview redacts a URL embedded in source text'
);
select is(
  (
    public.admin_list_zagulyaky_ingestion_items_v1(
      '20000000-0000-4000-8000-000000000008'::uuid,
      null, null, null, 'has_attachments', 25, 0
    ) ->> 'total'
  )::integer,
  1,
  'attachment filter finds only the item with a private attachment'
);
select is(
  (
    public.admin_list_zagulyaky_ingestion_items_v1(
      '20000000-0000-4000-8000-000000000008'::uuid,
      null, null, null, 'requires_ocr', 25, 0
    ) ->> 'total'
  )::integer,
  1,
  'OCR filter finds only the flagged private item'
);
select is(
  (
    public.admin_list_zagulyaky_ingestion_items_v1(
      '20000000-0000-4000-8000-000000000008'::uuid,
      null, 'quarantined', true, null, 25, 0
    ) ->> 'total'
  )::integer,
  1,
  'stage and quarantine filters combine without exposing other items'
);
select is(
  (
    public.admin_list_zagulyaky_ingestion_items_v1(
      '20000000-0000-4000-8000-000000000008'::uuid,
      'beta OCR', null, null, null, 25, 0
    ) ->> 'total'
  )::integer,
  1,
  'bounded search matches the private review text without a public projection'
);

create temporary table pgtap_stage0_reviewer_detail as
select public.admin_get_zagulyaky_ingestion_item_v1(
  '20000000-0000-4000-8000-000000000008'::uuid,
  '30000000-0000-4000-8000-000000000008'::uuid
) as result;

select is(
  (select result -> 'item' -> 'content' ->> 'rawText' from pgtap_stage0_reviewer_detail),
  'Reviewer fixture alpha https://example.test/list-hidden text.',
  'selected detail returns the private text only to the authorized reviewer'
);
select is(
  (select jsonb_array_length(result -> 'attachments') from pgtap_stage0_reviewer_detail),
  1,
  'selected detail returns attachment metadata but not image bytes'
);
select is(
  (select result -> 'links' -> 0 ->> 'rawUrl' from pgtap_stage0_reviewer_detail),
  'https://www.facebook.com/groups/example/posts/alpha',
  'selected detail returns source links only after explicit item selection'
);
select ok(
  not ((select result from pgtap_stage0_reviewer_detail) -> 'item' ? 'rawPayload'),
  'selected detail never returns the original JSON source blob'
);

reset role;

select ok(
  exists (
    select 1
    from public.admin_audit_log audit
    where audit.admin_actor_id = '8b000000-0000-0000-0000-000000000008'
      and audit.action_code = 'zagulyaky.ingestion_item.view'
      and audit.target_type = 'zagulyaky_ingestion_item'
      and audit.target_id = '30000000-0000-4000-8000-000000000008'
      and audit.sanitized_diff ?& array[
        'batchId', 'sourceItemIndex', 'rawTextCharactersReturned',
        'attachmentCount', 'linkCount', 'jobCount', 'recordLinkCount'
      ]
      and audit.sanitized_diff::text not like '%Reviewer fixture alpha https://example.test/list-hidden text%'
  ),
  'opening private detail creates an operator audit without copying private text'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8b000000-0000-0000-0000-000000000008","role":"authenticated","email":"stage0-reviewer@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_get_zagulyaky_ingestion_item_v1(
      '20000000-0000-4000-8000-000000000008'::uuid,
      '30000000-0000-4000-8000-000000000010'::uuid
    )
  $$,
  'P0002',
  'INGESTION_ITEM_NOT_FOUND',
  'detail refuses an item that is not a member of the requested batch'
);

reset role;

select * from finish();
rollback;
