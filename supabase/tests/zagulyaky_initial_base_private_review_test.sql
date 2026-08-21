begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

select has_function(
  'public',
  'admin_list_zagulyaky_ingestion_items_v1',
  array['uuid', 'text', 'text', 'boolean', 'text', 'integer', 'integer'],
  'initial-base review retains the protected Stage 0 list facade'
);
select has_function(
  'public',
  'admin_get_zagulyaky_ingestion_item_v1',
  array['uuid', 'uuid'],
  'initial-base review retains the protected selected-item facade'
);
select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_ingestion_structured_candidates', 'SELECT'),
  'browser roles still have no direct access to private structured candidates'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated callers cannot automatically materialize candidates into catalogue drafts'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer)'::regprocedure,
    'EXECUTE'
  ),
  'the service role cannot bypass the disabled automatic materialization route'
);

create temporary table pgtap_initial_base_validated as
select security_private.zagulyaky_structuring_validate_candidate_v1(
  $$
  {
    "kind": "person",
    "confidence": 0.91,
    "title": "Сергій Карповь Онищенко",
    "participants": [
      {
        "structuralRole": "subject",
        "eventRoleCode": "groom",
        "originalFullName": "Сергей Карповь Онищенко",
        "originText": "Полтавской губерн. Кобелякского уезда Кишенской волости",
        "residenceText": "с. Хороше Павлоградського повіту",
        "socialEstateText": "казакь"
      }
    ]
  }
  $$::jsonb,
  'Сергей Карповь Онищенко'
) as result;

select ok(
  (select result -> 'candidateData' -> 'participants' -> 0 ->> 'originText' from pgtap_initial_base_validated)
    = 'Полтавской губерн. Кобелякского уезда Кишенской волости'
  and (select result -> 'candidateData' -> 'participants' -> 0 ->> 'residenceText' from pgtap_initial_base_validated)
    = 'с. Хороше Павлоградського повіту'
  and (select result -> 'candidateData' -> 'participants' -> 0 ->> 'socialEstateText' from pgtap_initial_base_validated)
    = 'казакь',
  'validator persists bounded origin, residence, and estate text on a participant candidate'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'ac000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'initial-base-reviewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ac000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'initial-base-non-reviewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  )
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles(user_id, email, display_name) values
  ('ac000000-0000-4000-8000-000000000001', 'initial-base-reviewer@example.test', 'Initial Base Reviewer'),
  ('ac000000-0000-4000-8000-000000000002', 'initial-base-non-reviewer@example.test', 'Initial Base Non Reviewer')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins(user_id, granted_by) values
  ('ac000000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001')
on conflict (user_id) do nothing;
insert into public.admin_role_assignments(user_id, role_code, assigned_by) values
  ('ac000000-0000-4000-8000-000000000001', 'content_admin', 'ac000000-0000-4000-8000-000000000001')
on conflict (user_id, role_code) do nothing;

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status,
  requested_by, processed_item_count, staged_item_count, completed_at
) values (
  'ad000000-0000-4000-8000-000000000001',
  'pgtap-initial-base-private-review.json', repeat('a', 64), 2, 'commit', 'completed',
  'ac000000-0000-4000-8000-000000000001', 2, 2, now()
);

insert into public.zagulyaky_ingestion_items(
  id, source_platform, external_id, idempotency_key, first_seen_batch_id, last_seen_batch_id,
  source_url, raw_text, raw_payload, declared_attachment_count, rights_review_required, stage_status
) values
  (
    'ae000000-0000-4000-8000-000000000001',
    'facebook_group_json', 'pgtap-initial-base-good', 'facebook_group_post:pgtap-initial-base-good',
    'ad000000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
    'https://www.facebook.com/groups/example/posts/pgtap-initial-base-good',
    '27 января 1908 года БРАК: Полтавской губерн. Кобелякского уезда Кишенской волости казакь Сергей Карповь Онищенко.',
    '{"postId":"pgtap-initial-base-good"}'::jsonb, 0, true, 'staged'
  ),
  (
    'ae000000-0000-4000-8000-000000000002',
    'facebook_group_json', 'pgtap-initial-base-bad-host', 'facebook_group_post:pgtap-initial-base-bad-host',
    'ad000000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
    'https://facebook.com.evil.invalid/groups/example/posts/not-a-facebook-host',
    'Host-boundary fixture.', '{"postId":"pgtap-initial-base-bad-host"}'::jsonb, 0, true, 'staged'
  );

