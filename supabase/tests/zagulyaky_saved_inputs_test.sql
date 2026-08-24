begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(17);

select has_table('public', 'zagulyaky_saved_places', 'private saved places table exists');
select has_table('public', 'zagulyaky_saved_source_presets', 'private saved source presets table exists');
select has_function('public', 'list_my_zagulyaky_saved_places_v1', array['text', 'integer'], 'saved places list RPC exists');
select has_function('public', 'upsert_my_zagulyaky_saved_place_v1', array['jsonb'], 'saved place upsert RPC exists');
select has_function('public', 'list_my_zagulyaky_saved_source_presets_v1', array['text', 'integer'], 'saved source list RPC exists');
select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_saved_places', 'SELECT')
    and not has_table_privilege('authenticated', 'public.zagulyaky_saved_source_presets', 'SELECT'),
  'browser roles cannot read saved inputs directly'
);
select ok(
  not has_function_privilege('anon', 'public.list_my_zagulyaky_saved_places_v1(text,integer)'::regprocedure, 'EXECUTE')
    and not has_function_privilege('anon', 'public.list_my_zagulyaky_saved_source_presets_v1(text,integer)'::regprocedure, 'EXECUTE'),
  'anonymous callers cannot use private saved-input RPCs'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'c5000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'saved-input-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'c5000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'saved-input-other@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  )
on conflict (id) do update
set email = excluded.email, updated_at = excluded.updated_at;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"c5000000-0000-4000-8000-000000000001","role":"authenticated","email":"saved-input-owner@example.test"}',
  true
);

create temporary table pgtap_saved_place as
select public.upsert_my_zagulyaky_saved_place_v1(
  $$
  {
    "name": "  Трипілля, Київський повіт  ",
    "geo": {
      "displayName": "Трипілля",
      "latitude": 50.118,
      "longitude": 30.781,
      "source": "search",
      "precision": "settlement",
      "provider": "OpenStreetMap Nominatim",
      "externalId": "node/1",
      "markerColor": "#fff"
    }
  }
  $$::jsonb
) as result;

select is(
  (select result ->> 'name' from pgtap_saved_place),
  'Трипілля, Київський повіт',
  'saved place normalizes its visible text'
);
select ok(
  not ((select result -> 'geo' from pgtap_saved_place) ? 'markerColor')
    and (select result -> 'geo' ->> 'latitude' from pgtap_saved_place) = '50.118',
  'saved place keeps the canonical geo payload only'
);
select is(
  jsonb_array_length(public.list_my_zagulyaky_saved_places_v1(null, 100)),
  1,
  'owner sees the new saved place'
);
select is(
  jsonb_array_length(
    public.list_my_zagulyaky_saved_places_v1('Трипілля', 100)
  ),
  1,
  'owner can filter saved places by their own wording'
);

select public.upsert_my_zagulyaky_saved_place_v1(
  $$
  {
    "name": "Трипілля, Київський повіт",
    "geo": {
      "displayName": "Трипілля",
      "latitude": 50.118,
      "longitude": 30.781,
      "source": "search",
      "precision": "settlement",
      "provider": "OpenStreetMap Nominatim",
      "externalId": "node/1"
    }
  }
  $$::jsonb
);
select is(
  jsonb_array_length(public.list_my_zagulyaky_saved_places_v1(null, 100)),
  1,
  'exactly matching place is updated instead of duplicated'
);

create temporary table pgtap_saved_source as
select public.upsert_my_zagulyaky_saved_source_preset_v1(
  $$
  {
    "institutionName": "ЦДІАК України",
    "archiveReference": "ф. 127, оп. 1012, спр. 305",
    "sourceTitle": "Метрична книга",
    "sourceUrl": "https://example.test/source/305"
  }
  $$::jsonb
) as result;
select is(
  (select result ->> 'archiveReference' from pgtap_saved_source),
  'ф. 127, оп. 1012, спр. 305',
  'saved source keeps the reusable file reference'
);
select is(
  jsonb_array_length(public.list_my_zagulyaky_saved_source_presets_v1(null, 100)),
  1,
  'owner sees the new saved source preset'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"c5000000-0000-4000-8000-000000000002","role":"authenticated","email":"saved-input-other@example.test"}',
  true
);
select is(
  jsonb_array_length(public.list_my_zagulyaky_saved_places_v1(null, 100)),
  0,
  'another user cannot list the owner saved places'
);
select is(
  jsonb_array_length(public.list_my_zagulyaky_saved_source_presets_v1(null, 100)),
  0,
  'another user cannot list the owner saved source presets'
);
select is(
  (public.delete_my_zagulyaky_saved_place_v1(
    (select (result ->> 'id')::uuid from pgtap_saved_place)
  ) ->> 'deleted')::boolean,
  false,
  'another user cannot delete the owner saved place'
);

select * from finish();
rollback;
