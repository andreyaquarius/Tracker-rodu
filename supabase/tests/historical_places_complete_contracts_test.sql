begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(62);

select ok(
  to_regprocedure('public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)') is not null
  and to_regprocedure('public.get_place_autocomplete_projection_v1(uuid,date,date,date)') is not null
  and to_regprocedure('public.resolve_place_hierarchy_period_v1(uuid,date,date,integer)') is not null
  and to_regprocedure('public.list_place_boundaries_v2(uuid,date,date,date)') is not null
  and to_regprocedure('public.list_place_documents_v2(uuid,date,date,integer,integer)') is not null
  and to_regprocedure('public.list_place_events_v2(uuid,date,date,integer,integer)') is not null
  and to_regprocedure('public.get_place_map_context_v1(uuid,date,date,date,integer)') is not null,
  'date-aware search, projection, hierarchy, list, and map read contracts exist'
);

select ok(
  to_regprocedure('public.create_project_place_v2(uuid,jsonb)') is not null
  and to_regprocedure('public.patch_project_place_v2(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.add_place_type_assignment_v1(uuid,jsonb)') is not null
  and to_regprocedure('public.update_place_type_assignment_v1(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.add_place_external_identifier_v1(uuid,jsonb)') is not null
  and to_regprocedure('public.update_place_external_identifier_v1(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.add_place_relation_v1(uuid,uuid,jsonb)') is not null
  and to_regprocedure('public.update_place_relation_v1(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.add_place_boundary_v1(uuid,jsonb)') is not null
  and to_regprocedure('public.update_place_boundary_v1(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)') is not null
  and to_regprocedure('public.get_finding_document_place_v1(uuid)') is not null
  and to_regprocedure('public.clear_finding_document_place_v1(uuid,timestamptz)') is not null,
  'complete versioned Place writes and finding confirmation contracts exist'
);

select ok(
  not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure)
  and (select prosecdef from pg_catalog.pg_proc
       where oid = 'security_private.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure)
  and not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)'::regprocedure)
  and (select prosecdef from pg_catalog.pg_proc
       where oid = 'security_private.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)'::regprocedure),
  'public APIs are invoker facades over explicitly authorized definer bodies'
);

select ok(
  has_function_privilege('anon', 'public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_place_map_context_v1(uuid,date,date,date,integer)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_finding_document_place_v1(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.clear_finding_document_place_v1(uuid,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_place_map_context_v1(uuid,date,date,date,integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_finding_document_place_v1(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.clear_finding_document_place_v1(uuid,timestamptz)', 'EXECUTE'),
  'public autocomplete is anonymous-safe while private map and writes are authenticated-only'
);

select ok(
  not has_function_privilege('authenticated', 'security_private.assert_historical_period_v1(date,date,date,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'security_private.can_read_historical_place_v2(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'security_private.place_boundary_json_v1(public.place_boundaries)', 'EXECUTE'),
  'internal validation and serialization helpers are not client-callable'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'places'
      and column_name = 'location' and is_generated = 'ALWAYS'
  )
  and exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'document_place_links'
      and column_name = 'source_finding_id'
  )
  and to_regclass('public.places_location_gist_idx') is not null,
  'spatial projection and finding-backed document link columns/index exist'
);

select ok(
  not has_table_privilege('authenticated', 'public.place_type_assignments', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.place_external_identifiers', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.place_relations', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.place_boundaries', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.document_place_links', 'UPDATE'),
  'authenticated clients cannot bypass versioned child-row updates'
);

