begin;

-- A historical place name and a coordinate are separate facts.  The source
-- wording remains in source_location_*/found_location_*; these optional pins
-- exist only after a contributor has consciously confirmed a map point.
create or replace function security_private.normalize_zagulyaky_geo_point_v1(
  p_geo jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  latitude_text text;
  longitude_text text;
  latitude_value numeric;
  longitude_value numeric;
  display_name text;
  point_source text;
  point_precision text;
  provider_name text;
  external_identifier text;
begin
  if p_geo is null or p_geo = 'null'::jsonb then
    return null;
  end if;
  if jsonb_typeof(p_geo) <> 'object' then
    raise exception 'INVALID_ZAGULYAKA_GEO_POINT' using errcode = '22023';
  end if;
  if octet_length(p_geo::text) > 4096 then
    raise exception 'ZAGULYAKA_GEO_POINT_TOO_LARGE' using errcode = '54000';
  end if;
  if coalesce(jsonb_typeof(p_geo -> 'latitude'), '') not in ('number', 'string')
    or coalesce(jsonb_typeof(p_geo -> 'longitude'), '') not in ('number', 'string') then
    raise exception 'ZAGULYAKA_GEO_COORDINATES_REQUIRED' using errcode = '22023';
  end if;

  latitude_text := btrim(coalesce(p_geo ->> 'latitude', ''));
  longitude_text := btrim(coalesce(p_geo ->> 'longitude', ''));
  if latitude_text !~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$'
    or longitude_text !~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$' then
    raise exception 'INVALID_ZAGULYAKA_GEO_COORDINATES' using errcode = '22023';
  end if;
  latitude_value := latitude_text::numeric;
  longitude_value := longitude_text::numeric;
  if latitude_value < -90 or latitude_value > 90
    or longitude_value < -180 or longitude_value > 180 then
    raise exception 'ZAGULYAKA_GEO_COORDINATES_OUT_OF_RANGE' using errcode = '22023';
  end if;

  display_name := nullif(btrim(coalesce(p_geo ->> 'displayName', '')), '');
  provider_name := nullif(btrim(coalesce(p_geo ->> 'provider', '')), '');
  external_identifier := nullif(btrim(coalesce(p_geo ->> 'externalId', '')), '');
  if char_length(coalesce(display_name, '')) > 500
    or char_length(coalesce(provider_name, '')) > 160
    or char_length(coalesce(external_identifier, '')) > 240 then
    raise exception 'ZAGULYAKA_GEO_POINT_TEXT_TOO_LONG' using errcode = '22023';
  end if;

  point_source := lower(coalesce(nullif(btrim(p_geo ->> 'source'), ''), 'unknown'));
  point_precision := lower(coalesce(nullif(btrim(p_geo ->> 'precision'), ''), 'unknown'));
  if point_source not in ('search', 'map_click', 'import', 'unknown') then
    raise exception 'INVALID_ZAGULYAKA_GEO_SOURCE' using errcode = '22023';
  end if;
  if point_precision not in ('exact', 'approximate', 'settlement', 'unknown') then
    raise exception 'INVALID_ZAGULYAKA_GEO_PRECISION' using errcode = '22023';
  end if;

  -- Deliberately whitelist fields.  A client-selected marker colour is a
  -- presentation detail, so public maps derive colours from the point role.
  return jsonb_build_object(
    'displayName', display_name,
    'latitude', latitude_value,
    'longitude', longitude_value,
    'source', point_source,
    'precision', point_precision,
    'provider', provider_name,
    'externalId', external_identifier
  );
end;
$function$;

create or replace function security_private.zagulyaky_geo_point_is_canonical_v1(
  p_geo jsonb
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  latitude_text text;
  longitude_text text;
  latitude_value numeric;
  longitude_value numeric;
begin
  if p_geo is null or jsonb_typeof(p_geo) <> 'object' then
    return false;
  end if;
  if not (p_geo ?& array[
    'displayName', 'latitude', 'longitude', 'source', 'precision', 'provider', 'externalId'
  ]) then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_object_keys(p_geo) as geo_key(key_name)
    where geo_key.key_name not in (
      'displayName', 'latitude', 'longitude', 'source', 'precision', 'provider', 'externalId'
    )
  ) then
    return false;
  end if;
  if jsonb_typeof(p_geo -> 'latitude') <> 'number'
    or jsonb_typeof(p_geo -> 'longitude') <> 'number'
    or jsonb_typeof(p_geo -> 'source') <> 'string'
    or jsonb_typeof(p_geo -> 'precision') <> 'string' then
    return false;
  end if;

  latitude_text := p_geo ->> 'latitude';
  longitude_text := p_geo ->> 'longitude';
  if latitude_text !~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$'
    or longitude_text !~ '^-?(0|[1-9][0-9]*)([.][0-9]+)?$' then
    return false;
  end if;
  latitude_value := latitude_text::numeric;
  longitude_value := longitude_text::numeric;
  if latitude_value < -90 or latitude_value > 90
    or longitude_value < -180 or longitude_value > 180 then
    return false;
  end if;
  if p_geo ->> 'source' not in ('search', 'map_click', 'import', 'unknown')
    or p_geo ->> 'precision' not in ('exact', 'approximate', 'settlement', 'unknown') then
    return false;
  end if;
  if (jsonb_typeof(p_geo -> 'displayName') not in ('string', 'null'))
    or (jsonb_typeof(p_geo -> 'provider') not in ('string', 'null'))
    or (jsonb_typeof(p_geo -> 'externalId') not in ('string', 'null')) then
    return false;
  end if;
  if char_length(coalesce(p_geo ->> 'displayName', '')) > 500
    or char_length(coalesce(p_geo ->> 'provider', '')) > 160
    or char_length(coalesce(p_geo ->> 'externalId', '')) > 240 then
    return false;
  end if;
  return true;
end;
$function$;

alter table public.zagulyaky_records
  add column if not exists origin_geo jsonb,
  add column if not exists found_geo jsonb;

alter table public.zagulyaky_records
  drop constraint if exists zagulyaky_records_origin_geo_check;
alter table public.zagulyaky_records
  add constraint zagulyaky_records_origin_geo_check check (
    origin_geo is null or security_private.zagulyaky_geo_point_is_canonical_v1(origin_geo)
  );
alter table public.zagulyaky_records
  drop constraint if exists zagulyaky_records_found_geo_check;
alter table public.zagulyaky_records
  add constraint zagulyaky_records_found_geo_check check (
    found_geo is null or security_private.zagulyaky_geo_point_is_canonical_v1(found_geo)
  );

-- The current browser RPCs already pass a bounded `payload` object.  Take
-- temporary map keys out of that object before persistence instead of
-- widening their public contract or letting geo data become unvalidated JSON.
create or replace function security_private.normalize_zagulyaky_record_map_points_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if jsonb_typeof(new.payload) = 'object' then
    if new.payload ? 'originGeo' then
      new.origin_geo := security_private.normalize_zagulyaky_geo_point_v1(new.payload -> 'originGeo');
    end if;
    if new.payload ? 'foundGeo' then
      new.found_geo := security_private.normalize_zagulyaky_geo_point_v1(new.payload -> 'foundGeo');
    end if;
    new.payload := new.payload - array['originGeo', 'foundGeo'];
  end if;
  return new;
end;
$function$;

drop trigger if exists zagulyaky_records_normalize_map_points on public.zagulyaky_records;
create trigger zagulyaky_records_normalize_map_points
before insert or update of payload on public.zagulyaky_records
for each row execute function security_private.normalize_zagulyaky_record_map_points_v1();

-- A new location is content, not a workflow field.  It must invalidate a
-- living-person clearance if changed, just like a name, source or transcript.
create or replace function security_private.zagulyaky_living_person_content_fingerprint_v1(
  p_record_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  content_snapshot jsonb;
  fingerprint text;
begin
  select jsonb_build_object(
    'record', jsonb_build_object(
      'kind', record_row.kind,
      'title', record_row.title,
      'summary', record_row.summary,
      'originalText', record_row.original_text,
      'normalizedText', record_row.normalized_text,
      'originalLanguage', record_row.original_language,
      'eventType', record_row.event_type,
      'eventDateText', record_row.event_date_text,
      'eventYearFrom', record_row.event_year_from,
      'eventYearTo', record_row.event_year_to,
      'datePrecision', record_row.date_precision,
      'sourceLocationText', record_row.source_location_text,
      'sourceLocationNormalized', record_row.source_location_normalized,
      'foundLocationText', record_row.found_location_text,
      'foundLocationNormalized', record_row.found_location_normalized,
      'originGeo', record_row.origin_geo,
      'foundGeo', record_row.found_geo,
      'classificationReason', record_row.classification_reason,
      'payload', record_row.payload,
      'possibleLivingPerson', record_row.possible_living_person
    ),
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', participant.role,
        'eventRoleCode', participant.event_role_code,
        'eventRoleCustom', participant.event_role_custom,
        'originalFullName', participant.original_full_name,
        'normalizedUkFullName', participant.normalized_uk_full_name,
        'surname', participant.surname,
        'givenName', participant.given_name,
        'patronymic', participant.patronymic,
        'maidenName', participant.maiden_name,
        'sex', participant.sex,
        'ageText', participant.age_text,
        'residenceText', participant.residence_text,
        'originText', participant.origin_text,
        'notes', participant.notes,
        'sortOrder', participant.sort_order
      ) order by participant.sort_order, participant.role,
        participant.normalized_uk_full_name, participant.original_full_name,
        participant.id)
      from public.zagulyaky_participants participant
      where participant.record_id = record_row.id
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'isPrimary', link.is_primary,
        'sourceType', source.source_type,
        'title', source.title,
        'archiveName', source.archive_name,
        'fond', source.fond,
        'inventory', source.inventory,
        'fileNumber', source.file_number,
        'pageFrom', source.page_from,
        'pageTo', source.page_to,
        'citation', source.citation,
        'sourceUrl', source.source_url,
        'sourcePlatform', source.source_platform,
        'externalId', source.external_id,
        'accessDate', source.access_date,
        'permissionStatus', source.permission_status,
        'metadata', source.metadata
      ) order by link.is_primary desc, source.source_type, source.title,
        source.citation, source.id)
      from public.zagulyaky_record_sources link
      join public.zagulyaky_sources source on source.id = link.source_id
      where link.record_id = record_row.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'officialLocationText', discovery.official_location_text,
        'discoveredLocationText', discovery.discovered_location_text,
        'recordTypes', discovery.record_types,
        'factualYearFrom', discovery.factual_year_from,
        'factualYearTo', discovery.factual_year_to,
        'pageFrom', discovery.page_from,
        'pageTo', discovery.page_to,
        'notes', discovery.notes
      ) order by discovery.official_location_text, discovery.discovered_location_text,
        discovery.factual_year_from nulls first, discovery.factual_year_to nulls first,
        discovery.page_from nulls first, discovery.page_to nulls first, discovery.id)
      from public.zagulyaky_document_discoveries discovery
      where discovery.record_id = record_row.id
    ), '[]'::jsonb)
  ) into content_snapshot
  from public.zagulyaky_records record_row
  where record_row.id = p_record_id;

  if content_snapshot is null then
    return null;
  end if;

  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute 'select encode(extensions.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into fingerprint using content_snapshot::text;
  elsif to_regprocedure('public.digest(bytea,text)') is not null then
    execute 'select encode(public.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into fingerprint using content_snapshot::text;
  else
    raise exception 'PGCRYPTO_DIGEST_REQUIRED' using errcode = '55000';
  end if;
  return fingerprint;
