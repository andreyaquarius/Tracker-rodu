begin;

-- Automated structuring is deliberately a private, review-first workflow.
-- It accepts a completed Stage 0 batch, lets a trusted worker read a single
-- item at a time, and persists only bounded structured proposals.  It never
-- exposes an ingestion item through the catalogue or creates a publishable
-- record, source URL, attachment, or merge decision.

create table if not exists public.zagulyaky_structuring_runs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_ingestion_batches(id) on delete restrict,
  requested_by uuid references public.profiles(user_id) on delete set null,
  parser_version text not null check (parser_version ~ '^[A-Za-z0-9._:-]{1,120}$'),
  provider text not null check (provider ~ '^[A-Za-z0-9._:-]{1,80}$'),
  model text not null check (model ~ '^[A-Za-z0-9._:=-]{1,160}$'),
  contract_version smallint not null default 1 check (contract_version = 1),
  configuration_fingerprint text not null check (configuration_fingerprint ~ '^[0-9a-f]{64}$'),
  batch_source_checksum text not null check (batch_source_checksum ~ '^[0-9a-f]{64}$'),
  consent_granted boolean not null check (consent_granted),
  consent_version text not null check (char_length(consent_version) between 2 and 100),
  consented_by uuid not null references public.profiles(user_id) on delete restrict,
  consented_at timestamptz not null default now(),
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled'
  )),
  requested_item_limit integer not null default 50 check (requested_item_limit between 1 and 5000),
  eligible_item_count integer not null default 0 check (eligible_item_count >= 0),
  selected_item_count integer not null default 0 check (selected_item_count >= 0),
  excluded_quarantined_count integer not null default 0 check (excluded_quarantined_count >= 0),
  excluded_ocr_count integer not null default 0 check (excluded_ocr_count >= 0),
  excluded_source_refetch_count integer not null default 0 check (excluded_source_refetch_count >= 0),
  excluded_source_incomplete_count integer not null default 0 check (excluded_source_incomplete_count >= 0),
  excluded_truncated_count integer not null default 0 check (excluded_truncated_count >= 0),
  excluded_oversized_count integer not null default 0 check (excluded_oversized_count >= 0),
  excluded_text_missing_count integer not null default 0 check (excluded_text_missing_count >= 0),
  queued_task_count integer not null default 0 check (queued_task_count >= 0),
  processing_task_count integer not null default 0 check (processing_task_count >= 0),
  succeeded_task_count integer not null default 0 check (succeeded_task_count >= 0),
  failed_task_count integer not null default 0 check (failed_task_count >= 0),
  zero_candidate_task_count integer not null default 0 check (zero_candidate_task_count >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  materialized_candidate_count integer not null default 0 check (materialized_candidate_count >= 0),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (batch_id, parser_version, provider, model, contract_version)
);

create index if not exists zagulyaky_structuring_runs_batch_idx
  on public.zagulyaky_structuring_runs(batch_id, created_at desc);
create index if not exists zagulyaky_structuring_runs_status_idx
  on public.zagulyaky_structuring_runs(status, updated_at desc);

create table if not exists public.zagulyaky_structuring_tasks (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.zagulyaky_structuring_runs(id) on delete cascade,
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete restrict,
  source_item_index integer not null check (source_item_index >= 0),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  input_character_count integer not null check (input_character_count between 1 and 200000),
  status text not null default 'queued' check (status in (
    'queued', 'processing', 'retry', 'succeeded', 'failed', 'cancelled'
  )),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  claimed_by text check (claimed_by is null or claimed_by ~ '^[A-Za-z0-9._:-]{1,120}$'),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  result_candidate_count integer not null default 0 check (result_candidate_count between 0 and 20),
  result_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(result_summary) = 'object'),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{3,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (run_id, item_id)
);

create index if not exists zagulyaky_structuring_tasks_queue_idx
  on public.zagulyaky_structuring_tasks(status, next_attempt_at, source_item_index, id)
  where status in ('queued', 'retry');
create index if not exists zagulyaky_structuring_tasks_run_idx
  on public.zagulyaky_structuring_tasks(run_id, source_item_index, id);
create index if not exists zagulyaky_structuring_tasks_lease_idx
  on public.zagulyaky_structuring_tasks(lease_expires_at)
  where status = 'processing';

create table if not exists public.zagulyaky_ingestion_structured_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.zagulyaky_structuring_runs(id) on delete cascade,
  task_id uuid not null references public.zagulyaky_structuring_tasks(id) on delete cascade,
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete restrict,
  source_item_index integer not null check (source_item_index >= 0),
  parser_version text not null check (parser_version ~ '^[A-Za-z0-9._:-]{1,120}$'),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_key text not null check (candidate_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('person', 'document')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  status text not null default 'proposed' check (status in (
    'proposed', 'materialized', 'rejected', 'superseded'
  )),
  privacy_review_required boolean not null default true check (privacy_review_required),
  -- This contains only allowlisted, bounded structured fields.  It has no
  -- source post text/payload, author, Facebook URL, or attachment metadata.
  candidate_data jsonb not null check (jsonb_typeof(candidate_data) = 'object'),
  -- Evidence excerpts are verified on ingestion then discarded.  The stored
  -- locations are offsets only, so list/detail projections cannot leak text.
  evidence_spans jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_spans) = 'array'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  materialized_record_id uuid references public.zagulyaky_records(id) on delete restrict,
  materialized_by uuid references public.profiles(user_id) on delete set null,
  materialized_at timestamptz,
  materialization_error_code text check (materialization_error_code is null or materialization_error_code ~ '^[A-Z0-9_]{3,100}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'materialized' and materialized_record_id is not null and materialized_at is not null)
    or (status <> 'materialized' and materialized_record_id is null)
  ),
  unique (run_id, item_id, input_fingerprint, candidate_key)
);

create index if not exists zagulyaky_structured_candidates_run_status_idx
  on public.zagulyaky_ingestion_structured_candidates(run_id, status, source_item_index, created_at);
create index if not exists zagulyaky_structured_candidates_task_idx
  on public.zagulyaky_ingestion_structured_candidates(task_id, status, created_at);
create index if not exists zagulyaky_structured_candidates_record_idx
  on public.zagulyaky_ingestion_structured_candidates(materialized_record_id)
  where materialized_record_id is not null;

-- These tables are an internal staging layer.  They deliberately have no
-- browser policies and no table grants; all access is through narrow RPCs.
alter table public.zagulyaky_structuring_runs enable row level security;
alter table public.zagulyaky_structuring_tasks enable row level security;
alter table public.zagulyaky_ingestion_structured_candidates enable row level security;

revoke all on table public.zagulyaky_structuring_runs from public, anon, authenticated;
revoke all on table public.zagulyaky_structuring_tasks from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_structured_candidates from public, anon, authenticated;
grant all on table public.zagulyaky_structuring_runs to service_role;
grant all on table public.zagulyaky_structuring_tasks to service_role;
grant all on table public.zagulyaky_ingestion_structured_candidates to service_role;

