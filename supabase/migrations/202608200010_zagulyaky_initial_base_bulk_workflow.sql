begin;

-- The initial tabular base is deliberately promoted in small, resumable
-- batches.  These contracts are intentionally separate from the ordinary
-- one-record submit/review RPCs: they are scoped to a completed tabular batch,
-- preserve all of the normal privacy gates, and never expose raw private
-- provenance in their response payloads.

create index if not exists zagulyaky_tabular_import_card_records_batch_record_idx
  on public.zagulyaky_tabular_import_card_records(batch_id, record_id);

create or replace function security_private.zagulyaky_initial_base_bulk_summary_v1(
  p_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  v_batch public.zagulyaky_tabular_import_batches;
  v_summary jsonb;
begin
  select batch_row.*
  into v_batch
  from public.zagulyaky_tabular_import_batches as batch_row
  where batch_row.id = p_batch_id;
  if not found then
    raise exception 'TABULAR_IMPORT_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;

  with scoped_records as (
    select
      record_row.id,
      record_row.status,
      record_row.kind,
      record_row.privacy_status,
      record_row.possible_living_person,
      record_row.found_location_text,
      record_row.submission_terms_version,
      record_row.rights_confirmed_at,
      origin_row.record_id is not null as has_origin_mapping,
      origin_row.public_link_status = 'approved'
        and origin_row.source_id is not null
        and exists (
          select 1
          from public.zagulyaky_record_sources as source_link
          where source_link.record_id = record_row.id
            and source_link.source_id = origin_row.source_id
        ) as has_approved_origin_source,
      btrim(record_row.title) <> ''
        and btrim(record_row.classification_reason) <> ''
        and (
          record_row.kind <> 'person'
          or (
            nullif(btrim(record_row.event_type), '') is not null
            and exists (
              select 1
              from public.zagulyaky_participants as participant_row
              where participant_row.record_id = record_row.id
                and participant_row.role = 'subject'
                and nullif(
                  btrim(coalesce(nullif(participant_row.normalized_uk_full_name, ''), participant_row.original_full_name)),
                  ''
                ) is not null
            )
          )
        )
        and (
          record_row.kind <> 'document'
          or exists (
            select 1
            from public.zagulyaky_document_discoveries as discovery_row
            where discovery_row.record_id = record_row.id
              and nullif(btrim(discovery_row.official_location_text), '') is not null
              and nullif(btrim(discovery_row.discovered_location_text), '') is not null
          )
        ) as has_submission_fields,
      security_private.zagulyaky_has_living_person_clearance_v1(record_row.id) as has_current_living_clearance
    from public.zagulyaky_tabular_import_card_records as record_map
    join public.zagulyaky_records as record_row
      on record_row.id = record_map.record_id
    left join public.zagulyaky_tabular_import_record_origins as origin_row
      on origin_row.record_id = record_row.id
    where record_map.batch_id = p_batch_id
  )
  select jsonb_build_object(
    'batchId', v_batch.id,
    'batchStatus', v_batch.status,
    'recordCount', count(*),
    'statusCounts', jsonb_build_object(
      'draft', count(*) filter (where status = 'draft'),
      'needsChanges', count(*) filter (where status = 'needs_changes'),
      'pendingReview', count(*) filter (where status = 'pending_review'),
      'published', count(*) filter (where status = 'published'),
      'other', count(*) filter (where status not in ('draft', 'needs_changes', 'pending_review', 'published'))
    ),
    'submission', jsonb_build_object(
      -- "afterAcknowledgement" means records that are technically ready once
      -- the owner explicitly acknowledges rights and public-origin linkage.
      -- It does not perform either acknowledgement by itself.
      'availableAfterAcknowledgement', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status <> 'blocked'
          and has_origin_mapping
          and has_submission_fields
      ),
      'remainingEligibleCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status <> 'blocked'
          and has_approved_origin_source
          and has_submission_fields
      ),
      'privacyBlockedCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status = 'blocked'
      ),
      'missingOriginCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and not has_origin_mapping
      ),
      'originApprovalPendingCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and has_origin_mapping
          and not has_approved_origin_source
      ),
      'requiredFieldsMissingCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and not has_submission_fields
      ),
      -- Historical events can honestly have no known place.  This is a
      -- moderation warning rather than a fabricated-place or hard rejection.
      'unknownFoundLocationCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and kind = 'person'
          and nullif(btrim(found_location_text), '') is null
      ),
      'rightsNotRecordedCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and (submission_terms_version is null or rights_confirmed_at is null)
      )
    ),
    'publication', jsonb_build_object(
      -- This is the count the bulk-publish call may process after its explicit
      -- moderator acknowledgement.  It includes a potentially living record
      -- only when a current documented consent fingerprint is present.
      'availableAfterAcknowledgement', count(*) filter (
        where status = 'pending_review'
          and has_approved_origin_source
          and submission_terms_version is not null
          and rights_confirmed_at is not null
          and privacy_status <> 'blocked'
          and (not possible_living_person or has_current_living_clearance)
      ),
      'livingNeedsDocumentedConsentCount', count(*) filter (
        where status = 'pending_review'
          and possible_living_person
          and not has_current_living_clearance
      ),
      'privacyBlockedCount', count(*) filter (
        where status = 'pending_review'
          and privacy_status = 'blocked'
      ),
      'originNotApprovedCount', count(*) filter (
        where status = 'pending_review'
          and not has_approved_origin_source
      ),
      'rightsNotRecordedCount', count(*) filter (
        where status = 'pending_review'
          and (submission_terms_version is null or rights_confirmed_at is null)
      )
    )
  )
  into v_summary
  from scoped_records;

  return coalesce(v_summary, jsonb_build_object(
    'batchId', v_batch.id,
    'batchStatus', v_batch.status,
    'recordCount', 0,
    'statusCounts', jsonb_build_object(
      'draft', 0,
      'needsChanges', 0,
      'pendingReview', 0,
      'published', 0,
      'other', 0
    ),
    'submission', jsonb_build_object(
      'availableAfterAcknowledgement', 0,
      'remainingEligibleCount', 0,
      'privacyBlockedCount', 0,
      'missingOriginCount', 0,
      'originApprovalPendingCount', 0,
      'requiredFieldsMissingCount', 0,
      'unknownFoundLocationCount', 0,
      'rightsNotRecordedCount', 0
    ),
    'publication', jsonb_build_object(
      'availableAfterAcknowledgement', 0,
      'livingNeedsDocumentedConsentCount', 0,
      'privacyBlockedCount', 0,
      'originNotApprovedCount', 0,
      'rightsNotRecordedCount', 0
    )
  ));
