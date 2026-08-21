begin;

-- Stage 0 is deliberately a private quarantine. Nothing in this migration
-- creates a public catalogue record, public Storage object, or public API
-- projection. The only browser-callable entry points below return sanitized
-- batch metadata and require the dedicated import permission.

insert into public.admin_role_permissions(role_code, permission_code) values
  ('content_admin', 'zagulyaky.import'),
  ('super_admin', 'zagulyaky.import')
on conflict (role_code, permission_code) do nothing;

create table if not exists public.zagulyaky_ingestion_batches (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null default 'facebook_group_json'
    check (source_platform = 'facebook_group_json'),
  source_file_name text not null
    check (char_length(source_file_name) between 1 and 255),
  source_checksum text not null
    check (source_checksum ~ '^[0-9a-f]{64}$'),
  source_collection_url text
    check (source_collection_url is null or source_collection_url ~* '^https?://'),
  source_exported_at timestamptz,
  expected_item_count integer not null check (expected_item_count between 1 and 5000),
  import_mode text not null default 'dry_run'
    check (import_mode in ('dry_run', 'commit')),
  status text not null default 'received'
    check (status in (
      'received', 'processing', 'dry_run_complete',
      'completed', 'completed_with_errors', 'failed', 'cancelled'
    )),
  source_schema_version smallint not null default 1 check (source_schema_version = 1),
  profile_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(profile_summary) = 'object'),
  requested_by uuid references public.profiles(user_id) on delete set null,
  received_at timestamptz not null default now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  processed_item_count integer not null default 0 check (processed_item_count >= 0),
  staged_item_count integer not null default 0 check (staged_item_count >= 0),
  duplicate_item_count integer not null default 0 check (duplicate_item_count >= 0),
  quarantined_item_count integer not null default 0 check (quarantined_item_count >= 0),
  failed_item_count integer not null default 0 check (failed_item_count >= 0),
  dry_run_completed_at timestamptz,
  dry_run_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(dry_run_summary) = 'object'),
  last_error_code text,
  updated_at timestamptz not null default now(),
  unique (source_platform, source_checksum)
);

create index if not exists zagulyaky_ingestion_batches_status_idx
  on public.zagulyaky_ingestion_batches(status, received_at desc);
create index if not exists zagulyaky_ingestion_batches_requested_by_idx
  on public.zagulyaky_ingestion_batches(requested_by, received_at desc);

-- A canonical item is keyed by the Facebook post id, while batch membership
-- remains many-to-many. This allows an incremental export to reference an
-- already-seen post without duplicating raw content or breaking provenance.
create table if not exists public.zagulyaky_ingestion_items (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null default 'facebook_group_json'
    check (source_platform = 'facebook_group_json'),
  external_id text not null
    check (external_id ~ '^[A-Za-z0-9:_-]{1,255}$'),
  idempotency_key text not null
    check (idempotency_key = 'facebook_group_post:' || external_id),
  first_seen_batch_id uuid not null references public.zagulyaky_ingestion_batches(id) on delete restrict,
  last_seen_batch_id uuid not null references public.zagulyaky_ingestion_batches(id) on delete restrict,
  source_url text
    check (source_url is null or source_url ~* '^https?://'),
  source_collection_url text
    check (source_collection_url is null or source_collection_url ~* '^https?://'),
  source_author_label text,
  source_date_text text,
  source_published_at timestamptz,
  source_date_precision text not null default 'unknown'
    check (source_date_precision in (
      'exact', 'parsed_from_text', 'inferred_current_year',
      'relative_unresolved', 'unknown'
    )),
  raw_text text,
  raw_payload jsonb not null check (jsonb_typeof(raw_payload) = 'object'),
  scraped_at timestamptz,
  collected_at timestamptz,
  source_updated_at timestamptz,
  candidate_years integer[] not null default '{}'
    check (coalesce(array_length(candidate_years, 1), 0) <= 50),
  declared_attachment_count integer not null default 0
    check (declared_attachment_count between 0 and 1000),
  normalized_text_sha256 text
    check (normalized_text_sha256 is null or normalized_text_sha256 ~ '^[0-9a-f]{64}$'),
  source_incomplete boolean not null default false,
  text_truncated boolean not null default false,
  requires_ocr boolean not null default false,
  requires_source_refetch boolean not null default false,
  missing_author boolean not null default false,
  missing_publication_date boolean not null default false,
  suspected_duplicate boolean not null default false,
  rights_review_required boolean not null default true,
  possible_living_person boolean not null default false,
  quarantined boolean not null default false,
  stage_status text not null default 'staged'
    check (stage_status in ('staged', 'quarantined', 'structured', 'linked', 'ignored')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_platform, external_id),
  unique (idempotency_key)
);

create index if not exists zagulyaky_ingestion_items_batch_idx
  on public.zagulyaky_ingestion_items(last_seen_batch_id, last_seen_at desc);
create index if not exists zagulyaky_ingestion_items_stage_idx
  on public.zagulyaky_ingestion_items(stage_status, quarantined, requires_ocr, requires_source_refetch);
create index if not exists zagulyaky_ingestion_items_text_hash_idx
  on public.zagulyaky_ingestion_items(normalized_text_sha256)
  where normalized_text_sha256 is not null;

create table if not exists public.zagulyaky_ingestion_batch_items (
  batch_id uuid not null references public.zagulyaky_ingestion_batches(id) on delete cascade,
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete restrict,
  source_item_index integer not null check (source_item_index >= 0),
  encountered_at timestamptz not null default now(),
  primary key (batch_id, item_id),
  unique (batch_id, source_item_index)
);

create index if not exists zagulyaky_ingestion_batch_items_item_idx
  on public.zagulyaky_ingestion_batch_items(item_id, encountered_at desc);

