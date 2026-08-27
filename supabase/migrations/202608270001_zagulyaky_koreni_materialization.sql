begin;

-- Koreni is an external, versioned open-data source.  These tables are not a
-- replacement for the retired private staging pipelines: they contain only
-- durable receipts and stable provenance needed for idempotency and rollback.
create table if not exists security_private.zagulyaky_koreni_batches (
  id uuid primary key default gen_random_uuid(),
  source_file_name text not null check (char_length(source_file_name) between 1 and 255),
  source_checksum text not null unique check (source_checksum ~ '^[0-9a-f]{64}$'),
  upstream_commit_sha text not null check (upstream_commit_sha ~ '^[0-9a-f]{40}$'),
  transform_version text not null check (char_length(transform_version) between 1 and 160),
  expected_record_count integer not null check (expected_record_count between 1 and 1000000),
  materialized_record_count integer not null default 0,
  status text not null default 'running' check (status in ('running', 'completed')),
  actor_id uuid not null references public.profiles(user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check (materialized_record_count between 0 and expected_record_count),
  check (
    (status = 'running' and completed_at is null)
    or
    (status = 'completed' and completed_at is not null
      and materialized_record_count = expected_record_count)
  )
);

create table if not exists security_private.zagulyaky_koreni_source_rows (
  upstream_table_id text not null check (char_length(upstream_table_id) between 1 and 200),
  upstream_row_number integer not null check (upstream_row_number > 0),
  upstream_row_sha256 text not null check (upstream_row_sha256 ~ '^[0-9a-f]{64}$'),
  source_id uuid not null unique references public.zagulyaky_sources(id) on delete restrict,
  source_url text not null check (
    char_length(source_url) <= 2000
    and source_url ~ '^https://koreni[.]org[.]ua(/|$)'
  ),
  first_batch_id uuid not null references security_private.zagulyaky_koreni_batches(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (upstream_table_id, upstream_row_number)
);

create table if not exists security_private.zagulyaky_koreni_record_map (
  external_record_key text primary key check (
    char_length(external_record_key) between 10 and 240
    and external_record_key ~ '^koreni:'
  ),
  batch_id uuid not null references security_private.zagulyaky_koreni_batches(id) on delete restrict,
  upstream_table_id text not null,
  upstream_row_number integer not null,
  upstream_row_sha256 text not null check (upstream_row_sha256 ~ '^[0-9a-f]{64}$'),
  record_id uuid not null unique references public.zagulyaky_records(id) on delete restrict,
  candidate_payload_sha256 text not null check (candidate_payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_group_key text check (event_group_key is null or char_length(event_group_key) <= 240),
  created_at timestamptz not null default now(),
  foreign key (upstream_table_id, upstream_row_number)
    references security_private.zagulyaky_koreni_source_rows(upstream_table_id, upstream_row_number)
    on delete restrict
);

create index if not exists zagulyaky_koreni_record_map_batch_idx
  on security_private.zagulyaky_koreni_record_map(batch_id, record_id);

alter table security_private.zagulyaky_koreni_batches enable row level security;
alter table security_private.zagulyaky_koreni_source_rows enable row level security;
alter table security_private.zagulyaky_koreni_record_map enable row level security;

revoke all on table
  security_private.zagulyaky_koreni_batches,
  security_private.zagulyaky_koreni_source_rows,
  security_private.zagulyaky_koreni_record_map
from public, anon, authenticated, service_role;
grant select on table
  security_private.zagulyaky_koreni_batches,
  security_private.zagulyaky_koreni_source_rows,
  security_private.zagulyaky_koreni_record_map
to service_role;

create or replace function security_private.zagulyaky_koreni_sha256_v1(p_value text)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, extensions, security_private, pg_temp
as $function$
  select encode(extensions.digest(coalesce(p_value, ''), 'sha256'), 'hex')
$function$;

revoke all on function security_private.zagulyaky_koreni_sha256_v1(text)
  from public, anon, authenticated, service_role;

create or replace function security_private.materialize_koreni_zagulyaky_v1(
  p_actor_id uuid,
  p_source_file_name text,
  p_source_checksum text,
  p_upstream_commit_sha text,
  p_transform_version text,
  p_expected_record_count integer,
  p_items jsonb,
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, security_private, extensions, pg_temp
as $function$
<<materializer>>
declare
  item jsonb;
  item_count integer;
  actor_name text;
  external_record_key text;
  event_group_key text;
  upstream_table_id text;
  upstream_row_number integer;
  upstream_row_sha256 text;
  source_url text;
  source_id uuid;
  record_id uuid;
  record_slug text;
  record_title text;
  payload_sha256 text;
  event_year_from integer;
  event_year_to integer;
  event_role_code text;
  event_role_custom text;
  date_precision text;
  participant_sex text;
  confidence_score numeric;
  duplicate_group_size integer;
  existing_map security_private.zagulyaky_koreni_record_map%rowtype;
  existing_source security_private.zagulyaky_koreni_source_rows%rowtype;
  batch_row security_private.zagulyaky_koreni_batches%rowtype;
  existing_batch_checksum text;
  created_count integer := 0;
  unchanged_count integer := 0;
  would_create_count integer := 0;
  batch_count integer := 0;
begin
  if p_dry_run is null then
    raise exception 'KORENI_DRY_RUN_REQUIRED' using errcode = '22004';
  end if;

  if p_actor_id is null
    or not exists (select 1 from public.profiles where user_id = p_actor_id)
    or not exists (select 1 from public.app_admins where user_id = p_actor_id) then
    raise exception 'KORENI_IMPORT_ADMIN_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(display_name), ''), 'Адміністратор Трекера Роду')
  into actor_name
  from public.profiles
  where user_id = p_actor_id;

  if p_source_file_name is null or char_length(btrim(p_source_file_name)) not between 1 and 255 then
    raise exception 'KORENI_SOURCE_FILE_NAME_INVALID' using errcode = '22023';
  end if;
  if p_source_checksum is null or p_source_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'KORENI_SOURCE_CHECKSUM_INVALID' using errcode = '22023';
  end if;
  if p_upstream_commit_sha is null or p_upstream_commit_sha !~ '^[0-9a-f]{40}$' then
    raise exception 'KORENI_COMMIT_SHA_INVALID' using errcode = '22023';
  end if;
  if p_transform_version is null or char_length(btrim(p_transform_version)) not between 1 and 160 then
    raise exception 'KORENI_TRANSFORM_VERSION_INVALID' using errcode = '22023';
  end if;
  if p_expected_record_count is null or p_expected_record_count not between 1 and 1000000 then
    raise exception 'KORENI_EXPECTED_COUNT_INVALID' using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'KORENI_ITEMS_ARRAY_REQUIRED' using errcode = '22023';
  end if;
  item_count := jsonb_array_length(p_items);
  if item_count not between 1 and 250 then
    raise exception 'KORENI_CHUNK_SIZE_INVALID' using errcode = '54000';
  end if;
  if octet_length(p_items::text) > 8388608 then
    raise exception 'KORENI_CHUNK_TOO_LARGE' using errcode = '54000';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) as candidate(value)
    group by candidate.value ->> 'externalRecordKey'
    having count(*) > 1
  ) then
    raise exception 'KORENI_DUPLICATE_KEY_IN_CHUNK' using errcode = '23505';
  end if;

  if not p_dry_run then
    perform pg_advisory_xact_lock(hashtextextended('zagulyaky:koreni:materialize:v1', 0));
  end if;

  -- Validate the complete chunk before the first write.  The same loop also
  -- proves that any already-materialized key has exactly the same payload.
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'KORENI_ITEM_OBJECT_REQUIRED' using errcode = '22023';
    end if;

    external_record_key := nullif(btrim(item ->> 'externalRecordKey'), '');
    event_group_key := nullif(btrim(item ->> 'eventGroupKey'), '');
    upstream_table_id := nullif(btrim(item ->> 'upstreamTableId'), '');
    upstream_row_sha256 := nullif(btrim(item ->> 'upstreamRowSha256'), '');
    source_url := nullif(btrim(item ->> 'sourceUrl'), '');

    if external_record_key is null
      or char_length(external_record_key) > 240
      or external_record_key !~ '^koreni:[A-Za-z0-9._-]{1,180}:[0-9a-f]{24}$' then
      raise exception 'KORENI_EXTERNAL_RECORD_KEY_INVALID' using errcode = '22023';
    end if;
    if upstream_table_id is null
      or upstream_table_id !~ '^[A-Za-z0-9._-]{1,180}$'
      or split_part(external_record_key, ':', 2) <> upstream_table_id then
      raise exception 'KORENI_UPSTREAM_TABLE_ID_INVALID' using errcode = '22023';
    end if;
    if event_group_key is null
      or char_length(event_group_key) > 240
      or event_group_key !~ '^koreni:[A-Za-z0-9._-]{1,180}:[0-9a-f]{24}$'
      or split_part(event_group_key, ':', 2) <> upstream_table_id then
      raise exception 'KORENI_EVENT_GROUP_KEY_INVALID' using errcode = '22023';
    end if;
    if coalesce(item ->> 'upstreamRowNumber', '') !~ '^[1-9][0-9]*$' then
      raise exception 'KORENI_UPSTREAM_ROW_NUMBER_INVALID' using errcode = '22023';
    end if;
    upstream_row_number := (item ->> 'upstreamRowNumber')::integer;
    if upstream_row_sha256 is null or upstream_row_sha256 !~ '^[0-9a-f]{64}$' then
      raise exception 'KORENI_UPSTREAM_ROW_SHA_INVALID' using errcode = '22023';
    end if;
    if source_url is null or char_length(source_url) > 2000
      or source_url !~ '^https://koreni[.]org[.]ua(/|$)' then
      raise exception 'KORENI_SOURCE_URL_INVALID' using errcode = '22023';
    end if;

    if item ->> 'kind' <> 'person' or item ->> 'publicationStatus' <> 'publishable' then
      raise exception 'KORENI_ITEM_NOT_PUBLISHABLE_PERSON' using errcode = '22023';
    end if;
    if item -> 'aiGenerated' is distinct from 'false'::jsonb then
      raise exception 'KORENI_AI_GENERATED_ITEM_REJECTED' using errcode = '22023';
    end if;
    if char_length(btrim(coalesce(item ->> 'originalFullName', ''))) not between 1 and 500
      or char_length(coalesce(item ->> 'normalizedUkFullName', '')) > 500 then
      raise exception 'KORENI_PERSON_NAME_INVALID' using errcode = '22023';
    end if;
    record_title := left(coalesce(
      nullif(btrim(item ->> 'normalizedUkFullName'), ''),
      nullif(btrim(item ->> 'title'), ''),
      nullif(btrim(item ->> 'originalFullName'), '')
    ), 300);
    if record_title is null then
      raise exception 'KORENI_TITLE_REQUIRED' using errcode = '22023';
    end if;
    if char_length(btrim(coalesce(item ->> 'originText', ''))) not between 1 and 4000
      or char_length(btrim(coalesce(item ->> 'foundText', ''))) not between 1 and 4000 then
      raise exception 'KORENI_LOCATIONS_REQUIRED' using errcode = '22023';
    end if;
    if char_length(btrim(coalesce(item ->> 'classificationReason', ''))) not between 1 and 12000 then
      raise exception 'KORENI_CLASSIFICATION_REASON_REQUIRED' using errcode = '22023';
    end if;
    if char_length(coalesce(item ->> 'originalText', '')) not between 1 and 250000 then
      raise exception 'KORENI_ORIGINAL_TEXT_REQUIRED' using errcode = '22023';
    end if;
    if char_length(coalesce(item ->> 'sourceTitle', '')) > 2000
      or char_length(coalesce(item ->> 'institutionName', '')) > 2000
      or char_length(coalesce(item ->> 'archiveReference', '')) > 4000
      or char_length(coalesce(item ->> 'pageLabel', '')) > 1000
      or char_length(coalesce(item ->> 'originalLanguage', '')) > 160
      or char_length(coalesce(item ->> 'moderationNote', '')) > 8000
      or char_length(coalesce(item ->> 'qcCodes', '')) > 8000 then
      raise exception 'KORENI_TEXT_FIELD_TOO_LONG' using errcode = '22023';
    end if;

    if nullif(item ->> 'eventYearFrom', '') is not null then
      if item ->> 'eventYearFrom' !~ '^[1-9][0-9]{0,3}$' then
        raise exception 'KORENI_EVENT_YEAR_FROM_INVALID' using errcode = '22023';
      end if;
      event_year_from := (item ->> 'eventYearFrom')::integer;
      if event_year_from not between 1 and 2200 then
        raise exception 'KORENI_EVENT_YEAR_FROM_INVALID' using errcode = '22023';
      end if;
    else
      event_year_from := null;
    end if;
    if nullif(item ->> 'eventYearTo', '') is not null then
      if item ->> 'eventYearTo' !~ '^[1-9][0-9]{0,3}$' then
        raise exception 'KORENI_EVENT_YEAR_TO_INVALID' using errcode = '22023';
      end if;
      event_year_to := (item ->> 'eventYearTo')::integer;
      if event_year_to not between 1 and 2200 then
        raise exception 'KORENI_EVENT_YEAR_TO_INVALID' using errcode = '22023';
      end if;
    else
      event_year_to := null;
    end if;
    if event_year_to is not null and event_year_from is not null and event_year_to < event_year_from then
      raise exception 'KORENI_EVENT_YEAR_RANGE_INVALID' using errcode = '22023';
    end if;

    date_precision := nullif(btrim(item ->> 'datePrecision'), '');
    if date_precision is not null and date_precision not in (
      'exact', 'month', 'year', 'range', 'approximate', 'before', 'after', 'unknown'
    ) then
      raise exception 'KORENI_DATE_PRECISION_INVALID' using errcode = '22023';
    end if;
    participant_sex := nullif(btrim(item ->> 'sex'), '');
    if participant_sex is not null and participant_sex not in ('male', 'female', 'unknown') then
      raise exception 'KORENI_SEX_INVALID' using errcode = '22023';
    end if;
    event_role_code := nullif(btrim(item ->> 'eventRoleCode'), '');
    event_role_custom := nullif(btrim(item ->> 'eventRoleCustom'), '');
    if event_role_code is null or event_role_code not in (
      'subject', 'newborn', 'baptized', 'groom', 'bride',
      'groom_father', 'groom_mother', 'bride_father', 'bride_mother',
      'deceased', 'resident', 'household_head', 'household_member',
      'military_person', 'migrant', 'godparent', 'godchild', 'father',
      'mother', 'parent', 'child', 'spouse', 'witness', 'pledger',
      'officiant', 'registrar', 'midwife', 'informant', 'owner',
      'commander', 'official', 'priest', 'relative', 'mentioned_person',
      'unspecified', 'other'
    ) then
      raise exception 'KORENI_EVENT_ROLE_INVALID' using errcode = '22023';
    end if;
    if event_role_code = 'other' and char_length(coalesce(event_role_custom, '')) not between 2 and 160 then
      raise exception 'KORENI_EVENT_ROLE_CUSTOM_REQUIRED' using errcode = '22023';
    end if;
    if event_role_code <> 'other' and event_role_custom is not null then
      raise exception 'KORENI_EVENT_ROLE_CUSTOM_UNEXPECTED' using errcode = '22023';
    end if;
    if coalesce(item ->> 'candidateStatus', '') not in ('ready', 'needs_review')
      or coalesce(item ->> 'extractionConfidence', '') not in ('high', 'medium', 'low') then
      raise exception 'KORENI_QUALITY_STATUS_INVALID' using errcode = '22023';
    end if;
    if jsonb_typeof(item -> 'confidenceScore') <> 'number' then
      raise exception 'KORENI_CONFIDENCE_SCORE_INVALID' using errcode = '22023';
    end if;
    confidence_score := (item ->> 'confidenceScore')::numeric;
    if confidence_score < 0 or confidence_score > 1 then
      raise exception 'KORENI_CONFIDENCE_SCORE_INVALID' using errcode = '22023';
    end if;
    if coalesce(item ->> 'duplicateGroupSize', '') !~ '^[1-9][0-9]*$' then
      raise exception 'KORENI_DUPLICATE_GROUP_SIZE_INVALID' using errcode = '22023';
    end if;
    duplicate_group_size := (item ->> 'duplicateGroupSize')::integer;

    payload_sha256 := security_private.zagulyaky_koreni_sha256_v1(item::text);
    select mapped.* into existing_map
    from security_private.zagulyaky_koreni_record_map as mapped
    where mapped.external_record_key = materializer.external_record_key;
    if found then
      select source_checksum into existing_batch_checksum
      from security_private.zagulyaky_koreni_batches
      where id = existing_map.batch_id;
      if existing_batch_checksum is distinct from p_source_checksum
        or existing_map.candidate_payload_sha256 is distinct from payload_sha256
        or existing_map.upstream_table_id is distinct from upstream_table_id
        or existing_map.upstream_row_number is distinct from upstream_row_number
        or existing_map.upstream_row_sha256 is distinct from upstream_row_sha256 then
        raise exception 'KORENI_IDEMPOTENCY_CONFLICT' using errcode = '40001';
      end if;
      unchanged_count := unchanged_count + 1;
    else
      would_create_count := would_create_count + 1;
    end if;

    select source_row.* into existing_source
    from security_private.zagulyaky_koreni_source_rows as source_row
    where source_row.upstream_table_id = materializer.upstream_table_id
      and source_row.upstream_row_number = materializer.upstream_row_number;
    if found and (
      existing_source.upstream_row_sha256 is distinct from upstream_row_sha256
      or existing_source.source_url is distinct from source_url
    ) then
      raise exception 'KORENI_SOURCE_ROW_CONFLICT' using errcode = '40001';
    end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object(
      'dryRun', true,
      'validated', item_count,
      'wouldCreate', would_create_count,
      'unchanged', unchanged_count
    );
  end if;

  select * into batch_row
  from security_private.zagulyaky_koreni_batches
  where source_checksum = p_source_checksum
  for update;
  if found then
    if batch_row.upstream_commit_sha is distinct from p_upstream_commit_sha
      or batch_row.transform_version is distinct from btrim(p_transform_version)
      or batch_row.expected_record_count is distinct from p_expected_record_count
      or batch_row.actor_id is distinct from p_actor_id then
      raise exception 'KORENI_BATCH_CONTRACT_CONFLICT' using errcode = '40001';
    end if;
  else
    insert into security_private.zagulyaky_koreni_batches(
      source_file_name, source_checksum, upstream_commit_sha, transform_version,
      expected_record_count, actor_id
    ) values (
      btrim(p_source_file_name), p_source_checksum, p_upstream_commit_sha,
      btrim(p_transform_version), p_expected_record_count, p_actor_id
    ) returning * into batch_row;
  end if;

  for item in select value from jsonb_array_elements(p_items) loop
    external_record_key := btrim(item ->> 'externalRecordKey');
    event_group_key := nullif(btrim(item ->> 'eventGroupKey'), '');
    upstream_table_id := btrim(item ->> 'upstreamTableId');
    upstream_row_number := (item ->> 'upstreamRowNumber')::integer;
    upstream_row_sha256 := btrim(item ->> 'upstreamRowSha256');
    source_url := btrim(item ->> 'sourceUrl');
    payload_sha256 := security_private.zagulyaky_koreni_sha256_v1(item::text);

    select mapped.* into existing_map
    from security_private.zagulyaky_koreni_record_map as mapped
    where mapped.external_record_key = materializer.external_record_key
    for update;
    if found then
      continue;
    end if;

    select source_row.* into existing_source
    from security_private.zagulyaky_koreni_source_rows as source_row
    where source_row.upstream_table_id = materializer.upstream_table_id
      and source_row.upstream_row_number = materializer.upstream_row_number
    for update;
    if found then
      source_id := existing_source.source_id;
    else
      insert into public.zagulyaky_sources(
        source_type, title, archive_name, page_from, citation,
        source_url, source_platform, external_id, access_date,
        permission_status, metadata, created_by
      ) values (
        'database',
        left(coalesce(nullif(btrim(item ->> 'sourceTitle'), ''), 'Koreni.org.ua'), 2000),
        nullif(btrim(item ->> 'institutionName'), ''),
        nullif(btrim(item ->> 'pageLabel'), ''),
        concat_ws(' · ',
          nullif(btrim(item ->> 'archiveReference'), ''),
          'Koreni.org.ua — ODbL 1.0',
          case when nullif(btrim(item ->> 'upstreamIndexerName'), '') is not null
            then 'Індексатор: ' || btrim(item ->> 'upstreamIndexerName') end,
          'Таблиця: ' || upstream_table_id,
          'Рядок: ' || upstream_row_number::text
        ),
        source_url,
        'koreni',
        coalesce(nullif(btrim(item ->> 'sourceExternalId'), ''),
          upstream_table_id || '-' || upstream_row_number::text),
        current_date,
        'permission_granted',
        jsonb_strip_nulls(jsonb_build_object(
          'dataset', 'koreni',
          'license', 'ODbL-1.0',
          'licenseUrl', 'https://koreni.org.ua/license/',
          'upstreamCommitSha', p_upstream_commit_sha,
          'upstreamTableId', upstream_table_id,
          'upstreamRowNumber', upstream_row_number,
          'upstreamRowSha256', upstream_row_sha256,
          'upstreamIndexerName', nullif(btrim(item ->> 'upstreamIndexerName'), ''),
          'transformVersion', p_transform_version
        )),
        p_actor_id
      ) returning id into source_id;

      insert into security_private.zagulyaky_koreni_source_rows(
        upstream_table_id, upstream_row_number, upstream_row_sha256,
        source_id, source_url, first_batch_id
      ) values (
        upstream_table_id, upstream_row_number, upstream_row_sha256,
        source_id, source_url, batch_row.id
      );
    end if;

    record_title := left(coalesce(
      nullif(btrim(item ->> 'normalizedUkFullName'), ''),
      nullif(btrim(item ->> 'title'), ''),
      btrim(item ->> 'originalFullName')
    ), 300);
    event_year_from := nullif(item ->> 'eventYearFrom', '')::integer;
    event_year_to := nullif(item ->> 'eventYearTo', '')::integer;
    date_precision := nullif(btrim(item ->> 'datePrecision'), '');
    participant_sex := nullif(btrim(item ->> 'sex'), '');
    event_role_code := btrim(item ->> 'eventRoleCode');
    event_role_custom := case when event_role_code = 'other'
      then nullif(btrim(item ->> 'eventRoleCustom'), '') else null end;
    record_slug := 'koreni-' || left(
      security_private.zagulyaky_koreni_sha256_v1(external_record_key), 40
    );

    insert into public.zagulyaky_records(
      kind, status, verification_status, privacy_status,
      title, summary, original_text, normalized_text, original_language,
      event_type, event_date_text, event_year_from, event_year_to, date_precision,
      source_location_text, source_location_normalized,
      found_location_text, found_location_normalized,
      classification_reason, payload, possible_living_person,
      submission_terms_version, rights_confirmed_at,
      public_attribution, public_attribution_name,
      created_by, submitted_at
    ) values (
      'person', 'pending_review', 'unverified', 'pending',
      record_title,
      left(btrim(item ->> 'classificationReason'), 4000),
      item ->> 'originalText',
      coalesce(item ->> 'normalizedTextUk', ''),
      nullif(btrim(item ->> 'originalLanguage'), ''),
      nullif(btrim(item ->> 'eventType'), ''),
      nullif(btrim(item ->> 'eventDateText'), ''),
      event_year_from, event_year_to, date_precision,
      btrim(item ->> 'originText'), btrim(item ->> 'originText'),
      btrim(item ->> 'foundText'), btrim(item ->> 'foundText'),
      btrim(item ->> 'classificationReason'),
      jsonb_build_object(
        'originalName', item ->> 'originalFullName',
        'normalizedNameUk', nullif(btrim(item ->> 'normalizedUkFullName'), ''),
        'gender', participant_sex,
        'eventRoleCode', event_role_code,
        'eventRoleCustomText', event_role_custom,
        'recordTypes', jsonb_build_array(item ->> 'eventType'),
        'koreni', jsonb_strip_nulls(jsonb_build_object(
          'externalRecordKey', external_record_key,
          'eventGroupKey', event_group_key,
          'sourceExternalId', nullif(btrim(item ->> 'sourceExternalId'), ''),
          'candidateStatus', item ->> 'candidateStatus',
          'confidenceLevel', item ->> 'extractionConfidence',
          'confidenceScore', item -> 'confidenceScore',
          'qcCodes', nullif(item ->> 'qcCodes', ''),
          'duplicateGroupId', nullif(item ->> 'duplicateGroupId', ''),
          'duplicateGroupSize', item -> 'duplicateGroupSize',
          'upstreamTableId', upstream_table_id,
          'upstreamRowNumber', upstream_row_number,
          'upstreamRowSha256', upstream_row_sha256,
          'upstreamCommitSha', p_upstream_commit_sha,
          'transformVersion', p_transform_version,
          'candidateTransformVersion', nullif(btrim(item ->> 'candidateTransformVersion'), ''),
          'sourceEventDateText', nullif(btrim(item ->> 'sourceEventDateText'), ''),
          'sourceEventYearFrom', nullif(item ->> 'sourceEventYearFrom', '')::integer,
          'sourceEventYearTo', nullif(item ->> 'sourceEventYearTo', '')::integer,
          'license', 'ODbL-1.0'
        ))
      ),
      false,
      1,
      now(),
      true,
      left(actor_name, 120),
      p_actor_id,
      now()
    ) returning id into record_id;

    insert into public.zagulyaky_participants(
      record_id, role, event_role_code, event_role_custom,
      original_full_name, normalized_uk_full_name, sex,
      residence_text, origin_text, notes, sort_order
    ) values (
      record_id,
      'subject',
      event_role_code,
      event_role_custom,
      btrim(item ->> 'originalFullName'),
      coalesce(btrim(item ->> 'normalizedUkFullName'), ''),
      participant_sex,
      case when item ->> 'eventType' in ('residence', 'census', 'migration')
        then btrim(item ->> 'foundText') end,
      btrim(item ->> 'originText'),
      '',
      0
    );

    insert into public.zagulyaky_record_sources(record_id, source_id, is_primary)
    values (record_id, source_id, true);

    update public.zagulyaky_records
    set status = 'published',
        privacy_status = 'cleared',
        public_slug = record_slug,
        published_at = now(),
        moderated_by = p_actor_id,
        moderation_note = nullif(left(coalesce(item ->> 'moderationNote', ''), 8000), '')
    where id = record_id;

    insert into public.zagulyaky_moderation_actions(
      record_id, actor_id, action, from_status, to_status, note, metadata
    ) values (
      record_id,
      p_actor_id,
      'publish',
      'pending_review',
      'published',
      'Опубліковано з відкритої бази Koreni.org.ua за ліцензією ODbL 1.0.',
      jsonb_build_object(
        'provider', 'koreni',
        'sourceChecksum', p_source_checksum,
        'externalRecordKey', external_record_key
      )
    );

    insert into security_private.zagulyaky_koreni_record_map(
      external_record_key, batch_id, upstream_table_id, upstream_row_number,
      upstream_row_sha256, record_id, candidate_payload_sha256, event_group_key
    ) values (
      external_record_key, batch_row.id, upstream_table_id, upstream_row_number,
      upstream_row_sha256, record_id, payload_sha256, event_group_key
    );

    created_count := created_count + 1;
  end loop;

  select count(*)::integer into batch_count
  from security_private.zagulyaky_koreni_record_map
  where batch_id = batch_row.id;
  if batch_count > batch_row.expected_record_count then
    raise exception 'KORENI_BATCH_COUNT_EXCEEDED' using errcode = '23514';
  end if;

  update security_private.zagulyaky_koreni_batches
  set materialized_record_count = batch_count,
      status = case when batch_count = expected_record_count then 'completed' else 'running' end,
      completed_at = case when batch_count = expected_record_count then coalesce(completed_at, now()) else null end,
      updated_at = now()
  where id = batch_row.id
  returning * into batch_row;

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    p_actor_id,
    'zagulyaky.koreni.materialize',
    'zagulyaky_koreni_batch',
    batch_row.id::text,
    'success',
    jsonb_build_object(
      'created', created_count,
      'unchanged', unchanged_count,
      'materialized', batch_row.materialized_record_count,
      'expected', batch_row.expected_record_count,
      'status', batch_row.status
    )
  );

  return jsonb_build_object(
    'dryRun', false,
    'batchId', batch_row.id,
    'created', created_count,
    'unchanged', unchanged_count,
    'materialized', batch_row.materialized_record_count,
    'expected', batch_row.expected_record_count,
    'status', batch_row.status
  );
end;
$function$;

revoke all on function security_private.materialize_koreni_zagulyaky_v1(
  uuid, text, text, text, text, integer, jsonb, boolean
) from public, anon, authenticated, service_role;
grant execute on function security_private.materialize_koreni_zagulyaky_v1(
  uuid, text, text, text, text, integer, jsonb, boolean
) to service_role;

comment on table security_private.zagulyaky_koreni_batches is
  'Service-only receipts for the one-way Koreni open-data materialization; not a staging queue.';
comment on table security_private.zagulyaky_koreni_source_rows is
  'Trusted Koreni source-row to catalogue-source provenance used for safe idempotency.';
comment on table security_private.zagulyaky_koreni_record_map is
  'Stable external Koreni candidate key to published Zagulyaka record mapping.';
comment on function security_private.materialize_koreni_zagulyaky_v1(
  uuid, text, text, text, text, integer, jsonb, boolean
) is 'Service-only, chunked and idempotent Koreni materializer. Dry-run performs no writes.';

commit;
