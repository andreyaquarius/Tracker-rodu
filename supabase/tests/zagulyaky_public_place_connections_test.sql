begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(30);

select has_function(
  'public',
  'list_public_zagulyaky_places_v1',
  array['text', 'integer'],
  'the anonymous public place selector exists'
);
select has_function(
  'public',
  'get_public_zagulyaky_place_connections_v1',
  array['jsonb', 'text', 'jsonb', 'integer', 'integer'],
  'the anonymous public place-connections facade exists'
);
select has_function(
  'security_private',
  'list_public_zagulyaky_places_v1',
  array['text', 'integer'],
  'the trusted place selector implementation is outside the Data API schema'
);
select has_function(
  'security_private',
  'get_public_zagulyaky_place_connections_v1',
  array['jsonb', 'text', 'jsonb', 'integer', 'integer'],
  'the trusted place-connections implementation is outside the Data API schema'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.list_public_zagulyaky_places_v1(text,integer)'::regprocedure)
    and not (select prosecdef from pg_proc where oid = 'public.get_public_zagulyaky_place_connections_v1(jsonb,text,jsonb,integer,integer)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'security_private.list_public_zagulyaky_places_v1(text,integer)'::regprocedure)
    and (select prosecdef from pg_proc where oid = 'security_private.get_public_zagulyaky_place_connections_v1(jsonb,text,jsonb,integer,integer)'::regprocedure),
  'public place facades are SECURITY INVOKER and trusted implementations are SECURITY DEFINER'
);
select ok(
  has_function_privilege('anon', 'public.list_public_zagulyaky_places_v1(text,integer)'::regprocedure, 'EXECUTE')
    and has_function_privilege('anon', 'public.get_public_zagulyaky_place_connections_v1(jsonb,text,jsonb,integer,integer)'::regprocedure, 'EXECUTE')
    and not has_function_privilege('anon', 'security_private.zagulyaky_public_place_key_v1(jsonb)'::regprocedure, 'EXECUTE'),
  'anonymous callers can use the two facades but not their private place-key helper'
);

insert into public.zagulyaky_records (
  id,
  kind,
  status,
  verification_status,
  privacy_status,
  public_slug,
  title,
  summary,
  event_type,
  event_date_text,
  event_year_from,
  event_year_to,
  source_location_text,
  source_location_normalized,
  found_location_text,
  found_location_normalized,
  origin_geo,
  found_geo,
  possible_living_person,
  published_at
) values
  (
    'e8000000-0000-4000-8000-000000000001',
    'person', 'published', 'verified', 'cleared', 'place-alpha-beta-1901',
    'Альфа — Бета, шлюб 1901', '', 'marriage', '1901 рік', 1901, 1901,
    'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ', 'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ',
    'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ', 'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Місто Бета","latitude":49.1,"longitude":31.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"beta-1"}'::jsonb,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000002',
    'person', 'published', 'plausible', 'cleared', 'place-alpha-beta-1902',
    'Альфа — Бета, шлюб 1902', '', 'marriage', '1902 рік', 1902, 1902,
    'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ', 'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ',
    'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ', 'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Місто Бета","latitude":49.1,"longitude":31.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"beta-1"}'::jsonb,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000003',
    'person', 'published', 'plausible', 'cleared', 'place-alpha-gamma-1903',
    'Альфа — Гамма, народження 1903', '', 'birth', '1903 рік', 1903, 1903,
    'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ', 'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ',
    'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ', 'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Село Гамма","latitude":48.1,"longitude":32.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"gamma-1"}'::jsonb,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000004',
    'person', 'published', 'plausible', 'cleared', 'place-beta-alpha-1904',
    'Бета — Альфа, смерть 1904', '', 'death', '1904 рік', 1904, 1904,
    'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ', 'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ',
    'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ', 'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ',
    '{"displayName":"Місто Бета","latitude":49.1,"longitude":31.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"beta-1"}'::jsonb,
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000005',
    'person', 'published', 'plausible', 'cleared', 'place-alpha-local-1905',
    'Альфа — Альфа, шлюб 1905', '', 'marriage', '1905 рік', 1905, 1905,
    'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ', 'ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ',
    'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ', 'ДОВІЛЬНИЙ ТЕКСТ ЗНАХІДКИ',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000006',
    'person', 'draft', 'unverified', 'pending', null,
    'Чернетка Альфа — Бета', '', 'marriage', '1906 рік', 1906, 1906,
    'Село Альфа', 'Село Альфа', 'Місто Бета', 'Місто Бета',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Місто Бета","latitude":49.1,"longitude":31.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"beta-1"}'::jsonb,
    false, null
  ),
  (
    'e8000000-0000-4000-8000-000000000007',
    'person', 'published', 'plausible', 'requires_consent', 'place-living-alpha-beta',
    'Неперевірена можливо жива особа', '', 'marriage', '1907 рік', 1907, 1907,
    'Село Альфа', 'Село Альфа', 'Місто Бета', 'Місто Бета',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Місто Бета","latitude":49.1,"longitude":31.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"beta-1"}'::jsonb,
    true, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000008',
    'document', 'published', 'verified', 'cleared', 'place-document-alpha-beta',
    'Документ Альфа — Бета', '', 'marriage', '1908 рік', 1908, 1908,
    'Село Альфа', 'Село Альфа', 'Місто Бета', 'Місто Бета',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    '{"displayName":"Місто Бета","latitude":49.1,"longitude":31.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"beta-1"}'::jsonb,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000009',
    'person', 'published', 'plausible', 'cleared', 'place-free-text-only',
    'Лише вільний текст', '', 'marriage', '1909 рік', 1909, 1909,
    'Село Альфа', 'Село Альфа', 'Місто Бета', 'Місто Бета',
    null, null,
    false, now()
  ),
  (
    'e8000000-0000-4000-8000-000000000010',
    'person', 'published', 'plausible', 'cleared', 'place-alpha-one-sided',
    'Лише походження без місця знахідки', '', 'residence', '1910 рік', 1910, 1910,
    'Село Альфа', 'Село Альфа', 'Місце не вказано', 'Місце не вказано',
    '{"displayName":"Село Альфа","latitude":50.1,"longitude":30.2,"source":"search","precision":"settlement","provider":"OpenStreetMap Nominatim","externalId":"alpha-1"}'::jsonb,
    null,
    false, now()
  );

insert into public.zagulyaky_participants (
  record_id,
  role,
  event_role_code,
  original_full_name,
  normalized_uk_full_name,
  notes,
  sort_order
) values
  ('e8000000-0000-4000-8000-000000000001', 'subject', 'groom', 'Особа Альфа Бета 1', 'Особа Альфа Бета 1', '', 0),
  ('e8000000-0000-4000-8000-000000000002', 'subject', 'bride', 'Особа Альфа Бета 2', 'Особа Альфа Бета 2', '', 0),
  ('e8000000-0000-4000-8000-000000000003', 'subject', 'newborn', 'Особа Альфа Гамма', 'Особа Альфа Гамма', '', 0),
  ('e8000000-0000-4000-8000-000000000004', 'subject', 'deceased', 'Особа Бета Альфа', 'Особа Бета Альфа', '', 0),
  ('e8000000-0000-4000-8000-000000000005', 'subject', 'groom', 'Особа Альфа Альфа', 'Особа Альфа Альфа', '', 0);

create temporary table pgtap_alpha_place on commit drop as
select item as place
from jsonb_array_elements(
  public.list_public_zagulyaky_places_v1('Альфа', 100) -> 'items'
) item
where item ->> 'label' = 'Село Альфа';

create temporary table pgtap_alpha_connections on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'all',
  '{}'::jsonb,
  50,
  0
) as response;