-- Chunk receipts make a retry safe: the same source chunk can be sent again,
-- but a different payload cannot silently replace a completed chunk.
create table if not exists public.zagulyaky_ingestion_chunks (
  batch_id uuid not null references public.zagulyaky_ingestion_batches(id) on delete cascade,
  import_mode text not null check (import_mode in ('dry_run', 'commit')),
  chunk_index integer not null check (chunk_index between 0 and 100000),
  item_count integer not null check (item_count between 1 and 250),
  payload_checksum text not null check (payload_checksum ~ '^[0-9a-f]{64}$'),
  status text not null default 'processed' check (status in ('processing', 'processed', 'failed')),
  processed_item_count integer not null default 0 check (processed_item_count >= 0),
  staged_item_count integer not null default 0 check (staged_item_count >= 0),
  duplicate_item_count integer not null default 0 check (duplicate_item_count >= 0),
  quarantined_item_count integer not null default 0 check (quarantined_item_count >= 0),
  failed_item_count integer not null default 0 check (failed_item_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (batch_id, import_mode, chunk_index)
);

create table if not exists public.zagulyaky_ingestion_item_errors (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.zagulyaky_ingestion_batches(id) on delete cascade,
  import_mode text not null check (import_mode in ('dry_run', 'commit')),
  chunk_index integer not null check (chunk_index >= 0),
  source_item_index integer not null check (source_item_index >= 0),
  external_id_hint text,
  error_code text not null check (error_code ~ '^[A-Z0-9_]{3,100}$'),
  -- Deliberately sanitized: no raw post text, author label, or source URL.
  error_detail text not null default '' check (char_length(error_detail) <= 500),
  created_at timestamptz not null default now(),
  unique (batch_id, import_mode, source_item_index, error_code)
);

create index if not exists zagulyaky_ingestion_item_errors_batch_idx
  on public.zagulyaky_ingestion_item_errors(batch_id, created_at);

-- A media asset is intentionally separate from an appearance of that media in
-- a post. `source_asset_key` deduplicates a Facebook photo id before any
-- download happens. Download/rights workers may later deduplicate by file hash.
create table if not exists public.zagulyaky_ingestion_media_assets (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null default 'facebook' check (source_platform = 'facebook'),
  source_asset_key text not null check (char_length(source_asset_key) between 1 and 320),
  facebook_photo_id text check (facebook_photo_id is null or facebook_photo_id ~ '^[0-9]{1,64}$'),
  original_cdn_url text check (original_cdn_url is null or original_cdn_url ~* '^https?://'),
  photo_page_url text check (photo_page_url is null or photo_page_url ~* '^https?://'),
  download_status text not null default 'not_requested'
    check (download_status in ('not_requested', 'queued', 'downloaded', 'failed', 'skipped')),
  mime_type text,
  byte_size bigint check (byte_size is null or byte_size between 0 and 2147483648),
  downloaded_file_sha256 text
    check (downloaded_file_sha256 is null or downloaded_file_sha256 ~ '^[0-9a-f]{64}$'),
  private_storage_bucket text,
  private_storage_path text,
  rights_status text not null default 'pending_review'
    check (rights_status in ('unknown', 'pending_review', 'approved_for_derivative', 'rejected', 'revoked')),
  rights_reviewed_by uuid references public.profiles(user_id) on delete set null,
  rights_reviewed_at timestamptz,
  public_derivative_bucket text,
  public_derivative_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_platform, source_asset_key),
  unique (private_storage_bucket, private_storage_path)
);

create unique index if not exists zagulyaky_ingestion_media_assets_file_hash_unique
  on public.zagulyaky_ingestion_media_assets(downloaded_file_sha256)
  where downloaded_file_sha256 is not null;
create index if not exists zagulyaky_ingestion_media_assets_download_idx
  on public.zagulyaky_ingestion_media_assets(download_status, rights_status);

create table if not exists public.zagulyaky_ingestion_attachments (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete cascade,
  asset_id uuid not null references public.zagulyaky_ingestion_media_assets(id) on delete restrict,
  source_index integer not null check (source_index >= 0),
  original_cdn_url text check (original_cdn_url is null or original_cdn_url ~* '^https?://'),
  photo_page_url text check (photo_page_url is null or photo_page_url ~* '^https?://'),
  alt_text text,
  width integer check (width is null or width between 1 and 100000),
  height integer check (height is null or height between 1 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, source_index)
);

create index if not exists zagulyaky_ingestion_attachments_asset_idx
  on public.zagulyaky_ingestion_attachments(asset_id, created_at);

create table if not exists public.zagulyaky_ingestion_links (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete cascade,
  source_index integer not null check (source_index >= 0),
  raw_url text not null check (raw_url ~* '^https?://'),
  normalized_url text check (normalized_url is null or normalized_url ~* '^https?://'),
  label text,
  link_kind text not null default 'other'
    check (link_kind in (
      'facebook_profile', 'facebook_photo', 'facebook_group', 'facebook_hashtag',
      'facebook_other', 'external_redirect', 'external', 'other'
    )),
  requires_safe_fetch boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, source_index)
);

create index if not exists zagulyaky_ingestion_links_normalized_idx
  on public.zagulyaky_ingestion_links(normalized_url)
  where normalized_url is not null;

-- This relation is only created by a later moderator workflow. It preserves
-- the 0..N relationship between a social post and catalogue records without
-- allowing an importer to publish or merge people automatically.
create table if not exists public.zagulyaky_ingestion_item_records (
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete cascade,
  record_id uuid not null references public.zagulyaky_records(id) on delete restrict,
  relationship_kind text not null default 'candidate'
    check (relationship_kind in ('candidate', 'source', 'derived')),
  linked_by uuid references public.profiles(user_id) on delete set null,
  linked_at timestamptz not null default now(),
  note text,
  primary key (item_id, record_id, relationship_kind)
);

create index if not exists zagulyaky_ingestion_item_records_record_idx
  on public.zagulyaky_ingestion_item_records(record_id, linked_at desc);

create table if not exists public.zagulyaky_extraction_jobs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.zagulyaky_ingestion_items(id) on delete cascade,
  job_type text not null check (job_type in ('ocr', 'structure', 'source_refetch', 'duplicate_check')),
  status text not null default 'queued'
    check (status in ('queued', 'claimed', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  requested_by uuid references public.profiles(user_id) on delete set null,
  claimed_by text,
  claimed_at timestamptz,
  completed_at timestamptz,
  -- Job payloads contain ids, flags and bounded technical metadata only. OCR
  -- text and any AI proposal must be stored in a later reviewed draft flow.
  request_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(request_metadata) = 'object'),
  result_summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result_summary) = 'object'),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (item_id, job_type)
);

