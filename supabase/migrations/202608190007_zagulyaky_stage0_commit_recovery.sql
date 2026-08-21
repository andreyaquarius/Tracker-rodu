begin;

-- A failed Stage 0 commit must never be repaired by deleting canonical items:
-- their batch membership, private provenance, attachments, links and queued
-- work are durable evidence.  This migration permits one safe shape of retry:
-- a complete, same-checksum commit where every non-staged source slot was
-- recorded as a failure and no cross-batch duplicates were introduced.
--
-- The prior chunk importer also declared a PL/pgSQL variable named
-- `source_asset_key`.  PostgreSQL treated the identically named ON CONFLICT
-- target ambiguously, so every item with an attachment was quarantined as a
-- generic per-item failure.  The replacement below uses
-- `media_source_asset_key` instead.

alter table public.zagulyaky_ingestion_audit_events
  drop constraint if exists zagulyaky_ingestion_audit_events_action_check;

alter table public.zagulyaky_ingestion_audit_events
  add constraint zagulyaky_ingestion_audit_events_action_check check (action in (
    'batch_received', 'dry_run_completed', 'commit_started',
    'commit_recovery_started',
    'commit_completed', 'commit_completed_with_errors', 'batch_failed'
  ));

-- This stays private and checks only bounded operational counters.  It never
-- examines raw post text, author labels, source URLs or JSON payloads.
create or replace function security_private.zagulyaky_commit_recovery_eligible_v1(
  p_batch public.zagulyaky_ingestion_batches
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select
    p_batch.import_mode = 'commit'
    and p_batch.status = 'completed_with_errors'
    and p_batch.processed_item_count = p_batch.expected_item_count
    and p_batch.duplicate_item_count = 0
    and p_batch.failed_item_count > 0
    and p_batch.failed_item_count = p_batch.expected_item_count - p_batch.staged_item_count
    and p_batch.quarantined_item_count between 0 and p_batch.staged_item_count
    and (
      select count(*)::integer
      from public.zagulyaky_ingestion_batch_items membership
      where membership.batch_id = p_batch.id
    ) = p_batch.staged_item_count
    and (
      select count(*) filter (where item.quarantined)::integer
      from public.zagulyaky_ingestion_batch_items membership
      join public.zagulyaky_ingestion_items item on item.id = membership.item_id
      where membership.batch_id = p_batch.id
    ) = p_batch.quarantined_item_count
$function$;

-- Browser-safe batch metadata may expose whether the *already selected*
-- checksum can be recovered, but not item-level error data or raw provenance.
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
    'lastErrorCode', p_batch.last_error_code,
    'recoveryAvailable', security_private.zagulyaky_commit_recovery_eligible_v1(p_batch),
    'recoveryAttemptCount', (
      select count(*)::integer
      from public.zagulyaky_ingestion_audit_events audit_event
      where audit_event.batch_id = p_batch.id
        and audit_event.action = 'commit_recovery_started'
    )
  )
$function$;

-- Preserve the existing SECURITY DEFINER ownership and grant surface.  The
-- recovery branch can only be reached by the same authorized import RPC that
-- began the original commit; it remains keyed by the exact file checksum.
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
  recovery_started boolean := false;
  retained_item_count integer := 0;
  retained_quarantined_count integer := 0;
  recovery_attempt_count integer := 0;
begin
  if current_user_id is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if normalized_file_name = ''
    or char_length(normalized_file_name) > 255
    or normalized_file_name ~ '[\\/]' then
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
      if batch.status = 'completed_with_errors' then
        if not security_private.zagulyaky_commit_recovery_eligible_v1(batch) then
          raise exception 'COMMIT_RECOVERY_NOT_AVAILABLE' using errcode = '23514';
        end if;

        select
          count(*)::integer,
          count(*) filter (where item.quarantined)::integer
        into retained_item_count, retained_quarantined_count
        from public.zagulyaky_ingestion_batch_items membership
        join public.zagulyaky_ingestion_items item on item.id = membership.item_id
        where membership.batch_id = batch.id;

        -- Receipt and error rows describe the failed transport attempt.  Keep
        -- dry-run receipts and all successful private provenance untouched.
        delete from public.zagulyaky_ingestion_chunks
        where batch_id = batch.id and import_mode = 'commit';
        delete from public.zagulyaky_ingestion_item_errors
        where batch_id = batch.id and import_mode = 'commit';

        select count(*)::integer + 1 into recovery_attempt_count
        from public.zagulyaky_ingestion_audit_events
        where batch_id = batch.id and action = 'commit_recovery_started';

        update public.zagulyaky_ingestion_batches set
          status = 'received',
          processing_started_at = null,
          completed_at = null,
          processed_item_count = retained_item_count,
          staged_item_count = retained_item_count,
          duplicate_item_count = 0,
          quarantined_item_count = retained_quarantined_count,
          failed_item_count = 0,
          last_error_code = null,
          updated_at = now()
        where id = batch.id
        returning * into batch;

        insert into public.zagulyaky_ingestion_audit_events(batch_id, actor_id, action, metadata)
        values (
          batch.id,
          current_user_id,
          'commit_recovery_started',
          jsonb_build_object(
            'expectedItemCount', batch.expected_item_count,
            'retainedItemCount', retained_item_count,
            'retainedQuarantinedItemCount', retained_quarantined_count,
            'recoveryAttemptCount', recovery_attempt_count
          )
        );
        recovery_started := true;
      elsif batch.status = 'completed' then
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
      || jsonb_build_object('replayed', is_replay, 'recoveryStarted', recovery_started);
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
    || jsonb_build_object('replayed', false, 'recoveryStarted', false);
end;
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
  media_source_asset_key text;
  raw_url text;
  item_is_new boolean;
  item_already_in_batch boolean;
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

      -- Recovery replays the whole file after retaining previously successful
      -- source slots.  Skip only an exact existing batch/source-index pair.
      -- A repeated external id at a *different* source index retains the
      -- normal duplicate accounting and cannot make finalization undercount.
      item_already_in_batch := false;
      if not item_is_new then
        select exists(
          select 1
          from public.zagulyaky_ingestion_batch_items membership
          where membership.batch_id = p_batch_id
            and membership.item_id = current_item_id
            and membership.source_item_index = current_source_item_index + (p_chunk_index * 250)
        ) into item_already_in_batch;
        if item_already_in_batch then
          continue;
        end if;
      end if;

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
          media_source_asset_key := case when photo_id is not null then 'facebook-photo:' || photo_id
            else 'facebook-post:' || normalized_external_id || ':' || attachment_index::text end;
          insert into public.zagulyaky_ingestion_media_assets(
            source_platform, source_asset_key, facebook_photo_id, original_cdn_url, photo_page_url
          ) values (
            'facebook', media_source_asset_key, photo_id,
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

  -- Existing successful source slots are deliberately skipped during a
  -- recovery, so enforce the ceiling against the actual new work rather than
  -- the raw request array length.
  if batch.processed_item_count + processed_count > batch.expected_item_count then
    raise exception 'INGESTION_ITEM_COUNT_EXCEEDED' using errcode = '23514';
  end if;

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

revoke all on function security_private.zagulyaky_commit_recovery_eligible_v1(public.zagulyaky_ingestion_batches)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