end;
$function$;

create or replace function security_private.get_my_zagulyaky_initial_base_bulk_summary_v1(
  p_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.zagulyaky_tabular_import_batches as batch_row
    where batch_row.id = p_batch_id
      and batch_row.requested_by = auth.uid()
      and batch_row.status = 'completed'
  ) then
    raise exception 'INITIAL_BASE_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;
  return security_private.zagulyaky_initial_base_bulk_summary_v1(p_batch_id);
end;
$function$;

create or replace function security_private.admin_get_zagulyaky_initial_base_bulk_summary_v1(
  p_batch_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.zagulyaky_tabular_import_batches as batch_row
    where batch_row.id = p_batch_id
      and batch_row.status = 'completed'
  ) then
    raise exception 'INITIAL_BASE_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;
  return security_private.zagulyaky_initial_base_bulk_summary_v1(p_batch_id);
end;
$function$;

create or replace function security_private.list_my_zagulyaky_initial_base_bulk_batches_v1(
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  v_limit integer;
  v_offset integer;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'INITIAL_BASE_LIST_LIMIT_INVALID' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'INITIAL_BASE_LIST_OFFSET_INVALID' using errcode = '22023';
  end if;
  v_limit := p_limit;
  v_offset := p_offset;

  with scoped_batches as (
    select
      batch_row.id,
      batch_row.status,
      batch_row.updated_at,
      count(record_map.record_id)::integer as record_count,
      count(record_map.record_id) filter (where record_row.status = 'draft')::integer as draft_count,
      count(record_map.record_id) filter (where record_row.status = 'pending_review')::integer as pending_review_count,
      count(record_map.record_id) filter (where record_row.status = 'published')::integer as published_count
    from public.zagulyaky_tabular_import_batches as batch_row
    left join public.zagulyaky_tabular_import_card_records as record_map
      on record_map.batch_id = batch_row.id
    left join public.zagulyaky_records as record_row
      on record_row.id = record_map.record_id
    where batch_row.requested_by = auth.uid()
      and batch_row.status = 'completed'
    group by batch_row.id, batch_row.status, batch_row.updated_at
  ), page as (
    select *
    from scoped_batches
    order by updated_at desc, id desc
    limit v_limit
    offset v_offset
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'batchId', page.id,
      'status', page.status,
      'recordCount', page.record_count,
      'draftCount', page.draft_count,
      'pendingReviewCount', page.pending_review_count,
      'publishedCount', page.published_count,
      'updatedAt', page.updated_at
    ) order by page.updated_at desc, page.id desc), '[]'::jsonb),
    'total', (select count(*) from scoped_batches)
  )
  into v_result
  from page;

  return v_result;
