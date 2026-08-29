-- Historical-place discovery: an offline KATOTTG settlement catalogue plus
-- server-only provider cache and an atomic cross-instance request scheduler.
--
-- The generated seed below is reproducible with:
--   node scripts/generate-katottg-discovery-migration.mjs
-- The script writes one checked-in seed migration so deployment never depends
-- on a workstation-local file or on the upstream XLSX remaining online.

create schema if not exists security_private;
create extension if not exists pg_trgm with schema extensions;

create table if not exists security_private.historical_place_reference_datasets (
  dataset_key text primary key,
  provider text not null,
  version text not null,
  published_on date,
  order_number text,
  source_page_url text not null,
  source_url text not null,
  source_sha256 text not null,
  retrieved_at timestamptz not null,
  row_count integer not null default 0,
  is_active boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint historical_place_reference_datasets_key_check
    check (dataset_key ~ '^[a-z][a-z0-9_-]{1,31}:[A-Za-z0-9._-]{1,63}$'),
  constraint historical_place_reference_datasets_provider_check
    check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  constraint historical_place_reference_datasets_version_check
    check (char_length(version) between 1 and 64),
  constraint historical_place_reference_datasets_order_number_check
    check (order_number is null or char_length(order_number) <= 64),
  constraint historical_place_reference_datasets_source_page_check
    check (source_page_url ~ '^https://'),
  constraint historical_place_reference_datasets_source_check
    check (source_url ~ '^https://'),
  constraint historical_place_reference_datasets_sha256_check
    check (source_sha256 ~ '^[0-9a-f]{64}$'),
  constraint historical_place_reference_datasets_row_count_check
    check (row_count >= 0),
  constraint historical_place_reference_datasets_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 50000),
  unique (provider, version)
);

create unique index if not exists historical_place_reference_datasets_one_active_idx
  on security_private.historical_place_reference_datasets (provider)
  where is_active;

create table if not exists security_private.katottg_settlements (
  id bigint generated always as identity primary key,
  dataset_key text not null
    references security_private.historical_place_reference_datasets(dataset_key)
    on delete cascade,
  katottg_code text not null,
  name text not null,
  category text not null,
  level1_code text,
  level2_code text,
  level3_code text,
  level4_code text not null,
  region_name text,
  district_name text,
  community_name text,
  source_row_number integer not null,
  normalized_name text generated always as (
    public.historical_place_search_normalize_v1(name)
  ) stored,
  search_text text generated always as (
    public.historical_place_search_normalize_v1(
      name || ' '
      || coalesce(community_name, '') || ' '
      || coalesce(district_name, '') || ' '
      || coalesce(region_name, '') || ' '
      || katottg_code
    )
  ) stored,
  created_at timestamptz not null default now(),
  constraint katottg_settlements_code_check
    check (katottg_code ~ '^UA[0-9]{17}$'),
  constraint katottg_settlements_name_check
    check (char_length(btrim(name)) between 1 and 500),
  constraint katottg_settlements_category_check
    check (category in ('M', 'T', 'C', 'X')),
  constraint katottg_settlements_level_codes_check
    check (
      (level1_code is null or level1_code ~ '^UA[0-9]{17}$')
      and (level2_code is null or level2_code ~ '^UA[0-9]{17}$')
      and (level3_code is null or level3_code ~ '^UA[0-9]{17}$')
      and level4_code ~ '^UA[0-9]{17}$'
      and level4_code = katottg_code
    ),
  constraint katottg_settlements_source_row_check
    check (source_row_number > 0),
  unique (dataset_key, katottg_code)
);

create index if not exists katottg_settlements_dataset_name_idx
  on security_private.katottg_settlements (dataset_key, normalized_name, katottg_code);
create index if not exists katottg_settlements_normalized_name_trgm_idx
  on security_private.katottg_settlements
  using gin (normalized_name extensions.gin_trgm_ops);
