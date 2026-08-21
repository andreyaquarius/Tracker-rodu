begin;

-- Initial-base review is intentionally source-card first.  The imported post
-- remains the private durable unit; candidate fields are only a bounded aid
-- for sorting, finding, and later human promotion.  Nothing in this migration
-- writes raw Facebook data, a source URL, or a candidate into the catalogue.

create or replace function security_private.zagulyaky_structuring_validate_candidate_v1(
  p_candidate jsonb,
  p_raw_text text
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  candidate_kind text;
  candidate_confidence numeric;
  candidate_title text;
  candidate_reason text;
  candidate_possible_living_signal boolean := false;
  event_value jsonb;
  event_type_value text;
  event_date_text_value text;
  event_place_text_value text;
  event_year_from_value integer;
  event_year_to_value integer;
  participant_value jsonb;
  participant_index integer := 0;
  structural_role_value text;
  event_role_code_value text;
  event_role_custom_value text;
  original_name_value text;
  normalized_name_value text;
  surname_value text;
  given_name_value text;
  patronymic_value text;
  sex_value text;
  origin_text_value text;
  residence_text_value text;
  social_estate_text_value text;
  safe_participants jsonb := '[]'::jsonb;
  safe_evidence jsonb := '[]'::jsonb;
  candidate_evidence jsonb;
  participant_evidence jsonb;
  evidence_remaining integer := 8;
  warning_value jsonb;
  safe_warnings jsonb := '[]'::jsonb;
  warning_count integer := 0;
  discovery_value jsonb;
  official_location_value text;
  discovered_location_value text;
  record_type_value jsonb;
  safe_record_types jsonb := '[]'::jsonb;
  discovery_year_from integer;
  discovery_year_to integer;
  page_from_value text;
  page_to_value text;
  safe_discovery jsonb;
  safe_data jsonb;
  subject_count integer := 0;
begin
  if p_candidate is null or jsonb_typeof(p_candidate) <> 'object'
    or octet_length(p_candidate::text) > 65536 then
    raise exception 'STRUCTURING_INVALID_CANDIDATE' using errcode = '22023';
  end if;

  candidate_kind := p_candidate ->> 'kind';
  if candidate_kind not in ('person', 'document') then
    raise exception 'STRUCTURING_INVALID_CANDIDATE_KIND' using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate -> 'confidence') <> 'number'
    or coalesce(p_candidate ->> 'confidence', '') !~ '^(0([.][0-9]+)?|1([.]0+)?)$' then
    raise exception 'STRUCTURING_INVALID_CANDIDATE_CONFIDENCE' using errcode = '22023';
  end if;
  candidate_confidence := (p_candidate ->> 'confidence')::numeric;
  if candidate_confidence < 0 or candidate_confidence > 1 then
    raise exception 'STRUCTURING_INVALID_CANDIDATE_CONFIDENCE' using errcode = '22023';
  end if;
  candidate_title := security_private.zagulyaky_structuring_safe_text_v1(
    p_candidate -> 'title', 'title', 300, true
  );
  candidate_reason := security_private.zagulyaky_structuring_safe_text_v1(
    p_candidate -> 'classificationReason', 'classification_reason', 1000, false
  );
  if p_candidate ? 'possibleLivingPerson' then
    if jsonb_typeof(p_candidate -> 'possibleLivingPerson') <> 'boolean' then
      raise exception 'STRUCTURING_INVALID_POSSIBLE_LIVING_SIGNAL' using errcode = '22023';
    end if;
    candidate_possible_living_signal := (p_candidate ->> 'possibleLivingPerson')::boolean;
  end if;

  event_value := coalesce(p_candidate -> 'event', '{}'::jsonb);
  if jsonb_typeof(event_value) <> 'object' then
    raise exception 'STRUCTURING_EVENT_MUST_BE_OBJECT' using errcode = '22023';
  end if;
  event_type_value := security_private.zagulyaky_structuring_safe_text_v1(
    event_value -> 'type', 'event_type', 40, false
  );
  if event_type_value is not null and event_type_value not in (
    'birth', 'baptism', 'marriage', 'death', 'burial', 'residence',
    'census', 'military', 'migration', 'other'
  ) then
    raise exception 'STRUCTURING_INVALID_EVENT_TYPE' using errcode = '22023';
  end if;
  event_date_text_value := security_private.zagulyaky_structuring_safe_text_v1(
    event_value -> 'dateText', 'event_date_text', 500, false
  );
  event_place_text_value := security_private.zagulyaky_structuring_safe_text_v1(
    event_value -> 'placeText', 'event_place_text', 500, false
  );
  if coalesce(event_value ->> 'yearFrom', '') <> '' then
    if event_value ->> 'yearFrom' !~ '^[0-9]{1,4}$' then
      raise exception 'STRUCTURING_INVALID_EVENT_YEAR' using errcode = '22023';
    end if;
    event_year_from_value := (event_value ->> 'yearFrom')::integer;
  end if;
  if coalesce(event_value ->> 'yearTo', '') <> '' then
    if event_value ->> 'yearTo' !~ '^[0-9]{1,4}$' then
      raise exception 'STRUCTURING_INVALID_EVENT_YEAR' using errcode = '22023';
    end if;
    event_year_to_value := (event_value ->> 'yearTo')::integer;
  end if;
  if event_year_from_value not between 1 and 2200
    or event_year_to_value not between 1 and 2200
    or (event_year_from_value is not null and event_year_to_value is not null
      and event_year_to_value < event_year_from_value) then
    raise exception 'STRUCTURING_INVALID_EVENT_YEAR' using errcode = '22023';
  end if;

  if p_candidate -> 'participants' is not null
    and jsonb_typeof(p_candidate -> 'participants') <> 'array' then
    raise exception 'STRUCTURING_PARTICIPANTS_MUST_BE_ARRAY' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_candidate -> 'participants', '[]'::jsonb)) > 30 then
    raise exception 'STRUCTURING_PARTICIPANT_LIMIT_EXCEEDED' using errcode = '54000';
  end if;
  for participant_value in select value from jsonb_array_elements(coalesce(p_candidate -> 'participants', '[]'::jsonb)) loop
    participant_index := participant_index + 1;
    if jsonb_typeof(participant_value) <> 'object' then
      raise exception 'STRUCTURING_INVALID_PARTICIPANT' using errcode = '22023';
    end if;
    structural_role_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'structuralRole', 'structural_role', 20, true
    );
    if structural_role_value not in (
      'subject', 'spouse', 'parent', 'child', 'witness', 'godparent',
      'official', 'relative', 'mentioned', 'other'
    ) then
      raise exception 'STRUCTURING_INVALID_STRUCTURAL_ROLE' using errcode = '22023';
    end if;
    event_role_code_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'eventRoleCode', 'event_role_code', 40, false
    );
    if event_role_code_value is not null and event_role_code_value not in (
      'subject', 'newborn', 'baptized', 'groom', 'bride',
      'groom_father', 'groom_mother', 'bride_father', 'bride_mother',
      'deceased', 'resident', 'household_head', 'household_member',
      'military_person', 'migrant', 'godparent', 'godchild',
      'father', 'mother', 'parent', 'child', 'spouse', 'witness',
      'pledger', 'officiant', 'registrar', 'midwife', 'informant',
      'owner', 'commander', 'official', 'other'
    ) then
      raise exception 'STRUCTURING_INVALID_EVENT_ROLE' using errcode = '22023';
    end if;
    event_role_custom_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'eventRoleCustom', 'event_role_custom', 160, false
    );
    if event_role_code_value = 'other'
      and (event_role_custom_value is null or char_length(event_role_custom_value) < 2) then
      raise exception 'STRUCTURING_EVENT_ROLE_CUSTOM_REQUIRED' using errcode = '22023';
    end if;
    if event_role_code_value is distinct from 'other' and event_role_custom_value is not null then
      raise exception 'STRUCTURING_EVENT_ROLE_CUSTOM_FORBIDDEN' using errcode = '22023';
    end if;
    original_name_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'originalFullName', 'original_full_name', 300, false
    );
    normalized_name_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'normalizedUkFullName', 'normalized_uk_full_name', 300, false
    );
    surname_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'surname', 'surname', 160, false
    );
    given_name_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'givenName', 'given_name', 160, false
    );
    patronymic_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'patronymic', 'patronymic', 160, false
    );
    sex_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'sex', 'sex', 20, false
    );
    if sex_value is not null and sex_value not in ('male', 'female', 'unknown') then
      raise exception 'STRUCTURING_INVALID_PARTICIPANT_SEX' using errcode = '22023';
    end if;
    -- These values remain verbatim, bounded provenance facts.  They are not
    -- normalized geography nor a claim about a living person.
    origin_text_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'originText', 'origin_text', 500, false
    );
    residence_text_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'residenceText', 'residence_text', 500, false
    );
    social_estate_text_value := security_private.zagulyaky_structuring_safe_text_v1(
      participant_value -> 'socialEstateText', 'social_estate_text', 240, false
    );
    if structural_role_value = 'subject'
      and coalesce(original_name_value, normalized_name_value) is not null then
      subject_count := subject_count + 1;
    end if;
    participant_evidence := security_private.zagulyaky_structuring_evidence_spans_v1(
      participant_value -> 'evidence', p_raw_text,
      'participant:' || participant_index::text, evidence_remaining
    );
    evidence_remaining := evidence_remaining - jsonb_array_length(participant_evidence);
    safe_evidence := safe_evidence || participant_evidence;
    safe_participants := safe_participants || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'structuralRole', structural_role_value,
      'eventRoleCode', event_role_code_value,
      'eventRoleCustom', event_role_custom_value,
      'originalFullName', original_name_value,
      'normalizedUkFullName', normalized_name_value,
      'surname', surname_value,
      'givenName', given_name_value,
      'patronymic', patronymic_value,
      'sex', sex_value,
      'originText', origin_text_value,
      'residenceText', residence_text_value,
      'socialEstateText', social_estate_text_value,
      'sortOrder', participant_index - 1
    )));
  end loop;
  if candidate_kind = 'person' and subject_count = 0 then
    raise exception 'STRUCTURING_PERSON_SUBJECT_REQUIRED' using errcode = '22023';
  end if;

  candidate_evidence := security_private.zagulyaky_structuring_evidence_spans_v1(
    p_candidate -> 'evidence', p_raw_text, 'candidate', evidence_remaining
  );
  safe_evidence := safe_evidence || candidate_evidence;

  if p_candidate -> 'warnings' is not null and jsonb_typeof(p_candidate -> 'warnings') <> 'array' then
    raise exception 'STRUCTURING_WARNINGS_MUST_BE_ARRAY' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_candidate -> 'warnings', '[]'::jsonb)) > 20 then
    raise exception 'STRUCTURING_WARNING_LIMIT_EXCEEDED' using errcode = '54000';
  end if;
  for warning_value in select value from jsonb_array_elements(coalesce(p_candidate -> 'warnings', '[]'::jsonb)) loop
    warning_count := warning_count + 1;
    safe_warnings := safe_warnings || jsonb_build_array(
      security_private.zagulyaky_structuring_safe_text_v1(
        warning_value, 'warning', 300, true
      )
    );
  end loop;

  discovery_value := p_candidate -> 'documentDiscovery';
  if discovery_value is not null and jsonb_typeof(discovery_value) not in ('object', 'null') then
    raise exception 'STRUCTURING_DOCUMENT_DISCOVERY_INVALID' using errcode = '22023';
  end if;
  if jsonb_typeof(discovery_value) = 'object' then
    official_location_value := security_private.zagulyaky_structuring_safe_text_v1(
      discovery_value -> 'officialLocationText', 'official_location_text', 500, false
    );
    discovered_location_value := security_private.zagulyaky_structuring_safe_text_v1(
      discovery_value -> 'discoveredLocationText', 'discovered_location_text', 500, false
    );
    if discovery_value -> 'recordTypes' is not null
      and jsonb_typeof(discovery_value -> 'recordTypes') <> 'array' then
      raise exception 'STRUCTURING_RECORD_TYPES_MUST_BE_ARRAY' using errcode = '22023';
    end if;
    if jsonb_array_length(coalesce(discovery_value -> 'recordTypes', '[]'::jsonb)) > 20 then
      raise exception 'STRUCTURING_RECORD_TYPE_LIMIT_EXCEEDED' using errcode = '54000';
    end if;
    for record_type_value in select value from jsonb_array_elements(coalesce(discovery_value -> 'recordTypes', '[]'::jsonb)) loop
      safe_record_types := safe_record_types || jsonb_build_array(
        security_private.zagulyaky_structuring_safe_text_v1(record_type_value, 'record_type', 120, true)
      );
    end loop;
    if coalesce(discovery_value ->> 'yearFrom', '') <> '' then
      if discovery_value ->> 'yearFrom' !~ '^[0-9]{1,4}$' then
        raise exception 'STRUCTURING_INVALID_DISCOVERY_YEAR' using errcode = '22023';
      end if;
      discovery_year_from := (discovery_value ->> 'yearFrom')::integer;
    end if;
    if coalesce(discovery_value ->> 'yearTo', '') <> '' then
      if discovery_value ->> 'yearTo' !~ '^[0-9]{1,4}$' then
        raise exception 'STRUCTURING_INVALID_DISCOVERY_YEAR' using errcode = '22023';
      end if;
      discovery_year_to := (discovery_value ->> 'yearTo')::integer;
    end if;
    if discovery_year_from not between 1 and 2200
      or discovery_year_to not between 1 and 2200
      or (discovery_year_from is not null and discovery_year_to is not null
        and discovery_year_to < discovery_year_from) then
      raise exception 'STRUCTURING_INVALID_DISCOVERY_YEAR' using errcode = '22023';
    end if;
    page_from_value := security_private.zagulyaky_structuring_safe_text_v1(
      discovery_value -> 'pageFrom', 'page_from', 80, false
    );
    page_to_value := security_private.zagulyaky_structuring_safe_text_v1(
      discovery_value -> 'pageTo', 'page_to', 80, false
    );
    safe_discovery := jsonb_strip_nulls(jsonb_build_object(
      'officialLocationText', official_location_value,
      'discoveredLocationText', discovered_location_value,
      'recordTypes', safe_record_types,
      'yearFrom', discovery_year_from,
      'yearTo', discovery_year_to,
      'pageFrom', page_from_value,
      'pageTo', page_to_value
    ));
  else
    safe_discovery := null;
  end if;

  safe_data := jsonb_strip_nulls(jsonb_build_object(
    'kind', candidate_kind,
    'title', candidate_title,
    'classificationReason', candidate_reason,
    'possibleLivingPerson', candidate_possible_living_signal,
    'event', jsonb_strip_nulls(jsonb_build_object(
      'type', event_type_value,
      'dateText', event_date_text_value,
      'yearFrom', event_year_from_value,
      'yearTo', event_year_to_value,
      'placeText', event_place_text_value
    )),
    'participants', safe_participants,
    'documentDiscovery', safe_discovery
  ));

  return jsonb_build_object(
    'kind', candidate_kind,
    'confidence', candidate_confidence,
    'candidateData', safe_data,
    'evidenceSpans', safe_evidence,
    'warnings', safe_warnings,
    -- Changes to origin/residence/estate are material distinctions for a
    -- source-card review, so their bounded values participate in this key.
    'candidateKey', security_private.zagulyaky_structuring_sha256_v1(
      jsonb_build_object(
        'kind', candidate_kind,
        'title', lower(candidate_title),
        'event', safe_data -> 'event',
        'participants', safe_participants,
        'documentDiscovery', safe_discovery
      )::text
    )
  );
