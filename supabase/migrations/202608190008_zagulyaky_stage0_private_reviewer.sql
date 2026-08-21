begin;

-- Stage 0 importer data is intentionally private.  These moderator-review
-- projections are the only browser-facing way to inspect it: they retain the
-- existing `zagulyaky.import` boundary, page results deterministically by the
-- source position, and never expose the JSON source blob through an API.

create or replace function security_private.admin_list_zagulyaky_ingestion_batches_v1(
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
  safe_status text := nullif(btrim(coalesce(p_status, '')), '');
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
  result jsonb;
begin
  if auth.uid() is null or not security_private.has_admin_permission_v1('zagulyaky.import') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;

  if safe_status is not null and safe_status not in (
    'received', 'processing', 'dry_run_complete', 'completed',
    'completed_with_errors', 'failed', 'cancelled'
  ) then
    raise exception 'INVALID_INGESTION_BATCH_STATUS' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'items', coalesce(jsonb_agg(
      security_private.zagulyaky_import_batch_summary_v1(batch)
        || jsonb_build_object(
          'sourceFileName', batch.source_file_name,
          'receivedAt', batch.received_at,
          'processingStartedAt', batch.processing_started_at
        )
      order by batch.received_at desc, batch.id desc
    ), '[]'::jsonb),
    'total', (
      select count(*)
      from public.zagulyaky_ingestion_batches candidate
      where safe_status is null or candidate.status = safe_status
    ),
    'limit', safe_limit,
    'offset', safe_offset
  ) into result
  from (
    select candidate.*
    from public.zagulyaky_ingestion_batches candidate
    where safe_status is null or candidate.status = safe_status
    order by candidate.received_at desc, candidate.id desc
    limit safe_limit
    offset safe_offset
  ) batch;

  return result;
end;
$function$;

create or replace function public.admin_list_zagulyaky_ingestion_batches_v1(
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
  select security_private.admin_list_zagulyaky_ingestion_batches_v1($1, $2, $3)
$function$;

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
      ) as linked_record_count
    from public.zagulyaky_ingestion_batch_items membership
    join public.zagulyaky_ingestion_items item on item.id = membership.item_id
    where membership.batch_id = p_batch_id
      and (safe_stage_status is null or item.stage_status = safe_stage_status)
      and (p_quarantined is null or item.quarantined = p_quarantined)
      and (
        safe_query is null
        or position(lower(safe_query) in lower(coalesce(item.external_id, ''))) > 0
        or position(lower(safe_query) in lower(coalesce(item.raw_text, ''))) > 0
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
      -- Do not let an address embedded in imported prose turn the preview into
      -- an accidental source/attachment URL disclosure; detail retains the
      -- original content only after an authorized moderator selects it.
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

create or replace function public.admin_list_zagulyaky_ingestion_items_v1(
  p_batch_id uuid,
  p_query text default null,
  p_stage_status text default null,
  p_quarantined boolean default null,
  p_flag text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_list_zagulyaky_ingestion_items_v1($1, $2, $3, $4, $5, $6, $7)
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
      'recordLinkCount', record_link_count
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
      'updatedAt', item_row.updated_at
    ),
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

create or replace function public.admin_get_zagulyaky_ingestion_item_v1(
  p_batch_id uuid,
  p_item_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaky_ingestion_item_v1($1, $2)
$function$;

-- The Data API sees only the public facades.  Both layers are reset first so
-- no inherited PUBLIC execute privilege can accidentally expose reviewer data.
revoke all on function security_private.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)
  from public, anon, authenticated, service_role;

grant execute on function security_private.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)
  to authenticated, service_role;
grant execute on function security_private.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)
  to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)
  to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_ingestion_batches_v1(text,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_list_zagulyaky_ingestion_items_v1(uuid,text,text,boolean,text,integer,integer)
  to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_ingestion_item_v1(uuid,uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
