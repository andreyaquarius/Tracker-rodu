begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

select ok(
  to_regprocedure('public.get_place_redirect_v1(uuid)') is not null
  and to_regprocedure('public.get_place_profile_v1(uuid,date)') is not null
  and to_regprocedure('public.get_place_autocomplete_projection_v1(uuid,date,date,date)') is not null
  and to_regprocedure('public.merge_places_preview_v1(uuid,uuid)') is not null
  and to_regprocedure('public.get_place_map_context_v1(uuid,date,date,date,integer)') is not null
  and to_regprocedure('public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)') is not null,
  'final historical-place integrity contracts exist without changing established signatures'
);

select ok(
  not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.get_place_redirect_v1(uuid)'::regprocedure)
  and not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.get_place_profile_v1(uuid,date)'::regprocedure)
  and not has_function_privilege(
    'authenticated',
    'security_private.get_historical_place_redirect_v1(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'security_private.get_historical_place_redirect_v1(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'security_private.historical_place_merge_cycle_v1(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'security_private.historical_place_admin_context_v1(uuid)',
    'EXECUTE'
  ),
  'public facades remain invoker functions and graph internals are not client-callable'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'fa100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'places-final-owner@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'fa100000-0000-4000-8000-000000000001',
  'places-final-owner@example.test',
  'Places final owner'
) on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values (
  'fa200000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001',
  'Historical places final integrity project'
);

insert into public.researches (id, project_id, title, created_by) values (
  'fa300000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Final integrity research',
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, is_living, privacy_status, created_by
) values (
  'fa400000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  'proven', 'unknown', 'Тестова', 'Особа', '', 'Тестова Особа',
  false, 'project', 'fa100000-0000-4000-8000-000000000001'
);

insert into public.documents (
  id, project_id, research_id, title, year_from, year_to, created_by
) values
(
  'fa410000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  'Документ 1862', '1862', '1862', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa410000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  'Документ 1900', '1900', '1900', 'fa100000-0000-4000-8000-000000000001'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, latitude, longitude,
  status, verification_status, created_by
) values
(
  'fa500000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Сучасна Канонічна Назва', 'Модерна Назва', 49.0, 28.0,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'Історичний район', '', 49.1, 28.1,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000003',
  'fa200000-0000-4000-8000-000000000001',
  'Історична область', '', 49.2, 28.2,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000004',
  'fa200000-0000-4000-8000-000000000001',
  'Безпечна ціль merge', '', 49.3, 28.3,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000005',
  'fa200000-0000-4000-8000-000000000001',
  'Цикл A', '', null, null,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000006',
  'fa200000-0000-4000-8000-000000000001',
  'Цикл B', '', null, null,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000007',
  'fa200000-0000-4000-8000-000000000001',
  'Цикл C', '', null, null,
  'active', 'unverified', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000008',
  null, 'SOURCE_SECRET_NAME', '', 50.0, 30.0,
  'active', 'verified', null
),
(
  'fa500000-0000-4000-8000-000000000009',
  null, 'Публічна ціль', 'Публічна сучасна ціль', 50.1, 30.1,
  'active', 'verified', null
),
(
  'fa500000-0000-4000-8000-00000000000a',
  null, 'Непублічна ціль', '', 50.2, 30.2,
  'active', 'verified', null
);

update public.places
set is_public = true
where id in (
  'fa500000-0000-4000-8000-000000000008',
  'fa500000-0000-4000-8000-000000000009'
);

insert into public.place_names (
  id, place_id, name, original_text, language_code, name_type,
  valid_from, valid_to, is_primary, created_by
) values
(
  'fa510000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000001',
  'Архаїчний Топонім', 'Архаїчний Топонім', 'uk', 'historical',
  '1800-01-01', '1899-12-31', true,
  'fa100000-0000-4000-8000-000000000001'
),
(
  'fa510000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000008',
  'SOURCE_ALIAS_SECRET', 'SOURCE_ALIAS_SECRET', 'en', 'historical',
  null, null, true, null
);

insert into public.place_type_assignments (
  id, place_id, place_type_code, is_primary, created_by
) values
(
  'fa520000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000002',
  'district', true, 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa520000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000003',
  'region', true, 'fa100000-0000-4000-8000-000000000001'
);

insert into public.place_hierarchy_relations (
  id, child_place_id, parent_place_id, relation_type, created_by
) values
(
  'fa530000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000002',
  'administrative_parent', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa530000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000003',
  'administrative_parent', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa530000-0000-4000-8000-000000000003',
  'fa500000-0000-4000-8000-000000000005',
  'fa500000-0000-4000-8000-000000000006',
  'administrative_parent', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa530000-0000-4000-8000-000000000004',
  'fa500000-0000-4000-8000-000000000006',
  'fa500000-0000-4000-8000-000000000007',
  'administrative_parent', 'fa100000-0000-4000-8000-000000000001'
);

insert into public.document_place_links (
  id, document_id, place_id, relation_type, original_text, created_by
) values
(
  'fa540000-0000-4000-8000-000000000001',
  'fa410000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000001',
  'mentions', 'Документ 1862', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa540000-0000-4000-8000-000000000002',
  'fa410000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000001',
  'mentions', 'Документ 1900', 'fa100000-0000-4000-8000-000000000001'
),
(
  'fa540000-0000-4000-8000-000000000003',
  'fa410000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000008',
  'mentions', 'PRIVATE_DOCUMENT_SECRET', 'fa100000-0000-4000-8000-000000000001'
);

insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date,
  place_name, place_id, place_original_text, place_resolution_status, metadata
) values
(
  'fa550000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'fa400000-0000-4000-8000-000000000001',
  'birth', 'Подія 1862', '1862-07-01',
  'Сучасна Канонічна Назва', 'fa500000-0000-4000-8000-000000000001',
  'Подія 1862', 'confirmed', '{}'
),
(
  'fa550000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'fa400000-0000-4000-8000-000000000001',
  'marriage', 'Подія 1900', '1900-07-01',
  'Сучасна Канонічна Назва', 'fa500000-0000-4000-8000-000000000001',
  'Подія 1900', 'confirmed', '{}'
),
(
  'fa550000-0000-4000-8000-000000000003',
  'fa200000-0000-4000-8000-000000000001',
  'fa400000-0000-4000-8000-000000000001',
  'residence', 'Приватна подія', '1862-07-01',
  'SOURCE_SECRET_NAME', 'fa500000-0000-4000-8000-000000000008',
  'PRIVATE_EVENT_SECRET', 'confirmed', '{}'
);

