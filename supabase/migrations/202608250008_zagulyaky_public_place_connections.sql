begin;

-- Public settlement connections are built only from contributor-confirmed map
-- points.  The free-text source/found fields remain valuable historical
-- wording, but are deliberately never used to guess a point or create a map
-- line.  A point without a label and coordinates is therefore not a public
-- place in this feature.
create or replace function security_private.zagulyaky_public_place_key_v1(
  p_geo jsonb
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  canonical_geo jsonb;
  display_name text;
  provider_name text;
  external_identifier text;
  latitude_value numeric;
  longitude_value numeric;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  -- Reuse the existing strict, whitelist-only point normalizer.  This makes
  -- the key insensitive to JSON field order and rejects arbitrary payloads.
  canonical_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  display_name := nullif(btrim(coalesce(canonical_geo ->> 'displayName', '')), '');
  if display_name is null then
    return null;
  end if;

  provider_name := lower(btrim(coalesce(canonical_geo ->> 'provider', '')));
  external_identifier := btrim(coalesce(canonical_geo ->> 'externalId', ''));
  latitude_value := (canonical_geo ->> 'latitude')::numeric;
  longitude_value := (canonical_geo ->> 'longitude')::numeric;

  -- The selector receives an opaque key rather than database IDs.  It is a
  -- stable identity over the confirmed provider/external-id/coordinates/name,
  -- never a fuzzy match over a human-entered text field.
  -- Prefix every component with its length so an arbitrary external ID cannot
  -- make two different points share a delimiter-based identity.
  return md5(
    char_length(provider_name)::text || ':' || provider_name ||
    char_length(external_identifier)::text || ':' || external_identifier ||
    char_length(trim_scale(latitude_value)::text)::text || ':' || trim_scale(latitude_value)::text ||
    char_length(trim_scale(longitude_value)::text)::text || ':' || trim_scale(longitude_value)::text ||
    char_length(lower(display_name))::text || ':' || lower(display_name)
  );
end;
$function$;

create or replace function security_private.zagulyaky_public_place_point_v1(
  p_geo jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  canonical_geo jsonb;
  display_name text;
  place_key text;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;

  canonical_geo := security_private.normalize_zagulyaky_geo_point_v1(p_geo);
  display_name := nullif(btrim(coalesce(canonical_geo ->> 'displayName', '')), '');
  place_key := security_private.zagulyaky_public_place_key_v1(canonical_geo);
  if display_name is null or place_key is null then
    return null;
  end if;

  -- Keep the public projection intentionally small: the opaque key is enough
  -- to select a place again, and provider/external identifiers are not needed
  -- by the client after the key has been issued.
  return jsonb_build_object(
    'key', place_key,
    'label', display_name,
    'geo', jsonb_build_object(
      'displayName', display_name,
      'latitude', canonical_geo -> 'latitude',
      'longitude', canonical_geo -> 'longitude',
      'precision', canonical_geo -> 'precision'
    )
  );
end;
$function$;

-- These expression indexes keep a selected-place lookup bounded as the public
-- person catalogue grows.  Possible-living clearance remains checked in the
-- trusted RPC because it is a current review decision, not static index data.
create index if not exists zagulyaky_records_public_person_origin_place_key_idx
  on public.zagulyaky_records (
    security_private.zagulyaky_public_place_key_v1(origin_geo)
  )
  where kind = 'person'
    and status = 'published'
    and privacy_status = 'cleared'
    and origin_geo is not null;

create index if not exists zagulyaky_records_public_person_found_place_key_idx
  on public.zagulyaky_records (
    security_private.zagulyaky_public_place_key_v1(found_geo)
  )
  where kind = 'person'
    and status = 'published'
    and privacy_status = 'cleared'
    and found_geo is not null;

create or replace function security_private.list_public_zagulyaky_places_v1(
  p_query text default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare
  safe_query text := nullif(btrim(coalesce(p_query, '')), '');
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  result jsonb;
begin
  if char_length(coalesce(safe_query, '')) > 200 then
    raise exception 'ZAGULYAKY_PLACE_QUERY_TOO_LONG' using errcode = '22023';
  end if;

  with visible_records as materialized (
    select
      record_row.id,
      origin_point.value as origin_place,
      found_point.value as found_place
    from public.zagulyaky_records record_row
    cross join lateral (
      select security_private.zagulyaky_public_place_point_v1(record_row.origin_geo) as value
    ) origin_point
    cross join lateral (
      select security_private.zagulyaky_public_place_point_v1(record_row.found_geo) as value
    ) found_point
    where record_row.kind = 'person'
      and record_row.status = 'published'
      and record_row.privacy_status = 'cleared'
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
      -- A selectable settlement must lead to a real origin ↔ found relation.
      -- Do not offer a one-sided point which the connections RPC cannot show.
      and origin_point.value is not null
      and found_point.value is not null
  ), endpoint_points as materialized (
    select record_row.id as record_id, 'origin'::text as point_role, record_row.origin_place as place
    from visible_records record_row

    union all

    select record_row.id as record_id, 'found'::text as point_role, record_row.found_place as place
    from visible_records record_row
  ), grouped as materialized (
    select
      endpoint.place ->> 'key' as place_key,
      (array_agg(endpoint.place order by endpoint.place ->> 'label'))[1] as place,
      count(distinct endpoint.record_id)::integer as record_count,
      count(distinct endpoint.record_id) filter (where endpoint.point_role = 'origin')::integer as origin_record_count,
      count(distinct endpoint.record_id) filter (where endpoint.point_role = 'found')::integer as found_record_count
    from endpoint_points endpoint
    group by endpoint.place ->> 'key'
  ), filtered as materialized (
    select *
    from grouped
    where safe_query is null
      or position(lower(safe_query) in lower(place ->> 'label')) > 0
  ), page_rows as materialized (
    select *
    from filtered
    order by lower(place ->> 'label'), place_key
    limit safe_limit
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', page_row.place_key,
        'label', page_row.place ->> 'label',
        'geo', page_row.place -> 'geo',
        'recordCount', page_row.record_count,
        'originRecordCount', page_row.origin_record_count,
        'foundRecordCount', page_row.found_record_count
      ) order by lower(page_row.place ->> 'label'), page_row.place_key)
      from page_rows page_row
    ), '[]'::jsonb),
    'total', (select count(*) from filtered)
  ) into result;

  return result;
