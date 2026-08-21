-- The local counter previously shared its name with the batch table column.
-- With plpgsql.variable_conflict = error, the final assignment was ambiguous
-- and rolled back the entire materialization call.  Keep every import rule
-- intact while giving the local counter a distinct name.
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
  computed_failed_card_count integer;
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
  select count(*)::integer into computed_failed_card_count
  from public.zagulyaky_tabular_import_cards
  where batch_id = p_batch_id and materialization_status = 'failed';

  update public.zagulyaky_tabular_import_batches
  set materialized_card_count = materialized_card_count + materialized_in_call,
      failed_card_count = computed_failed_card_count,
      status = case
        when remaining_card_count = 0 and computed_failed_card_count = 0 then 'completed'
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
