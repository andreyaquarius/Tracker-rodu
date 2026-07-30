begin;

-- The provider can move a PDF to a revision-specific canonical URL while its
-- fingerprint changes. Keep all version-coupled resolved fields pending with
-- that fingerprint, then accept the complete version in one update.
alter table public.document_sources
  add column if not exists pending_resolved_metadata jsonb;

create or replace function private.external_pdf_url_host(target_url text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.lower(
    (pg_catalog.regexp_match(
      target_url,
      '^https://(\[[0-9a-fA-F:.]+\]|[^/:?#]+)(:[0-9]{1,5})?([/?#]|$)',
      'i'
    ))[1]
  );
$$;

create or replace function private.external_pdf_resolved_metadata_is_persistence_safe(
  payload jsonb
)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  canonical_value text;
  provider_host_value text;
  access_mode_value text;
  numeric_value numeric;
  field_count integer;
begin
  if pg_catalog.jsonb_typeof(payload) <> 'object'
    or pg_catalog.pg_column_size(payload) > 12288
  then
    return false;
  end if;

  select pg_catalog.count(*)::integer
  into field_count
  from pg_catalog.jsonb_object_keys(payload);

  if not (payload ?& array[
      'canonical_url',
      'provider_host',
      'file_size_bytes',
      'page_count',
      'access_mode'
    ]::text[])
    or field_count <> 5
  then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(payload -> 'canonical_url') <> 'string'
    or pg_catalog.jsonb_typeof(payload -> 'provider_host') <> 'string'
    or pg_catalog.jsonb_typeof(payload -> 'access_mode') <> 'string'
  then
    return false;
  end if;

  canonical_value := payload ->> 'canonical_url';
  provider_host_value := payload ->> 'provider_host';
  access_mode_value := payload ->> 'access_mode';

  if not private.external_pdf_url_is_persistence_safe(canonical_value)
    or provider_host_value is distinct from private.external_pdf_url_host(canonical_value)
    or pg_catalog.length(provider_host_value) < 1
    or pg_catalog.length(provider_host_value) > 253
    or provider_host_value <> pg_catalog.lower(pg_catalog.btrim(provider_host_value))
    or provider_host_value ~ '[[:space:]/@?#[:cntrl:]]'
    or access_mode_value not in ('direct_cors', 'secure_proxy', 'google_drive_api')
  then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(payload -> 'file_size_bytes') not in ('number', 'null')
    or pg_catalog.jsonb_typeof(payload -> 'page_count') not in ('number', 'null')
  then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(payload -> 'file_size_bytes') = 'number' then
    numeric_value := (payload ->> 'file_size_bytes')::numeric;
    if numeric_value <> pg_catalog.trunc(numeric_value)
      or numeric_value < 0
      or numeric_value > 9007199254740991
    then
      return false;
    end if;
  end if;

  if pg_catalog.jsonb_typeof(payload -> 'page_count') = 'number' then
    numeric_value := (payload ->> 'page_count')::numeric;
    if numeric_value <> pg_catalog.trunc(numeric_value)
      or numeric_value < 1
      or numeric_value > 2147483647
    then
      return false;
    end if;
  end if;

  return true;
exception
  when numeric_value_out_of_range or invalid_text_representation then
    return false;
end;
$$;

-- Migration 005 did not retain the resolved fields belonging to its pending
-- fingerprint. Never manufacture a mixed version from the confirmed URL and
-- an unconfirmed fingerprint: discard only that pending observation and make
-- it due for a fresh, complete revalidation. Confirmed source fields and every
-- existing finding fingerprint stay untouched.
update public.document_sources as source
set
  pending_fingerprint = null,
  pending_resolved_metadata = null,
  status = 'active',
  validation_error_code = null,
  last_validated_at = null
where source.pending_fingerprint is not null;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.document_sources'::regclass
      and conname = 'document_sources_pending_resolved_metadata_safe_check'
  ) then
    alter table public.document_sources
      add constraint document_sources_pending_resolved_metadata_safe_check
      check (
        pending_resolved_metadata is null
        or private.external_pdf_resolved_metadata_is_persistence_safe(
          pending_resolved_metadata
        )
      ) not valid;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.document_sources'::regclass
      and conname = 'document_sources_pending_version_complete_check'
  ) then
    alter table public.document_sources
      add constraint document_sources_pending_version_complete_check
      check (
        (pending_fingerprint is null) = (pending_resolved_metadata is null)
      ) not valid;
  end if;