insert into public.place_external_identifiers (
  id, place_id, provider, external_identifier, is_primary
) values (
  'fa560000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000008',
  'private-test-provider', 'PRIVATE_EXTERNAL_ID_SECRET', true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.search_places_v2(
    'Архаїчний Топонім', '1862-07-01', null, null, 'day',
    'fa200000-0000-4000-8000-000000000001', 20, null, null, null, null
  ) #>> '{0,id}',
  'fa500000-0000-4000-8000-000000000001',
  'date-aware search finds a historical name inside its validity period'
);

select is(
  jsonb_array_length(public.search_places_v2(
    'Архаїчний Топонім', '1900-07-01', null, null, 'day',
    'fa200000-0000-4000-8000-000000000001', 20, null, null, null, null
  )),
  0,
  'date-aware search does not match an expired historical name'
);

select is(
  public.search_places_v2(
    'Сучасна Канонічна Назва', '1900-07-01', null, null, 'day',
    'fa200000-0000-4000-8000-000000000001', 20, null, null, null, null
  ) #>> '{0,id}',
  'fa500000-0000-4000-8000-000000000001',
  'canonical-name search remains available with a date filter'
);

select is(
  public.search_places_v2(
    'Модерна Назва', '1900-07-01', null, null, 'day',
    'fa200000-0000-4000-8000-000000000001', 20, null, null, null, null
  ) #>> '{0,id}',
  'fa500000-0000-4000-8000-000000000001',
  'modern-name search remains available with a date filter'
);

select is(
  jsonb_array_length(public.get_place_map_context_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01', null, null, 100
  ) -> 'documents'),
  1,
  'exact-date map context excludes documents outside that day'
);

select is(
  jsonb_array_length(public.get_place_map_context_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01', null, null, 100
  ) -> 'events'),
  1,
  'exact-date map context excludes events outside that day'
);

select is(
  row(
    public.get_place_map_context_v1(
      'fa500000-0000-4000-8000-000000000001', '1862-07-01', null, null, 100
    ) -> 'documents',
    public.get_place_map_context_v1(
      'fa500000-0000-4000-8000-000000000001', '1862-07-01', null, null, 100
    ) -> 'events'
  )::text,
  row(
    public.get_place_map_context_v1(
      'fa500000-0000-4000-8000-000000000001', null, '1862-07-01', '1862-07-01', 100
    ) -> 'documents',
    public.get_place_map_context_v1(
      'fa500000-0000-4000-8000-000000000001', null, '1862-07-01', '1862-07-01', 100
    ) -> 'events'
  )::text,
  'exact-date map results equal the equivalent one-day period results'
);

