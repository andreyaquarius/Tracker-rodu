begin;

-- TЗ №13, phase 2: a bounded, read-only documentary projection around one
-- Person. The projection is deliberately separate from family-tree storage
-- and never materialises pairwise "mentioned together" Person relations.
set local lock_timeout = '5s';
set local statement_timeout = '10min';

create schema if not exists security_private;

create unique index if not exists documents_id_project_unique
  on public.documents (id, project_id);
create unique index if not exists findings_id_project_unique
  on public.findings (id, project_id);

-- The original single-column foreign keys prove that a row exists, but not
-- that documentary evidence belongs to the same project. Fail visibly before
-- installing the composite guards; never rewrite historical data silently.
do $documentary_scope_preflight$
declare
  mismatch_count bigint;
  sample_id uuid;
begin
  select count(*), min(finding.id::text)::uuid
  into mismatch_count, sample_id
  from public.findings finding
  join public.documents document on document.id = finding.document_id
  where finding.document_id is not null
    and document.project_id <> finding.project_id;
  if mismatch_count > 0 then
    raise exception 'FINDING_DOCUMENT_PROJECT_MISMATCH: % row(s), sample finding %',
      mismatch_count, sample_id using errcode = '23514';
  end if;

  select count(*), min(event_row.id::text)::uuid
  into mismatch_count, sample_id
  from public.person_timeline_events event_row
  join public.documents document on document.id = event_row.source_document_id
  where event_row.source_document_id is not null
    and document.project_id <> event_row.project_id;
  if mismatch_count > 0 then
    raise exception 'PERSON_EVENT_DOCUMENT_PROJECT_MISMATCH: % row(s), sample event %',
      mismatch_count, sample_id using errcode = '23514';
  end if;

  select count(*), min(event_row.id::text)::uuid
  into mismatch_count, sample_id
  from public.person_timeline_events event_row
  join public.findings finding on finding.id = event_row.source_finding_id
  where event_row.source_finding_id is not null
    and finding.project_id <> event_row.project_id;
  if mismatch_count > 0 then
    raise exception 'PERSON_EVENT_FINDING_PROJECT_MISMATCH: % row(s), sample event %',
      mismatch_count, sample_id using errcode = '23514';
  end if;
end;
$documentary_scope_preflight$;

do $documentary_scope_constraints$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.findings'::regclass
      and constraint_row.conname = 'findings_document_project_fkey'
  ) then
    alter table public.findings
      add constraint findings_document_project_fkey
      foreign key (document_id, project_id)
      references public.documents(id, project_id)
      on delete set null (document_id)
      not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.person_timeline_events'::regclass
      and constraint_row.conname = 'person_timeline_events_document_project_fkey'
  ) then
    alter table public.person_timeline_events
      add constraint person_timeline_events_document_project_fkey
      foreign key (source_document_id, project_id)
      references public.documents(id, project_id)
      on delete set null (source_document_id)
      not valid;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.person_timeline_events'::regclass
      and constraint_row.conname = 'person_timeline_events_finding_project_fkey'
  ) then
    alter table public.person_timeline_events
      add constraint person_timeline_events_finding_project_fkey
      foreign key (source_finding_id, project_id)
      references public.findings(id, project_id)
      on delete set null (source_finding_id)
      not valid;
  end if;
end;
$documentary_scope_constraints$;

alter table public.findings
  validate constraint findings_document_project_fkey;
alter table public.person_timeline_events
  validate constraint person_timeline_events_document_project_fkey;
alter table public.person_timeline_events
  validate constraint person_timeline_events_finding_project_fkey;

create index if not exists finding_participants_project_person_finding_idx
  on public.finding_participants (project_id, person_id, finding_id, id)
  where person_id is not null;
create index if not exists person_timeline_events_project_person_updated_idx
  on public.person_timeline_events (project_id, person_id, updated_at desc, id);

