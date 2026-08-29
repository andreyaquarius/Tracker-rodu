begin;

-- Versioned write contracts for the historical-place catalogue.
--
-- These RPCs are intentionally additive.  They never infer a Place from text,
-- never rewrite legacy person/document fields, and never let an authenticated
-- client mutate the shared catalogue directly.  Public SECURITY INVOKER
-- facades expose narrowly bounded JSON contracts; trusted private bodies do
-- the explicit authorization and scope checks before touching audited tables.

set local lock_timeout = '5s';
set local statement_timeout = '10min';

create or replace function security_private.assert_historical_place_payload_v1(
  p_payload jsonb,
  p_allowed_keys text[],
  p_context text,
  p_max_bytes integer default 100000
)
returns void
language plpgsql
immutable
security definer
set search_path = pg_catalog, pg_temp
as $function$
declare
  unexpected_key text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '%_PAYLOAD_OBJECT_REQUIRED', p_context using errcode = '22023';
  end if;
  if octet_length(p_payload::text) > least(greatest(coalesce(p_max_bytes, 100000), 1), 200000) then
    raise exception '%_PAYLOAD_TOO_LARGE', p_context using errcode = '22023';
  end if;

  select payload_key
  into unexpected_key
  from jsonb_object_keys(p_payload) payload_key
  where not (payload_key = any(coalesce(p_allowed_keys, array[]::text[])))
  order by payload_key
  limit 1;

  if unexpected_key is not null then
    raise exception '%_FIELD_NOT_ALLOWED: %', p_context, unexpected_key using errcode = '22023';
  end if;
end;
$function$;

create or replace function security_private.require_historical_project_edit_v1(
  p_project_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return;
  end if;
  if auth.uid() is null or p_project_id is null
     or not public.can_edit_project(p_project_id) then
    raise exception 'PROJECT_EDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
end;
$function$;

create or replace function security_private.require_historical_place_edit_v1(
  p_place_id uuid
)
returns public.places
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $function$
declare
  place_row public.places;
begin
  select * into place_row
  from public.places candidate
  where candidate.id = p_place_id;

  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if coalesce(auth.role(), '') = 'service_role' then
    return place_row;
  end if;
  if place_row.project_id is null then
    raise exception 'GLOBAL_PLACE_CHANGE_REQUEST_REQUIRED' using errcode = '42501';
  end if;
  perform security_private.require_historical_project_edit_v1(place_row.project_id);
  return place_row;
end;
$function$;

-- Exact evidence is append-only once supplied.  Empty evidence fields on the
-- additive relation/archive tables may be filled once, but a non-empty source
-- transcription must never be corrected in place: callers add a new evidence
-- row instead.  This trigger also protects service/maintenance writes and the
-- direct table API; merge operations remain valid because they only move the
-- owning place identifiers and preserve original_text byte-for-byte.
create or replace function security_private.preserve_historical_original_text_v1()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $function$
begin
  if coalesce(old.original_text, '') <> ''
     and new.original_text is distinct from old.original_text then
    raise exception 'HISTORICAL_ORIGINAL_TEXT_IMMUTABLE' using errcode = '22023';
  end if;
  return new;
end;
$function$;

create or replace function security_private.patch_project_place_v1(
  p_place_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  updated_row public.places;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array[
      'canonicalName','modernName','description','latitude','longitude',
      'status','verificationStatus','metadata'
    ],
    'PLACE_PATCH'
  );
  if p_patch = '{}'::jsonb then
    raise exception 'PLACE_PATCH_EMPTY' using errcode = '22023';
  end if;
  if coalesce(p_expected_lock_version, 0) < 1 then
    raise exception 'PLACE_EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
  end if;

  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status = 'merged' then
    raise exception 'MERGED_PLACE_EDIT_FORBIDDEN' using errcode = '22023';
  end if;
  if place_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_VERSION_CONFLICT' using errcode = '40001';
  end if;

  update public.places candidate
  set
    canonical_name = case when p_patch ? 'canonicalName'
      then coalesce(p_patch ->> 'canonicalName', '') else candidate.canonical_name end,
    modern_name = case when p_patch ? 'modernName'
      then coalesce(p_patch ->> 'modernName', '') else candidate.modern_name end,
    description = case when p_patch ? 'description'
      then coalesce(p_patch ->> 'description', '') else candidate.description end,
    latitude = case when p_patch ? 'latitude'
      then nullif(p_patch ->> 'latitude', '')::numeric else candidate.latitude end,
    longitude = case when p_patch ? 'longitude'
      then nullif(p_patch ->> 'longitude', '')::numeric else candidate.longitude end,
    status = case when p_patch ? 'status'
      then coalesce(p_patch ->> 'status', '') else candidate.status end,
    verification_status = case when p_patch ? 'verificationStatus'
      then coalesce(p_patch ->> 'verificationStatus', '') else candidate.verification_status end,
    metadata = case when p_patch ? 'metadata'
      then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_place_id
    and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;

  if not found then
    raise exception 'PLACE_VERSION_CONFLICT' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'id', updated_row.id,
    'projectId', updated_row.project_id,
    'canonicalName', updated_row.canonical_name,
    'modernName', updated_row.modern_name,
    'description', updated_row.description,
    'latitude', updated_row.latitude,
    'longitude', updated_row.longitude,
    'status', updated_row.status,
    'verificationStatus', updated_row.verification_status,
    'lockVersion', updated_row.lock_version,
    'updatedAt', updated_row.updated_at
  );
