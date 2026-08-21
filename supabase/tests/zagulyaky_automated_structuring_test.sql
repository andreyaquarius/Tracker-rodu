begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(36);

select has_table(
  'public', 'zagulyaky_structuring_runs',
  'automated structuring has a durable private run table'
);
select has_table(
  'public', 'zagulyaky_structuring_tasks',
  'automated structuring has a leaseable task table'
);
select has_table(
  'public', 'zagulyaky_ingestion_structured_candidates',
  'one ingestion item can persist zero or more private candidates'
);
select has_function(
  'public', 'admin_start_zagulyaky_structuring_run_v1',
  array['uuid','text','text','text','boolean','text','integer','integer'],
  'admin start RPC has an explicit bounded pilot contract'
);
select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_ingestion_structured_candidates', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zagulyaky_structuring_tasks', 'SELECT'),
  'browser roles have no direct access to task or candidate tables'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.admin_start_zagulyaky_structuring_run_v1(uuid,text,text,text,boolean,text,integer,integer)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.service_claim_zagulyaky_structuring_task_v1(uuid,text,integer)'::regprocedure,
    'EXECUTE'
  ),
  'anonymous callers cannot start and authenticated browser callers cannot claim service tasks'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '9a000000-0000-0000-0000-000000000009',
    'authenticated', 'authenticated', 'structuring-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '9b000000-0000-0000-0000-000000000009',
    'authenticated', 'authenticated', 'structuring-non-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  )
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

insert into public.profiles(user_id, email, display_name) values
  ('9a000000-0000-0000-0000-000000000009', 'structuring-admin@example.test', 'Structuring Admin'),
  ('9b000000-0000-0000-0000-000000000009', 'structuring-non-admin@example.test', 'Structuring Non Admin')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins(user_id, granted_by) values
  ('9a000000-0000-0000-0000-000000000009', '9a000000-0000-0000-0000-000000000009')
on conflict (user_id) do nothing;
insert into public.admin_role_assignments(user_id, role_code, assigned_by) values
  ('9a000000-0000-0000-0000-000000000009', 'content_admin', '9a000000-0000-0000-0000-000000000009')
on conflict (user_id, role_code) do nothing;

insert into public.zagulyaky_ingestion_batches(
  id, source_file_name, source_checksum, expected_item_count, import_mode, status,
  requested_by, processed_item_count, staged_item_count, quarantined_item_count, completed_at
) values (
  '91000000-0000-4000-8000-000000000009',
  'pgtap-automated-structuring.json', repeat('9', 64), 5, 'commit', 'completed',
  '9a000000-0000-0000-0000-000000000009', 5, 5, 1, now()
);

insert into public.zagulyaky_ingestion_items(
  id, source_platform, external_id, idempotency_key, first_seen_batch_id, last_seen_batch_id,
  raw_text, raw_payload, declared_attachment_count, rights_review_required, stage_status,
  requires_ocr, quarantined
) values
  (
    '92000000-0000-4000-8000-000000000009', 'facebook_group_json', 'pgtap-structure-alpha',
    'facebook_group_post:pgtap-structure-alpha', '91000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000009',
    'Іван Петренко, наречений. Шлюб 1901 року.',
    '{"years":["1901","1902","not-a-year"]}'::jsonb, 0, true, 'staged', false, false
  ),
  (
    '92000000-0000-4000-8000-000000000010', 'facebook_group_json', 'pgtap-structure-ocr',
    'facebook_group_post:pgtap-structure-ocr', '91000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000009',
    'OCR-only fixture.', '{}'::jsonb, 1, true, 'staged', true, false
  ),
  (
    '92000000-0000-4000-8000-000000000011', 'facebook_group_json', 'pgtap-structure-quarantine',
    'facebook_group_post:pgtap-structure-quarantine', '91000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000009',
    'Quarantined fixture.', '{}'::jsonb, 0, true, 'quarantined', false, true
  ),
  (
    '92000000-0000-4000-8000-000000000012', 'facebook_group_json', 'pgtap-structure-delta',
    'facebook_group_post:pgtap-structure-delta', '91000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000009',
    'Марія Коваль, свідок у шлюбі.', '{}'::jsonb, 0, true, 'staged', false, false
  ),
  (
    '92000000-0000-4000-8000-000000000013', 'facebook_group_json', 'pgtap-structure-oversized',
    'facebook_group_post:pgtap-structure-oversized', '91000000-0000-4000-8000-000000000009',
    '91000000-0000-4000-8000-000000000009',
    repeat('x', 12001), '{}'::jsonb, 0, true, 'staged', false, false
  );