end;
$function$;

-- Search deliberately enumerates every permitted field.  In particular, it
-- must not use candidate_data::text: doing so would make future private or
-- operational keys searchable through the list endpoint by accident.
create or replace function security_private.zagulyaky_structured_candidate_search_text_v1(
  p_candidate_data jsonb
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with candidate as (
    select case
      when p_candidate_data is not null and jsonb_typeof(p_candidate_data) = 'object'
        then p_candidate_data
      else '{}'::jsonb
    end as data
  )
  select coalesce(concat_ws(
    ' ',
    nullif(btrim(data ->> 'kind'), ''),
    nullif(btrim(data ->> 'title'), ''),
    nullif(btrim(data ->> 'classificationReason'), ''),
    nullif(btrim(data -> 'event' ->> 'type'), ''),
    nullif(btrim(data -> 'event' ->> 'dateText'), ''),
    nullif(btrim(data -> 'event' ->> 'placeText'), ''),
    nullif(btrim(data -> 'event' ->> 'yearFrom'), ''),
    nullif(btrim(data -> 'event' ->> 'yearTo'), ''),
    (
      select nullif(btrim(string_agg(concat_ws(
        ' ',
        nullif(btrim(participant.value ->> 'structuralRole'), ''),
        nullif(btrim(participant.value ->> 'eventRoleCode'), ''),
        nullif(btrim(participant.value ->> 'eventRoleCustom'), ''),
        nullif(btrim(participant.value ->> 'originalFullName'), ''),
        nullif(btrim(participant.value ->> 'normalizedUkFullName'), ''),
        nullif(btrim(participant.value ->> 'surname'), ''),
        nullif(btrim(participant.value ->> 'givenName'), ''),
        nullif(btrim(participant.value ->> 'patronymic'), ''),
        nullif(btrim(participant.value ->> 'sex'), ''),
        nullif(btrim(participant.value ->> 'originText'), ''),
        nullif(btrim(participant.value ->> 'residenceText'), ''),
        nullif(btrim(participant.value ->> 'socialEstateText'), '')
      ), ' ')), '')
      from jsonb_array_elements(
        case when jsonb_typeof(data -> 'participants') = 'array'
          then data -> 'participants' else '[]'::jsonb end
      ) as participant(value)
    ),
    nullif(btrim(data -> 'documentDiscovery' ->> 'officialLocationText'), ''),
    nullif(btrim(data -> 'documentDiscovery' ->> 'discoveredLocationText'), ''),
    nullif(btrim(data -> 'documentDiscovery' ->> 'yearFrom'), ''),
    nullif(btrim(data -> 'documentDiscovery' ->> 'yearTo'), ''),
    nullif(btrim(data -> 'documentDiscovery' ->> 'pageFrom'), ''),
    nullif(btrim(data -> 'documentDiscovery' ->> 'pageTo'), ''),
    (
      select nullif(btrim(string_agg(nullif(btrim(record_type.value), ''), ' ')), '')
      from jsonb_array_elements_text(
        case when jsonb_typeof(data -> 'documentDiscovery' -> 'recordTypes') = 'array'
          then data -> 'documentDiscovery' -> 'recordTypes' else '[]'::jsonb end
      ) as record_type(value)
    )
  ), '')
  from candidate;
$function$;

create index if not exists zagulyaky_structured_candidates_item_status_created_idx
  on public.zagulyaky_ingestion_structured_candidates(item_id, status, created_at desc, id);

create or replace function security_private.admin_list_zagulyaky_ingestion_items_v1(
  p_batch_id uuid,
  p_query text default null,
  p_stage_status text default null,
  p_quarantined boolean default null,
  p_flag text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  safe_query text := nullif(btrim(coalesce(p_query, '')), '');
  safe_stage_status text := nullif(btrim(coalesce(p_stage_status, '')), '');
  safe_flag text := nullif(lower(btrim(coalesce(p_flag, ''))), '');
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
  result jsonb;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.zagulyaky_ingestion_batches batch where batch.id = p_batch_id
  ) then
    raise exception 'INGESTION_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;

  if safe_query is not null and char_length(safe_query) > 160 then
    raise exception 'INGESTION_SEARCH_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  if safe_stage_status is not null and safe_stage_status not in (
    'staged', 'quarantined', 'structured', 'linked', 'ignored'
  ) then
    raise exception 'INVALID_INGESTION_STAGE_STATUS' using errcode = '22023';
  end if;
  if safe_flag is not null and safe_flag not in (
    'has_attachments', 'requires_ocr', 'requires_source_refetch',
    'suspected_duplicate', 'possible_living_person', 'rights_review_required',
    'unlinked'
  ) then
    raise exception 'INVALID_INGESTION_FILTER' using errcode = '22023';
  end if;

  with filtered as materialized (
    select
      membership.source_item_index,
      membership.encountered_at,
      item.id as item_id,
      item.external_id,
      item.stage_status,
      item.quarantined,
      item.source_published_at,
      item.source_date_precision,
      item.candidate_years,
      item.raw_text,
      item.declared_attachment_count,
      item.source_incomplete,
      item.text_truncated,
      item.requires_ocr,
      item.requires_source_refetch,
      item.missing_author,
      item.missing_publication_date,
      item.suspected_duplicate,
      item.rights_review_required,
      item.possible_living_person,
      item.updated_at,
      (
        select count(*)::integer
        from public.zagulyaky_ingestion_attachments attachment
        where attachment.item_id = item.id
      ) as attachment_count,
      (
        select count(*)::integer
        from public.zagulyaky_ingestion_links link
        where link.item_id = item.id
      ) as link_count,
      (
        select count(*)::integer
        from public.zagulyaky_extraction_jobs job
        where job.item_id = item.id
      ) as extraction_job_count,
      (
        select count(*)::integer
        from public.zagulyaky_ingestion_item_records record_link
        where record_link.item_id = item.id
      ) as linked_record_count,
      (
        select count(*)::integer
        from public.zagulyaky_ingestion_structured_candidates candidate
        where candidate.item_id = item.id
      ) as structured_candidate_count,
      (
        select count(*)::integer
        from public.zagulyaky_ingestion_structured_candidates candidate
        where candidate.item_id = item.id and candidate.kind = 'person'
      ) as structured_person_count,
      (
        select count(*)::integer
        from public.zagulyaky_ingestion_structured_candidates candidate
        where candidate.item_id = item.id and candidate.kind = 'document'
      ) as structured_document_count
    from public.zagulyaky_ingestion_batch_items membership
    join public.zagulyaky_ingestion_items item on item.id = membership.item_id
    where membership.batch_id = p_batch_id
      and (safe_stage_status is null or item.stage_status = safe_stage_status)
      and (p_quarantined is null or item.quarantined = p_quarantined)
      and (
        safe_query is null
        or position(lower(safe_query) in lower(coalesce(item.external_id, ''))) > 0
        or position(lower(safe_query) in lower(coalesce(item.raw_text, ''))) > 0
        or exists (
          select 1
          from public.zagulyaky_ingestion_structured_candidates candidate
          where candidate.item_id = item.id
            and position(
              lower(safe_query) in lower(
                security_private.zagulyaky_structured_candidate_search_text_v1(candidate.candidate_data)
              )
            ) > 0
        )
      )
      and (
        safe_flag is null
        or case safe_flag
          when 'has_attachments' then exists (
            select 1 from public.zagulyaky_ingestion_attachments attachment
            where attachment.item_id = item.id
          )
          when 'requires_ocr' then item.requires_ocr
          when 'requires_source_refetch' then item.requires_source_refetch
          when 'suspected_duplicate' then item.suspected_duplicate
          when 'possible_living_person' then item.possible_living_person
          when 'rights_review_required' then item.rights_review_required
          when 'unlinked' then not exists (
            select 1 from public.zagulyaky_ingestion_item_records record_link
            where record_link.item_id = item.id
          )
          else false
        end
      )
  ), paged as materialized (
    select *
    from filtered
    order by source_item_index asc, item_id asc
    limit safe_limit
    offset safe_offset
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'itemId', page.item_id,
      'sourceItemIndex', page.source_item_index,
      'encounteredAt', page.encountered_at,
      'externalId', page.external_id,
      'stageStatus', page.stage_status,
      'quarantined', page.quarantined,
      'sourcePublishedAt', page.source_published_at,
      'sourceDatePrecision', page.source_date_precision,
      'candidateYears', page.candidate_years,
      -- A list row is intentionally safe to scan without opening an item.
      'textPreview', nullif(left(
        regexp_replace(
          regexp_replace(
            coalesce(page.raw_text, ''),
            '((https?|ftp)://|www[.]|mailto:)[^[:space:]]+',
            '[посилання приховано]',
            'gi'
          ),
          '[[:space:]]+',
          ' ',
          'g'
        ),
        360
      ), ''),
      'rawTextLength', char_length(coalesce(page.raw_text, '')),
      'declaredAttachmentCount', page.declared_attachment_count,
      'attachmentCount', page.attachment_count,
      'linkCount', page.link_count,
      'extractionJobCount', page.extraction_job_count,
      'linkedRecordCount', page.linked_record_count,
      'structuredCandidateCount', page.structured_candidate_count,
      'structuredPersonCount', page.structured_person_count,
      'structuredDocumentCount', page.structured_document_count,
      'flags', jsonb_build_object(
        'sourceIncomplete', page.source_incomplete,
        'textTruncated', page.text_truncated,
        'requiresOcr', page.requires_ocr,
        'requiresSourceRefetch', page.requires_source_refetch,
        'missingAuthor', page.missing_author,
        'missingPublicationDate', page.missing_publication_date,
        'suspectedDuplicate', page.suspected_duplicate,
        'rightsReviewRequired', page.rights_review_required,
        'possibleLivingPerson', page.possible_living_person
      ),
      'updatedAt', page.updated_at
    ) order by page.source_item_index asc, page.item_id asc), '[]'::jsonb),
    'total', (select count(*) from filtered),
    'limit', safe_limit,
    'offset', safe_offset
  ) into result
  from paged page;

  return result;
