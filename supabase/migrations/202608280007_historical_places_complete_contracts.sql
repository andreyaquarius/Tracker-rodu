begin;

-- Completion contracts for historical places (TЗ №12).
--
-- The migration is deliberately additive. Existing exact-date v1 RPCs keep
-- their signatures and semantics. A year or an uncertain range is represented
-- by explicit period bounds; no caller or database function invents an exact
-- day for a historical fact.

set local lock_timeout = '5s';
set local statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- Spatial and finding-confirmation projections
-- ---------------------------------------------------------------------------

alter table public.places
  add column if not exists location extensions.geometry(Point, 4326)
  generated always as (
    case
      when latitude is null or longitude is null then null
      else extensions.st_setsrid(
        extensions.st_makepoint(longitude::double precision, latitude::double precision),
        4326
      )
    end
  ) stored;

create index if not exists places_location_gist_idx
  on public.places using gist (location)
  where location is not null;

comment on column public.places.location is
  'Generated EPSG:4326 point used by explicit coordinate/radius search. Latitude and longitude remain the canonical editable values.';

alter table public.document_place_links
  add column if not exists source_finding_id uuid
    references public.findings(id) on delete set null,
  add column if not exists resolution_status text not null default 'confirmed';

alter table public.document_place_links
  drop constraint if exists document_place_links_resolution_status_check;
alter table public.document_place_links
  add constraint document_place_links_resolution_status_check
  check (resolution_status in ('confirmed', 'needs_review'));

create index if not exists document_place_links_source_finding_idx
  on public.document_place_links (source_finding_id, document_id, place_id)
  where source_finding_id is not null;

drop index if exists public.document_place_links_finding_confirmation_uidx;
create unique index document_place_links_finding_confirmation_uidx
  on public.document_place_links (source_finding_id, relation_type)
  where source_finding_id is not null;

comment on column public.document_place_links.source_finding_id is
  'Finding whose transcription was explicitly confirmed against this Place.';
comment on column public.document_place_links.resolution_status is
  'Explicit user decision: confirmed or needs_review. The database never guesses a Place from text.';

-- Date parsing is intentionally conservative. Only a valid ISO day or a plain
-- four-digit year becomes a comparable bound. Everything else stays source
-- text and is treated as temporally unknown.
create or replace function security_private.historical_text_date_bound_v1(
  p_value text,
  p_upper boolean default false
)
returns date
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  value_text text := btrim(coalesce(p_value, ''));
  year_value integer;
begin
  if value_text ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      return value_text::date;
    exception when others then
      return null;
    end;
  end if;

  if value_text ~ '^\d{4}$' then
    year_value := value_text::integer;
    if year_value between 1 and 9999 then
      return case when p_upper
        then pg_catalog.make_date(year_value, 12, 31)
        else pg_catalog.make_date(year_value, 1, 1)
      end;
    end if;
  end if;

  return null;
end;
$function$;

create or replace function security_private.assert_historical_period_v1(
  p_at_date date,
  p_period_from date,
  p_period_to date,
  p_date_precision text,
  p_context text
)
returns void
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  if p_at_date is not null
     and (p_period_from is not null or p_period_to is not null) then
    raise exception '%_EXACT_DATE_AND_PERIOD_CONFLICT', p_context using errcode = '22023';
  end if;
  if (p_period_from is null) <> (p_period_to is null) then
    raise exception '%_PERIOD_BOUNDS_REQUIRED', p_context using errcode = '22023';
  end if;
  if p_period_from is not null and p_period_from > p_period_to then
    raise exception '%_PERIOD_INVALID', p_context using errcode = '22023';
  end if;
  if p_date_precision is not null
     and p_date_precision not in ('day','month','year','circa','before','after','range','unknown') then
    raise exception '%_DATE_PRECISION_INVALID', p_context using errcode = '22023';
  end if;
  if p_at_date is not null
     and p_date_precision is not null
     and p_date_precision <> 'day' then
    raise exception '%_EXACT_DATE_PRECISION_INVALID', p_context using errcode = '22023';
  end if;
end;
$function$;

create or replace function security_private.can_read_historical_place_v2(
  p_place_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select exists (
    select 1
    from public.places place_row
    where place_row.id = p_place_id
      and (
        coalesce(auth.role(), '') = 'service_role'
        or (
          auth.uid() is null
          and place_row.project_id is null
          and place_row.is_public
        )
        or (
          auth.uid() is not null
          and (
            (place_row.project_id is null
              and place_row.status = 'active'
              and place_row.verification_status = 'verified')
            or (place_row.project_id is not null
              and public.is_project_member(place_row.project_id))
          )
        )
      )
  );
$function$;

create or replace function security_private.can_read_historical_place_relation_v1(
  p_project_id uuid,
  p_child_place_id uuid,
  p_parent_place_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
  select
    coalesce(auth.role(), '') = 'service_role'
    or (
      security_private.can_read_historical_place_v2(p_child_place_id)
      and security_private.can_read_historical_place_v2(p_parent_place_id)
      and (
        p_project_id is null
        or (
          auth.uid() is not null
          and public.is_project_member(p_project_id)
        )
      )
    );
$function$;

revoke all on function security_private.can_read_historical_place_relation_v1(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function security_private.can_read_historical_place_relation_v1(uuid,uuid,uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- Period-aware hierarchy and autocomplete projection
-- ---------------------------------------------------------------------------

create or replace function security_private.resolve_place_hierarchy_period_v1(
  p_place_id uuid,
  p_period_from date,
  p_period_to date,
  p_max_depth integer default 12
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  bounded_depth integer := least(greatest(coalesce(p_max_depth, 12), 1), 32);
  hierarchy_rows jsonb;
  ambiguous_period boolean;
  cycle_detected boolean;
  truncated_detected boolean;
begin
  perform security_private.assert_historical_period_v1(
    null, p_period_from, p_period_to, 'range', 'PLACE_HIERARCHY_PERIOD'
  );
  if p_place_id is null then
    raise exception 'PLACE_ID_REQUIRED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  with recursive hierarchy_walk as (
    select
      0 depth,
      p_place_id place_id,
      null::uuid relation_id,
      null::text relation_type,
      null::date valid_from,
      null::date valid_to,
      array[p_place_id]::uuid[] path,
      false cycle_detected
    union all
    select
      walk.depth + 1,
      relation.parent_place_id,
      relation.id,
      relation.relation_type,
      relation.valid_from,
      relation.valid_to,
      walk.path || relation.parent_place_id,
      relation.parent_place_id = any(walk.path)
    from hierarchy_walk walk
    join public.place_hierarchy_relations relation
      on relation.child_place_id = walk.place_id
     and (relation.valid_from is null or relation.valid_from <= p_period_to)
     and (relation.valid_to is null or relation.valid_to >= p_period_from)
     and security_private.can_read_historical_place_relation_v1(
       relation.project_id, relation.child_place_id, relation.parent_place_id
     )
    where walk.depth < bounded_depth
      and not walk.cycle_detected
      and security_private.can_read_historical_place_v2(relation.parent_place_id)
  ), stats as (
    select
      coalesce(bool_or(walk.cycle_detected), false) cycle_found,
      exists (
        select 1 from hierarchy_walk branch
        where branch.depth > 0
        group by branch.depth
        having count(*) > 1
      ) ambiguous_found,
      exists (
        select 1
        from hierarchy_walk leaf
        join public.place_hierarchy_relations relation
          on relation.child_place_id = leaf.place_id
         and (relation.valid_from is null or relation.valid_from <= p_period_to)
         and (relation.valid_to is null or relation.valid_to >= p_period_from)
         and security_private.can_read_historical_place_relation_v1(
           relation.project_id, relation.child_place_id, relation.parent_place_id
         )
        where leaf.depth = bounded_depth and not leaf.cycle_detected
      ) truncated_found
    from hierarchy_walk walk
  ), payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'depth', walk.depth,
      'relationId', walk.relation_id,
      'relationType', walk.relation_type,
      'validFrom', walk.valid_from,
      'validTo', walk.valid_to,
      'cycleDetected', walk.cycle_detected,
      'place', jsonb_build_object(
        'id', place_row.id,
        'canonicalName', place_row.canonical_name,
        'modernName', nullif(place_row.modern_name, ''),
        'latitude', place_row.latitude,
        'longitude', place_row.longitude
      )
    ) order by walk.depth, walk.valid_from nulls first, walk.path), '[]'::jsonb) value
    from hierarchy_walk walk
    join public.places place_row on place_row.id = walk.place_id
    where walk.depth > 0
  )
  select payload.value, stats.ambiguous_found, stats.cycle_found, stats.truncated_found
  into hierarchy_rows, ambiguous_period, cycle_detected, truncated_detected
  from payload cross join stats;

  return jsonb_build_object(
    'status', case
      when cycle_detected then 'cycle_detected'
      when truncated_detected then 'truncated'
      when ambiguous_period then 'ambiguous_period'
      when jsonb_array_length(hierarchy_rows) = 0 then 'unknown'
      else 'resolved'
    end,
    'periodFrom', p_period_from,
    'periodTo', p_period_to,
    'ambiguous', ambiguous_period,
    'requiresExactDate', ambiguous_period,
    'cycleDetected', cycle_detected,
    'truncated', truncated_detected,
    'hierarchy', hierarchy_rows
  );
end;
$function$;

create or replace function security_private.get_place_autocomplete_projection_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  names_rows jsonb;
  hierarchy_data jsonb;
  active_name text;
  active_type text;
begin
  perform security_private.assert_historical_period_v1(
    p_at_date, p_period_from, p_period_to,
    case when p_at_date is not null then 'day'
         when p_period_from is not null then 'range' else null end,
    'PLACE_AUTOCOMPLETE'
  );
  select * into place_row from public.places where id = p_place_id;
  if not found then raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002'; end if;
  if not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', name_row.id,
    'name', name_row.name,
    'languageCode', name_row.language_code,
    'nameType', name_row.name_type,
    'validFrom', name_row.valid_from,
    'validTo', name_row.valid_to,
    'isPrimary', name_row.is_primary
  ) order by name_row.is_primary desc, name_row.valid_from nulls first, name_row.name), '[]'::jsonb)
  into names_rows
  from (
    select source_row.*
    from public.place_names source_row
    where source_row.place_id = p_place_id
      and (
        (p_at_date is null and p_period_from is null)
        or (p_at_date is not null
          and (source_row.valid_from is null or source_row.valid_from <= p_at_date)
          and (source_row.valid_to is null or source_row.valid_to >= p_at_date))
        or (p_period_from is not null
          and (source_row.valid_from is null or source_row.valid_from <= p_period_to)
          and (source_row.valid_to is null or source_row.valid_to >= p_period_from))
      )
    order by source_row.is_primary desc, source_row.valid_from desc nulls last, source_row.id
    limit 20
  ) name_row;

  select name_row.name into active_name
  from public.place_names name_row
  where name_row.place_id = p_place_id
    and (
      (p_at_date is null and p_period_from is null)
      or (p_at_date is not null
        and (name_row.valid_from is null or name_row.valid_from <= p_at_date)
        and (name_row.valid_to is null or name_row.valid_to >= p_at_date))
      or (p_period_from is not null
        and (name_row.valid_from is null or name_row.valid_from <= p_period_to)
        and (name_row.valid_to is null or name_row.valid_to >= p_period_from))
    )
  order by name_row.is_primary desc, name_row.valid_from desc nulls last, name_row.id
  limit 1;

  select assignment.place_type_code into active_type
  from public.place_type_assignments assignment
  where assignment.place_id = p_place_id
    and (
      (p_at_date is null and p_period_from is null)
      or (p_at_date is not null
        and (assignment.valid_from is null or assignment.valid_from <= p_at_date)
        and (assignment.valid_to is null or assignment.valid_to >= p_at_date))
      or (p_period_from is not null
        and (assignment.valid_from is null or assignment.valid_from <= p_period_to)
        and (assignment.valid_to is null or assignment.valid_to >= p_period_from))
    )
  order by assignment.is_primary desc, assignment.valid_from desc nulls last, assignment.id
  limit 1;

  -- The ACL-safe period resolver also handles an exact day. With no explicit
  -- date autocomplete should show the current hierarchy, not traverse every
  -- historical branch through the authenticated-only legacy resolver.
  hierarchy_data := security_private.resolve_place_hierarchy_period_v1(
    p_place_id,
    coalesce(p_period_from, p_at_date, current_date),
    coalesce(p_period_to, p_at_date, current_date),
    12
  );

  return jsonb_build_object(
    'id', place_row.id,
    'projectId', place_row.project_id,
    'scope', case when place_row.project_id is null then 'global' else 'project' end,
    'canonicalName', place_row.canonical_name,
    'modernName', nullif(place_row.modern_name, ''),
    'displayName', coalesce(active_name,
      case when p_at_date is null and p_period_from is null
        then nullif(place_row.modern_name, '') else place_row.canonical_name end,
      place_row.canonical_name),
    'placeType', active_type,
    'latitude', place_row.latitude,
    'longitude', place_row.longitude,
    'currentCountry', nullif(place_row.metadata ->> 'currentCountry', ''),
    'currentAdmin', nullif(place_row.metadata ->> 'currentAdmin', ''),
    'historicalNames', names_rows,
    'hierarchy', hierarchy_data,
    'atDate', p_at_date,
    'periodFrom', p_period_from,
    'periodTo', p_period_to
  );