insert into public.zagulyaky_ingestion_batch_items(batch_id, item_id, source_item_index) values
  ('91000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000009', 0),
  ('91000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000010', 1),
  ('91000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000011', 2),
  ('91000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000012', 3),
  ('91000000-0000-4000-8000-000000000009', '92000000-0000-4000-8000-000000000013', 4);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9b000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-non-admin@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_start_zagulyaky_structuring_run_v1(
      '91000000-0000-4000-8000-000000000009'::uuid, 'pgtap-v1', 'gemini', 'test-model', true, 'v1', 1, 3
    )
  $$,
  '42501', 'ADMIN_PERMISSION_REQUIRED',
  'a signed-in user without zagulyaky.import cannot start a run'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"9a000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-admin@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_start_zagulyaky_structuring_run_v1(
      '91000000-0000-4000-8000-000000000009'::uuid, 'pgtap-v1', 'gemini', 'test-model', false, 'v1', 1, 3
    )
  $$,
  '42501', 'STRUCTURING_CONSENT_REQUIRED',
  'an import admin must explicitly consent for each run-start request'
);

create temporary table pgtap_structuring_start as
select public.admin_start_zagulyaky_structuring_run_v1(
  '91000000-0000-4000-8000-000000000009'::uuid, 'pgtap-v1', 'gemini', 'test-model', true, 'v1', 1, 3
) as result;
grant select on pgtap_structuring_start to service_role;

select is(
  (select result ->> 'status' from pgtap_structuring_start), 'queued',
  'explicit consent starts a queued private pilot'
);
select ok(
  (select (result ->> 'explicitConsent')::boolean from pgtap_structuring_start)
  and (select (result ->> 'eligibleItemCount')::integer from pgtap_structuring_start) = 2
  and (select (result ->> 'selectedItemCount')::integer from pgtap_structuring_start) = 1
  and (select (result ->> 'excludedOcrCount')::integer from pgtap_structuring_start) = 1
  and (select (result ->> 'excludedQuarantinedCount')::integer from pgtap_structuring_start) = 1
  and (select (result ->> 'excludedOversizedCount')::integer from pgtap_structuring_start) = 1,
  'selection is bounded and reports OCR, quarantine, and worker-size exclusions'
);
select is(
  (select (result ->> 'queuedCount')::integer from pgtap_structuring_start),
  1,
  'the pilot exposes one queued task without exposing its private table'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table pgtap_structuring_claim as
select public.service_claim_zagulyaky_structuring_task_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start), 'pgtap-worker', 120
) as result;

select ok(
  (select result -> 'task' ->> 'taskId' from pgtap_structuring_claim) is not null
  and (select result -> 'task' ->> 'sourceItemIndex' from pgtap_structuring_claim) = '0',
  'service role atomically claims the deterministic first eligible task'
);

create temporary table pgtap_structuring_input as
select public.service_get_zagulyaky_structuring_task_input_v1(
  (select (result -> 'task' ->> 'taskId')::uuid from pgtap_structuring_claim),
  (select (result -> 'task' ->> 'claimToken')::uuid from pgtap_structuring_claim)
) as result;

select ok(
  (select result ->> 'rawText' from pgtap_structuring_input) = 'Іван Петренко, наречений. Шлюб 1901 року.'
  and (select result ->> 'provider' from pgtap_structuring_input) = 'gemini'
  and (select result ->> 'model' from pgtap_structuring_input) = 'test-model'
  and (select result ->> 'requestedBy' from pgtap_structuring_input) = '9a000000-0000-0000-0000-000000000009'
  and (select result ->> 'claimToken' from pgtap_structuring_input) =
    (select result -> 'task' ->> 'claimToken' from pgtap_structuring_claim),
  'only the service input contract carries text and the required safe worker configuration'
);

