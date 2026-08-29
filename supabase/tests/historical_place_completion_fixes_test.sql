begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'f9100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'place-completion@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'f9100000-0000-4000-8000-000000000001',
  'place-completion@example.test',
  'Place completion owner'
)
on conflict (user_id) do update set
  email = excluded.email,
  display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values (
  'f9200000-0000-4000-8000-000000000001',
  'f9100000-0000-4000-8000-000000000001',
  'Historical place completion project'
);

insert into public.places (
  id, project_id, canonical_name, status, verification_status,
  is_public, published_at, created_by
) values
(
  'f9300000-0000-4000-8000-000000000001', null,
  'Відкрита губернія', 'active', 'verified', true, now(),
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9300000-0000-4000-8000-000000000002', null,
  'Відкритий повіт', 'active', 'verified', true, now(),
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9300000-0000-4000-8000-000000000003', null,
  'Відкрите село', 'active', 'verified', true, now(),
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9300000-0000-4000-8000-000000000004',
  'f9200000-0000-4000-8000-000000000001',
  'Приватне село', 'active', 'unverified', false, null,
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9300000-0000-4000-8000-000000000005',
  'f9200000-0000-4000-8000-000000000001',
  'Місце для архівації', 'active', 'unverified', false, null,
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9300000-0000-4000-8000-000000000006',
  'f9200000-0000-4000-8000-000000000001',
  'Місце із зовнішніми ID', 'active', 'unverified', false, null,
  'f9100000-0000-4000-8000-000000000001'
);

insert into public.place_hierarchy_relations (
  id, child_place_id, parent_place_id, relation_type, created_by
) values
(
  'f9400000-0000-4000-8000-000000000001',
  'f9300000-0000-4000-8000-000000000002',
  'f9300000-0000-4000-8000-000000000001',
  'administrative_parent',
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9400000-0000-4000-8000-000000000002',
  'f9300000-0000-4000-8000-000000000003',
  'f9300000-0000-4000-8000-000000000002',
  'administrative_parent',
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9400000-0000-4000-8000-000000000003',
  'f9300000-0000-4000-8000-000000000004',
  'f9300000-0000-4000-8000-000000000002',
  'administrative_parent',
  'f9100000-0000-4000-8000-000000000001'
);

insert into public.place_external_identifiers (
  id, place_id, provider, external_identifier, is_primary, created_by
) values
(
  'f9500000-0000-4000-8000-000000000001',
  'f9300000-0000-4000-8000-000000000006',
  'wikidata', 'Q123456', true,
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9500000-0000-4000-8000-000000000002',
  'f9300000-0000-4000-8000-000000000006',
  'geonames', '987654', true,
  'f9100000-0000-4000-8000-000000000001'
),
(
  'f9500000-0000-4000-8000-000000000003',
  'f9300000-0000-4000-8000-000000000006',
  'archive_catalogue', 'CAT-42', false,
  'f9100000-0000-4000-8000-000000000001'
);

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select lives_ok(
  $$select public.search_places_v2(
    '', null, null, null, null, null, 20,
    'f9300000-0000-4000-8000-000000000002', null, null, null
  )$$,
  'anonymous search without a date succeeds for a public historical-place branch'
);

select is(
  jsonb_array_length(public.search_places_v2(
    '', null, null, null, null, null, 20,
    'f9300000-0000-4000-8000-000000000002', null, null, null
  )),
  1,
  'anonymous ancestor search returns only the public descendant'
);

select is(
  public.search_places_v2(
    '', null, null, null, null, null, 20,
    'f9300000-0000-4000-8000-000000000002', null, null, null
  ) #>> '{0,id}',
  'f9300000-0000-4000-8000-000000000003',
  'the public descendant remains searchable when no historical date is supplied'
);

select ok(
  public.search_places_v2(
    '', null, null, null, null, null, 20,
    'f9300000-0000-4000-8000-000000000002', null, null, null
  )::text not like '%Приватне село%'
  and public.search_places_v2(
    '', null, null, null, null, null, 20,
    'f9300000-0000-4000-8000-000000000002', null, null, null
  )::text not like '%f9300000-0000-4000-8000-000000000004%',
  'anonymous recursive search does not disclose a project-private relation or place'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"f9100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

create temporary table _historical_place_create_result(payload jsonb) on commit drop;

select lives_ok(
  $$insert into _historical_place_create_result(payload)
    select public.create_project_place_v2(
      'f9200000-0000-4000-8000-000000000001',
      '{
        "canonicalName":"Архівне атомарне місце",
        "placeType":"village",
        "status":"archived",
        "parentRelation":{
          "parentPlaceId":"f9300000-0000-4000-8000-000000000002",
          "relationType":"administrative_parent",
          "validFromText":"до 1917 року",
          "validFromPrecision":"before",
          "confidence":90
        }
      }'::jsonb
    )$$,
  'place, primary type, parent relation and archived status are created atomically'
);

