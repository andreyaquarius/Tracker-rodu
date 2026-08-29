begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(44);

select ok(
  to_regclass('public.place_boundaries') is not null
  and to_regclass('public.place_relations') is not null
  and to_regclass('public.place_parish_relations') is not null
  and to_regclass('public.archive_resources') is not null
  and to_regclass('public.place_archive_relations') is not null
  and to_regclass('public.document_place_links') is not null
  and to_regclass('public.place_merge_operations') is not null
  and to_regclass('public.place_merge_preserved_rows') is not null,
  'historical boundary, relation, archive, document, and merge tables exist'
);

select ok(
  exists (select 1 from pg_catalog.pg_extension where extname = 'postgis')
  and (
    select format_type(attribute_row.atttypid, attribute_row.atttypmod)
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = 'public.place_boundaries'::regclass
      and attribute_row.attname = 'geometry'
  ) = 'geometry(MultiPolygon,4326)'
  and (
    select attribute_row.attgenerated
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = 'public.place_boundaries'::regclass
      and attribute_row.attname = 'geometry'
  ) = 's',
  'boundary geometry is a generated PostGIS MultiPolygon in EPSG:4326'
);

select ok(
  to_regclass('public.place_boundaries_geometry_gist_idx') is not null
  and pg_get_indexdef('public.place_boundaries_geometry_gist_idx'::regclass) like '%USING gist (geometry)%',
  'boundary projection has a GiST spatial index'
);

select ok(
  to_regprocedure('public.list_place_boundaries_v1(uuid,date)') is not null
  and to_regprocedure('public.list_place_related_v1(uuid,date)') is not null
  and to_regprocedure('public.list_place_parishes_v1(uuid,date)') is not null
  and to_regprocedure('public.list_place_archives_v1(uuid,date)') is not null
  and to_regprocedure('public.list_place_documents_v1(uuid,integer,integer)') is not null
  and to_regprocedure('public.list_place_people_v1(uuid,integer,integer)') is not null
  and to_regprocedure('public.list_place_events_v1(uuid,integer,integer)') is not null
  and to_regprocedure('public.merge_places_preview_v1(uuid,uuid)') is not null
  and to_regprocedure('public.merge_places_v1(uuid,uuid,integer,integer,text)') is not null,
  'dedicated profile list and explicit merge RPCs exist'
);

select ok(
  not (select prosecdef from pg_catalog.pg_proc where oid = 'public.merge_places_v1(uuid,uuid,integer,integer,text)'::regprocedure)
  and (select prosecdef from pg_catalog.pg_proc where oid = 'security_private.merge_places_v1(uuid,uuid,integer,integer,text)'::regprocedure)
  and not (select prosecdef from pg_catalog.pg_proc where oid = 'public.list_place_related_v1(uuid,date)'::regprocedure),
  'public APIs are invoker facades and only ACL bodies are definers'
);

select ok(
  has_function_privilege('authenticated', 'public.merge_places_preview_v1(uuid,uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.merge_places_v1(uuid,uuid,integer,integer,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.merge_places_preview_v1(uuid,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_place_boundaries_v1(uuid,date)', 'EXECUTE'),
  'rich relation and merge APIs are authenticated-only'
);

select ok(
  not has_table_privilege('anon', 'public.place_boundaries', 'SELECT')
  and not has_table_privilege('anon', 'public.document_place_links', 'SELECT')
  and not has_table_privilege('anon', 'public.place_merge_preserved_rows', 'SELECT'),
  'anonymous users cannot read raw boundaries, private documents, or preserved merge evidence'
);