end;
$function$;

-- Explicit coordinate parameters avoid treating a comma-containing place name
-- as a latitude/longitude pair. Ancestor filtering also accepts only a Place
-- UUID, never a free-form administrative label.
create or replace function security_private.search_places_v2(
  p_query text default '',
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null,
  p_date_precision text default null,
  p_project_id uuid default null,
  p_limit integer default 20,
  p_ancestor_place_id uuid default null,
  p_latitude numeric default null,
  p_longitude numeric default null,
  p_radius_km numeric default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
declare
  raw_query text := btrim(coalesce(p_query, ''));
  normalized_query text := public.historical_place_search_normalize_v1(btrim(coalesce(p_query, '')));
  bounded_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  has_coordinates boolean := p_latitude is not null or p_longitude is not null or p_radius_km is not null;
begin
  perform security_private.assert_historical_period_v1(
    p_at_date, p_period_from, p_period_to, p_date_precision, 'PLACE_SEARCH'
  );
  if char_length(raw_query) > 200 then
    raise exception 'PLACE_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  if p_project_id is not null
     and coalesce(auth.role(), '') <> 'service_role'
     and (auth.uid() is null or not public.is_project_member(p_project_id)) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if has_coordinates and (p_latitude is null or p_longitude is null or p_radius_km is null) then
    raise exception 'PLACE_COORDINATE_SEARCH_REQUIRES_LATITUDE_LONGITUDE_RADIUS'
      using errcode = '22023';
  end if;
  if p_latitude is not null and p_latitude not between -90 and 90 then
    raise exception 'PLACE_SEARCH_LATITUDE_INVALID' using errcode = '22023';
  end if;
  if p_longitude is not null and p_longitude not between -180 and 180 then
    raise exception 'PLACE_SEARCH_LONGITUDE_INVALID' using errcode = '22023';
  end if;
  if p_radius_km is not null and p_radius_km not between 0.01 and 500 then
    raise exception 'PLACE_SEARCH_RADIUS_INVALID' using errcode = '22023';
  end if;
  if p_ancestor_place_id is not null
     and not security_private.can_read_historical_place_v2(p_ancestor_place_id) then
    raise exception 'PLACE_ANCESTOR_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if char_length(normalized_query) < 2
     and p_ancestor_place_id is null
     and not has_coordinates then
    return '[]'::jsonb;
  end if;

  return coalesce((
    with recursive ancestor_descendants as (
      select p_ancestor_place_id place_id, 0 depth,
        array[p_ancestor_place_id]::uuid[] path
      where p_ancestor_place_id is not null
      union all
      select relation.child_place_id, walk.depth + 1,
        walk.path || relation.child_place_id
      from ancestor_descendants walk
      join public.place_hierarchy_relations relation
        on relation.parent_place_id = walk.place_id
       and security_private.can_read_historical_place_relation_v1(
         relation.project_id, relation.child_place_id, relation.parent_place_id
       )
       and (
         (p_at_date is null and p_period_from is null)
         or (p_at_date is not null
           and (relation.valid_from is null or relation.valid_from <= p_at_date)
           and (relation.valid_to is null or relation.valid_to >= p_at_date))
         or (p_period_from is not null
           and (relation.valid_from is null or relation.valid_from <= p_period_to)
           and (relation.valid_to is null or relation.valid_to >= p_period_from))
       )
      where walk.depth < 32
        and not relation.child_place_id = any(walk.path)
    ), visible_places as (
      select place_row.*
      from public.places place_row
      where place_row.status not in ('merged','archived')
        and security_private.can_read_historical_place_v2(place_row.id)
        and (p_project_id is null
          or place_row.project_id is null
          or place_row.project_id = p_project_id)
        and (p_ancestor_place_id is null or exists (
          select 1 from ancestor_descendants descendant
          where descendant.depth > 0 and descendant.place_id = place_row.id
        ))
        and (not has_coordinates or (
          place_row.location is not null
          and extensions.st_dwithin(
            place_row.location::extensions.geography,
            extensions.st_setsrid(
              extensions.st_makepoint(p_longitude::double precision, p_latitude::double precision),
              4326
            )::extensions.geography,
            p_radius_km::double precision * 1000.0
          )
        ))
    ), matched as (
      select place_row.id,
        coalesce(match_name.name, place_row.canonical_name) matched_name,
        case
          when char_length(normalized_query) < 2 then 0
          when match_name.search_text = normalized_query then 0
          when place_row.search_text = normalized_query then 0
          when coalesce(match_name.search_text, place_row.search_text) like normalized_query || '%' then 1
          when coalesce(match_name.search_text, place_row.search_text) like '%' || normalized_query || '%' then 2
          else 3
        end match_rank,
        case when has_coordinates then extensions.st_distance(
          place_row.location::extensions.geography,
          extensions.st_setsrid(
            extensions.st_makepoint(p_longitude::double precision, p_latitude::double precision), 4326
          )::extensions.geography
        ) / 1000.0 else null end distance_km
      from visible_places place_row
      left join lateral (
        select name_row.name, name_row.search_text
        from public.place_names name_row
        where name_row.place_id = place_row.id
          and (char_length(normalized_query) < 2
            or name_row.search_text like '%' || normalized_query || '%'
            or name_row.search_text % normalized_query)
        order by
          case when name_row.search_text = normalized_query then 0
               when name_row.search_text like normalized_query || '%' then 1
               when name_row.search_text like '%' || normalized_query || '%' then 2 else 3 end,
          extensions.similarity(name_row.search_text, normalized_query) desc,
          name_row.id
        limit 1
      ) match_name on true
      where char_length(normalized_query) < 2
         or place_row.search_text like '%' || normalized_query || '%'
         or place_row.search_text % normalized_query
         or match_name.name is not null
    ), limited as (
      select * from matched
      order by match_rank, distance_km nulls last, matched_name, id
      limit bounded_limit
    )
    select jsonb_agg(
      security_private.get_place_autocomplete_projection_v1(
        limited.id, p_at_date, p_period_from, p_period_to
      ) || jsonb_build_object(
        'matchedName', limited.matched_name,
        'distanceKm', case when limited.distance_km is null then null
          else round(limited.distance_km::numeric, 3) end,
        'ancestorPlaceId', p_ancestor_place_id
      )
      order by limited.match_rank, limited.distance_km nulls last, limited.matched_name, limited.id
    )
    from limited
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_boundaries_v2(
  p_place_id uuid,
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions, pg_temp
set statement_timeout = '5s'
as $function$
begin
  perform security_private.assert_historical_period_v1(
    p_at_date, p_period_from, p_period_to,
    case when p_at_date is not null then 'day'
         when p_period_from is not null then 'range' else null end,
    'PLACE_BOUNDARY_LIST'
  );
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', boundary.id,
      'placeId', boundary.place_id,
      'boundaryType', boundary.boundary_type,
      'geometryGeojson', boundary.geometry_geojson,
      'srid', extensions.st_srid(boundary.geometry),
      'geometryType', extensions.geometrytype(boundary.geometry),
      'validFrom', boundary.valid_from,
      'validTo', boundary.valid_to,
      'validFromText', boundary.valid_from_text,
      'validToText', boundary.valid_to_text,
      'validFromPrecision', boundary.valid_from_precision,
      'validToPrecision', boundary.valid_to_precision,
      'sourceDocumentId', boundary.source_document_id,
      'sourceFindingId', boundary.source_finding_id,
      'citationId', boundary.citation_id,
      'sourceReference', boundary.source_reference,
      'confidence', boundary.confidence,
      'originalText', boundary.original_text,
      'note', boundary.note,
      'metadata', boundary.metadata,
      'lockVersion', boundary.lock_version,
      'createdAt', boundary.created_at,
      'updatedAt', boundary.updated_at
    ) order by boundary.valid_from nulls first, boundary.id)
    from public.place_boundaries boundary
    where boundary.place_id = p_place_id
      and (
        (p_at_date is null and p_period_from is null)
        or (p_at_date is not null
          and (boundary.valid_from is null or boundary.valid_from <= p_at_date)
          and (boundary.valid_to is null or boundary.valid_to >= p_at_date))
        or (p_period_from is not null
          and (boundary.valid_from is null or boundary.valid_from <= p_period_to)
          and (boundary.valid_to is null or boundary.valid_to >= p_period_from))
      )
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_documents_v2(
  p_place_id uuid,
  p_period_from date default null,
  p_period_to date default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  bounded_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform security_private.assert_historical_period_v1(
    null, p_period_from, p_period_to,
    case when p_period_from is not null then 'range' else null end,
    'PLACE_DOCUMENT_LIST'
  );
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(page_row) order by page_row."updatedAt" desc, page_row."linkId")
    from (
      select
        link_row.id as "linkId",
        link_row.document_id as "documentId",
        link_row.source_finding_id as "sourceFindingId",
        link_row.resolution_status as "resolutionStatus",
        document_row.title,
        document_row.document_type as "documentType",
        document_row.archive,
        document_row.fund,
        document_row.file_reference as "fileReference",
        document_row.year_from as "yearFrom",
        document_row.year_to as "yearTo",
        document_row.url,
        link_row.relation_type as "relationType",
        link_row.original_text as "originalText",
        link_row.valid_from as "validFrom",
        link_row.valid_to as "validTo",
        link_row.valid_from_text as "validFromText",
        link_row.valid_to_text as "validToText",
        link_row.valid_from_precision as "validFromPrecision",
        link_row.valid_to_precision as "validToPrecision",
        link_row.source_reference as "sourceReference",
        link_row.confidence,
        link_row.note,
        link_row.metadata,
        link_row.lock_version as "lockVersion",
        link_row.updated_at as "updatedAt"
      from public.document_place_links link_row
      join public.documents document_row on document_row.id = link_row.document_id
      cross join lateral (
        select
          coalesce(link_row.valid_from,
            security_private.historical_text_date_bound_v1(document_row.year_from, false)) lower_bound,
          coalesce(link_row.valid_to,
            security_private.historical_text_date_bound_v1(
              coalesce(nullif(document_row.year_to, ''), document_row.year_from), true
            )) upper_bound
      ) period_bound
      where link_row.place_id = p_place_id
        and (coalesce(auth.role(), '') = 'service_role'
          or public.is_project_member(link_row.project_id))
        and (
          p_period_from is null
          or (
            period_bound.lower_bound is not null
            and period_bound.upper_bound is not null
            and period_bound.lower_bound <= p_period_to
            and period_bound.upper_bound >= p_period_from
          )
        )
      order by link_row.updated_at desc, link_row.id
      limit bounded_limit offset bounded_offset
    ) page_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.list_place_events_v2(
  p_place_id uuid,
  p_period_from date default null,
  p_period_to date default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '5s'
as $function$
declare
  bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  bounded_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  perform security_private.assert_historical_period_v1(
    null, p_period_from, p_period_to,
    case when p_period_from is not null then 'range' else null end,
    'PLACE_EVENT_LIST'
  );
  if not exists (select 1 from public.places where id = p_place_id) then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not security_private.can_read_historical_place_v2(p_place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(to_jsonb(page_row) order by page_row."sortDate" nulls last, page_row."eventId")
    from (
      select
        event_row.id as "eventId",
        event_row.person_id as "personId",
        person_row.full_name as "personName",
        event_row.event_type as "eventType",
        event_row.title,
        event_row.event_date as "eventDate",
        event_row.date_from as "dateFrom",
        event_row.date_to as "dateTo",
        event_row.date_text as "dateText",
        event_row.place_name as "placeName",
        event_row.place_original_text as "placeOriginalText",
        event_row.place_resolution_status as "placeResolutionStatus",
        event_row.event_role as "eventRole",
        event_row.evidence_status as "evidenceStatus",
        event_row.confidence,
        event_row.source_document_id as "sourceDocumentId",
        event_row.source_finding_id as "sourceFindingId",
        event_row.notes,
        event_row.metadata,
        event_row.updated_at as "updatedAt",
        period_bound.lower_bound as "sortDate"
      from public.person_timeline_events event_row
      join public.persons person_row
        on person_row.id = event_row.person_id
       and person_row.project_id = event_row.project_id
      cross join lateral (
        select
          coalesce(
            security_private.historical_text_date_bound_v1(event_row.date_from, false),
            security_private.historical_text_date_bound_v1(event_row.event_date, false),
            security_private.historical_text_date_bound_v1(event_row.date_to, false)
          ) lower_bound,
          coalesce(
            security_private.historical_text_date_bound_v1(event_row.date_to, true),
            security_private.historical_text_date_bound_v1(event_row.event_date, true),
            security_private.historical_text_date_bound_v1(event_row.date_from, true)
          ) upper_bound
      ) period_bound
      where event_row.place_id = p_place_id
        and (coalesce(auth.role(), '') = 'service_role'
          or public.is_project_member(event_row.project_id))
        and (
          p_period_from is null
          or (
            period_bound.lower_bound is not null
            and period_bound.upper_bound is not null
            and period_bound.lower_bound <= p_period_to
            and period_bound.upper_bound >= p_period_from
          )
        )
      order by period_bound.lower_bound nulls last, event_row.id
      limit bounded_limit offset bounded_offset
    ) page_row
  ), '[]'::jsonb);
end;
$function$;

create or replace function security_private.get_place_map_context_v1(
  p_place_id uuid,
  p_at_date date default null,
  p_period_from date default null,
  p_period_to date default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '10s'
as $function$
declare
  bounded_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
begin
  perform security_private.assert_historical_period_v1(
    p_at_date, p_period_from, p_period_to,
    case when p_at_date is not null then 'day'
         when p_period_from is not null then 'range' else null end,
    'PLACE_MAP_CONTEXT'
  );

  return jsonb_build_object(
    'place', security_private.get_place_autocomplete_projection_v1(
      p_place_id, p_at_date, p_period_from, p_period_to
    ),
    'boundaries', security_private.list_place_boundaries_v2(
      p_place_id, p_at_date, p_period_from, p_period_to
    ),
    'documents', security_private.list_place_documents_v2(
      p_place_id, p_period_from, p_period_to, bounded_limit, 0
    ),
    'events', security_private.list_place_events_v2(
      p_place_id, p_period_from, p_period_to, bounded_limit, 0
    ),
    'atDate', p_at_date,
    'periodFrom', p_period_from,
    'periodTo', p_period_to,
    'temporalMode', case when p_at_date is not null then 'exact_date'
      when p_period_from is not null then 'period' else 'all_time' end
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Complete optimistic write contracts for previously read-only entities
-- ---------------------------------------------------------------------------

create or replace function security_private.place_type_assignment_json_v1(
  p_row public.place_type_assignments
)
returns jsonb language sql immutable security definer set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'id', p_row.id, 'placeId', p_row.place_id, 'projectId', p_row.project_id,
    'placeTypeCode', p_row.place_type_code,
    'validFrom', p_row.valid_from, 'validTo', p_row.valid_to,
    'validFromText', p_row.valid_from_text, 'validToText', p_row.valid_to_text,
    'validFromPrecision', p_row.valid_from_precision,
    'validToPrecision', p_row.valid_to_precision,
    'sourceDocumentId', p_row.source_document_id,
    'sourceFindingId', p_row.source_finding_id,
    'citationId', p_row.citation_id, 'sourceReference', p_row.source_reference,
    'confidence', p_row.confidence, 'isPrimary', p_row.is_primary,
    'note', p_row.note, 'metadata', p_row.metadata,
    'lockVersion', p_row.lock_version,
    'createdAt', p_row.created_at, 'updatedAt', p_row.updated_at
  );
$function$;

create or replace function security_private.place_external_identifier_json_v1(
  p_row public.place_external_identifiers
)
returns jsonb language sql immutable security definer set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'id', p_row.id, 'placeId', p_row.place_id, 'projectId', p_row.project_id,
    'provider', p_row.provider, 'externalIdentifier', p_row.external_identifier,
    'sourceUrl', p_row.source_url, 'isPrimary', p_row.is_primary,
    'metadata', p_row.metadata, 'lockVersion', p_row.lock_version,
    'createdAt', p_row.created_at, 'updatedAt', p_row.updated_at
  );
$function$;

create or replace function security_private.place_relation_json_v1(
  p_row public.place_relations
)
returns jsonb language sql immutable security definer set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'id', p_row.id, 'placeId', p_row.place_id,
    'relatedPlaceId', p_row.related_place_id, 'projectId', p_row.project_id,
    'relationType', p_row.relation_type,
    'validFrom', p_row.valid_from, 'validTo', p_row.valid_to,
    'validFromText', p_row.valid_from_text, 'validToText', p_row.valid_to_text,
    'validFromPrecision', p_row.valid_from_precision,
    'validToPrecision', p_row.valid_to_precision,
    'sourceDocumentId', p_row.source_document_id,
    'sourceFindingId', p_row.source_finding_id,
    'citationId', p_row.citation_id, 'sourceReference', p_row.source_reference,
    'confidence', p_row.confidence, 'originalText', p_row.original_text,
    'note', p_row.note, 'metadata', p_row.metadata,
    'lockVersion', p_row.lock_version,
    'createdAt', p_row.created_at, 'updatedAt', p_row.updated_at
  );
$function$;

create or replace function security_private.place_boundary_json_v1(
  p_row public.place_boundaries
)
returns jsonb language sql immutable security definer set search_path = pg_catalog
as $function$
  select jsonb_build_object(
    'id', p_row.id, 'placeId', p_row.place_id, 'projectId', p_row.project_id,
    'boundaryType', p_row.boundary_type, 'geometryGeojson', p_row.geometry_geojson,
    'geometryFormat', p_row.geometry_format,
    'coordinateReferenceSystem', p_row.coordinate_reference_system,
    'validFrom', p_row.valid_from, 'validTo', p_row.valid_to,
    'validFromText', p_row.valid_from_text, 'validToText', p_row.valid_to_text,
    'validFromPrecision', p_row.valid_from_precision,
    'validToPrecision', p_row.valid_to_precision,
    'sourceDocumentId', p_row.source_document_id,
    'sourceFindingId', p_row.source_finding_id,
    'citationId', p_row.citation_id, 'sourceReference', p_row.source_reference,
    'confidence', p_row.confidence, 'originalText', p_row.original_text,
    'note', p_row.note, 'metadata', p_row.metadata,
    'lockVersion', p_row.lock_version,
    'createdAt', p_row.created_at, 'updatedAt', p_row.updated_at
  );
$function$;

create or replace function security_private.add_place_type_assignment_v1(
  p_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_type_assignments;
  make_primary boolean;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array['placeTypeCode','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','isPrimary','note','metadata'],
    'PLACE_TYPE_ASSIGNMENT'
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged','archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);
  make_primary := coalesce((p_payload ->> 'isPrimary')::boolean, false);
  if make_primary then
    update public.place_type_assignments set is_primary = false
    where place_id = p_place_id and is_primary;
  end if;
  insert into public.place_type_assignments (
    place_id, place_type_code, valid_from, valid_to,
    valid_from_text, valid_to_text, valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, is_primary, note, metadata, created_by
  ) values (
    p_place_id, coalesce(p_payload ->> 'placeTypeCode', ''),
    nullif(p_payload ->> 'validFrom', '')::date,
    nullif(p_payload ->> 'validTo', '')::date,
    nullif(p_payload ->> 'validFromText', ''), nullif(p_payload ->> 'validToText', ''),
    nullif(p_payload ->> 'validFromPrecision', ''),
    nullif(p_payload ->> 'validToPrecision', ''),
    nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
    nullif(p_payload ->> 'sourceFindingId', '')::uuid,
    nullif(p_payload ->> 'citationId', '')::uuid,
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce((p_payload ->> 'confidence')::smallint, 50), make_primary,
    coalesce(p_payload ->> 'note', ''), coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  ) returning * into created_row;
  return security_private.place_type_assignment_json_v1(created_row);
end;
$function$;

create or replace function security_private.update_place_type_assignment_v1(
  p_assignment_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_type_assignments;
  updated_row public.place_type_assignments;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['placeTypeCode','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','isPrimary','note','metadata'],
    'PLACE_TYPE_ASSIGNMENT_PATCH'
  );
  select * into current_row from public.place_type_assignments where id = p_assignment_id;
  if not found then raise exception 'PLACE_TYPE_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.place_id);
  perform security_private.lock_historical_place_ids_v1(array[current_row.place_id]::uuid[], true);
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_TYPE_ASSIGNMENT_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if p_patch ? 'isPrimary' and coalesce((p_patch ->> 'isPrimary')::boolean, false) then
    update public.place_type_assignments set is_primary = false
    where place_id = current_row.place_id and id <> current_row.id and is_primary;
  end if;
  update public.place_type_assignments candidate set
    place_type_code = case when p_patch ? 'placeTypeCode' then coalesce(p_patch ->> 'placeTypeCode','') else candidate.place_type_code end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId' then nullif(p_patch ->> 'sourceDocumentId','')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId' then nullif(p_patch ->> 'citationId','')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    is_primary = case when p_patch ? 'isPrimary' then coalesce((p_patch ->> 'isPrimary')::boolean,false) else candidate.is_primary end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_assignment_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_TYPE_ASSIGNMENT_VERSION_CONFLICT' using errcode = '40001'; end if;
  return security_private.place_type_assignment_json_v1(updated_row);
end;
$function$;

create or replace function security_private.add_place_external_identifier_v1(
  p_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_external_identifiers;
  provider_value text;
  make_primary boolean;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload, array['provider','externalIdentifier','sourceUrl','isPrimary','metadata'],
    'PLACE_EXTERNAL_IDENTIFIER'
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged','archived') then raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023'; end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);
  provider_value := btrim(coalesce(p_payload ->> 'provider',''));
  make_primary := coalesce((p_payload ->> 'isPrimary')::boolean, false);
  if make_primary then
    update public.place_external_identifiers set is_primary = false
    where place_id = p_place_id and lower(provider) = lower(provider_value) and is_primary;
  end if;
  insert into public.place_external_identifiers (
    place_id, provider, external_identifier, source_url, is_primary, metadata, created_by
  ) values (
    p_place_id, provider_value, coalesce(p_payload ->> 'externalIdentifier',''),
    nullif(p_payload ->> 'sourceUrl',''), make_primary,
    coalesce(p_payload -> 'metadata','{}'::jsonb), auth.uid()
  ) returning * into created_row;
  return security_private.place_external_identifier_json_v1(created_row);
end;
$function$;

create or replace function security_private.update_place_external_identifier_v1(
  p_identifier_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_external_identifiers;
  updated_row public.place_external_identifiers;
  provider_value text;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch, array['provider','externalIdentifier','sourceUrl','isPrimary','metadata'],
    'PLACE_EXTERNAL_IDENTIFIER_PATCH'
  );
  select * into current_row from public.place_external_identifiers where id = p_identifier_id;
  if not found then raise exception 'PLACE_EXTERNAL_IDENTIFIER_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.place_id);
  perform security_private.lock_historical_place_ids_v1(array[current_row.place_id]::uuid[], true);
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_EXTERNAL_IDENTIFIER_VERSION_CONFLICT' using errcode = '40001';
  end if;
  provider_value := case when p_patch ? 'provider'
    then btrim(coalesce(p_patch ->> 'provider','')) else current_row.provider end;
  if p_patch ? 'isPrimary' and coalesce((p_patch ->> 'isPrimary')::boolean,false) then
    update public.place_external_identifiers set is_primary = false
    where place_id = current_row.place_id and id <> current_row.id
      and lower(provider) = lower(provider_value) and is_primary;
  end if;
  update public.place_external_identifiers candidate set
    provider = provider_value,
    external_identifier = case when p_patch ? 'externalIdentifier' then coalesce(p_patch ->> 'externalIdentifier','') else candidate.external_identifier end,
    source_url = case when p_patch ? 'sourceUrl' then nullif(p_patch ->> 'sourceUrl','') else candidate.source_url end,
    is_primary = case when p_patch ? 'isPrimary' then coalesce((p_patch ->> 'isPrimary')::boolean,false) else candidate.is_primary end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_identifier_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_EXTERNAL_IDENTIFIER_VERSION_CONFLICT' using errcode = '40001'; end if;
  return security_private.place_external_identifier_json_v1(updated_row);
end;
$function$;

create or replace function security_private.add_place_relation_v1(
  p_place_id uuid,
  p_related_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_relations;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array['relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','originalText','note','metadata'],
    'PLACE_RELATION'
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged','archived') then raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023'; end if;
  perform security_private.lock_historical_place_ids_v1(
    array[p_place_id,p_related_place_id]::uuid[], true
  );
  insert into public.place_relations (
    place_id, related_place_id, relation_type, valid_from, valid_to,
    valid_from_text, valid_to_text, valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, original_text, note, metadata, created_by
  ) values (
    p_place_id, p_related_place_id, coalesce(p_payload ->> 'relationType',''),
    nullif(p_payload ->> 'validFrom','')::date,
    nullif(p_payload ->> 'validTo','')::date,
    nullif(p_payload ->> 'validFromText',''), nullif(p_payload ->> 'validToText',''),
    nullif(p_payload ->> 'validFromPrecision',''), nullif(p_payload ->> 'validToPrecision',''),
    nullif(p_payload ->> 'sourceDocumentId','')::uuid,
    nullif(p_payload ->> 'sourceFindingId','')::uuid,
    nullif(p_payload ->> 'citationId','')::uuid,
    nullif(p_payload ->> 'sourceReference',''),
    coalesce((p_payload ->> 'confidence')::smallint,50),
    coalesce(p_payload ->> 'originalText',''), coalesce(p_payload ->> 'note',''),
    coalesce(p_payload -> 'metadata','{}'::jsonb), auth.uid()
  ) returning * into created_row;
  return security_private.place_relation_json_v1(created_row);
end;
$function$;

create or replace function security_private.update_place_relation_v1(
  p_relation_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_relations;
  updated_row public.place_relations;
  related_id uuid;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['relatedPlaceId','relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','originalText','note','metadata'],
    'PLACE_RELATION_PATCH'
  );
  select * into current_row from public.place_relations where id = p_relation_id;
  if not found then raise exception 'PLACE_RELATION_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.place_id);
  related_id := case when p_patch ? 'relatedPlaceId'
    then nullif(p_patch ->> 'relatedPlaceId','')::uuid else current_row.related_place_id end;
  perform security_private.lock_historical_place_ids_v1(
    array[current_row.place_id,current_row.related_place_id,related_id]::uuid[], true
  );
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_RELATION_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.place_relations candidate set
    related_place_id = related_id,
    relation_type = case when p_patch ? 'relationType' then coalesce(p_patch ->> 'relationType','') else candidate.relation_type end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId' then nullif(p_patch ->> 'sourceDocumentId','')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId' then nullif(p_patch ->> 'citationId','')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch ->> 'originalText','') else candidate.original_text end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_relation_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_RELATION_VERSION_CONFLICT' using errcode = '40001'; end if;
  return security_private.place_relation_json_v1(updated_row);
end;
$function$;

create or replace function security_private.add_place_boundary_v1(
  p_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_boundaries;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array['boundaryType','geometryGeojson','coordinateReferenceSystem',
      'validFrom','validTo','validFromText','validToText','validFromPrecision',
      'validToPrecision','sourceDocumentId','sourceFindingId','citationId',
      'sourceReference','confidence','originalText','note','metadata'],
    'PLACE_BOUNDARY', 200000
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged','archived') then raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023'; end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);
  insert into public.place_boundaries (
    place_id, boundary_type, geometry_geojson, coordinate_reference_system,
    valid_from, valid_to, valid_from_text, valid_to_text,
    valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, original_text, note, metadata, created_by
  ) values (
    p_place_id, coalesce(nullif(p_payload ->> 'boundaryType',''),'historical_boundary'),
    p_payload -> 'geometryGeojson',
    coalesce(nullif(p_payload ->> 'coordinateReferenceSystem',''),'EPSG:4326'),
    nullif(p_payload ->> 'validFrom','')::date,
    nullif(p_payload ->> 'validTo','')::date,
    nullif(p_payload ->> 'validFromText',''), nullif(p_payload ->> 'validToText',''),
    nullif(p_payload ->> 'validFromPrecision',''), nullif(p_payload ->> 'validToPrecision',''),
    nullif(p_payload ->> 'sourceDocumentId','')::uuid,
    nullif(p_payload ->> 'sourceFindingId','')::uuid,
    nullif(p_payload ->> 'citationId','')::uuid,
    nullif(p_payload ->> 'sourceReference',''),
    coalesce((p_payload ->> 'confidence')::smallint,50),
    coalesce(p_payload ->> 'originalText',''), coalesce(p_payload ->> 'note',''),
    coalesce(p_payload -> 'metadata','{}'::jsonb), auth.uid()
  ) returning * into created_row;
  return security_private.place_boundary_json_v1(created_row);
end;
$function$;

create or replace function security_private.update_place_boundary_v1(
  p_boundary_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_boundaries;
  updated_row public.place_boundaries;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['boundaryType','geometryGeojson','coordinateReferenceSystem',
      'validFrom','validTo','validFromText','validToText','validFromPrecision',
      'validToPrecision','sourceDocumentId','sourceFindingId','citationId',
      'sourceReference','confidence','originalText','note','metadata'],
    'PLACE_BOUNDARY_PATCH', 200000
  );
  select * into current_row from public.place_boundaries where id = p_boundary_id;
  if not found then raise exception 'PLACE_BOUNDARY_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.place_id);
  perform security_private.lock_historical_place_ids_v1(array[current_row.place_id]::uuid[], true);
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_BOUNDARY_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.place_boundaries candidate set
    boundary_type = case when p_patch ? 'boundaryType' then coalesce(p_patch ->> 'boundaryType','') else candidate.boundary_type end,
    geometry_geojson = case when p_patch ? 'geometryGeojson' then p_patch -> 'geometryGeojson' else candidate.geometry_geojson end,
    coordinate_reference_system = case when p_patch ? 'coordinateReferenceSystem' then coalesce(p_patch ->> 'coordinateReferenceSystem','') else candidate.coordinate_reference_system end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId' then nullif(p_patch ->> 'sourceDocumentId','')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId' then nullif(p_patch ->> 'citationId','')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch ->> 'originalText','') else candidate.original_text end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_boundary_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_BOUNDARY_VERSION_CONFLICT' using errcode = '40001'; end if;
  return security_private.place_boundary_json_v1(updated_row);