-- The original importer accepted only the browser's candidateYears field.
-- The current Facebook export stores those same hints as rawPayload.years
-- (strings), so use that source only when the explicit field is empty.  This
-- is a provenance-only repair; it does not infer facts or make records.
create or replace function security_private.zagulyaky_import_candidate_years_v1(
  p_item jsonb
)
returns integer[]
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with years_source as (
    select case
      when jsonb_typeof(p_item -> 'candidateYears') = 'array'
        and jsonb_array_length(p_item -> 'candidateYears') > 0
        then p_item -> 'candidateYears'
      when jsonb_typeof(p_item -> 'rawPayload' -> 'years') = 'array'
        then p_item -> 'rawPayload' -> 'years'
      else '[]'::jsonb
    end as values_json
  )
  select coalesce(
    array_agg(year_value order by ordinality)
      filter (where year_value between 1 and 2200),
    '{}'::integer[]
  )
  from years_source,
  lateral (
    select ordinality,
      case when value ~ '^[0-9]{1,4}$' then value::integer else null end as year_value
    from jsonb_array_elements_text(years_source.values_json)
      with ordinality candidate_values(value, ordinality)
  ) candidate
$function$;

update public.zagulyaky_ingestion_items item_row
set candidate_years = security_private.zagulyaky_import_candidate_years_v1(
  jsonb_build_object(
    'candidateYears', to_jsonb(item_row.candidate_years),
    'rawPayload', item_row.raw_payload
  )
),
updated_at = now()
where item_row.candidate_years is distinct from security_private.zagulyaky_import_candidate_years_v1(
  jsonb_build_object(
    'candidateYears', to_jsonb(item_row.candidate_years),
    'rawPayload', item_row.raw_payload
  )
);