create index if not exists zagulyaky_extraction_jobs_queue_idx
  on public.zagulyaky_extraction_jobs(status, job_type, created_at)
  where status = 'queued';

create table if not exists public.zagulyaky_ingestion_audit_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.zagulyaky_ingestion_batches(id) on delete set null,
  item_id uuid references public.zagulyaky_ingestion_items(id) on delete set null,
  actor_id uuid references public.profiles(user_id) on delete set null,
  action text not null check (action in (
    'batch_received', 'dry_run_completed', 'commit_started',
    'commit_completed', 'commit_completed_with_errors', 'batch_failed'
  )),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create index if not exists zagulyaky_ingestion_audit_events_batch_idx
  on public.zagulyaky_ingestion_audit_events(batch_id, created_at desc);

-- No public policy is intentionally defined. The Data API roles receive no
-- table privileges; service workers use narrow RPC contracts instead.
alter table public.zagulyaky_ingestion_batches enable row level security;
alter table public.zagulyaky_ingestion_items enable row level security;
alter table public.zagulyaky_ingestion_batch_items enable row level security;
alter table public.zagulyaky_ingestion_chunks enable row level security;
alter table public.zagulyaky_ingestion_item_errors enable row level security;
alter table public.zagulyaky_ingestion_media_assets enable row level security;
alter table public.zagulyaky_ingestion_attachments enable row level security;
alter table public.zagulyaky_ingestion_links enable row level security;
alter table public.zagulyaky_ingestion_item_records enable row level security;
alter table public.zagulyaky_extraction_jobs enable row level security;
alter table public.zagulyaky_ingestion_audit_events enable row level security;

revoke all on table public.zagulyaky_ingestion_batches from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_items from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_batch_items from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_chunks from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_item_errors from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_media_assets from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_attachments from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_links from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_item_records from public, anon, authenticated;
revoke all on table public.zagulyaky_extraction_jobs from public, anon, authenticated;
revoke all on table public.zagulyaky_ingestion_audit_events from public, anon, authenticated;

grant all on table public.zagulyaky_ingestion_batches to service_role;
grant all on table public.zagulyaky_ingestion_items to service_role;
grant all on table public.zagulyaky_ingestion_batch_items to service_role;
grant all on table public.zagulyaky_ingestion_chunks to service_role;
grant all on table public.zagulyaky_ingestion_item_errors to service_role;
grant all on table public.zagulyaky_ingestion_media_assets to service_role;
grant all on table public.zagulyaky_ingestion_attachments to service_role;
grant all on table public.zagulyaky_ingestion_links to service_role;
grant all on table public.zagulyaky_ingestion_item_records to service_role;
grant all on table public.zagulyaky_extraction_jobs to service_role;
grant all on table public.zagulyaky_ingestion_audit_events to service_role;

create or replace function security_private.zagulyaky_import_server_request_v1()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select coalesce(auth.role(), '') = 'service_role'
$function$;

create or replace function security_private.zagulyaky_import_flag_v1(
  p_item jsonb,
  p_key text,
  p_default boolean
)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select case jsonb_typeof(p_item -> p_key)
    when 'boolean' then (p_item ->> p_key)::boolean
    else p_default
  end
$function$;

create or replace function security_private.zagulyaky_import_candidate_years_v1(
  p_item jsonb
)
returns integer[]
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select coalesce(
    array_agg(candidate.year_value order by candidate.ordinality)
      filter (where candidate.year_value between 1 and 2200),
    '{}'::integer[]
  )
  from (
    select
      ordinality,
      case when value ~ '^[0-9]{1,4}$' then value::integer else null end as year_value
    from jsonb_array_elements_text(
      case when jsonb_typeof(p_item -> 'candidateYears') = 'array'
        then p_item -> 'candidateYears'
        else '[]'::jsonb
      end
    ) with ordinality candidate_values(value, ordinality)
  ) candidate
$function$;

-- A browser-facing begin RPC must not become a side channel for raw export
-- content. Persist only its allowlisted aggregate counters, even if a caller
-- supplies extra keys in p_profile_summary.
create or replace function security_private.zagulyaky_import_summary_count_v1(
  p_summary jsonb,
  p_key text,
  p_maximum integer default 5000
)
returns integer
language sql
immutable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select case
    when jsonb_typeof(p_summary -> p_key) = 'number'
      and (p_summary ->> p_key) ~ '^[0-9]{1,7}$'
    then case
      when (p_summary ->> p_key)::integer between 0 and greatest(coalesce(p_maximum, 5000), 0)
      then (p_summary ->> p_key)::integer
      else 0
    end
    else 0
  end
$function$;