create temporary table pgtap_structuring_complete as
select public.service_complete_zagulyaky_structuring_task_v1(
  (select (result -> 'task' ->> 'taskId')::uuid from pgtap_structuring_claim),
  (select (result -> 'task' ->> 'claimToken')::uuid from pgtap_structuring_claim),
  (select result ->> 'inputFingerprint' from pgtap_structuring_input),
  jsonb_build_array(
    jsonb_build_object(
      'kind', 'person', 'confidence', 0.91, 'title', 'Іван Петренко',
      'classificationReason', 'Згаданий як наречений', 'possibleLivingPerson', true,
      'event', jsonb_build_object('type', 'marriage', 'dateText', '1901', 'yearFrom', 1901, 'yearTo', 1901, 'placeText', 'Війтівка'),
      'participants', jsonb_build_array(jsonb_build_object(
        'structuralRole', 'subject', 'eventRoleCode', 'groom',
        'originalFullName', 'Іван Петренко', 'normalizedUkFullName', 'Іван Петренко',
        'surname', 'Петренко', 'givenName', 'Іван', 'sex', 'male',
        'evidence', jsonb_build_array(jsonb_build_object(
          'start', 0, 'end', char_length('Іван Петренко'), 'excerpt', 'Іван Петренко'
        ))
      )),
      'documentDiscovery', null, 'evidence', '[]'::jsonb,
      'warnings', jsonb_build_array('Потрібна перевірка модератором')
    ),
    jsonb_build_object(
      'kind', 'document', 'confidence', 0.72, 'title', 'Метричний запис про шлюб',
      'classificationReason', 'Ймовірний опис документального джерела', 'possibleLivingPerson', false,
      'event', jsonb_build_object('type', 'marriage', 'yearFrom', 1901, 'yearTo', 1901, 'placeText', 'Війтівка'),
      'participants', '[]'::jsonb,
      'documentDiscovery', jsonb_build_object(
        'officialLocationText', 'Державний архів', 'discoveredLocationText', 'Метрична книга',
        'recordTypes', jsonb_build_array('метрична книга'), 'yearFrom', 1901, 'yearTo', 1901,
        'pageFrom', '12', 'pageTo', '12'
      ),
      'evidence', '[]'::jsonb, 'warnings', '[]'::jsonb
    )
  ),
  jsonb_build_object(
    'provider', 'gemini', 'model', 'test-model', 'keySource', 'environment',
    'inputChars', char_length('Іван Петренко, наречений. Шлюб 1901 року.'),
    'candidateCount', 2, 'personCandidateCount', 1, 'documentCandidateCount', 1,
    'evidenceCount', 1, 'warningCount', 1
  )
) as result;

select is(
  (select (result ->> 'candidateCount')::integer from pgtap_structuring_complete), 2,
  'one post can complete with a person and a document candidate'
);
select ok(
  exists (
    select 1 from public.zagulyaky_structuring_tasks task_row
    where task_row.id = (select (result -> 'task' ->> 'taskId')::uuid from pgtap_structuring_claim)
      and task_row.result_summary ->> 'provider' = 'gemini'
      and task_row.result_summary ->> 'keySource' = 'environment'
      and task_row.result_summary::text not like '%Іван Петренко, наречений. Шлюб 1901 року%'
  ),
  'worker result summary preserves only allowlisted operational fields, never post text'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9a000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-admin@example.test"}',
  true
);

create temporary table pgtap_structuring_run as
select public.admin_get_zagulyaky_structuring_run_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start)
) as result;

select ok(
  (select (result ->> 'personCandidateCount')::integer from pgtap_structuring_run) = 1
  and (select (result ->> 'documentCandidateCount')::integer from pgtap_structuring_run) = 1
  and (select (result ->> 'explicitConsent')::boolean from pgtap_structuring_run),
  'safe run summary exposes consent and separate person/document candidate counters'
);
select is(
  (select result ->> 'status' from pgtap_structuring_run), 'completed',
  'a completed structure task settles the private run before any materialization'
);

create temporary table pgtap_structuring_candidates as
select public.admin_list_zagulyaky_structuring_candidates_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start), null, null, null, 1, 0
) as result;

select ok(
  (select (result ->> 'total')::integer from pgtap_structuring_candidates) = 2
  and (select result -> 'items' -> 0 ? 'candidateData' from pgtap_structuring_candidates) = false
  and (select result::text not like '%Шлюб 1901 року%' from pgtap_structuring_candidates),
  'candidate list uses the full filtered total and never returns raw source text or full candidate payload'
);
select ok(
  (select result -> 'items' -> 0 ? 'classificationReason' from pgtap_structuring_candidates)
  and (select result -> 'items' -> 0 ? 'event' from pgtap_structuring_candidates)
  and (select result -> 'items' -> 0 ? 'participantCount' from pgtap_structuring_candidates),
  'candidate list includes safe review fields without evidence excerpts'
);