select is(
  private.project_deletion_uncovered_table_names(),
  array[]::text[],
  'every new project-owned table is covered by the resumable deletion contract'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'place_boundaries','place_relations','place_parish_relations',
      'archive_resources','place_archive_relations','document_place_links',
      'place_merge_operations','place_merge_preserved_rows'
    ]) table_name
    cross join lateral (
      select to_regclass(format('public.%I', table_name)) relation_id
    ) relation_row
    where not exists (
      select 1
      from pg_catalog.pg_index index_row
      join pg_catalog.pg_attribute first_key
        on first_key.attrelid = index_row.indrelid
       and first_key.attnum = index_row.indkey[0]
      where index_row.indrelid = relation_row.relation_id
        and index_row.indisvalid and index_row.indisready
        and first_key.attname = 'project_id'
    )
  ),
  'every new deletion phase has a project_id-leading index'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  'fb100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'place-merge-owner@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
),
(
  '00000000-0000-0000-0000-000000000000',
  'fb100000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'place-merge-other@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values
('fb100000-0000-4000-8000-000000000001', 'place-merge-owner@example.test', 'Merge owner'),
('fb100000-0000-4000-8000-000000000002', 'place-merge-other@example.test', 'Merge other')
on conflict (user_id) do update set email = excluded.email, display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
('fb200000-0000-4000-8000-000000000001', 'fb100000-0000-4000-8000-000000000001', 'Merge project'),
('fb200000-0000-4000-8000-000000000002', 'fb100000-0000-4000-8000-000000000002', 'Other project'),
('fb200000-0000-4000-8000-000000000003', 'fb100000-0000-4000-8000-000000000001', 'Cascade project');

insert into public.researches (id, project_id, title, created_by) values
('fb300000-0000-4000-8000-000000000001', 'fb200000-0000-4000-8000-000000000001', 'Merge research', 'fb100000-0000-4000-8000-000000000001');

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, is_living, privacy_status, created_by
) values (
  'fb400000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001',
  'fb300000-0000-4000-8000-000000000001',
  'proven', 'unknown', 'Тестовий', 'Іван', '', 'Тестовий Іван',
  false, 'project', 'fb100000-0000-4000-8000-000000000001'
);

insert into public.documents (id, project_id, research_id, title, created_by) values (
  'fb410000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001',
  'fb300000-0000-4000-8000-000000000001',
  'Метрична книга Трубієвки',
  'fb100000-0000-4000-8000-000000000001'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, latitude, longitude,
  status, verification_status, created_by
) values
('fb500000-0000-4000-8000-000000000001', 'fb200000-0000-4000-8000-000000000001', 'Трубіевка', '', 50.1, 30.1, 'active', 'unverified', 'fb100000-0000-4000-8000-000000000001'),
('fb500000-0000-4000-8000-000000000002', 'fb200000-0000-4000-8000-000000000001', 'Трубіївка', 'Трубіївка', 50.11, 30.11, 'active', 'unverified', 'fb100000-0000-4000-8000-000000000001'),
('fb500000-0000-4000-8000-000000000003', 'fb200000-0000-4000-8000-000000000001', 'Сусіднє село', '', 50.2, 30.2, 'active', 'unverified', 'fb100000-0000-4000-8000-000000000001'),
('fb500000-0000-4000-8000-000000000004', 'fb200000-0000-4000-8000-000000000001', 'Парафія', '', 50.3, 30.3, 'active', 'unverified', 'fb100000-0000-4000-8000-000000000001'),
('fb500000-0000-4000-8000-000000000005', 'fb200000-0000-4000-8000-000000000002', 'Чуже місце', '', null, null, 'active', 'unverified', 'fb100000-0000-4000-8000-000000000002'),
('fb500000-0000-4000-8000-000000000006', 'fb200000-0000-4000-8000-000000000003', 'Каскадне місце', '', null, null, 'active', 'unverified', 'fb100000-0000-4000-8000-000000000001'),
('fb500000-0000-4000-8000-000000000007', null, 'Глобальний дубль', '', null, null, 'active', 'verified', null),
('fb500000-0000-4000-8000-000000000008', null, 'Глобальне місце', '', null, null, 'active', 'verified', null);