create temporary table pgtap_beta_place on commit drop as
select item as place
from jsonb_array_elements(
  public.list_public_zagulyaky_places_v1('Бета', 100) -> 'items'
) item
where item ->> 'label' = 'Місто Бета';

select is(
  (select count(*)::integer from pgtap_alpha_place),
  1,
  'the selector returns one canonical confirmed point for the chosen settlement'
);
select is(
  (select place ->> 'originRecordCount' from pgtap_alpha_place),
  '4',
  'the selector counts only visible person records that have the confirmed origin point'
);
select is(
  (select place ->> 'foundRecordCount' from pgtap_alpha_place),
  '2',
  'the selector counts only visible person records that have the confirmed found point'
);
select is(
  (select place ->> 'recordCount' from pgtap_alpha_place),
  '5',
  'free-text-only, one-sided, draft, document and uncleared possible-living rows do not make a selectable settlement count'
);
select is(
  jsonb_array_length(public.search_zagulyaky_people_v1(
    null,
    jsonb_build_object(
      'sourceLocation', 'Село Альфа',
      'foundLocation', 'Місто Бета',
      'originPlaceKey', (select place ->> 'key' from pgtap_alpha_place),
      'foundPlaceKey', (select place ->> 'key' from pgtap_beta_place),
      'eventRole', 'groom'
    ),
    50,
    null,
    null
  ) -> 'items'),
  1,
  'opaque map-point keys and an event role reopen the exact public card even when historic free-text locations differ from the map labels'
);
select is(
  (select response -> 'place' ->> 'label' from pgtap_alpha_connections),
  'Село Альфа',
  'connections return the selected public place with its canonical label'
);
select ok(
  (select response -> 'counts' -> 'outgoing' ->> 'placeCount' from pgtap_alpha_connections) = '2'
    and (select response -> 'counts' -> 'outgoing' ->> 'recordCount' from pgtap_alpha_connections) = '3',
  'outgoing aggregates distinguish connected settlements from public person records'
);
select is(
  (select response -> 'outgoing' -> 'items' -> 0 ->> 'label' from pgtap_alpha_connections),
  'Місто Бета',
  'outgoing settlements are ranked by their record count'
);
select ok(
  (select response -> 'outgoing' -> 'items' -> 0 ->> 'recordCount' from pgtap_alpha_connections) = '2'
    and jsonb_array_length((select response -> 'outgoing' -> 'items' -> 0 -> 'sampleRecords' from pgtap_alpha_connections)) = 2,
  'a connection includes only bounded public sample cards'
);
select ok(
  (select response -> 'counts' -> 'incoming' ->> 'placeCount' from pgtap_alpha_connections) = '1'
    and (select response -> 'counts' -> 'incoming' ->> 'recordCount' from pgtap_alpha_connections) = '1'
    and (select response -> 'incoming' -> 'items' -> 0 ->> 'label' from pgtap_alpha_connections) = 'Місто Бета',
  'incoming means the selected place is where the record was found'
);
select ok(
  (select response -> 'counts' -> 'local' ->> 'placeCount' from pgtap_alpha_connections) = '1'
    and (select response -> 'counts' -> 'local' ->> 'recordCount' from pgtap_alpha_connections) = '1'
    and (select response -> 'local' -> 'items' -> 0 ->> 'label' from pgtap_alpha_connections) = 'Село Альфа',
  'local records are counted separately and retain no artificial route'
);