end;
$$;

alter table public.document_sources
  validate constraint document_sources_pending_resolved_metadata_safe_check;
alter table public.document_sources
  validate constraint document_sources_pending_version_complete_check;

comment on column public.document_sources.pending_resolved_metadata is
  'Bounded non-secret canonical URL, provider host, size, page count and access mode awaiting version confirmation.';

revoke all on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, text, timestamptz
) from public, anon, authenticated, service_role;
drop function public.record_document_source_validation(
  uuid, uuid, text, jsonb, text, timestamptz
);

create function public.record_document_source_validation(
  target_project_id uuid,
  target_document_source_id uuid,
  target_status text,
  target_new_fingerprint jsonb,
  target_resolved_metadata jsonb,
  target_expected_status text,
  target_expected_fingerprint jsonb,
  target_expected_last_validated_at timestamptz,
  target_error_code text,
  target_validated_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  if auth.uid() is null
    or not (select public.can_edit_project(target_project_id))
  then
    raise exception using
      errcode = '42501',
      message = 'DOCUMENT_SOURCE_VALIDATION_ACCESS_DENIED';
  end if;

  if target_status not in ('active', 'changed', 'needs_auth', 'unavailable', 'invalid')
    or target_expected_status not in ('active', 'needs_auth', 'unavailable', 'invalid')
    or target_expected_fingerprint is null
    or not private.external_pdf_fingerprint_is_persistence_safe(
      target_expected_fingerprint
    )
    or target_validated_at is null
    or target_validated_at > pg_catalog.clock_timestamp() + interval '5 minutes'
  then
    raise exception using
      errcode = '22023',
      message = 'DOCUMENT_SOURCE_VALIDATION_INVALID';
  end if;

  if target_status in ('active', 'changed') then
    if target_new_fingerprint is null
      or not private.external_pdf_fingerprint_is_persistence_safe(target_new_fingerprint)
      or target_resolved_metadata is null
      or not private.external_pdf_resolved_metadata_is_persistence_safe(
        target_resolved_metadata
      )
      or target_error_code is not null
    then
      raise exception using
        errcode = '22023',
        message = 'DOCUMENT_SOURCE_VALIDATION_VERSION_INVALID';
    end if;
  elsif target_new_fingerprint is not null
    or target_resolved_metadata is not null
    or target_error_code is null
    or target_error_code not in (
      'INVALID_URL',
      'UNSUPPORTED_SCHEME',
      'SOURCE_NOT_FOUND',
      'SOURCE_NOT_PDF',
      'OAUTH_REQUIRED',
      'WIKIMEDIA_FILE_NOT_FOUND',
      'GOOGLE_DRIVE_PERMISSION_DENIED'
    )
  then
    raise exception using
      errcode = '22023',
      message = 'DOCUMENT_SOURCE_VALIDATION_ERROR_INVALID';
  end if;

  if target_status = 'changed'
    and exists (
      select 1
      from public.document_sources as source
      where source.id = target_document_source_id
        and source.project_id = target_project_id
        and source.initial_page is not null
        and pg_catalog.jsonb_typeof(target_resolved_metadata -> 'page_count') = 'number'
        and source.initial_page > (target_resolved_metadata ->> 'page_count')::integer
    )
  then
    raise exception using
      errcode = '22023',
      message = 'DOCUMENT_SOURCE_VALIDATION_PAGE_COUNT_INVALID';
  end if;

  update public.document_sources as source
  set
    status = target_status,
    pending_fingerprint = case
      when target_status = 'changed' then target_new_fingerprint
      else null
    end,
    pending_resolved_metadata = case
      when target_status = 'changed' then target_resolved_metadata
      else null
    end,
    validation_error_code = case
      when target_status = 'changed' then 'SOURCE_CHANGED'
      when target_status = 'active' then null
      else target_error_code
    end,
    last_validated_at = target_validated_at
  where source.id = target_document_source_id
    and source.project_id = target_project_id
    and source.status = target_expected_status
    and source.fingerprint = target_expected_fingerprint
    and source.last_validated_at is not distinct from target_expected_last_validated_at
    and source.pending_fingerprint is null
    and source.pending_resolved_metadata is null;

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

comment on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz, text, timestamptz
) is
  'Compare-and-set records a complete pending external PDF version without changing confirmed source or finding provenance.';