select ok(
  pg_get_functiondef('security_private.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure)
    like '%pg_advisory_xact_lock%'
  and pg_get_functiondef('security_private.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)'::regprocedure)
    like '%had_existing := found%',
  'finding confirmation serializes competing requests and snapshots FOUND before later PERFORM calls'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_index index_row
    where index_row.indexrelid =
      'public.document_place_links_finding_confirmation_uidx'::regclass
      and index_row.indisunique
  ),
  'a database uniqueness invariant prevents duplicate finding/document/relation links'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  'fd100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'places-complete-owner@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
),
(
  '00000000-0000-0000-0000-000000000000',
  'fd100000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'places-complete-other@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values
('fd100000-0000-4000-8000-000000000001', 'places-complete-owner@example.test', 'Places complete owner'),
('fd100000-0000-4000-8000-000000000002', 'places-complete-other@example.test', 'Places complete other')
on conflict (user_id) do update set email = excluded.email, display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
('fd200000-0000-4000-8000-000000000001', 'fd100000-0000-4000-8000-000000000001', 'Complete contracts project'),
('fd200000-0000-4000-8000-000000000002', 'fd100000-0000-4000-8000-000000000002', 'Other complete contracts project');

insert into public.researches (id, project_id, title, created_by) values
('fd300000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000001', 'Complete research', 'fd100000-0000-4000-8000-000000000001'),
('fd300000-0000-4000-8000-000000000002', 'fd200000-0000-4000-8000-000000000002', 'Other complete research', 'fd100000-0000-4000-8000-000000000002');

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, is_living, privacy_status, created_by
) values (
  'fd400000-0000-4000-8000-000000000001',
  'fd200000-0000-4000-8000-000000000001',
  'fd300000-0000-4000-8000-000000000001',
  'proven', 'unknown', 'Тестова', 'Особа', '', 'Тестова Особа', false,
  'project', 'fd100000-0000-4000-8000-000000000001'
);

insert into public.documents (
  id, project_id, research_id, title, year_from, year_to, created_by
) values
('fd410000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000001', 'fd300000-0000-4000-8000-000000000001', 'Метрична книга 1862', '1862', '', 'fd100000-0000-4000-8000-000000000001'),
('fd410000-0000-4000-8000-000000000002', 'fd200000-0000-4000-8000-000000000001', 'fd300000-0000-4000-8000-000000000001', 'Метрична книга 1900', '1900', '', 'fd100000-0000-4000-8000-000000000001');

insert into public.findings (
  id, project_id, research_id, document_id, finding_type, place,
  transcription, created_by, updated_at
) values (
  'fd420000-0000-4000-8000-000000000001',
  'fd200000-0000-4000-8000-000000000001',
  'fd300000-0000-4000-8000-000000000001',
  'fd410000-0000-4000-8000-000000000001',
  'record', 'с. Трубіевки', 'при селі Трубіевці',
  'fd100000-0000-4000-8000-000000000001', '2026-08-28 10:00:00+00'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, latitude, longitude,
  status, verification_status, metadata, created_by
) values
('fd500000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000001', 'Трубіївка', 'Трубіївка', 49.0000, 28.0000, 'active', 'unverified', '{"currentCountry":"Україна","currentAdmin":"Вінницька область"}', 'fd100000-0000-4000-8000-000000000001'),
('fd500000-0000-4000-8000-000000000002', 'fd200000-0000-4000-8000-000000000001', 'Старий повіт', '', 49.1000, 28.1000, 'active', 'unverified', '{}', 'fd100000-0000-4000-8000-000000000001'),
('fd500000-0000-4000-8000-000000000003', 'fd200000-0000-4000-8000-000000000001', 'Новий район', '', 49.2000, 28.2000, 'active', 'unverified', '{}', 'fd100000-0000-4000-8000-000000000001'),
('fd500000-0000-4000-8000-000000000004', 'fd200000-0000-4000-8000-000000000001', 'Спірний повіт', '', 49.3000, 28.3000, 'active', 'unverified', '{}', 'fd100000-0000-4000-8000-000000000001'),
('fd500000-0000-4000-8000-000000000005', 'fd200000-0000-4000-8000-000000000001', 'Сусіднє село', '', 49.0100, 28.0100, 'active', 'unverified', '{}', 'fd100000-0000-4000-8000-000000000001'),
('fd500000-0000-4000-8000-000000000006', 'fd200000-0000-4000-8000-000000000002', 'Чуже село', '', 48.0000, 27.0000, 'active', 'unverified', '{}', 'fd100000-0000-4000-8000-000000000002');