end;
$function$;

create or replace function security_private.create_project_place_v2(
  p_project_id uuid,
  p_input jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare
  base_input jsonb;
  create_result jsonb;
  place_id_value uuid;
  metadata_value jsonb;
  external_item jsonb;
  external_results jsonb := '[]'::jsonb;
  type_payload jsonb;
  type_result jsonb;
  identifier_result jsonb;
  parent_relation_result jsonb;
  external_items jsonb := '[]'::jsonb;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_input,
    array['canonicalName','canonical_name','modernName','modern_name','description',
      'languageCode','language_code','needsIdentification','needs_identification',
      'latitude','longitude','names','metadata','currentCountry','currentAdmin',
      'placeType','typeAssignment','wikidataId','geonamesId','externalIds',
      'status','verificationStatus','parentRelation'],
    'PLACE_CREATE_V2', 200000
  );
  if p_project_id is null then raise exception 'PROJECT_ID_REQUIRED' using errcode = '22023'; end if;
  perform security_private.require_historical_project_edit_v1(p_project_id);
  if p_input ? 'externalIds' then
    if jsonb_typeof(p_input -> 'externalIds') = 'array' then
      external_items := p_input -> 'externalIds';
    elsif jsonb_typeof(p_input -> 'externalIds') = 'object' then
      select coalesce(jsonb_agg(
        case when jsonb_typeof(item.value) = 'object'
          then item.value || jsonb_build_object('provider',item.key)
          else jsonb_build_object(
            'provider',item.key,
            'externalIdentifier',item.value #>> '{}'
          )
        end order by item.key
      ),'[]'::jsonb)
      into external_items
      from jsonb_each(p_input -> 'externalIds') item;
    else
      raise exception 'PLACE_EXTERNAL_IDS_ARRAY_OR_OBJECT_REQUIRED' using errcode = '22023';
    end if;
  end if;
  if jsonb_array_length(external_items) > 20 then
    raise exception 'PLACE_EXTERNAL_IDS_LIMIT_EXCEEDED' using errcode = '22023';
  end if;
  if char_length(coalesce(p_input ->> 'currentCountry','')) > 500
     or char_length(coalesce(p_input ->> 'currentAdmin','')) > 2000 then
    raise exception 'PLACE_CURRENT_ADMIN_TOO_LONG' using errcode = '22023';
  end if;

  base_input := p_input - array[
    'metadata','currentCountry','currentAdmin','placeType','typeAssignment',
    'wikidataId','geonamesId','externalIds','status','verificationStatus',
    'parentRelation'
  ];
  create_result := public.create_project_place_v1(p_project_id, base_input);
  place_id_value := nullif(create_result #>> '{place,id}','')::uuid;
  if place_id_value is null then raise exception 'PLACE_CREATE_INVALID_RESPONSE' using errcode = 'P0002'; end if;

  metadata_value := coalesce(p_input -> 'metadata','{}'::jsonb);
  if jsonb_typeof(metadata_value) <> 'object' then
    raise exception 'PLACE_METADATA_OBJECT_REQUIRED' using errcode = '22023';
  end if;
  if p_input ? 'currentCountry' then
    metadata_value := jsonb_set(metadata_value, '{currentCountry}',
      to_jsonb(coalesce(p_input ->> 'currentCountry','')), true);
  end if;
  if p_input ? 'currentAdmin' then
    metadata_value := jsonb_set(metadata_value, '{currentAdmin}',
      to_jsonb(coalesce(p_input ->> 'currentAdmin','')), true);
  end if;
  if nullif(p_input ->> 'placeType','') is not null or p_input ? 'typeAssignment' then
    if p_input ? 'typeAssignment' and jsonb_typeof(p_input -> 'typeAssignment') <> 'object' then
      raise exception 'PLACE_TYPE_ASSIGNMENT_OBJECT_REQUIRED' using errcode = '22023';
    end if;
    type_payload := coalesce(p_input -> 'typeAssignment','{}'::jsonb)
      || jsonb_build_object(
        'placeTypeCode', coalesce(nullif(p_input ->> 'placeType',''),
          p_input #>> '{typeAssignment,placeTypeCode}'),
        'isPrimary', true
      );
    type_result := security_private.add_place_type_assignment_v1(place_id_value, type_payload);
  end if;

  if nullif(p_input ->> 'wikidataId','') is not null then
    identifier_result := security_private.add_place_external_identifier_v1(
      place_id_value, jsonb_build_object('provider','wikidata',
        'externalIdentifier',p_input ->> 'wikidataId','isPrimary',true)
    );
    external_results := external_results || jsonb_build_array(identifier_result);
  end if;
  if nullif(p_input ->> 'geonamesId','') is not null then
    identifier_result := security_private.add_place_external_identifier_v1(
      place_id_value, jsonb_build_object('provider','geonames',
        'externalIdentifier',p_input ->> 'geonamesId','isPrimary',true)
    );
    external_results := external_results || jsonb_build_array(identifier_result);
  end if;
  for external_item in select value from jsonb_array_elements(external_items)
  loop
    identifier_result := security_private.add_place_external_identifier_v1(place_id_value, external_item);
    external_results := external_results || jsonb_build_array(identifier_result);
  end loop;

  if p_input ? 'parentRelation' then
    if jsonb_typeof(p_input -> 'parentRelation') <> 'object' then
      raise exception 'PLACE_PARENT_RELATION_OBJECT_REQUIRED' using errcode = '22023';
    end if;
    if nullif(p_input #>> '{parentRelation,parentPlaceId}','') is null then
      raise exception 'PLACE_PARENT_ID_REQUIRED' using errcode = '22023';
    end if;
    parent_relation_result := security_private.add_place_hierarchy_relation_v1(
      place_id_value,
      (p_input #>> '{parentRelation,parentPlaceId}')::uuid,
      (p_input -> 'parentRelation') - 'parentPlaceId'
    );
  end if;

  -- Add type assignments, identifiers and the optional parent while the new
  -- Place is editable. Applying an archived lifecycle status first would make
  -- those same-transaction child writes reject their own freshly created row.
  if metadata_value <> '{}'::jsonb
     or p_input ? 'status' or p_input ? 'verificationStatus' then
    update public.places candidate set
      metadata = metadata_value,
      status = case when p_input ? 'status'
        then coalesce(p_input ->> 'status','') else candidate.status end,
      verification_status = case when p_input ? 'verificationStatus'
        then coalesce(p_input ->> 'verificationStatus','')
        else candidate.verification_status end
    where candidate.id = place_id_value;
  end if;

  return jsonb_build_object(
    'place', security_private.get_place_autocomplete_projection_v1(place_id_value,null,null,null)
      || jsonb_build_object('lockVersion',
        (select lock_version from public.places where id = place_id_value)),
    'typeAssignment', type_result,
    'externalIds', external_results,
    'parentRelation', parent_relation_result
  );
end;
$function$;

create or replace function security_private.patch_project_place_v2(
  p_place_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare
  current_row public.places;
  updated_row public.places;
  metadata_value jsonb;
  base_change boolean;
  external_item jsonb;
  external_results jsonb := '[]'::jsonb;
  type_payload jsonb;
  type_result jsonb;
  identifier_result jsonb;
  external_items jsonb := '[]'::jsonb;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['canonicalName','modernName','description','latitude','longitude','status',
      'verificationStatus','metadata','currentCountry','currentAdmin','placeType',
      'typeAssignment','wikidataId','geonamesId','externalIds'],
    'PLACE_PATCH_V2', 200000
  );
  current_row := security_private.require_historical_place_edit_v1(p_place_id);
  if current_row.status in ('merged','archived') and not (p_patch ? 'status') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);
  select * into current_row from public.places where id = p_place_id for update;
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_VERSION_CONFLICT' using errcode = '40001';
  end if;
  if p_patch ? 'externalIds' then
    if jsonb_typeof(p_patch -> 'externalIds') = 'array' then
      external_items := p_patch -> 'externalIds';
    elsif jsonb_typeof(p_patch -> 'externalIds') = 'object' then
      select coalesce(jsonb_agg(
        case when jsonb_typeof(item.value) = 'object'
          then item.value || jsonb_build_object('provider',item.key)
          else jsonb_build_object(
            'provider',item.key,
            'externalIdentifier',item.value #>> '{}'
          )
        end order by item.key
      ),'[]'::jsonb)
      into external_items
      from jsonb_each(p_patch -> 'externalIds') item;
    else
      raise exception 'PLACE_EXTERNAL_IDS_ARRAY_OR_OBJECT_REQUIRED' using errcode = '22023';
    end if;
  end if;
  if jsonb_array_length(external_items) > 20 then
    raise exception 'PLACE_EXTERNAL_IDS_LIMIT_EXCEEDED' using errcode = '22023';
  end if;
  if char_length(coalesce(p_patch ->> 'currentCountry','')) > 500
     or char_length(coalesce(p_patch ->> 'currentAdmin','')) > 2000 then
    raise exception 'PLACE_CURRENT_ADMIN_TOO_LONG' using errcode = '22023';
  end if;

  metadata_value := case when p_patch ? 'metadata' then p_patch -> 'metadata'
    else current_row.metadata end;
  if jsonb_typeof(metadata_value) <> 'object' then
    raise exception 'PLACE_METADATA_OBJECT_REQUIRED' using errcode = '22023';
  end if;
  if p_patch ? 'currentCountry' then
    metadata_value := jsonb_set(metadata_value, '{currentCountry}',
      to_jsonb(coalesce(p_patch ->> 'currentCountry','')), true);
  end if;
  if p_patch ? 'currentAdmin' then
    metadata_value := jsonb_set(metadata_value, '{currentAdmin}',
      to_jsonb(coalesce(p_patch ->> 'currentAdmin','')), true);
  end if;
  base_change := p_patch ?| array['canonicalName','modernName','description','latitude',
    'longitude','status','verificationStatus','metadata','currentCountry','currentAdmin'];
  -- Child rows are synchronized before a requested archive status is applied;
  -- their write contracts deliberately reject already archived places.
  if nullif(p_patch ->> 'placeType','') is not null or p_patch ? 'typeAssignment' then
    if p_patch ? 'typeAssignment' and jsonb_typeof(p_patch -> 'typeAssignment') <> 'object' then
      raise exception 'PLACE_TYPE_ASSIGNMENT_OBJECT_REQUIRED' using errcode = '22023';
    end if;
    type_payload := coalesce(p_patch -> 'typeAssignment','{}'::jsonb)
      || jsonb_build_object(
        'placeTypeCode', coalesce(nullif(p_patch ->> 'placeType',''),
          p_patch #>> '{typeAssignment,placeTypeCode}'),
        'isPrimary', true
      );
    type_result := security_private.add_place_type_assignment_v1(p_place_id,type_payload);
  end if;

  if p_patch ? 'wikidataId' then
    delete from public.place_external_identifiers identifier_row
    where identifier_row.place_id = p_place_id
      and lower(identifier_row.provider) = 'wikidata'
      and (
        nullif(btrim(coalesce(p_patch ->> 'wikidataId','')), '') is null
        or identifier_row.external_identifier <> btrim(p_patch ->> 'wikidataId')
      );
  end if;
  if p_patch ? 'geonamesId' then
    delete from public.place_external_identifiers identifier_row
    where identifier_row.place_id = p_place_id
      and lower(identifier_row.provider) = 'geonames'
      and (
        nullif(btrim(coalesce(p_patch ->> 'geonamesId','')), '') is null
        or identifier_row.external_identifier <> btrim(p_patch ->> 'geonamesId')
      );
  end if;
  if p_patch ? 'externalIds' then
    delete from public.place_external_identifiers identifier_row
    where identifier_row.place_id = p_place_id
      and lower(identifier_row.provider) not in ('wikidata','geonames')
      and not exists (
        select 1
        from jsonb_array_elements(external_items) desired
        where lower(btrim(coalesce(desired.value ->> 'provider',''))) = lower(identifier_row.provider)
          and btrim(coalesce(desired.value ->> 'externalIdentifier','')) = identifier_row.external_identifier
      );
  end if;

  if nullif(p_patch ->> 'wikidataId','') is not null then
    identifier_result := security_private.add_place_external_identifier_v1(
      p_place_id,jsonb_build_object('provider','wikidata',
        'externalIdentifier',p_patch ->> 'wikidataId','isPrimary',true));
    external_results := external_results || jsonb_build_array(identifier_result);
  end if;
  if nullif(p_patch ->> 'geonamesId','') is not null then
    identifier_result := security_private.add_place_external_identifier_v1(
      p_place_id,jsonb_build_object('provider','geonames',
        'externalIdentifier',p_patch ->> 'geonamesId','isPrimary',true));
    external_results := external_results || jsonb_build_array(identifier_result);
  end if;
  for external_item in select value from jsonb_array_elements(external_items)
  loop
    identifier_result := security_private.add_place_external_identifier_v1(p_place_id,external_item);
    external_results := external_results || jsonb_build_array(identifier_result);
  end loop;

  if base_change then
    update public.places candidate set
      canonical_name = case when p_patch ? 'canonicalName' then coalesce(p_patch ->> 'canonicalName','') else candidate.canonical_name end,
      modern_name = case when p_patch ? 'modernName' then coalesce(p_patch ->> 'modernName','') else candidate.modern_name end,
      description = case when p_patch ? 'description' then coalesce(p_patch ->> 'description','') else candidate.description end,
      latitude = case when p_patch ? 'latitude' then nullif(p_patch ->> 'latitude','')::numeric else candidate.latitude end,
      longitude = case when p_patch ? 'longitude' then nullif(p_patch ->> 'longitude','')::numeric else candidate.longitude end,
      status = case when p_patch ? 'status' then coalesce(p_patch ->> 'status','') else candidate.status end,
      verification_status = case when p_patch ? 'verificationStatus' then coalesce(p_patch ->> 'verificationStatus','') else candidate.verification_status end,
      metadata = metadata_value
    where candidate.id = p_place_id and candidate.lock_version = p_expected_lock_version
    returning * into updated_row;
    if not found then raise exception 'PLACE_VERSION_CONFLICT' using errcode = '40001'; end if;
  else
    updated_row := current_row;
  end if;

  return jsonb_build_object(
    'place', security_private.get_place_autocomplete_projection_v1(p_place_id,null,null,null)
      || jsonb_build_object('lockVersion',
        (select lock_version from public.places where id = p_place_id)),
    'typeAssignment', type_result,
    'externalIds', external_results
  );
end;
$function$;

create or replace function security_private.update_place_hierarchy_relation_v1(
  p_relation_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_hierarchy_relations;
  updated_row public.place_hierarchy_relations;
  parent_id uuid;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['parentPlaceId','relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','note','metadata'],
    'PLACE_HIERARCHY_PATCH'
  );
  select * into current_row from public.place_hierarchy_relations where id = p_relation_id;
  if not found then raise exception 'PLACE_HIERARCHY_RELATION_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.child_place_id);
  parent_id := case when p_patch ? 'parentPlaceId'
    then nullif(p_patch ->> 'parentPlaceId','')::uuid else current_row.parent_place_id end;
  perform security_private.lock_historical_place_ids_v1(
    array[current_row.child_place_id,current_row.parent_place_id,parent_id]::uuid[], true
  );
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_HIERARCHY_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.place_hierarchy_relations candidate set
    parent_place_id = parent_id,
    relation_type = case when p_patch ? 'relationType' then coalesce(p_patch ->> 'relationType','') else candidate.relation_type end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId' then nullif(p_patch ->> 'sourceDocumentId','')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId' then nullif(p_patch ->> 'citationId','')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_relation_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_HIERARCHY_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object(
    'id',updated_row.id,'childPlaceId',updated_row.child_place_id,
    'parentPlaceId',updated_row.parent_place_id,'relationType',updated_row.relation_type,
    'validFrom',updated_row.valid_from,'validTo',updated_row.valid_to,
    'validFromText',updated_row.valid_from_text,'validToText',updated_row.valid_to_text,
    'validFromPrecision',updated_row.valid_from_precision,
    'validToPrecision',updated_row.valid_to_precision,
    'sourceDocumentId',updated_row.source_document_id,'sourceFindingId',updated_row.source_finding_id,
    'citationId',updated_row.citation_id,'sourceReference',updated_row.source_reference,
    'confidence',updated_row.confidence,'note',updated_row.note,'metadata',updated_row.metadata,
    'lockVersion',updated_row.lock_version,'updatedAt',updated_row.updated_at
  );
end;
$function$;

create or replace function security_private.update_place_parish_relation_v1(
  p_relation_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_parish_relations;
  updated_row public.place_parish_relations;
  parish_id uuid;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['parishPlaceId','religion','relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','originalText','note','metadata'],
    'PLACE_PARISH_PATCH'
  );
  select * into current_row from public.place_parish_relations where id = p_relation_id;
  if not found then raise exception 'PLACE_PARISH_RELATION_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.place_id);
  parish_id := case when p_patch ? 'parishPlaceId'
    then nullif(p_patch ->> 'parishPlaceId','')::uuid else current_row.parish_place_id end;
  perform security_private.lock_historical_place_ids_v1(
    array[current_row.place_id,current_row.parish_place_id,parish_id]::uuid[], true
  );
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_PARISH_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.place_parish_relations candidate set
    parish_place_id = parish_id,
    religion = case when p_patch ? 'religion' then coalesce(p_patch ->> 'religion','') else candidate.religion end,
    relation_type = case when p_patch ? 'relationType' then coalesce(p_patch ->> 'relationType','') else candidate.relation_type end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId' then nullif(p_patch ->> 'sourceDocumentId','')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId' then nullif(p_patch ->> 'citationId','')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch ->> 'originalText','') else candidate.original_text end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_relation_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_PARISH_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object(
    'id',updated_row.id,'placeId',updated_row.place_id,'parishPlaceId',updated_row.parish_place_id,
    'religion',updated_row.religion,'relationType',updated_row.relation_type,
    'validFrom',updated_row.valid_from,'validTo',updated_row.valid_to,
    'validFromText',updated_row.valid_from_text,'validToText',updated_row.valid_to_text,
    'validFromPrecision',updated_row.valid_from_precision,'validToPrecision',updated_row.valid_to_precision,
    'sourceDocumentId',updated_row.source_document_id,'sourceFindingId',updated_row.source_finding_id,
    'citationId',updated_row.citation_id,'sourceReference',updated_row.source_reference,
    'confidence',updated_row.confidence,'originalText',updated_row.original_text,
    'note',updated_row.note,'metadata',updated_row.metadata,
    'lockVersion',updated_row.lock_version,'updatedAt',updated_row.updated_at
  );
end;
$function$;

create or replace function security_private.update_archive_resource_v1(
  p_resource_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.archive_resources;
  updated_row public.archive_resources;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['parentResourceId','resourceType','title','archiveName','fund','inventory',
      'fileReference','catalogueReference','url','description','sourceReference',
      'originalText','status','isPublic','metadata'],
    'ARCHIVE_RESOURCE_PATCH'
  );
  select * into current_row from public.archive_resources where id = p_resource_id for update;
  if not found then raise exception 'ARCHIVE_RESOURCE_NOT_FOUND' using errcode = 'P0002'; end if;
  if current_row.project_id is null then
    if coalesce(auth.role(),'') <> 'service_role' then
      raise exception 'GLOBAL_ARCHIVE_CHANGE_REQUEST_REQUIRED' using errcode = '42501';
    end if;
  else perform security_private.require_historical_project_edit_v1(current_row.project_id);
  end if;
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'ARCHIVE_RESOURCE_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.archive_resources candidate set
    parent_resource_id = case when p_patch ? 'parentResourceId' then nullif(p_patch ->> 'parentResourceId','')::uuid else candidate.parent_resource_id end,
    resource_type = case when p_patch ? 'resourceType' then coalesce(p_patch ->> 'resourceType','') else candidate.resource_type end,
    title = case when p_patch ? 'title' then coalesce(p_patch ->> 'title','') else candidate.title end,
    archive_name = case when p_patch ? 'archiveName' then coalesce(p_patch ->> 'archiveName','') else candidate.archive_name end,
    fund = case when p_patch ? 'fund' then coalesce(p_patch ->> 'fund','') else candidate.fund end,
    inventory = case when p_patch ? 'inventory' then coalesce(p_patch ->> 'inventory','') else candidate.inventory end,
    file_reference = case when p_patch ? 'fileReference' then coalesce(p_patch ->> 'fileReference','') else candidate.file_reference end,
    catalogue_reference = case when p_patch ? 'catalogueReference' then coalesce(p_patch ->> 'catalogueReference','') else candidate.catalogue_reference end,
    url = case when p_patch ? 'url' then nullif(p_patch ->> 'url','') else candidate.url end,
    description = case when p_patch ? 'description' then coalesce(p_patch ->> 'description','') else candidate.description end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch ->> 'originalText','') else candidate.original_text end,
    status = case when p_patch ? 'status' then coalesce(p_patch ->> 'status','') else candidate.status end,
    is_public = case when p_patch ? 'isPublic' then coalesce((p_patch ->> 'isPublic')::boolean,false) else candidate.is_public end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_resource_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'ARCHIVE_RESOURCE_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object(
    'id',updated_row.id,'projectId',updated_row.project_id,'parentResourceId',updated_row.parent_resource_id,
    'resourceType',updated_row.resource_type,'title',updated_row.title,
    'archiveName',updated_row.archive_name,'fund',updated_row.fund,'inventory',updated_row.inventory,
    'fileReference',updated_row.file_reference,'catalogueReference',updated_row.catalogue_reference,
    'url',updated_row.url,'description',updated_row.description,
    'sourceReference',updated_row.source_reference,'originalText',updated_row.original_text,
    'status',updated_row.status,'isPublic',updated_row.is_public,'metadata',updated_row.metadata,
    'lockVersion',updated_row.lock_version,'updatedAt',updated_row.updated_at
  );
end;
$function$;

create or replace function security_private.update_place_archive_relation_v1(
  p_relation_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.place_archive_relations;
  updated_row public.place_archive_relations;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['archiveResourceId','relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','originalText','note','metadata'],
    'PLACE_ARCHIVE_PATCH'
  );
  select * into current_row from public.place_archive_relations where id = p_relation_id;
  if not found then raise exception 'PLACE_ARCHIVE_RELATION_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_place_edit_v1(current_row.place_id);
  perform security_private.lock_historical_place_ids_v1(array[current_row.place_id]::uuid[], true);
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_ARCHIVE_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.place_archive_relations candidate set
    archive_resource_id = case when p_patch ? 'archiveResourceId' then nullif(p_patch ->> 'archiveResourceId','')::uuid else candidate.archive_resource_id end,
    relation_type = case when p_patch ? 'relationType' then coalesce(p_patch ->> 'relationType','') else candidate.relation_type end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId' then nullif(p_patch ->> 'sourceDocumentId','')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId' then nullif(p_patch ->> 'citationId','')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch ->> 'originalText','') else candidate.original_text end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_relation_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'PLACE_ARCHIVE_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object(
    'id',updated_row.id,'placeId',updated_row.place_id,
    'archiveResourceId',updated_row.archive_resource_id,'relationType',updated_row.relation_type,
    'validFrom',updated_row.valid_from,'validTo',updated_row.valid_to,
    'validFromText',updated_row.valid_from_text,'validToText',updated_row.valid_to_text,
    'validFromPrecision',updated_row.valid_from_precision,'validToPrecision',updated_row.valid_to_precision,
    'sourceDocumentId',updated_row.source_document_id,'sourceFindingId',updated_row.source_finding_id,
    'citationId',updated_row.citation_id,'sourceReference',updated_row.source_reference,
    'confidence',updated_row.confidence,'originalText',updated_row.original_text,
    'note',updated_row.note,'metadata',updated_row.metadata,
    'lockVersion',updated_row.lock_version,'updatedAt',updated_row.updated_at
  );