end;
$function$;

create or replace function security_private.add_place_name_v1(
  p_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_names;
  exact_original_text text;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array[
      'name','originalText','languageCode','nameType','validFrom','validTo',
      'validFromText','validToText','validFromPrecision','validToPrecision',
      'sourceDocumentId','sourceFindingId','citationId','sourceReference',
      'confidence','isPrimary','note','metadata'
    ],
    'PLACE_NAME'
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);

  exact_original_text := p_payload ->> 'originalText';
  if exact_original_text is null or exact_original_text = '' then
    raise exception 'PLACE_NAME_ORIGINAL_TEXT_REQUIRED' using errcode = '22023';
  end if;

  insert into public.place_names (
    place_id, name, original_text, language_code, name_type,
    valid_from, valid_to, valid_from_text, valid_to_text,
    valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, is_primary, note, metadata, created_by
  ) values (
    p_place_id,
    coalesce(p_payload ->> 'name', ''),
    exact_original_text,
    nullif(p_payload ->> 'languageCode', ''),
    coalesce(nullif(p_payload ->> 'nameType', ''), 'variant'),
    nullif(p_payload ->> 'validFrom', '')::date,
    nullif(p_payload ->> 'validTo', '')::date,
    nullif(p_payload ->> 'validFromText', ''),
    nullif(p_payload ->> 'validToText', ''),
    nullif(p_payload ->> 'validFromPrecision', ''),
    nullif(p_payload ->> 'validToPrecision', ''),
    nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
    nullif(p_payload ->> 'sourceFindingId', '')::uuid,
    nullif(p_payload ->> 'citationId', '')::uuid,
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce((p_payload ->> 'confidence')::smallint, 50),
    coalesce((p_payload ->> 'isPrimary')::boolean, false),
    coalesce(p_payload ->> 'note', ''),
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  )
  returning * into created_row;

  return jsonb_build_object(
    'id', created_row.id,
    'placeId', created_row.place_id,
    'name', created_row.name,
    'originalText', created_row.original_text,
    'languageCode', created_row.language_code,
    'nameType', created_row.name_type,
    'validFrom', created_row.valid_from,
    'validTo', created_row.valid_to,
    'lockVersion', created_row.lock_version
  );
end;
$function$;