insert into public.zagulyaky_ingestion_batch_items(batch_id, item_id, source_item_index) values
  ('ad000000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-000000000001', 0),
  ('ad000000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-000000000002', 1);

insert into public.zagulyaky_structuring_runs(
  id, batch_id, requested_by, parser_version, provider, model,
  configuration_fingerprint, batch_source_checksum, consent_granted,
  consent_version, consented_by, status, requested_item_limit
) values (
  'af000000-0000-4000-8000-000000000001',
  'ad000000-0000-4000-8000-000000000001',
  'ac000000-0000-4000-8000-000000000001', 'pgtap-initial-base-v2', 'fixture', 'fixture-model',
  repeat('b', 64), repeat('a', 64), true,
  'v1', 'ac000000-0000-4000-8000-000000000001', 'completed', 2
);

insert into public.zagulyaky_structuring_tasks(
  id, run_id, item_id, source_item_index, input_fingerprint, input_character_count,
  status, attempt_count, max_attempts, result_candidate_count
) values (
  'b0000000-0000-4000-8000-000000000001',
  'af000000-0000-4000-8000-000000000001',
  'ae000000-0000-4000-8000-000000000001', 0, repeat('c', 64), 120,
  'succeeded', 1, 3, 1
);

insert into public.zagulyaky_ingestion_structured_candidates(
  id, run_id, task_id, item_id, source_item_index, parser_version,
  input_fingerprint, candidate_key, kind, confidence, status, candidate_data,
  evidence_spans, warnings
) values (
  'b1000000-0000-4000-8000-000000000001',
  'af000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'ae000000-0000-4000-8000-000000000001', 0, 'pgtap-initial-base-v2',
  repeat('c', 64), repeat('d', 64), 'person', 0.910, 'proposed',
  $$
  {
    "kind": "person",
    "title": "Сергій Карповь Онищенко",
    "classificationReason": "Учасник шлюбного запису",
    "possibleLivingPerson": false,
    "event": {
      "type": "marriage",
      "dateText": "27 января 1908 года",
      "yearFrom": 1908,
      "yearTo": 1908,
      "placeText": "Олексіївська церква, с. Хороше Павлоградського повіту"
    },
    "participants": [
      {
        "structuralRole": "subject",
        "eventRoleCode": "groom",
        "originalFullName": "Сергей Карповь Онищенко",
        "normalizedUkFullName": "Сергій Карпович Онищенко",
        "surname": "Онищенко",
        "givenName": "Сергій",
        "patronymic": "Карпович",
        "sex": "male",
        "originText": "Полтавской губерн. Кобелякского уезда Кишенской волости",
        "residenceText": "с. Хороше Павлоградського повіту",
        "socialEstateText": "казакь",
        "sortOrder": 0
      }
    ]
  }
  $$::jsonb,
  '[{"scope":"candidate","start":0,"end":7}]'::jsonb,
  '["Needs manual review"]'::jsonb
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000002","role":"authenticated","email":"initial-base-non-reviewer@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_get_zagulyaky_ingestion_item_v1(
      'ad000000-0000-4000-8000-000000000001'::uuid,
      'ae000000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  '42501',
  'ADMIN_PERMISSION_REQUIRED',
  'a signed-in user without zagulyaky.import cannot open a private source card'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"ac000000-0000-4000-8000-000000000001","role":"authenticated","email":"initial-base-reviewer@example.test"}',
  true
);

select is(
  (
    public.admin_list_zagulyaky_ingestion_items_v1(
      'ad000000-0000-4000-8000-000000000001'::uuid,
      'Кобелякского', null, null, null, 25, 0
    ) ->> 'total'
  )::integer,
  1,
  'the protected list finds an item by the allowlisted participant origin text'
);
select is(
  (
    public.admin_list_zagulyaky_ingestion_items_v1(
      'ad000000-0000-4000-8000-000000000001'::uuid,
      'казакь', null, null, null, 25, 0
    ) ->> 'total'
  )::integer,
  1,
  'the protected list finds an item by the allowlisted participant estate text'
);