end;
$function$;

create or replace function security_private.update_document_place_link_v1(
  p_link_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  current_row public.document_place_links;
  updated_row public.document_place_links;
  place_id_value uuid;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array['placeId','relationType','originalText','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceFindingId','resolutionStatus',
      'sourceReference','confidence','note','metadata'],
    'DOCUMENT_PLACE_PATCH'
  );
  select * into current_row from public.document_place_links where id = p_link_id;
  if not found then raise exception 'DOCUMENT_PLACE_LINK_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_project_edit_v1(current_row.project_id);
  place_id_value := case when p_patch ? 'placeId'
    then nullif(p_patch ->> 'placeId','')::uuid else current_row.place_id end;
  perform security_private.lock_historical_place_ids_v1(
    array[current_row.place_id,place_id_value]::uuid[], true
  );
  if current_row.lock_version <> p_expected_lock_version then
    raise exception 'DOCUMENT_PLACE_VERSION_CONFLICT' using errcode = '40001';
  end if;
  update public.document_place_links candidate set
    place_id = place_id_value,
    relation_type = case when p_patch ? 'relationType' then coalesce(p_patch ->> 'relationType','') else candidate.relation_type end,
    original_text = case when p_patch ? 'originalText' then coalesce(p_patch ->> 'originalText','') else candidate.original_text end,
    valid_from = case when p_patch ? 'validFrom' then nullif(p_patch ->> 'validFrom','')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo' then nullif(p_patch ->> 'validTo','')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText' then nullif(p_patch ->> 'validFromText','') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText' then nullif(p_patch ->> 'validToText','') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision' then nullif(p_patch ->> 'validFromPrecision','') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision' then nullif(p_patch ->> 'validToPrecision','') else candidate.valid_to_precision end,
    source_finding_id = case when p_patch ? 'sourceFindingId' then nullif(p_patch ->> 'sourceFindingId','')::uuid else candidate.source_finding_id end,
    resolution_status = case when p_patch ? 'resolutionStatus' then coalesce(p_patch ->> 'resolutionStatus','') else candidate.resolution_status end,
    source_reference = case when p_patch ? 'sourceReference' then nullif(p_patch ->> 'sourceReference','') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence' then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    note = case when p_patch ? 'note' then coalesce(p_patch ->> 'note','') else candidate.note end,
    metadata = case when p_patch ? 'metadata' then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_link_id and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;
  if not found then raise exception 'DOCUMENT_PLACE_VERSION_CONFLICT' using errcode = '40001'; end if;
  return jsonb_build_object(
    'id',updated_row.id,'documentId',updated_row.document_id,'placeId',updated_row.place_id,
    'relationType',updated_row.relation_type,'originalText',updated_row.original_text,
    'validFrom',updated_row.valid_from,'validTo',updated_row.valid_to,
    'validFromText',updated_row.valid_from_text,'validToText',updated_row.valid_to_text,
    'validFromPrecision',updated_row.valid_from_precision,'validToPrecision',updated_row.valid_to_precision,
    'sourceFindingId',updated_row.source_finding_id,'resolutionStatus',updated_row.resolution_status,
    'sourceReference',updated_row.source_reference,'confidence',updated_row.confidence,
    'note',updated_row.note,'metadata',updated_row.metadata,
    'lockVersion',updated_row.lock_version,'updatedAt',updated_row.updated_at
  );