create temporary table pgtap_outgoing_only on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'outgoing',
  '{}'::jsonb,
  50,
  0
) as response;

select ok(
  (select response -> 'counts' -> 'outgoing' ->> 'recordCount' from pgtap_outgoing_only) = '3'
    and (select response -> 'counts' -> 'incoming' ->> 'recordCount' from pgtap_outgoing_only) = '0'
    and (select response -> 'counts' -> 'local' ->> 'recordCount' from pgtap_outgoing_only) = '0',
  'an individual direction returns only that requested direction without extra round trips'
);

create temporary table pgtap_marriages on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'all',
  '{"eventType":"marriage"}'::jsonb,
  50,
  0
) as response;

select ok(
  (select response -> 'counts' -> 'outgoing' ->> 'placeCount' from pgtap_marriages) = '1'
    and (select response -> 'counts' -> 'outgoing' ->> 'recordCount' from pgtap_marriages) = '2'
    and (select response -> 'counts' -> 'local' ->> 'recordCount' from pgtap_marriages) = '1',
  'event-type filtering applies before aggregation in every direction'
);

create temporary table pgtap_grooms on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'all',
  '{"eventRole":"groom"}'::jsonb,
  50,
  0
) as response;

select ok(
  (select response -> 'counts' -> 'outgoing' ->> 'recordCount' from pgtap_grooms) = '1'
    and (select response -> 'counts' -> 'local' ->> 'recordCount' from pgtap_grooms) = '1'
    and (select response -> 'counts' -> 'incoming' ->> 'recordCount' from pgtap_grooms) = '0',
  'event-role filtering applies to the same public connection groups as event and year filters'
);

create temporary table pgtap_years on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'all',
  '{"yearFrom":1903,"yearTo":1903}'::jsonb,
  50,
  0
) as response;

