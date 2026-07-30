begin;

-- A newly observed provider version must not overwrite the fingerprint used by
-- existing findings until an editor explicitly accepts that version.  The
-- pending value contains only the same bounded, non-secret metadata accepted
-- for document_sources.fingerprint.
alter table public.document_sources
  add column if not exists pending_fingerprint jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.document_sources'::regclass
      and conname = 'document_sources_pending_fingerprint_safe_check'
  ) then
    alter table public.document_sources
      add constraint document_sources_pending_fingerprint_safe_check
      check (
        pending_fingerprint is null
        or private.external_pdf_fingerprint_is_persistence_safe(pending_fingerprint)
      );
  end if;
end;
$$;

comment on column public.document_sources.pending_fingerprint is
  'Unconfirmed non-secret provider version metadata. Existing finding provenance keeps the confirmed fingerprint.';

create or replace function public.record_document_source_validation(
  target_project_id uuid,
  target_document_source_id uuid,
  target_status text,
  target_new_fingerprint jsonb,
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
      or target_error_code is not null
    then
      raise exception using
        errcode = '22023',
        message = 'DOCUMENT_SOURCE_VALIDATION_FINGERPRINT_INVALID';
    end if;
  elsif target_new_fingerprint is not null
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

  update public.document_sources as source
  set
    status = target_status,
    -- An unchanged validation confirms availability, but deliberately keeps
    -- the prior fingerprint byte-for-byte. A changed result is accepted only
    -- by confirm_document_source_version below.
    pending_fingerprint = case
      when target_status = 'changed' then target_new_fingerprint
      else null
    end,
    validation_error_code = case
      when target_status = 'changed' then 'SOURCE_CHANGED'
      when target_status = 'active' then null
      else target_error_code
    end,
    last_validated_at = target_validated_at
  where source.id = target_document_source_id
    and source.project_id = target_project_id;

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

comment on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, text, timestamptz
) is
  'Records an editor-triggered source validation without replacing confirmed finding provenance.';

create or replace function public.confirm_document_source_version(
  target_project_id uuid,
  target_document_source_id uuid
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

  update public.document_sources as source
  set
    fingerprint = source.pending_fingerprint,
    pending_fingerprint = null,
    status = 'active',
    validation_error_code = null,
    last_validated_at = pg_catalog.clock_timestamp()
  where source.id = target_document_source_id
    and source.project_id = target_project_id
    and source.status = 'changed'
    and source.pending_fingerprint is not null;

  get diagnostics affected_rows = row_count;
  return affected_rows = 1;
end;
$$;

comment on function public.confirm_document_source_version(uuid, uuid) is
  'Atomically accepts a pending external PDF fingerprint. Existing finding snapshots remain unchanged.';

revoke all on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, text, timestamptz
) from public, anon;
grant execute on function public.record_document_source_validation(
  uuid, uuid, text, jsonb, text, timestamptz
) to authenticated, service_role;

revoke all on function public.confirm_document_source_version(uuid, uuid)
  from public, anon;
grant execute on function public.confirm_document_source_version(uuid, uuid)
  to authenticated, service_role;

commit;