create or replace function security_private.update_place_name_v1(
  p_name_id uuid,
  p_expected_lock_version integer,
  p_patch jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  name_row public.place_names;
  place_row public.places;
  updated_row public.place_names;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_patch,
    array[
      'name','languageCode','nameType','validFrom','validTo',
      'validFromText','validToText','validFromPrecision','validToPrecision',
      'sourceDocumentId','sourceFindingId','citationId','sourceReference',
      'confidence','isPrimary','note','metadata'
    ],
    'PLACE_NAME_PATCH'
  );
  if p_patch = '{}'::jsonb then
    raise exception 'PLACE_NAME_PATCH_EMPTY' using errcode = '22023';
  end if;
  if coalesce(p_expected_lock_version, 0) < 1 then
    raise exception 'PLACE_NAME_EXPECTED_LOCK_VERSION_REQUIRED' using errcode = '22023';
  end if;

  select * into name_row
  from public.place_names candidate
  where candidate.id = p_name_id;
  if not found then
    raise exception 'PLACE_NAME_NOT_FOUND' using errcode = 'P0002';
  end if;
  place_row := security_private.require_historical_place_edit_v1(name_row.place_id);
  if place_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(array[name_row.place_id]::uuid[], true);

  select * into name_row
  from public.place_names candidate
  where candidate.id = p_name_id
  for update;
  if not found then
    raise exception 'PLACE_NAME_NOT_FOUND' using errcode = 'P0002';
  end if;
  place_row := security_private.require_historical_place_edit_v1(name_row.place_id);
  if place_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  if name_row.lock_version <> p_expected_lock_version then
    raise exception 'PLACE_NAME_VERSION_CONFLICT' using errcode = '40001';
  end if;

  update public.place_names candidate
  set
    name = case when p_patch ? 'name'
      then coalesce(p_patch ->> 'name', '') else candidate.name end,
    language_code = case when p_patch ? 'languageCode'
      then nullif(p_patch ->> 'languageCode', '') else candidate.language_code end,
    name_type = case when p_patch ? 'nameType'
      then coalesce(p_patch ->> 'nameType', '') else candidate.name_type end,
    valid_from = case when p_patch ? 'validFrom'
      then nullif(p_patch ->> 'validFrom', '')::date else candidate.valid_from end,
    valid_to = case when p_patch ? 'validTo'
      then nullif(p_patch ->> 'validTo', '')::date else candidate.valid_to end,
    valid_from_text = case when p_patch ? 'validFromText'
      then nullif(p_patch ->> 'validFromText', '') else candidate.valid_from_text end,
    valid_to_text = case when p_patch ? 'validToText'
      then nullif(p_patch ->> 'validToText', '') else candidate.valid_to_text end,
    valid_from_precision = case when p_patch ? 'validFromPrecision'
      then nullif(p_patch ->> 'validFromPrecision', '') else candidate.valid_from_precision end,
    valid_to_precision = case when p_patch ? 'validToPrecision'
      then nullif(p_patch ->> 'validToPrecision', '') else candidate.valid_to_precision end,
    source_document_id = case when p_patch ? 'sourceDocumentId'
      then nullif(p_patch ->> 'sourceDocumentId', '')::uuid else candidate.source_document_id end,
    source_finding_id = case when p_patch ? 'sourceFindingId'
      then nullif(p_patch ->> 'sourceFindingId', '')::uuid else candidate.source_finding_id end,
    citation_id = case when p_patch ? 'citationId'
      then nullif(p_patch ->> 'citationId', '')::uuid else candidate.citation_id end,
    source_reference = case when p_patch ? 'sourceReference'
      then nullif(p_patch ->> 'sourceReference', '') else candidate.source_reference end,
    confidence = case when p_patch ? 'confidence'
      then (p_patch ->> 'confidence')::smallint else candidate.confidence end,
    is_primary = case when p_patch ? 'isPrimary'
      then coalesce((p_patch ->> 'isPrimary')::boolean, false) else candidate.is_primary end,
    note = case when p_patch ? 'note'
      then coalesce(p_patch ->> 'note', '') else candidate.note end,
    metadata = case when p_patch ? 'metadata'
      then p_patch -> 'metadata' else candidate.metadata end
  where candidate.id = p_name_id
    and candidate.lock_version = p_expected_lock_version
  returning * into updated_row;

  if not found then
    raise exception 'PLACE_NAME_VERSION_CONFLICT' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'id', updated_row.id,
    'placeId', updated_row.place_id,
    'name', updated_row.name,
    'originalText', updated_row.original_text,
    'languageCode', updated_row.language_code,
    'nameType', updated_row.name_type,
    'validFrom', updated_row.valid_from,
    'validTo', updated_row.valid_to,
    'lockVersion', updated_row.lock_version
  );