insert into public.place_names (
  id, place_id, name, original_text, language_code, name_type,
  valid_from, valid_to, is_primary, created_by
) values (
  'fd510000-0000-4000-8000-000000000001',
  'fd500000-0000-4000-8000-000000000001', 'Трубіевка', 'села Трубіевки',
  'uk', 'historical', '1800-01-01', '1899-12-31', true,
  'fd100000-0000-4000-8000-000000000001'
);

insert into public.place_hierarchy_relations (
  id, child_place_id, parent_place_id, relation_type, valid_from, valid_to,
  source_reference, note, created_by
) values
('fd520000-0000-4000-8000-000000000001', 'fd500000-0000-4000-8000-000000000001', 'fd500000-0000-4000-8000-000000000002', 'administrative_parent', '1800-01-01', '1899-12-31', 'source:old', 'old parent', 'fd100000-0000-4000-8000-000000000001'),
('fd520000-0000-4000-8000-000000000002', 'fd500000-0000-4000-8000-000000000001', 'fd500000-0000-4000-8000-000000000004', 'administrative_parent', '1850-01-01', '1870-12-31', 'source:competing', 'competing parent', 'fd100000-0000-4000-8000-000000000001'),
('fd520000-0000-4000-8000-000000000003', 'fd500000-0000-4000-8000-000000000001', 'fd500000-0000-4000-8000-000000000003', 'administrative_parent', '1900-01-01', null, 'source:modern', 'modern parent', 'fd100000-0000-4000-8000-000000000001');

insert into public.place_parish_relations (
  id, place_id, parish_place_id, religion, relation_type,
  valid_from, valid_to, original_text, note, created_by
) values (
  'fd530000-0000-4000-8000-000000000001',
  'fd500000-0000-4000-8000-000000000001',
  'fd500000-0000-4000-8000-000000000005',
  'orthodox', 'parish', '1800-01-01', '1899-12-31',
  'парафіяльна згадка', 'old parish note',
  'fd100000-0000-4000-8000-000000000001'
);

insert into public.archive_resources (
  id, project_id, resource_type, title, archive_name, fund, inventory,
  file_reference, original_text, created_by
) values (
  'fd540000-0000-4000-8000-000000000001',
  'fd200000-0000-4000-8000-000000000001', 'file', 'Метрична книга',
  'ЦДІАК', '127', '1012', '45', 'ЦДІАК, ф.127, оп.1012, спр.45',
  'fd100000-0000-4000-8000-000000000001'
);

insert into public.place_archive_relations (
  id, place_id, archive_resource_id, relation_type, valid_from, valid_to,
  original_text, note, created_by
) values (
  'fd550000-0000-4000-8000-000000000001',
  'fd500000-0000-4000-8000-000000000001',
  'fd540000-0000-4000-8000-000000000001', 'has_materials',
  '1800-01-01', '1899-12-31', 'матеріали по селу', 'old archive note',
  'fd100000-0000-4000-8000-000000000001'
);

insert into public.document_place_links (
  id, document_id, place_id, relation_type, original_text, confidence, created_by
) values (
  'fd560000-0000-4000-8000-000000000001',
  'fd410000-0000-4000-8000-000000000002',
  'fd500000-0000-4000-8000-000000000001', 'mentions',
  'Трубіївка у книзі 1900', 90, 'fd100000-0000-4000-8000-000000000001'
);

insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date,
  date_from, date_to, date_text, place_name, place_id,
  place_original_text, place_resolution_status, metadata
) values
('fd570000-0000-4000-8000-000000000001', 'fd200000-0000-4000-8000-000000000001', 'fd400000-0000-4000-8000-000000000001', 'birth', 'Народження', '', '1862', '', '1862 рік', 'с. Трубіевка', 'fd500000-0000-4000-8000-000000000001', 'села Трубіевки', 'confirmed', '{}'),
('fd570000-0000-4000-8000-000000000002', 'fd200000-0000-4000-8000-000000000001', 'fd400000-0000-4000-8000-000000000001', 'marriage', 'Шлюб', '1900-04-02', '', '', '2 квітня 1900', 'Трубіївка', 'fd500000-0000-4000-8000-000000000001', 'Трубіївка', 'confirmed', '{}');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fd100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.search_places_v2('Трубіевка', '1862-06-01', null, null, 'day', 'fd200000-0000-4000-8000-000000000001', 20, null, null, null, null) #>> '{0,id}',
  'fd500000-0000-4000-8000-000000000001',
  'autocomplete searches historical names active on an exact date'
);