end;
$function$;

-- The canonical fingerprint gained two keys even for records without pins.
-- Rebind existing approvals at the schema boundary; future point changes will
-- naturally require a new review for a possible living person.
update public.zagulyaky_privacy_clearances clearance
set reviewed_content_fingerprint = security_private.zagulyaky_living_person_content_fingerprint_v1(clearance.record_id),
    updated_at = now()
where clearance.review_status = 'approved';

-- Preserve the current public facade: it still redacts attachment storage
-- paths, checks living-person clearance and appends only explicitly approved
-- Facebook origins.  Pins appear only after those existing visibility gates.
create or replace function public.get_public_zagulyaka_v1(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as (
    select security_private.get_public_zagulyaka_v1($1) as payload
  )
  select case
    when source.payload is null then null
    when exists (
      select 1
      from public.zagulyaky_records record_row
      where record_row.id::text = (source.payload ->> 'id')
        and record_row.possible_living_person
        and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
    ) then null
    else jsonb_set(
      source.payload,
      '{publicAttachments}',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', attachment.value -> 'id',
          'fileName', attachment.value -> 'fileName',
          'mimeType', attachment.value -> 'mimeType',
          'byteSize', attachment.value -> 'byteSize'
        ) order by attachment.ordinality)
        from jsonb_array_elements(coalesce(source.payload -> 'publicAttachments', '[]'::jsonb))
          with ordinality as attachment(value, ordinality)
      ), '[]'::jsonb),
      true
    ) || coalesce(
      security_private.zagulyaky_public_facebook_origin_v1((source.payload ->> 'id')::uuid),
      '{}'::jsonb
    ) || coalesce((
      select jsonb_build_object(
        'originGeo', record_row.origin_geo,
        'foundGeo', record_row.found_geo
      )
      from public.zagulyaky_records record_row
      where record_row.id::text = (source.payload ->> 'id')
    ), '{}'::jsonb)
  end
  from source
$function$;

revoke all on function security_private.normalize_zagulyaky_geo_point_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_geo_point_is_canonical_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function security_private.normalize_zagulyaky_record_map_points_v1()
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_living_person_content_fingerprint_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_public_zagulyaka_v1(text)
  from public;
grant execute on function public.get_public_zagulyaka_v1(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;

