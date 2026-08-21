begin;

-- Event-centric workbook import for the initial private Zagulyaky base.
--
-- This is deliberately independent from the Stage 0 Facebook collector.
-- A workbook may describe several historical events inside one Facebook post,
-- and every named person may become a separate draft card.  The raw post,
-- Facebook URL and exact private import provenance never leave this ledger.

insert into public.admin_role_permissions(role_code, permission_code) values
  ('content_admin', 'zagulyaky.import'),
  ('super_admin', 'zagulyaky.import')
on conflict (role_code, permission_code) do nothing;

-- These fields are historical, structured facts.  They are intentionally not
-- URLs or private platform identifiers and are safe to carry with a draft
-- catalogue participant after review.  The complete Facebook post remains in
-- the private tabular-import source-post table below.
alter table public.zagulyaky_participants
  add column if not exists social_estate_text text,
  add column if not exists occupation_or_rank_text text,
  add column if not exists marital_status_text text,
  add column if not exists relation_original text,
  add column if not exists evidence_excerpt text;

alter table public.zagulyaky_participants
  drop constraint if exists zagulyaky_participants_import_safe_fields_check;
alter table public.zagulyaky_participants
  add constraint zagulyaky_participants_import_safe_fields_check check (
    (social_estate_text is null or char_length(social_estate_text) <= 1000)
    and (occupation_or_rank_text is null or char_length(occupation_or_rank_text) <= 1000)
    and (marital_status_text is null or char_length(marital_status_text) <= 1000)
    and (relation_original is null or char_length(relation_original) <= 1000)
    and (evidence_excerpt is null or char_length(evidence_excerpt) <= 4000)
    and (evidence_excerpt is null or evidence_excerpt !~* 'https?://')
  );

-- The workbook prompt has a few useful, source-faithful role codes that were
-- not present in the first UI-only vocabulary.  They remain event roles; the
-- structural role of the primary card participant is assigned by the
-- materializer below.
alter table public.zagulyaky_participants
  drop constraint if exists zagulyaky_participants_event_role_code_check;
alter table public.zagulyaky_participants
  add constraint zagulyaky_participants_event_role_code_check check (
    event_role_code is null
    or event_role_code in (
      'subject', 'newborn', 'baptized', 'groom', 'bride',
      'groom_father', 'groom_mother', 'bride_father', 'bride_mother',
      'deceased', 'resident', 'household_head', 'household_member',
      'military_person', 'migrant', 'godparent', 'godchild', 'father',
      'mother', 'parent', 'child', 'spouse', 'witness', 'pledger',
      'officiant', 'registrar', 'midwife', 'informant', 'owner',
      'commander', 'official', 'priest', 'relative', 'mentioned_person',
      'unspecified', 'other'
    )
  );

create table if not exists public.zagulyaky_tabular_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_file_name text not null
    check (char_length(source_file_name) between 1 and 255),
  source_checksum text not null
    check (source_checksum ~ '^[0-9a-f]{64}$'),
  import_contract_version smallint not null default 1
    check (import_contract_version = 1),
  import_mode text not null default 'dry_run'
    check (import_mode in ('dry_run', 'commit')),
  status text not null default 'received'
    check (status in (
      'received', 'processing', 'dry_run_complete', 'commit_ready',
      'commit_materializing', 'completed', 'completed_with_errors',
      'failed', 'cancelled'
    )),
  expected_source_post_count integer not null default 0
    check (expected_source_post_count between 0 and 50000),
  expected_event_count integer not null default 0
    check (expected_event_count between 0 and 200000),
  expected_participant_count integer not null default 0
    check (expected_participant_count between 0 and 500000),
  expected_event_source_count integer not null default 0
    check (expected_event_source_count between 0 and 500000),
  expected_card_count integer not null default 0
    check (expected_card_count between 0 and 500000),
  expected_qc_count integer not null default 0
    check (expected_qc_count between 0 and 500000),
  expected_no_card_event_count integer not null default 0
    check (expected_no_card_event_count between 0 and 200000),
  source_post_count integer not null default 0 check (source_post_count >= 0),
  event_count integer not null default 0 check (event_count >= 0),
  participant_count integer not null default 0 check (participant_count >= 0),
  event_source_count integer not null default 0 check (event_source_count >= 0),
  card_count integer not null default 0 check (card_count >= 0),
  qc_count integer not null default 0 check (qc_count >= 0),
  no_card_event_count integer not null default 0 check (no_card_event_count >= 0),
  chunk_count integer not null default 0 check (chunk_count >= 0),
  materialized_card_count integer not null default 0 check (materialized_card_count >= 0),
  failed_card_count integer not null default 0 check (failed_card_count >= 0),
  requested_by uuid references public.profiles(user_id) on delete set null,
  received_at timestamptz not null default now(),
  dry_run_completed_at timestamptz,
  commit_started_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique (source_checksum)
);

create index if not exists zagulyaky_tabular_import_batches_status_idx
  on public.zagulyaky_tabular_import_batches(status, received_at desc);

