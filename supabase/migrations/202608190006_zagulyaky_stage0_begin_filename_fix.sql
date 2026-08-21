begin;

-- PostgreSQL's text type cannot contain U+0000, and `chr(0)` itself raises
-- SQLSTATE 54000 ("null character not permitted").  The former validation
-- therefore rejected every otherwise-valid source filename before a private
-- dry-run batch could be created.  The Edge handler already rejects a NUL in
-- the header, while PostgreSQL rejects one at the protocol boundary, so retain
-- the useful filename checks without constructing an impossible text value.
--
-- CREATE OR REPLACE preserves this function's owner and existing EXECUTE
-- grants.  Keep the original SECURITY DEFINER and fixed search_path exactly.
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

commit;