create index if not exists katottg_settlements_search_text_trgm_idx
  on security_private.katottg_settlements
  using gin (search_text extensions.gin_trgm_ops);

create table if not exists security_private.historical_place_discovery_cache (
  provider text not null,
  cache_key text not null,
  payload jsonb not null,
  response_status integer not null default 200,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  source_url text,
  metadata jsonb not null default '{}'::jsonb,
  primary key (provider, cache_key),
  constraint historical_place_discovery_cache_provider_check
    check (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  constraint historical_place_discovery_cache_key_check
    check (char_length(cache_key) between 1 and 200),
  constraint historical_place_discovery_cache_payload_check
    check (payload <> 'null'::jsonb and octet_length(payload::text) <= 2000000),
  constraint historical_place_discovery_cache_status_check
    check (response_status between 100 and 599),
  constraint historical_place_discovery_cache_expiry_check
    check (expires_at > fetched_at),
  constraint historical_place_discovery_cache_source_url_check
    check (source_url is null or (source_url ~ '^https://' and char_length(source_url) <= 2000)),
  constraint historical_place_discovery_cache_metadata_check
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 50000)
);

create index if not exists historical_place_discovery_cache_expiry_idx
  on security_private.historical_place_discovery_cache (expires_at);

create table if not exists security_private.historical_place_provider_slots (
  provider text primary key,
  next_available_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint historical_place_provider_slots_provider_check
    check (provider ~ '^[a-z][a-z0-9_-]{1,31}$')
);

comment on table security_private.historical_place_reference_datasets is
  'Versioned provenance for read-only external reference catalogues used by historical-place discovery.';
comment on table security_private.katottg_settlements is
  'Level-four Ukrainian settlements imported losslessly from a specific official KATOTTG workbook.';
comment on table security_private.historical_place_discovery_cache is
  'Service-role-only cache for normalized external place-provider responses.';
comment on table security_private.historical_place_provider_slots is
  'Atomic cross-instance request-start scheduler for external provider rate limits.';

-- BEGIN GENERATED KATOTTG 2026-07-07 SETTLEMENT SEED
-- Seeded by the next migration; regenerate both files with the script above.
-- END GENERATED KATOTTG 2026-07-07 SETTLEMENT SEED

create or replace function security_private.require_historical_place_service_role_v1()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, auth, pg_temp
as $function$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
end;
$function$;

