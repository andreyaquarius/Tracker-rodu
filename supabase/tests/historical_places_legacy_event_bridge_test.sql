begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

select ok(
  definition like '%v_candidate record%'
  and definition like '%from legacy_place_candidates resolved_candidate%'
  and definition !~ '(^|[^[:alnum:]_])candidate[.]resolved_place_id',
  'legacy bridge keeps its PL/pgSQL record distinct from the final SQL alias'
)
from (
  select pg_get_functiondef(
    'security_private.bridge_legacy_person_event_places_v1(uuid,boolean,integer)'::regprocedure
  ) as definition
) bridge_function;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'e7100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'legacy-place-bridge@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'e7100000-0000-4000-8000-000000000001',
  'legacy-place-bridge@example.test',
  'Legacy place bridge owner'
)
on conflict (user_id) do update set
  email = excluded.email,
  display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values (
  'e7200000-0000-4000-8000-000000000001',
  'e7100000-0000-4000-8000-000000000001',
  'Legacy place bridge project'
);

insert into public.researches (id, project_id, title, created_by) values (
  'e7300000-0000-4000-8000-000000000001',
  'e7200000-0000-4000-8000-000000000001',
  'Legacy place bridge research',
  'e7100000-0000-4000-8000-000000000001'
);

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, is_living, privacy_status, created_by
) values (
  'e7400000-0000-4000-8000-000000000001',
  'e7200000-0000-4000-8000-000000000001',
  'e7300000-0000-4000-8000-000000000001',
  'proven', 'unknown', 'Мостова', 'Олена', '', 'Мостова Олена',
  false, 'project', 'e7100000-0000-4000-8000-000000000001'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, status,
  verification_status, created_by
) values (
  'e7500000-0000-4000-8000-000000000001',
  'e7200000-0000-4000-8000-000000000001',
  'Трубіївка', 'Трубіївка', 'active', 'unverified',
  'e7100000-0000-4000-8000-000000000001'
);

insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date,
  place_name, place_original_text, place_resolution_status, metadata
) values
(
  'e7600000-0000-4000-8000-000000000001',
  'e7200000-0000-4000-8000-000000000001',
  'e7400000-0000-4000-8000-000000000001',
  'birth', 'Народження', '1862-07-01',
  'Трубіївка', 'въ селѣ Трубіевкѣ', 'unresolved', '{}'::jsonb
),
(
  'e7600000-0000-4000-8000-000000000002',
  'e7200000-0000-4000-8000-000000000001',
  'e7400000-0000-4000-8000-000000000001',
  'residence', 'Місце проживання', '1870',
  'Нова Слобода', null, 'unresolved', '{}'::jsonb
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"e7100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  (
    select row(
      summary ->> 'candidateNames',
      summary ->> 'candidateEvents',
      summary ->> 'existingPlaces',
      summary ->> 'placesToCreate',
      summary ->> 'applied'
    )::text
    from (
      select public.bridge_legacy_person_event_places_v1(
        'e7200000-0000-4000-8000-000000000001', false, 50
      ) as summary
    ) preview
  ),
  row('2', '2', '1', '1', 'false')::text,
  'dry run reports one existing and one new legacy place candidate'
);

select is(
  row(
    (select count(*) from public.person_timeline_events
     where project_id = 'e7200000-0000-4000-8000-000000000001'
       and place_id is not null),
    (select count(*) from public.places
     where project_id = 'e7200000-0000-4000-8000-000000000001'
       and canonical_name = 'Нова Слобода')
  )::text,
  row(0::bigint, 0::bigint)::text,
  'dry run does not link events or create catalogue places'
);

create temporary table _legacy_bridge_apply_result(payload jsonb) on commit drop;

select lives_ok(
  $$insert into _legacy_bridge_apply_result(payload)
    select public.bridge_legacy_person_event_places_v1(
      'e7200000-0000-4000-8000-000000000001', true, 50
    )$$,
  'apply path completes without the candidate.resolved_place_id 42702 error'
);

select is(
  (
    select row(
      payload ->> 'candidateNames', payload ->> 'candidateEvents',
      payload ->> 'existingPlaces', payload ->> 'placesToCreate',
      payload ->> 'ambiguousNames', payload ->> 'createdPlaces',
      payload ->> 'linkedEvents', payload ->> 'remainingNames',
      payload ->> 'applied'
    )::text
    from _legacy_bridge_apply_result
  ),
  row('2', '2', '1', '1', '0', '1', '2', '0', 'true')::text,
  'apply summary reports the completed existing-place and new-place links'
);

select is(
  row(
    (select place_id from public.person_timeline_events
     where id = 'e7600000-0000-4000-8000-000000000001'),
    (select place_row.canonical_name
     from public.person_timeline_events event_row
     join public.places place_row on place_row.id = event_row.place_id
     where event_row.id = 'e7600000-0000-4000-8000-000000000002')
  )::text,
  row(
    'e7500000-0000-4000-8000-000000000001'::uuid,
    'Нова Слобода'
  )::text,
  'apply links both an existing Place and the newly created Place'
);

select is(
  (
    select jsonb_agg(
      jsonb_build_array(
        event_row.place_name,
        event_row.place_original_text,
        event_row.place_resolution_status
      ) order by event_row.id
    )
    from public.person_timeline_events event_row
    where event_row.id in (
      'e7600000-0000-4000-8000-000000000001',
      'e7600000-0000-4000-8000-000000000002'
    )
  ),
  '[
    ["Трубіївка", "въ селѣ Трубіевкѣ", "needs_review"],
    ["Нова Слобода", "Нова Слобода", "needs_review"]
  ]'::jsonb,
  'apply preserves existing source wording and copies missing original wording without changing place_name'
);

select is(
  (
    select row(
      place_row.project_id,
      place_row.status,
      place_row.verification_status,
      place_row.is_public,
      place_row.metadata ->> 'importSource',
      place_row.metadata ->> 'requiresReview',
      type_row.place_type_code
    )::text
    from public.places place_row
    join public.place_type_assignments type_row
      on type_row.place_id = place_row.id and type_row.is_primary
    where place_row.canonical_name = 'Нова Слобода'
      and place_row.project_id = 'e7200000-0000-4000-8000-000000000001'
  ),
  row(
    'e7200000-0000-4000-8000-000000000001'::uuid,
    'needs_review', 'unverified', false,
    'legacy_person_timeline_events', 'true', 'settlement'
  )::text,
  'new legacy Place remains private, review-only, and provenance-marked'
);

create temporary table _legacy_bridge_retry_result(payload jsonb) on commit drop;
insert into _legacy_bridge_retry_result(payload)
select public.bridge_legacy_person_event_places_v1(
  'e7200000-0000-4000-8000-000000000001', true, 50
);

select is(
  (
    select row(
      payload ->> 'candidateNames', payload ->> 'createdPlaces',
      payload ->> 'linkedEvents', payload ->> 'remainingNames'
    )::text
    from _legacy_bridge_retry_result
  ),
  row('0', '0', '0', '0')::text,
  'retry is idempotent after every legacy event has a Place identity'
);

select is(
  row(
    (select count(*) from public.person_timeline_events
     where project_id = 'e7200000-0000-4000-8000-000000000001'
       and place_id is not null),
    (select count(*) from public.places
     where project_id = 'e7200000-0000-4000-8000-000000000001')
  )::text,
  row(2::bigint, 2::bigint)::text,
  'retry creates no duplicate Place and leaves both event links intact'
);

select * from finish();
rollback;