end;
$function$;

create or replace function security_private.add_place_hierarchy_relation_v1(
  p_child_place_id uuid,
  p_parent_place_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  child_row public.places;
  created_row public.place_hierarchy_relations;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array[
      'relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId',
      'sourceFindingId','citationId','sourceReference','confidence','note','metadata'
    ],
    'PLACE_HIERARCHY'
  );
  child_row := security_private.require_historical_place_edit_v1(p_child_place_id);
  if child_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(
    array[p_child_place_id, p_parent_place_id]::uuid[],
    true
  );

  insert into public.place_hierarchy_relations (
    child_place_id, parent_place_id, relation_type,
    valid_from, valid_to, valid_from_text, valid_to_text,
    valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, note, metadata, created_by
  ) values (
    p_child_place_id,
    p_parent_place_id,
    coalesce(nullif(p_payload ->> 'relationType', ''), 'administrative_parent'),
    nullif(p_payload ->> 'validFrom', '')::date,
    nullif(p_payload ->> 'validTo', '')::date,
    nullif(p_payload ->> 'validFromText', ''),
    nullif(p_payload ->> 'validToText', ''),
    nullif(p_payload ->> 'validFromPrecision', ''),
    nullif(p_payload ->> 'validToPrecision', ''),
    nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
    nullif(p_payload ->> 'sourceFindingId', '')::uuid,
    nullif(p_payload ->> 'citationId', '')::uuid,
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce((p_payload ->> 'confidence')::smallint, 50),
    coalesce(p_payload ->> 'note', ''),
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  )
  returning * into created_row;

  return jsonb_build_object(
    'id', created_row.id,
    'childPlaceId', created_row.child_place_id,
    'parentPlaceId', created_row.parent_place_id,
    'relationType', created_row.relation_type,
    'validFrom', created_row.valid_from,
    'validTo', created_row.valid_to,
    'lockVersion', created_row.lock_version
  );
end;
$function$;