end;
$function$;

comment on function security_private.list_public_zagulyaky_places_v1(text, integer) is
  'Trusted public-only selector for confirmed Zagulyaky person places. Never infer locations from free text.';

create or replace function security_private.get_public_zagulyaky_place_connections_v1(
  p_place jsonb,
  p_direction text default 'all',
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare
  safe_place_key text;
  safe_direction text := lower(btrim(coalesce(p_direction, 'all')));
  safe_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  safe_event_type text;
  safe_event_role text;
  safe_year_from integer;
  safe_year_to integer;
  safe_year_text text;
  safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 250);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  result jsonb;
begin
  if p_place is null or jsonb_typeof(p_place) <> 'object' then
    raise exception 'INVALID_ZAGULYAKY_PLACE' using errcode = '22023';
  end if;
  safe_place_key := lower(nullif(btrim(coalesce(p_place ->> 'key', '')), ''));
  if safe_place_key is null or safe_place_key !~ '^[0-9a-f]{32}$' then
    raise exception 'INVALID_ZAGULYAKY_PLACE_KEY' using errcode = '22023';
  end if;
  if safe_direction not in ('all', 'incoming', 'outgoing', 'local') then
    raise exception 'INVALID_ZAGULYAKY_PLACE_DIRECTION' using errcode = '22023';
  end if;
  if jsonb_typeof(safe_filters) <> 'object' then
    raise exception 'INVALID_ZAGULYAKY_PLACE_FILTERS' using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_object_keys(safe_filters) as filter_key(key_name)
    where filter_key.key_name not in ('eventType', 'eventRole', 'yearFrom', 'yearTo')
  ) then
    raise exception 'INVALID_ZAGULYAKY_PLACE_FILTERS' using errcode = '22023';
  end if;

  if safe_filters ? 'eventType'
    and jsonb_typeof(safe_filters -> 'eventType') not in ('string', 'null') then
    raise exception 'INVALID_ZAGULYAKY_PLACE_EVENT_TYPE' using errcode = '22023';
  end if;
  safe_event_type := nullif(btrim(coalesce(safe_filters ->> 'eventType', '')), '');
  if char_length(coalesce(safe_event_type, '')) > 120 then
    raise exception 'INVALID_ZAGULYAKY_PLACE_EVENT_TYPE' using errcode = '22023';
  end if;

  if safe_filters ? 'eventRole'
    and jsonb_typeof(safe_filters -> 'eventRole') not in ('string', 'null') then
    raise exception 'INVALID_ZAGULYAKY_PLACE_EVENT_ROLE' using errcode = '22023';
  end if;
  safe_event_role := lower(nullif(btrim(coalesce(safe_filters ->> 'eventRole', '')), ''));
  if char_length(coalesce(safe_event_role, '')) > 80 then
    raise exception 'INVALID_ZAGULYAKY_PLACE_EVENT_ROLE' using errcode = '22023';
  end if;

  if safe_filters ? 'yearFrom' and jsonb_typeof(safe_filters -> 'yearFrom') <> 'null' then
    if jsonb_typeof(safe_filters -> 'yearFrom') not in ('number', 'string') then
      raise exception 'INVALID_ZAGULYAKY_PLACE_YEAR' using errcode = '22023';
    end if;
    safe_year_text := btrim(coalesce(safe_filters ->> 'yearFrom', ''));
    if safe_year_text !~ '^[0-9]{1,4}$' then
      raise exception 'INVALID_ZAGULYAKY_PLACE_YEAR' using errcode = '22023';
    end if;
    safe_year_from := safe_year_text::integer;
  end if;

  if safe_filters ? 'yearTo' and jsonb_typeof(safe_filters -> 'yearTo') <> 'null' then
    if jsonb_typeof(safe_filters -> 'yearTo') not in ('number', 'string') then
      raise exception 'INVALID_ZAGULYAKY_PLACE_YEAR' using errcode = '22023';
    end if;
    safe_year_text := btrim(coalesce(safe_filters ->> 'yearTo', ''));
    if safe_year_text !~ '^[0-9]{1,4}$' then
      raise exception 'INVALID_ZAGULYAKY_PLACE_YEAR' using errcode = '22023';
    end if;
    safe_year_to := safe_year_text::integer;
  end if;
  if (safe_year_from is not null and (safe_year_from < 1 or safe_year_from > 2200))
    or (safe_year_to is not null and (safe_year_to < 1 or safe_year_to > 2200))
    or (safe_year_from is not null and safe_year_to is not null and safe_year_from > safe_year_to) then
    raise exception 'INVALID_ZAGULYAKY_PLACE_YEAR' using errcode = '22023';
  end if;

  with selected_place as materialized (
    select candidate.place
    from (
      select point.value as place
      from public.zagulyaky_records record_row
      cross join lateral (
        select security_private.zagulyaky_public_place_point_v1(record_row.origin_geo) as value
      ) point
      where record_row.kind = 'person'
        and record_row.status = 'published'
        and record_row.privacy_status = 'cleared'
        and record_row.origin_geo is not null
        and (
          not record_row.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
        )
        and security_private.zagulyaky_public_place_key_v1(record_row.origin_geo) = safe_place_key

      union all

      select point.value as place
      from public.zagulyaky_records record_row
      cross join lateral (
        select security_private.zagulyaky_public_place_point_v1(record_row.found_geo) as value
      ) point
      where record_row.kind = 'person'
        and record_row.status = 'published'
        and record_row.privacy_status = 'cleared'
        and record_row.found_geo is not null
        and (
          not record_row.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
        )
        and security_private.zagulyaky_public_place_key_v1(record_row.found_geo) = safe_place_key
    ) candidate
    where candidate.place is not null
    order by candidate.place ->> 'label'
    limit 1
  ), record_points as materialized (
    select
      record_row.id,
      record_row.public_slug,
      record_row.title,
      record_row.event_type,
      record_row.event_date_text,
      record_row.event_year_from,
      record_row.event_year_to,
      security_private.zagulyaky_public_place_point_v1(record_row.origin_geo) as origin_place,
      security_private.zagulyaky_public_place_point_v1(record_row.found_geo) as found_place
    from public.zagulyaky_records record_row
    where record_row.kind = 'person'
      and record_row.status = 'published'
      and record_row.privacy_status = 'cleared'
      and record_row.origin_geo is not null
      and record_row.found_geo is not null
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
      and (
        safe_event_type is null
        or lower(coalesce(record_row.event_type, '')) = lower(safe_event_type)
      )
      and (
        safe_event_role is null
        or exists (
          select 1
          from public.zagulyaky_participants participant
          where participant.record_id = record_row.id
            and participant.event_role_code = safe_event_role
        )
      )
      and (
        safe_year_from is null
        or coalesce(record_row.event_year_to, record_row.event_year_from, 2200) >= safe_year_from
      )
      and (
        safe_year_to is null
        or coalesce(record_row.event_year_from, record_row.event_year_to, 1) <= safe_year_to
      )
      and (
        security_private.zagulyaky_public_place_key_v1(record_row.origin_geo) = safe_place_key
        or security_private.zagulyaky_public_place_key_v1(record_row.found_geo) = safe_place_key
      )
  ), classified_connections as materialized (
    select
      record_point.public_slug,
      record_point.title,
      record_point.event_type,
      record_point.event_date_text,
      record_point.event_year_from,
      record_point.event_year_to,
      case
        when record_point.origin_place ->> 'key' = safe_place_key
          and record_point.found_place ->> 'key' = safe_place_key then 'local'
        when record_point.found_place ->> 'key' = safe_place_key
          and record_point.origin_place ->> 'key' <> safe_place_key then 'incoming'
        when record_point.origin_place ->> 'key' = safe_place_key
          and record_point.found_place ->> 'key' <> safe_place_key then 'outgoing'
        else null
      end as direction,
      case
        when record_point.origin_place ->> 'key' = safe_place_key
          and record_point.found_place ->> 'key' = safe_place_key then record_point.origin_place
        when record_point.found_place ->> 'key' = safe_place_key
          and record_point.origin_place ->> 'key' <> safe_place_key then record_point.origin_place
        when record_point.origin_place ->> 'key' = safe_place_key
          and record_point.found_place ->> 'key' <> safe_place_key then record_point.found_place
        else null
      end as counterpart_place,
      record_point.origin_place,
      record_point.found_place
    from record_points record_point
    where record_point.origin_place is not null
      and record_point.found_place is not null
      and (
        record_point.origin_place ->> 'key' = safe_place_key
        or record_point.found_place ->> 'key' = safe_place_key
      )
  ), filtered_connections as materialized (
    select *
    from classified_connections connection_row
    where connection_row.direction is not null
      and (safe_direction = 'all' or connection_row.direction = safe_direction)
  ), ranked_connections as materialized (
    select
      connection_row.*,
      connection_row.counterpart_place ->> 'key' as counterpart_key,
      row_number() over (
        partition by connection_row.direction, connection_row.counterpart_place ->> 'key'
        order by connection_row.event_year_from nulls last,
          connection_row.event_year_to nulls last,
          connection_row.public_slug
      ) as sample_rank
    from filtered_connections connection_row
  ), grouped_connections as materialized (
    select
      connection_row.direction,
      connection_row.counterpart_key,
      (array_agg(connection_row.counterpart_place order by connection_row.counterpart_place ->> 'label'))[1] as counterpart_place,
      count(*)::integer as record_count,
      array_agg(distinct connection_row.event_type order by connection_row.event_type)
        filter (where connection_row.event_type is not null) as event_types,
      min(coalesce(connection_row.event_year_from, connection_row.event_year_to)) as year_from,
      max(coalesce(connection_row.event_year_to, connection_row.event_year_from)) as year_to
    from ranked_connections connection_row
    group by connection_row.direction, connection_row.counterpart_key
  ), connection_samples as materialized (
    select
      connection_row.direction,
      connection_row.counterpart_key,
      jsonb_agg(jsonb_build_object(
        'slug', connection_row.public_slug,
        'title', connection_row.title,
        'eventType', connection_row.event_type,
        'eventDateText', connection_row.event_date_text,
        'eventYearFrom', connection_row.event_year_from,
        'eventYearTo', connection_row.event_year_to,
        'origin', jsonb_build_object(
          'label', connection_row.origin_place ->> 'label',
          'geo', connection_row.origin_place -> 'geo'
        ),
        'found', jsonb_build_object(
          'label', connection_row.found_place ->> 'label',
          'geo', connection_row.found_place -> 'geo'
        )
      ) order by connection_row.event_year_from nulls last,
        connection_row.event_year_to nulls last,
        connection_row.public_slug)
        filter (where connection_row.sample_rank <= 3) as samples
    from ranked_connections connection_row
    group by connection_row.direction, connection_row.counterpart_key
  ), grouped_with_samples as materialized (
    select
      grouped.direction,
      grouped.counterpart_key,
      grouped.counterpart_place,
      grouped.record_count,
      grouped.event_types,
      grouped.year_from,
      grouped.year_to,
      coalesce(samples.samples, '[]'::jsonb) as sample_records,
      row_number() over (
        partition by grouped.direction
        order by grouped.record_count desc,
          lower(grouped.counterpart_place ->> 'label'),
          grouped.counterpart_key
      ) as place_rank
    from grouped_connections grouped
    left join connection_samples samples
      on samples.direction = grouped.direction
      and samples.counterpart_key = grouped.counterpart_key
  ), direction_names as materialized (
    select unnest(array['incoming', 'outgoing', 'local']::text[]) as direction
  ), direction_summaries as materialized (
    select
      direction_name.direction,
      count(grouped.counterpart_key)::integer as place_count,
      coalesce(sum(grouped.record_count), 0)::integer as record_count,
      coalesce(jsonb_agg(jsonb_build_object(
        'key', grouped.counterpart_key,
        'label', grouped.counterpart_place ->> 'label',
        'geo', grouped.counterpart_place -> 'geo',
        'recordCount', grouped.record_count,
        'eventTypes', coalesce(to_jsonb(grouped.event_types), '[]'::jsonb),
        'yearFrom', grouped.year_from,
        'yearTo', grouped.year_to,
        'sampleRecords', grouped.sample_records
      ) order by grouped.place_rank)
        filter (where grouped.place_rank > safe_offset and grouped.place_rank <= safe_offset + safe_limit), '[]'::jsonb) as items
    from direction_names direction_name
    left join grouped_with_samples grouped
      on grouped.direction = direction_name.direction
    group by direction_name.direction
  )
  select jsonb_build_object(
    'place', (select place from selected_place),
    'direction', safe_direction,
    'filters', jsonb_build_object(
      'eventType', safe_event_type,
      'eventRole', safe_event_role,
      'yearFrom', safe_year_from,
      'yearTo', safe_year_to
    ),
    'limit', safe_limit,
    'offset', safe_offset,
    'counts', jsonb_build_object(
      'incoming', jsonb_build_object(
        'placeCount', (select place_count from direction_summaries where direction = 'incoming'),
        'recordCount', (select record_count from direction_summaries where direction = 'incoming')
      ),
      'outgoing', jsonb_build_object(
        'placeCount', (select place_count from direction_summaries where direction = 'outgoing'),
        'recordCount', (select record_count from direction_summaries where direction = 'outgoing')
      ),
      'local', jsonb_build_object(
        'placeCount', (select place_count from direction_summaries where direction = 'local'),
        'recordCount', (select record_count from direction_summaries where direction = 'local')
      )
    ),
    'incoming', jsonb_build_object(
      'placeCount', (select place_count from direction_summaries where direction = 'incoming'),
      'recordCount', (select record_count from direction_summaries where direction = 'incoming'),
      'hasMore', (select place_count > safe_offset + safe_limit from direction_summaries where direction = 'incoming'),
      'items', (select items from direction_summaries where direction = 'incoming')
    ),
    'outgoing', jsonb_build_object(
      'placeCount', (select place_count from direction_summaries where direction = 'outgoing'),
      'recordCount', (select record_count from direction_summaries where direction = 'outgoing'),
      'hasMore', (select place_count > safe_offset + safe_limit from direction_summaries where direction = 'outgoing'),
      'items', (select items from direction_summaries where direction = 'outgoing')
    ),
    'local', jsonb_build_object(
      'placeCount', (select place_count from direction_summaries where direction = 'local'),
      'recordCount', (select record_count from direction_summaries where direction = 'local'),
      'hasMore', (select place_count > safe_offset + safe_limit from direction_summaries where direction = 'local'),
      'items', (select items from direction_summaries where direction = 'local')
    )
  ) into result;

  if result is null or result -> 'place' = 'null'::jsonb then
    raise exception 'ZAGULYAKY_PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;

  return result;