create temporary table pgtap_initial_base_list as
select public.admin_list_zagulyaky_ingestion_items_v1(
  'ad000000-0000-4000-8000-000000000001'::uuid,
  'Онищенко', null, null, null, 25, 0
) as result;

select ok(
  (select (result -> 'items' -> 0 ->> 'structuredCandidateCount')::integer from pgtap_initial_base_list) = 1
  and (select (result -> 'items' -> 0 ->> 'structuredPersonCount')::integer from pgtap_initial_base_list) = 1
  and (select (result -> 'items' -> 0 ->> 'structuredDocumentCount')::integer from pgtap_initial_base_list) = 0
  and not ((select result -> 'items' -> 0 from pgtap_initial_base_list) ? 'facebookPostUrl')
  and not ((select result -> 'items' -> 0 from pgtap_initial_base_list) ? 'rawText')
  and not ((select result -> 'items' -> 0 from pgtap_initial_base_list) ? 'candidateData'),
  'the list exposes only structured counts, not Facebook URLs, raw text, or full candidate data'
);

create temporary table pgtap_initial_base_detail as
select public.admin_get_zagulyaky_ingestion_item_v1(
  'ad000000-0000-4000-8000-000000000001'::uuid,
  'ae000000-0000-4000-8000-000000000001'::uuid
) as result;

select ok(
  (select result -> 'item' -> 'source' ->> 'facebookPostUrl' from pgtap_initial_base_detail)
    = 'https://www.facebook.com/groups/example/posts/pgtap-initial-base-good'
  and (select result -> 'item' -> 'content' ->> 'rawText' from pgtap_initial_base_detail)
    = '27 января 1908 года БРАК: Полтавской губерн. Кобелякского уезда Кишенской волости казакь Сергей Карповь Онищенко.',
  'an authorized selected source card preserves its original text and a host-validated Facebook post URL'
);
select ok(
  (select result -> 'structuredCandidates' -> 0 -> 'participants' -> 0 ->> 'originText' from pgtap_initial_base_detail)
    = 'Полтавской губерн. Кобелякского уезда Кишенской волости'
  and (select result -> 'structuredCandidates' -> 0 -> 'participants' -> 0 ->> 'residenceText' from pgtap_initial_base_detail)
    = 'с. Хороше Павлоградського повіту'
  and (select result -> 'structuredCandidates' -> 0 -> 'participants' -> 0 ->> 'socialEstateText' from pgtap_initial_base_detail)
    = 'казакь',
  'selected source-card detail returns the safe structured participant fields for review'
);
select ok(
  not ((select result -> 'structuredCandidates' -> 0 from pgtap_initial_base_detail) ? 'evidenceSpans')
  and not ((select result -> 'structuredCandidates' -> 0 from pgtap_initial_base_detail) ? 'inputFingerprint')
  and (select result::text not like '%"scope": "candidate"%' from pgtap_initial_base_detail),
  'source-card candidate detail omits private evidence spans and worker fingerprints'
);
select is(
  (
    public.admin_get_zagulyaky_ingestion_item_v1(
      'ad000000-0000-4000-8000-000000000001'::uuid,
      'ae000000-0000-4000-8000-000000000002'::uuid
    ) -> 'item' -> 'source' ->> 'facebookPostUrl'
  ),
  null::text,
  'a look-alike non-Facebook hostname is not returned as the explicit Facebook post URL'
);

reset role;

select ok(
  exists (
    select 1
    from public.admin_audit_log audit
    where audit.admin_actor_id = 'ac000000-0000-4000-8000-000000000001'
      and audit.action_code = 'zagulyaky.ingestion_item.view'
      and audit.target_id = 'ae000000-0000-4000-8000-000000000001'
      and audit.sanitized_diff ?& array[
        'batchId', 'sourceItemIndex', 'rawTextCharactersReturned',
        'attachmentCount', 'linkCount', 'jobCount', 'recordLinkCount',
        'structuredCandidateCount'
      ]
      and audit.sanitized_diff::text not like '%Кобелякского%'
      and audit.sanitized_diff::text not like '%facebook.com%'
  ),
  'opening a source card audits only counters and never copies private post content or URL'
);

select * from finish();
rollback;