select is(
  public.search_places_v2('', '1862-06-01', null, null, 'day', 'fd200000-0000-4000-8000-000000000001', 20, 'fd500000-0000-4000-8000-000000000002', null, null, null) #>> '{0,id}',
  'fd500000-0000-4000-8000-000000000001',
  'search filters descendants by an explicit administrative ancestor UUID'
);

select is(
  public.search_places_v2('', null, null, null, null, 'fd200000-0000-4000-8000-000000000001', 20, null, 49.0000, 28.0000, 2.0) #>> '{0,id}',
  'fd500000-0000-4000-8000-000000000001',
  'coordinate search uses explicit latitude, longitude, and radius parameters'
);

select throws_ok(
  $$select public.search_places_v2('',null,null,null,null,'fd200000-0000-4000-8000-000000000001',20,null,49,null,2)$$,
  '22023', 'PLACE_COORDINATE_SEARCH_REQUIRES_LATITUDE_LONGITUDE_RADIUS',
  'partial or comma-ambiguous coordinate input is rejected'
);

select throws_ok(
  $$select public.search_places_v2('Трубіївка','1862-01-01','1862-01-01','1862-12-31','year','fd200000-0000-4000-8000-000000000001',20,null,null,null,null)$$,
  '22023', 'PLACE_SEARCH_EXACT_DATE_AND_PERIOD_CONFLICT',
  'exact dates and historical periods cannot be supplied together'
);

select is(
  public.get_place_autocomplete_projection_v1('fd500000-0000-4000-8000-000000000001','1862-06-01',null,null) ->> 'displayName',
  'Трубіевка',
  'autocomplete projection chooses the historical name active on the exact date'
);

select is(
  public.get_place_autocomplete_projection_v1('fd500000-0000-4000-8000-000000000001','1862-06-01',null,null) #>> '{hierarchy,hierarchy,0,place,id}',
  'fd500000-0000-4000-8000-000000000002',
  'exact-date projection resolves its historical administrative hierarchy without inventing a year day'
);

select is(
  public.resolve_place_hierarchy_period_v1('fd500000-0000-4000-8000-000000000001','1862-01-01','1862-12-31',12) ->> 'status',
  'ambiguous_period',
  'overlapping hierarchy candidates are explicitly ambiguous for a period'
);

select is(
  public.resolve_place_hierarchy_period_v1('fd500000-0000-4000-8000-000000000001','1862-01-01','1862-12-31',12) ->> 'requiresExactDate',
  'true',
  'period ambiguity asks the caller for an exact date instead of choosing an arbitrary parent'
);

select is(
  public.confirm_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    'fd410000-0000-4000-8000-000000000001',
    'fd500000-0000-4000-8000-000000000001',
    E'  села Трубіевки\n', 'confirmed', '2026-08-28 10:00:00+00'
  ) ->> 'sourceReference',
  'finding:fd420000-0000-4000-8000-000000000001',
  'first finding confirmation creates a traceable finding-backed document link'
);

select set_config(
  'test.confirmed_link_id',
  (select id::text from public.document_place_links
   where source_finding_id = 'fd420000-0000-4000-8000-000000000001'),
  true
);

select is(
  public.get_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001'
  ) #>> '{link,placeId}',
  'fd500000-0000-4000-8000-000000000001',
  'finding lifecycle load returns the persisted document/Place decision'
);

select is(
  public.get_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001'
  ) #>> '{place,canonicalName}',
  'Трубіївка',
  'finding lifecycle load includes a safe Place summary for the editor'
);