create or replace function security_private.add_place_parish_relation_v1(
  p_place_id uuid,
  p_parish_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_parish_relations;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array[
      'religion','relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','originalText','note','metadata'
    ],
    'PLACE_PARISH'
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(
    array[p_place_id, p_parish_place_id]::uuid[],
    true
  );

  insert into public.place_parish_relations (
    place_id, parish_place_id, religion, relation_type,
    valid_from, valid_to, valid_from_text, valid_to_text,
    valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, original_text, note, metadata, created_by
  ) values (
    p_place_id,
    p_parish_place_id,
    coalesce(p_payload ->> 'religion', ''),
    coalesce(nullif(p_payload ->> 'relationType', ''), 'belongs_to_parish'),
    nullif(p_payload ->> 'validFrom', '')::date,
    nullif(p_payload ->> 'validTo', '')::date,
    nullif(p_payload ->> 'validFromText', ''),
    nullif(p_payload ->> 'validToText', ''),
    nullif(p_payload ->> 'validFromPrecision', ''),
    nullif(p_payload ->> 'validToPrecision', ''),
    nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
    nullif(p_payload ->> 'sourceFindingId', '')::uuid,
    nullif(p_payload ->> 'citationId', '')::uuid,
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce((p_payload ->> 'confidence')::smallint, 50),
    coalesce(p_payload ->> 'originalText', ''),
    coalesce(p_payload ->> 'note', ''),
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  )
  returning * into created_row;

  return jsonb_build_object(
    'id', created_row.id,
    'placeId', created_row.place_id,
    'parishPlaceId', created_row.parish_place_id,
    'religion', created_row.religion,
    'relationType', created_row.relation_type,
    'validFrom', created_row.valid_from,
    'validTo', created_row.valid_to,
    'originalText', created_row.original_text,
    'lockVersion', created_row.lock_version
  );
end;
$function$;

create or replace function security_private.create_archive_resource_v1(
  p_project_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  created_row public.archive_resources;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array[
      'parentResourceId','resourceType','title','archiveName','fund','inventory',
      'fileReference','catalogueReference','url','description','sourceReference',
      'originalText','status','isPublic','metadata'
    ],
    'ARCHIVE_RESOURCE'
  );
  if p_project_id is null and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'GLOBAL_ARCHIVE_CHANGE_REQUEST_REQUIRED' using errcode = '42501';
  end if;
  if p_project_id is not null then
    perform security_private.require_historical_project_edit_v1(p_project_id);
  end if;

  insert into public.archive_resources (
    project_id, parent_resource_id, resource_type, title,
    archive_name, fund, inventory, file_reference, catalogue_reference,
    url, description, source_reference, original_text, status, is_public,
    metadata, created_by
  ) values (
    p_project_id,
    nullif(p_payload ->> 'parentResourceId', '')::uuid,
    coalesce(p_payload ->> 'resourceType', ''),
    coalesce(p_payload ->> 'title', ''),
    coalesce(p_payload ->> 'archiveName', ''),
    coalesce(p_payload ->> 'fund', ''),
    coalesce(p_payload ->> 'inventory', ''),
    coalesce(p_payload ->> 'fileReference', ''),
    coalesce(p_payload ->> 'catalogueReference', ''),
    nullif(p_payload ->> 'url', ''),
    coalesce(p_payload ->> 'description', ''),
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce(p_payload ->> 'originalText', ''),
    coalesce(nullif(p_payload ->> 'status', ''), 'active'),
    case when p_project_id is null
      then coalesce((p_payload ->> 'isPublic')::boolean, false)
      else false end,
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  )
  returning * into created_row;

  return jsonb_build_object(
    'id', created_row.id,
    'projectId', created_row.project_id,
    'parentResourceId', created_row.parent_resource_id,
    'resourceType', created_row.resource_type,
    'title', created_row.title,
    'archiveName', created_row.archive_name,
    'fund', created_row.fund,
    'inventory', created_row.inventory,
    'fileReference', created_row.file_reference,
    'originalText', created_row.original_text,
    'lockVersion', created_row.lock_version
  );
end;
$function$;

create or replace function security_private.add_place_archive_relation_v1(
  p_place_id uuid,
  p_archive_resource_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  created_row public.place_archive_relations;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array[
      'relationType','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceDocumentId','sourceFindingId',
      'citationId','sourceReference','confidence','originalText','note','metadata'
    ],
    'PLACE_ARCHIVE'
  );
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);

  insert into public.place_archive_relations (
    place_id, archive_resource_id, relation_type,
    valid_from, valid_to, valid_from_text, valid_to_text,
    valid_from_precision, valid_to_precision,
    source_document_id, source_finding_id, citation_id, source_reference,
    confidence, original_text, note, metadata, created_by
  ) values (
    p_place_id,
    p_archive_resource_id,
    coalesce(nullif(p_payload ->> 'relationType', ''), 'has_materials'),
    nullif(p_payload ->> 'validFrom', '')::date,
    nullif(p_payload ->> 'validTo', '')::date,
    nullif(p_payload ->> 'validFromText', ''),
    nullif(p_payload ->> 'validToText', ''),
    nullif(p_payload ->> 'validFromPrecision', ''),
    nullif(p_payload ->> 'validToPrecision', ''),
    nullif(p_payload ->> 'sourceDocumentId', '')::uuid,
    nullif(p_payload ->> 'sourceFindingId', '')::uuid,
    nullif(p_payload ->> 'citationId', '')::uuid,
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce((p_payload ->> 'confidence')::smallint, 50),
    coalesce(p_payload ->> 'originalText', ''),
    coalesce(p_payload ->> 'note', ''),
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  )
  returning * into created_row;

  return jsonb_build_object(
    'id', created_row.id,
    'placeId', created_row.place_id,
    'archiveResourceId', created_row.archive_resource_id,
    'relationType', created_row.relation_type,
    'validFrom', created_row.valid_from,
    'validTo', created_row.valid_to,
    'originalText', created_row.original_text,
    'lockVersion', created_row.lock_version
  );
