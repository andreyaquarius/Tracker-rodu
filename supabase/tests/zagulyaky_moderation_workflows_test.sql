begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(20);

select has_function('public', 'admin_get_zagulyaka_review_bundle_v1', array['uuid', 'integer', 'integer'], 'moderator review bundle facade exists');
select has_function('public', 'admin_list_zagulyaky_duplicate_candidates_v1', array['uuid', 'text', 'integer', 'integer'], 'duplicate queue facade exists');
select has_function('public', 'admin_create_zagulyaka_duplicate_candidate_v1', array['uuid', 'uuid', 'numeric', 'jsonb'], 'duplicate candidate creation facade exists');
select has_function('public', 'admin_resolve_zagulyaka_duplicate_candidate_v1', array['uuid', 'uuid', 'text', 'text'], 'duplicate decision facade exists');
select has_function('public', 'admin_merge_zagulyaka_duplicate_v1', array['uuid', 'uuid', 'integer', 'integer', 'text'], 'duplicate merge facade exists');
select has_function('public', 'admin_resolve_zagulyaka_claim_v2', array['uuid', 'text', 'text', 'text'], 'claim v2 facade exists');

select ok(
  not exists (
    select 1
    from unnest(array[
      'public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)',
      'public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)',
      'public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)',
      'public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)',
      'public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)',
      'public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)'
    ]) signature
    join pg_proc function_record on function_record.oid = to_regprocedure(signature)
    where function_record.prosecdef
  ),
  'public moderator facades are security invoker'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)',
      'security_private.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)',
      'security_private.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)',
      'security_private.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)',
      'security_private.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)',
      'security_private.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)'
    ]) signature
    join pg_proc function_record on function_record.oid = to_regprocedure(signature)
    where not function_record.prosecdef
  ),
  'private moderator implementations are security definer'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)',
      'public.admin_list_zagulyaky_duplicate_candidates_v1(uuid,text,integer,integer)',
      'public.admin_create_zagulyaka_duplicate_candidate_v1(uuid,uuid,numeric,jsonb)',
      'public.admin_resolve_zagulyaka_duplicate_candidate_v1(uuid,uuid,text,text)',
      'public.admin_merge_zagulyaka_duplicate_v1(uuid,uuid,integer,integer,text)',
      'public.admin_resolve_zagulyaka_claim_v2(uuid,text,text,text)'
    ]) signature
    where has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')
  ),
  'anonymous callers cannot execute moderator workflows'
);

select ok(
  not exists (
    select 1
    -- Checking concrete API roles also detects a PUBLIC grant, because it is
    -- inherited by every role.  PUBLIC itself is not a PostgreSQL role name.
    from unnest(array['anon', 'authenticated', 'service_role']) as roles(role_name)
    where has_function_privilege(
      role_name,
      to_regprocedure('public.admin_resolve_zagulyaka_claim_v1(uuid,text,text)'),
      'EXECUTE'
    )
  ),
  'deprecated v1 claim resolver cannot bypass the v2 closed-claim workflow'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '8a000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'zagulyaky-author@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '8a000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'zagulyaky-moderator@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('8a000000-0000-0000-0000-000000000001', 'zagulyaky-author@example.test', 'Zagulyaky Author'),
  ('8a000000-0000-0000-0000-000000000002', 'zagulyaky-moderator@example.test', 'Zagulyaky Moderator')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.app_admins (user_id, granted_by)
values ('8a000000-0000-0000-0000-000000000002', '8a000000-0000-0000-0000-000000000002')
on conflict (user_id) do nothing;

insert into public.admin_role_assignments (user_id, role_code, assigned_by)
values ('8a000000-0000-0000-0000-000000000002', 'content_admin', '8a000000-0000-0000-0000-000000000002')
on conflict (user_id, role_code) do nothing;

create temporary table zagulyaky_moderation_workflow_state (
  first_record_id uuid,
  second_record_id uuid,
  first_lock_version integer,
  second_lock_version integer,
  claim_id uuid
) on commit drop;

grant select, insert, update, delete on zagulyaky_moderation_workflow_state to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"8a000000-0000-0000-0000-000000000001","role":"authenticated","email":"zagulyaky-author@example.test"}',
  true
);