create or replace function security_private.get_person_documentary_context_graph_v1(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 2,
  p_entity_types text[] default null,
  p_event_types text[] default null,
  p_evidence_statuses text[] default null,
  p_year_from integer default null,
  p_year_to integer default null,
  p_place_id uuid default null,
  p_max_nodes integer default 100,
  p_max_edges integer default 250
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, security_private, pg_temp
as $function$
declare
  center_row public.persons%rowtype;
  can_edit boolean;
  center_hidden boolean;
  requested_entity_types text[];
  result jsonb;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);

  if p_center_person_id is null then
    raise exception 'DOCUMENTARY_GRAPH_CENTER_PERSON_REQUIRED' using errcode = '22023';
  end if;
  select person.* into center_row
  from public.persons person
  where person.id = p_center_person_id
    and person.project_id = p_project_id;
  if not found then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002';
  end if;
  if p_depth not in (1, 2) then
    raise exception 'DOCUMENTARY_GRAPH_DEPTH_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_max_nodes is null or p_max_nodes < 1 or p_max_nodes > 100 then
    raise exception 'DOCUMENTARY_GRAPH_MAX_NODES_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_max_edges is null or p_max_edges < 1 or p_max_edges > 500 then
    raise exception 'DOCUMENTARY_GRAPH_MAX_EDGES_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_year_from is not null and (p_year_from < 1 or p_year_from > 9999) then
    raise exception 'DOCUMENTARY_GRAPH_YEAR_FROM_INVALID' using errcode = '22023';
  end if;
  if p_year_to is not null and (p_year_to < 1 or p_year_to > 9999) then
    raise exception 'DOCUMENTARY_GRAPH_YEAR_TO_INVALID' using errcode = '22023';
  end if;
  if p_year_from is not null and p_year_to is not null and p_year_from > p_year_to then
    raise exception 'DOCUMENTARY_GRAPH_YEAR_RANGE_INVALID' using errcode = '22023';
  end if;

  requested_entity_types := case
    when cardinality(coalesce(p_entity_types, array[]::text[])) = 0
      then array['person','finding','person_event','document','place']::text[]
    else p_entity_types
  end;
  if exists (
    select 1 from unnest(requested_entity_types) requested(entity_type)
    where requested.entity_type is null
       or requested.entity_type not in ('person','finding','person_event','document','place')
  ) then
    raise exception 'DOCUMENTARY_GRAPH_ENTITY_TYPE_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_evidence_statuses, array[]::text[])) requested(status)
    where requested.status is null
       or requested.status not in ('proven','likely','disputed','disproven','unknown')
  ) then
    raise exception 'DOCUMENTARY_GRAPH_EVIDENCE_STATUS_INVALID' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_event_types, array[]::text[])) requested(event_type)
    where requested.event_type is null
       or requested.event_type !~ '^[a-z][a-z0-9_]{0,63}$'
  ) then
    raise exception 'DOCUMENTARY_GRAPH_EVENT_TYPE_INVALID' using errcode = '22023';
  end if;
  if p_place_id is not null and not exists (
    select 1 from public.places place_row
    where place_row.id = p_place_id
      and (
        place_row.project_id = p_project_id
        or (
          place_row.project_id is null
          and place_row.is_public
          and place_row.status = 'active'
          and place_row.verification_status = 'verified'
        )
      )
  ) then
    raise exception 'DOCUMENTARY_GRAPH_PLACE_NOT_FOUND_OR_FORBIDDEN' using errcode = '42501';
  end if;

  can_edit := coalesce(auth.role(), '') = 'service_role'
    or public.can_edit_project(p_project_id);
  center_hidden := center_row.is_living
    and center_row.privacy_status in ('private', 'confidential')
    and not can_edit;

  -- A viewer who knows a private living Person UUID receives no documentary
  -- neighbourhood, identifiers, counts or timestamps belonging to that Person.
  if center_hidden then
    return jsonb_build_object(
      'centerNodeId', 'person:' || p_center_person_id::text,
      'nodes', jsonb_build_array(jsonb_build_object(
        'id', 'person:' || p_center_person_id::text,
        'entityType', 'person',
        'entityId', p_center_person_id,
        'label', 'Приватна особа',
        'secondaryLabel', '',
        'depth', 0,
        'masked', true,
        'metadata', jsonb_build_object('isCenter', true, 'isLiving', true)
      )),
      'edges', '[]'::jsonb,
      'generatedAt', statement_timestamp(),
      'snapshotUpdatedAt', null,
      'truncated', false,
      'edgesTruncated', false
    );
  end if;

  with
  -- Source scans stay inline so PostgreSQL can push the bounded top-N work
  -- below the wider documentary projection.  Every priority bucket keeps one
  -- extra row: that is enough to report truncation without materialising the
  -- complete neighbourhood.
  finding_link_sources as (
    select participant.finding_id, 'participant'::text as source_kind
    from public.finding_participants participant
    where participant.project_id = p_project_id
      and participant.person_id = p_center_person_id
    union all
    select person_name.source_finding_id, 'person_name'
    from public.person_names person_name
    where person_name.project_id = p_project_id
      and person_name.person_id = p_center_person_id
      and person_name.source_finding_id is not null
    union all
    select event_row.source_finding_id, 'person_event'
    from public.person_timeline_events event_row
    where event_row.project_id = p_project_id
      and event_row.person_id = p_center_person_id
      and event_row.source_finding_id is not null
  ),
  direct_finding_ids as materialized (
    select source.finding_id, count(*)::integer as source_count
    from finding_link_sources source
    join public.findings finding
      on finding.id = source.finding_id
     and finding.project_id = p_project_id
    where (
      p_year_from is null
      or (
        security_private.historical_text_date_bound_v1(finding.event_date, true) is not null
        and security_private.historical_text_date_bound_v1(finding.event_date, true)
          >= make_date(p_year_from, 1, 1)
      )
    )
      and (
        p_year_to is null
        or (
          security_private.historical_text_date_bound_v1(finding.event_date, false) is not null
          and security_private.historical_text_date_bound_v1(finding.event_date, false)
            <= make_date(p_year_to, 12, 31)
        )
      )
      and (
        cardinality(coalesce(p_evidence_statuses, array[]::text[])) = 0
        or (case
          when finding.needs_review then 'unknown'
          when lower(finding.reliability) in ('proven','доведено','підтверджено') then 'proven'
          when lower(finding.reliability) in ('likely','імовірно','ймовірно') then 'likely'
          when lower(finding.reliability) in ('disputed','сумнівно','суперечливо') then 'disputed'
          when lower(finding.reliability) in ('disproven','спростовано') then 'disproven'
          else 'unknown'
        end) = any(p_evidence_statuses)
      )
      and (
        p_place_id is null
        or exists (
          select 1 from public.document_place_links link_row
          where link_row.project_id = p_project_id
            and link_row.place_id = p_place_id
            and link_row.resolution_status = 'confirmed'
            and (
              link_row.source_finding_id = finding.id
              or link_row.document_id = finding.document_id
            )
        )
        or exists (
          select 1 from public.person_timeline_events linked_event
          where linked_event.project_id = p_project_id
            and linked_event.source_finding_id = finding.id
            and linked_event.place_id = p_place_id
            and linked_event.place_resolution_status = 'confirmed'
        )
      )
    group by source.finding_id
    order by max(finding.updated_at) desc nulls last, source.finding_id
    limit (p_max_nodes + 1)
  ),
  direct_findings as materialized (
    select finding.*, linked.source_count,
      case
        when finding.needs_review then 'unknown'
        when lower(finding.reliability) in ('proven','доведено','підтверджено') then 'proven'
        when lower(finding.reliability) in ('likely','імовірно','ймовірно') then 'likely'
        when lower(finding.reliability) in ('disputed','сумнівно','суперечливо') then 'disputed'
        when lower(finding.reliability) in ('disproven','спростовано') then 'disproven'
        else 'unknown'
      end as graph_status
    from direct_finding_ids linked
    join public.findings finding
      on finding.id = linked.finding_id
     and finding.project_id = p_project_id
  ),
  direct_events as materialized (
    select event_row.*
    from public.person_timeline_events event_row
    where event_row.project_id = p_project_id
      and event_row.person_id = p_center_person_id
      and (
        cardinality(coalesce(p_event_types, array[]::text[])) = 0
        or event_row.event_type = any(p_event_types)
      )
      and (
        cardinality(coalesce(p_evidence_statuses, array[]::text[])) = 0
        or event_row.evidence_status = any(p_evidence_statuses)
      )
      and (
        p_year_from is null
        or coalesce(
          security_private.historical_text_date_bound_v1(event_row.date_to, true),
          security_private.historical_text_date_bound_v1(event_row.event_date, true),
          security_private.historical_text_date_bound_v1(event_row.date_text, true)
        ) >= make_date(p_year_from, 1, 1)
      )
      and (
        p_year_to is null
        or coalesce(
          security_private.historical_text_date_bound_v1(event_row.date_from, false),
          security_private.historical_text_date_bound_v1(event_row.event_date, false),
          security_private.historical_text_date_bound_v1(event_row.date_text, false)
        ) <= make_date(p_year_to, 12, 31)
      )
      and (
        p_place_id is null
        or (
          event_row.place_id = p_place_id
          and event_row.place_resolution_status = 'confirmed'
        )
        or exists (
          select 1 from public.document_place_links link_row
          where link_row.project_id = p_project_id
            and link_row.document_id = event_row.source_document_id
            and link_row.place_id = p_place_id
            and link_row.resolution_status = 'confirmed'
        )
      )
    order by event_row.updated_at desc nulls last, event_row.id
    limit (p_max_nodes + 1)
  ),
  document_link_sources as (
    select finding.document_id, 'finding'::text as source_kind
    from direct_findings finding where finding.document_id is not null
    union all
    select reference.document_id, 'finding_reference'
    from public.finding_document_references reference
    join direct_findings finding on finding.id = reference.finding_id
    where reference.project_id = p_project_id
    union all
    select event_row.source_document_id, 'person_event'
    from direct_events event_row where event_row.source_document_id is not null
    union all
    select person_name.source_document_id, 'person_name'
    from public.person_names person_name
    where person_name.project_id = p_project_id
      and person_name.person_id = p_center_person_id
      and person_name.source_document_id is not null
      and (
        cardinality(coalesce(p_evidence_statuses, array[]::text[])) = 0
        or person_name.evidence_status = any(p_evidence_statuses)
      )
  ),
  direct_document_ids as materialized (
    select source.document_id, count(*)::integer as source_count
    from document_link_sources source
    join public.documents document
      on document.id = source.document_id
     and document.project_id = p_project_id
    where (
      p_year_from is null
      or (
        security_private.historical_text_date_bound_v1(document.year_to, true) is not null
        and security_private.historical_text_date_bound_v1(document.year_to, true)
          >= make_date(p_year_from, 1, 1)
      )
    )
      and (
        p_year_to is null
        or (
          security_private.historical_text_date_bound_v1(document.year_from, false) is not null
          and security_private.historical_text_date_bound_v1(document.year_from, false)
            <= make_date(p_year_to, 12, 31)
        )
      )
      and (
        p_place_id is null
        or exists (
          select 1 from public.document_place_links link_row
          where link_row.project_id = p_project_id
            and link_row.document_id = document.id
            and link_row.place_id = p_place_id
            and link_row.resolution_status = 'confirmed'
        )
        or exists (
          select 1 from direct_events event_row
          where event_row.source_document_id = document.id
            and event_row.place_id = p_place_id
            and event_row.place_resolution_status = 'confirmed'
        )
      )
    group by source.document_id
    order by max(document.updated_at) desc nulls last, source.document_id
    limit (p_max_nodes + 1)
  ),
  direct_documents as materialized (
    select document.*, linked.source_count
    from direct_document_ids linked
    join public.documents document
      on document.id = linked.document_id
     and document.project_id = p_project_id
  ),
  finding_people as materialized (
    select participant.finding_id, participant.person_id,
      min(nullif(btrim(participant.role), '')) as role_label,
      count(*)::integer as source_count,
      max(participant.created_at) as updated_at
    from public.finding_participants participant
    join direct_findings finding on finding.id = participant.finding_id
    join public.persons person
      on person.id = participant.person_id
     and person.project_id = p_project_id
    where participant.project_id = p_project_id
      and participant.person_id is not null
      and participant.person_id <> p_center_person_id
      and p_depth >= 2
      and 'person' = any(requested_entity_types)
      and 'finding' = any(requested_entity_types)
      and not (
        person.is_living
        and person.privacy_status in ('private', 'confidential')
        and not can_edit
      )
    group by participant.finding_id, participant.person_id
    order by max(participant.created_at) desc nulls last,
      participant.finding_id, participant.person_id
    limit (p_max_nodes + 1)
  ),
  finding_people_rollup as materialized (
    select linked.person_id,
      count(distinct linked.finding_id)::integer as finding_count,
      sum(linked.source_count)::integer as source_count,
      max(linked.updated_at) as updated_at
    from finding_people linked
    group by linked.person_id
  ),
  direct_place_ids as (
    select event_row.place_id, count(*)::integer as source_count
    from direct_events event_row
    where event_row.place_id is not null
      and event_row.place_resolution_status = 'confirmed'
      and p_depth >= 2
      and 'place' = any(requested_entity_types)
    group by event_row.place_id
    union all
    select link_row.place_id, count(*)::integer
    from public.document_place_links link_row
    join direct_documents document on document.id = link_row.document_id
    where link_row.project_id = p_project_id
      and link_row.resolution_status = 'confirmed'
      and p_depth >= 2
      and 'place' = any(requested_entity_types)
    group by link_row.place_id
  ),
  direct_places as materialized (
    select place_row.*, sum(linked.source_count)::integer as source_count,
      coalesce(period_name.name, place_row.canonical_name) as period_name
    from direct_place_ids linked
    join public.places place_row on place_row.id = linked.place_id
    left join lateral (
      select place_name.name
      from public.place_names place_name
      where place_name.place_id = place_row.id
        and (p_year_from is null or place_name.valid_to is null
          or place_name.valid_to >= make_date(p_year_from, 1, 1))
        and (p_year_to is null or place_name.valid_from is null
          or place_name.valid_from <= make_date(p_year_to, 12, 31))
      order by place_name.is_primary desc, place_name.confidence desc nulls last,
        place_name.updated_at desc, place_name.id
      limit 1
    ) period_name on true
    where (
      place_row.project_id = p_project_id
      or (
        place_row.project_id is null
        and place_row.is_public
        and place_row.status = 'active'
        and place_row.verification_status = 'verified'
      )
    )
      and (p_place_id is null or place_row.id = p_place_id)
    group by place_row.id, period_name.name
    order by place_row.updated_at desc nulls last, place_row.id
    limit (p_max_nodes + 1)
  ),
  candidate_nodes as materialized (
    select
      'person:' || center_row.id::text as node_key,
      'person'::text as entity_type,
      center_row.id as entity_id,
      0 as depth,
      0 as priority,
      center_row.updated_at as sort_at,
      jsonb_build_object(
        'id', 'person:' || center_row.id::text,
        'entityType', 'person',
        'entityId', center_row.id,
        'label', coalesce(
          nullif(center_row.full_name, ''),
          nullif(btrim(concat_ws(' ', center_row.surname, center_row.given_name, center_row.patronymic)), ''),
          'Особа'
        ),
        'secondaryLabel', '',
        'depth', 0,
        'masked', false,
        'metadata', jsonb_build_object(
          'isCenter', true,
          'isLiving', center_row.is_living,
          'privacyStatus', center_row.privacy_status
        )
      ) as payload
    union all
    select
      'document:' || document.id::text,
      'document', document.id, 1, 10, document.updated_at,
      jsonb_build_object(
        'id', 'document:' || document.id::text,
        'entityType', 'document',
        'entityId', document.id,
        'label', case when can_edit then coalesce(nullif(document.title, ''), 'Документ')
          else coalesce(nullif(document.document_type, ''), 'Документ') end,
        'secondaryLabel', btrim(concat_ws(' · ',
          nullif(document.document_type, ''),
          nullif(concat_ws('–', nullif(document.year_from, ''), nullif(document.year_to, '')), '')
        )),
        'depth', 1,
        'masked', false,
        'metadata', jsonb_build_object(
          'documentType', document.document_type,
          'yearFrom', document.year_from,
          'yearTo', document.year_to,
          'archive', document.archive,
          'fund', document.fund,
          'sourceCount', document.source_count
        )
      )
    from direct_documents document
    where 'document' = any(requested_entity_types)
    union all
    select
      'finding:' || finding.id::text,
      'finding', finding.id, 1, 20, finding.updated_at,
      jsonb_build_object(
        'id', 'finding:' || finding.id::text,
        'entityType', 'finding',
        'entityId', finding.id,
        'label', case when nullif(btrim(finding.finding_type), '') is null
          then 'Знахідка' else 'Знахідка: ' || finding.finding_type end,
        'secondaryLabel', btrim(concat_ws(' · ', nullif(finding.event_date, ''),
          case when nullif(finding.page, '') is not null then 'с. ' || finding.page end)),
        'depth', 1,
        'masked', false,
        'metadata', jsonb_build_object(
          'findingType', finding.finding_type,
          'eventDate', finding.event_date,
          'page', finding.page,
          'needsReview', finding.needs_review,
          'evidenceStatus', finding.graph_status,
          'documentId', finding.document_id,
          'sourceCount', finding.source_count
        )
      )
    from direct_findings finding
    where 'finding' = any(requested_entity_types)
    union all
    select
      'person_event:' || event_row.id::text,
      'person_event', event_row.id, 1, 30, event_row.updated_at,
      jsonb_build_object(
        'id', 'person_event:' || event_row.id::text,
        'entityType', 'person_event',
        'entityId', event_row.id,
        'label', event_row.event_type,
        'secondaryLabel', coalesce(
          nullif(event_row.date_text, ''),
          nullif(event_row.event_date, ''),
          ''
        ),
        'depth', 1,
        'masked', false,
        'metadata', jsonb_build_object(
          'eventType', event_row.event_type,
          'eventDate', event_row.event_date,
          'dateFrom', event_row.date_from,
          'dateTo', event_row.date_to,
          'dateText', event_row.date_text,
          'placeId', case
            when event_row.place_resolution_status = 'confirmed' then event_row.place_id
            else null
          end,
          'personId', event_row.person_id,
          'evidenceStatus', event_row.evidence_status,
          'confidence', event_row.confidence,
          'eventRole', event_row.event_role,
          'sourceDocumentId', event_row.source_document_id,
          'sourceFindingId', event_row.source_finding_id
        )
      )
    from direct_events event_row
    where 'person_event' = any(requested_entity_types)
    union all
    select
      'place:' || place_row.id::text,
      'place', place_row.id, 2, 40, place_row.updated_at,
      jsonb_build_object(
        'id', 'place:' || place_row.id::text,
        'entityType', 'place',
        'entityId', place_row.id,
        'label', place_row.period_name,
        'secondaryLabel', nullif(place_row.modern_name, ''),
        'depth', 2,
        'masked', false,
        'metadata', jsonb_build_object(
          'modernName', place_row.modern_name,
          'latitude', place_row.latitude,
          'longitude', place_row.longitude,
          'verificationStatus', place_row.verification_status,
          'sourceCount', place_row.source_count
        )
      )
    from direct_places place_row
    where p_depth >= 2 and 'place' = any(requested_entity_types)
    union all
    select
      'person:' || person.id::text,
      'person', person.id, 2, 50, linked.updated_at,
      jsonb_build_object(
        'id', 'person:' || person.id::text,
        'entityType', 'person',
        'entityId', person.id,
        'label', coalesce(nullif(person.full_name, ''),
          nullif(btrim(concat_ws(' ', person.surname, person.given_name, person.patronymic)), ''),
          'Особа'),
        'secondaryLabel', case
          when linked.finding_count = 1 then 'Учасник спільної знахідки'
          else 'Спільних знахідок: ' || linked.finding_count::text
        end,
        'depth', 2,
        'masked', false,
        'metadata', jsonb_build_object(
          'isCenter', false,
          'isLiving', person.is_living,
          'privacyStatus', person.privacy_status,
           'sourceCount', linked.source_count,
           'findingCount', linked.finding_count
         )
       )
    from finding_people_rollup linked
    join public.persons person
      on person.id = linked.person_id and person.project_id = p_project_id
    where p_depth >= 2
      and 'person' = any(requested_entity_types)
      and 'finding' = any(requested_entity_types)
    group by person.id, linked.finding_count, linked.source_count, linked.updated_at
  ),
  ranked_nodes as materialized (
    select node.*,
      row_number() over (order by node.priority, node.sort_at desc nulls last, node.node_key) as node_rank
    from candidate_nodes node
    where node.depth <= p_depth
  ),
  selected_nodes as materialized (
    select node.* from ranked_nodes node where node.node_rank <= p_max_nodes
  ),
  finding_document_pair_sources as (
    select finding.id as finding_id, finding.document_id as document_id,
      1::integer as source_count, finding.updated_at
    from direct_findings finding
    where finding.document_id is not null
    union all
    select reference.finding_id, reference.document_id,
      1::integer, reference.updated_at
    from public.finding_document_references reference
    join direct_findings finding on finding.id = reference.finding_id
    where reference.project_id = p_project_id
  ),
  finding_document_pairs as materialized (
    select source.finding_id, source.document_id,
      sum(source.source_count)::integer as source_count,
      max(source.updated_at) as updated_at
    from finding_document_pair_sources source
    where p_depth >= 2
      and 'finding' = any(requested_entity_types)
      and 'document' = any(requested_entity_types)
    group by source.finding_id, source.document_id
    order by max(source.updated_at) desc nulls last,
      source.finding_id, source.document_id
    limit (p_max_edges + 1)
  ),
  document_place_pairs as materialized (
    select link_row.document_id, link_row.place_id,
      count(*)::integer as source_count, max(link_row.updated_at) as updated_at
    from public.document_place_links link_row
    join direct_documents document on document.id = link_row.document_id
    join direct_places place_row on place_row.id = link_row.place_id
    where link_row.project_id = p_project_id
      and link_row.resolution_status = 'confirmed'
      and p_depth >= 2
      and 'document' = any(requested_entity_types)
      and 'place' = any(requested_entity_types)
    group by link_row.document_id, link_row.place_id
    order by max(link_row.updated_at) desc nulls last,
      link_row.document_id, link_row.place_id
    limit (p_max_edges + 1)
  ),
  candidate_edges as materialized (
    select
      'person_finding:' || p_center_person_id::text || ':' || finding.id::text as edge_id,
      'person:' || p_center_person_id::text as source_key,
      'finding:' || finding.id::text as target_key,
      1 as required_depth, 10 as priority, finding.updated_at as sort_at,
      jsonb_build_object(
        'id', 'person_finding:' || p_center_person_id::text || ':' || finding.id::text,
        'source', 'person:' || p_center_person_id::text,
        'target', 'finding:' || finding.id::text,
        'relationType', 'linked_to_finding',
        'label', 'пов’язано зі знахідкою',
        'status', finding.graph_status,
        'confidence', case finding.graph_status when 'proven' then 100 when 'likely' then 75 else 50 end,
        'sourceCount', finding.source_count,
        'generated', true,
        'metadata', '{}'::jsonb
      ) as payload
    from direct_findings finding
    union all
    select
      'person_event:' || p_center_person_id::text || ':' || event_row.id::text,
      'person:' || p_center_person_id::text,
      'person_event:' || event_row.id::text,
      1, 20, event_row.updated_at,
      jsonb_build_object(
        'id', 'person_event:' || p_center_person_id::text || ':' || event_row.id::text,
        'source', 'person:' || p_center_person_id::text,
        'target', 'person_event:' || event_row.id::text,
        'relationType', 'has_event',
        'label', 'подія особи',
        'status', event_row.evidence_status,
        'confidence', event_row.confidence,
        'sourceCount', 1,
        'generated', false,
        'metadata', jsonb_build_object('eventRole', event_row.event_role)
      )
    from direct_events event_row
    union all
    select
      'person_document:' || p_center_person_id::text || ':' || document.id::text,
      'person:' || p_center_person_id::text,
      'document:' || document.id::text,
      1, 30, document.updated_at,
      jsonb_build_object(
        'id', 'person_document:' || p_center_person_id::text || ':' || document.id::text,
        'source', 'person:' || p_center_person_id::text,
        'target', 'document:' || document.id::text,
        'relationType', 'documented_in',
        'label', 'зафіксовано в документі',
        'status', 'unknown',
        'confidence', 50,
        'sourceCount', document.source_count,
        'generated', true,
        'metadata', '{}'::jsonb
      )
    from direct_documents document
    union all
    select
      'finding_document:' || pair.finding_id::text || ':' || pair.document_id::text,
      'finding:' || pair.finding_id::text,
      'document:' || pair.document_id::text,
      2, 40, pair.updated_at,
      jsonb_build_object(
        'id', 'finding_document:' || pair.finding_id::text || ':' || pair.document_id::text,
        'source', 'finding:' || pair.finding_id::text,
        'target', 'document:' || pair.document_id::text,
        'relationType', 'recorded_in',
        'label', 'записано в документі',
        'status', 'unknown',
        'confidence', 50,
        'sourceCount', pair.source_count,
        'generated', true,
        'metadata', '{}'::jsonb
      )
    from finding_document_pairs pair
    union all
    select
      'finding_person:' || linked.finding_id::text || ':' || linked.person_id::text,
      'finding:' || linked.finding_id::text,
      'person:' || linked.person_id::text,
      2, 50, linked.updated_at,
      jsonb_build_object(
        'id', 'finding_person:' || linked.finding_id::text || ':' || linked.person_id::text,
        'source', 'finding:' || linked.finding_id::text,
        'target', 'person:' || linked.person_id::text,
        'relationType', 'has_participant',
        'label', coalesce(linked.role_label, 'учасник'),
        'status', 'unknown',
        'confidence', 50,
        'sourceCount', linked.source_count,
        'generated', true,
        'metadata', '{}'::jsonb
      )
    from finding_people linked
    union all
    select
      'event_document:' || event_row.id::text || ':' || event_row.source_document_id::text,
      'person_event:' || event_row.id::text,
      'document:' || event_row.source_document_id::text,
      2, 60, event_row.updated_at,
      jsonb_build_object(
        'id', 'event_document:' || event_row.id::text || ':' || event_row.source_document_id::text,
        'source', 'person_event:' || event_row.id::text,
        'target', 'document:' || event_row.source_document_id::text,
        'relationType', 'supported_by_document',
        'label', 'підтверджено документом',
        'status', event_row.evidence_status,
        'confidence', event_row.confidence,
        'sourceCount', 1,
        'generated', false,
        'metadata', '{}'::jsonb
      )
    from direct_events event_row where event_row.source_document_id is not null
    union all
    select
      'event_finding:' || event_row.id::text || ':' || event_row.source_finding_id::text,
      'person_event:' || event_row.id::text,
      'finding:' || event_row.source_finding_id::text,
      2, 70, event_row.updated_at,
      jsonb_build_object(
        'id', 'event_finding:' || event_row.id::text || ':' || event_row.source_finding_id::text,
        'source', 'person_event:' || event_row.id::text,
        'target', 'finding:' || event_row.source_finding_id::text,
        'relationType', 'supported_by_finding',
        'label', 'підтверджено знахідкою',
        'status', event_row.evidence_status,
        'confidence', event_row.confidence,
        'sourceCount', 1,
        'generated', false,
        'metadata', '{}'::jsonb
      )
    from direct_events event_row where event_row.source_finding_id is not null
    union all
    select
      'event_place:' || event_row.id::text || ':' || event_row.place_id::text,
      'person_event:' || event_row.id::text,
      'place:' || event_row.place_id::text,
      2, 80, event_row.updated_at,
      jsonb_build_object(
        'id', 'event_place:' || event_row.id::text || ':' || event_row.place_id::text,
        'source', 'person_event:' || event_row.id::text,
        'target', 'place:' || event_row.place_id::text,
        'relationType', 'occurred_at',
        'label', 'відбулося у місці',
        'status', event_row.evidence_status,
        'confidence', event_row.confidence,
        'sourceCount', 1,
        'generated', false,
        'metadata', '{}'::jsonb
      )
    from direct_events event_row
    join direct_places place_row on place_row.id = event_row.place_id
    where event_row.place_id is not null
      and event_row.place_resolution_status = 'confirmed'
    union all
    select
      'document_place:' || pair.document_id::text || ':' || pair.place_id::text,
      'document:' || pair.document_id::text,
      'place:' || pair.place_id::text,
      2, 90, pair.updated_at,
      jsonb_build_object(
        'id', 'document_place:' || pair.document_id::text || ':' || pair.place_id::text,
        'source', 'document:' || pair.document_id::text,
        'target', 'place:' || pair.place_id::text,
        'relationType', 'mentions_place',
        'label', 'згадує місце',
        'status', 'proven',
        'confidence', 100,
        'sourceCount', pair.source_count,
        'generated', false,
        'metadata', '{}'::jsonb
      )
    from document_place_pairs pair
  ),
  eligible_edges as materialized (
    select edge.*,
      row_number() over (order by edge.priority, edge.sort_at desc nulls last, edge.edge_id) as edge_rank
    from candidate_edges edge
    join selected_nodes source_node on source_node.node_key = edge.source_key
    join selected_nodes target_node on target_node.node_key = edge.target_key
    where edge.required_depth <= p_depth
  ),
  selected_edges as materialized (
    select edge.* from eligible_edges edge where edge.edge_rank <= p_max_edges
  ),
  connected_node_keys as (
    select 'person:' || p_center_person_id::text as node_key
    union select edge.source_key from selected_edges edge
    union select edge.target_key from selected_edges edge
  ),
  final_nodes as materialized (
    select node.* from selected_nodes node
    join connected_node_keys connected on connected.node_key = node.node_key
  )
  select jsonb_build_object(
    'centerNodeId', 'person:' || p_center_person_id::text,
    'nodes', coalesce((
      select jsonb_agg(node.payload order by node.node_rank)
      from final_nodes node
    ), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(edge.payload order by edge.edge_rank)
      from selected_edges edge
    ), '[]'::jsonb),
    'generatedAt', statement_timestamp(),
    'snapshotUpdatedAt', (
      select max(node.sort_at) from final_nodes node
    ),
    'truncated', (select count(*) > p_max_nodes from ranked_nodes),
    'edgesTruncated', (select count(*) > p_max_edges from eligible_edges)
  ) into result;

  return result;
end;
$function$;

create or replace function public.get_person_documentary_context_graph_v1(
  p_project_id uuid,
  p_center_person_id uuid,
  p_depth integer default 2,
  p_entity_types text[] default null,
  p_event_types text[] default null,
  p_evidence_statuses text[] default null,
  p_year_from integer default null,
  p_year_to integer default null,
  p_place_id uuid default null,
  p_max_nodes integer default 100,
  p_max_edges integer default 250
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_person_documentary_context_graph_v1(
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
  );
$wrapper$;

revoke all on function security_private.get_person_documentary_context_graph_v1(
  uuid, uuid, integer, text[], text[], text[], integer, integer, uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.get_person_documentary_context_graph_v1(
  uuid, uuid, integer, text[], text[], text[], integer, integer, uuid, integer, integer
) to authenticated, service_role;

revoke all on function public.get_person_documentary_context_graph_v1(
  uuid, uuid, integer, text[], text[], text[], integer, integer, uuid, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.get_person_documentary_context_graph_v1(
  uuid, uuid, integer, text[], text[], text[], integer, integer, uuid, integer, integer
) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