create or replace function security_private.search_katottg_settlements_api_v1(
  p_query text,
  p_limit integer default 10
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, security_private, auth, pg_temp
set statement_timeout = '5s'
as $function$
declare
  requested_query text := btrim(coalesce(p_query, ''));
  normalized_query text;
  bounded_limit integer := least(greatest(coalesce(p_limit, 10), 1), 20);
  active_dataset security_private.historical_place_reference_datasets;
  items jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'service_role') then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if char_length(requested_query) < 2 or char_length(requested_query) > 120 then
    raise exception 'KATOTTG_QUERY_INVALID' using errcode = '22023';
  end if;

  normalized_query := public.historical_place_search_normalize_v1(requested_query);
  if normalized_query = '' then
    raise exception 'KATOTTG_QUERY_INVALID' using errcode = '22023';
  end if;

  select dataset.*
  into active_dataset
  from security_private.historical_place_reference_datasets dataset
  where dataset.provider = 'katottg' and dataset.is_active
  order by dataset.published_on desc nulls last, dataset.version desc
  limit 1;

  if active_dataset.dataset_key is not null then
    with scored as (
      select
        settlement.*,
        case settlement.category
          when 'M' then 'city'
          when 'T' then 'urban_settlement'
          when 'C' then 'village'
          else 'settlement'
        end as place_type,
        greatest(
          case
            when upper(settlement.katottg_code) = upper(requested_query) then 1.0
            when upper(settlement.katottg_code) like upper(requested_query) || '%' then 0.98
            when settlement.normalized_name = normalized_query then 0.96
            when settlement.normalized_name like normalized_query || '%' then 0.90
            when settlement.normalized_name like '%' || normalized_query || '%' then 0.78
            else 0.0
          end,
          extensions.similarity(settlement.normalized_name, normalized_query),
          extensions.similarity(settlement.search_text, normalized_query) * 0.9
        )::numeric as score
      from security_private.katottg_settlements settlement
      where settlement.dataset_key = active_dataset.dataset_key
        and (
          upper(settlement.katottg_code) like upper(requested_query) || '%'
          or settlement.normalized_name like '%' || normalized_query || '%'
          or settlement.search_text like '%' || normalized_query || '%'
          or settlement.normalized_name % normalized_query
          or settlement.search_text % normalized_query
        )
    ), limited as (
      select scored.*
      from scored
      where scored.score >= 0.22
      order by scored.score desc, char_length(scored.name), scored.name, scored.katottg_code
      limit bounded_limit
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'provider', 'katottg',
          'katottgCode', limited.katottg_code,
          'name', limited.name,
          'category', limited.category,
          'placeType', limited.place_type,
          'country', 'Україна',
          'region', case when limited.level1_code is null then null else
            jsonb_build_object('code', limited.level1_code, 'name', limited.region_name) end,
          'district', case when limited.level2_code is null then null else
            jsonb_build_object('code', limited.level2_code, 'name', limited.district_name) end,
          'community', case when limited.level3_code is null then null else
            jsonb_build_object('code', limited.level3_code, 'name', limited.community_name) end,
          'currentAdmin', concat_ws(', ',
            nullif(limited.community_name, ''),
            nullif(limited.district_name, ''),
            nullif(limited.region_name, '')
          ),
          'matchedName', limited.name,
          'score', round(limited.score, 4),
          'sourceRowNumber', limited.source_row_number
        ) order by limited.score desc, limited.name, limited.katottg_code
      ),
      '[]'::jsonb
    )
    into items
    from limited;
  end if;

  return jsonb_build_object(
    'query', requested_query,
    'normalizedQuery', normalized_query,
    'count', jsonb_array_length(items),
    'dataset', case when active_dataset.dataset_key is null then null else
      jsonb_build_object(
        'provider', active_dataset.provider,
        'version', active_dataset.version,
        'publishedOn', active_dataset.published_on,
        'orderNumber', active_dataset.order_number,
        'sourcePageUrl', active_dataset.source_page_url,
        'sourceUrl', active_dataset.source_url,
        'sha256', active_dataset.source_sha256
      ) end,
    'items', items
  );
end;
$function$;

