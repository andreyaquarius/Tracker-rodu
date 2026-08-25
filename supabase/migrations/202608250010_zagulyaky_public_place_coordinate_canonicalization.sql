begin;

-- Raw origin_geo/found_geo values are evidence and must remain unchanged.
-- A private canonical registry maps small variations of a confirmed pin to
-- one settlement identity used only by the public place explorer.
create table if not exists security_private.zagulyaky_canonical_places (
  id uuid primary key default gen_random_uuid(),
  normalized_label text not null,
  display_name text not null,
  latitude numeric not null check (latitude between -90 and 90),
  longitude numeric not null check (longitude between -180 and 180),
  point_source text not null,
  point_precision text not null,
  provider_name text,
  external_identifier text,
  alias_count integer not null default 1 check (alias_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists security_private.zagulyaky_canonical_place_aliases (
  raw_fingerprint text primary key check (raw_fingerprint ~ '^[0-9a-f]{32}$'),
  place_id uuid not null references security_private.zagulyaky_canonical_places(id) on delete restrict,
  raw_label text not null,
  normalized_label text not null,
  latitude numeric not null check (latitude between -90 and 90),
  longitude numeric not null check (longitude between -180 and 180),
  point_source text not null,
  point_precision text not null,
  provider_name text,
  external_identifier text,
  match_method text not null check (match_method in ('new', 'provider', 'nearby_label')),
  created_at timestamptz not null default now()
);

create index if not exists zagulyaky_canonical_places_label_idx
  on security_private.zagulyaky_canonical_places (normalized_label);
create index if not exists zagulyaky_canonical_place_aliases_place_idx
  on security_private.zagulyaky_canonical_place_aliases (place_id);
create index if not exists zagulyaky_canonical_place_aliases_provider_idx
  on security_private.zagulyaky_canonical_place_aliases (lower(provider_name), external_identifier)
  where point_source = 'search'
    and point_precision = 'settlement'
    and provider_name is not null
    and external_identifier is not null;

create or replace function security_private.normalize_zagulyaky_place_label_v1(
  p_label text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog
as $function$
  select nullif(
    regexp_replace(
      regexp_replace(lower(btrim(coalesce($1, ''))), '[[:space:]]+', ' ', 'g'),
      '[[:space:]]*,[[:space:]]*',
      ',',
      'g'
    ),
    ''
  );
$function$;

-- Fingerprint one exact confirmed pin. It identifies an alias, not a public
-- settlement, and therefore remains immutable and safe for a primary key.
create or replace function security_private.zagulyaky_raw_place_fingerprint_v1(
  p_geo jsonb
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  v_geo jsonb;
  v_label text;
  v_provider text;
  v_external_id text;
  v_latitude_text text;
  v_longitude_text text;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  v_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  v_label := security_private.normalize_zagulyaky_place_label_v1(v_geo ->> 'displayName');
  if v_label is null then
    return null;
  end if;

  v_provider := lower(btrim(coalesce(v_geo ->> 'provider', '')));
  v_external_id := btrim(coalesce(v_geo ->> 'externalId', ''));
  v_latitude_text := trim_scale((v_geo ->> 'latitude')::numeric)::text;
  v_longitude_text := trim_scale((v_geo ->> 'longitude')::numeric)::text;

  return md5(
    'raw-v1|' ||
    char_length(v_label)::text || ':' || v_label ||
    char_length(v_provider)::text || ':' || v_provider ||
    char_length(v_external_id)::text || ':' || v_external_id ||
    char_length(v_latitude_text)::text || ':' || v_latitude_text ||
    char_length(v_longitude_text)::text || ':' || v_longitude_text
  );
end;
$function$;

create or replace function security_private.zagulyaky_place_distance_km_v1(
  p_latitude_a numeric,
  p_longitude_a numeric,
  p_latitude_b numeric,
  p_longitude_b numeric
)
returns double precision
language sql
immutable
strict
security definer
set search_path = pg_catalog
as $function$
  select 111.195 * sqrt(
    power(($1 - $3)::double precision, 2) +
    power(
      (($2 - $4)::double precision) *
      cos(radians((($1 + $3) / 2)::double precision)),
      2
    )
  );
$function$;

-- Resolve or create one canonical place. Automatic merging is deliberately
-- narrow:
--   1. the same trusted catalogue settlement object may drift up to 5 km;
--   2. otherwise an identical label and pin within 50 m is the same result even
--      when a provider returned different technical IDs;
--   3. a full contextual settlement label (3+ comma-separated components) may
--      drift by at most 500 m. Wider or ambiguous matches stay separate.
-- Ambiguous multiple candidates are never merged silently.
create or replace function security_private.resolve_zagulyaky_canonical_place_v1(
  p_geo jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  v_geo jsonb;
  v_fingerprint text;
  v_label text;
  v_display_name text;
  v_provider text;
  v_external_id text;
  v_source text;
  v_precision text;
  v_latitude numeric;
  v_longitude numeric;
  v_label_parts integer;
  v_candidate_ids uuid[];
  v_place_id uuid;
  v_created_new_place boolean := false;
  v_match_method text := 'new';
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  v_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  v_fingerprint := security_private.zagulyaky_raw_place_fingerprint_v1(v_geo);
  v_label := security_private.normalize_zagulyaky_place_label_v1(v_geo ->> 'displayName');
  v_display_name := nullif(btrim(coalesce(v_geo ->> 'displayName', '')), '');
  if v_fingerprint is null or v_label is null or v_display_name is null then
    return null;
  end if;

  v_provider := lower(nullif(btrim(coalesce(v_geo ->> 'provider', '')), ''));
  v_external_id := nullif(btrim(coalesce(v_geo ->> 'externalId', '')), '');
  v_source := lower(coalesce(nullif(btrim(v_geo ->> 'source'), ''), 'unknown'));
  v_precision := lower(coalesce(nullif(btrim(v_geo ->> 'precision'), ''), 'unknown'));
  v_latitude := (v_geo ->> 'latitude')::numeric;
  v_longitude := (v_geo ->> 'longitude')::numeric;
  v_label_parts := coalesce(array_length(regexp_split_to_array(v_label, ','), 1), 1);

  -- Same-label resolutions are serialized so parallel record writes cannot
  -- create two nearby canonical rows before either alias becomes visible.
  perform pg_advisory_xact_lock(hashtextextended('zagulyaky-place-label|' || v_label, 0));
  if v_provider is not null and v_external_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(
      'zagulyaky-place-provider|' || v_provider || '|' || v_external_id,
      0
    ));
  end if;

  select place_alias.place_id
  into v_place_id
  from security_private.zagulyaky_canonical_place_aliases place_alias
  where place_alias.raw_fingerprint = v_fingerprint;
  if v_place_id is not null then
    return v_place_id;
  end if;

  if v_source = 'search'
    and v_precision = 'settlement'
    and v_provider is not null
    and v_external_id is not null then
    select array_agg(candidate.id order by candidate.distance_km, candidate.id)
    into v_candidate_ids
    from (
      select distinct
        place_row.id,
        security_private.zagulyaky_place_distance_km_v1(
          v_latitude,
          v_longitude,
          place_row.latitude,
          place_row.longitude
        ) as distance_km
      from security_private.zagulyaky_canonical_place_aliases place_alias
      join security_private.zagulyaky_canonical_places place_row
        on place_row.id = place_alias.place_id
      where place_alias.point_source = 'search'
        and place_alias.point_precision = 'settlement'
        and lower(place_alias.provider_name) = v_provider
        and place_alias.external_identifier = v_external_id
    ) candidate
    where candidate.distance_km <= 5;

    if coalesce(cardinality(v_candidate_ids), 0) = 1 then
      v_place_id := v_candidate_ids[1];
      v_match_method := 'provider';
    end if;
  end if;

  if v_place_id is null then
    select array_agg(candidate.id order by candidate.distance_km, candidate.id)
    into v_candidate_ids
    from (
      select
        place_row.id,
        security_private.zagulyaky_place_distance_km_v1(
          v_latitude,
          v_longitude,
          place_row.latitude,
          place_row.longitude
        ) as distance_km
      from security_private.zagulyaky_canonical_places place_row
      where place_row.normalized_label = v_label
    ) candidate
    where candidate.distance_km <= 0.05
      or (
        v_label_parts >= 3
        and candidate.distance_km <= 0.5
      );

    if coalesce(cardinality(v_candidate_ids), 0) = 1 then
      v_place_id := v_candidate_ids[1];
      v_match_method := 'nearby_label';
    end if;
  end if;

  if v_place_id is null then
    insert into security_private.zagulyaky_canonical_places (
      normalized_label,
      display_name,
      latitude,
      longitude,
      point_source,
      point_precision,
      provider_name,
      external_identifier,
      alias_count
    ) values (
      v_label,
      v_display_name,
      v_latitude,
      v_longitude,
      v_source,
      v_precision,
      v_provider,
      v_external_id,
      1
    )
    returning id into v_place_id;
    v_created_new_place := true;
  end if;

  insert into security_private.zagulyaky_canonical_place_aliases (
    raw_fingerprint,
    place_id,
    raw_label,
    normalized_label,
    latitude,
    longitude,
    point_source,
    point_precision,
    provider_name,
    external_identifier,
    match_method
  ) values (
    v_fingerprint,
    v_place_id,
    v_display_name,
    v_label,
    v_latitude,
    v_longitude,
    v_source,
    v_precision,
    v_provider,
    v_external_id,
    v_match_method
  )
  on conflict (raw_fingerprint) do nothing;

  if not found then
    if v_created_new_place then
      delete from security_private.zagulyaky_canonical_places place_row
      where place_row.id = v_place_id
        and not exists (
          select 1
          from security_private.zagulyaky_canonical_place_aliases place_alias
          where place_alias.place_id = place_row.id
        );
    end if;
    select place_alias.place_id
    into v_place_id
    from security_private.zagulyaky_canonical_place_aliases place_alias
    where place_alias.raw_fingerprint = v_fingerprint;
    return v_place_id;
  end if;

  if not v_created_new_place then
    update security_private.zagulyaky_canonical_places place_row
    -- The anchor never moves after creation. This prevents a chain of nearby
    -- aliases from gradually joining two genuinely different settlements.
    set alias_count = place_row.alias_count + 1,
        updated_at = now()
    where place_row.id = v_place_id;
  end if;

  return v_place_id;
end;
$function$;

create or replace function security_private.register_zagulyaky_canonical_places_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  if new.kind <> 'person'
    or new.status <> 'published'
    or new.privacy_status <> 'cleared'
    or (
      new.possible_living_person
      and not security_private.zagulyaky_has_living_person_clearance_v1(new.id)
    ) then
    return new;
  end if;

  perform security_private.resolve_zagulyaky_canonical_place_v1(new.origin_geo);
  perform security_private.resolve_zagulyaky_canonical_place_v1(new.found_geo);
  return new;
end;
$function$;

drop trigger if exists zagulyaky_records_register_canonical_places
  on public.zagulyaky_records;
create trigger zagulyaky_records_register_canonical_places
after insert or update of origin_geo, found_geo, payload, kind, status, privacy_status, possible_living_person
on public.zagulyaky_records
for each row execute function security_private.register_zagulyaky_canonical_places_v1();

-- Install the trigger before the backfill so a record published concurrently
-- with the migration cannot fall into a gap between the scan and trigger.
-- Only already-public person pins participate; drafts and privacy-blocked
-- records cannot influence a public settlement identity.
do $backfill$
declare
  point_row record;
begin
  for point_row in
    select record_point.geo
    from (
      select
        record_row.id,
        0 as point_order,
        record_row.origin_geo as geo
      from public.zagulyaky_records record_row
      where record_row.kind = 'person'
        and record_row.status = 'published'
        and record_row.privacy_status = 'cleared'
        and record_row.origin_geo is not null
        and (
          not record_row.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
        )

      union all

      select
        record_row.id,
        1 as point_order,
        record_row.found_geo as geo
      from public.zagulyaky_records record_row
      where record_row.kind = 'person'
        and record_row.status = 'published'
        and record_row.privacy_status = 'cleared'
        and record_row.found_geo is not null
        and (
          not record_row.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
        )
    ) record_point
    order by
      case
        when record_point.geo ->> 'source' = 'search'
          and record_point.geo ->> 'precision' = 'settlement'
          and nullif(btrim(coalesce(record_point.geo ->> 'externalId', '')), '') is not null
          then 0
        else 1
      end,
      record_point.id,
      record_point.point_order
  loop
    perform security_private.resolve_zagulyaky_canonical_place_v1(point_row.geo);
  end loop;
end;
$backfill$;

-- The v1 indexes contain the old exact-coordinate identity. The canonical
-- resolver is table-backed and STABLE, so expression indexes over it would be
-- invalid; alias lookup is instead covered by the alias primary key.
drop index if exists public.zagulyaky_records_public_person_origin_place_key_idx;
drop index if exists public.zagulyaky_records_public_person_found_place_key_idx;

create or replace function security_private.zagulyaky_public_place_key_v1(
  p_geo jsonb
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  v_fingerprint text;
  v_place_id uuid;
begin
  v_fingerprint := security_private.zagulyaky_raw_place_fingerprint_v1(p_geo);
  if v_fingerprint is null then
    return null;
  end if;

  select place_alias.place_id
  into v_place_id
  from security_private.zagulyaky_canonical_place_aliases place_alias
  where place_alias.raw_fingerprint = v_fingerprint;

  if v_place_id is null then
    return null;
  end if;
  return md5('canonical-place-v1|' || v_place_id::text);
end;
$function$;

create or replace function security_private.zagulyaky_public_place_point_v1(
  p_geo jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  v_geo jsonb;
  v_display_name text;
  v_place_key text;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  v_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  v_display_name := nullif(btrim(coalesce(v_geo ->> 'displayName', '')), '');
  v_place_key := security_private.zagulyaky_public_place_key_v1(v_geo);
  if v_display_name is null or v_place_key is null then
    return null;
  end if;

  -- Label and coordinates come only from the current visible record supplied
  -- by the public RPC. The private registry contributes the opaque grouping
  -- key only, so a draft or formerly-public alias can never become map data.
  return jsonb_build_object(
    'key', v_place_key,
    'label', v_display_name,
    'geo', jsonb_build_object(
      'displayName', v_display_name,
      'latitude', v_geo -> 'latitude',
      'longitude', v_geo -> 'longitude',
      'precision', v_geo -> 'precision'
    )
  );
end;
$function$;

comment on table security_private.zagulyaky_canonical_places is
  'Private canonical settlement registry for confirmed Zagulyaky origin/found pins. Never expose through PostgREST.';
comment on table security_private.zagulyaky_canonical_place_aliases is
  'Maps exact confirmed pin fingerprints to canonical settlements without changing source record coordinates.';
comment on function security_private.zagulyaky_public_place_key_v1(jsonb) is
  'Returns the opaque canonical settlement key for a registered confirmed pin.';
comment on function security_private.zagulyaky_public_place_point_v1(jsonb) is
  'Returns the visible record point plus an opaque canonical grouping key; private registry coordinates are never projected.';

revoke all on table
  security_private.zagulyaky_canonical_places,
  security_private.zagulyaky_canonical_place_aliases
  from public, anon, authenticated, service_role;

revoke all on function
  security_private.normalize_zagulyaky_place_label_v1(text),
  security_private.zagulyaky_raw_place_fingerprint_v1(jsonb),
  security_private.zagulyaky_place_distance_km_v1(numeric, numeric, numeric, numeric),
  security_private.resolve_zagulyaky_canonical_place_v1(jsonb),
  security_private.register_zagulyaky_canonical_places_v1(),
  security_private.zagulyaky_public_place_key_v1(jsonb),
  security_private.zagulyaky_public_place_point_v1(jsonb)
  from public, anon, authenticated, service_role;

analyze security_private.zagulyaky_canonical_places;
analyze security_private.zagulyaky_canonical_place_aliases;

notify pgrst, 'reload schema';

commit;