end;
$function$;

-- Validate a finding-backed document link at the table boundary as well as in
-- the RPC, so direct service maintenance cannot cross project scopes.
create or replace function security_private.set_document_place_link_scope_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  document_project_id uuid;
  place_project_id uuid;
  place_status text;
  place_verification_status text;
  finding_project_id uuid;
  finding_document_id uuid;
begin
  select project_id into document_project_id from public.documents where id = new.document_id;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  select project_id,status,verification_status
  into place_project_id,place_status,place_verification_status
  from public.places where id = new.place_id;
  if not found then raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002'; end if;
  if place_project_id is not null and place_project_id <> document_project_id then
    raise exception 'DOCUMENT_PLACE_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if place_project_id is null
     and not (place_status = 'active' and place_verification_status = 'verified') then
    raise exception 'DOCUMENT_PLACE_GLOBAL_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if new.source_finding_id is not null then
    select project_id,document_id into finding_project_id,finding_document_id
    from public.findings where id = new.source_finding_id;
    if not found then raise exception 'FINDING_NOT_FOUND' using errcode = 'P0002'; end if;
    if finding_project_id <> document_project_id then
      raise exception 'FINDING_DOCUMENT_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
    end if;
    if finding_document_id is not null and finding_document_id <> new.document_id then
      raise exception 'FINDING_DOCUMENT_MISMATCH' using errcode = '22023';
    end if;
  end if;
  new.project_id := document_project_id;
  return new;