select ok(
  (select response -> 'counts' -> 'outgoing' ->> 'placeCount' from pgtap_years) = '1'
    and (select response -> 'counts' -> 'outgoing' ->> 'recordCount' from pgtap_years) = '1'
    and (select response -> 'outgoing' -> 'items' -> 0 ->> 'label' from pgtap_years) = 'Село Гамма',
  'year-range filtering uses the public event years before connections are grouped'
);

create temporary table pgtap_no_matching_event on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'all',
  '{"eventType":"census"}'::jsonb,
  50,
  0
) as response;

select ok(
  (select response -> 'place' ->> 'label' from pgtap_no_matching_event) = 'Село Альфа'
    and (select response -> 'counts' -> 'outgoing' ->> 'recordCount' from pgtap_no_matching_event) = '0',
  'a valid selected place remains selected when the active filters match no public records'
);

create temporary table pgtap_outgoing_first_page on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'outgoing',
  '{}'::jsonb,
  1,
  0
) as response;
create temporary table pgtap_outgoing_second_page on commit drop as
select public.get_public_zagulyaky_place_connections_v1(
  jsonb_build_object('key', (select place ->> 'key' from pgtap_alpha_place)),
  'outgoing',
  '{}'::jsonb,
  1,
  1
) as response;

select ok(
  (select response -> 'outgoing' ->> 'hasMore' from pgtap_outgoing_first_page) = 'true'
    and jsonb_array_length((select response -> 'outgoing' -> 'items' from pgtap_outgoing_first_page)) = 1
    and (select response -> 'outgoing' -> 'items' -> 0 ->> 'label' from pgtap_outgoing_first_page) = 'Місто Бета',
  'per-direction place pagination is bounded and reports more results'
);
select is(
  (select response -> 'outgoing' -> 'items' -> 0 ->> 'label' from pgtap_outgoing_second_page),
  'Село Гамма',
  'the offset returns the next deterministic connected settlement'
);
select ok(
  position('e8000000-0000-4000-8000-000000000001' in (select response::text from pgtap_alpha_connections)) = 0
    and position('ДОВІЛЬНИЙ ТЕКСТ ПОХОДЖЕННЯ' in (select response::text from pgtap_alpha_connections)) = 0
    and position('payload' in (select response::text from pgtap_alpha_connections)) = 0,
  'the public response has no record UUID, free-text location or internal payload'
);
select throws_ok(
  $$select public.get_public_zagulyaky_place_connections_v1('{"label":"Село Альфа"}'::jsonb, 'all', '{}'::jsonb, 50, 0)$$,
  '22023',
  'INVALID_ZAGULYAKY_PLACE_KEY',
  'free-text labels cannot be used to infer a selected public settlement'
);
select throws_ok(
  $$select public.get_public_zagulyaky_place_connections_v1('{"key":"00000000000000000000000000000000"}'::jsonb, 'sideways', '{}'::jsonb, 50, 0)$$,
  '22023',
  'INVALID_ZAGULYAKY_PLACE_DIRECTION',
  'the connections RPC rejects an unsupported direction'
);
select throws_ok(
  $$select public.get_public_zagulyaky_place_connections_v1('{"key":"00000000000000000000000000000000"}'::jsonb, 'all', '{"archive":"x"}'::jsonb, 50, 0)$$,
  '22023',
  'INVALID_ZAGULYAKY_PLACE_FILTERS',
  'archive or storage filters are intentionally outside the settlement-connections contract'
);
select throws_ok(
  $$select public.get_public_zagulyaky_place_connections_v1('{"key":"00000000000000000000000000000000"}'::jsonb, 'all', '{"yearFrom":1905,"yearTo":1904}'::jsonb, 50, 0)$$,
  '22023',
  'INVALID_ZAGULYAKY_PLACE_YEAR',
  'the connections RPC rejects an invalid event-year interval'
);
select throws_ok(
  $$select public.get_public_zagulyaky_place_connections_v1('{"key":"00000000000000000000000000000000"}'::jsonb, 'all', '{}'::jsonb, 50, 0)$$,
  'P0002',
  'ZAGULYAKY_PLACE_NOT_FOUND',
  'a syntactically valid but unavailable place key does not expose or infer data'
);

select * from finish();
rollback;