-- Source posts are retained even when their text produces no historical event.
-- This table is the canonical location for raw Facebook post text and a
-- Facebook post URL.  Other private ledger rows may retain an unmodified
-- workbook-row envelope for audit, but none of that provenance is copied to
-- a catalogue record or a public source table.
create table if not exists public.zagulyaky_tabular_import_source_posts (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  post_key text not null check (post_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  -- The workbook can combine Facebook posts with archive/catalogue exports.
  -- Do not constrain this to one collector platform.
  source_platform text not null default 'facebook' check (char_length(source_platform) between 1 and 120),
  facebook_post_url_private text
    check (facebook_post_url_private is null or facebook_post_url_private ~* '^https?://'),
  source_collection_url_private text
    check (source_collection_url_private is null or source_collection_url_private ~* '^https?://'),
  source_author_label_private text,
  source_date_text text,
  source_date_precision text,
  source_published_at timestamptz,
  source_collected_at timestamptz,
  source_file_name_original text,
  source_row_number integer check (source_row_number is null or source_row_number >= 1),
  post_text_complete boolean not null default true,
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  source_title_original text,
  post_original_text text not null,
  source_language text,
  privacy_scope text not null default 'private_source'
    check (privacy_scope = 'private_source'),
  source_status text not null default 'staged',
  source_notes text not null default '',
  workbook_row_private jsonb not null default '{}'::jsonb
    check (jsonb_typeof(workbook_row_private) = 'object' and octet_length(workbook_row_private::text) <= 524288),
  created_at timestamptz not null default now(),
  unique (batch_id, post_key)
);

create index if not exists zagulyaky_tabular_import_source_posts_batch_idx
  on public.zagulyaky_tabular_import_source_posts(batch_id, post_key);

create table if not exists public.zagulyaky_tabular_import_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  event_key text not null check (event_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  event_group_key text,
  post_key text not null check (post_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  event_sequence integer not null check (event_sequence between 1 and 1000000),
  event_type_code text,
  event_type_original text,
  event_date_original text,
  event_year integer check (event_year is null or event_year between 1 and 2200),
  event_year_from integer check (event_year_from is null or event_year_from between 1 and 2200),
  event_year_to integer check (event_year_to is null or event_year_to between 1 and 2200),
  event_month integer check (event_month is null or event_month between 1 and 12),
  event_day integer check (event_day is null or event_day between 1 and 31),
  date_precision text check (date_precision is null or date_precision in (
    'exact', 'month', 'year', 'range', 'approximate', 'before', 'after', 'unknown'
  )),
  calendar_style text,
  event_place_original text,
  event_place_normalized text,
  church_or_parish_original text,
  record_number_original text,
  archive_repository_original text,
  archive_reference_original text,
  page_or_folio_original text,
  document_title_original text,
  document_language text,
  record_types_private jsonb not null default '[]'::jsonb
    check (jsonb_typeof(record_types_private) = 'array' and octet_length(record_types_private::text) <= 16000),
  document_url_private text
    check (document_url_private is null or document_url_private ~* '^https?://'),
  event_original_text text,
  event_summary text,
  event_status text,
  event_notes text,
  event_confidence text,
  review_status text not null default 'private_staging',
  uncertainty_notes text not null default '',
  workbook_row_private jsonb not null default '{}'::jsonb
    check (jsonb_typeof(workbook_row_private) = 'object' and octet_length(workbook_row_private::text) <= 524288),
  created_at timestamptz not null default now(),
  unique (batch_id, event_key),
  check (event_year_to is null or event_year_from is null or event_year_to >= event_year_from)
);

create index if not exists zagulyaky_tabular_import_events_batch_post_idx
  on public.zagulyaky_tabular_import_events(batch_id, post_key, event_sequence, event_key);

create table if not exists public.zagulyaky_tabular_import_participants (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  participant_key text not null check (participant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  person_card_key text not null check (person_card_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  event_key text not null check (event_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  post_key text not null check (post_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  participant_sequence integer not null check (participant_sequence between 1 and 1000000),
  full_name_original text not null default '',
  surname_original text,
  given_name_original text,
  patronymic_original text,
  name_normalized text,
  maiden_name_original text,
  structural_role_code text,
  role_code text,
  role_original text,
  event_role_custom text,
  sex text check (sex is null or sex in ('male', 'female', 'unknown')),
  origin_original text,
  residence_original text,
  social_estate_text text,
  occupation_or_rank_text text,
  marital_status_text text,
  age_original text,
  age_years integer check (age_years is null or age_years between 0 and 140),
  relation_original text,
  participant_original_text text,
  evidence_excerpt text,
  field_confidence text,
  privacy_review_required boolean not null default false,
  possible_living_person boolean not null default false,
  participant_status text,
  duplicate_key text,
  participant_notes text,
  review_status text not null default 'private_staging',
  uncertainty_notes text not null default '',
  private_search_text text not null default '',
  workbook_row_private jsonb not null default '{}'::jsonb
    check (jsonb_typeof(workbook_row_private) = 'object' and octet_length(workbook_row_private::text) <= 524288),
  created_at timestamptz not null default now(),
  unique (batch_id, participant_key)
);

create index if not exists zagulyaky_tabular_import_participants_event_idx
  on public.zagulyaky_tabular_import_participants(batch_id, event_key, participant_sequence, participant_key);
create index if not exists zagulyaky_tabular_import_participants_person_card_idx
  on public.zagulyaky_tabular_import_participants(batch_id, person_card_key, participant_key);

create table if not exists public.zagulyaky_tabular_import_event_sources (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  event_source_key text not null check (event_source_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  event_key text not null check (event_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  post_key text not null check (post_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  event_source_sequence integer not null check (event_source_sequence between 1 and 1000000),
  document_type text,
  document_title_original text,
  archive_repository_original text,
  archive_reference_original text,
  page_or_folio_original text,
  record_number_original text,
  document_url_private text
    check (document_url_private is null or document_url_private ~* '^https?://'),
  source_original_text text,
  permission_status text not null default 'not_reviewed'
    check (permission_status in (
      'not_reviewed', 'unknown', 'link_only', 'permission_granted',
      'public_domain', 'restricted'
    )),
  confidence text,
  is_primary boolean not null default false,
  source_platform text,
  external_id text,
  access_date date,
  review_status text not null default 'private_staging',
  uncertainty_notes text not null default '',
  private_search_text text not null default '',
  workbook_row_private jsonb not null default '{}'::jsonb
    check (jsonb_typeof(workbook_row_private) = 'object' and octet_length(workbook_row_private::text) <= 524288),
  created_at timestamptz not null default now(),
  unique (batch_id, event_source_key)
);

create index if not exists zagulyaky_tabular_import_event_sources_event_idx
  on public.zagulyaky_tabular_import_event_sources(batch_id, event_key, event_source_sequence, event_source_key);

create table if not exists public.zagulyaky_tabular_import_cards (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  card_key text not null check (card_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  post_key text not null check (post_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  event_key text not null check (event_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  card_sequence integer not null check (card_sequence between 1 and 1000000),
  card_kind text not null default 'person' check (card_kind in ('person', 'document')),
  primary_participant_key text not null check (primary_participant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'),
  card_title_original text,
  card_summary text not null default '',
  card_original_text text not null default '',
  card_normalized_text text not null default '',
  classification_reason text not null default 'Initial private tabular import.',
  possible_living_person boolean not null default false,
  requested_verification_status text,
  requested_privacy_status text,
  requested_publication_status text,
  card_status text,
  copy_event_participants boolean not null default true,
  duplicate_key text,
  card_notes text,
  review_status text not null default 'private_staging',
  uncertainty_notes text not null default '',
  materialization_status text not null default 'pending'
    check (materialization_status in ('pending', 'materialized', 'failed')),
  materialization_error_code text,
  materialized_at timestamptz,
  workbook_row_private jsonb not null default '{}'::jsonb
    check (jsonb_typeof(workbook_row_private) = 'object' and octet_length(workbook_row_private::text) <= 524288),
  created_at timestamptz not null default now(),
  unique (card_key)
);

create index if not exists zagulyaky_tabular_import_cards_batch_event_idx
  on public.zagulyaky_tabular_import_cards(batch_id, event_key, card_sequence, card_key)
  where materialization_status = 'pending';

create table if not exists public.zagulyaky_tabular_import_qc (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  post_key text,
  event_key text,
  participant_key text,
  severity text not null check (severity in ('info', 'warning', 'error')),
  qc_code text not null check (qc_code ~ '^[A-Z0-9_]{3,100}$'),
  field_name text,
  source_excerpt text,
  note text not null default '',
  review_status text,
  workbook_row_private jsonb not null default '{}'::jsonb
    check (jsonb_typeof(workbook_row_private) = 'object' and octet_length(workbook_row_private::text) <= 524288),
  created_at timestamptz not null default now()
);

create index if not exists zagulyaky_tabular_import_qc_batch_idx
  on public.zagulyaky_tabular_import_qc(batch_id, severity, qc_code, id);

-- Chunk receipts make retries deterministic.  A workbook is staged on a
-- dry-run.  A later commit never uploads a second copy; it materializes the
-- checked private ledger only after the dry-run has completed.
create table if not exists public.zagulyaky_tabular_import_chunks (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  import_mode text not null check (import_mode in ('dry_run', 'commit')),
  chunk_index integer not null check (chunk_index between 0 and 100000),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  source_post_count integer not null default 0 check (source_post_count >= 0),
  event_count integer not null default 0 check (event_count >= 0),
  participant_count integer not null default 0 check (participant_count >= 0),
  event_source_count integer not null default 0 check (event_source_count >= 0),
  card_count integer not null default 0 check (card_count >= 0),
  qc_count integer not null default 0 check (qc_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (batch_id, import_mode, chunk_index)
);

create table if not exists public.zagulyaky_tabular_import_card_records (
  card_id uuid primary key references public.zagulyaky_tabular_import_cards(id) on delete cascade,
  record_id uuid not null unique references public.zagulyaky_records(id) on delete restrict,
  batch_id uuid not null references public.zagulyaky_tabular_import_batches(id) on delete cascade,
  materialized_at timestamptz not null default now()
);

-- All workbook tables are private service-side state.  Browser clients use
-- narrowly projected RPCs below; they never receive direct table privileges.
alter table public.zagulyaky_tabular_import_batches enable row level security;
alter table public.zagulyaky_tabular_import_source_posts enable row level security;
alter table public.zagulyaky_tabular_import_events enable row level security;
alter table public.zagulyaky_tabular_import_participants enable row level security;
alter table public.zagulyaky_tabular_import_event_sources enable row level security;
alter table public.zagulyaky_tabular_import_cards enable row level security;
alter table public.zagulyaky_tabular_import_qc enable row level security;
alter table public.zagulyaky_tabular_import_chunks enable row level security;
alter table public.zagulyaky_tabular_import_card_records enable row level security;

revoke all on table public.zagulyaky_tabular_import_batches from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_source_posts from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_events from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_participants from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_event_sources from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_cards from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_qc from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_chunks from public, anon, authenticated;
revoke all on table public.zagulyaky_tabular_import_card_records from public, anon, authenticated;

grant all on table public.zagulyaky_tabular_import_batches to service_role;
grant all on table public.zagulyaky_tabular_import_source_posts to service_role;
grant all on table public.zagulyaky_tabular_import_events to service_role;
grant all on table public.zagulyaky_tabular_import_participants to service_role;
grant all on table public.zagulyaky_tabular_import_event_sources to service_role;
grant all on table public.zagulyaky_tabular_import_cards to service_role;
grant all on table public.zagulyaky_tabular_import_qc to service_role;
grant all on table public.zagulyaky_tabular_import_chunks to service_role;
grant all on table public.zagulyaky_tabular_import_card_records to service_role;

create or replace function security_private.zagulyaky_tabular_import_server_request_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select coalesce(auth.role(), '') = 'service_role'
$function$;

create or replace function security_private.zagulyaky_tabular_import_text_v1(
  p_row jsonb,
  p_key text,
  p_max_length integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  raw_value jsonb;
  normalized_value text;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'INVALID_TABULAR_ROW' using errcode = '22023';
  end if;
  raw_value := p_row -> p_key;
  if raw_value is null or raw_value = 'null'::jsonb then
    if p_required then
      raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(raw_value) not in ('string', 'number', 'boolean') then
    raise exception 'TABULAR_FIELD_MUST_BE_SCALAR:%', p_key using errcode = '22023';
  end if;
  normalized_value := btrim(raw_value #>> '{}');
  if position(chr(0) in normalized_value) > 0 or char_length(normalized_value) > p_max_length then
    raise exception 'TABULAR_FIELD_INVALID_LENGTH:%', p_key using errcode = '22023';
  end if;
  if normalized_value = '' then
    if p_required then
      raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  return normalized_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_raw_text_v1(
  p_row jsonb,
  p_key text,
  p_max_length integer,
  p_required boolean default false
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  raw_value jsonb;
  result_value text;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'INVALID_TABULAR_ROW' using errcode = '22023';
  end if;
  raw_value := p_row -> p_key;
  if raw_value is null or raw_value = 'null'::jsonb then
    if p_required then
      raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
    end if;
    return null;
  end if;
  if jsonb_typeof(raw_value) <> 'string' then
    raise exception 'TABULAR_FIELD_MUST_BE_TEXT:%', p_key using errcode = '22023';
  end if;
  result_value := raw_value #>> '{}';
  if position(chr(0) in result_value) > 0 or char_length(result_value) > p_max_length then
    raise exception 'TABULAR_FIELD_INVALID_LENGTH:%', p_key using errcode = '22023';
  end if;
  if p_required and btrim(result_value) = '' then
    raise exception 'TABULAR_REQUIRED_FIELD_MISSING:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_key_v1(
  p_row jsonb,
  p_key text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  result_value text;
begin
  result_value := security_private.zagulyaky_tabular_import_text_v1(p_row, p_key, 200, true);
  if result_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' then
    raise exception 'INVALID_TABULAR_KEY:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_integer_v1(
  p_row jsonb,
  p_key text,
  p_min integer,
  p_max integer,
  p_required boolean default false
)
returns integer
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  text_value text;
  result_value integer;
begin
  text_value := security_private.zagulyaky_tabular_import_text_v1(p_row, p_key, 20, p_required);
  if text_value is null then return null; end if;
  if text_value !~ '^-?[0-9]{1,10}$' then
    raise exception 'TABULAR_FIELD_MUST_BE_INTEGER:%', p_key using errcode = '22023';
  end if;
  result_value := text_value::integer;
  if result_value not between p_min and p_max then
    raise exception 'TABULAR_INTEGER_OUT_OF_RANGE:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_boolean_v1(
  p_row jsonb,
  p_key text,
  p_default boolean default false
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  raw_value jsonb;
  text_value text;
begin
  raw_value := p_row -> p_key;
  if raw_value is null or raw_value = 'null'::jsonb then return p_default; end if;
  if jsonb_typeof(raw_value) = 'boolean' then return (raw_value #>> '{}')::boolean; end if;
  if jsonb_typeof(raw_value) = 'string' then
    text_value := lower(btrim(raw_value #>> '{}'));
    if text_value in ('true', '1', 'yes', 'так') then return true; end if;
    if text_value in ('false', '0', 'no', 'ні', '') then return false; end if;
  end if;
  raise exception 'TABULAR_FIELD_MUST_BE_BOOLEAN:%', p_key using errcode = '22023';
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_url_v1(
  p_row jsonb,
  p_key text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  result_value text;
begin
  result_value := security_private.zagulyaky_tabular_import_text_v1(p_row, p_key, 4000, false);
  if result_value is not null and result_value !~* '^https?://' then
    raise exception 'INVALID_TABULAR_URL:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_timestamp_v1(
  p_row jsonb,
  p_key text
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  text_value text;
  result_value timestamptz;
begin
  text_value := security_private.zagulyaky_tabular_import_text_v1(p_row, p_key, 80, false);
  if text_value is null then return null; end if;
  begin
    result_value := text_value::timestamptz;
  exception when others then
    raise exception 'INVALID_TABULAR_TIMESTAMP:%', p_key using errcode = '22023';
  end;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_role_code_v1(
  p_role_code text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  normalized_role text := lower(btrim(coalesce(p_role_code, '')));
begin
  if normalized_role in (
    'subject', 'newborn', 'baptized', 'groom', 'bride',
    'groom_father', 'groom_mother', 'bride_father', 'bride_mother',
    'deceased', 'resident', 'household_head', 'household_member',
    'military_person', 'migrant', 'godparent', 'godchild', 'father',
    'mother', 'parent', 'child', 'spouse', 'witness', 'pledger',
    'officiant', 'registrar', 'midwife', 'informant', 'owner',
    'commander', 'official', 'priest', 'relative', 'mentioned_person',
    'unspecified', 'other'
  ) then
    return normalized_role;
  end if;
  return 'other';
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_structural_role_v1(
  p_event_role_code text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select case p_event_role_code
    when 'spouse' then 'spouse'
    when 'groom' then 'spouse'
    when 'bride' then 'spouse'
    when 'father' then 'parent'
    when 'mother' then 'parent'
    when 'parent' then 'parent'
    when 'groom_father' then 'parent'
    when 'groom_mother' then 'parent'
    when 'bride_father' then 'parent'
    when 'bride_mother' then 'parent'
    when 'child' then 'child'
    when 'newborn' then 'child'
    when 'baptized' then 'child'
    when 'godchild' then 'child'
    when 'witness' then 'witness'
    when 'godparent' then 'godparent'
    when 'relative' then 'relative'
    when 'official' then 'official'
    when 'officiant' then 'official'
    when 'priest' then 'official'
    when 'registrar' then 'official'
    when 'midwife' then 'official'
    when 'informant' then 'official'
    when 'mentioned_person' then 'mentioned'
    else 'other'
  end
$function$;

create or replace function security_private.zagulyaky_tabular_import_public_text_v1(
  p_value text,
  p_max_length integer
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  result_value text;
begin
  if p_value is null then return null; end if;
  result_value := regexp_replace(p_value, 'https?://[^[:space:]]+', '[приватне посилання]', 'gi');
  result_value := nullif(btrim(left(result_value, p_max_length)), '');
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_workbook_row_v1(
  p_row jsonb
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  private_row jsonb;
begin
  if p_row is null or jsonb_typeof(p_row) <> 'object' then
    raise exception 'INVALID_TABULAR_ROW' using errcode = '22023';
  end if;
  private_row := case
    when p_row ? 'workbook_row_private' then p_row -> 'workbook_row_private'
    else p_row
  end;
  if private_row is null or jsonb_typeof(private_row) <> 'object'
    or octet_length(private_row::text) > 524288 then
    raise exception 'INVALID_TABULAR_PRIVATE_ROW' using errcode = '22023';
  end if;
  return private_row;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_json_array_v1(
  p_row jsonb,
  p_key text,
  p_maximum_bytes integer default 16000
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  result_value jsonb;
begin
  result_value := p_row -> p_key;
  if result_value is null or result_value = 'null'::jsonb then return '[]'::jsonb; end if;
  if jsonb_typeof(result_value) <> 'array' or octet_length(result_value::text) > p_maximum_bytes then
    raise exception 'INVALID_TABULAR_JSON_ARRAY:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_integer_alias_v1(
  p_row jsonb,
  p_primary_key text,
  p_fallback_key text,
  p_min integer,
  p_max integer
)
returns integer
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
begin
  if p_row ? p_primary_key and p_row -> p_primary_key is distinct from 'null'::jsonb
    and nullif(btrim(coalesce(p_row ->> p_primary_key, '')), '') is not null then
    return security_private.zagulyaky_tabular_import_integer_v1(p_row, p_primary_key, p_min, p_max, false);
  end if;
  return security_private.zagulyaky_tabular_import_integer_v1(p_row, p_fallback_key, p_min, p_max, false);
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_date_v1(
  p_row jsonb,
  p_key text
)
returns date
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  text_value text;
  result_value date;
begin
  text_value := security_private.zagulyaky_tabular_import_text_v1(p_row, p_key, 32, false);
  if text_value is null then return null; end if;
  begin
    result_value := text_value::date;
  exception when others then
    raise exception 'INVALID_TABULAR_DATE:%', p_key using errcode = '22023';
  end;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_catalogue_event_type_v1(
  p_event_type_code text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select case lower(btrim(coalesce(p_event_type_code, '')))
    when 'birth' then 'birth'
    when 'baptism' then 'baptism'
    when 'christening' then 'baptism'
    when 'marriage' then 'marriage'
    when 'wedding' then 'marriage'
    when 'death' then 'death'
    when 'burial' then 'burial'
    when 'residence' then 'residence'
    when 'residence_record' then 'residence'
    when 'military' then 'military'
    when 'military_service' then 'military'
    -- A combined civil/church event is not silently reduced to just one
    -- catalogue event.  Its exact wording remains in the private ledger.
    when 'birth_and_baptism' then 'other'
    when 'court_record' then 'other'
    when 'property_record' then 'other'
    when 'divorce' then 'other'
    else 'other'
  end
$function$;

create or replace function security_private.zagulyaky_tabular_import_supplied_structural_role_v1(
  p_structural_role_code text
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
  select case lower(btrim(coalesce(p_structural_role_code, '')))
    when 'subject' then 'subject'
    when 'spouse' then 'spouse'
    when 'parent' then 'parent'
    when 'child' then 'child'
    when 'witness' then 'witness'
    when 'godparent' then 'godparent'
    when 'official' then 'official'
    when 'relative' then 'relative'
    when 'mentioned' then 'mentioned'
    when 'other' then 'other'
    else null
  end
$function$;

create or replace function security_private.zagulyaky_tabular_import_expected_count_v1(
  p_counts jsonb,
  p_key text,
  p_maximum integer
)
returns integer
language plpgsql
immutable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  raw_value jsonb;
  text_value text;
  result_value integer;
begin
  if jsonb_typeof(p_counts) <> 'object' then
    raise exception 'INVALID_TABULAR_EXPECTED_COUNTS' using errcode = '22023';
  end if;
  raw_value := p_counts -> p_key;
  if raw_value is null or raw_value = 'null'::jsonb then
    raise exception 'TABULAR_EXPECTED_COUNT_REQUIRED:%', p_key using errcode = '22023';
  end if;
  if jsonb_typeof(raw_value) not in ('number', 'string') then
    raise exception 'TABULAR_EXPECTED_COUNT_INVALID:%', p_key using errcode = '22023';
  end if;
  text_value := raw_value #>> '{}';
  if text_value !~ '^[0-9]{1,9}$' then
    raise exception 'TABULAR_EXPECTED_COUNT_INVALID:%', p_key using errcode = '22023';
  end if;
  result_value := text_value::integer;
  if result_value > p_maximum then
    raise exception 'TABULAR_EXPECTED_COUNT_TOO_LARGE:%', p_key using errcode = '22023';
  end if;
  return result_value;
end;
$function$;

create or replace function security_private.zagulyaky_tabular_import_batch_summary_v1(
  p_batch public.zagulyaky_tabular_import_batches
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select jsonb_build_object(
    'batchId', p_batch.id,
    'sourceFileName', p_batch.source_file_name,
    'sourceChecksum', p_batch.source_checksum,
    'importMode', p_batch.import_mode,
    'status', p_batch.status,
    'expectedCounts', jsonb_build_object(
      'sourcePosts', p_batch.expected_source_post_count,
      'events', p_batch.expected_event_count,
      'participants', p_batch.expected_participant_count,
      'eventSources', p_batch.expected_event_source_count,
      'cards', p_batch.expected_card_count,
      'qc', p_batch.expected_qc_count,
      'eventsWithoutCards', p_batch.expected_no_card_event_count
    ),
    'actualCounts', jsonb_build_object(
      'sourcePosts', p_batch.source_post_count,
      'events', p_batch.event_count,
      'participants', p_batch.participant_count,
      'eventSources', p_batch.event_source_count,
      'cards', p_batch.card_count,
      'qc', p_batch.qc_count,
      'eventsWithoutCards', p_batch.no_card_event_count,
      'chunks', p_batch.chunk_count,
      'materializedCards', p_batch.materialized_card_count,
      'failedCards', p_batch.failed_card_count
    ),
    'receivedAt', p_batch.received_at,
    'dryRunCompletedAt', p_batch.dry_run_completed_at,
    'commitStartedAt', p_batch.commit_started_at,
    'completedAt', p_batch.completed_at,
    'lastErrorCode', p_batch.last_error_code
  )
$function$;

create or replace function security_private.admin_begin_zagulyaky_tabular_event_import_v1(
  p_source_file_name text,
  p_source_checksum text,
  p_expected_counts jsonb,
  p_import_mode text default 'dry_run'
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  normalized_file_name text := btrim(coalesce(p_source_file_name, ''));
  normalized_checksum text := lower(btrim(coalesce(p_source_checksum, '')));
  normalized_import_mode text := lower(btrim(coalesce(p_import_mode, '')));
  expected_source_posts integer;
  expected_events integer;
  expected_participants integer;
  expected_event_sources integer;
  expected_cards integer;
  expected_qc integer;
  expected_no_card_events integer;
  batch_row public.zagulyaky_tabular_import_batches;
  created_new boolean := false;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if normalized_file_name = ''
    or normalized_file_name !~* '[.]xlsx$'
    or position(chr(0) in normalized_file_name) > 0
    or normalized_file_name ~ '[\\/]' then
    raise exception 'INVALID_TABULAR_SOURCE_FILE_NAME' using errcode = '22023';
  end if;
  if normalized_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TABULAR_SOURCE_CHECKSUM' using errcode = '22023';
  end if;
  if normalized_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;

  expected_source_posts := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'sourcePosts', 50000);
  expected_events := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'events', 200000);
  expected_participants := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'participants', 500000);
  expected_event_sources := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'eventSources', 500000);
  expected_cards := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'cards', 500000);
  expected_qc := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'qc', 500000);
  expected_no_card_events := security_private.zagulyaky_tabular_import_expected_count_v1(p_expected_counts, 'eventsWithoutCards', 200000);

  insert into public.zagulyaky_tabular_import_batches(
    source_file_name, source_checksum, import_mode, status,
    expected_source_post_count, expected_event_count, expected_participant_count,
    expected_event_source_count, expected_card_count, expected_qc_count,
    expected_no_card_event_count, requested_by
  ) values (
    normalized_file_name, normalized_checksum, 'dry_run', 'received',
    expected_source_posts, expected_events, expected_participants,
    expected_event_sources, expected_cards, expected_qc,
    expected_no_card_events, current_user_id
  )
  on conflict (source_checksum) do nothing
  returning * into batch_row;

  if found then
    created_new := true;
  else
    select * into batch_row
    from public.zagulyaky_tabular_import_batches
    where source_checksum = normalized_checksum
    for update;

    if batch_row.expected_source_post_count <> expected_source_posts
      or batch_row.expected_event_count <> expected_events
      or batch_row.expected_participant_count <> expected_participants
      or batch_row.expected_event_source_count <> expected_event_sources
      or batch_row.expected_card_count <> expected_cards
      or batch_row.expected_qc_count <> expected_qc
      or batch_row.expected_no_card_event_count <> expected_no_card_events then
      raise exception 'TABULAR_SOURCE_CHECKSUM_METADATA_CONFLICT' using errcode = '23514';
    end if;
  end if;

  if created_new then
    if normalized_import_mode <> 'dry_run' then
      raise exception 'DRY_RUN_REQUIRED' using errcode = '23514';
    end if;
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', false);
  end if;

  if normalized_import_mode = 'dry_run' then
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', true);
  end if;

  if batch_row.status = 'dry_run_complete' then
    update public.zagulyaky_tabular_import_batches
    set import_mode = 'commit',
        status = 'commit_ready',
        commit_started_at = now(),
        requested_by = current_user_id,
        updated_at = now(),
        last_error_code = null
    where id = batch_row.id
    returning * into batch_row;
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', false);
  end if;

  if batch_row.status in ('commit_ready', 'commit_materializing', 'completed') then
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('replayed', true);
  end if;

  raise exception 'DRY_RUN_NOT_COMPLETE' using errcode = '23514';
end;
$function$;

create or replace function public.admin_begin_zagulyaky_tabular_event_import_v1(
  p_source_file_name text,
  p_source_checksum text,
  p_expected_counts jsonb,
  p_import_mode text default 'dry_run'
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_begin_zagulyaky_tabular_event_import_v1($1, $2, $3, $4)
$function$;

create or replace function security_private.admin_get_zagulyaky_tabular_event_import_v1(
  p_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  batch_row public.zagulyaky_tabular_import_batches;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select * into batch_row from public.zagulyaky_tabular_import_batches where id = p_batch_id;
  if not found then raise exception 'TABULAR_IMPORT_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row);
end;
$function$;

create or replace function public.admin_get_zagulyaky_tabular_event_import_v1(
  p_batch_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaky_tabular_event_import_v1($1)
$function$;

create or replace function security_private.admin_list_zagulyaky_tabular_event_imports_v1(
  p_status text default null,
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
  safe_status text := nullif(lower(btrim(coalesce(p_status, ''))), '');
  safe_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if safe_status is not null and safe_status not in (
    'received', 'processing', 'dry_run_complete', 'commit_ready',
    'commit_materializing', 'completed', 'completed_with_errors',
    'failed', 'cancelled'
  ) then
    raise exception 'INVALID_TABULAR_IMPORT_STATUS' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
        order by batch_row.received_at desc, batch_row.id desc)
      from (
        select *
        from public.zagulyaky_tabular_import_batches
        where safe_status is null or status = safe_status
        order by received_at desc, id desc
        limit safe_limit offset safe_offset
      ) batch_row
    ), '[]'::jsonb),
    'limit', safe_limit,
    'offset', safe_offset
  );
end;
$function$;

create or replace function public.admin_list_zagulyaky_tabular_event_imports_v1(
  p_status text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_list_zagulyaky_tabular_event_imports_v1($1, $2, $3)
$function$;

create or replace function security_private.service_ingest_zagulyaky_tabular_event_import_chunk_v1(
  p_batch_id uuid,
  p_chunk jsonb,
  p_import_mode text,
  p_chunk_index integer,
  p_chunk_checksum text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  batch_row public.zagulyaky_tabular_import_batches;
  receipt_row public.zagulyaky_tabular_import_chunks;
  row_value jsonb;
  source_rows jsonb;
  event_rows jsonb;
  participant_rows jsonb;
  event_source_rows jsonb;
  card_rows jsonb;
  qc_rows jsonb;
  normalized_import_mode text := lower(btrim(coalesce(p_import_mode, '')));
  normalized_checksum text := lower(btrim(coalesce(p_chunk_checksum, '')));
  source_row_count integer;
  event_row_count integer;
  participant_row_count integer;
  event_source_row_count integer;
  card_row_count integer;
  qc_row_count integer;
  total_row_count integer;
  value_key text;
  linked_event_post_key text;
  linked_participant_event_key text;
  sex_value text;
  role_value text;
  severity_value text;
  permission_status_value text;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVER_IMPORT_REQUIRED' using errcode = '42501';
  end if;
  if normalized_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;
  if p_chunk_index not between 0 and 100000 then
    raise exception 'INVALID_TABULAR_CHUNK_INDEX' using errcode = '22023';
  end if;
  if normalized_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_TABULAR_CHUNK_CHECKSUM' using errcode = '22023';
  end if;
  if p_chunk is null or jsonb_typeof(p_chunk) <> 'object' then
    raise exception 'INVALID_TABULAR_IMPORT_CHUNK' using errcode = '22023';
  end if;

  source_rows := coalesce(p_chunk -> 'sourcePosts', '[]'::jsonb);
  event_rows := coalesce(p_chunk -> 'events', '[]'::jsonb);
  participant_rows := coalesce(p_chunk -> 'participants', '[]'::jsonb);
  event_source_rows := coalesce(p_chunk -> 'eventSources', '[]'::jsonb);
  card_rows := coalesce(p_chunk -> 'cards', '[]'::jsonb);
  qc_rows := coalesce(p_chunk -> 'qc', '[]'::jsonb);
  if jsonb_typeof(source_rows) <> 'array'
    or jsonb_typeof(event_rows) <> 'array'
    or jsonb_typeof(participant_rows) <> 'array'
    or jsonb_typeof(event_source_rows) <> 'array'
    or jsonb_typeof(card_rows) <> 'array'
    or jsonb_typeof(qc_rows) <> 'array' then
    raise exception 'INVALID_TABULAR_IMPORT_CHUNK' using errcode = '22023';
  end if;
  source_row_count := jsonb_array_length(source_rows);
  event_row_count := jsonb_array_length(event_rows);
  participant_row_count := jsonb_array_length(participant_rows);
  event_source_row_count := jsonb_array_length(event_source_rows);
  card_row_count := jsonb_array_length(card_rows);
  qc_row_count := jsonb_array_length(qc_rows);
  total_row_count := source_row_count + event_row_count + participant_row_count
    + event_source_row_count + card_row_count + qc_row_count;
  if total_row_count not between 1 and 250 then
    raise exception 'INVALID_TABULAR_IMPORT_CHUNK_SIZE' using errcode = '22023';
  end if;

  select * into batch_row
  from public.zagulyaky_tabular_import_batches
  where id = p_batch_id
  for update;
  if not found then raise exception 'TABULAR_IMPORT_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  if batch_row.import_mode <> normalized_import_mode then
    raise exception 'IMPORT_MODE_MISMATCH' using errcode = '23514';
  end if;
  if batch_row.status not in ('received', 'processing') then
    raise exception 'TABULAR_IMPORT_BATCH_NOT_ACCEPTING_CHUNKS' using errcode = '23514';
  end if;

  select * into receipt_row
  from public.zagulyaky_tabular_import_chunks
  where batch_id = p_batch_id
    and import_mode = normalized_import_mode
    and chunk_index = p_chunk_index
  for update;
  if found then
    if receipt_row.payload_checksum is distinct from normalized_checksum then
      raise exception 'CHUNK_CHECKSUM_MISMATCH' using errcode = '23514';
    end if;
    if receipt_row.source_post_count <> source_row_count
      or receipt_row.event_count <> event_row_count
      or receipt_row.participant_count <> participant_row_count
      or receipt_row.event_source_count <> event_source_row_count
      or receipt_row.card_count <> card_row_count
      or receipt_row.qc_count <> qc_row_count then
      raise exception 'CHUNK_REPLAY_MISMATCH' using errcode = '23514';
    end if;
    return jsonb_build_object(
      'batchId', p_batch_id,
      'chunkIndex', p_chunk_index,
      'replayed', true,
      'sourcePostCount', receipt_row.source_post_count,
      'eventCount', receipt_row.event_count,
      'participantCount', receipt_row.participant_count,
      'eventSourceCount', receipt_row.event_source_count,
      'cardCount', receipt_row.card_count,
      'qcCount', receipt_row.qc_count
    );
  end if;

  if batch_row.source_post_count + source_row_count > batch_row.expected_source_post_count
    or batch_row.event_count + event_row_count > batch_row.expected_event_count
    or batch_row.participant_count + participant_row_count > batch_row.expected_participant_count
    or batch_row.event_source_count + event_source_row_count > batch_row.expected_event_source_count
    or batch_row.card_count + card_row_count > batch_row.expected_card_count
    or batch_row.qc_count + qc_row_count > batch_row.expected_qc_count then
    raise exception 'TABULAR_IMPORT_EXPECTED_COUNT_EXCEEDED' using errcode = '23514';
  end if;

  -- References are resolved in this order.  The Edge worker must therefore
  -- put sourcePosts before events, events before participants/eventSources,
  -- and cards/QC last when it needs cross-row references in one chunk.
  for row_value in select value from jsonb_array_elements(source_rows)
  loop
    value_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'post_key');
    insert into public.zagulyaky_tabular_import_source_posts(
      batch_id, post_key, source_platform, facebook_post_url_private,
      source_collection_url_private, source_author_label_private,
      source_date_text, source_date_precision, source_published_at,
      source_collected_at, source_file_name_original, source_row_number,
      post_text_complete, content_sha256, source_title_original,
      post_original_text, source_language, privacy_scope, source_status,
      source_notes, workbook_row_private
    ) values (
      p_batch_id,
      value_key,
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_platform', 120, false), 'facebook'),
      security_private.zagulyaky_tabular_import_url_v1(row_value, 'facebook_post_url_private'),
      security_private.zagulyaky_tabular_import_url_v1(row_value, 'source_collection_url_private'),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_author_label_private', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'source_date_text', 500, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_date_precision', 80, false),
      security_private.zagulyaky_tabular_import_timestamp_v1(row_value, 'source_published_at'),
      security_private.zagulyaky_tabular_import_timestamp_v1(row_value, 'source_collected_at'),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_file_name_original', 255, false),
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'source_row_number', 1, 100000000, false),
      security_private.zagulyaky_tabular_import_boolean_v1(row_value, 'post_text_complete', true),
      lower(security_private.zagulyaky_tabular_import_text_v1(row_value, 'content_sha256', 64, false)),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_title_original', 2000, false),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'post_original_text', 250000, false), ''),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_language', 80, false),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'privacy_scope', 40, false), 'private_source'),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_status', 80, false), 'staged'),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'source_notes', 12000, false), ''),
      security_private.zagulyaky_tabular_import_workbook_row_v1(row_value)
    ) on conflict (batch_id, post_key) do nothing;
    if not found then
      raise exception 'DUPLICATE_TABULAR_POST_KEY' using errcode = '23514';
    end if;
  end loop;

  for row_value in select value from jsonb_array_elements(event_rows)
  loop
    value_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'event_key');
    linked_event_post_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'post_key');
    if not exists (
      select 1 from public.zagulyaky_tabular_import_source_posts
      where batch_id = p_batch_id and post_key = linked_event_post_key
    ) then
      raise exception 'TABULAR_EVENT_POST_NOT_FOUND' using errcode = '23503';
    end if;
    insert into public.zagulyaky_tabular_import_events(
      batch_id, event_key, event_group_key, post_key, event_sequence,
      event_type_code, event_type_original, event_date_original, event_year,
      event_year_from, event_year_to, event_month, event_day, date_precision, calendar_style,
      event_place_original, church_or_parish_original, record_number_original,
      event_place_normalized, archive_repository_original, archive_reference_original,
      page_or_folio_original, document_title_original, document_language,
      record_types_private, document_url_private, event_original_text,
      event_summary, event_status, event_notes, event_confidence, review_status,
      uncertainty_notes, workbook_row_private
    ) values (
      p_batch_id,
      value_key,
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_group_key', 200, false),
      linked_event_post_key,
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'event_sequence', 1, 1000000, true),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_type_code', 120, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_type_original', 500, false),
      -- Date descriptions in the workbook sometimes include a full archival
      -- qualification, not merely a short formatted date.  Preserve the
      -- source-faithful value privately up to 4 KiB rather than rejecting a
      -- valid 501-character date description.
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_date_original', 4000, false),
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'event_year', 1, 2200, false),
      security_private.zagulyaky_tabular_import_integer_alias_v1(row_value, 'event_year_from', 'event_year', 1, 2200),
      security_private.zagulyaky_tabular_import_integer_alias_v1(row_value, 'event_year_to', 'event_year', 1, 2200),
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'event_month', 1, 12, false),
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'event_day', 1, 31, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'date_precision', 20, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'calendar_style', 80, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_place_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'church_or_parish_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'record_number_original', 500, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_place_normalized', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'archive_repository_original', 2000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'archive_reference_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'page_or_folio_original', 500, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'document_title_original', 4000, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'document_language', 80, false),
      security_private.zagulyaky_tabular_import_json_array_v1(row_value, 'record_types'),
      security_private.zagulyaky_tabular_import_url_v1(row_value, 'document_url_private'),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_original_text', 100000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_summary', 12000, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_status', 80, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_notes', 12000, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_confidence', 80, false),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'review_status', 80, false), 'private_staging'),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'uncertainty_notes', 12000, false), ''),
      security_private.zagulyaky_tabular_import_workbook_row_v1(row_value)
    ) on conflict (batch_id, event_key) do nothing;
    if not found then
      raise exception 'DUPLICATE_TABULAR_EVENT_KEY' using errcode = '23514';
    end if;
  end loop;

  for row_value in select value from jsonb_array_elements(participant_rows)
  loop
    value_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'participant_key');
    linked_event_post_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'post_key');
    linked_participant_event_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'event_key');
    select event_row.post_key into linked_event_post_key
    from public.zagulyaky_tabular_import_events event_row
    where event_row.batch_id = p_batch_id and event_row.event_key = linked_participant_event_key;
    if not found then
      raise exception 'TABULAR_PARTICIPANT_EVENT_NOT_FOUND' using errcode = '23503';
    end if;
    if linked_event_post_key is distinct from security_private.zagulyaky_tabular_import_key_v1(row_value, 'post_key') then
      raise exception 'TABULAR_PARTICIPANT_POST_MISMATCH' using errcode = '23514';
    end if;
    sex_value := lower(coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'sex', 16, false), ''));
    if sex_value <> '' and sex_value not in ('male', 'female', 'unknown') then
      raise exception 'INVALID_TABULAR_PARTICIPANT_SEX' using errcode = '22023';
    end if;
    role_value := security_private.zagulyaky_tabular_import_role_code_v1(
      coalesce(
        security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_role_code', 120, false),
        security_private.zagulyaky_tabular_import_text_v1(row_value, 'role_code', 120, false)
      )
    );
    insert into public.zagulyaky_tabular_import_participants(
      batch_id, participant_key, person_card_key, event_key, post_key,
      participant_sequence, full_name_original, surname_original,
      given_name_original, patronymic_original, name_normalized,
      maiden_name_original, structural_role_code, role_code, role_original,
      event_role_custom, sex, origin_original, residence_original,
      social_estate_text, occupation_or_rank_text, marital_status_text,
      age_original, age_years, relation_original, participant_original_text,
      evidence_excerpt, field_confidence, privacy_review_required,
      possible_living_person, participant_status, duplicate_key,
      participant_notes, review_status, uncertainty_notes, private_search_text,
      workbook_row_private
    ) values (
      p_batch_id,
      value_key,
      security_private.zagulyaky_tabular_import_key_v1(row_value, 'person_card_key'),
      linked_participant_event_key,
      linked_event_post_key,
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'participant_sequence', 1, 1000000, true),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'full_name_original', 2000, false), ''),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'surname_original', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'given_name_original', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'patronymic_original', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'name_normalized', 2000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'maiden_name_original', 1000, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'structural_role_code', 40, false),
      role_value,
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'role_original', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'event_role_custom', 160, false),
      nullif(sex_value, ''),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'origin_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'residence_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'social_estate_text', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'occupation_or_rank_text', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'marital_status_text', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'age_original', 500, false),
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'age_years', 0, 140, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'relation_original', 1000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'participant_original_text', 100000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'evidence_excerpt', 4000, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'field_confidence', 80, false),
      security_private.zagulyaky_tabular_import_boolean_v1(row_value, 'privacy_review_required', false),
      security_private.zagulyaky_tabular_import_boolean_v1(row_value, 'possible_living_person', false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'participant_status', 80, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'duplicate_key', 200, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'participant_notes', 12000, false),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'review_status', 80, false), 'private_staging'),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'uncertainty_notes', 12000, false), ''),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'private_search_text', 12000, false), ''),
      security_private.zagulyaky_tabular_import_workbook_row_v1(row_value)
    ) on conflict (batch_id, participant_key) do nothing;
    if not found then
      raise exception 'DUPLICATE_TABULAR_PARTICIPANT_KEY' using errcode = '23514';
    end if;
  end loop;

  for row_value in select value from jsonb_array_elements(event_source_rows)
  loop
    value_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'event_source_key');
    linked_participant_event_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'event_key');
    select event_row.post_key into linked_event_post_key
    from public.zagulyaky_tabular_import_events event_row
    where event_row.batch_id = p_batch_id and event_row.event_key = linked_participant_event_key;
    if not found then
      raise exception 'TABULAR_EVENT_SOURCE_EVENT_NOT_FOUND' using errcode = '23503';
    end if;
    if linked_event_post_key is distinct from security_private.zagulyaky_tabular_import_key_v1(row_value, 'post_key') then
      raise exception 'TABULAR_EVENT_SOURCE_POST_MISMATCH' using errcode = '23514';
    end if;
    permission_status_value := lower(coalesce(
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'permission_status', 40, false),
      'not_reviewed'
    ));
    if permission_status_value not in (
      'not_reviewed', 'unknown', 'link_only', 'permission_granted', 'public_domain', 'restricted'
    ) then
      raise exception 'INVALID_TABULAR_EVENT_SOURCE_PERMISSION' using errcode = '22023';
    end if;
    insert into public.zagulyaky_tabular_import_event_sources(
      batch_id, event_source_key, event_key, post_key, event_source_sequence,
      document_type, document_title_original, archive_repository_original,
      archive_reference_original, page_or_folio_original, record_number_original,
      document_url_private, source_original_text, permission_status, confidence,
      is_primary, source_platform, external_id, access_date, review_status,
      uncertainty_notes, private_search_text, workbook_row_private
    ) values (
      p_batch_id,
      value_key,
      linked_participant_event_key,
      linked_event_post_key,
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'event_source_sequence', 1, 1000000, true),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'document_type', 120, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'document_title_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'archive_repository_original', 2000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'archive_reference_original', 4000, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'page_or_folio_original', 500, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'record_number_original', 500, false),
      security_private.zagulyaky_tabular_import_url_v1(row_value, 'document_url_private'),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'source_original_text', 100000, false),
      permission_status_value,
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'confidence', 80, false),
      security_private.zagulyaky_tabular_import_boolean_v1(row_value, 'is_primary', false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'source_platform', 120, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'external_id', 500, false),
      security_private.zagulyaky_tabular_import_date_v1(row_value, 'access_date'),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'review_status', 80, false), 'private_staging'),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'uncertainty_notes', 12000, false), ''),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'private_search_text', 12000, false), ''),
      security_private.zagulyaky_tabular_import_workbook_row_v1(row_value)
    ) on conflict (batch_id, event_source_key) do nothing;
    if not found then
      raise exception 'DUPLICATE_TABULAR_EVENT_SOURCE_KEY' using errcode = '23514';
    end if;
  end loop;

  for row_value in select value from jsonb_array_elements(card_rows)
  loop
    value_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'card_key');
    linked_participant_event_key := security_private.zagulyaky_tabular_import_key_v1(row_value, 'event_key');
    select event_row.post_key into linked_event_post_key
    from public.zagulyaky_tabular_import_events event_row
    where event_row.batch_id = p_batch_id and event_row.event_key = linked_participant_event_key;
    if not found then
      raise exception 'TABULAR_CARD_EVENT_NOT_FOUND' using errcode = '23503';
    end if;
    if linked_event_post_key is distinct from security_private.zagulyaky_tabular_import_key_v1(row_value, 'post_key') then
      raise exception 'TABULAR_CARD_POST_MISMATCH' using errcode = '23514';
    end if;
    if lower(coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'card_kind', 20, false), 'person')) = 'person'
      and not exists (
        select 1 from public.zagulyaky_tabular_import_participants participant_row
        where participant_row.batch_id = p_batch_id
          and participant_row.event_key = linked_participant_event_key
          and participant_row.participant_key = security_private.zagulyaky_tabular_import_key_v1(row_value, 'primary_participant_key')
      ) then
      raise exception 'TABULAR_CARD_PRIMARY_PARTICIPANT_NOT_FOUND' using errcode = '23503';
    end if;
    insert into public.zagulyaky_tabular_import_cards(
      batch_id, card_key, post_key, event_key, card_sequence, card_kind,
      primary_participant_key, card_title_original, card_summary,
      card_original_text, card_normalized_text, classification_reason,
      possible_living_person, requested_verification_status,
      requested_privacy_status, requested_publication_status, card_status,
      copy_event_participants, duplicate_key, card_notes, review_status,
      uncertainty_notes, workbook_row_private
    ) values (
      p_batch_id,
      value_key,
      linked_event_post_key,
      linked_participant_event_key,
      security_private.zagulyaky_tabular_import_integer_v1(row_value, 'card_sequence', 1, 1000000, true),
      lower(coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'card_kind', 20, false), 'person')),
      security_private.zagulyaky_tabular_import_key_v1(row_value, 'primary_participant_key'),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'card_title_original', 300, false),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'card_summary', 4000, false), ''),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'card_original_text', 100000, false), ''),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'card_normalized_text', 100000, false), ''),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'classification_reason', 4000, false), 'Initial private tabular import.'),
      security_private.zagulyaky_tabular_import_boolean_v1(row_value, 'possible_living_person', false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'verification_status', 80, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'privacy_status', 80, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'publication_status', 80, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'card_status', 80, false),
      security_private.zagulyaky_tabular_import_boolean_v1(row_value, 'copy_event_participants', true),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'duplicate_key', 200, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'card_notes', 12000, false),
      coalesce(security_private.zagulyaky_tabular_import_text_v1(row_value, 'review_status', 80, false), 'private_staging'),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'uncertainty_notes', 12000, false), ''),
      security_private.zagulyaky_tabular_import_workbook_row_v1(row_value)
    ) on conflict (card_key) do nothing;
    if not found then
      raise exception 'DUPLICATE_TABULAR_CARD_KEY' using errcode = '23514';
    end if;
  end loop;

  for row_value in select value from jsonb_array_elements(qc_rows)
  loop
    severity_value := lower(security_private.zagulyaky_tabular_import_text_v1(row_value, 'severity', 16, true));
    if severity_value not in ('info', 'warning', 'error') then
      raise exception 'INVALID_TABULAR_QC_SEVERITY' using errcode = '22023';
    end if;
    insert into public.zagulyaky_tabular_import_qc(
      batch_id, post_key, event_key, participant_key, severity, qc_code,
      field_name, source_excerpt, note, review_status, workbook_row_private
    ) values (
      p_batch_id,
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'post_key', 200, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'event_key', 200, false),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'participant_key', 200, false),
      severity_value,
      upper(security_private.zagulyaky_tabular_import_text_v1(row_value, 'qc_code', 100, true)),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'field_name', 200, false),
      security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'source_excerpt', 12000, false),
      coalesce(security_private.zagulyaky_tabular_import_raw_text_v1(row_value, 'note', 12000, false), ''),
      security_private.zagulyaky_tabular_import_text_v1(row_value, 'review_status', 80, false),
      security_private.zagulyaky_tabular_import_workbook_row_v1(row_value)
    );
  end loop;

  insert into public.zagulyaky_tabular_import_chunks(
    batch_id, import_mode, chunk_index, payload_checksum,
    source_post_count, event_count, participant_count, event_source_count,
    card_count, qc_count, completed_at
  ) values (
    p_batch_id, normalized_import_mode, p_chunk_index, normalized_checksum,
    source_row_count, event_row_count, participant_row_count, event_source_row_count,
    card_row_count, qc_row_count, now()
  );

  update public.zagulyaky_tabular_import_batches
  set status = 'processing',
      source_post_count = source_post_count + source_row_count,
      event_count = event_count + event_row_count,
      participant_count = participant_count + participant_row_count,
      event_source_count = event_source_count + event_source_row_count,
      card_count = card_count + card_row_count,
      qc_count = qc_count + qc_row_count,
      chunk_count = chunk_count + 1,
      updated_at = now()
  where id = p_batch_id
  returning * into batch_row;

  return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
    || jsonb_build_object('chunkIndex', p_chunk_index, 'replayed', false);