insert into public.place_names (
  id, place_id, name, original_text, language_code, name_type,
  valid_from, valid_to, is_primary, created_by
) values
('fb600000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 'Трубіевка', 'села Трубіевки', 'uk', 'historical', '1800-01-01', '1899-12-31', true, 'fb100000-0000-4000-8000-000000000001'),
('fb600000-0000-4000-8000-000000000002', 'fb500000-0000-4000-8000-000000000002', 'Трубіївка', 'Трубіївка', 'uk', 'official', '1900-01-01', null, true, 'fb100000-0000-4000-8000-000000000001');

insert into public.place_boundaries (
  id, place_id, boundary_type, geometry_geojson, valid_from, valid_to,
  original_text, created_by
) values (
  'fb610000-0000-4000-8000-000000000001',
  'fb500000-0000-4000-8000-000000000001', 'historical_boundary',
  '{"type":"Polygon","coordinates":[[[30,50],[31,50],[31,51],[30,51],[30,50]]]}'::jsonb,
  '1800-01-01', '1899-12-31', 'межі за картою 1862 року',
  'fb100000-0000-4000-8000-000000000001'
);

insert into public.place_type_assignments (
  id, place_id, place_type_code, valid_from, valid_to, created_by
) values (
  'fb620000-0000-4000-8000-000000000001',
  'fb500000-0000-4000-8000-000000000001', 'village',
  '1800-01-01', '1899-12-31', 'fb100000-0000-4000-8000-000000000001'
);

insert into public.place_hierarchy_relations (
  id, child_place_id, parent_place_id, relation_type, valid_from, valid_to, created_by
) values
('fb630000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000003', 'administrative_parent', '1800-01-01', '1899-12-31', 'fb100000-0000-4000-8000-000000000001'),
('fb630000-0000-4000-8000-000000000002', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000002', 'duplicate_context', null, null, 'fb100000-0000-4000-8000-000000000001'),
('fb630000-0000-4000-8000-000000000003', 'fb500000-0000-4000-8000-000000000005', 'fb500000-0000-4000-8000-000000000007', 'administrative_parent', null, null, 'fb100000-0000-4000-8000-000000000002');

insert into public.place_relations (
  id, place_id, related_place_id, relation_type, valid_from, valid_to,
  original_text, created_by
) values
('fb640000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000003', 'neighbour', '1800-01-01', '1899-12-31', 'сусіднє село', 'fb100000-0000-4000-8000-000000000001'),
('fb640000-0000-4000-8000-000000000002', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000003', 'neighbour', '1900-01-01', null, 'пізніша згадка', 'fb100000-0000-4000-8000-000000000001'),
('fb640000-0000-4000-8000-000000000003', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000002', 'same_place_candidate', null, null, 'можливий дубль', 'fb100000-0000-4000-8000-000000000001');

insert into public.place_parish_relations (
  id, place_id, parish_place_id, religion, valid_from, valid_to,
  original_text, created_by
) values
('fb650000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000004', 'orthodox', '1800-01-01', '1899-12-31', 'православна парафія', 'fb100000-0000-4000-8000-000000000001'),
('fb650000-0000-4000-8000-000000000002', 'fb500000-0000-4000-8000-000000000001', 'fb500000-0000-4000-8000-000000000002', 'unknown', null, null, 'зв’язок дубля', 'fb100000-0000-4000-8000-000000000001');

insert into public.archive_resources (
  id, project_id, resource_type, title, archive_name, fund, inventory,
  file_reference, original_text, created_by
) values (
  'fb660000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001', 'file',
  'Метрична книга', 'ЦДІАК', '127', '1012', '45',
  'ЦДІАК, ф. 127, оп. 1012, спр. 45',
  'fb100000-0000-4000-8000-000000000001'
);

insert into public.archive_resources (
  id, project_id, parent_resource_id, resource_type, title, archive_name,
  fund, original_text, created_by
) values (
  'fb660000-0000-4000-8000-000000000002',
  'fb200000-0000-4000-8000-000000000001',
  'fb660000-0000-4000-8000-000000000001', 'fund',
  'Фонд 127', 'ЦДІАК', '127', 'ЦДІАК, ф. 127',
  'fb100000-0000-4000-8000-000000000001'
);

insert into public.place_archive_relations (
  id, place_id, archive_resource_id, relation_type, valid_from, valid_to,
  original_text, created_by
) values (
  'fb670000-0000-4000-8000-000000000001',
  'fb500000-0000-4000-8000-000000000001',
  'fb660000-0000-4000-8000-000000000001', 'has_materials',
  '1800-01-01', '1899-12-31', 'матеріали по селу',
  'fb100000-0000-4000-8000-000000000001'
);

insert into public.document_place_links (
  id, document_id, place_id, relation_type, original_text, confidence, created_by
) values (
  'fb680000-0000-4000-8000-000000000001',
  'fb410000-0000-4000-8000-000000000001',
  'fb500000-0000-4000-8000-000000000001', 'mentions',
  'села Трубіевки', 95, 'fb100000-0000-4000-8000-000000000001'
);

insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date,
  place_name, place_id, place_original_text, place_resolution_status, metadata
) values (
  'fb690000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001',
  'fb400000-0000-4000-8000-000000000001', 'birth', 'Народження', '1862-07-01',
  'с. Трубіевка', 'fb500000-0000-4000-8000-000000000001',
  'села Трубіевки', 'confirmed', '{}'::jsonb
);

select is(
  extensions.st_srid((select geometry from public.place_boundaries where id = 'fb610000-0000-4000-8000-000000000001')),
  4326,
  'GeoJSON boundary is projected to SRID 4326'
);

select is(
  extensions.geometrytype((select geometry from public.place_boundaries where id = 'fb610000-0000-4000-8000-000000000001')),
  'MULTIPOLYGON',
  'Polygon evidence is safely projected to MultiPolygon'
);

select throws_ok(
  $$insert into public.place_boundaries (
    place_id, geometry_geojson, coordinate_reference_system
  ) values (
    'fb500000-0000-4000-8000-000000000001',
    '{"type":"Polygon","coordinates":[[[30,50],[31,50],[31,51],[30,50]]]}'::jsonb,
    'EPSG:3857'
  )$$,
  '23514',
  'new row for relation "place_boundaries" violates check constraint "place_boundaries_crs_check"',
  'non-4326 boundary evidence is rejected explicitly'
);

select throws_ok(
  $$insert into public.place_boundaries (place_id, geometry_geojson) values (
    'fb500000-0000-4000-8000-000000000001',
    '{"type":"Polygon","coordinates":[]}'::jsonb
  )$$,
  '23514',
  'new row for relation "place_boundaries" violates check constraint "place_boundaries_geojson_check"',
  'empty boundary geometry is rejected'
);

select throws_ok(
  $$insert into public.place_boundaries (place_id, geometry_geojson) values (
    'fb500000-0000-4000-8000-000000000001',
    '{"type":"Polygon","coordinates":[[[30,50],[31,51],[31,50],[30,51],[30,50]]]}'::jsonb
  )$$,
  '23514',
  'new row for relation "place_boundaries" violates check constraint "place_boundaries_geometry_valid_check"',
  'topologically invalid boundary geometry is rejected'
);

select throws_ok(
  $$insert into public.place_boundaries (place_id, geometry_geojson) values (
    'fb500000-0000-4000-8000-000000000001',
    '{"type":"Polygon","coordinates":[[[181,50],[182,50],[182,51],[181,51],[181,50]]]}'::jsonb
  )$$,
  '23514',
  'new row for relation "place_boundaries" violates check constraint "place_boundaries_geometry_valid_check"',
  'EPSG:4326 boundaries reject longitude coordinates outside the legal range'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fb100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.update_archive_resource_v1(
    'fb660000-0000-4000-8000-000000000001',
    1,
    jsonb_build_object(
      'parentResourceId', 'fb660000-0000-4000-8000-000000000002'
    )
  )$$,
  '22023', 'ARCHIVE_RESOURCE_PARENT_CYCLE',
  'archive resource hierarchy rejects indirect parent cycles through the guarded write RPC'
);

select is(jsonb_array_length(public.list_place_related_v1(
  'fb500000-0000-4000-8000-000000000001', '1862-01-01'
)), 2, 'date-aware related list includes the historical neighbour and undated duplicate link');

select is(jsonb_array_length(public.list_place_related_v1(
  'fb500000-0000-4000-8000-000000000001', '1910-01-01'
)), 2, 'date-aware related list switches to the later neighbour while retaining undated evidence');

select is(jsonb_array_length(public.list_place_parishes_v1(
  'fb500000-0000-4000-8000-000000000001', '1862-01-01'
)), 2, 'date-aware parish list includes applicable and undated evidence');

select is(jsonb_array_length(public.list_place_archives_v1(
  'fb500000-0000-4000-8000-000000000001', '1862-01-01'
)), 1, 'member can read time-applicable archive materials');

select is(jsonb_array_length(public.list_place_documents_v1(
  'fb500000-0000-4000-8000-000000000001', 100, 0
)), 1, 'member can read linked project documents');

select is(jsonb_array_length(public.list_place_people_v1(
  'fb500000-0000-4000-8000-000000000001', 100, 0
)), 1, 'member can read people connected through events');

select is(jsonb_array_length(public.list_place_events_v1(
  'fb500000-0000-4000-8000-000000000001', 100, 0
)), 1, 'member can read place events');

select set_config(
  'request.jwt.claims',
  '{"sub":"fb100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.list_place_related_v1('fb500000-0000-4000-8000-000000000001', null)$$,
  '42501', 'PLACE_ACCESS_REQUIRED',
  'non-member cannot read private related places'
);

select throws_ok(
  $$select public.merge_places_preview_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002'
  )$$,
  '42501', 'PLACE_ACCESS_REQUIRED',
  'non-member cannot preview a private merge'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fb100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$insert into public.place_relations (place_id, related_place_id, relation_type) values (
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000005', 'neighbour'
  )$$,
  '22023', 'PLACE_RELATION_PROJECT_SCOPE_MISMATCH',
  'a relation cannot cross private project scopes'
);

select is(
  public.merge_places_preview_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002'
  ) ->> 'canMerge',
  'true',
  'project editor receives an explicit merge permission in preview'
);

select is(
  public.merge_places_preview_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002'
  ) #>> '{source,names,0,originalText}',
  'села Трубіевки',
  'preview exposes exact historical name evidence'
);