create or replace function security_private.zagulyaky_import_batch_summary_v1(
  p_batch public.zagulyaky_ingestion_batches
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select jsonb_build_object(
    'batchId', p_batch.id,
    'status', p_batch.status,
    'importMode', p_batch.import_mode,
    'sourceChecksum', p_batch.source_checksum,
    'expectedItemCount', p_batch.expected_item_count,
    'processedItemCount', p_batch.processed_item_count,
    'stagedItemCount', p_batch.staged_item_count,
    'duplicateItemCount', p_batch.duplicate_item_count,
    'quarantinedItemCount', p_batch.quarantined_item_count,
    'failedItemCount', p_batch.failed_item_count,
    'dryRunCompletedAt', p_batch.dry_run_completed_at,
    'completedAt', p_batch.completed_at,
    'lastErrorCode', p_batch.last_error_code
  )
$function$;

create or replace function security_private.admin_begin_zagulyaky_facebook_import_v1(
  p_source_file_name text,
  p_source_checksum text,
  p_source_exported_at timestamptz,
  p_source_collection_url text,
  p_expected_item_count integer,
  p_import_mode text,
  p_profile_summary jsonb default '{}'::jsonb
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
  normalized_collection_url text := nullif(btrim(coalesce(p_source_collection_url, '')), '');
  batch public.zagulyaky_ingestion_batches;
  sanitized_profile_summary jsonb;
  is_replay boolean := false;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if normalized_file_name = ''
    or char_length(normalized_file_name) > 255
    or normalized_file_name ~ '[\\/]'
    or position(chr(0) in normalized_file_name) > 0 then
    raise exception 'INVALID_SOURCE_FILE_NAME' using errcode = '22023';
  end if;
  if normalized_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_SOURCE_CHECKSUM' using errcode = '22023';
  end if;
  if p_expected_item_count not between 1 and 5000 then
    raise exception 'INVALID_EXPECTED_ITEM_COUNT' using errcode = '22023';
  end if;
  if p_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;
  if normalized_collection_url is not null
    and (char_length(normalized_collection_url) > 4000 or normalized_collection_url !~* '^https?://') then
    raise exception 'INVALID_SOURCE_COLLECTION_URL' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_profile_summary, '{}'::jsonb)) <> 'object'
    or octet_length(coalesce(p_profile_summary, '{}'::jsonb)::text) > 100000 then
    raise exception 'INVALID_PROFILE_SUMMARY' using errcode = '22023';
  end if;
  sanitized_profile_summary := jsonb_build_object(
    'schemaVersion', 1,
    'itemCount', p_expected_item_count,
    'nonObjectCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'nonObjectCount', p_expected_item_count),
    'textTruncatedCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'textTruncatedCount', p_expected_item_count),
    'imageOnlyCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'imageOnlyCount', p_expected_item_count),
    'quarantinedCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'quarantinedCount', p_expected_item_count),
    'requiresOcrCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'requiresOcrCount', p_expected_item_count),
    'requiresSourceRefetchCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'requiresSourceRefetchCount', p_expected_item_count),
    'missingAuthorCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'missingAuthorCount', p_expected_item_count),
    'missingPublicationDateCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'missingPublicationDateCount', p_expected_item_count),
    'attachmentCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'attachmentCount', 1000000),
    'linkCount', security_private.zagulyaky_import_summary_count_v1(p_profile_summary, 'linkCount', 1000000)
  );

  select * into batch
  from public.zagulyaky_ingestion_batches
  where source_platform = 'facebook_group_json'
    and source_checksum = normalized_checksum
  for update;

  if found then
    if batch.expected_item_count <> p_expected_item_count
      or (batch.source_collection_url is distinct from normalized_collection_url
        and batch.source_collection_url is not null and normalized_collection_url is not null) then
      raise exception 'SOURCE_CHECKSUM_METADATA_CONFLICT' using errcode = '23514';
    end if;

    if p_import_mode = 'dry_run' then
      if batch.status = 'dry_run_complete' then
        is_replay := true;
      elsif batch.status in ('completed', 'completed_with_errors') then
        is_replay := true;
      elsif batch.import_mode <> 'dry_run' then
        raise exception 'BATCH_ALREADY_COMMITTED' using errcode = '23514';
      end if;
    else
      if batch.status in ('completed', 'completed_with_errors') then
        is_replay := true;
      elsif batch.status = 'dry_run_complete' then
        if batch.failed_item_count > 0 then
          raise exception 'DRY_RUN_REMEDIATION_REQUIRED' using errcode = '23514';
        end if;
        update public.zagulyaky_ingestion_batches set
          import_mode = 'commit',
          status = 'received',
          processing_started_at = null,
          completed_at = null,
          processed_item_count = 0,
          staged_item_count = 0,
          duplicate_item_count = 0,
          quarantined_item_count = 0,
          failed_item_count = 0,
          last_error_code = null,
          requested_by = current_user_id,
          updated_at = now()
        where id = batch.id
        returning * into batch;
        insert into public.zagulyaky_ingestion_audit_events(batch_id, actor_id, action, metadata)
        values (batch.id, current_user_id, 'commit_started', jsonb_build_object('expectedItemCount', batch.expected_item_count));
      elsif batch.import_mode <> 'commit' then
        raise exception 'DRY_RUN_REQUIRED' using errcode = '23514';
      end if;
    end if;

    return security_private.zagulyaky_import_batch_summary_v1(batch)
      || jsonb_build_object('replayed', is_replay);
  end if;

  if p_import_mode <> 'dry_run' then
    raise exception 'DRY_RUN_REQUIRED' using errcode = '23514';
  end if;

  insert into public.zagulyaky_ingestion_batches (
    source_file_name, source_checksum, source_collection_url, source_exported_at,
    expected_item_count, import_mode, status, profile_summary, requested_by
  ) values (
    normalized_file_name, normalized_checksum, normalized_collection_url, p_source_exported_at,
    p_expected_item_count, 'dry_run', 'received', sanitized_profile_summary, current_user_id
  ) returning * into batch;

  insert into public.zagulyaky_ingestion_audit_events(batch_id, actor_id, action, metadata)
  values (batch.id, current_user_id, 'batch_received', jsonb_build_object('expectedItemCount', batch.expected_item_count));

  return security_private.zagulyaky_import_batch_summary_v1(batch)
    || jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.admin_begin_zagulyaky_facebook_import_v1(
  p_source_file_name text,
  p_source_checksum text,
  p_source_exported_at timestamptz,
  p_source_collection_url text,
  p_expected_item_count integer,
  p_import_mode text,
  p_profile_summary jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_begin_zagulyaky_facebook_import_v1(
    $1, $2, $3, $4, $5, $6, $7
  )
$function$;

create or replace function security_private.admin_get_zagulyaky_ingestion_batch_v1(
  p_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  batch public.zagulyaky_ingestion_batches;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  select * into batch from public.zagulyaky_ingestion_batches where id = p_batch_id;
  if not found then raise exception 'INGESTION_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  return security_private.zagulyaky_import_batch_summary_v1(batch)
    || jsonb_build_object('profileSummary', batch.profile_summary, 'dryRunSummary', batch.dry_run_summary);
end;
$function$;

create or replace function public.admin_get_zagulyaky_ingestion_batch_v1(
  p_batch_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaky_ingestion_batch_v1($1)
$function$;

create or replace function security_private.service_ingest_zagulyaky_facebook_chunk_v1(
  p_batch_id uuid,
  p_items jsonb,
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
  batch public.zagulyaky_ingestion_batches;
  receipt public.zagulyaky_ingestion_chunks;
  item_json jsonb;
  attachment_json jsonb;
  link_json jsonb;
  current_source_item_index integer;
  attachment_index integer;
  link_index integer;
  raw_external_id text;
  normalized_external_id text;
  normalized_text_hash text;
  current_item_id uuid;
  asset_id uuid;
  photo_id text;
  source_asset_key text;
  raw_url text;
  item_is_new boolean;
  item_quarantined boolean;
  processed_count integer := 0;
  staged_count integer := 0;
  duplicate_count integer := 0;
  quarantined_count integer := 0;
  failed_count integer := 0;
  item_error_code text;
  error_detail text;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVER_IMPORT_REQUIRED' using errcode = '42501';
  end if;
  if p_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;
  if p_chunk_index not between 0 and 100000 then
    raise exception 'INVALID_CHUNK_INDEX' using errcode = '22023';
  end if;
  if lower(coalesce(p_chunk_checksum, '')) !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_CHUNK_CHECKSUM' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 250 then
    raise exception 'INVALID_IMPORT_CHUNK' using errcode = '22023';
  end if;

  select * into batch from public.zagulyaky_ingestion_batches where id = p_batch_id for update;
  if not found then raise exception 'INGESTION_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  if batch.import_mode <> p_import_mode then
    raise exception 'IMPORT_MODE_MISMATCH' using errcode = '23514';
  end if;
  if batch.status in ('completed', 'completed_with_errors', 'failed', 'cancelled', 'dry_run_complete') then
    raise exception 'INGESTION_BATCH_NOT_ACCEPTING_CHUNKS' using errcode = '23514';
  end if;

  select * into receipt
  from public.zagulyaky_ingestion_chunks
  where batch_id = p_batch_id and import_mode = p_import_mode and chunk_index = p_chunk_index
  for update;
  if found then
    if receipt.payload_checksum <> lower(p_chunk_checksum)
      or receipt.item_count <> jsonb_array_length(p_items) then
      raise exception 'INGESTION_CHUNK_CONFLICT' using errcode = '23514';
    end if;
    return jsonb_build_object(
      'batchId', p_batch_id,
      'chunkIndex', p_chunk_index,
      'replayed', true,
      'processedItemCount', receipt.processed_item_count,
      'stagedItemCount', receipt.staged_item_count,
      'duplicateItemCount', receipt.duplicate_item_count,
      'quarantinedItemCount', receipt.quarantined_item_count,
      'failedItemCount', receipt.failed_item_count
    );
  end if;

  if batch.processed_item_count + jsonb_array_length(p_items) > batch.expected_item_count then
    raise exception 'INGESTION_ITEM_COUNT_EXCEEDED' using errcode = '23514';
  end if;

  insert into public.zagulyaky_ingestion_chunks(
    batch_id, import_mode, chunk_index, item_count, payload_checksum, status
  ) values (
    p_batch_id, p_import_mode, p_chunk_index, jsonb_array_length(p_items), lower(p_chunk_checksum), 'processing'
  );
  update public.zagulyaky_ingestion_batches set
    status = 'processing',
    processing_started_at = coalesce(processing_started_at, now()),
    updated_at = now()
  where id = p_batch_id;

  for item_json, current_source_item_index in
    select value, (ordinality - 1)::integer
    from jsonb_array_elements(p_items) with ordinality item(value, ordinality)
  loop
    begin
      if jsonb_typeof(item_json) <> 'object' then
        raise exception 'INVALID_ITEM_OBJECT' using errcode = '22023';
      end if;
      if nullif(item_json ->> 'inputError', '') is not null then
        raise exception '%', upper(left(item_json ->> 'inputError', 100)) using errcode = '22023';
      end if;
      normalized_external_id := btrim(coalesce(item_json ->> 'externalId', ''));
      if normalized_external_id !~ '^[A-Za-z0-9:_-]{1,255}$' then
        raise exception 'INVALID_EXTERNAL_ID' using errcode = '22023';
      end if;
      if jsonb_typeof(item_json -> 'rawPayload') <> 'object' then
        raise exception 'INVALID_RAW_PAYLOAD' using errcode = '22023';
      end if;
      if coalesce(char_length(item_json ->> 'rawText'), 0) > 200000
        or coalesce(char_length(item_json ->> 'sourceAuthorLabel'), 0) > 1000
        or coalesce(char_length(item_json ->> 'sourceDateText'), 0) > 1000 then
        raise exception 'ITEM_FIELD_TOO_LARGE' using errcode = '22023';
      end if;
      if nullif(item_json ->> 'sourceUrl', '') is not null
        and (char_length(item_json ->> 'sourceUrl') > 4000 or item_json ->> 'sourceUrl' !~* '^https?://') then
        raise exception 'INVALID_SOURCE_URL' using errcode = '22023';
      end if;
      if nullif(item_json ->> 'sourceCollectionUrl', '') is not null
        and (char_length(item_json ->> 'sourceCollectionUrl') > 4000 or item_json ->> 'sourceCollectionUrl' !~* '^https?://') then
        raise exception 'INVALID_SOURCE_COLLECTION_URL' using errcode = '22023';
      end if;
      normalized_text_hash := lower(nullif(item_json ->> 'normalizedTextSha256', ''));
      if normalized_text_hash is not null and normalized_text_hash !~ '^[0-9a-f]{64}$' then
        raise exception 'INVALID_NORMALIZED_TEXT_HASH' using errcode = '22023';
      end if;

      if p_import_mode = 'dry_run' then
        processed_count := processed_count + 1;
        if security_private.zagulyaky_import_flag_v1(item_json, 'quarantined', false)
          or security_private.zagulyaky_import_flag_v1(item_json, 'sourceIncomplete', false) then
          quarantined_count := quarantined_count + 1;
        end if;
        continue;
      end if;

      select id into current_item_id
      from public.zagulyaky_ingestion_items
      where source_platform = 'facebook_group_json' and external_id = normalized_external_id
      for update;
      item_is_new := not found;
      item_quarantined := security_private.zagulyaky_import_flag_v1(item_json, 'quarantined', false)
        or security_private.zagulyaky_import_flag_v1(item_json, 'sourceIncomplete', false);

      if item_is_new then
        insert into public.zagulyaky_ingestion_items(
          source_platform, external_id, idempotency_key, first_seen_batch_id, last_seen_batch_id,
          source_url, source_collection_url, source_author_label, source_date_text,
          source_published_at, source_date_precision, raw_text, raw_payload,
          scraped_at, collected_at, source_updated_at, candidate_years,
          declared_attachment_count, normalized_text_sha256,
          source_incomplete, text_truncated, requires_ocr, requires_source_refetch,
          missing_author, missing_publication_date, suspected_duplicate,
          rights_review_required, possible_living_person, quarantined, stage_status
        ) values (
          'facebook_group_json', normalized_external_id, 'facebook_group_post:' || normalized_external_id,
          p_batch_id, p_batch_id,
          nullif(item_json ->> 'sourceUrl', ''), nullif(item_json ->> 'sourceCollectionUrl', ''),
          nullif(item_json ->> 'sourceAuthorLabel', ''), nullif(item_json ->> 'sourceDateText', ''),
          nullif(item_json ->> 'sourcePublishedAt', '')::timestamptz,
          coalesce(nullif(item_json ->> 'sourceDatePrecision', ''), 'unknown'),
          nullif(item_json ->> 'rawText', ''), item_json -> 'rawPayload',
          nullif(item_json ->> 'scrapedAt', '')::timestamptz,
          nullif(item_json ->> 'collectedAt', '')::timestamptz,
          nullif(item_json ->> 'sourceUpdatedAt', '')::timestamptz,
          security_private.zagulyaky_import_candidate_years_v1(item_json),
          greatest(coalesce((item_json ->> 'declaredAttachmentCount')::integer, 0), 0),
          normalized_text_hash,
          security_private.zagulyaky_import_flag_v1(item_json, 'sourceIncomplete', false),
          security_private.zagulyaky_import_flag_v1(item_json, 'textTruncated', false),
          security_private.zagulyaky_import_flag_v1(item_json, 'requiresOcr', false),
          security_private.zagulyaky_import_flag_v1(item_json, 'requiresSourceRefetch', false),
          security_private.zagulyaky_import_flag_v1(item_json, 'missingAuthor', false),
          security_private.zagulyaky_import_flag_v1(item_json, 'missingPublicationDate', false),
          security_private.zagulyaky_import_flag_v1(item_json, 'suspectedDuplicate', false),
          true,
          security_private.zagulyaky_import_flag_v1(item_json, 'possibleLivingPerson', false),
          item_quarantined,
          case when item_quarantined then 'quarantined' else 'staged' end
        ) returning id into current_item_id;
      else
        update public.zagulyaky_ingestion_items set
          last_seen_batch_id = p_batch_id,
          source_url = coalesce(nullif(item_json ->> 'sourceUrl', ''), source_url),
          source_collection_url = coalesce(nullif(item_json ->> 'sourceCollectionUrl', ''), source_collection_url),
          source_author_label = coalesce(nullif(item_json ->> 'sourceAuthorLabel', ''), source_author_label),
          source_date_text = coalesce(nullif(item_json ->> 'sourceDateText', ''), source_date_text),
          source_published_at = coalesce(nullif(item_json ->> 'sourcePublishedAt', '')::timestamptz, source_published_at),
          source_date_precision = coalesce(nullif(item_json ->> 'sourceDatePrecision', ''), source_date_precision),
          raw_text = coalesce(nullif(item_json ->> 'rawText', ''), raw_text),
          raw_payload = item_json -> 'rawPayload',
          scraped_at = coalesce(nullif(item_json ->> 'scrapedAt', '')::timestamptz, scraped_at),
          collected_at = coalesce(nullif(item_json ->> 'collectedAt', '')::timestamptz, collected_at),
          source_updated_at = coalesce(nullif(item_json ->> 'sourceUpdatedAt', '')::timestamptz, source_updated_at),
          candidate_years = security_private.zagulyaky_import_candidate_years_v1(item_json),
          declared_attachment_count = greatest(coalesce((item_json ->> 'declaredAttachmentCount')::integer, declared_attachment_count), 0),
          normalized_text_sha256 = coalesce(normalized_text_hash, normalized_text_sha256),
          source_incomplete = source_incomplete or security_private.zagulyaky_import_flag_v1(item_json, 'sourceIncomplete', false),
          text_truncated = text_truncated or security_private.zagulyaky_import_flag_v1(item_json, 'textTruncated', false),
          requires_ocr = requires_ocr or security_private.zagulyaky_import_flag_v1(item_json, 'requiresOcr', false),
          requires_source_refetch = requires_source_refetch or security_private.zagulyaky_import_flag_v1(item_json, 'requiresSourceRefetch', false),
          missing_author = missing_author and security_private.zagulyaky_import_flag_v1(item_json, 'missingAuthor', false),
          missing_publication_date = missing_publication_date and security_private.zagulyaky_import_flag_v1(item_json, 'missingPublicationDate', false),
          suspected_duplicate = suspected_duplicate or security_private.zagulyaky_import_flag_v1(item_json, 'suspectedDuplicate', false),
          possible_living_person = possible_living_person or security_private.zagulyaky_import_flag_v1(item_json, 'possibleLivingPerson', false),
          quarantined = quarantined or item_quarantined,
          stage_status = case when quarantined or item_quarantined then 'quarantined' else stage_status end,
          last_seen_at = now(),
          updated_at = now()
        where id = current_item_id;
      end if;

      insert into public.zagulyaky_ingestion_batch_items(batch_id, item_id, source_item_index)
      values (p_batch_id, current_item_id, current_source_item_index + (p_chunk_index * 250))
      on conflict (batch_id, item_id) do nothing;

      if jsonb_typeof(item_json -> 'attachments') = 'array' then
        for attachment_json, attachment_index in
          select value, (ordinality - 1)::integer
          from jsonb_array_elements(item_json -> 'attachments') with ordinality attachment(value, ordinality)
        loop
          photo_id := nullif(btrim(coalesce(attachment_json ->> 'facebookPhotoId', '')), '');
          if photo_id is not null and photo_id !~ '^[0-9]{1,64}$' then photo_id := null; end if;
          source_asset_key := case when photo_id is not null then 'facebook-photo:' || photo_id
            else 'facebook-post:' || normalized_external_id || ':' || attachment_index::text end;
          insert into public.zagulyaky_ingestion_media_assets(
            source_platform, source_asset_key, facebook_photo_id, original_cdn_url, photo_page_url
          ) values (
            'facebook', source_asset_key, photo_id,
            nullif(attachment_json ->> 'sourceUrl', ''), nullif(attachment_json ->> 'facebookUrl', '')
          ) on conflict (source_platform, source_asset_key) do update set
            original_cdn_url = coalesce(excluded.original_cdn_url, public.zagulyaky_ingestion_media_assets.original_cdn_url),
            photo_page_url = coalesce(excluded.photo_page_url, public.zagulyaky_ingestion_media_assets.photo_page_url),
            updated_at = now()
          returning id into asset_id;

          insert into public.zagulyaky_ingestion_attachments(
            item_id, asset_id, source_index, original_cdn_url, photo_page_url, alt_text, width, height
          ) values (
            current_item_id, asset_id, attachment_index,
            nullif(attachment_json ->> 'sourceUrl', ''), nullif(attachment_json ->> 'facebookUrl', ''),
            nullif(attachment_json ->> 'alt', ''),
            nullif(attachment_json ->> 'width', '')::integer,
            nullif(attachment_json ->> 'height', '')::integer
          ) on conflict (item_id, source_index) do update set
            asset_id = excluded.asset_id,
            original_cdn_url = coalesce(excluded.original_cdn_url, public.zagulyaky_ingestion_attachments.original_cdn_url),
            photo_page_url = coalesce(excluded.photo_page_url, public.zagulyaky_ingestion_attachments.photo_page_url),
            alt_text = coalesce(excluded.alt_text, public.zagulyaky_ingestion_attachments.alt_text),
            width = coalesce(excluded.width, public.zagulyaky_ingestion_attachments.width),
            height = coalesce(excluded.height, public.zagulyaky_ingestion_attachments.height),
            updated_at = now();
        end loop;
      end if;

      if jsonb_typeof(item_json -> 'links') = 'array' then
        for link_json, link_index in
          select value, (ordinality - 1)::integer
          from jsonb_array_elements(item_json -> 'links') with ordinality link(value, ordinality)
        loop
          raw_url := nullif(link_json ->> 'rawUrl', '');
          if raw_url is null or char_length(raw_url) > 4000 or raw_url !~* '^https?://' then
            continue;
          end if;
          insert into public.zagulyaky_ingestion_links(
            item_id, source_index, raw_url, normalized_url, label, link_kind, requires_safe_fetch
          ) values (
            current_item_id, link_index, raw_url, nullif(link_json ->> 'normalizedUrl', ''),
            nullif(link_json ->> 'label', ''),
            coalesce(nullif(link_json ->> 'linkKind', ''), 'other'),
            security_private.zagulyaky_import_flag_v1(link_json, 'requiresSafeFetch', false)
          ) on conflict (item_id, source_index) do update set
            raw_url = excluded.raw_url,
            normalized_url = excluded.normalized_url,
            label = excluded.label,
            link_kind = excluded.link_kind,
            requires_safe_fetch = excluded.requires_safe_fetch,
            updated_at = now();
        end loop;
      end if;

      if security_private.zagulyaky_import_flag_v1(item_json, 'requiresOcr', false) and not item_quarantined then
        insert into public.zagulyaky_extraction_jobs(item_id, job_type, requested_by, request_metadata)
        values (current_item_id, 'ocr', batch.requested_by, jsonb_build_object('reason', 'stage0_requires_ocr'))
        on conflict (item_id, job_type) do nothing;
      end if;
      if security_private.zagulyaky_import_flag_v1(item_json, 'requiresSourceRefetch', false) and not item_quarantined then
        insert into public.zagulyaky_extraction_jobs(item_id, job_type, requested_by, request_metadata)
        values (current_item_id, 'source_refetch', batch.requested_by, jsonb_build_object('reason', 'stage0_truncated_without_image'))
        on conflict (item_id, job_type) do nothing;
      end if;
      if not item_quarantined then
        insert into public.zagulyaky_extraction_jobs(item_id, job_type, requested_by, request_metadata)
        values (current_item_id, 'duplicate_check', batch.requested_by, jsonb_build_object('reason', 'stage0_deduplication'))
        on conflict (item_id, job_type) do nothing;
      end if;

      processed_count := processed_count + 1;
      if item_is_new then staged_count := staged_count + 1; else duplicate_count := duplicate_count + 1; end if;
      if item_quarantined then quarantined_count := quarantined_count + 1; end if;
    exception when others then
      item_error_code := case upper(SQLERRM)
        when 'INVALID_POST_OBJECT' then 'INVALID_POST_OBJECT'
        when 'EMBEDDED_NUL_NOT_ALLOWED' then 'EMBEDDED_NUL_NOT_ALLOWED'
        when 'INVALID_EXTERNAL_ID' then 'INVALID_EXTERNAL_ID'
        when 'INVALID_IMAGES_ARRAY' then 'INVALID_IMAGES_ARRAY'
        when 'TOO_MANY_IMAGES' then 'TOO_MANY_IMAGES'
        when 'INVALID_LINKS_ARRAY' then 'INVALID_LINKS_ARRAY'
        when 'TOO_MANY_LINKS' then 'TOO_MANY_LINKS'
        when 'INVALID_ITEM_OBJECT' then 'INVALID_ITEM_OBJECT'
        when 'INVALID_RAW_PAYLOAD' then 'INVALID_RAW_PAYLOAD'
        when 'ITEM_FIELD_TOO_LARGE' then 'ITEM_FIELD_TOO_LARGE'
        when 'INVALID_SOURCE_URL' then 'INVALID_SOURCE_URL'
        when 'INVALID_SOURCE_COLLECTION_URL' then 'INVALID_SOURCE_COLLECTION_URL'
        when 'INVALID_NORMALIZED_TEXT_HASH' then 'INVALID_NORMALIZED_TEXT_HASH'
        else 'INGESTION_ITEM_REJECTED'
      end;
      error_detail := 'Item rejected by the private import contract.';
      raw_external_id := case when jsonb_typeof(item_json) = 'object' then nullif(left(item_json ->> 'externalId', 255), '') else null end;
      insert into public.zagulyaky_ingestion_item_errors(
        batch_id, import_mode, chunk_index, source_item_index, external_id_hint, error_code, error_detail
      ) values (
        p_batch_id, p_import_mode, p_chunk_index, current_source_item_index + (p_chunk_index * 250),
        raw_external_id, item_error_code, error_detail
      ) on conflict (batch_id, import_mode, source_item_index, error_code) do nothing;
      processed_count := processed_count + 1;
      failed_count := failed_count + 1;
    end;
  end loop;

  update public.zagulyaky_ingestion_chunks set
    status = 'processed',
    processed_item_count = processed_count,
    staged_item_count = staged_count,
    duplicate_item_count = duplicate_count,
    quarantined_item_count = quarantined_count,
    failed_item_count = failed_count,
    completed_at = now()
  where batch_id = p_batch_id and import_mode = p_import_mode and chunk_index = p_chunk_index;

  update public.zagulyaky_ingestion_batches set
    processed_item_count = processed_item_count + processed_count,
    staged_item_count = staged_item_count + staged_count,
    duplicate_item_count = duplicate_item_count + duplicate_count,
    quarantined_item_count = quarantined_item_count + quarantined_count,
    failed_item_count = failed_item_count + failed_count,
    updated_at = now()
  where id = p_batch_id;

  return jsonb_build_object(
    'batchId', p_batch_id,
    'chunkIndex', p_chunk_index,
    'replayed', false,
    'processedItemCount', processed_count,
    'stagedItemCount', staged_count,
    'duplicateItemCount', duplicate_count,
    'quarantinedItemCount', quarantined_count,
    'failedItemCount', failed_count
  );
end;
$function$;

create or replace function public.service_ingest_zagulyaky_facebook_chunk_v1(
  p_batch_id uuid,
  p_items jsonb,
  p_import_mode text,
  p_chunk_index integer,
  p_chunk_checksum text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.service_ingest_zagulyaky_facebook_chunk_v1($1, $2, $3, $4, $5)
$function$;

create or replace function security_private.service_finalize_zagulyaky_facebook_import_v1(
  p_batch_id uuid,
  p_import_mode text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  batch public.zagulyaky_ingestion_batches;
  final_status text;
  action_code text;
begin
  if not security_private.zagulyaky_import_server_request_v1() then
    raise exception 'SERVER_IMPORT_REQUIRED' using errcode = '42501';
  end if;
  if p_import_mode not in ('dry_run', 'commit') then
    raise exception 'INVALID_IMPORT_MODE' using errcode = '22023';
  end if;
  select * into batch from public.zagulyaky_ingestion_batches where id = p_batch_id for update;
  if not found then raise exception 'INGESTION_BATCH_NOT_FOUND' using errcode = 'P0002'; end if;
  if batch.import_mode <> p_import_mode then raise exception 'IMPORT_MODE_MISMATCH' using errcode = '23514'; end if;
  if batch.processed_item_count <> batch.expected_item_count then
    raise exception 'INGESTION_BATCH_INCOMPLETE' using errcode = '23514';
  end if;

  if p_import_mode = 'dry_run' then
    update public.zagulyaky_ingestion_batches set
      status = 'dry_run_complete',
      dry_run_completed_at = now(),
      dry_run_summary = jsonb_build_object(
        'expectedItemCount', expected_item_count,
        'processedItemCount', processed_item_count,
        'quarantinedItemCount', quarantined_item_count,
        'failedItemCount', failed_item_count
      ),
      completed_at = now(),
      updated_at = now()
    where id = p_batch_id returning * into batch;
    insert into public.zagulyaky_ingestion_audit_events(batch_id, actor_id, action, metadata)
    values (batch.id, batch.requested_by, 'dry_run_completed', batch.dry_run_summary);
  else
    final_status := case when batch.failed_item_count > 0 then 'completed_with_errors' else 'completed' end;
    action_code := case when final_status = 'completed' then 'commit_completed' else 'commit_completed_with_errors' end;
    update public.zagulyaky_ingestion_batches set
      status = final_status,
      completed_at = now(),
      updated_at = now()
    where id = p_batch_id returning * into batch;
    insert into public.zagulyaky_ingestion_audit_events(batch_id, actor_id, action, metadata)
    values (batch.id, batch.requested_by, action_code,
      jsonb_build_object('processedItemCount', batch.processed_item_count, 'failedItemCount', batch.failed_item_count));
  end if;
  return security_private.zagulyaky_import_batch_summary_v1(batch);
end;
$function$;

create or replace function public.service_finalize_zagulyaky_facebook_import_v1(
  p_batch_id uuid,
  p_import_mode text
)
returns jsonb
language sql
security invoker
set search_path = pg_catalog
as $function$
  select security_private.service_finalize_zagulyaky_facebook_import_v1($1, $2)
$function$;

revoke all on function security_private.zagulyaky_import_server_request_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_import_flag_v1(jsonb,text,boolean) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_import_candidate_years_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_import_summary_count_v1(jsonb,text,integer) from public, anon, authenticated, service_role;
revoke all on function security_private.zagulyaky_import_batch_summary_v1(public.zagulyaky_ingestion_batches) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_ingestion_batch_v1(uuid) from public, anon, authenticated, service_role;
revoke all on function security_private.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text) from public, anon, authenticated, service_role;
revoke all on function security_private.service_finalize_zagulyaky_facebook_import_v1(uuid,text) from public, anon, authenticated, service_role;

grant execute on function security_private.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb) to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_ingestion_batch_v1(uuid) to authenticated, service_role;
grant execute on function security_private.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text) to service_role;
grant execute on function security_private.service_finalize_zagulyaky_facebook_import_v1(uuid,text) to service_role;

revoke all on function public.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb) from public, anon;
revoke all on function public.admin_get_zagulyaky_ingestion_batch_v1(uuid) from public, anon;
revoke all on function public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text) from public, anon, authenticated;
revoke all on function public.service_finalize_zagulyaky_facebook_import_v1(uuid,text) from public, anon, authenticated;

grant execute on function public.admin_begin_zagulyaky_facebook_import_v1(text,text,timestamptz,text,integer,text,jsonb) to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_ingestion_batch_v1(uuid) to authenticated, service_role;
grant execute on function public.service_ingest_zagulyaky_facebook_chunk_v1(uuid,jsonb,text,integer,text) to service_role;
grant execute on function public.service_finalize_zagulyaky_facebook_import_v1(uuid,text) to service_role;

commit;