end;
$function$;

comment on function security_private.get_public_zagulyaky_place_connections_v1(jsonb, text, jsonb, integer, integer) is
  'Trusted public person-place connections. Uses only confirmed origin/found map points, never free-text inference or archive locations.';

-- The Data API exposes only SECURITY INVOKER facades.  The implementations
-- stay in the non-exposed trusted schema with a fixed search path.
create or replace function public.list_public_zagulyaky_places_v1(
  p_query text default null,
  p_limit integer default 20
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_public_zagulyaky_places_v1($1, $2);
$wrapper$;

create or replace function public.get_public_zagulyaky_place_connections_v1(
  p_place jsonb,
  p_direction text default 'all',
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_public_zagulyaky_place_connections_v1($1, $2, $3, $4, $5);
$wrapper$;

comment on function public.list_public_zagulyaky_places_v1(text, integer) is
  'Anonymous selector of confirmed public Zagulyaky person places. Returns opaque place keys, labels, coordinates and public counts only.';
comment on function public.get_public_zagulyaky_place_connections_v1(jsonb, text, jsonb, integer, integer) is
  'Anonymous public settlement-connection aggregates. Input must be a selector item key; no free-text place matching is performed.';

revoke all on function
  security_private.zagulyaky_public_place_key_v1(jsonb),
  security_private.zagulyaky_public_place_point_v1(jsonb)
  from public, anon, authenticated, service_role;

revoke all on function
  security_private.list_public_zagulyaky_places_v1(text, integer),
  security_private.get_public_zagulyaky_place_connections_v1(jsonb, text, jsonb, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  security_private.list_public_zagulyaky_places_v1(text, integer),
  security_private.get_public_zagulyaky_place_connections_v1(jsonb, text, jsonb, integer, integer)
  to anon, authenticated, service_role;

revoke all on function
  public.list_public_zagulyaky_places_v1(text, integer),
  public.get_public_zagulyaky_place_connections_v1(jsonb, text, jsonb, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.list_public_zagulyaky_places_v1(text, integer),
  public.get_public_zagulyaky_place_connections_v1(jsonb, text, jsonb, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