end;
$function$;

create or replace function security_private.confirm_finding_document_place_v1(
  p_finding_id uuid,
  p_document_id uuid,
  p_place_id uuid,
  p_original_text text,
  p_resolution_status text default 'confirmed',
  p_expected_finding_updated_at timestamptz default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  finding_row public.findings;
  document_project_id uuid;
  existing_row public.document_place_links;
  saved_row public.document_place_links;
  exact_text text := coalesce(p_original_text,'');
  had_existing boolean := false;
begin
  if p_finding_id is null or p_document_id is null or p_place_id is null then
    raise exception 'FINDING_DOCUMENT_PLACE_IDS_REQUIRED' using errcode = '22023';
  end if;
  if exact_text = '' or char_length(exact_text) > 20000 then
    raise exception 'FINDING_PLACE_ORIGINAL_TEXT_REQUIRED' using errcode = '22023';
  end if;
  if p_resolution_status not in ('confirmed','needs_review') then
    raise exception 'FINDING_PLACE_RESOLUTION_STATUS_INVALID' using errcode = '22023';
  end if;

  -- One lock serializes retries and competing clients for the same finding.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('historical-place-finding:' || p_finding_id::text, 0)
  );
  select * into finding_row from public.findings where id = p_finding_id for update;
  if not found then raise exception 'FINDING_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_project_edit_v1(finding_row.project_id);
  if p_expected_finding_updated_at is not null
     and finding_row.updated_at is distinct from p_expected_finding_updated_at then
    raise exception 'FINDING_VERSION_CONFLICT' using errcode = '40001';
  end if;
  select project_id into document_project_id from public.documents where id = p_document_id;
  if not found then raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002'; end if;
  if document_project_id <> finding_row.project_id then
    raise exception 'FINDING_DOCUMENT_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
  end if;
  if finding_row.document_id is not null and finding_row.document_id <> p_document_id then
    raise exception 'FINDING_DOCUMENT_MISMATCH' using errcode = '22023';
  end if;

  select * into existing_row
  from public.document_place_links
  where source_finding_id = p_finding_id
    and relation_type = 'mentions'
  for update;
  had_existing := found;
  perform security_private.lock_historical_place_ids_v1(
    array[existing_row.place_id,p_place_id]::uuid[], true
  );

  if had_existing then
    if existing_row.original_text <> exact_text then
      raise exception 'FINDING_PLACE_ORIGINAL_TEXT_CONFLICT' using errcode = '22023';
    end if;
    if existing_row.document_id = p_document_id
       and existing_row.place_id = p_place_id
       and existing_row.resolution_status = p_resolution_status then
      saved_row := existing_row;
    else
      update public.document_place_links link_row set
        document_id = p_document_id,
        place_id = p_place_id,
        resolution_status = p_resolution_status,
        source_reference = 'finding:' || p_finding_id::text,
        metadata = link_row.metadata || jsonb_build_object(
          'confirmationSource','finding','confirmedBy',auth.uid()
        )
      where link_row.id = existing_row.id
      returning * into saved_row;
    end if;
  else
    insert into public.document_place_links (
      document_id,place_id,relation_type,original_text,source_finding_id,
      resolution_status,source_reference,confidence,metadata,created_by
    ) values (
      p_document_id,p_place_id,'mentions',exact_text,p_finding_id,
      p_resolution_status,'finding:' || p_finding_id::text,
      case when p_resolution_status = 'confirmed' then 100 else 50 end,
      jsonb_build_object('confirmationSource','finding','confirmedBy',auth.uid()),
      auth.uid()
    ) returning * into saved_row;
  end if;

  return jsonb_build_object(
    'id',saved_row.id,'findingId',saved_row.source_finding_id,
    'documentId',saved_row.document_id,'placeId',saved_row.place_id,
    'originalText',saved_row.original_text,'resolutionStatus',saved_row.resolution_status,
    'sourceReference',saved_row.source_reference,'lockVersion',saved_row.lock_version,
    'idempotent',had_existing
      and existing_row.document_id = p_document_id
      and existing_row.place_id = p_place_id
      and existing_row.resolution_status = p_resolution_status
  );