insert into zagulyaky_moderation_workflow_state(first_record_id, first_lock_version)
select (created.payload ->> 'id')::uuid, (created.payload ->> 'lock_version')::integer
from (
  select public.create_zagulyaka_draft_v1(
    'document',
    jsonb_build_object(
      'title', 'Тестовий документ A',
      'classificationReason', 'Неочікуване місце зберігання',
      'submissionTermsVersion', 1,
      'rightsConfirmed', true
    )
  ) as payload
) created;

update zagulyaky_moderation_workflow_state state
set first_lock_version = (
  public.replace_my_zagulyaka_details_v1(
    state.first_record_id,
    state.first_lock_version,
    jsonb_build_array(jsonb_build_object('sourceType', 'archive', 'title', 'Тестове джерело A', 'citation', 'A-1')),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('officialLocationText', 'Офіційне місце A', 'discoveredLocationText', 'Знайдено A'))
  ) -> 'record' ->> 'lock_version'
)::integer;

select throws_ok(
  format(
    'select public.submit_zagulyaka_v1(%L::uuid, null)',
    (select first_record_id from zagulyaky_moderation_workflow_state)
  ),
  '40001',
  'ZAGULYAKA_VERSION_CONFLICT',
  'submission rejects a missing optimistic lock version'
);

update zagulyaky_moderation_workflow_state state
set first_lock_version = (
  public.submit_zagulyaka_v1(state.first_record_id, state.first_lock_version) ->> 'lock_version'
)::integer;

update zagulyaky_moderation_workflow_state state
set (second_record_id, second_lock_version) = (
  select (created.payload ->> 'id')::uuid, (created.payload ->> 'lock_version')::integer
  from (
    select public.create_zagulyaka_draft_v1(
      'document',
      jsonb_build_object(
        'title', 'Тестовий документ B',
        'classificationReason', 'Неочікуване місце зберігання',
        'submissionTermsVersion', 1,
        'rightsConfirmed', true
      )
    ) as payload
  ) created
);

update zagulyaky_moderation_workflow_state state
set second_lock_version = (
  public.replace_my_zagulyaka_details_v1(
    state.second_record_id,
    state.second_lock_version,
    jsonb_build_array(jsonb_build_object('sourceType', 'archive', 'title', 'Тестове джерело B', 'citation', 'B-1')),
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('officialLocationText', 'Офіційне місце B', 'discoveredLocationText', 'Знайдено B'))
  ) -> 'record' ->> 'lock_version'
)::integer;

update zagulyaky_moderation_workflow_state state
set second_lock_version = (
  public.submit_zagulyaka_v1(state.second_record_id, state.second_lock_version) ->> 'lock_version'
)::integer;

select throws_ok(
  $$select public.admin_list_zagulyaky_duplicate_candidates_v1(null, 'pending', 25, 0)$$,
  '42501',
  'ADMIN_PERMISSION_REQUIRED',
  'an ordinary author cannot inspect duplicate candidates'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"8a000000-0000-0000-0000-000000000002","role":"authenticated","email":"zagulyaky-moderator@example.test"}',
  true
);

update zagulyaky_moderation_workflow_state state
set first_lock_version = (
  public.admin_review_zagulyaka_v1(
    state.first_record_id,
    state.first_lock_version,
    'publish',
    'Тестова публікація',
    'plausible',
    'cleared',
    'test-document-a'
  ) ->> 'lock_version'
)::integer;

select set_config(
  'request.jwt.claims',
  '{"sub":"8a000000-0000-0000-0000-000000000001","role":"authenticated","email":"zagulyaky-author@example.test"}',
  true
);

update zagulyaky_moderation_workflow_state state
set claim_id = (
  public.create_zagulyaka_claim_v1(state.first_record_id, 'privacy', 'Тестове звернення щодо приватності') ->> 'id'
)::uuid;

