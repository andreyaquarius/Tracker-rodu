begin;

-- Zagulyaky are a historical catalogue.  An author may therefore send a
-- complete draft to moderation without accepting a separate rights/publication
-- checkbox.  This migration intentionally changes *submission* only:
-- publication remains a moderator action, and the existing possible-living
-- and blocked-privacy safeguards remain in force.

-- Keep the manual user workflow compatible with existing clients while
-- removing the old rights-recording prerequisite.  A source is still required
-- for review, as are the record-specific completeness checks.  In particular,
-- this does not turn a submission into a publication.
create or replace function public.submit_zagulyaka_v1(
  p_record_id uuid,
  p_expected_lock_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  existing public.zagulyaky_records;
  updated_record public.zagulyaky_records;
begin
  if current_user_id is null then raise exception 'AUTH_REQUIRED' using errcode = '42501'; end if;
  select * into existing from public.zagulyaky_records where id = p_record_id for update;
  if not found or existing.created_by is distinct from current_user_id then raise exception 'ZAGULYAKA_NOT_FOUND' using errcode = 'P0002'; end if;
  if existing.status not in ('draft', 'needs_changes', 'withdrawn') then raise exception 'ZAGULYAKA_NOT_SUBMITTABLE' using errcode = '55000'; end if;
  if p_expected_lock_version is null or existing.lock_version is distinct from p_expected_lock_version then raise exception 'ZAGULYAKA_VERSION_CONFLICT' using errcode = '40001'; end if;
  if btrim(existing.title) = '' or btrim(existing.classification_reason) = '' then
    raise exception 'ZAGULYAKA_REQUIRED_FIELDS_MISSING' using errcode = '23514';
  end if;
  if existing.kind = 'person' and (existing.event_type is null or existing.found_location_text is null) then
    raise exception 'PERSON_EVENT_AND_FOUND_LOCATION_REQUIRED' using errcode = '23514';
  end if;
  if existing.kind = 'person' and not exists (
    select 1 from public.zagulyaky_participants participant
    where participant.record_id = existing.id
      and participant.role = 'subject'
      and nullif(btrim(coalesce(nullif(participant.normalized_uk_full_name, ''), participant.original_full_name)), '') is not null
  ) then
    raise exception 'PERSON_SUBJECT_REQUIRED' using errcode = '23514';
  end if;
  if existing.kind = 'document' and not exists (
    select 1 from public.zagulyaky_document_discoveries discovery
    where discovery.record_id = existing.id
      and nullif(btrim(discovery.official_location_text), '') is not null
      and nullif(btrim(discovery.discovered_location_text), '') is not null
  ) then
    raise exception 'DOCUMENT_LOCATIONS_REQUIRED' using errcode = '23514';
  end if;
  if not exists (select 1 from public.zagulyaky_record_sources rs where rs.record_id = existing.id) then
    raise exception 'ZAGULYAKA_SOURCE_REQUIRED' using errcode = '23514';
  end if;

  update public.zagulyaky_records
  set status = 'pending_review',
      submitted_at = now(),
      moderation_note = null,
      -- Preserve the separate safety route for a record already marked as
      -- possibly living.  This does not ask the author for a checkbox and it
      -- does not block moderation; it prevents implicit public clearance.
      privacy_status = case
        when possible_living_person then 'requires_consent'
        else privacy_status
      end
  where id = existing.id
  returning * into updated_record;

  insert into public.zagulyaky_moderation_actions(record_id, actor_id, action, from_status, to_status, metadata)
  values (
    existing.id,
    current_user_id,
    'submit',
    existing.status,
    'pending_review',
    jsonb_build_object(
      'historicalCatalogueSubmission', true,
      'possibleLivingPerson', existing.possible_living_person
    )
  );
  return to_jsonb(updated_record) - 'search_vector';
end;
$function$;

-- The summary keeps its older keys as compatibility aliases for already
-- deployed browser code, but their meaning is now "available now" rather
-- than "available after an acknowledgement".  It never exposes a private
-- Facebook URL or any private workbook content.
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
      origin_row.record_id is not null
        and security_private.zagulyaky_is_facebook_post_url_v1(origin_row.facebook_post_url_private)
        as has_publishable_origin,
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
      'availableForSubmission', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status <> 'blocked'
          and has_publishable_origin
          and has_submission_fields
      ),
      -- Compatibility for the first bulk-panel version.  No acknowledgement
      -- is now needed before this count can be submitted.
      'availableAfterAcknowledgement', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status <> 'blocked'
          and has_publishable_origin
          and has_submission_fields
      ),
      'remainingEligibleCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status <> 'blocked'
          and has_publishable_origin
          and has_submission_fields
      ),
      'privacyBlockedCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and privacy_status = 'blocked'
      ),
      'missingOriginCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and not has_publishable_origin
      ),
      -- A private origin is valid for submission; the moderator makes it
      -- public only in the later publish action.
      'originApprovalPendingCount', 0,
      'requiredFieldsMissingCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and not has_submission_fields
      ),
      'unknownFoundLocationCount', count(*) filter (
        where status in ('draft', 'needs_changes')
          and kind = 'person'
          and nullif(btrim(found_location_text), '') is null
      ),
      -- Retained only for response compatibility.  These historic submissions
      -- no longer need a recorded rights acknowledgement.
      'rightsNotRecordedCount', 0
    ),
    'publication', jsonb_build_object(
      'availableForPublication', count(*) filter (
        where status = 'pending_review'
          and has_publishable_origin
          and privacy_status <> 'blocked'
          and (not possible_living_person or has_current_living_clearance)
      ),
      'availableAfterAcknowledgement', count(*) filter (
        where status = 'pending_review'
          and has_publishable_origin
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
      -- A valid private origin is enough to start the moderator publish
      -- action, which then atomically creates its minimal public source link.
      'originNotApprovedCount', count(*) filter (
        where status = 'pending_review'
          and not has_publishable_origin
      ),
      'rightsNotRecordedCount', 0
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
      'availableForSubmission', 0,
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
      'availableForPublication', 0,
      'availableAfterAcknowledgement', 0,
      'livingNeedsDocumentedConsentCount', 0,
      'privacyBlockedCount', 0,
      'originNotApprovedCount', 0,
      'rightsNotRecordedCount', 0
    )
  ));