select ok(
  jsonb_array_length(public.merge_places_preview_v1(
    'fa500000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000004'
  ) #> '{source,adminContext,ancestors}') = 2
  and public.merge_places_preview_v1(
    'fa500000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000004'
  ) #>> '{source,adminContext,ancestors,0,place,placeType}' = 'district'
  and public.merge_places_preview_v1(
    'fa500000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000004'
  ) #>> '{source,adminContext,ancestors,1,place,placeType}' = 'region',
  'merge preview includes the complete accessible typed ancestor chain'
);

select throws_ok(
  $$select public.merge_places_preview_v1(
    'fa500000-0000-4000-8000-000000000005',
    'fa500000-0000-4000-8000-000000000007'
  )$$,
  '22023', 'PLACE_MERGE_HIERARCHY_CYCLE',
  'merge preview rejects a transitive hierarchy cycle'
);

select throws_ok(
  $$select public.merge_places_v1(
    'fa500000-0000-4000-8000-000000000005',
    'fa500000-0000-4000-8000-000000000007', 1, 1,
    'must fail because A reaches C through B'
  )$$,
  '22023', 'PLACE_MERGE_HIERARCHY_CYCLE',
  'merge execution independently rejects the same transitive hierarchy cycle'
);

select is(
  row(
    (select status from public.places where id = 'fa500000-0000-4000-8000-000000000005'),
    (select count(*) from public.place_hierarchy_relations
     where id in (
       'fa530000-0000-4000-8000-000000000003',
       'fa530000-0000-4000-8000-000000000004'
     ))
  )::text,
  row('active', 2::bigint)::text,
  'rejected cyclic merge leaves the source and hierarchy untouched'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select public.merge_places_preview_v1(
    'fa500000-0000-4000-8000-000000000008',
    'fa500000-0000-4000-8000-00000000000a'
  )$$,
  '22023', 'GLOBAL_PUBLIC_PLACE_MERGE_TARGET_MUST_BE_PUBLIC',
  'a public global source cannot be merged into an anonymous-invisible target'
);

select ok(
  (public.merge_places_v1(
    'fa500000-0000-4000-8000-000000000008',
    'fa500000-0000-4000-8000-000000000009', 2, 2,
    'verified public duplicates'
  ) ->> 'operationId')::uuid is not null,
  'service role can merge a public global source into a readable public target'
);

select ok(
  (public.merge_places_v1(
    'fa500000-0000-4000-8000-00000000000a',
    'fa500000-0000-4000-8000-000000000009',
    (select lock_version from public.places
      where id = 'fa500000-0000-4000-8000-00000000000a'),
    (select lock_version from public.places
      where id = 'fa500000-0000-4000-8000-000000000009'),
    'private catalogue duplicate'
  ) ->> 'operationId')::uuid is not null,
  'service role can merge a non-public global source for the redirect privacy test'
);

reset role;

select is(
  row(
    (select count(*) from public.document_place_links
     where place_id = 'fa500000-0000-4000-8000-000000000009'),
    (select count(*) from public.person_timeline_events
     where place_id = 'fa500000-0000-4000-8000-000000000009')
  )::text,
  row(1::bigint, 1::bigint)::text,
  'global merge still transfers private project links to the target'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select throws_ok(
  $$select public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-000000000001'
  )$$,
  'P0002', 'PLACE_NOT_FOUND',
  'redirect lookup hides an existing private project Place from anonymous callers'
);

select throws_ok(
  $$select public.get_place_redirect_v1(
    'fa5fffff-ffff-4fff-8fff-ffffffffffff'
  )$$,
  'P0002', 'PLACE_NOT_FOUND',
  'redirect lookup gives the same response for an unknown Place UUID'
);

select is(
  row(
    public.get_place_redirect_v1(
      'fa500000-0000-4000-8000-000000000008'
    ) ->> 'status',
    public.get_place_redirect_v1(
      'fa500000-0000-4000-8000-000000000008'
    ) #>> '{redirect,finalTargetPlaceId}'
  )::text,
  row('merged', 'fa500000-0000-4000-8000-000000000009')::text,
  'anonymous callers receive a usable redirect to the visible final target'
);

select ok(
  position('SOURCE_SECRET_NAME' in public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-000000000008'
  )::text) = 0
  and position('SOURCE_ALIAS_SECRET' in public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-000000000008'
  )::text) = 0
  and position('PRIVATE_DOCUMENT_SECRET' in public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-000000000008'
  )::text) = 0
  and position('PRIVATE_EVENT_SECRET' in public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-000000000008'
  )::text) = 0
  and position('PRIVATE_EXTERNAL_ID_SECRET' in public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-000000000008'
  )::text) = 0,
  'safe redirect contains no source evidence or private linked-record data'
);

select throws_ok(
  $$select public.get_place_redirect_v1(
    'fa500000-0000-4000-8000-00000000000a'
  )$$,
  'P0002', 'PLACE_NOT_FOUND',
  'anonymous callers cannot discover a merged source that was never public'
);

select ok(
  public.get_place_autocomplete_projection_v1(
    'fa500000-0000-4000-8000-000000000008', null, null, null
  ) #>> '{redirect,finalTargetPlaceId}' = 'fa500000-0000-4000-8000-000000000009'
  and position('SOURCE_ALIAS_SECRET' in public.get_place_autocomplete_projection_v1(
    'fa500000-0000-4000-8000-000000000008', null, null, null
  )::text) = 0,
  'existing autocomplete API returns the same minimal safe redirect'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select ok(
  public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000008', null
  ) #>> '{redirect,finalTargetPlaceId}' = 'fa500000-0000-4000-8000-000000000009'
  and jsonb_array_length(public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000008', null
  ) -> 'names') = 0
  and jsonb_array_length(public.list_place_external_identifiers_v1(
    'fa500000-0000-4000-8000-000000000008'
  )) = 0
  and position('PRIVATE_DOCUMENT_SECRET' in public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000008', null
  )::text) = 0,
  'existing profile and identifier APIs keep a merged global source readable without leaking source data'
);

select * from finish();

rollback;