end;
$function$;

create or replace function public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(
  p_batch_id uuid,
  p_chunk jsonb,
  p_import_mode text,
  p_chunk_index integer,
  p_chunk_checksum text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.service_ingest_zagulyaky_tabular_event_import_chunk_v1($1, $2, $3, $4, $5)
$function$;

create or replace function security_private.service_finalize_zagulyaky_tabular_event_import_v1(
  p_batch_id uuid,
  p_import_mode text,
  p_materialize_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  batch_row public.zagulyaky_tabular_import_batches;
  card_row public.zagulyaky_tabular_import_cards;
  event_row public.zagulyaky_tabular_import_events;
  primary_participant_row public.zagulyaky_tabular_import_participants;
  normalized_import_mode text := lower(btrim(coalesce(p_import_mode, '')));
  safe_materialize_limit integer := greatest(1, least(coalesce(p_materialize_limit, 250), 500));
  actual_source_post_count integer;
  actual_event_count integer;
  actual_participant_count integer;
  actual_event_source_count integer;
  actual_card_count integer;
  actual_qc_count integer;
  actual_no_card_event_count integer;
  remaining_card_count integer;
  failed_card_count integer;
  materialized_in_call integer := 0;
  materialized_possible_living boolean;
  new_record_id uuid;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVER_IMPORT_REQUIRED' using errcode = '42501';
  end if;
  if normalized_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;

  select * into batch_row
  from public.zagulyaky_tabular_import_batches
  where id = p_batch_id
  for update;
  if not found then raise exception 'TABULAR_IMPORT_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;

  if normalized_import_mode = 'commit' and batch_row.import_mode <> 'commit' then
    raise exception 'DRY_RUN_REQUIRED' using errcode = '23514';
  end if;
  if normalized_import_mode = 'dry_run' and batch_row.import_mode <> 'dry_run' then
    raise exception 'IMPORT_MODE_MISMATCH' using errcode = '23514';
  end if;
  if normalized_import_mode = 'commit' and batch_row.status not in ('commit_ready', 'commit_materializing', 'completed') then
    raise exception 'DRY_RUN_NOT_COMPLETE' using errcode = '23514';
  end if;
  if normalized_import_mode = 'dry_run' and batch_row.status not in ('received', 'processing', 'dry_run_complete') then
    raise exception 'TABULAR_IMPORT_NOT_FINALIZABLE' using errcode = '23514';
  end if;

  select count(*)::integer into actual_source_post_count
  from public.zagulyaky_tabular_import_source_posts
  where batch_id = p_batch_id;
  select count(*)::integer into actual_event_count
  from public.zagulyaky_tabular_import_events
  where batch_id = p_batch_id;
  select count(*)::integer into actual_participant_count
  from public.zagulyaky_tabular_import_participants
  where batch_id = p_batch_id;
  select count(*)::integer into actual_event_source_count
  from public.zagulyaky_tabular_import_event_sources
  where batch_id = p_batch_id;
  select count(*)::integer into actual_card_count
  from public.zagulyaky_tabular_import_cards
  where batch_id = p_batch_id;
  select count(*)::integer into actual_qc_count
  from public.zagulyaky_tabular_import_qc
  where batch_id = p_batch_id;
  select count(*)::integer into actual_no_card_event_count
  from public.zagulyaky_tabular_import_events event_candidate
  where event_candidate.batch_id = p_batch_id
    and not exists (
      select 1
      from public.zagulyaky_tabular_import_cards card_candidate
      where card_candidate.batch_id = event_candidate.batch_id
        and card_candidate.event_key = event_candidate.event_key
    );

  if actual_source_post_count <> batch_row.expected_source_post_count
    or actual_event_count <> batch_row.expected_event_count
    or actual_participant_count <> batch_row.expected_participant_count
    or actual_event_source_count <> batch_row.expected_event_source_count
    or actual_card_count <> batch_row.expected_card_count
    or actual_qc_count <> batch_row.expected_qc_count
    or actual_no_card_event_count <> batch_row.expected_no_card_event_count then
    raise exception 'TABULAR_IMPORT_COUNT_MISMATCH' using errcode = '23514';
  end if;

  -- Every relationship is rechecked after all chunks have arrived.  In
  -- particular, no-event posts remain valid, while an event/card may not
  -- point across a post or batch boundary.
  if exists (
    select 1
    from public.zagulyaky_tabular_import_events event_candidate
    where event_candidate.batch_id = p_batch_id
      and not exists (
        select 1 from public.zagulyaky_tabular_import_source_posts post_candidate
        where post_candidate.batch_id = event_candidate.batch_id
          and post_candidate.post_key = event_candidate.post_key
      )
  ) then
    raise exception 'TABULAR_EVENT_POST_NOT_FOUND' using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.zagulyaky_tabular_import_participants participant_candidate
    left join public.zagulyaky_tabular_import_events event_candidate
      on event_candidate.batch_id = participant_candidate.batch_id
      and event_candidate.event_key = participant_candidate.event_key
    where participant_candidate.batch_id = p_batch_id
      and (event_candidate.id is null or event_candidate.post_key is distinct from participant_candidate.post_key)
  ) then
    raise exception 'TABULAR_PARTICIPANT_EVENT_RELATION_INVALID' using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.zagulyaky_tabular_import_event_sources source_candidate
    left join public.zagulyaky_tabular_import_events event_candidate
      on event_candidate.batch_id = source_candidate.batch_id
      and event_candidate.event_key = source_candidate.event_key
    where source_candidate.batch_id = p_batch_id
      and (event_candidate.id is null or event_candidate.post_key is distinct from source_candidate.post_key)
  ) then
    raise exception 'TABULAR_EVENT_SOURCE_RELATION_INVALID' using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.zagulyaky_tabular_import_cards card_candidate
    left join public.zagulyaky_tabular_import_events event_candidate
      on event_candidate.batch_id = card_candidate.batch_id
      and event_candidate.event_key = card_candidate.event_key
    left join public.zagulyaky_tabular_import_participants primary_candidate
      on primary_candidate.batch_id = card_candidate.batch_id
      and primary_candidate.event_key = card_candidate.event_key
      and primary_candidate.participant_key = card_candidate.primary_participant_key
    where card_candidate.batch_id = p_batch_id
      and (
        event_candidate.id is null
        or event_candidate.post_key is distinct from card_candidate.post_key
        or (card_candidate.card_kind = 'person' and primary_candidate.id is null)
      )
  ) then
    raise exception 'TABULAR_CARD_RELATION_INVALID' using errcode = '23503';
  end if;
  if exists (
    select 1
    from public.zagulyaky_tabular_import_qc qc_candidate
    where qc_candidate.batch_id = p_batch_id
      and (
        (qc_candidate.post_key is not null and not exists (
          select 1 from public.zagulyaky_tabular_import_source_posts post_candidate
          where post_candidate.batch_id = qc_candidate.batch_id
            and post_candidate.post_key = qc_candidate.post_key
        ))
        or (qc_candidate.event_key is not null and not exists (
          select 1 from public.zagulyaky_tabular_import_events event_candidate
          where event_candidate.batch_id = qc_candidate.batch_id
            and event_candidate.event_key = qc_candidate.event_key
        ))
        or (qc_candidate.participant_key is not null and not exists (
          select 1 from public.zagulyaky_tabular_import_participants participant_candidate
          where participant_candidate.batch_id = qc_candidate.batch_id
            and participant_candidate.participant_key = qc_candidate.participant_key
        ))
      )
  ) then
    raise exception 'TABULAR_QC_REFERENCE_INVALID' using errcode = '23503';
  end if;

  update public.zagulyaky_tabular_import_batches
  set source_post_count = actual_source_post_count,
      event_count = actual_event_count,
      participant_count = actual_participant_count,
      event_source_count = actual_event_source_count,
      card_count = actual_card_count,
      qc_count = actual_qc_count,
      no_card_event_count = actual_no_card_event_count,
      updated_at = now(),
      last_error_code = null
  where id = p_batch_id
  returning * into batch_row;

  if normalized_import_mode = 'dry_run' then
    if batch_row.status <> 'dry_run_complete' then
      update public.zagulyaky_tabular_import_batches
      set status = 'dry_run_complete',
          dry_run_completed_at = now(),
          updated_at = now()
      where id = p_batch_id
      returning * into batch_row;
    end if;
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('materializedInCall', 0, 'remainingCardCount', batch_row.card_count);
  end if;

  if batch_row.status = 'completed' then
    return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
      || jsonb_build_object('materializedInCall', 0, 'remainingCardCount', 0, 'replayed', true);
  end if;

  for card_row in
    select *
    from public.zagulyaky_tabular_import_cards
    where batch_id = p_batch_id
      and materialization_status = 'pending'
    order by card_sequence, card_key
    limit safe_materialize_limit
    for update skip locked
  loop
    select * into event_row
    from public.zagulyaky_tabular_import_events
    where batch_id = p_batch_id and event_key = card_row.event_key;
    if not found then
      raise exception 'TABULAR_CARD_EVENT_NOT_FOUND' using errcode = '23503';
    end if;

    primary_participant_row := null;
    if card_row.card_kind = 'person' then
      select * into primary_participant_row
      from public.zagulyaky_tabular_import_participants
      where batch_id = p_batch_id
        and event_key = card_row.event_key
        and participant_key = card_row.primary_participant_key;
      if not found then
        raise exception 'TABULAR_CARD_PRIMARY_PARTICIPANT_NOT_FOUND' using errcode = '23503';
      end if;
    end if;
    -- A copied related person can be potentially living even when the card's
    -- primary participant is not.  Privacy is therefore derived from every
    -- participant that this specific card will actually materialize, not only
    -- from the primary participant.  This condition intentionally mirrors the
    -- participant INSERT below: a `copy_event_participants = false` card does
    -- not inherit a flag from an event participant it does not copy.
    materialized_possible_living := card_row.possible_living_person
      or exists (
        select 1
        from public.zagulyaky_tabular_import_participants participant_candidate
        where participant_candidate.batch_id = p_batch_id
          and participant_candidate.event_key = card_row.event_key
          and participant_candidate.possible_living_person
          and (
            card_row.copy_event_participants
            or participant_candidate.participant_key = card_row.primary_participant_key
          )
      );

    insert into public.zagulyaky_records(
      kind, status, verification_status, privacy_status,
      title, summary, original_text, normalized_text, original_language,
      event_type, event_date_text, event_year_from, event_year_to,
      date_precision, source_location_text, source_location_normalized,
      found_location_text, found_location_normalized, classification_reason,
      payload, possible_living_person, created_by
    ) values (
      card_row.card_kind,
      'draft',
      'unverified',
      case when materialized_possible_living then 'requires_consent' else 'pending' end,
      left(
        coalesce(
          nullif(btrim(card_row.card_title_original), ''),
          nullif(btrim(primary_participant_row.full_name_original), ''),
          nullif(btrim(event_row.document_title_original), ''),
          'Невідома загуляка'
        ),
        300
      ),
      coalesce(security_private.zagulyaky_tabular_import_public_text_v1(card_row.card_summary, 4000), ''),
      coalesce(security_private.zagulyaky_tabular_import_public_text_v1(card_row.card_original_text, 100000), ''),
      coalesce(security_private.zagulyaky_tabular_import_public_text_v1(card_row.card_normalized_text, 100000), ''),
      'uk',
      security_private.zagulyaky_tabular_import_catalogue_event_type_v1(event_row.event_type_code),
      security_private.zagulyaky_tabular_import_public_text_v1(event_row.event_date_original, 4000),
      event_row.event_year_from,
      event_row.event_year_to,
      event_row.date_precision,
      security_private.zagulyaky_tabular_import_public_text_v1(
        coalesce(event_row.church_or_parish_original, event_row.archive_repository_original), 4000
      ),
      null,
      security_private.zagulyaky_tabular_import_public_text_v1(event_row.event_place_original, 4000),
      security_private.zagulyaky_tabular_import_public_text_v1(event_row.event_place_normalized, 4000),
      coalesce(
        security_private.zagulyaky_tabular_import_public_text_v1(card_row.classification_reason, 4000),
        'Initial private tabular import.'
      ),
      jsonb_build_object(
        'importKind', 'tabular_event_v1',
        'batchId', p_batch_id,
        'cardKey', card_row.card_key,
        'eventKey', card_row.event_key
      ),
      materialized_possible_living,
      batch_row.requested_by
    ) returning id into new_record_id;

    -- A card can deliberately carry every participant of its event, or only
    -- its primary participant.  In both modes the named primary card
    -- participant becomes the structural `subject`, while the historical
    -- event role remains in event_role_code.
    insert into public.zagulyaky_participants(
      record_id, role, event_role_code, event_role_custom,
      original_full_name, normalized_uk_full_name, surname, given_name,
      patronymic, maiden_name, sex, age_text, residence_text, origin_text, notes,
      sort_order, social_estate_text, occupation_or_rank_text,
      marital_status_text, relation_original, evidence_excerpt
    )
    select
      new_record_id,
      case
        when participant_row.participant_key = card_row.primary_participant_key then 'subject'
        else coalesce(
          security_private.zagulyaky_tabular_import_supplied_structural_role_v1(participant_row.structural_role_code),
          security_private.zagulyaky_tabular_import_structural_role_v1(participant_row.role_code)
        )
      end,
      participant_row.role_code,
      case
        when participant_row.role_code = 'other' then coalesce(
          nullif(left(btrim(security_private.zagulyaky_tabular_import_public_text_v1(
            coalesce(participant_row.event_role_custom, participant_row.role_original), 160
          )), 160), ''),
          'інше'
        )
        else null
      end,
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.full_name_original, 2000),
      coalesce(
        security_private.zagulyaky_tabular_import_public_text_v1(participant_row.name_normalized, 2000),
        security_private.zagulyaky_tabular_import_public_text_v1(participant_row.full_name_original, 2000),
        ''
      ),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.surname_original, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.given_name_original, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.patronymic_original, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.maiden_name_original, 1000),
      participant_row.sex,
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.age_original, 500),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.residence_original, 4000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.origin_original, 4000),
      concat_ws(E'\n',
        case when participant_row.role_original is null then null
          else 'Роль у джерелі: ' || security_private.zagulyaky_tabular_import_public_text_v1(participant_row.role_original, 1000) end,
        case when participant_row.uncertainty_notes = '' then null
          else security_private.zagulyaky_tabular_import_public_text_v1(participant_row.uncertainty_notes, 4000) end
        , case when participant_row.participant_notes is null then null
          else security_private.zagulyaky_tabular_import_public_text_v1(participant_row.participant_notes, 4000) end
      ),
      participant_row.participant_sequence,
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.social_estate_text, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.occupation_or_rank_text, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.marital_status_text, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.relation_original, 1000),
      security_private.zagulyaky_tabular_import_public_text_v1(participant_row.evidence_excerpt, 4000)
    from public.zagulyaky_tabular_import_participants participant_row
    where participant_row.batch_id = p_batch_id
      and participant_row.event_key = card_row.event_key
      and (
        card_row.copy_event_participants
        or participant_row.participant_key = card_row.primary_participant_key
      )
    order by participant_row.participant_sequence, participant_row.participant_key;

    if card_row.card_kind = 'document' then
      insert into public.zagulyaky_document_discoveries(
        record_id, official_location_text, discovered_location_text,
        record_types, factual_year_from, factual_year_to, page_from, page_to,
        notes
      ) values (
        new_record_id,
        coalesce(security_private.zagulyaky_tabular_import_public_text_v1(event_row.archive_reference_original, 4000), ''),
        coalesce(security_private.zagulyaky_tabular_import_public_text_v1(event_row.event_place_original, 4000), ''),
        coalesce(array(
          select left(btrim(record_type_value #>> '{}'), 200)
          from jsonb_array_elements(event_row.record_types_private) record_type_value
          where jsonb_typeof(record_type_value) in ('string', 'number')
            and btrim(record_type_value #>> '{}') <> ''
        ), '{}'::text[]),
        event_row.event_year_from,
        event_row.event_year_to,
        security_private.zagulyaky_tabular_import_public_text_v1(event_row.page_or_folio_original, 500),
        security_private.zagulyaky_tabular_import_public_text_v1(event_row.page_or_folio_original, 500),
        coalesce(security_private.zagulyaky_tabular_import_public_text_v1(event_row.document_title_original, 4000), '')
      );
    end if;

    -- `zagulyaky_records_version` runs when the record row is inserted, which
    -- is necessarily before its participants/document discovery rows exist.
    -- Touch the record once after all materialized children have been written:
    -- the established BEFORE UPDATE trigger increments lock_version and the
    -- existing AFTER UPDATE trigger writes revision 2 with the complete
    -- reviewable snapshot.  No catalogue content or publication state changes.
    update public.zagulyaky_records
    set updated_at = updated_at
    where id = new_record_id;

    insert into public.zagulyaky_tabular_import_card_records(card_id, record_id, batch_id)
    values (card_row.id, new_record_id, p_batch_id);

    update public.zagulyaky_tabular_import_cards
    set materialization_status = 'materialized',
        materialization_error_code = null,
        materialized_at = now()
    where id = card_row.id;
    materialized_in_call := materialized_in_call + 1;
  end loop;

  select count(*)::integer into remaining_card_count
  from public.zagulyaky_tabular_import_cards
  where batch_id = p_batch_id and materialization_status = 'pending';
  select count(*)::integer into failed_card_count
  from public.zagulyaky_tabular_import_cards
  where batch_id = p_batch_id and materialization_status = 'failed';

  update public.zagulyaky_tabular_import_batches
  set materialized_card_count = materialized_card_count + materialized_in_call,
      failed_card_count = failed_card_count,
      status = case
        when remaining_card_count = 0 and failed_card_count = 0 then 'completed'
        when remaining_card_count = 0 then 'completed_with_errors'
        else 'commit_materializing'
      end,
      completed_at = case when remaining_card_count = 0 then now() else completed_at end,
      updated_at = now()
  where id = p_batch_id
  returning * into batch_row;

  return security_private.zagulyaky_tabular_import_batch_summary_v1(batch_row)
    || jsonb_build_object(
      'materializedInCall', materialized_in_call,
      'remainingCardCount', remaining_card_count,
      'replayed', false
    );
end;
$function$;

create or replace function public.service_finalize_zagulyaky_tabular_event_import_v1(
  p_batch_id uuid,
  p_import_mode text,
  p_materialize_limit integer default 250
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.service_finalize_zagulyaky_tabular_event_import_v1($1, $2, $3)
$function$;

revoke all on function security_private.zagulyaky_tabular_import_server_request_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_text_v1(jsonb,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_raw_text_v1(jsonb,text,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_key_v1(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_integer_v1(jsonb,text,integer,integer,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_boolean_v1(jsonb,text,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_url_v1(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_timestamp_v1(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_role_code_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_structural_role_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_public_text_v1(text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_workbook_row_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_json_array_v1(jsonb,text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_integer_alias_v1(jsonb,text,text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_date_v1(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_catalogue_event_type_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_supplied_structural_role_v1(text) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_expected_count_v1(jsonb,text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_tabular_import_batch_summary_v1(public.zagulyaky_tabular_import_batches) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_begin_zagulyaky_tabular_event_import_v1(text,text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_tabular_event_import_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_list_zagulyaky_tabular_event_imports_v1(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer) from public, anon, authenticated, service_role;

grant execute on function security_private.admin_begin_zagulyaky_tabular_event_import_v1(text,text,jsonb,text) to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_tabular_event_import_v1(uuid) to authenticated, service_role;
grant execute on function security_private.admin_list_zagulyaky_tabular_event_imports_v1(text,integer,integer) to authenticated, service_role;
grant execute on function security_private.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text) to service_role;
grant execute on function security_private.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer) to service_role;

revoke all on function public.admin_begin_zagulyaky_tabular_event_import_v1(text,text,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaky_tabular_event_import_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_list_zagulyaky_tabular_event_imports_v1(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text) from public, anon, authenticated, service_role;
revoke all on function public.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer) from public, anon, authenticated, service_role;

grant execute on function public.admin_begin_zagulyaky_tabular_event_import_v1(text,text,jsonb,text) to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_tabular_event_import_v1(uuid) to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_tabular_event_imports_v1(text,integer,integer) to authenticated, service_role;
grant execute on function public.service_ingest_zagulyaky_tabular_event_import_chunk_v1(uuid,jsonb,text,integer,text) to service_role;
grant execute on function public.service_finalize_zagulyaky_tabular_event_import_v1(uuid,text,integer) to service_role;

-- The public catalogue must never reveal Facebook provenance, but a moderator
-- reviewing a draft needs a bounded trail back to the private workbook row.
-- Keep this on the existing moderator-only review bundle rather than adding a
-- new public read API.  In particular, do not serialise workbook_row_private:
-- it is deliberately the full audit envelope and can contain unrelated raw
-- workbook fields.
create or replace function security_private.admin_get_zagulyaka_review_bundle_v1(
  p_record_id uuid,
  p_version_limit integer default 40,
  p_action_limit integer default 80
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  result jsonb;
  safe_version_limit integer := least(greatest(coalesce(p_version_limit, 40), 1), 100);
  safe_action_limit integer := least(greatest(coalesce(p_action_limit, 80), 1), 200);
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  if not exists (select 1 from public.zagulyaky_records where id = p_record_id) then
    raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'record', to_jsonb(r) - 'search_vector',
    'sources', coalesce((
      select jsonb_agg((to_jsonb(s) - 'created_by') || jsonb_build_object('isPrimary', rs.is_primary)
        order by rs.is_primary desc, s.created_at, s.id)
      from public.zagulyaky_record_sources rs
      join public.zagulyaky_sources s on s.id = rs.source_id
      where rs.record_id = r.id
    ), '[]'::jsonb),
    'participants', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.sort_order, p.id)
      from public.zagulyaky_participants p
      where p.record_id = r.id
    ), '[]'::jsonb),
    'documentDiscoveries', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.id)
      from public.zagulyaky_document_discoveries d
      where d.record_id = r.id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(to_jsonb(a) - 'created_by' order by a.created_at, a.id)
      from public.zagulyaky_attachments a
      where a.record_id = r.id
    ), '[]'::jsonb),
    'versions', coalesce((
      select jsonb_agg(to_jsonb(version_row) order by version_row.revision_no desc)
      from (
        select version.id, version.revision_no, version.snapshot,
          version.actor_id, version.created_at
        from public.zagulyaky_record_versions version
        where version.record_id = r.id
        order by version.revision_no desc
        limit safe_version_limit
      ) version_row
    ), '[]'::jsonb),
    'moderationActions', coalesce((
      select jsonb_agg(to_jsonb(action_row) order by action_row.created_at desc, action_row.id desc)
      from (
        select action.id, action.action, action.from_status, action.to_status,
          action.note, action.metadata, action.created_at
        from public.zagulyaky_moderation_actions action
        where action.record_id = r.id
        order by action.created_at desc, action.id desc
        limit safe_action_limit
      ) action_row
    ), '[]'::jsonb),
    'adminAudit', coalesce((
      select jsonb_agg(to_jsonb(audit_row) order by audit_row.created_at desc, audit_row.id desc)
      from (
        select audit.id, audit.action_code, audit.target_type, audit.target_id,
          audit.outcome, audit.sanitized_diff, audit.created_at
        from public.admin_audit_log audit
        where audit.target_type = 'zagulyaky_record'
          and audit.target_id = r.id::text
        order by audit.created_at desc, audit.id desc
        limit safe_action_limit
      ) audit_row
    ), '[]'::jsonb),
    'claims', coalesce((
      select jsonb_agg(to_jsonb(claim_row) order by claim_row.created_at desc, claim_row.id desc)
      from (
        select claim.id, claim.claim_type, claim.message, claim.status,
          claim.resolution_note, claim.resolved_at, claim.created_at, claim.updated_at
        from public.zagulyaky_claims claim
        where claim.record_id = r.id
        order by claim.created_at desc, claim.id desc
        limit safe_action_limit
      ) claim_row
    ), '[]'::jsonb),
    'privateImportOrigins', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'cardKey', import_card.card_key,
        'eventKey', import_event.event_key,
        'postKey', import_post.post_key,
        'sourcePlatform', left(import_post.source_platform, 120),
        'sourceDateText', nullif(left(import_post.source_date_text, 500), ''),
        'facebookPostUrl', nullif(left(import_post.facebook_post_url_private, 4000), ''),
        'sourceCollectionUrl', nullif(left(import_post.source_collection_url_private, 4000), ''),
        'sourceTitleOriginal', nullif(left(import_post.source_title_original, 2000), ''),
        'postOriginalText', nullif(left(import_post.post_original_text, 12000), ''),
        'eventTypeOriginal', nullif(left(import_event.event_type_original, 500), ''),
        'eventDateOriginal', nullif(left(import_event.event_date_original, 4000), ''),
        'eventPlaceOriginal', nullif(left(import_event.event_place_original, 4000), ''),
        'eventOriginalText', nullif(left(import_event.event_original_text, 12000), '')
      )) order by import_card.card_sequence, import_card.card_key)
      from public.zagulyaky_tabular_import_card_records import_map
      join public.zagulyaky_tabular_import_cards import_card
        on import_card.id = import_map.card_id
        and import_card.batch_id = import_map.batch_id
      join public.zagulyaky_tabular_import_events import_event
        on import_event.batch_id = import_card.batch_id
        and import_event.event_key = import_card.event_key
      join public.zagulyaky_tabular_import_source_posts import_post
        on import_post.batch_id = import_event.batch_id
        and import_post.post_key = import_event.post_key
      where import_map.record_id = r.id
    ), '[]'::jsonb)
  ) into result
  from public.zagulyaky_records r
  where r.id = p_record_id;

  return result;
end;
$function$;

-- The function signature is unchanged.  Recreate the invoker facade so this
-- migration remains self-contained, then reassert its existing narrow ACL.
create or replace function public.admin_get_zagulyaka_review_bundle_v1(
  p_record_id uuid,
  p_version_limit integer default 40,
  p_action_limit integer default 80
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaka_review_bundle_v1($1, $2, $3)
$function$;

revoke all on function security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  to authenticated, service_role;
revoke all on function public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_get_zagulyaka_review_bundle_v1(uuid,integer,integer)
  to authenticated, service_role;

-- Extend the already privacy-gated public catalogue search with the new,
-- historical participant facts.  This intentionally reads only published,
-- cleared catalogue participants; none of the private workbook ledger or
-- Facebook provenance tables appears here.
create or replace function security_private.search_zagulyaky_v1(
  p_kind text,
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  result jsonb;
begin
  if p_kind not in ('person', 'document') then
    raise exception 'INVALID_ZAGULYAKY_KIND' using errcode = '22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters) <> 'object' then
    raise exception 'INVALID_FILTERS' using errcode = '22023';
  end if;
  if char_length(coalesce(p_query, '')) > 200 then
    raise exception 'SEARCH_QUERY_TOO_LONG' using errcode = '22023';
  end if;
  if (p_cursor_published_at is null) <> (p_cursor_id is null) then
    raise exception 'INCOMPLETE_SEARCH_CURSOR' using errcode = '22023';
  end if;
  if (p_filters ? 'yearFrom' and coalesce(p_filters->>'yearFrom', '') !~ '^\d{1,4}$')
    or (p_filters ? 'yearTo' and coalesce(p_filters->>'yearTo', '') !~ '^\d{1,4}$') then
    raise exception 'INVALID_YEAR_FILTER' using errcode = '22023';
  end if;

  with matched as (
    select r.*
    from public.zagulyaky_records r
    where r.kind = p_kind
      and r.status = 'published'
      and r.privacy_status = 'cleared'
      and (
        not r.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(r.id)
      )
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or r.search_vector @@ websearch_to_tsquery('simple'::regconfig, p_query)
        or lower(
          coalesce(r.title, '') || ' ' ||
          coalesce(r.summary, '') || ' ' ||
          coalesce(r.original_text, '') || ' ' ||
          coalesce(r.normalized_text, '') || ' ' ||
          coalesce(r.original_language, '') || ' ' ||
          coalesce(r.event_type, '') || ' ' ||
          coalesce(r.event_date_text, '') || ' ' ||
          coalesce(r.event_year_from::text, '') || ' ' ||
          coalesce(r.event_year_to::text, '') || ' ' ||
          coalesce(r.date_precision, '') || ' ' ||
          coalesce(r.source_location_text, '') || ' ' ||
          coalesce(r.source_location_normalized, '') || ' ' ||
          coalesce(r.found_location_text, '') || ' ' ||
          coalesce(r.found_location_normalized, '') || ' ' ||
          coalesce(r.classification_reason, '') || ' ' ||
          coalesce(r.verification_status, '')
        ) like '%' || lower(p_query) || '%'
        or exists (
          select 1
          from public.zagulyaky_participants participant
          where participant.record_id = r.id
            and lower(
              coalesce(participant.original_full_name, '') || ' ' ||
              coalesce(participant.normalized_uk_full_name, '') || ' ' ||
              coalesce(participant.surname, '') || ' ' ||
              coalesce(participant.given_name, '') || ' ' ||
              coalesce(participant.patronymic, '') || ' ' ||
              coalesce(participant.maiden_name, '') || ' ' ||
              coalesce(participant.age_text, '') || ' ' ||
              coalesce(participant.origin_text, '') || ' ' ||
              coalesce(participant.residence_text, '') || ' ' ||
              coalesce(participant.social_estate_text, '') || ' ' ||
              coalesce(participant.occupation_or_rank_text, '') || ' ' ||
              coalesce(participant.marital_status_text, '') || ' ' ||
              coalesce(participant.relation_original, '') || ' ' ||
              coalesce(participant.evidence_excerpt, '') || ' ' ||
              coalesce(participant.notes, '') || ' ' ||
              coalesce(participant.role, '') || ' ' ||
              coalesce(participant.event_role_code, '') || ' ' ||
              coalesce(participant.event_role_custom, '')
            ) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
            and lower(
              coalesce(source.source_type, '') || ' ' ||
              coalesce(source.title, '') || ' ' ||
              coalesce(source.archive_name, '') || ' ' ||
              coalesce(source.fond, '') || ' ' ||
              coalesce(source.inventory, '') || ' ' ||
              coalesce(source.file_number, '') || ' ' ||
              coalesce(source.page_from, '') || ' ' ||
              coalesce(source.page_to, '') || ' ' ||
              coalesce(source.citation, '')
            ) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
            and lower(
              coalesce(discovery.official_location_text, '') || ' ' ||
              coalesce(discovery.discovered_location_text, '') || ' ' ||
              coalesce(array_to_string(discovery.record_types, ' '), '') || ' ' ||
              coalesce(discovery.page_from, '') || ' ' ||
              coalesce(discovery.page_to, '') || ' ' ||
              coalesce(discovery.notes, '')
            ) like '%' || lower(p_query) || '%'
        )
      )
      and (not (p_filters ? 'eventType') or r.event_type = p_filters->>'eventType')
      and (not (p_filters ? 'verificationStatus') or r.verification_status = p_filters->>'verificationStatus')
      and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters->>'yearFrom')::integer)
      and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters->>'yearTo')::integer)
      and (not (p_filters ? 'sourceLocation') or coalesce(r.source_location_normalized, r.source_location_text, '') ilike '%' || (p_filters->>'sourceLocation') || '%')
      and (not (p_filters ? 'foundLocation') or coalesce(r.found_location_normalized, r.found_location_text, '') ilike '%' || (p_filters->>'foundLocation') || '%')
      and (
        not (p_filters ? 'archiveName')
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources s on s.id = rs.source_id
          where rs.record_id = r.id
            and coalesce(s.archive_name, '') ilike '%' || (p_filters->>'archiveName') || '%'
        )
      )
      and (
        p_cursor_published_at is null
        or r.published_at < p_cursor_published_at
        or (r.published_at = p_cursor_published_at and r.id < p_cursor_id)
      )
    order by r.published_at desc, r.id desc
    limit safe_limit + 1
  ), page_rows as (
    select * from matched order by published_at desc, id desc limit safe_limit
  ), last_row as (
    select published_at, id from page_rows order by published_at, id limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id,
        'slug', r.public_slug,
        'kind', r.kind,
        'title', r.title,
        'summary', r.summary,
        'subject', (
          select jsonb_build_object(
            'originalFullName', participant.original_full_name,
            'normalizedUkFullName', participant.normalized_uk_full_name,
            'sex', participant.sex,
            'ageText', participant.age_text
          )
          from public.zagulyaky_participants participant
          where participant.record_id = r.id and participant.role = 'subject'
          order by participant.sort_order, participant.id
          limit 1
        ),
        'primarySource', (
          select jsonb_build_object(
            'sourceType', source.source_type,
            'title', source.title,
            'archiveName', source.archive_name,
            'citation', source.citation,
            'pageFrom', source.page_from,
            'pageTo', source.page_to
          )
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
          order by rs.is_primary desc, source.created_at, source.id
          limit 1
        ),
        'documentDiscovery', (
          select jsonb_build_object(
            'officialLocationText', discovery.official_location_text,
            'discoveredLocationText', discovery.discovered_location_text,
            'recordTypes', discovery.record_types,
            'factualYearFrom', discovery.factual_year_from,
            'factualYearTo', discovery.factual_year_to,
            'pageFrom', discovery.page_from,
            'pageTo', discovery.page_to
          )
          from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
          order by discovery.id
          limit 1
        ),
        'eventType', r.event_type,
        'eventDateText', r.event_date_text,
        'eventYearFrom', r.event_year_from,
        'eventYearTo', r.event_year_to,
        'datePrecision', r.date_precision,
        'sourceLocation', coalesce(r.source_location_normalized, r.source_location_text),
        'foundLocation', coalesce(r.found_location_normalized, r.found_location_text),
        'verificationStatus', r.verification_status,
        'publishedAt', r.published_at,
        'confirmationCount', (
          select count(*) from public.zagulyaky_confirmations c
          where c.record_id = r.id and c.confirmation_type in ('confirm', 'source_checked')
        )
      ) order by r.published_at desc, r.id desc)
      from page_rows r
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from matched) > safe_limit then (
      select jsonb_build_object('publishedAt', published_at, 'id', id) from last_row
    ) else null end
  ) into result;

  return result;
end;
$function$;

revoke all on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