create temporary table pgtap_structuring_candidate_detail as
select public.admin_get_zagulyaky_structuring_candidate_v1(
  (select (result -> 'items' -> 0 ->> 'candidateId')::uuid from pgtap_structuring_candidates)
) as result;

select ok(
  not coalesce((select result -> 'evidenceSpans' -> 0 ? 'excerpt' from pgtap_structuring_candidate_detail), false)
  and (select result::text not like '%Шлюб 1901 року%' from pgtap_structuring_candidate_detail),
  'candidate detail retains checked offsets but discards evidence excerpts and raw post text'
);
reset role;
select is(
  (select count(*) from public.zagulyaky_records where payload -> 'automatedStructuring' ->> 'runId' = (select result ->> 'runId' from pgtap_structuring_start)),
  0::bigint,
  'completion alone never creates a catalogue record'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9a000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-admin@example.test"}',
  true
);

create temporary table pgtap_structuring_materialize as
select public.admin_materialize_zagulyaky_structuring_candidates_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start), 100
) as result;

select ok(
  (select (result ->> 'attemptedCount')::integer from pgtap_structuring_materialize) = 2
  and (select (result ->> 'materializedCount')::integer from pgtap_structuring_materialize) = 2
  and (select (result ->> 'remainingCount')::integer from pgtap_structuring_materialize) = 0
  and not (select result ? 'recordIds' from pgtap_structuring_materialize),
  'materialization reports safe counts and does not return record identifiers'
);
reset role;
select ok(
  (select count(*) from public.zagulyaky_records where payload -> 'automatedStructuring' ->> 'runId' = (select result ->> 'runId' from pgtap_structuring_start)
    and status = 'draft' and verification_status = 'unverified' and public_slug is null) = 2
  and (select count(*) from public.zagulyaky_records where payload -> 'automatedStructuring' ->> 'runId' = (select result ->> 'runId' from pgtap_structuring_start)
    and possible_living_person and privacy_status = 'requires_consent') = 1,
  'materialization creates only private unverified drafts and conservatively marks the living-person signal'
);
select ok(
  (select count(*) from public.zagulyaky_ingestion_item_records map
    join public.zagulyaky_records record_row on record_row.id = map.record_id
    where map.item_id = '92000000-0000-4000-8000-000000000009'
      and map.relationship_kind = 'derived'
      and record_row.payload -> 'automatedStructuring' ->> 'runId' = (select result ->> 'runId' from pgtap_structuring_start)) = 2
  and (select count(*) from public.zagulyaky_record_sources record_source
    join public.zagulyaky_records record_row on record_row.id = record_source.record_id
    where record_row.payload -> 'automatedStructuring' ->> 'runId' = (select result ->> 'runId' from pgtap_structuring_start)) = 0,
  'each materialized draft has a derived private provenance link and no automatic source URL'
);
select is(
  (select count(*) from public.zagulyaky_attachments attachment
    join public.zagulyaky_records record_row on record_row.id = attachment.record_id
    where record_row.payload -> 'automatedStructuring' ->> 'runId' = (select result ->> 'runId' from pgtap_structuring_start)),
  0::bigint,
  'materialization never creates an attachment or public media derivative'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9a000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-admin@example.test"}',
  true
);

select is(
  (public.admin_materialize_zagulyaky_structuring_candidates_v1(
    (select (result ->> 'runId')::uuid from pgtap_structuring_start), 100
  ) ->> 'attemptedCount')::integer,
  0,
  'repeating materialization is idempotent after every proposed candidate is materialized'
);
reset role;
select is(
  security_private.zagulyaky_import_candidate_years_v1(
    '{"candidateYears":[],"rawPayload":{"years":["1901","1902","bad"]}}'::jsonb
  ),
  array[1901,1902]::integer[],
  'candidate-year repair falls back to raw export year strings without inventing a fact'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9a000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-admin@example.test"}',
  true
);

create temporary table pgtap_structuring_expand as
select public.admin_start_zagulyaky_structuring_run_v1(
  '91000000-0000-4000-8000-000000000009'::uuid, 'pgtap-v1', 'gemini', 'test-model', true, 'v1', 2, 3
) as result;

