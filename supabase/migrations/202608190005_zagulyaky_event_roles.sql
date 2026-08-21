begin;

-- `role` identifies a participant's structural relation to a Zagulyaka record;
-- it is not the role that person had in the historical event.  Keep the two
-- concepts separate, so the primary UI participant remains searchable as a
-- `subject` while related participants retain their existing structural roles.
alter table public.zagulyaky_participants
  add column if not exists event_role_code text,
  add column if not exists event_role_custom text;

-- Event-role codes are stable API values.  Ukrainian wording belongs in the
-- client catalogue; in particular, there is one gender-neutral `witness`
-- code for every person.
alter table public.zagulyaky_participants
  drop constraint if exists zagulyaky_participants_event_role_code_check;
alter table public.zagulyaky_participants
  add constraint zagulyaky_participants_event_role_code_check check (
    event_role_code is null
    or event_role_code in (
      'subject',
      'newborn',
      'baptized',
      'groom',
      'bride',
      'groom_father',
      'groom_mother',
      'bride_father',
      'bride_mother',
      'deceased',
      'resident',
      'household_head',
      'household_member',
      'military_person',
      'migrant',
      'godparent',
      'godchild',
      'father',
      'mother',
      'parent',
      'child',
      'spouse',
      'witness',
      'pledger',
      'officiant',
      'registrar',
      'midwife',
      'informant',
      'owner',
      'commander',
      'official',
      'other'
    )
  );

-- Free text must not silently become a second, unbounded role system.  It is
-- reserved for an explicit `other` selection and is normalised by the writer
-- RPC before this constraint is evaluated.
alter table public.zagulyaky_participants
  drop constraint if exists zagulyaky_participants_event_role_custom_check;
alter table public.zagulyaky_participants
  add constraint zagulyaky_participants_event_role_custom_check check (
    (
      event_role_code = 'other'
      and event_role_custom is not null
      and event_role_custom = btrim(event_role_custom)
      and char_length(event_role_custom) between 2 and 160
    )
    or (
      event_role_code is distinct from 'other'
      and event_role_custom is null
    )
  );

-- Living-person consent is tied to the full content snapshot.  Event roles
-- therefore take part in the canonical fingerprint.  `null` values are kept
-- in the JSON deliberately: a historic unspecified role is distinct from a
-- later selected role, while the immediate re-stamp below keeps prior valid
-- approvals valid at the migration boundary.
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

-- Adding canonical keys changes the digest even when both values are null.
-- Rebind every approved decision in the same transaction so an already
-- cleared living-person record does not disappear merely because the schema
-- gained these fields.
update public.zagulyaky_privacy_clearances clearance
set reviewed_content_fingerprint = security_private.zagulyaky_living_person_content_fingerprint_v1(clearance.record_id),
    updated_at = now()
where clearance.review_status = 'approved';