select set_config(
  'request.jwt.claims',
  '{"sub":"8a000000-0000-0000-0000-000000000002","role":"authenticated","email":"zagulyaky-moderator@example.test"}',
  true
);

select public.admin_create_zagulyaka_duplicate_candidate_v1(
  (select first_record_id from zagulyaky_moderation_workflow_state),
  (select second_record_id from zagulyaky_moderation_workflow_state),
  0.9200,
  '["same archival collection", "same date range"]'::jsonb
);

select is(
  jsonb_array_length(
    public.admin_list_zagulyaky_duplicate_candidates_v1(
      (select first_record_id from zagulyaky_moderation_workflow_state), 'pending', 25, 0
    ) -> 'items'
  ),
  1,
  'moderator sees the created pending duplicate candidate'
);

select is(
  public.admin_resolve_zagulyaka_duplicate_candidate_v1(
    (select first_record_id from zagulyaky_moderation_workflow_state),
    (select second_record_id from zagulyaky_moderation_workflow_state),
    'confirmed',
    'Тестове підтвердження дубліката'
  ) ->> 'status',
  'confirmed',
  'moderator explicitly confirms the duplicate pair'
);

select throws_ok(
  format(
    'select public.admin_merge_zagulyaka_duplicate_v1(%L::uuid, %L::uuid, %s, %s, %L)',
    (select first_record_id from zagulyaky_moderation_workflow_state),
    (select second_record_id from zagulyaky_moderation_workflow_state),
    (select first_lock_version from zagulyaky_moderation_workflow_state),
    (select second_lock_version from zagulyaky_moderation_workflow_state),
    'Не можна об’єднувати за відкритої скарги'
  ),
  '55000',
  'OPEN_ZAGULYAKA_CLAIM_BLOCKS_MERGE',
  'an open claim blocks duplicate merge until it is resolved'
);

update zagulyaky_moderation_workflow_state state
set first_lock_version = (
  public.admin_resolve_zagulyaka_claim_v2(
    state.claim_id,
    'resolved',
    'Тестове блокування приватності',
    'privacy_block'
  ) -> 'record' ->> 'lock_version'
)::integer;

select is(
  (
    public.admin_get_zagulyaka_review_bundle_v1(
      (select first_record_id from zagulyaky_moderation_workflow_state), 40, 80
    ) -> 'record' ->> 'privacy_status'
  ),
  'blocked',
  'privacy claim can atomically hide the published record'
);

select is(
  public.admin_merge_zagulyaka_duplicate_v1(
    (select first_record_id from zagulyaky_moderation_workflow_state),
    (select second_record_id from zagulyaky_moderation_workflow_state),
    (select first_lock_version from zagulyaky_moderation_workflow_state),
    (select second_lock_version from zagulyaky_moderation_workflow_state),
    'Тестове об’єднання підтверджених дублів'
  ) -> 'merged' ->> 'status',
  'merged',
  'confirmed duplicate can be merged with optimistic locks'
);

select ok(
  jsonb_array_length(
    public.admin_get_zagulyaka_review_bundle_v1(
      (select first_record_id from zagulyaky_moderation_workflow_state), 40, 80
    ) -> 'versions'
  ) >= 1,
  'review bundle includes immutable versions'
);

select ok(
  jsonb_array_length(
    public.admin_get_zagulyaka_review_bundle_v1(
      (select first_record_id from zagulyaky_moderation_workflow_state), 40, 80
    ) -> 'moderationActions'
  ) >= 4,
  'review bundle includes moderation and duplicate audit history'
);

select ok(
  jsonb_array_length(
    public.admin_get_zagulyaka_review_bundle_v1(
      (select first_record_id from zagulyaky_moderation_workflow_state), 40, 80
    ) -> 'adminAudit'
  ) >= 1,
  'review bundle includes sanitized administrator audit entries'
);

reset role;
select * from finish();
rollback;