create or replace function security_private.zagulyaky_structuring_sha256_v1(
  p_value text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  fingerprint text;
begin
  if p_value is null then
    raise exception 'STRUCTURING_FINGERPRINT_INPUT_REQUIRED' using errcode = '22023';
  end if;
  if to_regprocedure('extensions.digest(bytea,text)') is not null then
    execute 'select encode(extensions.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into fingerprint using p_value;
  elsif to_regprocedure('public.digest(bytea,text)') is not null then
    execute 'select encode(public.digest(convert_to($1, ''UTF8''), ''sha256''), ''hex'')'
      into fingerprint using p_value;
  else
    raise exception 'PGCRYPTO_DIGEST_REQUIRED' using errcode = '55000';
  end if;
  return fingerprint;
end;
$function$;

create or replace function security_private.zagulyaky_structuring_safe_text_v1(
  p_value jsonb,
  p_field text,
  p_max_length integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  normalized text;
begin
  if p_max_length < 1 then
    raise exception 'STRUCTURING_INVALID_TEXT_LIMIT' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    if p_required then
      raise exception 'STRUCTURING_%_REQUIRED', upper(p_field) using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    raise exception 'STRUCTURING_%_MUST_BE_TEXT', upper(p_field) using errcode = '22023';
  end if;
  normalized := btrim(p_value #>> '{}');
  if normalized = '' then
    if p_required then
      raise exception 'STRUCTURING_%_REQUIRED', upper(p_field) using errcode = '22023';
    end if;
    return null;
  end if;
  if char_length(normalized) > p_max_length then
    raise exception 'STRUCTURING_%_TOO_LONG', upper(p_field) using errcode = '22023';
  end if;
  -- A structured proposal has no legitimate URL field.  Rejecting URLs here
  -- prevents source/Facebook/CDN material from being smuggled into a title,
  -- classification explanation, warning, or discovery location.
  if normalized ~* '(https?://|www[.]|facebook[.]com|fbcdn[.])' then
    raise exception 'STRUCTURING_SOURCE_URL_FORBIDDEN' using errcode = '22023';
  end if;
  return normalized;
end;
$function$;

create or replace function security_private.zagulyaky_structuring_evidence_spans_v1(
  p_evidence jsonb,
  p_raw_text text,
  p_scope text,
  p_maximum integer
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  evidence_item jsonb;
  start_offset integer;
  end_offset integer;
  excerpt text;
  result jsonb := '[]'::jsonb;
  item_count integer := 0;
begin
  if p_evidence is null or jsonb_typeof(p_evidence) = 'null' then
    return result;
  end if;
  if jsonb_typeof(p_evidence) <> 'array' then
    raise exception 'STRUCTURING_EVIDENCE_MUST_BE_ARRAY' using errcode = '22023';
  end if;
  if jsonb_array_length(p_evidence) > p_maximum then
    raise exception 'STRUCTURING_EVIDENCE_LIMIT_EXCEEDED' using errcode = '54000';
  end if;
  for evidence_item in select value from jsonb_array_elements(p_evidence) loop
    item_count := item_count + 1;
    if jsonb_typeof(evidence_item) <> 'object'
      or coalesce(evidence_item ->> 'start', '') !~ '^[0-9]{1,6}$'
      or coalesce(evidence_item ->> 'end', '') !~ '^[0-9]{1,6}$'
      or jsonb_typeof(evidence_item -> 'excerpt') <> 'string' then
      raise exception 'STRUCTURING_INVALID_EVIDENCE' using errcode = '22023';
    end if;
    start_offset := (evidence_item ->> 'start')::integer;
    end_offset := (evidence_item ->> 'end')::integer;
    excerpt := evidence_item ->> 'excerpt';
    if end_offset <= start_offset or end_offset > char_length(p_raw_text)
      or char_length(excerpt) > 500
      or substring(p_raw_text from start_offset + 1 for end_offset - start_offset) is distinct from excerpt then
      raise exception 'STRUCTURING_EVIDENCE_DOES_NOT_MATCH_INPUT' using errcode = '22023';
    end if;
    result := result || jsonb_build_array(jsonb_build_object(
      'scope', p_scope, 'start', start_offset, 'end', end_offset
    ));
  end loop;
  return result;
end;
$function$;

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
    -- This is an unverified model signal for review triage only.  If true,
    -- materialization conservatively carries it into the private draft as
    -- possible_living_person=true plus privacy_status=requires_consent; it
    -- never makes a record public or clears a living-person review.
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
    -- Stability deliberately excludes confidence/warnings/evidence.  A retry
    -- can improve those non-identity fields without creating a second draft.
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

create or replace function security_private.zagulyaky_structuring_refresh_run_v1(
  p_run_id uuid
)
returns public.zagulyaky_structuring_runs
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  run_row public.zagulyaky_structuring_runs;
  task_total integer := 0;
  queued_total integer := 0;
  processing_total integer := 0;
  succeeded_total integer := 0;
  failed_total integer := 0;
  zero_candidate_total integer := 0;
  candidate_total integer := 0;
  materialized_total integer := 0;
  next_status text;
begin
  select * into run_row from public.zagulyaky_structuring_runs where id = p_run_id for update;
  if not found then
    raise exception 'STRUCTURING_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  select
    count(*),
    count(*) filter (where status in ('queued', 'retry')),
    count(*) filter (where status = 'processing'),
    count(*) filter (where status = 'succeeded'),
    count(*) filter (where status = 'failed'),
    count(*) filter (where status = 'succeeded' and result_candidate_count = 0)
  into task_total, queued_total, processing_total, succeeded_total, failed_total, zero_candidate_total
  from public.zagulyaky_structuring_tasks where run_id = p_run_id;
  select count(*), count(*) filter (where status = 'materialized')
  into candidate_total, materialized_total
  from public.zagulyaky_ingestion_structured_candidates where run_id = p_run_id;
  next_status := case
    when run_row.status = 'cancelled' then 'cancelled'
    when processing_total > 0 then 'processing'
    when queued_total > 0 then 'queued'
    when task_total = 0 then 'queued'
    when failed_total > 0 then 'completed_with_errors'
    else 'completed'
  end;
  update public.zagulyaky_structuring_runs
  set status = next_status,
      selected_item_count = task_total,
      queued_task_count = queued_total,
      processing_task_count = processing_total,
      succeeded_task_count = succeeded_total,
      failed_task_count = failed_total,
      zero_candidate_task_count = zero_candidate_total,
      candidate_count = candidate_total,
      materialized_candidate_count = materialized_total,
      completed_at = case when next_status in ('completed', 'completed_with_errors') then coalesce(completed_at, now()) else null end,
      updated_at = now()
  where id = p_run_id
  returning * into run_row;
  return run_row;
end;
$function$;

create or replace function security_private.zagulyaky_structuring_run_projection_v1(
  p_run_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select jsonb_build_object(
    'runId', run_row.id,
    'batchId', run_row.batch_id,
    'status', run_row.status,
    'parserVersion', run_row.parser_version,
    'provider', run_row.provider,
    'model', run_row.model,
    'explicitConsent', run_row.consent_granted,
    'consentVersion', run_row.consent_version,
    'consentedAt', run_row.consented_at,
    'requestedItemLimit', run_row.requested_item_limit,
    'eligibleItemCount', run_row.eligible_item_count,
    'selectedItemCount', run_row.selected_item_count,
    'excludedQuarantinedCount', run_row.excluded_quarantined_count,
    'excludedOcrCount', run_row.excluded_ocr_count,
    'excludedSourceRefetchCount', run_row.excluded_source_refetch_count,
    'excludedSourceIncompleteCount', run_row.excluded_source_incomplete_count,
    'excludedTruncatedCount', run_row.excluded_truncated_count,
    'excludedOversizedCount', run_row.excluded_oversized_count,
    'excludedTextMissingCount', run_row.excluded_text_missing_count,
    'queuedCount', run_row.queued_task_count,
    'processingCount', run_row.processing_task_count,
    'succeededCount', run_row.succeeded_task_count,
    'failedCount', run_row.failed_task_count,
    'zeroCandidateTaskCount', run_row.zero_candidate_task_count,
    'candidateCount', run_row.candidate_count,
    'materializedCandidateCount', run_row.materialized_candidate_count,
    'materializedCount', run_row.materialized_candidate_count,
    'personCandidateCount', (
      select count(*) from public.zagulyaky_ingestion_structured_candidates candidate_row
      where candidate_row.run_id = run_row.id and candidate_row.kind = 'person'
    ),
    'documentCandidateCount', (
      select count(*) from public.zagulyaky_ingestion_structured_candidates candidate_row
      where candidate_row.run_id = run_row.id and candidate_row.kind = 'document'
    ),
    'lastErrorCode', run_row.last_error_code,
    'createdAt', run_row.created_at,
    'updatedAt', run_row.updated_at,
    'completedAt', run_row.completed_at
  )
  from public.zagulyaky_structuring_runs run_row
  where run_row.id = p_run_id
$function$;

create or replace function security_private.admin_start_zagulyaky_structuring_run_v1(
  p_batch_id uuid,
  p_parser_version text,
  p_provider text,
  p_model text,
  p_explicit_consent boolean,
  p_consent_version text,
  p_item_limit integer default 50,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  batch_row public.zagulyaky_ingestion_batches;
  run_row public.zagulyaky_structuring_runs;
  target_limit integer;
  config_fingerprint text;
  eligible_count integer := 0;
  quarantined_count integer := 0;
  ocr_count integer := 0;
  refetch_count integer := 0;
  incomplete_count integer := 0;
  truncated_count integer := 0;
  oversized_count integer := 0;
  missing_text_count integer := 0;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_explicit_consent is not true then
    raise exception 'STRUCTURING_CONSENT_REQUIRED' using errcode = '42501';
  end if;
  if p_item_limit not between 1 and 5000 or p_max_attempts not between 1 and 10
    or p_parser_version !~ '^[A-Za-z0-9._:-]{1,120}$'
    or p_provider !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_model !~ '^[A-Za-z0-9._:=-]{1,160}$'
    or char_length(btrim(coalesce(p_consent_version, ''))) not between 2 and 100 then
    raise exception 'STRUCTURING_INVALID_START_REQUEST' using errcode = '22023';
  end if;
  select * into batch_row from public.zagulyaky_ingestion_batches where id = p_batch_id for share;
  if not found then raise exception 'INGESTION_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  if batch_row.import_mode <> 'commit' or batch_row.status not in ('completed', 'completed_with_errors') then
    raise exception 'STRUCTURING_BATCH_NOT_READY' using errcode = '55000';
  end if;
  config_fingerprint := security_private.zagulyaky_structuring_sha256_v1(
    jsonb_build_object('contractVersion', 1, 'parserVersion', p_parser_version,
      'provider', p_provider, 'model', p_model)::text
  );
  insert into public.zagulyaky_structuring_runs(
    batch_id, requested_by, parser_version, provider, model, configuration_fingerprint,
    batch_source_checksum, consent_granted, consent_version, consented_by, requested_item_limit
  ) values (
    p_batch_id, current_user_id, p_parser_version, p_provider, p_model, config_fingerprint,
    batch_row.source_checksum, true, btrim(p_consent_version), current_user_id, p_item_limit
  ) on conflict (batch_id, parser_version, provider, model, contract_version) do update
  set requested_item_limit = greatest(public.zagulyaky_structuring_runs.requested_item_limit, excluded.requested_item_limit),
      updated_at = now()
  returning * into run_row;
  target_limit := run_row.requested_item_limit;

  select
    count(*) filter (where not item_row.quarantined and item_row.stage_status <> 'quarantined'
      and nullif(btrim(item_row.raw_text), '') is not null
      and not item_row.requires_ocr and not item_row.requires_source_refetch
      and not item_row.source_incomplete and not item_row.text_truncated
      and char_length(item_row.raw_text) <= 12000
      and item_row.stage_status in ('staged', 'structured')),
    count(*) filter (where item_row.quarantined or item_row.stage_status = 'quarantined'),
    count(*) filter (where item_row.requires_ocr),
    count(*) filter (where item_row.requires_source_refetch),
    count(*) filter (where item_row.source_incomplete),
    count(*) filter (where item_row.text_truncated),
    count(*) filter (where nullif(btrim(item_row.raw_text), '') is not null and char_length(item_row.raw_text) > 12000),
    count(*) filter (where nullif(btrim(item_row.raw_text), '') is null)
  into eligible_count, quarantined_count, ocr_count, refetch_count, incomplete_count, truncated_count, oversized_count, missing_text_count
  from public.zagulyaky_ingestion_batch_items membership
  join public.zagulyaky_ingestion_items item_row on item_row.id = membership.item_id
  where membership.batch_id = p_batch_id;

  with eligible as (
    select item_row.id, membership.source_item_index, item_row.raw_text,
      row_number() over (order by membership.source_item_index, item_row.id) as position
    from public.zagulyaky_ingestion_batch_items membership
    join public.zagulyaky_ingestion_items item_row on item_row.id = membership.item_id
    where membership.batch_id = p_batch_id
      and not item_row.quarantined and item_row.stage_status <> 'quarantined'
      and nullif(btrim(item_row.raw_text), '') is not null
      and not item_row.requires_ocr and not item_row.requires_source_refetch
      and not item_row.source_incomplete and not item_row.text_truncated
      and char_length(item_row.raw_text) <= 12000
      and item_row.stage_status in ('staged', 'structured')
  )
  insert into public.zagulyaky_structuring_tasks(
    run_id, item_id, source_item_index, input_fingerprint, input_character_count, max_attempts
  )
  select run_row.id, eligible.id, eligible.source_item_index,
    security_private.zagulyaky_structuring_sha256_v1(eligible.raw_text),
    char_length(eligible.raw_text), p_max_attempts
  from eligible
  where eligible.position <= target_limit
  on conflict (run_id, item_id) do update
  set max_attempts = greatest(public.zagulyaky_structuring_tasks.max_attempts, excluded.max_attempts),
      updated_at = now();

  update public.zagulyaky_structuring_runs
  set eligible_item_count = eligible_count,
      excluded_quarantined_count = quarantined_count,
      excluded_ocr_count = ocr_count,
      excluded_source_refetch_count = refetch_count,
      excluded_source_incomplete_count = incomplete_count,
      excluded_truncated_count = truncated_count,
      excluded_oversized_count = oversized_count,
      excluded_text_missing_count = missing_text_count,
      updated_at = now()
  where id = run_row.id;
  perform security_private.zagulyaky_structuring_refresh_run_v1(run_row.id);

  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id, 'zagulyaky.structuring.start', 'zagulyaky_structuring_run', run_row.id::text,
    'success', jsonb_build_object('batchId', p_batch_id, 'itemLimit', target_limit,
      'parserVersion', p_parser_version, 'provider', p_provider, 'model', p_model)
  );
  return security_private.zagulyaky_structuring_run_projection_v1(run_row.id);
end;
$function$;

create or replace function public.admin_start_zagulyaky_structuring_run_v1(
  p_batch_id uuid,
  p_parser_version text,
  p_provider text,
  p_model text,
  p_explicit_consent boolean,
  p_consent_version text,
  p_item_limit integer default 50,
  p_max_attempts integer default 3
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_start_zagulyaky_structuring_run_v1($1,$2,$3,$4,$5,$6,$7,$8)
$function$;

create or replace function security_private.admin_get_zagulyaky_structuring_run_v1(
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.zagulyaky_structuring_runs where id = p_run_id) then
    raise exception 'STRUCTURING_RUN_NOT_FOUND' using errcode = 'P0002';
  end if;
  return security_private.zagulyaky_structuring_run_projection_v1(p_run_id);
end;
$function$;

create or replace function public.admin_get_zagulyaky_structuring_run_v1(p_run_id uuid)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.admin_get_zagulyaky_structuring_run_v1($1)
$function$;

create or replace function security_private.admin_list_zagulyaky_structuring_runs_v1(
  p_batch_id uuid default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100 or p_offset < 0
    or (p_status is not null and p_status not in ('queued','processing','completed','completed_with_errors','failed','cancelled')) then
    raise exception 'STRUCTURING_INVALID_PAGINATION' using errcode = '22023';
  end if;
  with filtered as (
    select * from public.zagulyaky_structuring_runs
    where (p_batch_id is null or batch_id = p_batch_id)
      and (p_status is null or status = p_status)
  ), page as (
    select filtered.*, count(*) over () as full_total
    from filtered
    order by created_at desc, id desc
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(security_private.zagulyaky_structuring_run_projection_v1(page.id)
      order by page.created_at desc, page.id desc), '[]'::jsonb),
    'total', (select count(*) from filtered)
  ) into result
  from page;
  return coalesce(result, jsonb_build_object('items', '[]'::jsonb, 'total', 0));
end;
$function$;

create or replace function public.admin_list_zagulyaky_structuring_runs_v1(
  p_batch_id uuid default null,
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.admin_list_zagulyaky_structuring_runs_v1($1,$2,$3,$4)
$function$;

create or replace function security_private.service_claim_zagulyaky_structuring_task_v1(
  p_run_id uuid default null,
  p_worker_id text default 'zagulyaky-structure',
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  task_row public.zagulyaky_structuring_tasks;
  claimed_task public.zagulyaky_structuring_tasks;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_lease_seconds not between 30 and 900
    or p_worker_id !~ '^[A-Za-z0-9._:-]{1,120}$' then
    raise exception 'STRUCTURING_INVALID_CLAIM_REQUEST' using errcode = '22023';
  end if;
  for task_row in
    select * from public.zagulyaky_structuring_tasks
    where status = 'processing' and lease_expires_at < now()
      and (p_run_id is null or run_id = p_run_id)
    for update skip locked
  loop
    update public.zagulyaky_structuring_tasks
    set status = case when task_row.attempt_count >= task_row.max_attempts then 'failed' else 'retry' end,
        next_attempt_at = case when task_row.attempt_count >= task_row.max_attempts then next_attempt_at else now() end,
        claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
        last_error_code = 'STRUCTURING_LEASE_EXPIRED', updated_at = now(),
        completed_at = case when task_row.attempt_count >= task_row.max_attempts then now() else null end
    where id = task_row.id;
    perform security_private.zagulyaky_structuring_refresh_run_v1(task_row.run_id);
  end loop;
  with next_task as (
    select task.id
    from public.zagulyaky_structuring_tasks task
    join public.zagulyaky_structuring_runs run_row on run_row.id = task.run_id
    join public.zagulyaky_ingestion_items item_row on item_row.id = task.item_id
    where task.status in ('queued', 'retry') and task.next_attempt_at <= now()
      and run_row.status <> 'cancelled'
      and char_length(item_row.raw_text) <= 12000
      and (p_run_id is null or task.run_id = p_run_id)
    order by task.next_attempt_at, task.source_item_index, task.id
    for update of task skip locked
    limit 1
  )
  update public.zagulyaky_structuring_tasks task
  set status = 'processing', attempt_count = task.attempt_count + 1,
      claim_token = gen_random_uuid(), claimed_by = p_worker_id,
      claimed_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      last_error_code = null, updated_at = now(), completed_at = null
  from next_task
  where task.id = next_task.id
  returning task.* into claimed_task;
  if not found then
    return jsonb_build_object('task', null);
  end if;
  perform security_private.zagulyaky_structuring_refresh_run_v1(claimed_task.run_id);
  return jsonb_build_object('task', jsonb_build_object(
    'taskId', claimed_task.id, 'runId', claimed_task.run_id, 'itemId', claimed_task.item_id,
    'sourceItemIndex', claimed_task.source_item_index, 'inputFingerprint', claimed_task.input_fingerprint,
    'attemptCount', claimed_task.attempt_count, 'maxAttempts', claimed_task.max_attempts,
    'claimToken', claimed_task.claim_token, 'leaseExpiresAt', claimed_task.lease_expires_at
  ));
end;
$function$;

create or replace function public.service_claim_zagulyaky_structuring_task_v1(
  p_run_id uuid default null,
  p_worker_id text default 'zagulyaky-structure',
  p_lease_seconds integer default 120
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.service_claim_zagulyaky_structuring_task_v1($1,$2,$3)
$function$;

create or replace function security_private.service_get_zagulyaky_structuring_task_input_v1(
  p_task_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  task_row public.zagulyaky_structuring_tasks;
  item_row public.zagulyaky_ingestion_items;
  run_row public.zagulyaky_structuring_runs;
  actual_fingerprint text;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  select * into task_row from public.zagulyaky_structuring_tasks
  where id = p_task_id for update;
  if not found or task_row.status <> 'processing' or task_row.claim_token is distinct from p_claim_token
    or task_row.lease_expires_at <= now() then
    raise exception 'STRUCTURING_TASK_CLAIM_INVALID' using errcode = '42501';
  end if;
  select * into item_row from public.zagulyaky_ingestion_items where id = task_row.item_id;
  select * into run_row from public.zagulyaky_structuring_runs where id = task_row.run_id;
  if not found or nullif(btrim(item_row.raw_text), '') is null then
    raise exception 'STRUCTURING_TASK_INPUT_UNAVAILABLE' using errcode = '55000';
  end if;
  actual_fingerprint := security_private.zagulyaky_structuring_sha256_v1(item_row.raw_text);
  if actual_fingerprint is distinct from task_row.input_fingerprint
    or char_length(item_row.raw_text) is distinct from task_row.input_character_count then
    raise exception 'STRUCTURING_TASK_INPUT_CHANGED' using errcode = '40001';
  end if;
  -- This is the one service-role-only boundary that returns source text.  It
  -- deliberately omits author, raw payload, source URL, link, and media data.
  return jsonb_build_object(
    'taskId', task_row.id, 'runId', task_row.run_id, 'itemId', task_row.item_id,
    'sourceItemIndex', task_row.source_item_index,
    'inputFingerprint', task_row.input_fingerprint,
    'claimToken', task_row.claim_token,
    'requestedBy', run_row.requested_by,
    'provider', run_row.provider,
    'model', run_row.model,
    'parserVersion', run_row.parser_version,
    'rawText', item_row.raw_text,
    'candidateYears', item_row.candidate_years,
    'inputCharacterCount', task_row.input_character_count
  );
end;
$function$;

create or replace function public.service_get_zagulyaky_structuring_task_input_v1(
  p_task_id uuid, p_claim_token uuid
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.service_get_zagulyaky_structuring_task_input_v1($1,$2)
$function$;

create or replace function security_private.service_complete_zagulyaky_structuring_task_v1(
  p_task_id uuid,
  p_claim_token uuid,
  p_input_fingerprint text,
  p_candidates jsonb,
  p_result_summary jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  task_row public.zagulyaky_structuring_tasks;
  run_row public.zagulyaky_structuring_runs;
  item_row public.zagulyaky_ingestion_items;
  candidate_value jsonb;
  validated jsonb;
  candidate_count integer := 0;
  person_candidate_count integer := 0;
  document_candidate_count integer := 0;
  evidence_count integer := 0;
  warning_count integer := 0;
  seen_candidate_keys text[] := '{}'::text[];
  summary_provider text;
  summary_model text;
  summary_key_source text;
  safe_result_summary jsonb;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_input_fingerprint !~ '^[0-9a-f]{64}$'
    or p_candidates is null or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 20
    or p_result_summary is null or jsonb_typeof(p_result_summary) <> 'object'
    or octet_length(p_result_summary::text) > 2048
    or exists (
      select 1 from jsonb_object_keys(p_result_summary) summary_key
      where summary_key not in (
        'provider', 'model', 'keySource', 'inputChars', 'candidateCount',
        'personCandidateCount', 'documentCandidateCount', 'evidenceCount', 'warningCount'
      )
    ) then
    raise exception 'STRUCTURING_INVALID_COMPLETE_REQUEST' using errcode = '22023';
  end if;
  select * into task_row from public.zagulyaky_structuring_tasks where id = p_task_id for update;
  if not found or task_row.status <> 'processing' or task_row.claim_token is distinct from p_claim_token
    or task_row.lease_expires_at <= now() then
    raise exception 'STRUCTURING_TASK_CLAIM_INVALID' using errcode = '42501';
  end if;
  select * into run_row from public.zagulyaky_structuring_runs where id = task_row.run_id;
  select * into item_row from public.zagulyaky_ingestion_items where id = task_row.item_id;
  if not found or security_private.zagulyaky_structuring_sha256_v1(item_row.raw_text) is distinct from task_row.input_fingerprint
    or p_input_fingerprint is distinct from task_row.input_fingerprint then
    raise exception 'STRUCTURING_INPUT_FINGERPRINT_MISMATCH' using errcode = '40001';
  end if;
  summary_provider := security_private.zagulyaky_structuring_safe_text_v1(
    p_result_summary -> 'provider', 'summary_provider', 80, false
  );
  summary_model := security_private.zagulyaky_structuring_safe_text_v1(
    p_result_summary -> 'model', 'summary_model', 160, false
  );
  summary_key_source := security_private.zagulyaky_structuring_safe_text_v1(
    p_result_summary -> 'keySource', 'summary_key_source', 80, false
  );
  if summary_provider is not null and summary_provider <> run_row.provider
    or summary_model is not null and summary_model <> run_row.model
    or summary_key_source is not null and summary_key_source !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception 'STRUCTURING_RESULT_SUMMARY_MISMATCH' using errcode = '22023';
  end if;
  if p_result_summary ? 'inputChars'
    and (jsonb_typeof(p_result_summary -> 'inputChars') <> 'number'
      or p_result_summary ->> 'inputChars' !~ '^[0-9]{1,6}$'
      or (p_result_summary ->> 'inputChars')::integer <> char_length(item_row.raw_text)) then
    raise exception 'STRUCTURING_RESULT_SUMMARY_MISMATCH' using errcode = '22023';
  end if;
  update public.zagulyaky_ingestion_structured_candidates
  set status = 'superseded', updated_at = now()
  where task_id = task_row.id and status = 'proposed'
    and input_fingerprint <> task_row.input_fingerprint;
  for candidate_value in select value from jsonb_array_elements(p_candidates) loop
    validated := security_private.zagulyaky_structuring_validate_candidate_v1(candidate_value, item_row.raw_text);
    if (validated ->> 'candidateKey') = any(seen_candidate_keys) then
      raise exception 'STRUCTURING_DUPLICATE_CANDIDATE_KEY' using errcode = '22023';
    end if;
    seen_candidate_keys := array_append(seen_candidate_keys, validated ->> 'candidateKey');
    insert into public.zagulyaky_ingestion_structured_candidates(
      run_id, task_id, item_id, source_item_index, parser_version, input_fingerprint,
      candidate_key, kind, confidence, candidate_data, evidence_spans, warnings
    ) values (
      task_row.run_id, task_row.id, task_row.item_id, task_row.source_item_index,
      run_row.parser_version, task_row.input_fingerprint,
      validated ->> 'candidateKey', validated ->> 'kind', (validated ->> 'confidence')::numeric,
      validated -> 'candidateData', validated -> 'evidenceSpans', validated -> 'warnings'
    ) on conflict (run_id, item_id, input_fingerprint, candidate_key) do update
    set confidence = excluded.confidence,
        candidate_data = excluded.candidate_data,
        evidence_spans = excluded.evidence_spans,
        warnings = excluded.warnings,
        materialization_error_code = null,
        updated_at = now()
    where public.zagulyaky_ingestion_structured_candidates.status = 'proposed';
    candidate_count := candidate_count + 1;
    if validated ->> 'kind' = 'person' then
      person_candidate_count := person_candidate_count + 1;
    else
      document_candidate_count := document_candidate_count + 1;
    end if;
    evidence_count := evidence_count + jsonb_array_length(validated -> 'evidenceSpans');
    warning_count := warning_count + jsonb_array_length(validated -> 'warnings');
  end loop;
  if (p_result_summary ? 'candidateCount'
      and (jsonb_typeof(p_result_summary -> 'candidateCount') <> 'number'
        or p_result_summary ->> 'candidateCount' !~ '^[0-9]{1,2}$'
        or (p_result_summary ->> 'candidateCount')::integer <> candidate_count))
    or (p_result_summary ? 'personCandidateCount'
      and (jsonb_typeof(p_result_summary -> 'personCandidateCount') <> 'number'
        or p_result_summary ->> 'personCandidateCount' !~ '^[0-9]{1,2}$'
        or (p_result_summary ->> 'personCandidateCount')::integer <> person_candidate_count))
    or (p_result_summary ? 'documentCandidateCount'
      and (jsonb_typeof(p_result_summary -> 'documentCandidateCount') <> 'number'
        or p_result_summary ->> 'documentCandidateCount' !~ '^[0-9]{1,2}$'
        or (p_result_summary ->> 'documentCandidateCount')::integer <> document_candidate_count))
    or (p_result_summary ? 'evidenceCount'
      and (jsonb_typeof(p_result_summary -> 'evidenceCount') <> 'number'
        or p_result_summary ->> 'evidenceCount' !~ '^[0-9]{1,3}$'
        or (p_result_summary ->> 'evidenceCount')::integer <> evidence_count))
    or (p_result_summary ? 'warningCount'
      and (jsonb_typeof(p_result_summary -> 'warningCount') <> 'number'
        or p_result_summary ->> 'warningCount' !~ '^[0-9]{1,3}$'
        or (p_result_summary ->> 'warningCount')::integer <> warning_count)) then
    raise exception 'STRUCTURING_RESULT_SUMMARY_MISMATCH' using errcode = '22023';
  end if;
  safe_result_summary := jsonb_strip_nulls(jsonb_build_object(
    'provider', coalesce(summary_provider, run_row.provider),
    'model', coalesce(summary_model, run_row.model),
    'keySource', summary_key_source,
    'inputChars', char_length(item_row.raw_text),
    'candidateCount', candidate_count,
    'personCandidateCount', person_candidate_count,
    'documentCandidateCount', document_candidate_count,
    'evidenceCount', evidence_count,
    'warningCount', warning_count
  ));
  update public.zagulyaky_structuring_tasks
  set status = 'succeeded', result_candidate_count = candidate_count,
      result_summary = safe_result_summary,
      claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      last_error_code = null, completed_at = now(), updated_at = now()
  where id = task_row.id;
  update public.zagulyaky_ingestion_items
  set stage_status = case when stage_status = 'staged' then 'structured' else stage_status end,
      updated_at = now()
  where id = task_row.item_id;
  perform security_private.zagulyaky_structuring_refresh_run_v1(task_row.run_id);
  return jsonb_build_object('taskId', task_row.id, 'status', 'succeeded', 'candidateCount', candidate_count);
end;
$function$;

create or replace function public.service_complete_zagulyaky_structuring_task_v1(
  p_task_id uuid,
  p_claim_token uuid,
  p_input_fingerprint text,
  p_candidates jsonb,
  p_result_summary jsonb default '{}'::jsonb
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.service_complete_zagulyaky_structuring_task_v1($1,$2,$3,$4,$5)
$function$;

create or replace function security_private.service_fail_zagulyaky_structuring_task_v1(
  p_task_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_retryable boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare task_row public.zagulyaky_structuring_tasks;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  if p_error_code !~ '^[A-Z0-9_]{3,100}$' then
    raise exception 'STRUCTURING_INVALID_ERROR_CODE' using errcode = '22023';
  end if;
  select * into task_row from public.zagulyaky_structuring_tasks where id = p_task_id for update;
  if not found or task_row.status <> 'processing' or task_row.claim_token is distinct from p_claim_token
    or task_row.lease_expires_at <= now() then
    raise exception 'STRUCTURING_TASK_CLAIM_INVALID' using errcode = '42501';
  end if;
  update public.zagulyaky_structuring_tasks
  set status = case when p_retryable and task_row.attempt_count < task_row.max_attempts then 'retry' else 'failed' end,
      next_attempt_at = case when p_retryable and task_row.attempt_count < task_row.max_attempts
        then now() + make_interval(secs => least(1800, 30 * power(2, greatest(task_row.attempt_count - 1, 0))::integer))
        else next_attempt_at end,
      claim_token = null, claimed_by = null, claimed_at = null, lease_expires_at = null,
      last_error_code = p_error_code,
      completed_at = case when p_retryable and task_row.attempt_count < task_row.max_attempts then null else now() end,
      updated_at = now()
  where id = task_row.id;
  perform security_private.zagulyaky_structuring_refresh_run_v1(task_row.run_id);
  return jsonb_build_object('taskId', task_row.id,
    'status', case when p_retryable and task_row.attempt_count < task_row.max_attempts then 'retry' else 'failed' end);
end;
$function$;

create or replace function public.service_fail_zagulyaky_structuring_task_v1(
  p_task_id uuid, p_claim_token uuid, p_error_code text, p_retryable boolean default true
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.service_fail_zagulyaky_structuring_task_v1($1,$2,$3,$4)
$function$;

create or replace function security_private.admin_list_zagulyaky_structuring_candidates_v1(
  p_run_id uuid,
  p_kind text default null,
  p_status text default null,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100 or p_offset < 0
    or (p_kind is not null and p_kind not in ('person','document'))
    or (p_status is not null and p_status not in ('proposed','materialized','rejected','superseded'))
    or char_length(coalesce(p_query, '')) > 160 then
    raise exception 'STRUCTURING_INVALID_CANDIDATE_LIST_REQUEST' using errcode = '22023';
  end if;
  with filtered as (
    select * from public.zagulyaky_ingestion_structured_candidates
    where run_id = p_run_id
      and (p_kind is null or kind = p_kind)
      and (p_status is null or status = p_status)
      and (nullif(btrim(p_query), '') is null or candidate_data ->> 'title' ilike '%' || btrim(p_query) || '%')
  ), page as (
    select filtered.*, count(*) over () as full_total
    from filtered
    order by source_item_index, created_at, id
    limit p_limit offset p_offset
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'candidateId', candidate_row.id,
      'runId', candidate_row.run_id,
      'taskId', candidate_row.task_id,
      'itemId', candidate_row.item_id,
      'sourceItemIndex', candidate_row.source_item_index,
      'kind', candidate_row.kind,
      'title', candidate_row.candidate_data ->> 'title',
      'classificationReason', candidate_row.candidate_data ->> 'classificationReason',
      'event', candidate_row.candidate_data -> 'event',
      'confidence', candidate_row.confidence,
      'status', candidate_row.status,
      'privacyReviewRequired', candidate_row.privacy_review_required,
      'possibleLivingPerson', coalesce((candidate_row.candidate_data ->> 'possibleLivingPerson')::boolean, false),
      'participantCount', jsonb_array_length(coalesce(candidate_row.candidate_data -> 'participants', '[]'::jsonb)),
      'warningCount', jsonb_array_length(candidate_row.warnings),
      'warnings', candidate_row.warnings,
      'materializedRecordId', candidate_row.materialized_record_id,
      'createdAt', candidate_row.created_at,
      'updatedAt', candidate_row.updated_at
    ) order by candidate_row.source_item_index, candidate_row.created_at, candidate_row.id), '[]'::jsonb),
    'total', (select count(*) from filtered)
  ) into result
  from page candidate_row;
  return coalesce(result, jsonb_build_object('items', '[]'::jsonb, 'total', 0));
end;
$function$;

create or replace function public.admin_list_zagulyaky_structuring_candidates_v1(
  p_run_id uuid,
  p_kind text default null,
  p_status text default null,
  p_query text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.admin_list_zagulyaky_structuring_candidates_v1($1,$2,$3,$4,$5,$6)
$function$;

create or replace function security_private.admin_get_zagulyaky_structuring_candidate_v1(
  p_candidate_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'candidateId', candidate_row.id,
    'runId', candidate_row.run_id,
    'taskId', candidate_row.task_id,
    'itemId', candidate_row.item_id,
    'sourceItemIndex', candidate_row.source_item_index,
    'parserVersion', candidate_row.parser_version,
    'inputFingerprint', candidate_row.input_fingerprint,
    'kind', candidate_row.kind,
    'confidence', candidate_row.confidence,
    'status', candidate_row.status,
    'privacyReviewRequired', candidate_row.privacy_review_required,
    'candidateData', candidate_row.candidate_data,
    'evidenceSpans', candidate_row.evidence_spans,
    'warnings', candidate_row.warnings,
    'materializedRecordId', candidate_row.materialized_record_id,
    'materializedAt', candidate_row.materialized_at,
    'materializationErrorCode', candidate_row.materialization_error_code,
    'createdAt', candidate_row.created_at,
    'updatedAt', candidate_row.updated_at
  ) into result
  from public.zagulyaky_ingestion_structured_candidates candidate_row
  where candidate_row.id = p_candidate_id;
  if result is null then raise exception 'STRUCTURING_CANDIDATE_NOT_FOUND' using errcode = 'P0002'; end if;
  return result;
end;
$function$;

create or replace function public.admin_get_zagulyaky_structuring_candidate_v1(p_candidate_id uuid)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.admin_get_zagulyaky_structuring_candidate_v1($1)
$function$;

create or replace function security_private.admin_materialize_zagulyaky_structuring_candidates_v1(
  p_run_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  run_row public.zagulyaky_structuring_runs;
  candidate_row public.zagulyaky_ingestion_structured_candidates;
  record_row public.zagulyaky_records;
  participant_value jsonb;
  discovery_value jsonb;
  materialized_count integer := 0;
  failed_count integer := 0;
  attempted_count integer := 0;
  remaining_count integer := 0;
  error_state text;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_limit not between 1 and 250 then
    raise exception 'STRUCTURING_INVALID_MATERIALIZE_LIMIT' using errcode = '22023';
  end if;
  select * into run_row from public.zagulyaky_structuring_runs where id = p_run_id for share;
  if not found then raise exception 'STRUCTURING_RUN_NOT_FOUND' using errcode = 'P0002'; end if;
  for candidate_row in
    select * from public.zagulyaky_ingestion_structured_candidates
    where run_id = p_run_id and status = 'proposed'
    order by source_item_index, created_at, id
    limit p_limit
    for update skip locked
  loop
    attempted_count := attempted_count + 1;
    begin
      insert into public.zagulyaky_records(
        kind, status, verification_status, privacy_status, title, summary,
        original_text, normalized_text, event_type, event_date_text,
        event_year_from, event_year_to, date_precision, found_location_text,
        classification_reason, payload, possible_living_person,
        public_attribution, created_by
      ) values (
        candidate_row.kind, 'draft', 'unverified',
        case when coalesce((candidate_row.candidate_data ->> 'possibleLivingPerson')::boolean, false)
          then 'requires_consent' else 'pending' end,
        candidate_row.candidate_data ->> 'title', '', '', '',
        candidate_row.candidate_data -> 'event' ->> 'type',
        candidate_row.candidate_data -> 'event' ->> 'dateText',
        nullif(candidate_row.candidate_data -> 'event' ->> 'yearFrom', '')::integer,
        nullif(candidate_row.candidate_data -> 'event' ->> 'yearTo', '')::integer,
        case
          when candidate_row.candidate_data -> 'event' ->> 'yearFrom' is not null
            and candidate_row.candidate_data -> 'event' ->> 'yearTo' is not null
            and candidate_row.candidate_data -> 'event' ->> 'yearFrom'
              <> candidate_row.candidate_data -> 'event' ->> 'yearTo' then 'range'
          when candidate_row.candidate_data -> 'event' ->> 'yearFrom' is not null then 'year'
          else 'unknown'
        end,
        candidate_row.candidate_data -> 'event' ->> 'placeText',
        coalesce(candidate_row.candidate_data ->> 'classificationReason', ''),
        jsonb_build_object('automatedStructuring', jsonb_build_object(
          'candidateId', candidate_row.id, 'runId', candidate_row.run_id,
          'privacyReviewRequired', true
        )),
        coalesce((candidate_row.candidate_data ->> 'possibleLivingPerson')::boolean, false),
        false, coalesce(run_row.requested_by, current_user_id)
      ) returning * into record_row;
      for participant_value in select value from jsonb_array_elements(candidate_row.candidate_data -> 'participants') loop
        insert into public.zagulyaky_participants(
          record_id, role, event_role_code, event_role_custom,
          original_full_name, normalized_uk_full_name, surname, given_name,
          patronymic, sex, sort_order
        ) values (
          record_row.id, participant_value ->> 'structuralRole',
          participant_value ->> 'eventRoleCode', participant_value ->> 'eventRoleCustom',
          coalesce(participant_value ->> 'originalFullName', ''),
          coalesce(participant_value ->> 'normalizedUkFullName', ''),
          participant_value ->> 'surname', participant_value ->> 'givenName',
          participant_value ->> 'patronymic', participant_value ->> 'sex',
          coalesce((participant_value ->> 'sortOrder')::integer, 0)
        );
      end loop;
      discovery_value := candidate_row.candidate_data -> 'documentDiscovery';
      if jsonb_typeof(discovery_value) = 'object' then
        insert into public.zagulyaky_document_discoveries(
          record_id, official_location_text, discovered_location_text, record_types,
          factual_year_from, factual_year_to, page_from, page_to
        ) values (
          record_row.id,
          coalesce(discovery_value ->> 'officialLocationText', ''),
          coalesce(discovery_value ->> 'discoveredLocationText', ''),
          coalesce(array(select jsonb_array_elements_text(
            coalesce(discovery_value -> 'recordTypes', '[]'::jsonb)
          )), '{}'::text[]),
          nullif(discovery_value ->> 'yearFrom', '')::integer,
          nullif(discovery_value ->> 'yearTo', '')::integer,
          discovery_value ->> 'pageFrom', discovery_value ->> 'pageTo'
        );
      end if;
      -- There are intentionally no zagulyaky_sources or attachments here.
      -- The private relation is the sole automatic provenance link.
      insert into public.zagulyaky_ingestion_item_records(item_id, record_id, relationship_kind, linked_by, note)
      values (candidate_row.item_id, record_row.id, 'derived', current_user_id,
        'automated_structuring_candidate')
      on conflict (item_id, record_id, relationship_kind) do nothing;
      update public.zagulyaky_ingestion_structured_candidates
      set status = 'materialized', materialized_record_id = record_row.id,
          materialized_by = current_user_id, materialized_at = now(),
          materialization_error_code = null, updated_at = now()
      where id = candidate_row.id;
      materialized_count := materialized_count + 1;
    exception when others then
      get stacked diagnostics error_state = returned_sqlstate;
      update public.zagulyaky_ingestion_structured_candidates
      set materialization_error_code = case when error_state ~ '^[A-Z0-9_]{3,100}$' then error_state else 'STRUCTURING_MATERIALIZATION_FAILED' end,
          updated_at = now()
      where id = candidate_row.id and status = 'proposed';
      failed_count := failed_count + 1;
    end;
  end loop;
  select count(*) into remaining_count
  from public.zagulyaky_ingestion_structured_candidates
  where run_id = p_run_id and status = 'proposed';
  perform security_private.zagulyaky_structuring_refresh_run_v1(p_run_id);
  insert into public.admin_audit_log(
    admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
  ) values (
    current_user_id, 'zagulyaky.structuring.materialize', 'zagulyaky_structuring_run', p_run_id::text,
    case when failed_count > 0 and materialized_count = 0 then 'failure' else 'success' end,
    jsonb_build_object('materializedCount', materialized_count, 'failedCount', failed_count)
  );
  return jsonb_build_object('runId', p_run_id, 'attemptedCount', attempted_count,
    'materializedCount', materialized_count, 'failedCount', failed_count,
    'skippedCount', 0, 'remainingCount', remaining_count,
    'run', security_private.zagulyaky_structuring_run_projection_v1(p_run_id));
end;
$function$;

create or replace function public.admin_materialize_zagulyaky_structuring_candidates_v1(
  p_run_id uuid, p_limit integer default 100
)
returns jsonb language sql security invoker set search_path = pg_catalog as $function$
  select security_private.admin_materialize_zagulyaky_structuring_candidates_v1($1,$2)
$function$;

-- Private implementations are deliberately not API surface.  The public
-- facades are scoped by role and repeat their authorization internally.
revoke all on function security_private.zagulyaky_structuring_sha256_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_structuring_safe_text_v1(jsonb,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_structuring_evidence_spans_v1(jsonb,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_structuring_validate_candidate_v1(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_structuring_refresh_run_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_structuring_run_projection_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_start_zagulyaky_structuring_run_v1(uuid,text,text,text,boolean,text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_structuring_run_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_list_zagulyaky_structuring_runs_v1(uuid,text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.service_claim_zagulyaky_structuring_task_v1(uuid,text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.service_get_zagulyaky_structuring_task_input_v1(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.service_complete_zagulyaky_structuring_task_v1(uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.service_fail_zagulyaky_structuring_task_v1(uuid,uuid,text,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_list_zagulyaky_structuring_candidates_v1(uuid,text,text,text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_structuring_candidate_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer) from public, anon, authenticated, service_role;

-- The facade calls its private SECURITY DEFINER implementation.  These
-- grants do not create a direct table path; the schema is not exposed by API.
grant execute on function security_private.admin_start_zagulyaky_structuring_run_v1(uuid,text,text,text,boolean,text,integer,integer) to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_structuring_run_v1(uuid) to authenticated, service_role;
grant execute on function security_private.admin_list_zagulyaky_structuring_runs_v1(uuid,text,integer,integer) to authenticated, service_role;
grant execute on function security_private.admin_list_zagulyaky_structuring_candidates_v1(uuid,text,text,text,integer,integer) to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_structuring_candidate_v1(uuid) to authenticated, service_role;
grant execute on function security_private.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer) to authenticated, service_role;
grant execute on function security_private.service_claim_zagulyaky_structuring_task_v1(uuid,text,integer) to service_role;
grant execute on function security_private.service_get_zagulyaky_structuring_task_input_v1(uuid,uuid) to service_role;
grant execute on function security_private.service_complete_zagulyaky_structuring_task_v1(uuid,uuid,text,jsonb,jsonb) to service_role;
grant execute on function security_private.service_fail_zagulyaky_structuring_task_v1(uuid,uuid,text,boolean) to service_role;

revoke all on function public.admin_start_zagulyaky_structuring_run_v1(uuid,text,text,text,boolean,text,integer,integer) from public, anon;
revoke all on function public.admin_get_zagulyaky_structuring_run_v1(uuid) from public, anon;
revoke all on function public.admin_list_zagulyaky_structuring_runs_v1(uuid,text,integer,integer) from public, anon;
revoke all on function public.admin_list_zagulyaky_structuring_candidates_v1(uuid,text,text,text,integer,integer) from public, anon;
revoke all on function public.admin_get_zagulyaky_structuring_candidate_v1(uuid) from public, anon;
revoke all on function public.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer) from public, anon;
revoke all on function public.service_claim_zagulyaky_structuring_task_v1(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.service_get_zagulyaky_structuring_task_input_v1(uuid,uuid) from public, anon, authenticated;
revoke all on function public.service_complete_zagulyaky_structuring_task_v1(uuid,uuid,text,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.service_fail_zagulyaky_structuring_task_v1(uuid,uuid,text,boolean) from public, anon, authenticated;

grant execute on function public.admin_start_zagulyaky_structuring_run_v1(uuid,text,text,text,boolean,text,integer,integer) to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_structuring_run_v1(uuid) to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_structuring_runs_v1(uuid,text,integer,integer) to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_structuring_candidates_v1(uuid,text,text,text,integer,integer) to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_structuring_candidate_v1(uuid) to authenticated, service_role;
grant execute on function public.admin_materialize_zagulyaky_structuring_candidates_v1(uuid,integer) to authenticated, service_role;
grant execute on function public.service_claim_zagulyaky_structuring_task_v1(uuid,text,integer) to service_role;
grant execute on function public.service_get_zagulyaky_structuring_task_input_v1(uuid,uuid) to service_role;
grant execute on function public.service_complete_zagulyaky_structuring_task_v1(uuid,uuid,text,jsonb,jsonb) to service_role;
grant execute on function public.service_fail_zagulyaky_structuring_task_v1(uuid,uuid,text,boolean) to service_role;

notify pgrst, 'reload schema';

commit;