end;
$function$;

-- Retain the four-argument signature so an already-open old browser client
-- continues to work.  The two acknowledgement arguments are intentionally
-- ignored: an author can submit their own valid historical drafts directly to
-- moderation.  Their Facebook origin remains private at this stage.
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
  v_limit integer;
  v_processed_count integer := 0;
  v_summary jsonb;
begin
  if v_current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 250 then
    raise exception 'INITIAL_BASE_BULK_LIMIT_INVALID' using errcode = '22023';
  end if;
  v_limit := p_limit;

  -- Serialise a batch's short chunks so an interrupted browser retry cannot
  -- double-submit a card.
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
      and security_private.zagulyaky_is_facebook_post_url_v1(origin_row.facebook_post_url_private)
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
    order by record_row.id
    limit v_limit
    for update of record_row skip locked
  loop
    update public.zagulyaky_records
    set status = 'pending_review',
        submitted_at = now(),
        moderation_note = null,
        -- A possible-living signal is kept for moderation.  It does not block
        -- this submission and it never gives the author a public-clearance
        -- route.
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
        'historicalCatalogueSubmission', true,
        'facebookOriginKeptPrivate', true,
        'foundLocationMissing', nullif(btrim(v_record.found_location_text), '') is null,
        'possibleLivingPerson', v_record.possible_living_person
      )
    );
    v_processed_count := v_processed_count + 1;
  end loop;

  v_summary := security_private.zagulyaky_initial_base_bulk_summary_v1(p_batch_id);
  return jsonb_build_object(
    'batchId', p_batch_id,
    'action', 'submit',
    'processedCount', v_processed_count,
    'remainingEligibleCount', coalesce((v_summary -> 'submission' ->> 'remainingEligibleCount')::integer, 0),
    'excluded', jsonb_build_object(
      'sourceUnavailableInCallCount', 0,
      'privacyBlockedCount', coalesce((v_summary -> 'submission' ->> 'privacyBlockedCount')::integer, 0),
      'missingOriginCount', coalesce((v_summary -> 'submission' ->> 'missingOriginCount')::integer, 0),
      'requiredFieldsMissingCount', coalesce((v_summary -> 'submission' ->> 'requiredFieldsMissingCount')::integer, 0),
      'originApprovalNeedsModeratorCount', 0
    ),
    'warnings', jsonb_build_object(
      'unknownFoundLocationCount', coalesce((v_summary -> 'submission' ->> 'unknownFoundLocationCount')::integer, 0)
    ),
    'summary', v_summary,
    'replayed', v_processed_count = 0
  );
end;
$function$;

-- Publication remains an explicit moderator-only decision.  It accepts a
-- valid private Facebook origin, then makes the minimal link-only projection
-- public in the same transaction immediately before publication.  Thus an
-- author submission cannot expose a Facebook link or publish a card.
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
  v_record_id uuid;
  v_selected_record_ids uuid[] := '{}'::uuid[];
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

  -- Select and lock records first.  The origin-visibility helper takes the
  -- same record-then-origin order, which prevents a visibility/publication
  -- lock inversion with a concurrent source revocation.
  for v_record in
    select record_row.*
    from public.zagulyaky_tabular_import_card_records as record_map
    join public.zagulyaky_records as record_row
      on record_row.id = record_map.record_id
    join public.zagulyaky_tabular_import_record_origins as origin_row
      on origin_row.record_id = record_row.id
    where record_map.batch_id = p_batch_id
      and record_row.status = 'pending_review'
      and record_row.privacy_status <> 'blocked'
      and security_private.zagulyaky_is_facebook_post_url_v1(origin_row.facebook_post_url_private)
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
    order by record_row.id
    limit v_limit
    for update of record_row skip locked
  loop
    v_selected_record_ids := array_append(v_selected_record_ids, v_record.id);
  end loop;

  if cardinality(v_selected_record_ids) > 0 then
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
        'publicOriginLinkApprovedByModerator', true
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
        'nonLivingPrivacyAcknowledged', true,
        'publicOriginsMaterializedByModerator', true
      )
    );
  end if;

  v_summary := security_private.zagulyaky_initial_base_bulk_summary_v1(p_batch_id);
  return jsonb_build_object(
    'batchId', p_batch_id,
    'action', 'publish',
    'processedCount', v_processed_count,
    'remainingEligibleCount', coalesce((v_summary -> 'publication' ->> 'availableForPublication')::integer, 0),
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

-- These function signatures are unchanged, but restate their ACLs in this
-- migration so replacement cannot broaden browser access.
revoke all on function public.submit_zagulyaka_v1(uuid,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_zagulyaka_v1(uuid,integer)
  to authenticated, service_role;

revoke all on function security_private.zagulyaky_initial_base_bulk_summary_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function security_private.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;
revoke all on function security_private.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function security_private.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;
grant execute on function security_private.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;

revoke all on function public.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_my_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;
grant execute on function public.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1(uuid,integer,boolean,boolean)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