select is(
  public.confirm_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    'fd410000-0000-4000-8000-000000000001',
    'fd500000-0000-4000-8000-000000000001',
    E'  села Трубіевки\n', 'confirmed', null
  ) ->> 'id',
  current_setting('test.confirmed_link_id'),
  'an idempotent retry returns the same document link'
);

select is(
  public.confirm_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    'fd410000-0000-4000-8000-000000000001',
    'fd500000-0000-4000-8000-000000000001',
    E'  села Трубіевки\n', 'confirmed', null
  ) ->> 'idempotent',
  'true',
  'the retry response identifies that no duplicate mutation was needed'
);

select is(
  (select count(*) from public.document_place_links
   where source_finding_id = 'fd420000-0000-4000-8000-000000000001'
     and document_id = 'fd410000-0000-4000-8000-000000000001'
     and relation_type = 'mentions'),
  1::bigint,
  'retries cannot create duplicate finding/document/relation rows'
);

select is(
  (select original_text from public.document_place_links
   where id = current_setting('test.confirmed_link_id')::uuid),
  E'  села Трубіевки\n',
  'finding confirmation preserves the original place text byte-for-byte'
);

select throws_ok(
  $$select public.confirm_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    'fd410000-0000-4000-8000-000000000001',
    'fd500000-0000-4000-8000-000000000001',
    'rewritten text', 'confirmed', null
  )$$,
  '22023', 'FINDING_PLACE_ORIGINAL_TEXT_CONFLICT',
  'an idempotent retry cannot silently rewrite source evidence'
);

select throws_ok(
  $$select public.confirm_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    'fd410000-0000-4000-8000-000000000001',
    'fd500000-0000-4000-8000-000000000001',
    E'  села Трубіевки\n', 'confirmed', '2020-01-01 00:00:00+00'
  )$$,
  '40001', 'FINDING_VERSION_CONFLICT',
  'a stale finding context is rejected before confirmation'
);

select is(
  jsonb_array_length(public.list_place_documents_v2(
    'fd500000-0000-4000-8000-000000000001','1862-01-01','1862-12-31',100,0
  )),
  1,
  'document list includes a source whose year overlaps the requested period'
);

select is(
  jsonb_array_length(public.list_place_documents_v2(
    'fd500000-0000-4000-8000-000000000001','1700-01-01','1700-12-31',100,0
  )),
  0,
  'document list excludes known non-overlapping years'
);

select is(
  jsonb_array_length(public.list_place_events_v2(
    'fd500000-0000-4000-8000-000000000001','1862-01-01','1862-12-31',100,0
  )),
  1,
  'event list treats a year-only lower value as an explicit year period'
);

select is(
  public.list_place_events_v2(
    'fd500000-0000-4000-8000-000000000001','1862-01-01','1862-12-31',100,0
  ) #>> '{0,dateFrom}',
  '1862',
  'year-only event evidence is returned unchanged and never rewritten as January 1'
);

select is(
  jsonb_array_length(public.list_place_events_v2(
    'fd500000-0000-4000-8000-000000000001','1900-01-01','1900-12-31',100,0
  )),
  1,
  'event list also supports exact-date events inside an explicit period'
);

select set_config(
  'test.boundary_id',
  public.add_place_boundary_v1(
    'fd500000-0000-4000-8000-000000000001',
    '{"boundaryType":"historical_boundary","geometryGeojson":{"type":"Polygon","coordinates":[[[27.9,48.9],[28.1,48.9],[28.1,49.1],[27.9,49.1],[27.9,48.9]]]},"validFrom":"1800-01-01","validTo":"1899-12-31","originalText":"межі повіту"}'::jsonb
  ) ->> 'id',
  true
);

select is(
  jsonb_array_length(public.list_place_boundaries_v2(
    'fd500000-0000-4000-8000-000000000001',null,'1862-01-01','1862-12-31'
  )),
  1,
  'boundary list returns geometry overlapping the requested historical period'
);