select is(
  (select (result ->> 'selectedItemCount')::integer from pgtap_structuring_expand), 2,
  'expanding the same idempotent run queues the deterministic second eligible item'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table pgtap_structuring_retry_claim as
select public.service_claim_zagulyaky_structuring_task_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start), 'pgtap-worker', 120
) as result;

select is(
  (select result -> 'task' ->> 'sourceItemIndex' from pgtap_structuring_retry_claim), '3',
  'claim skips OCR, quarantine, and oversized items when reaching the next queue item'
);
select is(
  public.service_fail_zagulyaky_structuring_task_v1(
    (select (result -> 'task' ->> 'taskId')::uuid from pgtap_structuring_retry_claim),
    (select (result -> 'task' ->> 'claimToken')::uuid from pgtap_structuring_retry_claim),
    'MODEL_TRANSIENT_FAILURE', true
  ) ->> 'status',
  'retry',
  'service failure moves a claimed task into a bounded retry state'
);

reset role;

-- The service contract deliberately applies a short retry backoff.  This
-- fixture exercises the later terminal/recovery branch in the same rollback
-- only, so make its already-created retry task claimable without waiting.
update public.zagulyaky_structuring_tasks
set next_attempt_at = now()
where id = (select (result -> 'task' ->> 'taskId')::uuid from pgtap_structuring_retry_claim)
  and status = 'retry';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table pgtap_structuring_failed_claim as
select public.service_claim_zagulyaky_structuring_task_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start), 'pgtap-worker', 120
) as result;

select is(
  public.service_fail_zagulyaky_structuring_task_v1(
    (select (result -> 'task' ->> 'taskId')::uuid from pgtap_structuring_failed_claim),
    (select (result -> 'task' ->> 'claimToken')::uuid from pgtap_structuring_failed_claim),
    'STRUCTURE_GEMINI_AUTH_FAILED', false
  ) ->> 'status',
  'failed',
  'a non-retryable provider configuration failure becomes terminal until an explicit recovery'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"9b000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-non-admin@example.test"}',
  true
);

select throws_ok(
  $$
    select public.admin_retry_zagulyaky_structuring_failed_tasks_v1(
      (select (result ->> 'runId')::uuid from pgtap_structuring_start), 1, true
    )
  $$,
  '42501', 'ADMIN_PERMISSION_REQUIRED',
  'a non-admin cannot requeue a failed private structuring task'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"9a000000-0000-0000-0000-000000000009","role":"authenticated","email":"structuring-admin@example.test"}',
  true
);

select is(
  public.admin_get_zagulyaky_structuring_run_v1(
    (select (result ->> 'runId')::uuid from pgtap_structuring_start)
  ) ->> 'lastErrorCode',
  'STRUCTURE_GEMINI_AUTH_FAILED',
  'the private run projection reports the latest safe terminal task error'
);

select throws_ok(
  $$
    select public.admin_retry_zagulyaky_structuring_failed_tasks_v1(
      (select (result ->> 'runId')::uuid from pgtap_structuring_start), 1, false
    )
  $$,
  '42501', 'STRUCTURING_RETRY_CONFIRMATION_REQUIRED',
  'recovery requires a fresh explicit administrator confirmation'
);

create temporary table pgtap_structuring_recovery as
select public.admin_retry_zagulyaky_structuring_failed_tasks_v1(
  (select (result ->> 'runId')::uuid from pgtap_structuring_start), 1, true
) as result;

select ok(
  (select (result ->> 'requeuedCount')::integer from pgtap_structuring_recovery) = 1
  and (select result -> 'run' ->> 'lastErrorCode' from pgtap_structuring_recovery) is null
  and (select (result -> 'run' ->> 'candidateCount')::integer from pgtap_structuring_recovery) = 2,
  'explicit recovery requeues only the terminal task and preserves existing private candidates'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (public.service_claim_zagulyaky_structuring_task_v1(
    (select (result ->> 'runId')::uuid from pgtap_structuring_start), 'pgtap-worker', 120
  ) -> 'task' ->> 'attemptCount')::integer,
  3,
  'controlled recovery preserves the original attempt and consumes the next bounded attempt'
);

reset role;

select * from finish();
rollback;