select is(
  jsonb_array_length(public.merge_places_preview_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002'
  ) #> '{source,people}'),
  1,
  'preview includes related people'
);

select is(
  jsonb_array_length(public.merge_places_preview_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002'
  ) #> '{source,documents}'),
  1,
  'preview includes linked documents'
);

select is(
  row(
    (public.merge_places_preview_v1(
      'fb500000-0000-4000-8000-000000000001',
      'fb500000-0000-4000-8000-000000000002'
    ) #>> '{preservationPreview,hierarchySelfLinks}')::integer,
    (public.merge_places_preview_v1(
      'fb500000-0000-4000-8000-000000000001',
      'fb500000-0000-4000-8000-000000000002'
    ) #>> '{preservationPreview,genericSelfLinks}')::integer,
    (public.merge_places_preview_v1(
      'fb500000-0000-4000-8000-000000000001',
      'fb500000-0000-4000-8000-000000000002'
    ) #>> '{preservationPreview,parishSelfLinks}')::integer
  )::text,
  row(1,1,1)::text,
  'preview warns about every relation that must be preserved outside the operational graph'
);

select throws_ok(
  $$select public.merge_places_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002', 99, 1, 'stale'
  )$$,
  '40001', 'PLACE_MERGE_VERSION_CONFLICT',
  'optimistic locking rejects a stale merge'
);

select ok(
  (public.merge_places_v1(
    'fb500000-0000-4000-8000-000000000001',
    'fb500000-0000-4000-8000-000000000002', 1, 1,
    'Підтверджені дублікати'
  ) ->> 'operationId')::uuid is not null,
  'editor can explicitly merge two private places in one project'
);

select is(
  (select row(status, merged_into_place_id)::text from public.places
   where id = 'fb500000-0000-4000-8000-000000000001'),
  row('merged', 'fb500000-0000-4000-8000-000000000002'::uuid)::text,
  'source Place remains as a merged redirect'
);

select is(
  (select row(place_id, place_original_text)::text from public.person_timeline_events
   where id = 'fb690000-0000-4000-8000-000000000001'),
  row('fb500000-0000-4000-8000-000000000002'::uuid, 'села Трубіевки')::text,
  'merge transfers event links without changing exact source wording'
);

select is(
  row(
    (select count(*) from public.place_names where place_id = 'fb500000-0000-4000-8000-000000000002'),
    (select count(*) from public.place_boundaries where place_id = 'fb500000-0000-4000-8000-000000000002'),
    (select count(*) from public.place_type_assignments where place_id = 'fb500000-0000-4000-8000-000000000002'),
    (select count(*) from public.document_place_links where place_id = 'fb500000-0000-4000-8000-000000000002'),
    (select count(*) from public.place_archive_relations where place_id = 'fb500000-0000-4000-8000-000000000002')
  )::text,
  row(2::bigint,1::bigint,1::bigint,1::bigint,1::bigint)::text,
  'names, boundaries, types, documents, and archives move to the target'
);

select is(
  (select count(*)::integer from public.place_merge_preserved_rows
   where project_id = 'fb200000-0000-4000-8000-000000000001'),
  3,
  'self-link conflicts are retained losslessly as exact row snapshots'
);

select is(
  (select status from public.place_merge_operations
   where source_place_id = 'fb500000-0000-4000-8000-000000000001'),
  'completed',
  'merge operation records successful completion'
);

reset role;

select ok(
  exists (
    select 1 from security_private.historical_place_audit_log
    where entity_table = 'place_merge_operations'
      and project_id = 'fb200000-0000-4000-8000-000000000001'
      and action in ('insert','update')
  ),
  'merge operation is written to the private audit trail'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fb100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.merge_places_preview_v1(
    'fb500000-0000-4000-8000-000000000007',
    'fb500000-0000-4000-8000-000000000008'
  ) ->> 'requiresChangeRequest',
  'true',
  'authenticated users receive a change-request path for global candidates'
);

select is(
  row(
    jsonb_array_length(public.merge_places_preview_v1(
      'fb500000-0000-4000-8000-000000000007',
      'fb500000-0000-4000-8000-000000000008'
    ) #> '{source,hierarchy}'),
    (public.merge_places_preview_v1(
      'fb500000-0000-4000-8000-000000000007',
      'fb500000-0000-4000-8000-000000000008'
    ) #>> '{source,counts,hierarchyAsParent}')::integer
  )::text,
  row(0, 0)::text,
  'global merge preview does not expose private incoming hierarchy to a non-member'
);

select throws_ok(
  $$select public.merge_places_v1(
    'fb500000-0000-4000-8000-000000000007',
    'fb500000-0000-4000-8000-000000000008', 1, 1, 'global'
  )$$,
  '42501', 'GLOBAL_PLACE_MERGE_CHANGE_REQUEST_REQUIRED',
  'authenticated clients cannot merge the global catalogue directly'
);

reset role;

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role"}',
  true
);

select ok(
  (public.merge_places_v1(
    'fb500000-0000-4000-8000-000000000007',
    'fb500000-0000-4000-8000-000000000008', 1, 1,
    'Curated global duplicate'
  ) ->> 'operationId')::uuid is not null,
  'service role can execute a reviewed global catalogue merge'
);

reset role;

insert into public.place_boundaries (place_id, geometry_geojson) values (
  'fb500000-0000-4000-8000-000000000006',
  '{"type":"Polygon","coordinates":[[[20,40],[21,40],[21,41],[20,40]]]}'::jsonb
);
insert into public.archive_resources (
  id, project_id, resource_type, title
) values (
  'fb660000-0000-4000-8000-000000000003',
  'fb200000-0000-4000-8000-000000000003', 'archive', 'Cascade archive'
);

delete from public.projects where id = 'fb200000-0000-4000-8000-000000000003';

select is(
  row(
    (select count(*) from public.place_boundaries where project_id = 'fb200000-0000-4000-8000-000000000003'),
    (select count(*) from public.archive_resources where project_id = 'fb200000-0000-4000-8000-000000000003'),
    (select count(*) from security_private.historical_place_audit_log where project_id = 'fb200000-0000-4000-8000-000000000003')
  )::text,
  row(0::bigint,0::bigint,0::bigint)::text,
  'project deletion cascades new place data and its private audit records'
);

select * from finish();
rollback;