end;
$function$;

-- The owner has to acknowledge both statements at action time.  The first is
-- the existing submission-rights requirement.  The second is deliberately
-- separate: a Facebook origin remains private unless the operator explicitly
-- asks to expose the link as a public, link-only source.  The called source
-- visibility contract is admin-gated and idempotently materialises the
-- sanitized social-post source without returning the raw URL here.
create or replace function security_private.submit_my_zagulyaky_tabular_initial_base_batch_v1(
  p_batch_id uuid,
  p_limit integer default 100,
  p_acknowledge_rights boolean default false,
  p_acknowledge_public_origin_link boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  v_current_user_id uuid := auth.uid();
  v_batch public.zagulyaky_tabular_import_batches;
  v_record public.zagulyaky_records;
  v_origin public.zagulyaky_tabular_import_record_origins;
  v_record_id uuid;
  v_selected_record_ids uuid[] := '{}'::uuid[];
  v_limit integer;
  v_can_moderate boolean := false;
  v_processed_count integer := 0;
  v_source_unavailable_count integer := 0;
  v_summary jsonb;
begin
  if v_current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception 'INITIAL_BASE_BULK_LIMIT_INVALID' using errcode = '22023';
  end if;
  if p_acknowledge_rights is distinct from true then
    raise exception 'INITIAL_BASE_RIGHTS_ACKNOWLEDGEMENT_REQUIRED' using errcode = '23514';
  end if;
  if p_acknowledge_public_origin_link is distinct from true then
    raise exception 'INITIAL_BASE_PUBLIC_ORIGIN_ACKNOWLEDGEMENT_REQUIRED' using errcode = '23514';
  end if;
  v_can_moderate := security_private.has_admin_permission_v1('zagulyaky.moderate');
  v_limit := p_limit;

  -- Serialise a batch's short chunks so an interrupted browser retry cannot
  -- double-submit a card while it is also materialising its public source.
  select batch_row.*
  into v_batch
  from public.zagulyaky_tabular_import_batches as batch_row
  where batch_row.id = p_batch_id
  for update;
  if not found
    or v_batch.requested_by is distinct from v_current_user_id
    or v_batch.status <> 'completed' then
    raise exception 'INITIAL_BASE_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Do not select malformed cards merely to make their origins public.  They
  -- remain explicitly visible in the aggregate exclusion counts for repair.
  for v_record in
    select record_row.*
    from public.zagulyaky_tabular_import_card_records as record_map
    join public.zagulyaky_records as record_row
      on record_row.id = record_map.record_id
    join public.zagulyaky_tabular_import_record_origins as origin_row
      on origin_row.record_id = record_row.id
    where record_map.batch_id = p_batch_id
      and record_row.created_by = v_current_user_id
      and record_row.status in ('draft', 'needs_changes')
      and record_row.privacy_status <> 'blocked'
      and nullif(btrim(origin_row.facebook_post_url_private), '') is not null
      and btrim(record_row.title) <> ''
      and btrim(record_row.classification_reason) <> ''
      and (
        record_row.kind <> 'person'
        or (
          nullif(btrim(record_row.event_type), '') is not null
          and exists (
            select 1
            from public.zagulyaky_participants as participant_row
            where participant_row.record_id = record_row.id
              and participant_row.role = 'subject'
              and nullif(
                btrim(coalesce(nullif(participant_row.normalized_uk_full_name, ''), participant_row.original_full_name)),
                ''
              ) is not null
          )
        )
      )
      and (
        record_row.kind <> 'document'
        or exists (
          select 1
          from public.zagulyaky_document_discoveries as discovery_row
          where discovery_row.record_id = record_row.id
            and nullif(btrim(discovery_row.official_location_text), '') is not null
            and nullif(btrim(discovery_row.discovered_location_text), '') is not null
        )
      )
      -- An owner may submit a source already approved by a moderator.  Only a
      -- moderator can turn a private Facebook origin into a public link.
      and (
        v_can_moderate
        or (
          origin_row.public_link_status = 'approved'
          and origin_row.source_id is not null
          and exists (
            select 1
            from public.zagulyaky_record_sources as source_link
            where source_link.record_id = record_row.id
              and source_link.source_id = origin_row.source_id
          )
        )
      )
    -- Keep the same global record-lock order as the public-origin toggle.
    order by record_row.id
    limit v_limit
    for update of record_row skip locked
  loop
    v_selected_record_ids := array_append(v_selected_record_ids, v_record.id);
  end loop;

  if v_can_moderate and cardinality(v_selected_record_ids) > 0 then
    perform public.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1(
      v_selected_record_ids,
      true
    );
  end if;

  foreach v_record_id in array v_selected_record_ids loop
    select record_row.*
    into v_record
    from public.zagulyaky_records as record_row
    where record_row.id = v_record_id
    for update;

    select origin_row.*
    into v_origin
    from public.zagulyaky_tabular_import_record_origins as origin_row
    where origin_row.record_id = v_record.id
    for update;

    if not found
      or v_origin.public_link_status <> 'approved'
      or v_origin.source_id is null
      or not exists (
        select 1
        from public.zagulyaky_record_sources as source_link
        where source_link.record_id = v_record.id
          and source_link.source_id = v_origin.source_id
      ) then
      v_source_unavailable_count := v_source_unavailable_count + 1;
      continue;
    end if;

    update public.zagulyaky_records
    set status = 'pending_review',
      submitted_at = now(),
      moderation_note = null,
      submission_terms_version = coalesce(v_record.submission_terms_version, 1),
      rights_confirmed_at = now(),
      privacy_status = case
        when v_record.possible_living_person then 'requires_consent'
        else privacy_status
      end
    where id = v_record.id;

    insert into public.zagulyaky_moderation_actions(
      record_id, actor_id, action, from_status, to_status, metadata
    ) values (
      v_record.id,
      v_current_user_id,
      'submit',
      v_record.status,
      'pending_review',
      jsonb_build_object(
        'bulkInitialBase', true,
        'tabularBatchId', p_batch_id,
        'rightsAcknowledged', true,
        'publicOriginLinkAcknowledged', true,
        'foundLocationMissing', nullif(btrim(v_record.found_location_text), '') is null,
        'possibleLivingPerson', v_record.possible_living_person
      )
    );
    v_processed_count := v_processed_count + 1;
  end loop;

  if v_can_moderate and (v_processed_count > 0 or v_source_unavailable_count > 0) then
    insert into public.admin_audit_log(
      admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
    ) values (
      v_current_user_id,
      'zagulyaky.initial_base.bulk_submit',
      'zagulyaky_tabular_import_batch',
      p_batch_id::text,
      'success',
      jsonb_build_object(
        'processedCount', v_processed_count,
        'sourceUnavailableCount', v_source_unavailable_count,
        'limit', v_limit,
        'rightsAcknowledged', true,
        'publicOriginLinkAcknowledged', true,
        'publicOriginApprovalPerformedByModerator', true
      )
    );
  end if;

  v_summary := security_private.zagulyaky_initial_base_bulk_summary_v1(p_batch_id);
  return jsonb_build_object(
    'batchId', p_batch_id,
    'action', 'submit',
    'processedCount', v_processed_count,
    'remainingEligibleCount', coalesce((v_summary -> 'submission' ->> 'remainingEligibleCount')::integer, 0),
    'excluded', jsonb_build_object(
      'sourceUnavailableInCallCount', v_source_unavailable_count,
      'privacyBlockedCount', coalesce((v_summary -> 'submission' ->> 'privacyBlockedCount')::integer, 0),
      'missingOriginCount', coalesce((v_summary -> 'submission' ->> 'missingOriginCount')::integer, 0),
      'requiredFieldsMissingCount', coalesce((v_summary -> 'submission' ->> 'requiredFieldsMissingCount')::integer, 0),
      'originApprovalNeedsModeratorCount', case
        when v_can_moderate then 0
        else coalesce((v_summary -> 'submission' ->> 'originApprovalPendingCount')::integer, 0)
      end
    ),
    'warnings', jsonb_build_object(
      'unknownFoundLocationCount', coalesce((v_summary -> 'submission' ->> 'unknownFoundLocationCount')::integer, 0)
    ),
    'summary', v_summary,
    'replayed', v_processed_count = 0
  );
end;
$function$;

-- Publishing does not infer any new facts.  It does not upgrade verification,
-- it never manufactures a living-person consent, and it refuses an origin that
-- has not separately been approved as a public link-only source.
create or replace function security_private.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(
  p_batch_id uuid,
  p_limit integer default 100,
  p_acknowledge_publication boolean default false,
  p_acknowledge_non_living_privacy boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  v_current_user_id uuid := auth.uid();
  v_batch public.zagulyaky_tabular_import_batches;
  v_record public.zagulyaky_records;
  v_origin public.zagulyaky_tabular_import_record_origins;
  v_safe_slug text;
  v_limit integer;
  v_processed_count integer := 0;
  v_source_unavailable_count integer := 0;
  v_living_clearance_missing_count integer := 0;
  v_summary jsonb;
begin
  if not security_private.has_admin_permission_v1('zagulyaky.moderate') then
    raise exception 'ADMIN_PERMISSION_REQUIRED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception 'INITIAL_BASE_BULK_LIMIT_INVALID' using errcode = '22023';
  end if;
  if p_acknowledge_publication is distinct from true then
    raise exception 'INITIAL_BASE_PUBLICATION_ACKNOWLEDGEMENT_REQUIRED' using errcode = '23514';
  end if;
  if p_acknowledge_non_living_privacy is distinct from true then
    raise exception 'INITIAL_BASE_NON_LIVING_PRIVACY_ACKNOWLEDGEMENT_REQUIRED' using errcode = '23514';
  end if;
  v_limit := p_limit;

  select batch_row.*
  into v_batch
  from public.zagulyaky_tabular_import_batches as batch_row
  where batch_row.id = p_batch_id
  for update;
  if not found or v_batch.status <> 'completed' then
    raise exception 'INITIAL_BASE_BATCH_NOT_FOUND' using errcode = 'P0002';
  end if;

  for v_record in
    select record_row.*
    from public.zagulyaky_tabular_import_card_records as record_map
    join public.zagulyaky_records as record_row
      on record_row.id = record_map.record_id
    join public.zagulyaky_tabular_import_record_origins as origin_row
      on origin_row.record_id = record_row.id
    where record_map.batch_id = p_batch_id
      and record_row.status = 'pending_review'
      and record_row.submission_terms_version is not null
      and record_row.rights_confirmed_at is not null
      and record_row.privacy_status <> 'blocked'
      and origin_row.public_link_status = 'approved'
      and origin_row.source_id is not null
      and exists (
        select 1
        from public.zagulyaky_record_sources as source_link
        where source_link.record_id = record_row.id
          and source_link.source_id = origin_row.source_id
      )
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
    -- A source revocation also locks records in this order before origin maps.
    order by record_row.id
    limit v_limit
    for update of record_row skip locked
  loop
    -- Re-lock the origin mapping after the record.  A concurrent revocation
    -- therefore waits instead of allowing a stale public-source decision to
    -- leak through to a newly-published record.
    select origin_row.*
    into v_origin
    from public.zagulyaky_tabular_import_record_origins as origin_row
    where origin_row.record_id = v_record.id
    for update;

    if not found
      or v_origin.public_link_status <> 'approved'
      or v_origin.source_id is null
      or not exists (
        select 1
        from public.zagulyaky_record_sources as source_link
        where source_link.record_id = v_record.id
          and source_link.source_id = v_origin.source_id
      ) then
      v_source_unavailable_count := v_source_unavailable_count + 1;
      continue;
    end if;
    if v_record.possible_living_person
      and not security_private.zagulyaky_has_living_person_clearance_v1(v_record.id) then
      v_living_clearance_missing_count := v_living_clearance_missing_count + 1;
      continue;
    end if;

    v_safe_slug := 'z-' || replace(v_record.id::text, '-', '');
    update public.zagulyaky_records
    set status = 'published',
      privacy_status = 'cleared',
      public_slug = v_safe_slug,
      published_at = coalesce(published_at, now()),
      moderated_by = v_current_user_id,
      moderation_note = null
    where id = v_record.id;

    insert into public.zagulyaky_moderation_actions(
      record_id, actor_id, action, from_status, to_status, metadata
    ) values (
      v_record.id,
      v_current_user_id,
      'publish',
      v_record.status,
      'published',
      jsonb_build_object(
        'bulkInitialBase', true,
        'tabularBatchId', p_batch_id,
        'publicationAcknowledged', true,
        'nonLivingPrivacyAcknowledged', not v_record.possible_living_person,
        'livingConsentCurrent', case
          when v_record.possible_living_person then true
          else null
        end,
        'publicOriginLinkApproved', true
      )
    );
    v_processed_count := v_processed_count + 1;
  end loop;

  if v_processed_count > 0 or v_source_unavailable_count > 0 or v_living_clearance_missing_count > 0 then
    insert into public.admin_audit_log(
      admin_actor_id, action_code, target_type, target_id, outcome, sanitized_diff
    ) values (
      v_current_user_id,
      'zagulyaky.initial_base.bulk_publish',
      'zagulyaky_tabular_import_batch',
      p_batch_id::text,
      'success',
      jsonb_build_object(
        'processedCount', v_processed_count,
        'sourceUnavailableCount', v_source_unavailable_count,
        'livingClearanceMissingCount', v_living_clearance_missing_count,
        'limit', v_limit,
        'publicationAcknowledged', true,
        'nonLivingPrivacyAcknowledged', true
      )
    );
  end if;

  v_summary := security_private.zagulyaky_initial_base_bulk_summary_v1(p_batch_id);
  return jsonb_build_object(
    'batchId', p_batch_id,
    'action', 'publish',
    'processedCount', v_processed_count,
    'remainingEligibleCount', coalesce((v_summary -> 'publication' ->> 'availableAfterAcknowledgement')::integer, 0),
    'excluded', jsonb_build_object(
      'sourceUnavailableInCallCount', v_source_unavailable_count,
      'livingClearanceMissingInCallCount', v_living_clearance_missing_count,
      'livingNeedsDocumentedConsentCount', coalesce((v_summary -> 'publication' ->> 'livingNeedsDocumentedConsentCount')::integer, 0),
      'privacyBlockedCount', coalesce((v_summary -> 'publication' ->> 'privacyBlockedCount')::integer, 0),
      'originNotApprovedCount', coalesce((v_summary -> 'publication' ->> 'originNotApprovedCount')::integer, 0)
    ),
    'summary', v_summary,
    'replayed', v_processed_count = 0
  );
end;
$function$;

create or replace function public.get_my_zagulyaky_initial_base_bulk_summary_v1(
  p_batch_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.get_my_zagulyaky_initial_base_bulk_summary_v1($1)
$function$;

create or replace function public.admin_get_zagulyaky_initial_base_bulk_summary_v1(
  p_batch_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_get_zagulyaky_initial_base_bulk_summary_v1($1)
$function$;

create or replace function public.list_my_zagulyaky_initial_base_bulk_batches_v1(
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $function$
  select security_private.list_my_zagulyaky_initial_base_bulk_batches_v1($1, $2)
$function$;

create or replace function public.submit_my_zagulyaky_tabular_initial_base_batch_v1(
  p_batch_id uuid,
  p_limit integer default 100,
  p_acknowledge_rights boolean default false,
  p_acknowledge_public_origin_link boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.submit_my_zagulyaky_tabular_initial_base_batch_v1($1, $2, $3, $4)
$function$;

create or replace function public.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(
  p_batch_id uuid,
  p_limit integer default 100,
  p_acknowledge_publication boolean default false,
  p_acknowledge_non_living_privacy boolean default false
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $function$
  select security_private.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1($1, $2, $3, $4)
$function$;

revoke all on function security_private.zagulyaky_initial_base_bulk_summary_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.get_my_zagulyaky_initial_base_bulk_summary_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_get_zagulyaky_initial_base_bulk_summary_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.list_my_zagulyaky_initial_base_bulk_batches_v1(integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function security_private.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;

grant execute on function security_private.get_my_zagulyaky_initial_base_bulk_summary_v1(uuid)
  to authenticated, service_role;
grant execute on function security_private.admin_get_zagulyaky_initial_base_bulk_summary_v1(uuid)
  to authenticated, service_role;
grant execute on function security_private.list_my_zagulyaky_initial_base_bulk_batches_v1(integer,integer)
  to authenticated, service_role;
grant execute on function security_private.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;
grant execute on function security_private.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;

revoke all on function public.get_my_zagulyaky_initial_base_bulk_summary_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_get_zagulyaky_initial_base_bulk_summary_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.list_my_zagulyaky_initial_base_bulk_batches_v1(integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;

grant execute on function public.get_my_zagulyaky_initial_base_bulk_summary_v1(uuid)
  to authenticated, service_role;
grant execute on function public.admin_get_zagulyaky_initial_base_bulk_summary_v1(uuid)
  to authenticated, service_role;
grant execute on function public.list_my_zagulyaky_initial_base_bulk_batches_v1(integer,integer)
  to authenticated, service_role;
grant execute on function public.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;
grant execute on function public.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