end;
$function$;

-- Creating a private archive resource and linking it to a Place is one user
-- action.  Keep both writes in the same RPC transaction so a failed relation
-- cannot leave an unreachable archive resource behind.
create or replace function security_private.create_and_link_place_archive_resource_v1(
  p_place_id uuid,
  p_resource_payload jsonb,
  p_link_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  resource_result jsonb;
  relation_result jsonb;
  archive_resource_id uuid;
begin
  place_row := security_private.require_historical_place_edit_v1(p_place_id);
  if place_row.status in ('merged', 'archived') then
    raise exception 'PLACE_NOT_EDITABLE' using errcode = '22023';
  end if;

  perform security_private.lock_historical_place_ids_v1(
    array[p_place_id]::uuid[],
    true
  );

  resource_result := security_private.create_archive_resource_v1(
    place_row.project_id,
    p_resource_payload
  );
  archive_resource_id := nullif(resource_result ->> 'id', '')::uuid;
  if archive_resource_id is null then
    raise exception 'ARCHIVE_RESOURCE_CREATE_INVALID_RESPONSE' using errcode = 'P0002';
  end if;

  relation_result := security_private.add_place_archive_relation_v1(
    p_place_id,
    archive_resource_id,
    coalesce(p_link_payload, '{}'::jsonb)
  );

  return jsonb_build_object(
    'resource', resource_result,
    'relation', relation_result
  );
end;
$function$;

create or replace function security_private.add_document_place_link_v1(
  p_document_id uuid,
  p_place_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  document_project_id uuid;
  place_row public.places;
  exact_original_text text;
  created_row public.document_place_links;
begin
  perform security_private.assert_historical_place_payload_v1(
    p_payload,
    array[
      'relationType','originalText','validFrom','validTo','validFromText','validToText',
      'validFromPrecision','validToPrecision','sourceReference','confidence','note','metadata'
    ],
    'DOCUMENT_PLACE'
  );

  select document_row.project_id into document_project_id
  from public.documents document_row
  where document_row.id = p_document_id;
  if not found then
    raise exception 'DOCUMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  perform security_private.require_historical_project_edit_v1(document_project_id);

  select * into place_row
  from public.places candidate
  where candidate.id = p_place_id;
  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if place_row.project_id is not null
       and place_row.project_id <> document_project_id then
      raise exception 'DOCUMENT_PLACE_PROJECT_SCOPE_MISMATCH' using errcode = '22023';
    end if;
    if place_row.project_id is null
       and not (place_row.status = 'active' and place_row.verification_status = 'verified') then
      raise exception 'DOCUMENT_PLACE_GLOBAL_ACCESS_REQUIRED' using errcode = '42501';
    end if;
  end if;

  exact_original_text := p_payload ->> 'originalText';
  if exact_original_text is null or exact_original_text = '' then
    raise exception 'DOCUMENT_PLACE_ORIGINAL_TEXT_REQUIRED' using errcode = '22023';
  end if;
  perform security_private.lock_historical_place_ids_v1(array[p_place_id]::uuid[], true);

  insert into public.document_place_links (
    document_id, place_id, relation_type, original_text,
    valid_from, valid_to, valid_from_text, valid_to_text,
    valid_from_precision, valid_to_precision, source_reference,
    confidence, note, metadata, created_by
  ) values (
    p_document_id,
    p_place_id,
    coalesce(nullif(p_payload ->> 'relationType', ''), 'mentions'),
    exact_original_text,
    nullif(p_payload ->> 'validFrom', '')::date,
    nullif(p_payload ->> 'validTo', '')::date,
    nullif(p_payload ->> 'validFromText', ''),
    nullif(p_payload ->> 'validToText', ''),
    nullif(p_payload ->> 'validFromPrecision', ''),
    nullif(p_payload ->> 'validToPrecision', ''),
    nullif(p_payload ->> 'sourceReference', ''),
    coalesce((p_payload ->> 'confidence')::smallint, 50),
    coalesce(p_payload ->> 'note', ''),
    coalesce(p_payload -> 'metadata', '{}'::jsonb),
    auth.uid()
  )
  returning * into created_row;

  return jsonb_build_object(
    'id', created_row.id,
    'documentId', created_row.document_id,
    'placeId', created_row.place_id,
    'relationType', created_row.relation_type,
    'originalText', created_row.original_text,
    'validFrom', created_row.valid_from,
    'validTo', created_row.valid_to,
    'lockVersion', created_row.lock_version
  );
end;
$function$;

create or replace function security_private.list_place_audit_history_v1(
  p_place_id uuid,
  p_limit integer default 50,
  p_before_id bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  place_row public.places;
  bounded_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  result_rows jsonb;
begin
  select * into place_row
  from public.places candidate
  where candidate.id = p_place_id;
  if not found then
    raise exception 'PLACE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_before_id is not null and p_before_id < 1 then
    raise exception 'PLACE_AUDIT_CURSOR_INVALID' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if auth.uid() is null or place_row.project_id is null
       or not public.is_project_member(place_row.project_id) then
      raise exception 'PLACE_AUDIT_ACCESS_REQUIRED' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(history_row.payload order by history_row.id desc), '[]'::jsonb)
  into result_rows
  from (
    select audit_row.id,
      jsonb_build_object(
        'id', audit_row.id,
        'entityTable', audit_row.entity_table,
        'entityId', audit_row.entity_id,
        'placeId', audit_row.place_id,
        'projectId', audit_row.project_id,
        'actorId', audit_row.actor_id,
        'action', audit_row.action,
        'before', audit_row.before_data,
        'after', audit_row.after_data,
        'createdAt', audit_row.created_at
      ) as payload
    from security_private.historical_place_audit_log audit_row
    where audit_row.place_id = p_place_id
      and audit_row.project_id = place_row.project_id
      and (p_before_id is null or audit_row.id < p_before_id)
    order by audit_row.id desc
    limit bounded_limit
  ) history_row;

  return result_rows;
end;
$function$;

-- Trigger order is intentional: scope validation runs at 10, evidence
-- immutability at 15, and lock-version/timestamp maintenance at 20.
do $original_text_triggers$
declare
  table_name text;
begin
  foreach table_name in array array[
    'place_names',
    'place_boundaries',
    'place_relations',
    'place_parish_relations',
    'archive_resources',
    'place_archive_relations',
    'document_place_links'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      table_name || '_15_original_text_immutable',
      table_name
    );
    execute format(
      'create trigger %I before update on public.%I
       for each row execute function security_private.preserve_historical_original_text_v1()',
      table_name || '_15_original_text_immutable',
      table_name
    );
  end loop;
end;
$original_text_triggers$;

-- SECURITY INVOKER public facades keep Security Advisor output clean while the
-- narrowly scoped private bodies retain explicit, testable authorization.
create or replace function public.patch_project_place_v1(
  p_place_id uuid, p_expected_lock_version integer, p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.patch_project_place_v1($1, $2, $3); $wrapper$;

create or replace function public.add_place_name_v1(p_place_id uuid, p_payload jsonb)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_name_v1($1, $2); $wrapper$;

create or replace function public.update_place_name_v1(
  p_name_id uuid, p_expected_lock_version integer, p_patch jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.update_place_name_v1($1, $2, $3); $wrapper$;

create or replace function public.add_place_hierarchy_relation_v1(
  p_child_place_id uuid, p_parent_place_id uuid, p_payload jsonb default '{}'::jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_hierarchy_relation_v1($1, $2, $3); $wrapper$;

create or replace function public.add_place_parish_relation_v1(
  p_place_id uuid, p_parish_place_id uuid, p_payload jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_parish_relation_v1($1, $2, $3); $wrapper$;

create or replace function public.create_archive_resource_v1(
  p_project_id uuid, p_payload jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.create_archive_resource_v1($1, $2); $wrapper$;

create or replace function public.add_place_archive_relation_v1(
  p_place_id uuid, p_archive_resource_id uuid, p_payload jsonb default '{}'::jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_place_archive_relation_v1($1, $2, $3); $wrapper$;

create or replace function public.create_and_link_place_archive_resource_v1(
  p_place_id uuid, p_resource_payload jsonb, p_link_payload jsonb default '{}'::jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$
  select security_private.create_and_link_place_archive_resource_v1($1, $2, $3);
$wrapper$;

create or replace function public.add_document_place_link_v1(
  p_document_id uuid, p_place_id uuid, p_payload jsonb
)
returns jsonb language sql volatile security invoker set search_path = pg_catalog
as $wrapper$ select security_private.add_document_place_link_v1($1, $2, $3); $wrapper$;

create or replace function public.list_place_audit_history_v1(
  p_place_id uuid, p_limit integer default 50, p_before_id bigint default null
)
returns jsonb language sql stable security invoker set search_path = pg_catalog
as $wrapper$ select security_private.list_place_audit_history_v1($1, $2, $3); $wrapper$;

do $grants$
declare
  function_signature text;
begin
  foreach function_signature in array array[
    'security_private.patch_project_place_v1(uuid,integer,jsonb)',
    'security_private.add_place_name_v1(uuid,jsonb)',
    'security_private.update_place_name_v1(uuid,integer,jsonb)',
    'security_private.add_place_hierarchy_relation_v1(uuid,uuid,jsonb)',
    'security_private.add_place_parish_relation_v1(uuid,uuid,jsonb)',
    'security_private.create_archive_resource_v1(uuid,jsonb)',
    'security_private.add_place_archive_relation_v1(uuid,uuid,jsonb)',
    'security_private.create_and_link_place_archive_resource_v1(uuid,jsonb,jsonb)',
    'security_private.add_document_place_link_v1(uuid,uuid,jsonb)',
    'security_private.list_place_audit_history_v1(uuid,integer,bigint)',
    'public.patch_project_place_v1(uuid,integer,jsonb)',
    'public.add_place_name_v1(uuid,jsonb)',
    'public.update_place_name_v1(uuid,integer,jsonb)',
    'public.add_place_hierarchy_relation_v1(uuid,uuid,jsonb)',
    'public.add_place_parish_relation_v1(uuid,uuid,jsonb)',
    'public.create_archive_resource_v1(uuid,jsonb)',
    'public.add_place_archive_relation_v1(uuid,uuid,jsonb)',
    'public.create_and_link_place_archive_resource_v1(uuid,jsonb,jsonb)',
    'public.add_document_place_link_v1(uuid,uuid,jsonb)',
    'public.list_place_audit_history_v1(uuid,integer,bigint)'
  ] loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      function_signature
    );
    execute format(
      'grant execute on function %s to authenticated, service_role',
      function_signature
    );
  end loop;
end;
$grants$;

revoke all on function security_private.assert_historical_place_payload_v1(jsonb,text[],text,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.require_historical_project_edit_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.require_historical_place_edit_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.preserve_historical_original_text_v1()
  from public, anon, authenticated, service_role;

-- The versioned RPCs are now the only authenticated update path for Place and
-- PlaceName.  Leaving the old table UPDATE grants in place would let a client
-- bypass expected_lock_version and rewrite normalized name data directly.
-- SELECT and additive INSERT/DELETE permissions remain governed by the
-- existing RLS contracts; service_role retains its maintenance privileges.
revoke update on table public.places from authenticated;
revoke update on table public.place_names from authenticated;

comment on function public.patch_project_place_v1(uuid,integer,jsonb) is
  'Optimistically patches a project-private Place. Authenticated global edits require an explicit change request.';
comment on function public.update_place_name_v1(uuid,integer,jsonb) is
  'Updates normalized historical-name metadata without accepting or changing exact original_text evidence.';
comment on function public.create_and_link_place_archive_resource_v1(uuid,jsonb,jsonb) is
  'Atomically creates an archive resource in the Place project and links it to that Place.';
comment on function public.list_place_audit_history_v1(uuid,integer,bigint) is
  'Bounded newest-first audit history for a Place owned by one of the caller projects.';

commit;