end;
$function$;

create or replace function security_private.get_finding_document_place_v1(
  p_finding_id uuid
)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  finding_row public.findings;
  link_row public.document_place_links;
  place_row public.places;
  place_projection jsonb;
  external_rows jsonb;
  wikidata_value text;
  geonames_value text;
begin
  if p_finding_id is null then
    raise exception 'FINDING_ID_REQUIRED' using errcode = '22023';
  end if;
  select * into finding_row from public.findings where id = p_finding_id;
  if not found then raise exception 'FINDING_NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and (auth.uid() is null or not public.is_project_member(finding_row.project_id)) then
    raise exception 'FINDING_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select * into link_row
  from public.document_place_links
  where source_finding_id = p_finding_id and relation_type = 'mentions'
  order by id
  limit 1;
  if not found then
    return jsonb_build_object(
      'findingId',finding_row.id,
      'currentDocumentId',finding_row.document_id,
      'documentMatchesFinding',null,
      'link',null,
      'place',null
    );
  end if;

  select * into place_row from public.places where id = link_row.place_id;
  if not found or not security_private.can_read_historical_place_v2(link_row.place_id) then
    raise exception 'PLACE_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  place_projection := security_private.get_place_autocomplete_projection_v1(
    place_row.id,null,null,null
  );
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id',identifier_row.id,
      'provider',identifier_row.provider,
      'externalIdentifier',identifier_row.external_identifier,
      'sourceUrl',identifier_row.source_url,
      'isPrimary',identifier_row.is_primary,
      'metadata',identifier_row.metadata,
      'lockVersion',identifier_row.lock_version
    ) order by identifier_row.provider,identifier_row.is_primary desc,identifier_row.id),'[]'::jsonb),
    max(identifier_row.external_identifier) filter (where lower(identifier_row.provider) = 'wikidata'),
    max(identifier_row.external_identifier) filter (where lower(identifier_row.provider) = 'geonames')
  into external_rows,wikidata_value,geonames_value
  from public.place_external_identifiers identifier_row
  where identifier_row.place_id = place_row.id;

  return jsonb_build_object(
    'findingId',finding_row.id,
    'currentDocumentId',finding_row.document_id,
    'documentMatchesFinding',link_row.document_id is not distinct from finding_row.document_id,
    'link',jsonb_build_object(
      'id',link_row.id,
      'findingId',link_row.source_finding_id,
      'documentId',link_row.document_id,
      'placeId',link_row.place_id,
      'relationType',link_row.relation_type,
      'originalText',link_row.original_text,
      'resolutionStatus',link_row.resolution_status,
      'sourceReference',link_row.source_reference,
      'confidence',link_row.confidence,
      'note',link_row.note,
      'metadata',link_row.metadata,
      'lockVersion',link_row.lock_version,
      'createdAt',link_row.created_at,
      'updatedAt',link_row.updated_at
    ),
    'place',place_projection || jsonb_build_object(
      'status',place_row.status,
      'verificationStatus',place_row.verification_status,
      'isPublic',place_row.is_public,
      'publishedAt',place_row.published_at,
      'description',place_row.description,
      'wikidataId',wikidata_value,
      'geonamesId',geonames_value,
      'externalIds',external_rows,
      'names',place_projection -> 'historicalNames',
      'matchedName',place_projection ->> 'displayName',
      'matchedNameType',coalesce(
        place_projection #>> '{historicalNames,0,nameType}','canonical'
      ),
      'lockVersion',place_row.lock_version,
      'createdAt',place_row.created_at,
      'updatedAt',place_row.updated_at
    )
  );
end;
$function$;

create or replace function security_private.clear_finding_document_place_v1(
  p_finding_id uuid,
  p_expected_finding_updated_at timestamptz default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  finding_row public.findings;
  deleted_row public.document_place_links;
begin
  if p_finding_id is null then
    raise exception 'FINDING_ID_REQUIRED' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('historical-place-finding:' || p_finding_id::text, 0)
  );
  select * into finding_row from public.findings where id = p_finding_id for update;
  if not found then raise exception 'FINDING_NOT_FOUND' using errcode = 'P0002'; end if;
  perform security_private.require_historical_project_edit_v1(finding_row.project_id);
  if p_expected_finding_updated_at is not null
     and finding_row.updated_at is distinct from p_expected_finding_updated_at then
    raise exception 'FINDING_VERSION_CONFLICT' using errcode = '40001';
  end if;

  delete from public.document_place_links link_row
  where link_row.source_finding_id = p_finding_id
    and link_row.relation_type = 'mentions'
  returning * into deleted_row;

  return jsonb_build_object(
    'findingId',finding_row.id,
    'cleared',deleted_row.id is not null,
    'linkId',deleted_row.id,
    'documentId',deleted_row.document_id,
    'placeId',deleted_row.place_id,
    'originalText',deleted_row.original_text,
    'resolutionStatus',deleted_row.resolution_status
  );
