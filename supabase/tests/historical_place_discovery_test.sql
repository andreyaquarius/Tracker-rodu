begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(31);

select has_table(
  'security_private', 'historical_place_reference_datasets',
  'versioned reference-dataset provenance table exists'
);
select has_table(
  'security_private', 'katottg_settlements',
  'offline KATOTTG settlement catalogue exists'
);
select has_table(
  'security_private', 'historical_place_discovery_cache',
  'external provider cache exists'
);
select has_table(
  'security_private', 'historical_place_provider_slots',
  'cross-instance provider scheduler exists'
);

select has_function(
  'public', 'search_katottg_settlements_v1', array['text', 'integer'],
  'authenticated KATOTTG search RPC exists'
);
select has_function(
  'public', 'get_historical_place_discovery_cache_v1', array['text', 'text'],
  'service cache lookup RPC exists'
);
select has_function(
  'public', 'put_historical_place_discovery_cache_v1',
  array['text', 'text', 'jsonb', 'integer', 'integer', 'text', 'jsonb'],
  'service cache upsert RPC exists'
);
select has_function(
  'public', 'acquire_historical_place_provider_slot_v1', array['text', 'integer'],
  'service provider-slot RPC exists'
);

select is(
  (
    select dataset.version
    from security_private.historical_place_reference_datasets dataset
    where dataset.provider = 'katottg' and dataset.is_active
  ),
  '2026-07-07',
  'the active catalogue is the official 07 July 2026 KATOTTG release'
);
select is(
  (
    select dataset.row_count
    from security_private.historical_place_reference_datasets dataset
    where dataset.dataset_key = 'katottg:2026-07-07'
  ),
  (
    select count(*)::integer
    from security_private.katottg_settlements settlement
    where settlement.dataset_key = 'katottg:2026-07-07'
  ),
  'declared catalogue row count matches the imported settlement rows'
);
select is(
  (
    select count(*)::integer
    from security_private.katottg_settlements settlement
    where settlement.dataset_key = 'katottg:2026-07-07'
  ),
  29701,
  'all 29,701 level-four settlements from the verified workbook are imported'
);
select is(
  (
    select dataset.source_sha256
    from security_private.historical_place_reference_datasets dataset
    where dataset.dataset_key = 'katottg:2026-07-07'
  ),
  '5c5317759b2b90208e9b00338bc3db3c5e694272a166acf73f1543b3e18ecbea',
  'the imported workbook checksum is recorded exactly'
);
select is(
  (
    select dataset.source_url
    from security_private.historical_place_reference_datasets dataset
    where dataset.dataset_key = 'katottg:2026-07-07'
  ),
  'https://mininfra.gov.ua/storage/app/sites/1/uploaded-files/kodifikator-07-07.xlsx',
  'the official KATOTTG workbook URL is retained as provenance'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.search_katottg_settlements_v1(text,integer)'::regprocedure,
    'EXECUTE'
  ),
  'authenticated users may search the local catalogue'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.search_katottg_settlements_v1(text,integer)'::regprocedure,
    'EXECUTE'
  ),
  'anonymous users cannot call the local catalogue RPC'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.get_historical_place_discovery_cache_v1(text,text)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.put_historical_place_discovery_cache_v1(text,text,jsonb,integer,integer,text,jsonb)'::regprocedure,
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.acquire_historical_place_provider_slot_v1(text,integer)'::regprocedure,
    'EXECUTE'
  ),
  'service role may use all provider infrastructure RPCs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_historical_place_discovery_cache_v1(text,text)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.put_historical_place_discovery_cache_v1(text,text,jsonb,integer,integer,text,jsonb)'::regprocedure,
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.acquire_historical_place_provider_slot_v1(text,integer)'::regprocedure,
    'EXECUTE'
  ),
  'browser users cannot call provider cache or scheduler RPCs'
);
select ok(
  not has_table_privilege(
    'authenticated', 'security_private.katottg_settlements', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'security_private.historical_place_discovery_cache', 'SELECT'
  ),
  'browser users cannot read the private provider tables directly'
);

create temporary table pgtap_katottg_search(payload jsonb) on commit drop;
grant select, insert on table pgtap_katottg_search to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fb100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$insert into pgtap_katottg_search(payload)
    select public.search_katottg_settlements_v1('Трубіївка', 3)$$,
  'authenticated KATOTTG search succeeds without an external network request'
);
select is(
  (select payload ->> 'count' from pgtap_katottg_search),
  '3',
  'the RPC honours its requested result limit'
);
select is(
  (select payload #>> '{items,0,name}' from pgtap_katottg_search),
  'Трубіївка',
  'an exact settlement name ranks first'
);
select is(
  (select payload #>> '{items,0,katottgCode}' from pgtap_katottg_search),
  'UA18020130320057622',
  'the exact result carries the official KATOTTG code'
);
select is(
  (select payload #>> '{dataset,version}' from pgtap_katottg_search),
  '2026-07-07',
  'search responses expose their reference dataset version'
);
select ok(
  (select payload -> 'items' -> 0 from pgtap_katottg_search)
    ?& array[
      'provider', 'category', 'placeType', 'country', 'region',
      'district', 'community', 'currentAdmin', 'matchedName',
      'score', 'sourceRowNumber'
    ],
  'search results provide the complete provider-neutral place projection'
);
select throws_ok(
  $$select public.search_katottg_settlements_v1(' ', 10)$$,
  '22023', 'KATOTTG_QUERY_INVALID',
  'blank catalogue queries are rejected before scanning the index'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.put_historical_place_discovery_cache_v1(
    'nominatim', 'pgtap:tubriivka',
    '{"items":[{"externalId":"relation/1"}]}'::jsonb,
    300, 200, 'https://nominatim.openstreetmap.org/search',
    '{"attribution":"OpenStreetMap contributors"}'::jsonb
  ) #>> '{payload,items,0,externalId}',
  'relation/1',
  'service role can store a bounded normalized provider response'
);
select ok(
  (public.get_historical_place_discovery_cache_v1(
    'nominatim', 'pgtap:tubriivka'
  ) ->> 'hit')::boolean,
  'a non-expired provider cache entry is returned as a hit'
);

reset role;
update security_private.historical_place_discovery_cache
set expires_at = fetched_at + interval '1 millisecond',
    fetched_at = clock_timestamp() - interval '1 minute'
where provider = 'nominatim' and cache_key = 'pgtap:tubriivka';

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  not (public.get_historical_place_discovery_cache_v1(
    'nominatim', 'pgtap:tubriivka'
  ) ->> 'hit')::boolean,
  'expired provider data is never returned as a cache hit'
);
select ok(
  (public.acquire_historical_place_provider_slot_v1(
    'pgtap_nominatim', 60000
  ) ->> 'waitMs')::integer >= 0,
  'the scheduler atomically reserves the first provider request slot'
);
select ok(
  (public.acquire_historical_place_provider_slot_v1(
    'pgtap_nominatim', 60000
  ) ->> 'waitMs')::integer > 0,
  'a concurrent provider reservation is deferred by the shared interval'
);
select throws_ok(
  $$select public.acquire_historical_place_provider_slot_v1('nominatim', 0)$$,
  '22023', 'PROVIDER_INTERVAL_INVALID',
  'an unsafe provider interval is rejected'
);

reset role;
select * from finish();
rollback;