end;
$function$;

create or replace function security_private.admin_get_zagulyaky_ingestion_item_v1(
  p_batch_id uuid,
  p_item_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  item_row public.zagulyaky_ingestion_items;
  source_item_index integer;
  encountered_at timestamptz;
  attachment_count integer := 0;
  link_count integer := 0;
  job_count integer := 0;
  record_link_count integer := 0;
  structured_candidate_count integer := 0;
  raw_text_length integer := 0;
  result jsonb;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  select item.* into item_row
  from public.zagulyaky_ingestion_batch_items membership
  join public.zagulyaky_ingestion_items item on item.id = membership.item_id
  where membership.batch_id = p_batch_id
    and membership.item_id = p_item_id;

  if not found then
    raise exception 'INGESTION_ITEM_NOT_FOUND' using errcode = 'P0002';
  end if;

  select membership.source_item_index, membership.encountered_at
  into source_item_index, encountered_at
  from public.zagulyaky_ingestion_batch_items membership
  where membership.batch_id = p_batch_id and membership.item_id = p_item_id;

  select count(*)::integer into attachment_count
  from public.zagulyaky_ingestion_attachments attachment
  where attachment.item_id = item_row.id;
  select count(*)::integer into link_count
  from public.zagulyaky_ingestion_links link
  where link.item_id = item_row.id;
  select count(*)::integer into job_count
  from public.zagulyaky_extraction_jobs job
  where job.item_id = item_row.id;
  select count(*)::integer into record_link_count
  from public.zagulyaky_ingestion_item_records record_link
  where record_link.item_id = item_row.id;
  select count(*)::integer into structured_candidate_count
  from public.zagulyaky_ingestion_structured_candidates candidate
  where candidate.item_id = item_row.id;
  raw_text_length := char_length(coalesce(item_row.raw_text, ''));

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id,
    'zagulyaky.ingestion_item.view',
    'zagulyaky_ingestion_item',
    item_row.id::text,
    'success',
    jsonb_build_object(
      'batchId', p_batch_id,
      'sourceItemIndex', source_item_index,
      'rawTextCharactersReturned', least(raw_text_length, 16000),
      'attachmentCount', attachment_count,
      'linkCount', link_count,
      'jobCount', job_count,
      'recordLinkCount', record_link_count,
      'structuredCandidateCount', structured_candidate_count
    )
  );

  select jsonb_build_object(
    'item', jsonb_build_object(
      'itemId', item_row.id,
      'sourceItemIndex', source_item_index,
      'encounteredAt', encountered_at,
      'externalId', item_row.external_id,
      'stageStatus', item_row.stage_status,
      'quarantined', item_row.quarantined,
      'flags', jsonb_build_object(
        'sourceIncomplete', item_row.source_incomplete,
        'textTruncated', item_row.text_truncated,
        'requiresOcr', item_row.requires_ocr,
        'requiresSourceRefetch', item_row.requires_source_refetch,
        'missingAuthor', item_row.missing_author,
        'missingPublicationDate', item_row.missing_publication_date,
        'suspectedDuplicate', item_row.suspected_duplicate,
        'rightsReviewRequired', item_row.rights_review_required,
        'possibleLivingPerson', item_row.possible_living_person
      ),
      'source', jsonb_build_object(
        'sourceUrl', item_row.source_url,
        -- This explicit field is a post URL only.  It is never part of a
        -- list-row response and the caller already passed zagulyaky.import.
        'facebookPostUrl', case
          when coalesce(item_row.source_url, '') ~* '^https://([a-z0-9-]+[.])*facebook[.]com([/:?#]|$)'
            or coalesce(item_row.source_url, '') ~* '^https://([a-z0-9-]+[.])*fb[.]com([/:?#]|$)'
            then item_row.source_url
          else null
        end,
        'sourceCollectionUrl', item_row.source_collection_url,
        'sourceAuthorLabel', item_row.source_author_label,
        'sourceDateText', item_row.source_date_text,
        'sourcePublishedAt', item_row.source_published_at,
        'sourceDatePrecision', item_row.source_date_precision,
        'scrapedAt', item_row.scraped_at,
        'collectedAt', item_row.collected_at,
        'sourceUpdatedAt', item_row.source_updated_at,
        'candidateYears', item_row.candidate_years
      ),
      'content', jsonb_build_object(
        'rawText', case when item_row.raw_text is null then null else left(item_row.raw_text, 16000) end,
        'rawTextLength', raw_text_length,
        'rawTextTruncatedForReview', raw_text_length > 16000,
        'sourceTextTruncated', item_row.text_truncated
      ),
      'declaredAttachmentCount', item_row.declared_attachment_count,
      'attachmentCount', attachment_count,
      'attachmentDetailsTruncated', attachment_count > 100,
      'linkCount', link_count,
      'linkDetailsTruncated', link_count > 100,
      'jobCount', job_count,
      'jobDetailsTruncated', job_count > 100,
      'recordLinkCount', record_link_count,
      'recordLinkDetailsTruncated', record_link_count > 100,
      'structuredCandidateCount', structured_candidate_count,
      'structuredCandidateDetailsTruncated', structured_candidate_count > 100,
      'updatedAt', item_row.updated_at
    ),
    'structuredCandidates', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'candidateId', candidate_row.id,
        'kind', candidate_row.kind,
        'confidence', candidate_row.confidence,
        'status', candidate_row.status,
        'privacyReviewRequired', candidate_row.privacy_review_required,
        'title', candidate_row.candidate_data ->> 'title',
        'classificationReason', candidate_row.candidate_data ->> 'classificationReason',
        'possibleLivingPerson', coalesce((candidate_row.candidate_data ->> 'possibleLivingPerson')::boolean, false),
        'event', candidate_row.candidate_data -> 'event',
        'participants', candidate_row.candidate_data -> 'participants',
        'documentDiscovery', candidate_row.candidate_data -> 'documentDiscovery',
        'warnings', candidate_row.warnings,
        'materializedRecordId', candidate_row.materialized_record_id,
        'createdAt', candidate_row.created_at,
        'updatedAt', candidate_row.updated_at
      )) order by candidate_row.created_at asc, candidate_row.id asc)
      from (
        select
          candidate.id,
          candidate.kind,
          candidate.confidence,
          candidate.status,
          candidate.privacy_review_required,
          candidate.candidate_data,
          candidate.warnings,
          candidate.materialized_record_id,
          candidate.created_at,
          candidate.updated_at
        from public.zagulyaky_ingestion_structured_candidates candidate
        where candidate.item_id = item_row.id
        order by candidate.created_at asc, candidate.id asc
        limit 100
      ) candidate_row
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'attachmentId', attachment_row.id,
        'sourceIndex', attachment_row.source_index,
        'facebookPhotoId', attachment_row.facebook_photo_id,
        'originalCdnUrl', attachment_row.original_cdn_url,
        'photoPageUrl', attachment_row.photo_page_url,
        'altText', case when attachment_row.alt_text is null then null else left(attachment_row.alt_text, 1000) end,
        'width', attachment_row.width,
        'height', attachment_row.height,
        'downloadStatus', attachment_row.download_status,
        'rightsStatus', attachment_row.rights_status
      ) order by attachment_row.source_index asc, attachment_row.id asc)
      from (
        select
          attachment.id,
          attachment.source_index,
          asset.facebook_photo_id,
          attachment.original_cdn_url,
          attachment.photo_page_url,
          attachment.alt_text,
          attachment.width,
          attachment.height,
          asset.download_status,
          asset.rights_status
        from public.zagulyaky_ingestion_attachments attachment
        join public.zagulyaky_ingestion_media_assets asset on asset.id = attachment.asset_id
        where attachment.item_id = item_row.id
        order by attachment.source_index asc, attachment.id asc
        limit 100
      ) attachment_row
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'linkId', link_row.id,
        'sourceIndex', link_row.source_index,
        'rawUrl', link_row.raw_url,
        'normalizedUrl', link_row.normalized_url,
        'label', link_row.label,
        'linkKind', link_row.link_kind,
        'requiresSafeFetch', link_row.requires_safe_fetch
      ) order by link_row.source_index asc, link_row.id asc)
      from (
        select
          link.id,
          link.source_index,
          link.raw_url,
          link.normalized_url,
          link.label,
          link.link_kind,
          link.requires_safe_fetch
        from public.zagulyaky_ingestion_links link
        where link.item_id = item_row.id
        order by link.source_index asc, link.id asc
        limit 100
      ) link_row
    ), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'jobId', job_row.id,
        'jobType', job_row.job_type,
        'status', job_row.status,
        'attemptCount', job_row.attempt_count,
        'lastErrorCode', job_row.last_error_code,
        'createdAt', job_row.created_at,
        'claimedAt', job_row.claimed_at,
        'completedAt', job_row.completed_at
      ) order by job_row.created_at desc, job_row.id desc)
      from (
        select
          job.id,
          job.job_type,
          job.status,
          job.attempt_count,
          job.last_error_code,
          job.created_at,
          job.claimed_at,
          job.completed_at
        from public.zagulyaky_extraction_jobs job
        where job.item_id = item_row.id
        order by job.created_at desc, job.id desc
        limit 100
      ) job_row
    ), '[]'::jsonb),
    'recordLinks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'recordId', record_link_row.record_id,
        'relationshipKind', record_link_row.relationship_kind,
        'linkedAt', record_link_row.linked_at
      ) order by record_link_row.linked_at desc, record_link_row.record_id asc)
      from (
        select
          record_link.record_id,
          record_link.relationship_kind,
          record_link.linked_at
        from public.zagulyaky_ingestion_item_records record_link
        where record_link.item_id = item_row.id
        order by record_link.linked_at desc, record_link.record_id asc
        limit 100
      ) record_link_row
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$function$;

-- The selected-item functions remain the sole browser path to raw Facebook
-- post text and the explicit Facebook post URL.  Direct table access stays
-- revoked under the migrations that created these private staging tables.
revoke all on function security_private.zagulyaky_structuring_validate_candidate_v1(jsonb,text)
  from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_structured_candidate_search_text_v1(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)
  from public, anon, authenticated, service_role;

grant execute on function security_private.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)
  to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)
  to authenticated, service_role;

-- Automatic catalogue fan-out is deliberately disabled for the initial base.
-- Existing private drafts are preserved; promotion must become an explicit,
-- reviewed workflow rather than a bulk automatic materialization action.
revoke all on function security_private.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