revoke all on function public.confirm_document_source_version(uuid, uuid)
  from public, anon, authenticated, service_role;
drop function public.confirm_document_source_version(uuid, uuid);

create function public.confirm_document_source_version(
  target_project_id uuid,
  target_document_source_id uuid,
  target_expected_pending_fingerprint jsonb,
  target_expected_pending_resolved_metadata jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  affected_rows integer;
begin
  if auth.uid() is null
    or not (select public.can_edit_project(target_project_id))
  then
    raise exception using
      errcode = '42501',
      message = 'DOCUMENT_SOURCE_CONFIRM_ACCESS_DENIED';
  end if;

  if target_expected_pending_fingerprint is null
    or not private.external_pdf_fingerprint_is_persistence_safe(
      target_expected_pending_fingerprint
    )
    or target_expected_pending_resolved_metadata is null
    or not private.external_pdf_resolved_metadata_is_persistence_safe(
      target_expected_pending_resolved_metadata
    )
  then
    raise exception using
      errcode = '22023',
      message = 'DOCUMENT_SOURCE_CONFIRM_VERSION_INVALID';
  end if;

  update public.document_sources as source
  set
    fingerprint = source.pending_fingerprint,
    canonical_url = source.pending_resolved_metadata ->> 'canonical_url',
    provider_host = source.pending_resolved_metadata ->> 'provider_host',
    file_size_bytes = case
      when pg_catalog.jsonb_typeof(
        source.pending_resolved_metadata -> 'file_size_bytes'
      ) = 'number'
        then (source.pending_resolved_metadata ->> 'file_size_bytes')::bigint
      else null
    end,
    page_count = case
      when pg_catalog.jsonb_typeof(
        source.pending_resolved_metadata -> 'page_count'
      ) = 'number'
        then (source.pending_resolved_metadata ->> 'page_count')::integer
      else null
    end,
    access_mode = source.pending_resolved_metadata ->> 'access_mode',
    pending_fingerprint = null,
    pending_resolved_metadata = null,
    status = 'active',
    validation_error_code = null,
    last_validated_at = pg_catalog.clock_timestamp()
  where source.id = target_document_source_id
    and source.project_id = target_project_id
    and source.status = 'changed'
    and source.pending_fingerprint = target_expected_pending_fingerprint
    and source.pending_resolved_metadata = target_expected_pending_resolved_metadata
    and private.external_pdf_resolved_metadata_is_persistence_safe(
      source.pending_resolved_metadata
    );

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

comment on function public.confirm_document_source_version(uuid, uuid, jsonb, jsonb) is
  'Atomically accepts a pending external PDF fingerprint and its resolved version fields. Existing finding snapshots remain unchanged.';

revoke all on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz, text, timestamptz
) from public, anon;
grant execute on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, jsonb, text, jsonb, timestamptz, text, timestamptz
) to authenticated, service_role;

revoke all on function public.confirm_document_source_version(uuid, uuid, jsonb, jsonb)
  from public, anon;
grant execute on function public.confirm_document_source_version(uuid, uuid, jsonb, jsonb)
  to authenticated, service_role;

revoke execute on function private.external_pdf_url_host(text)
  from public, anon, authenticated;
revoke execute on function private.external_pdf_resolved_metadata_is_persistence_safe(jsonb)
  from public, anon, authenticated;
grant execute on function private.external_pdf_url_host(text)
  to authenticated, service_role;
grant execute on function private.external_pdf_resolved_metadata_is_persistence_safe(jsonb)
  to authenticated, service_role;

commit;