select ok(
  jsonb_array_length(public.get_place_map_context_v1(
    'fd500000-0000-4000-8000-000000000001',null,'1862-01-01','1862-12-31',100
  ) -> 'boundaries') = 1
  and jsonb_array_length(public.get_place_map_context_v1(
    'fd500000-0000-4000-8000-000000000001',null,'1862-01-01','1862-12-31',100
  ) -> 'documents') = 1
  and jsonb_array_length(public.get_place_map_context_v1(
    'fd500000-0000-4000-8000-000000000001',null,'1862-01-01','1862-12-31',100
  ) -> 'events') = 1
  and public.get_place_map_context_v1(
    'fd500000-0000-4000-8000-000000000001',null,'1862-01-01','1862-12-31',100
  ) #>> '{place,hierarchy,status}' = 'ambiguous_period',
  'map-on-date context returns Place projection, ambiguous hierarchy, boundaries, documents, and events together'
);

select set_config(
  'test.type_id',
  public.add_place_type_assignment_v1(
    'fd500000-0000-4000-8000-000000000001',
    '{"placeTypeCode":"village","validFromText":"до 1900","validFromPrecision":"before","sourceReference":"type source","confidence":91,"isPrimary":true,"note":"type note","metadata":{"basis":"source"}}'::jsonb
  ) ->> 'id', true
);

select is(
  (select place_type_code from public.place_type_assignments
   where id = current_setting('test.type_id')::uuid),
  'village',
  'versioned type assignment accepts its complete evidence payload'
);