select is(
  (select status from public.places
   where id = (select (payload #>> '{place,id}')::uuid from _historical_place_create_result)),
  'archived',
  'atomic create applies the final archived lifecycle status after child writes'
);

select is(
  (select place_type_code from public.place_type_assignments
   where place_id = (select (payload #>> '{place,id}')::uuid from _historical_place_create_result)
     and is_primary),
  'village',
  'atomic create retains the selected primary place type'
);

select is(
  (select parent_place_id::text from public.place_hierarchy_relations
   where child_place_id = (select (payload #>> '{place,id}')::uuid from _historical_place_create_result)),
  'f9300000-0000-4000-8000-000000000002',
  'atomic create retains its dated administrative parent relation'
);

select lives_ok(
  $$do $atomic_failure$
    begin
      perform public.create_project_place_v2(
        'f9200000-0000-4000-8000-000000000001',
        '{
          "canonicalName":"Місце для перевірки відкату",
          "placeType":"village",
          "parentRelation":{
            "parentPlaceId":"f9300000-0000-4000-8000-000000000099"
          }
        }'::jsonb
      );
    exception when others then
      null;
    end
  $atomic_failure$;$$,
  'a rejected parent relation can be caught by the caller without aborting the test transaction'
);

select is(
  (select count(*) from public.places where canonical_name = 'Місце для перевірки відкату'),
  0::bigint,
  'a failed parent relation rolls back the newly created Place instead of leaving a duplicate candidate'
);

select lives_ok(
  $$select public.patch_project_place_v2(
    'f9300000-0000-4000-8000-000000000005', 1,
    '{"status":"archived","placeType":"village"}'::jsonb
  )$$,
  'one patch can synchronize the primary type before archiving the place'
);

select is(
  (select status from public.places
   where id = 'f9300000-0000-4000-8000-000000000005'),
  'archived',
  'the combined type-and-archive patch persists the archived lifecycle status'
);

select is(
  (select place_type_code from public.place_type_assignments
   where place_id = 'f9300000-0000-4000-8000-000000000005'
     and is_primary),
  'village',
  'the combined type-and-archive patch persists the selected primary type'
);

select lives_ok(
  $$select public.patch_project_place_v2(
    'f9300000-0000-4000-8000-000000000006', 1,
    '{"wikidataId":"","geonamesId":"","externalIds":[]}'::jsonb
  )$$,
  'clearing every external identifier through the profile patch succeeds'
);

select is(
  (select count(*) from public.place_external_identifiers
   where place_id = 'f9300000-0000-4000-8000-000000000006'
     and lower(provider) in ('wikidata','geonames')),
  0::bigint,
  'blank dedicated Wikidata and GeoNames values delete their stored rows'
);

select is(
  (select count(*) from public.place_external_identifiers
   where place_id = 'f9300000-0000-4000-8000-000000000006'
     and lower(provider) not in ('wikidata','geonames')),
  0::bigint,
  'an empty generic externalIds collection deletes obsolete provider rows'
);

select is(
  jsonb_array_length(
    public.list_place_hierarchy_history_v1(
      'f9300000-0000-4000-8000-000000000004'
    ) #> '{0,hierarchy}'
  ),
  2,
  'each hierarchy-history period contains the complete parent chain'
);

select is(
  (public.list_place_hierarchy_history_v1(
    'f9300000-0000-4000-8000-000000000004'
  ) #>> '{0,hierarchy,0,place,canonicalName}')
  || ' > '
  || (public.list_place_hierarchy_history_v1(
    'f9300000-0000-4000-8000-000000000004'
  ) #>> '{0,hierarchy,1,place,canonicalName}'),
  'Відкритий повіт > Відкрита губернія',
  'history preserves the ordered county-to-province chain instead of only the direct parent'
);

select * from finish();
rollback;