-- Preserve the RPC signature expected by the browser.  Event-role fields are
-- independent from the existing structural participant role, which remains
-- available for a future multi-participant record.
create or replace function public.replace_my_zagulyaka_details_v1(
  p_record_id uuid,
  p_expected_lock_version integer,
  p_sources jsonb default '[]'::jsonb,
  p_participants jsonb default '[]'::jsonb,
  p_document_discoveries jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  item jsonb;
  source_id uuid;
  previous_source_ids uuid[];
  item_index integer := 0;
  structural_role text;
  event_role_code text;
  event_role_custom text;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_sources is null or p_participants is null or p_document_discoveries is null
    or jsonb_typeof(p_sources) <> 'array' or jsonb_typeof(p_participants) <> 'array'
    or jsonb_typeof(p_document_discoveries) <> 'array' then
    raise exception 'DETAILS_MUST_BE_ARRAYS' using errcode = '22023';
  end if;
  if octet_length(p_sources::text) + octet_length(p_participants::text)
      + octet_length(p_document_discoveries::text) > 4194304 then
    raise exception 'DETAILS_PAYLOAD_TOO_LARGE' using errcode = '54000';
  end if;
  if jsonb_array_length(p_sources) > 20 or jsonb_array_length(p_participants) > 100
    or jsonb_array_length(p_document_discoveries) > 100 then
    raise exception 'DETAILS_LIMIT_EXCEEDED' using errcode = '54000';
  end if;

  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_EDITABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;

  select coalesce(array_agg(rs.source_id), '{}'::uuid[]) into previous_source_ids
  from public.zagulyaky_record_sources rs where rs.record_id = existing.id;
  delete from public.zagulyaky_record_sources where record_id = existing.id;
  delete from public.zagulyaky_sources s
  where s.id = any(previous_source_ids)
    and s.created_by = current_user_id
    and not exists (select 1 from public.zagulyaky_record_sources rs where rs.source_id = s.id);
  delete from public.zagulyaky_participants where record_id = existing.id;
  delete from public.zagulyaky_document_discoveries where record_id = existing.id;

  item_index := 0;
  for item in select value from jsonb_array_elements(p_sources) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'INVALID_SOURCE'; end if;
    insert into public.zagulyaky_sources(
      source_type, title, archive_name, fond, inventory, file_number,
      page_from, page_to, citation, source_url, source_platform, external_id,
      access_date, permission_status, metadata, created_by
    ) values (
      coalesce(nullif(item->>'sourceType', ''), 'other'),
      coalesce(item->>'title', ''), nullif(item->>'archiveName', ''),
      nullif(item->>'fond', ''), nullif(item->>'inventory', ''), nullif(item->>'fileNumber', ''),
      nullif(item->>'pageFrom', ''), nullif(item->>'pageTo', ''), coalesce(item->>'citation', ''),
      nullif(item->>'sourceUrl', ''), nullif(item->>'sourcePlatform', ''), nullif(item->>'externalId', ''),
      case when item->>'accessDate' ~ '^\d{4}-\d{2}-\d{2}$' then (item->>'accessDate')::date end,
      coalesce(nullif(item->>'permissionStatus', ''), 'unknown'),
      case when jsonb_typeof(item->'metadata') = 'object' then item->'metadata' else '{}'::jsonb end,
      current_user_id
    ) returning id into source_id;
    insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
    values (existing.id, source_id, item_index = 0);
    item_index := item_index + 1;
  end loop;

  item_index := 0;
  for item in select value from jsonb_array_elements(p_participants) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'INVALID_PARTICIPANT'; end if;

    structural_role := coalesce(nullif(btrim(item->>'role'), ''), 'subject');
    event_role_code := nullif(btrim(item->>'eventRoleCode'), '');
    event_role_custom := nullif(btrim(item->>'eventRoleCustom'), '');

    if event_role_code is not null and event_role_code not in (
      'subject', 'newborn', 'baptized', 'groom', 'bride',
      'groom_father', 'groom_mother', 'bride_father', 'bride_mother',
      'deceased', 'resident', 'household_head', 'household_member',
      'military_person', 'migrant', 'godparent', 'godchild',
      'father', 'mother', 'parent', 'child', 'spouse', 'witness',
      'pledger', 'officiant', 'registrar', 'midwife', 'informant',
      'owner', 'commander', 'official', 'other'
    ) then
      raise exception 'INVALID_EVENT_ROLE_CODE' using errcode = '22023';
    end if;
    if event_role_code = 'other'
      and (event_role_custom is null or char_length(event_role_custom) < 2) then
      raise exception 'EVENT_ROLE_CUSTOM_REQUIRED' using errcode = '23514';
    end if;
    if event_role_code is distinct from 'other' and event_role_custom is not null then
      raise exception 'EVENT_ROLE_CUSTOM_ONLY_FOR_OTHER' using errcode = '23514';
    end if;
    if char_length(coalesce(event_role_custom, '')) > 160 then
      raise exception 'EVENT_ROLE_CUSTOM_TOO_LONG' using errcode = '22023';
    end if;

    insert into public.zagulyaky_participants(
      record_id, role, event_role_code, event_role_custom,
      original_full_name, normalized_uk_full_name,
      surname, given_name, patronymic, maiden_name, sex, age_text,
      residence_text, origin_text, notes, sort_order
    ) values (
      existing.id, structural_role, event_role_code, event_role_custom,
      coalesce(item->>'originalFullName', ''), coalesce(item->>'normalizedUkFullName', ''),
      nullif(item->>'surname', ''), nullif(item->>'givenName', ''), nullif(item->>'patronymic', ''),
      nullif(item->>'maidenName', ''), nullif(item->>'sex', ''), nullif(item->>'ageText', ''),
      nullif(item->>'residenceText', ''), nullif(item->>'originText', ''),
      coalesce(item->>'notes', ''), item_index
    );
    item_index := item_index + 1;
  end loop;

  for item in select value from jsonb_array_elements(p_document_discoveries) loop
    if jsonb_typeof(item) <> 'object' then raise exception 'INVALID_DOCUMENT_DISCOVERY'; end if;
    insert into public.zagulyaky_document_discoveries(
      record_id, official_location_text, discovered_location_text, record_types,
      factual_year_from, factual_year_to, page_from, page_to, notes
    ) values (
      existing.id, coalesce(item->>'officialLocationText', ''), coalesce(item->>'discoveredLocationText', ''),
      coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(item->'recordTypes') = 'array' then item->'recordTypes' else '[]'::jsonb end)), '{}'::text[]),
      case when item->>'factualYearFrom' ~ '^\d{1,4}$' then (item->>'factualYearFrom')::integer end,
      case when item->>'factualYearTo' ~ '^\d{1,4}$' then (item->>'factualYearTo')::integer end,
      nullif(item->>'pageFrom', ''), nullif(item->>'pageTo', ''), coalesce(item->>'notes', '')
    );
  end loop;

  update public.zagulyaky_records set status = case when status = 'withdrawn' then 'draft' else status end
  where id = existing.id returning * into updated_record;
  return jsonb_build_object('record', to_jsonb(updated_record) - 'search_vector');