create or replace function public.search_katottg_settlements_v1(
  p_query text,
  p_limit integer default 10
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.search_katottg_settlements_api_v1(p_query, p_limit);
$function$;

create or replace function public.get_historical_place_discovery_cache_v1(
  p_provider text,
  p_cache_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, auth, pg_temp
set statement_timeout = '3s'
as $function$
declare
  requested_provider text := lower(btrim(coalesce(p_provider, '')));
  requested_cache_key text := btrim(coalesce(p_cache_key, ''));
  cached security_private.historical_place_discovery_cache;
begin
  perform security_private.require_historical_place_service_role_v1();
  if requested_provider !~ '^[a-z][a-z0-9_-]{1,31}$'
     or char_length(requested_cache_key) not between 1 and 200 then
    raise exception 'DISCOVERY_CACHE_KEY_INVALID' using errcode = '22023';
  end if;

  select cache_row.*
  into cached
  from security_private.historical_place_discovery_cache cache_row
  where cache_row.provider = requested_provider
    and cache_row.cache_key = requested_cache_key
    and cache_row.expires_at > clock_timestamp();

  if cached.provider is null then
    return jsonb_build_object(
      'hit', false,
      'provider', requested_provider,
      'cacheKey', requested_cache_key
    );
  end if;

  return jsonb_build_object(
    'hit', true,
    'provider', cached.provider,
    'cacheKey', cached.cache_key,
    'payload', cached.payload,
    'responseStatus', cached.response_status,
    'fetchedAt', cached.fetched_at,
    'expiresAt', cached.expires_at,
    'sourceUrl', cached.source_url,
    'metadata', cached.metadata
  );
end;
$function$;

create or replace function public.put_historical_place_discovery_cache_v1(
  p_provider text,
  p_cache_key text,
  p_payload jsonb,
  p_ttl_seconds integer,
  p_response_status integer default 200,
  p_source_url text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, auth, pg_temp
set statement_timeout = '3s'
as $function$
declare
  requested_provider text := lower(btrim(coalesce(p_provider, '')));
  requested_cache_key text := btrim(coalesce(p_cache_key, ''));
  written security_private.historical_place_discovery_cache;
  fetched_time timestamptz := clock_timestamp();
begin
  perform security_private.require_historical_place_service_role_v1();
  if requested_provider !~ '^[a-z][a-z0-9_-]{1,31}$'
     or char_length(requested_cache_key) not between 1 and 200 then
    raise exception 'DISCOVERY_CACHE_KEY_INVALID' using errcode = '22023';
  end if;
  if p_payload is null or p_payload = 'null'::jsonb
     or octet_length(p_payload::text) > 2000000 then
    raise exception 'DISCOVERY_CACHE_PAYLOAD_INVALID' using errcode = '22023';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 1 and 7776000 then
    raise exception 'DISCOVERY_CACHE_TTL_INVALID' using errcode = '22023';
  end if;
  if p_response_status is null or p_response_status not between 100 and 599 then
    raise exception 'DISCOVERY_CACHE_STATUS_INVALID' using errcode = '22023';
  end if;
  if p_source_url is not null
     and (p_source_url !~ '^https://' or char_length(p_source_url) > 2000) then
    raise exception 'DISCOVERY_CACHE_SOURCE_URL_INVALID' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_metadata), '') <> 'object'
     or octet_length(p_metadata::text) > 50000 then
    raise exception 'DISCOVERY_CACHE_METADATA_INVALID' using errcode = '22023';
  end if;

  insert into security_private.historical_place_discovery_cache (
    provider, cache_key, payload, response_status, fetched_at,
    expires_at, source_url, metadata
  ) values (
    requested_provider, requested_cache_key, p_payload, p_response_status,
    fetched_time, fetched_time + p_ttl_seconds * interval '1 second',
    p_source_url, p_metadata
  )
  on conflict (provider, cache_key) do update set
    payload = excluded.payload,
    response_status = excluded.response_status,
    fetched_at = excluded.fetched_at,
    expires_at = excluded.expires_at,
    source_url = excluded.source_url,
    metadata = excluded.metadata
  returning * into written;

  return jsonb_build_object(
    'hit', true,
    'provider', written.provider,
    'cacheKey', written.cache_key,
    'payload', written.payload,
    'responseStatus', written.response_status,
    'fetchedAt', written.fetched_at,
    'expiresAt', written.expires_at,
    'sourceUrl', written.source_url,
    'metadata', written.metadata
  );
end;
$function$;

create or replace function public.acquire_historical_place_provider_slot_v1(
  p_provider text,
  p_min_interval_ms integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, auth, pg_temp
set statement_timeout = '3s'
as $function$
declare
  requested_provider text := lower(btrim(coalesce(p_provider, '')));
  observed_at timestamptz;
  previous_next_available timestamptz;
  scheduled_at timestamptz;
  next_available timestamptz;
  wait_ms integer;
begin
  perform security_private.require_historical_place_service_role_v1();
  if requested_provider !~ '^[a-z][a-z0-9_-]{1,31}$' then
    raise exception 'PROVIDER_INVALID' using errcode = '22023';
  end if;
  if p_min_interval_ms is null or p_min_interval_ms not between 1 and 60000 then
    raise exception 'PROVIDER_INTERVAL_INVALID' using errcode = '22023';
  end if;

  insert into security_private.historical_place_provider_slots (
    provider, next_available_at, updated_at
  ) values (
    requested_provider, clock_timestamp(), clock_timestamp()
  ) on conflict (provider) do nothing;

  select slot.next_available_at
  into previous_next_available
  from security_private.historical_place_provider_slots slot
  where slot.provider = requested_provider
  for update;

  observed_at := clock_timestamp();
  scheduled_at := greatest(observed_at, previous_next_available);
  next_available := scheduled_at + p_min_interval_ms * interval '1 millisecond';
  wait_ms := greatest(
    0,
    ceil(extract(epoch from (scheduled_at - observed_at)) * 1000.0)::integer
  );

  update security_private.historical_place_provider_slots slot
  set next_available_at = next_available,
      updated_at = observed_at
  where slot.provider = requested_provider;

  return jsonb_build_object(
    'provider', requested_provider,
    'reserved', true,
    'scheduledAt', scheduled_at,
    'waitMs', wait_ms,
    'nextAvailableAt', next_available,
    'minIntervalMs', p_min_interval_ms
  );
end;
$function$;

revoke all on table security_private.historical_place_reference_datasets
  from public, anon, authenticated;
revoke all on table security_private.katottg_settlements
  from public, anon, authenticated;
revoke all on table security_private.historical_place_discovery_cache
  from public, anon, authenticated;
revoke all on table security_private.historical_place_provider_slots
  from public, anon, authenticated;

grant all on table security_private.historical_place_reference_datasets to service_role;
grant all on table security_private.katottg_settlements to service_role;
grant all on table security_private.historical_place_discovery_cache to service_role;
grant all on table security_private.historical_place_provider_slots to service_role;
grant usage, select on sequence security_private.katottg_settlements_id_seq to service_role;

revoke all on function security_private.require_historical_place_service_role_v1()
  from public, anon, authenticated;
grant execute on function security_private.require_historical_place_service_role_v1()
  to service_role;

revoke all on function security_private.search_katottg_settlements_api_v1(text,integer)
  from public, anon;
grant execute on function security_private.search_katottg_settlements_api_v1(text,integer)
  to authenticated, service_role;

revoke all on function public.search_katottg_settlements_v1(text,integer)
  from public, anon;
grant execute on function public.search_katottg_settlements_v1(text,integer)
  to authenticated, service_role;

revoke all on function public.get_historical_place_discovery_cache_v1(text,text)
  from public, anon, authenticated;
revoke all on function public.put_historical_place_discovery_cache_v1(text,text,jsonb,integer,integer,text,jsonb)
  from public, anon, authenticated;
revoke all on function public.acquire_historical_place_provider_slot_v1(text,integer)
  from public, anon, authenticated;
grant execute on function public.get_historical_place_discovery_cache_v1(text,text)
  to service_role;
grant execute on function public.put_historical_place_discovery_cache_v1(text,text,jsonb,integer,integer,text,jsonb)
  to service_role;
grant execute on function public.acquire_historical_place_provider_slot_v1(text,integer)
  to service_role;

comment on function security_private.search_katottg_settlements_api_v1(text,integer) is
  'Elevated implementation for authenticated search in the active official KATOTTG settlement snapshot.';
comment on function public.search_katottg_settlements_v1(text,integer) is
  'Security-invoker facade for local authenticated KATOTTG settlement search; no external request is made.';
comment on function public.get_historical_place_discovery_cache_v1(text,text) is
  'Service-role-only non-expired provider cache lookup.';
comment on function public.put_historical_place_discovery_cache_v1(text,text,jsonb,integer,integer,text,jsonb) is
  'Service-role-only provider cache upsert with a bounded TTL.';
comment on function public.acquire_historical_place_provider_slot_v1(text,integer) is
  'Atomically reserves a provider request-start time across Edge Function instances.';

analyze security_private.historical_place_reference_datasets;
analyze security_private.katottg_settlements;