select is(
  public.update_place_type_assignment_v1(
    current_setting('test.type_id')::uuid,1,
    '{"placeTypeCode":"town","validToText":"після 1910","validToPrecision":"after","sourceReference":"updated type source","confidence":87,"isPrimary":true,"note":"updated type note","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'lockVersion',
  '2',
  'type assignment update is optimistic and returns the incremented version'
);

select throws_ok(
  format(
    'select public.update_place_type_assignment_v1(%L::uuid,1,%L::jsonb)',
    current_setting('test.type_id'), '{"note":"stale"}'
  ),
  '40001', 'PLACE_TYPE_ASSIGNMENT_VERSION_CONFLICT',
  'stale type assignment updates are rejected'
);

select set_config(
  'test.external_id',
  public.add_place_external_identifier_v1(
    'fd500000-0000-4000-8000-000000000001',
    '{"provider":"wikidata","externalIdentifier":"Q123","sourceUrl":"https://www.wikidata.org/wiki/Q123","isPrimary":true,"metadata":{"source":"catalogue"}}'::jsonb
  ) ->> 'id', true
);

select is(
  public.update_place_external_identifier_v1(
    current_setting('test.external_id')::uuid,1,
    '{"externalIdentifier":"Q456","sourceUrl":"https://www.wikidata.org/wiki/Q456","isPrimary":true,"metadata":{"reviewed":true}}'::jsonb
  ) ->> 'lockVersion',
  '2',
  'external identifier update covers identifier, URL, primary flag, metadata, and version'
);

select set_config(
  'test.relation_id',
  public.add_place_relation_v1(
    'fd500000-0000-4000-8000-000000000001',
    'fd500000-0000-4000-8000-000000000005',
    '{"relationType":"neighbour","validFrom":"1800-01-01","validTo":"1899-12-31","sourceReference":"relation source","confidence":80,"originalText":"сусіднє село","note":"relation note","metadata":{"kind":"map"}}'::jsonb
  ) ->> 'id', true
);

select is(
  public.update_place_relation_v1(
    current_setting('test.relation_id')::uuid,1,
    '{"relationType":"nearby","validTo":"1910-12-31","sourceReference":"updated relation source","confidence":85,"note":"updated relation note","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'originalText',
  'сусіднє село',
  'generic relation update covers full metadata but preserves immutable source wording'
);

select is(
  public.update_place_boundary_v1(
    current_setting('test.boundary_id')::uuid,1,
    '{"boundaryType":"historical_boundary","validTo":"1900-12-31","sourceReference":"updated boundary source","confidence":88,"note":"boundary reviewed","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'originalText',
  'межі повіту',
  'boundary update is versioned and preserves immutable geometry evidence wording'
);

select is(
  public.update_place_hierarchy_relation_v1(
    'fd520000-0000-4000-8000-000000000001',1,
    '{"relationType":"administrative_parent","validToText":"кінець XIX ст.","validToPrecision":"circa","sourceReference":"updated hierarchy source","confidence":89,"note":"hierarchy reviewed","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'lockVersion',
  '2',
  'existing hierarchy relations have a complete versioned update contract'
);

select is(
  public.update_place_parish_relation_v1(
    'fd530000-0000-4000-8000-000000000001',1,
    '{"religion":"orthodox","relationType":"parish","validToText":"1899","validToPrecision":"year","sourceReference":"updated parish source","confidence":86,"note":"parish reviewed","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'originalText',
  'парафіяльна згадка',
  'existing parish relations have a complete versioned update contract with immutable source wording'
);

select is(
  public.update_archive_resource_v1(
    'fd540000-0000-4000-8000-000000000001',1,
    '{"resourceType":"file","title":"Метрична книга 1862","archiveName":"ЦДІАК","fund":"127","inventory":"1012","fileReference":"45","catalogueReference":"catalogue:45","url":"https://example.test/archive/45","description":"опис ресурсу","sourceReference":"archive source","status":"active","isPublic":false,"metadata":{"reviewed":true}}'::jsonb
  ) ->> 'originalText',
  'ЦДІАК, ф.127, оп.1012, спр.45',
  'archive resource update covers all editable fields while preserving original evidence text'
);

select is(
  public.update_place_archive_relation_v1(
    'fd550000-0000-4000-8000-000000000001',1,
    '{"relationType":"has_materials","validToText":"1899","validToPrecision":"year","sourceReference":"updated archive relation source","confidence":92,"note":"archive relation reviewed","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'originalText',
  'матеріали по селу',
  'archive relation update covers all evidence fields while preserving original wording'
);

select is(
  public.update_document_place_link_v1(
    'fd560000-0000-4000-8000-000000000001',1,
    '{"validFromText":"1900","validFromPrecision":"year","resolutionStatus":"confirmed","sourceReference":"document source","confidence":99,"note":"document link reviewed","metadata":{"reviewed":true}}'::jsonb
  ) ->> 'originalText',
  'Трубіївка у книзі 1900',
  'document link update is versioned and preserves exact source wording'
);

select set_config(
  'test.created_place_id',
  public.create_project_place_v2(
    'fd200000-0000-4000-8000-000000000001',
    '{"canonicalName":"Нове історичне місце","modernName":"Нове місце","latitude":50.1,"longitude":29.1,"currentCountry":"Україна","currentAdmin":"Київська область","status":"needs_review","verificationStatus":"unverified","placeType":"village","wikidataId":"Q777","geonamesId":"123456","externalIds":{"other_catalogue":{"externalIdentifier":"ABC-1","sourceUrl":"https://example.test/ABC-1"}}}'::jsonb
  ) #>> '{place,id}', true
);

select is(
  (select metadata ->> 'currentAdmin' from public.places
   where id = current_setting('test.created_place_id')::uuid),
  'Київська область',
  'Place v2 create persists current administrative display metadata without replacing historical hierarchy'
);

select is(
  (select row(status,verification_status)::text from public.places
   where id = current_setting('test.created_place_id')::uuid),
  row('needs_review','unverified')::text,
  'Place v2 create accepts explicit lifecycle and verification fields through the versioned contract'
);

select is(
  (select place_type_code from public.place_type_assignments
   where place_id = current_setting('test.created_place_id')::uuid and is_primary),
  'village',
  'Place v2 create adds the selected primary type assignment'
);

select is(
  (select count(*) from public.place_external_identifiers
   where place_id = current_setting('test.created_place_id')::uuid),
  3::bigint,
  'Place v2 create normalizes Wikidata, GeoNames, and generic external identifiers'
);

select is(
  public.patch_project_place_v2(
    current_setting('test.created_place_id')::uuid,
    (select lock_version from public.places where id = current_setting('test.created_place_id')::uuid),
    '{"currentAdmin":"Київська губернія","description":"уточнене місце","externalIds":[{"provider":"catalogue_2","externalIdentifier":"XYZ-2"}]}'::jsonb
  ) #>> '{place,currentAdmin}',
  'Київська губернія',
  'Place v2 patch updates current metadata and can add identifiers through an optimistic contract'
);

select ok(
  extensions.st_equals(
    (select location from public.places where id = 'fd500000-0000-4000-8000-000000000001'),
    extensions.st_setsrid(extensions.st_makepoint(28.0,49.0),4326)
  ),
  'generated spatial point always follows explicit longitude/latitude columns'
);

reset role;

select ok(
  exists (
    select 1 from security_private.historical_place_audit_log
    where project_id = 'fd200000-0000-4000-8000-000000000001'
      and entity_table in ('place_type_assignments','place_external_identifiers','place_relations','place_boundaries')
  ),
  'new versioned child writes remain covered by the historical-place audit trail'
);

set local role authenticated;

update public.findings
set document_id = 'fd410000-0000-4000-8000-000000000002'
where id = 'fd420000-0000-4000-8000-000000000001';

select is(
  public.get_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001'
  ) ->> 'documentMatchesFinding',
  'false',
  'lifecycle load exposes a stale document association after the finding document changes'
);

select set_config(
  'test.reconfirm_response',
  public.confirm_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    'fd410000-0000-4000-8000-000000000002',
    'fd500000-0000-4000-8000-000000000001',
    E'  села Трубіевки\n', 'confirmed', null
  )::text,
  true
);

select ok(
  current_setting('test.reconfirm_response')::jsonb ->> 'id'
      = current_setting('test.confirmed_link_id')
  and (select document_id from public.document_place_links
       where id = current_setting('test.confirmed_link_id')::uuid)
      = 'fd410000-0000-4000-8000-000000000002'::uuid
  and (select count(*) from public.document_place_links
       where source_finding_id = 'fd420000-0000-4000-8000-000000000001') = 1,
  'reconfirmation moves the same unique link to the changed document without leaving stale duplicates'
);

select set_config(
  'test.finding_updated_at',
  (select updated_at::text from public.findings
   where id = 'fd420000-0000-4000-8000-000000000001'),
  true
);

select throws_ok(
  $$select public.clear_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001','2020-01-01 00:00:00+00'
  )$$,
  '40001', 'FINDING_VERSION_CONFLICT',
  'clear rejects a stale finding context before deleting the persisted link'
);

select is(
  public.clear_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',
    current_setting('test.finding_updated_at')::timestamptz
  ) ->> 'cleared',
  'true',
  'clear removes the finding-backed link through the versioned lifecycle contract'
);

select is(
  (select place from public.findings
   where id = 'fd420000-0000-4000-8000-000000000001'),
  'с. Трубіевки',
  'clear never rewrites or deletes the original finding place text'
);

select is(
  public.get_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001'
  ) -> 'link',
  'null'::jsonb,
  'lifecycle load reports no persisted Place decision after clear'
);

select is(
  public.clear_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',null
  ) ->> 'cleared',
  'false',
  'clear is idempotent when two clients retry the removal'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fd100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.get_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001'
  )$$,
  '42501', 'FINDING_ACCESS_REQUIRED',
  'another project member cannot load a private finding Place decision'
);

select throws_ok(
  $$select public.clear_finding_document_place_v1(
    'fd420000-0000-4000-8000-000000000001',null
  )$$,
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED',
  'another project member cannot clear a private finding Place decision'
);

select throws_ok(
  $$select public.add_place_type_assignment_v1(
    'fd500000-0000-4000-8000-000000000001', '{"placeTypeCode":"village"}'::jsonb
  )$$,
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED',
  'another project member cannot mutate a private Place'
);

select * from finish();
rollback;