end;
$function$;

-- 190003 moved the broad detail builder out of the public schema and the
-- facade below redacts attachment Storage coordinates.  Recreate the private
-- builder with the two safe role fields; the public facade intentionally keeps
-- every participant field from this canonical projection and redacts only
-- public attachment bucket/path data.
create or replace function security_private.get_public_zagulyaka_v1(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
begin
  if char_length(btrim(coalesce(p_slug, ''))) not between 3 and 180 then
    return null;
  end if;
  select jsonb_build_object(
    'id', r.id,
    'slug', r.public_slug,
    'kind', r.kind,
    'title', r.title,
    'summary', r.summary,
    'originalText', r.original_text,
    'normalizedText', r.normalized_text,
    'originalLanguage', r.original_language,
    'eventType', r.event_type,
    'eventDateText', r.event_date_text,
    'eventYearFrom', r.event_year_from,
    'eventYearTo', r.event_year_to,
    'datePrecision', r.date_precision,
    'sourceLocationText', r.source_location_text,
    'sourceLocationNormalized', r.source_location_normalized,
    'foundLocationText', r.found_location_text,
    'foundLocationNormalized', r.found_location_normalized,
    'classificationReason', r.classification_reason,
    'verificationStatus', r.verification_status,
    'contributor', case when r.public_attribution then coalesce(r.public_attribution_name, 'Учасник спільноти') else null end,
    'publishedAt', r.published_at,
    'updatedAt', r.updated_at,
    'participants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'role', p.role,
        'eventRoleCode', p.event_role_code,
        'eventRoleCustom', p.event_role_custom,
        'originalFullName', p.original_full_name,
        'normalizedUkFullName', p.normalized_uk_full_name,
        'surname', p.surname,
        'givenName', p.given_name,
        'patronymic', p.patronymic,
        'maidenName', p.maiden_name,
        'sex', p.sex,
        'ageText', p.age_text,
        'residenceText', p.residence_text,
        'originText', p.origin_text,
        'notes', p.notes
      ) order by p.sort_order, p.id)
      from public.zagulyaky_participants p where p.record_id = r.id
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'sourceType', s.source_type,
        'title', s.title,
        'archiveName', s.archive_name,
        'fond', s.fond,
        'inventory', s.inventory,
        'fileNumber', s.file_number,
        'pageFrom', s.page_from,
        'pageTo', s.page_to,
        'citation', s.citation,
        'sourceUrl', s.source_url,
        'sourcePlatform', s.source_platform,
        'accessDate', s.access_date,
        'permissionStatus', s.permission_status,
        'isPrimary', rs.is_primary
      ) order by rs.is_primary desc, s.created_at, s.id)
      from public.zagulyaky_record_sources rs
      join public.zagulyaky_sources s on s.id = rs.source_id
      where rs.record_id = r.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'officialLocationText', d.official_location_text,
        'discoveredLocationText', d.discovered_location_text,
        'recordTypes', d.record_types,
        'factualYearFrom', d.factual_year_from,
        'factualYearTo', d.factual_year_to,
        'pageFrom', d.page_from,
        'pageTo', d.page_to,
        'notes', d.notes
      ) order by d.id)
      from public.zagulyaky_document_discoveries d where d.record_id = r.id
    ), '[]'::jsonb),
    'publicAttachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id,
        'bucket', a.public_bucket,
        'path', a.public_path,
        'fileName', a.file_name,
        'mimeType', a.mime_type,
        'byteSize', a.byte_size
      ) order by a.created_at, a.id)
      from public.zagulyaky_attachments a
      where a.record_id = r.id
        and a.is_public_derivative
        and a.public_bucket is not null
        and a.public_path is not null
    ), '[]'::jsonb),
    'confirmationCount', (
      select count(*) from public.zagulyaky_confirmations c
      where c.record_id = r.id and c.confirmation_type in ('confirm', 'source_checked')
    )
  ) into result
  from public.zagulyaky_records r
  where lower(r.public_slug) = lower(btrim(p_slug))
    and r.status = 'published'
    and r.privacy_status = 'cleared';

  return result;
end;
$function$;

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
    )
  end
  from source
$function$;

-- Reassert the existing explicit API grants after replacing the two public
-- functions.  This also prevents an inherited PUBLIC EXECUTE privilege from
-- resurfacing on deployments with different default privileges.
revoke all on function security_private.zagulyaky_living_person_content_fingerprint_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.get_public_zagulyaka_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)
  to authenticated, service_role;
revoke all on function public.get_public_zagulyaka_v1(text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_zagulyaka_v1(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