end;
$function$;

-- ---------------------------------------------------------------------------
-- Public invoker facades
-- ---------------------------------------------------------------------------

create or replace function public.search_places_v2(
  p_query text default '', p_at_date date default null,
  p_period_from date default null, p_period_to date default null,
  p_date_precision text default null, p_project_id uuid default null,
  p_limit integer default 20, p_ancestor_place_id uuid default null,
  p_latitude numeric default null, p_longitude numeric default null,
  p_radius_km numeric default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.search_places_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11); $wrapper$;

create or replace function public.get_place_autocomplete_projection_v1(
  p_place_id uuid, p_at_date date default null,
  p_period_from date default null, p_period_to date default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.get_place_autocomplete_projection_v1($1,$2,$3,$4); $wrapper$;

create or replace function public.resolve_place_hierarchy_period_v1(
  p_place_id uuid, p_period_from date, p_period_to date,
  p_max_depth integer default 12
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.resolve_place_hierarchy_period_v1($1,$2,$3,$4); $wrapper$;

create or replace function public.list_place_boundaries_v2(
  p_place_id uuid, p_at_date date default null,
  p_period_from date default null, p_period_to date default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_boundaries_v2($1,$2,$3,$4); $wrapper$;

create or replace function public.list_place_documents_v2(
  p_place_id uuid, p_period_from date default null, p_period_to date default null,
  p_limit integer default 100, p_offset integer default 0
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_documents_v2($1,$2,$3,$4,$5); $wrapper$;

create or replace function public.list_place_events_v2(
  p_place_id uuid, p_period_from date default null, p_period_to date default null,
  p_limit integer default 100, p_offset integer default 0
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_events_v2($1,$2,$3,$4,$5); $wrapper$;

create or replace function public.get_place_map_context_v1(
  p_place_id uuid, p_at_date date default null,
  p_period_from date default null, p_period_to date default null,
  p_limit integer default 100
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.get_place_map_context_v1($1,$2,$3,$4,$5); $wrapper$;

create or replace function public.create_project_place_v2(p_project_id uuid,p_input jsonb)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.create_project_place_v2($1,$2); $wrapper$;

create or replace function public.patch_project_place_v2(
  p_place_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.patch_project_place_v2($1,$2,$3); $wrapper$;

create or replace function public.add_place_type_assignment_v1(p_place_id uuid,p_payload jsonb)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_type_assignment_v1($1,$2); $wrapper$;

create or replace function public.update_place_type_assignment_v1(
  p_assignment_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_type_assignment_v1($1,$2,$3); $wrapper$;

create or replace function public.add_place_external_identifier_v1(p_place_id uuid,p_payload jsonb)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_external_identifier_v1($1,$2); $wrapper$;

create or replace function public.update_place_external_identifier_v1(
  p_identifier_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_external_identifier_v1($1,$2,$3); $wrapper$;

create or replace function public.add_place_relation_v1(
  p_place_id uuid,p_related_place_id uuid,p_payload jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_relation_v1($1,$2,$3); $wrapper$;

create or replace function public.update_place_relation_v1(
  p_relation_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_relation_v1($1,$2,$3); $wrapper$;

create or replace function public.add_place_boundary_v1(p_place_id uuid,p_payload jsonb)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_boundary_v1($1,$2); $wrapper$;

create or replace function public.update_place_boundary_v1(
  p_boundary_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_boundary_v1($1,$2,$3); $wrapper$;

create or replace function public.update_place_hierarchy_relation_v1(
  p_relation_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_hierarchy_relation_v1($1,$2,$3); $wrapper$;

create or replace function public.update_place_parish_relation_v1(
  p_relation_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_parish_relation_v1($1,$2,$3); $wrapper$;

create or replace function public.update_archive_resource_v1(
  p_resource_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_archive_resource_v1($1,$2,$3); $wrapper$;

create or replace function public.update_place_archive_relation_v1(
  p_relation_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_archive_relation_v1($1,$2,$3); $wrapper$;

create or replace function public.update_document_place_link_v1(
  p_link_id uuid,p_expected_lock_version integer,p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_document_place_link_v1($1,$2,$3); $wrapper$;

create or replace function public.confirm_finding_document_place_v1(
  p_finding_id uuid,p_document_id uuid,p_place_id uuid,p_original_text text,
  p_resolution_status text default 'confirmed',
  p_expected_finding_updated_at timestamptz default null
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.confirm_finding_document_place_v1($1,$2,$3,$4,$5,$6); $wrapper$;

create or replace function public.get_finding_document_place_v1(p_finding_id uuid)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.get_finding_document_place_v1($1); $wrapper$;

create or replace function public.clear_finding_document_place_v1(
  p_finding_id uuid,p_expected_finding_updated_at timestamptz default null
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.clear_finding_document_place_v1($1,$2); $wrapper$;

do $read_grants$
declare signature text;
begin
  foreach signature in array array[
    'security_private.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)',
    'security_private.get_place_autocomplete_projection_v1(uuid,date,date,date)',
    'security_private.resolve_place_hierarchy_period_v1(uuid,date,date,integer)',
    'public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric)',
    'public.get_place_autocomplete_projection_v1(uuid,date,date,date)',
    'public.resolve_place_hierarchy_period_v1(uuid,date,date,integer)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',signature);
    execute format('grant execute on function %s to anon,authenticated,service_role',signature);
  end loop;
end;
$read_grants$;

do $authenticated_grants$
declare signature text;
begin
  foreach signature in array array[
    'security_private.list_place_boundaries_v2(uuid,date,date,date)',
    'security_private.list_place_documents_v2(uuid,date,date,integer,integer)',
    'security_private.list_place_events_v2(uuid,date,date,integer,integer)',
    'security_private.get_place_map_context_v1(uuid,date,date,date,integer)',
    'security_private.create_project_place_v2(uuid,jsonb)',
    'security_private.patch_project_place_v2(uuid,integer,jsonb)',
    'security_private.add_place_type_assignment_v1(uuid,jsonb)',
    'security_private.update_place_type_assignment_v1(uuid,integer,jsonb)',
    'security_private.add_place_external_identifier_v1(uuid,jsonb)',
    'security_private.update_place_external_identifier_v1(uuid,integer,jsonb)',
    'security_private.add_place_relation_v1(uuid,uuid,jsonb)',
    'security_private.update_place_relation_v1(uuid,integer,jsonb)',
    'security_private.add_place_boundary_v1(uuid,jsonb)',
    'security_private.update_place_boundary_v1(uuid,integer,jsonb)',
    'security_private.update_place_hierarchy_relation_v1(uuid,integer,jsonb)',
    'security_private.update_place_parish_relation_v1(uuid,integer,jsonb)',
    'security_private.update_archive_resource_v1(uuid,integer,jsonb)',
    'security_private.update_place_archive_relation_v1(uuid,integer,jsonb)',
    'security_private.update_document_place_link_v1(uuid,integer,jsonb)',
    'security_private.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)',
    'security_private.get_finding_document_place_v1(uuid)',
    'security_private.clear_finding_document_place_v1(uuid,timestamptz)',
    'public.list_place_boundaries_v2(uuid,date,date,date)',
    'public.list_place_documents_v2(uuid,date,date,integer,integer)',
    'public.list_place_events_v2(uuid,date,date,integer,integer)',
    'public.get_place_map_context_v1(uuid,date,date,date,integer)',
    'public.create_project_place_v2(uuid,jsonb)',
    'public.patch_project_place_v2(uuid,integer,jsonb)',
    'public.add_place_type_assignment_v1(uuid,jsonb)',
    'public.update_place_type_assignment_v1(uuid,integer,jsonb)',
    'public.add_place_external_identifier_v1(uuid,jsonb)',
    'public.update_place_external_identifier_v1(uuid,integer,jsonb)',
    'public.add_place_relation_v1(uuid,uuid,jsonb)',
    'public.update_place_relation_v1(uuid,integer,jsonb)',
    'public.add_place_boundary_v1(uuid,jsonb)',
    'public.update_place_boundary_v1(uuid,integer,jsonb)',
    'public.update_place_hierarchy_relation_v1(uuid,integer,jsonb)',
    'public.update_place_parish_relation_v1(uuid,integer,jsonb)',
    'public.update_archive_resource_v1(uuid,integer,jsonb)',
    'public.update_place_archive_relation_v1(uuid,integer,jsonb)',
    'public.update_document_place_link_v1(uuid,integer,jsonb)',
    'public.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz)',
    'public.get_finding_document_place_v1(uuid)',
    'public.clear_finding_document_place_v1(uuid,timestamptz)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',signature);
    execute format('grant execute on function %s to authenticated,service_role',signature);
  end loop;
end;
$authenticated_grants$;

do $private_helpers$
declare signature text;
begin
  foreach signature in array array[
    'security_private.historical_text_date_bound_v1(text,boolean)',
    'security_private.assert_historical_period_v1(date,date,date,text,text)',
    'security_private.can_read_historical_place_v2(uuid)',
    'security_private.place_type_assignment_json_v1(public.place_type_assignments)',
    'security_private.place_external_identifier_json_v1(public.place_external_identifiers)',
    'security_private.place_relation_json_v1(public.place_relations)',
    'security_private.place_boundary_json_v1(public.place_boundaries)'
  ] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',signature);
  end loop;
end;
$private_helpers$;

-- The versioned update RPCs are the only authenticated mutation path for
-- optimistic rows. INSERT and DELETE remain protected by existing RLS and
-- scope/audit/advisory-lock triggers.
revoke update on table public.place_external_identifiers from authenticated;
revoke update on table public.place_type_assignments from authenticated;
revoke update on table public.place_hierarchy_relations from authenticated;
revoke update on table public.place_boundaries from authenticated;
revoke update on table public.place_relations from authenticated;
revoke update on table public.place_parish_relations from authenticated;
revoke update on table public.archive_resources from authenticated;
revoke update on table public.place_archive_relations from authenticated;
revoke update on table public.document_place_links from authenticated;

comment on function public.search_places_v2(text,date,date,date,text,uuid,integer,uuid,numeric,numeric,numeric) is
  'Safe Place autocomplete/search by name, explicit ancestor UUID, or explicit latitude/longitude/radius. Exact date and period are mutually exclusive.';
comment on function public.get_place_map_context_v1(uuid,date,date,date,integer) is
  'Single bounded read model for a Place map at an exact date or explicit historical period; never invents an exact day.';
comment on function public.confirm_finding_document_place_v1(uuid,uuid,uuid,text,text,timestamptz) is
  'Idempotently records a user-confirmed finding/document/Place link while preserving source text byte-for-byte.';
comment on function public.get_finding_document_place_v1(uuid) is
  'Loads the persisted finding-backed document/Place decision and a safe Place summary for a project member.';
comment on function public.clear_finding_document_place_v1(uuid,timestamptz) is
  'Idempotently removes only the finding-backed Place link; the finding and its source text remain unchanged.';

notify pgrst, 'reload schema';

analyze public.places;
analyze public.document_place_links;

commit;
