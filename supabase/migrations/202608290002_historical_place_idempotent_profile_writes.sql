begin;

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
  existing_row public.place_type_assignments;
  make_primary boolean;
  type_code text;
  carries_evidence boolean;
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
  type_code := btrim(coalesce(p_payload ->> 'placeTypeCode', ''));
  carries_evidence := p_payload ?| array[
    'validFrom','validTo','validFromText','validToText','validFromPrecision',
    'validToPrecision','sourceDocumentId','sourceFindingId','citationId',
    'sourceReference','confidence','note','metadata'
  ];

  -- A full-profile save always sends its currently selected primary type.
  -- Returning that row makes the operation safe to retry without inventing a
  -- second undated type assignment. Evidence-bearing additions remain distinct.
  if make_primary and not carries_evidence then
    select * into existing_row
    from public.place_type_assignments assignment_row
    where assignment_row.place_id = p_place_id
      and assignment_row.is_primary
      and assignment_row.place_type_code = type_code
    order by assignment_row.updated_at desc, assignment_row.id
    limit 1;
    if found then
      return security_private.place_type_assignment_json_v1(existing_row);
    end if;
  end if;

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
    p_place_id, type_code,
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
  existing_row public.place_external_identifiers;
  provider_value text;
  identifier_value text;
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
  identifier_value := btrim(coalesce(p_payload ->> 'externalIdentifier',''));
  make_primary := coalesce((p_payload ->> 'isPrimary')::boolean, false);

  select * into existing_row
  from public.place_external_identifiers identifier_row
  where identifier_row.place_id = p_place_id
    and lower(identifier_row.provider) = lower(provider_value)
    and identifier_row.external_identifier = identifier_value
  order by identifier_row.is_primary desc, identifier_row.id
  limit 1;

  if found then
    if make_primary and not existing_row.is_primary then
      update public.place_external_identifiers set is_primary = false
      where place_id = p_place_id
        and lower(provider) = lower(provider_value)
        and id <> existing_row.id
        and is_primary;
      update public.place_external_identifiers identifier_row
      set is_primary = true
      where identifier_row.id = existing_row.id
      returning * into existing_row;
    end if;
    return security_private.place_external_identifier_json_v1(existing_row);
  end if;

  if make_primary then
    update public.place_external_identifiers set is_primary = false
    where place_id = p_place_id and lower(provider) = lower(provider_value) and is_primary;
  end if;
  insert into public.place_external_identifiers (
    place_id, provider, external_identifier, source_url, is_primary, metadata, created_by
  ) values (
    p_place_id, provider_value, identifier_value,
    nullif(p_payload ->> 'sourceUrl',''), make_primary,
    coalesce(p_payload -> 'metadata','{}'::jsonb), auth.uid()
  ) returning * into created_row;
  return security_private.place_external_identifier_json_v1(created_row);
end;
$function$;

comment on function public.add_place_type_assignment_v1(uuid,jsonb) is
  'Adds an evidence-bearing type assignment; retrying the same undated primary type is idempotent.';
comment on function public.add_place_external_identifier_v1(uuid,jsonb) is
  'Adds an external identifier; retrying the same Place/provider/value is idempotent.';

notify pgrst, 'reload schema';

commit;
