begin;

-- Co-occurrence is a calculated, center-person projection. It never persists
-- Person pairs. V1 deliberately requires one concrete shared provenance
-- context and never treats every Person in a large multi-record Document as
-- co-mentioned merely because their separate Findings cite that Document.
create or replace function security_private.list_person_context_cooccurrences_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_year_from integer default null,
  p_year_to integer default null,
  p_place_id uuid default null,
  p_min_shared integer default 1,
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
  center_row public.persons%rowtype;
  can_edit boolean;
  center_hidden boolean;
  result jsonb;
  source_cap constant integer := 500;
  members_per_source_cap constant integer := 500;
  pair_cap constant integer := 10000;
begin
  perform security_private.require_context_project_access_v1(p_project_id, false);

  if p_person_id is null then
    raise exception 'CONTEXT_COOCCURRENCE_PERSON_REQUIRED' using errcode = '22023';
  end if;
  select person.* into center_row
  from public.persons person
  where person.id = p_person_id and person.project_id = p_project_id;
  if not found then
    raise exception 'PERSON_NOT_FOUND_IN_PROJECT' using errcode = 'P0002';
  end if;

  if p_year_from is not null and (p_year_from < 1 or p_year_from > 9999) then
    raise exception 'CONTEXT_COOCCURRENCE_YEAR_FROM_INVALID' using errcode = '22023';
  end if;
  if p_year_to is not null and (p_year_to < 1 or p_year_to > 9999) then
    raise exception 'CONTEXT_COOCCURRENCE_YEAR_TO_INVALID' using errcode = '22023';
  end if;
  if p_year_from is not null and p_year_to is not null and p_year_from > p_year_to then
    raise exception 'CONTEXT_COOCCURRENCE_YEAR_RANGE_INVALID' using errcode = '22023';
  end if;
  if p_min_shared is null or p_min_shared < 1 or p_min_shared > 1000 then
    raise exception 'CONTEXT_COOCCURRENCE_MIN_SHARED_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'CONTEXT_COOCCURRENCE_LIMIT_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception 'CONTEXT_COOCCURRENCE_OFFSET_OUT_OF_RANGE' using errcode = '22023';
  end if;
  if p_place_id is not null and not exists (
    select 1 from public.places place_row
    where place_row.id = p_place_id
      and (
        place_row.project_id = p_project_id
        or (
          place_row.project_id is null and place_row.is_public
          and place_row.status = 'active'
          and place_row.verification_status = 'verified'
        )
      )
  ) then
    raise exception 'CONTEXT_COOCCURRENCE_PLACE_NOT_FOUND_OR_FORBIDDEN'
      using errcode = '42501';
  end if;

  can_edit := coalesce(auth.role(), '') = 'service_role'
    or public.can_edit_project(p_project_id);
  center_hidden := center_row.is_living
    and center_row.privacy_status in ('private', 'confidential')
    and not can_edit;
  if center_hidden then
    return jsonb_build_object(
      'centerPersonId', p_person_id,
      'algorithmVersion', 'cooccurrence_v1',
      'items', '[]'::jsonb,
      'total', 0,
      'truncated', false
    );
  end if;

  with
  -- The center's own Finding set may be large, but it cannot initiate more
  -- than source_cap bounded fan-outs in one request.
  center_finding_links as materialized (
    select participant.finding_id, participant.created_at as linked_at
    from public.finding_participants participant
    where participant.project_id = p_project_id
      and participant.person_id = p_person_id
    union all
    select person_name.source_finding_id, person_name.updated_at
    from public.person_names person_name
    where person_name.project_id = p_project_id
      and person_name.person_id = p_person_id
      and person_name.source_finding_id is not null
    union all
    select event_row.source_finding_id, event_row.updated_at
    from public.person_timeline_events event_row
    where event_row.project_id = p_project_id
      and event_row.person_id = p_person_id
      and event_row.source_finding_id is not null
  ),
  center_finding_candidates as materialized (
    select
      finding.id,
      finding.document_id,
      finding.finding_type,
      finding.event_date,
      finding.updated_at,
      security_private.historical_text_date_bound_v1(finding.event_date, true) as date_from,
      security_private.historical_text_date_bound_v1(finding.event_date, false) as date_to
    from (
      select link.finding_id, max(link.linked_at) as linked_at
      from center_finding_links link
      group by link.finding_id
    ) linked
    join public.findings finding
      on finding.id = linked.finding_id and finding.project_id = p_project_id
    where (
      p_year_from is null
      or security_private.historical_text_date_bound_v1(finding.event_date, false)
        >= make_date(p_year_from, 1, 1)
    )
      and (
        p_year_to is null
        or security_private.historical_text_date_bound_v1(finding.event_date, true)
          <= make_date(p_year_to, 12, 31)
      )
      and (
        p_place_id is null
        or exists (
          select 1 from public.document_place_links place_link
          where place_link.project_id = p_project_id
            and place_link.source_finding_id = finding.id
            and place_link.place_id = p_place_id
            and place_link.resolution_status = 'confirmed'
        )
        or exists (
          select 1 from public.person_timeline_events finding_event
          where finding_event.project_id = p_project_id
            and finding_event.source_finding_id = finding.id
            and finding_event.place_id = p_place_id
            and finding_event.place_resolution_status = 'confirmed'
        )
      )
    order by linked.linked_at desc nulls last, finding.id
    limit (source_cap + 1)
  ),
  center_findings as materialized (
    select candidate.*
    from center_finding_candidates candidate
    order by candidate.updated_at desc nulls last, candidate.id
    limit source_cap
  ),
  shared_finding_candidates as materialized (
    select
      member.person_id,
      finding.id as source_id,
      finding.document_id,
      finding.finding_type,
      finding.date_from,
      finding.date_to,
      finding.updated_at,
      member.source_truncated
    from center_findings finding
    cross join lateral (
      select bounded.person_id,
        bounded.member_count > members_per_source_cap as source_truncated
      from (
        select unique_member.person_id, count(*) over () as member_count
        from (
          select distinct member.person_id
          from (
            (select distinct participant.person_id
             from public.finding_participants participant
             where participant.project_id = p_project_id
               and participant.finding_id = finding.id
               and participant.person_id is not null
             order by participant.person_id
             limit (members_per_source_cap + 1))
            union all
            (select distinct person_name.person_id
             from public.person_names person_name
             where person_name.project_id = p_project_id
               and person_name.source_finding_id = finding.id
             order by person_name.person_id
             limit (members_per_source_cap + 1))
            union all
            (select distinct event_row.person_id
             from public.person_timeline_events event_row
             where event_row.project_id = p_project_id
               and event_row.source_finding_id = finding.id
             order by event_row.person_id
             limit (members_per_source_cap + 1))
          ) member
          where member.person_id <> p_person_id
          order by member.person_id
          limit (members_per_source_cap + 1)
        ) unique_member
      ) bounded
      order by bounded.person_id
      limit members_per_source_cap
    ) member
    order by finding.updated_at desc nulls last, finding.id, member.person_id
    limit (pair_cap + 1)
  ),
  shared_findings as materialized (
    select candidate.*
    from shared_finding_candidates candidate
    order by candidate.updated_at desc nulls last, candidate.source_id, candidate.person_id
    limit pair_cap
  ),

  -- sharedEventCount is based on real person_timeline_events only. V1 accepts
  -- a canonical event context only when both rows cite the same Finding and
  -- have the same type plus compatible date bounds. A bare same-Document/date
  -- match is deliberately forbidden: one register may contain different
  -- events of the same type on the same date.
  center_event_rows as materialized (
    select
      event_row.id,
      event_row.event_type,
      event_row.source_finding_id,
      event_row.source_document_id,
      event_row.place_id,
      event_row.place_resolution_status,
      event_row.updated_at,
      coalesce(
        security_private.historical_text_date_bound_v1(event_row.date_from, true),
        security_private.historical_text_date_bound_v1(event_row.event_date, true),
        security_private.historical_text_date_bound_v1(event_row.date_text, true),
        security_private.historical_text_date_bound_v1(event_row.date_to, true)
      ) as date_from,
      coalesce(
        security_private.historical_text_date_bound_v1(event_row.date_to, false),
        security_private.historical_text_date_bound_v1(event_row.event_date, false),
        security_private.historical_text_date_bound_v1(event_row.date_text, false),
        security_private.historical_text_date_bound_v1(event_row.date_from, false)
      ) as date_to
    from public.person_timeline_events event_row
    where event_row.project_id = p_project_id
      and event_row.person_id = p_person_id
      and event_row.source_finding_id is not null
  ),
  center_event_candidates as materialized (
    select distinct on (event_row.source_finding_id, event_row.event_type)
      event_row.*
    from center_event_rows event_row
    order by event_row.source_finding_id, event_row.event_type,
      event_row.updated_at desc nulls last, event_row.id
    limit (source_cap + 1)
  ),
  center_events as materialized (
    select candidate.*
    from center_event_candidates candidate
    order by candidate.updated_at desc nulls last, candidate.id
    limit source_cap
  ),
  shared_event_candidates as materialized (
    select
      shared.person_id,
      'finding:' || center_event.source_finding_id::text
        || ':type:' || center_event.event_type as event_key,
      center_event.source_finding_id,
      coalesce(center_event.source_document_id, matched.source_document_id) as source_document_id,
      center_event.event_type,
      case
        when center_event.date_from is null then matched.date_from
        when matched.date_from is null then center_event.date_from
        else greatest(center_event.date_from, matched.date_from)
      end as date_from,
      case
        when center_event.date_to is null then matched.date_to
        when matched.date_to is null then center_event.date_to
        else least(center_event.date_to, matched.date_to)
      end as date_to,
      greatest(center_event.updated_at, matched.updated_at) as updated_at,
      shared.source_truncated
    from center_events center_event
    join shared_findings shared
      on shared.source_id = center_event.source_finding_id
    cross join lateral (
      select candidate.*
      from (
        select
          event_row.id,
          event_row.source_document_id,
          event_row.place_id,
          event_row.place_resolution_status,
          event_row.updated_at,
          coalesce(
            security_private.historical_text_date_bound_v1(event_row.date_from, true),
            security_private.historical_text_date_bound_v1(event_row.event_date, true),
            security_private.historical_text_date_bound_v1(event_row.date_text, true),
            security_private.historical_text_date_bound_v1(event_row.date_to, true)
          ) as date_from,
          coalesce(
            security_private.historical_text_date_bound_v1(event_row.date_to, false),
            security_private.historical_text_date_bound_v1(event_row.event_date, false),
            security_private.historical_text_date_bound_v1(event_row.date_text, false),
            security_private.historical_text_date_bound_v1(event_row.date_from, false)
          ) as date_to
        from public.person_timeline_events event_row
        where event_row.project_id = p_project_id
          and event_row.person_id = shared.person_id
          and event_row.source_finding_id = center_event.source_finding_id
          and event_row.event_type = center_event.event_type
      ) candidate
      where (
        center_event.date_from is null or candidate.date_to is null
        or center_event.date_from <= candidate.date_to
      )
        and (
          center_event.date_to is null or candidate.date_from is null
          or center_event.date_to >= candidate.date_from
        )
        and (
          p_year_from is null
          or (
            coalesce(center_event.date_to, center_event.date_from)
              >= make_date(p_year_from, 1, 1)
            and coalesce(candidate.date_to, candidate.date_from)
              >= make_date(p_year_from, 1, 1)
          )
        )
        and (
          p_year_to is null
          or (
            coalesce(center_event.date_from, center_event.date_to)
              <= make_date(p_year_to, 12, 31)
            and coalesce(candidate.date_from, candidate.date_to)
              <= make_date(p_year_to, 12, 31)
          )
        )
        and (
          p_place_id is null
          or (
            (
              (
                center_event.place_id = p_place_id
                and center_event.place_resolution_status = 'confirmed'
              )
              or (
                center_event.place_resolution_status <> 'confirmed'
                and exists (
                  select 1 from public.document_place_links event_place
                  where event_place.project_id = p_project_id
                    and event_place.source_finding_id = center_event.source_finding_id
                    and event_place.place_id = p_place_id
                    and event_place.resolution_status = 'confirmed'
                )
              )
            )
            and (
              (
                candidate.place_id = p_place_id
                and candidate.place_resolution_status = 'confirmed'
              )
              or (
                candidate.place_resolution_status <> 'confirmed'
                and exists (
                  select 1 from public.document_place_links event_place
                  where event_place.project_id = p_project_id
                    and event_place.source_finding_id = center_event.source_finding_id
                    and event_place.place_id = p_place_id
                    and event_place.resolution_status = 'confirmed'
                )
              )
            )
          )
        )
      order by candidate.updated_at desc nulls last, candidate.id
      limit 1
    ) matched
    order by center_event.updated_at desc nulls last, center_event.id,
      shared.person_id
    limit (pair_cap + 1)
  ),
  shared_events as materialized (
    select distinct on (candidate.person_id, candidate.event_key)
      candidate.*
    from shared_event_candidates candidate
    order by candidate.person_id, candidate.event_key,
      candidate.updated_at desc nulls last
    limit pair_cap
  ),

  -- A truly direct same-Document provenance requires the same canonical
  -- citation or fragment on both Person-name rows. A bare Document UUID is an
  -- envelope and is deliberately insufficient for co-occurrence.
  center_direct_name_rows as materialized (
    select
      person_name.id,
      person_name.source_document_id,
      'fragment'::text as provenance_kind,
      person_name.document_fragment_id as provenance_id,
      person_name.updated_at,
      security_private.historical_text_date_bound_v1(person_name.valid_from, true) as date_from,
      security_private.historical_text_date_bound_v1(person_name.valid_to, false) as date_to
    from public.person_names person_name
    where person_name.project_id = p_project_id
      and person_name.person_id = p_person_id
      and person_name.source_document_id is not null
      and person_name.document_fragment_id is not null
      and p_place_id is null
    union all
    select
      person_name.id,
      person_name.source_document_id,
      'citation',
      person_name.citation_id,
      person_name.updated_at,
      security_private.historical_text_date_bound_v1(person_name.valid_from, true),
      security_private.historical_text_date_bound_v1(person_name.valid_to, false)
    from public.person_names person_name
    where person_name.project_id = p_project_id
      and person_name.person_id = p_person_id
      and person_name.source_document_id is not null
      and person_name.citation_id is not null
      and p_place_id is null
  ),
  center_direct_name_candidates as materialized (
    select distinct on (
      center_name.source_document_id, center_name.provenance_kind,
      center_name.provenance_id
    ) center_name.*
    from center_direct_name_rows center_name
    where (
      p_year_from is null
      or coalesce(center_name.date_to, center_name.date_from)
        >= make_date(p_year_from, 1, 1)
    )
      and (
        p_year_to is null
        or coalesce(center_name.date_from, center_name.date_to)
          <= make_date(p_year_to, 12, 31)
      )
    order by center_name.source_document_id, center_name.provenance_kind,
      center_name.provenance_id, center_name.updated_at desc nulls last,
      center_name.id
    limit (source_cap + 1)
  ),
  center_direct_names as materialized (
    select candidate.* from center_direct_name_candidates candidate
    order by candidate.updated_at desc nulls last, candidate.id
    limit source_cap
  ),
  direct_document_candidates as materialized (
    select
      matched.person_id,
      center_name.source_document_id,
      center_name.provenance_kind || ':' || center_name.provenance_id::text
        as provenance_key,
      case
        when center_name.date_from is null then matched.date_from
        when matched.date_from is null then center_name.date_from
        else least(center_name.date_from, matched.date_from)
      end as date_from,
      case
        when center_name.date_to is null then matched.date_to
        when matched.date_to is null then center_name.date_to
        else greatest(center_name.date_to, matched.date_to)
      end as date_to,
      greatest(center_name.updated_at, matched.updated_at) as updated_at,
      matched.source_truncated
    from center_direct_names center_name
    cross join lateral (
      select counted.*,
        counted.member_count > members_per_source_cap as source_truncated
      from (
        select bounded.*,
          count(*) over () as member_count
        from (
          select distinct on (person_name.person_id)
            person_name.person_id,
            person_name.updated_at,
            security_private.historical_text_date_bound_v1(
              person_name.valid_from, true
            ) as date_from,
            security_private.historical_text_date_bound_v1(
              person_name.valid_to, false
            ) as date_to
          from public.person_names person_name
          where person_name.project_id = p_project_id
            and person_name.person_id <> p_person_id
            and person_name.source_document_id = center_name.source_document_id
            and case center_name.provenance_kind
              when 'fragment' then person_name.document_fragment_id = center_name.provenance_id
              else person_name.citation_id = center_name.provenance_id
            end
            and (
              p_year_from is null
              or coalesce(
                security_private.historical_text_date_bound_v1(
                  person_name.valid_to, false
                ),
                security_private.historical_text_date_bound_v1(
                  person_name.valid_from, false
                )
              ) >= make_date(p_year_from, 1, 1)
            )
            and (
              p_year_to is null
              or coalesce(
                security_private.historical_text_date_bound_v1(
                  person_name.valid_from, true
                ),
                security_private.historical_text_date_bound_v1(
                  person_name.valid_to, true
                )
              ) <= make_date(p_year_to, 12, 31)
            )
          order by person_name.person_id,
            person_name.updated_at desc nulls last, person_name.id
          limit (members_per_source_cap + 1)
        ) bounded
      ) counted
      order by counted.updated_at desc nulls last, counted.person_id
      limit members_per_source_cap
    ) matched
    order by center_name.updated_at desc nulls last, center_name.id, matched.person_id
    limit (pair_cap + 1)
  ),
  direct_documents as materialized (
    select distinct on (
      candidate.person_id, candidate.source_document_id, candidate.provenance_key
    ) candidate.*
    from direct_document_candidates candidate
    order by candidate.person_id, candidate.source_document_id,
      candidate.provenance_key, candidate.updated_at desc
    limit pair_cap
  ),

  -- Documents are now attached only after a real shared context exists.
  shared_document_context_candidates as materialized (
    select
      shared.person_id,
      linked_document.document_id,
      'finding'::text as context_kind,
      'finding:' || shared.source_id::text as context_key,
      shared.date_from,
      shared.date_to,
      shared.updated_at
    from shared_findings shared
    cross join lateral (
      select source.document_id
      from (
        select shared.document_id where shared.document_id is not null
        union
        select reference.document_id
        from public.finding_document_references reference
        where reference.project_id = p_project_id
          and reference.finding_id = shared.source_id
      ) source
      order by source.document_id
      limit 100
    ) linked_document
    union all
    select
      shared.person_id,
      shared.source_document_id,
      'event',
      'event:' || shared.event_key,
      shared.date_from,
      shared.date_to,
      shared.updated_at
    from shared_events shared
    where shared.source_document_id is not null
    union all
    select
      shared.person_id,
      shared.source_document_id,
      'direct',
      'direct:' || shared.provenance_key,
      shared.date_from,
      shared.date_to,
      shared.updated_at
    from direct_documents shared
    order by updated_at desc nulls last, person_id, document_id, context_key
    limit (pair_cap + 1)
  ),
  shared_document_contexts as materialized (
    select candidate.*
    from shared_document_context_candidates candidate
    order by candidate.updated_at desc nulls last,
      candidate.person_id, candidate.document_id, candidate.context_key
    limit pair_cap
  ),
  shared_documents as materialized (
    select
      context.person_id,
      context.document_id,
      min(context.date_from) as date_from,
      max(context.date_to) as date_to,
      max(context.updated_at) as updated_at,
      bool_or(context.context_kind = 'finding') as has_finding_context,
      bool_or(context.context_kind = 'event') as has_event_context,
      bool_or(context.context_kind = 'direct') as has_direct_context
    from shared_document_contexts context
    group by context.person_id, context.document_id
  ),
  finding_rollup as materialized (
    select
      shared.person_id,
      count(*)::integer as shared_finding_count,
      min(extract(year from shared.date_from))::integer as first_year,
      max(extract(year from shared.date_to))::integer as last_year
    from shared_findings shared
    group by shared.person_id
  ),
  event_rollup as materialized (
    select
      shared.person_id,
      count(*)::integer as shared_event_count,
      min(extract(year from shared.date_from))::integer as first_year,
      max(extract(year from shared.date_to))::integer as last_year
    from shared_events shared
    group by shared.person_id
  ),
  document_rollup as materialized (
    select
      shared.person_id,
      count(*)::integer as shared_document_count,
      count(*) filter (
        where shared.has_direct_context
          and not shared.has_finding_context
          and not shared.has_event_context
      )::integer as independent_document_count,
      min(extract(year from shared.date_from))::integer as first_year,
      max(extract(year from shared.date_to))::integer as last_year
    from shared_documents shared
    group by shared.person_id
  ),
  candidate_ids as materialized (
    select person_id from finding_rollup
    union select person_id from event_rollup
    union select person_id from document_rollup
  ),
  candidate_counts as materialized (
    select
      candidate.person_id,
      coalesce(finding.shared_finding_count, 0) as shared_finding_count,
      coalesce(document.shared_document_count, 0) as shared_document_count,
      coalesce(event.shared_event_count, 0) as shared_event_count,
      coalesce(finding.shared_finding_count, 0)
        + coalesce(document.independent_document_count, 0) as shared_source_count,
      coalesce(finding.shared_finding_count, 0) * 10
        + coalesce(document.independent_document_count, 0) * 4 as relation_strength,
      least(
        coalesce(finding.first_year, 10000),
        coalesce(event.first_year, 10000),
        coalesce(document.first_year, 10000)
      ) as first_year_value,
      greatest(
        coalesce(finding.last_year, 0),
        coalesce(event.last_year, 0),
        coalesce(document.last_year, 0)
      ) as last_year_value
    from candidate_ids candidate
    left join finding_rollup finding using (person_id)
    left join event_rollup event using (person_id)
    left join document_rollup document using (person_id)
  ),
  visible_candidates as materialized (
    select candidate.*, person.full_name, person.surname,
      person.given_name, person.patronymic
    from candidate_counts candidate
    join public.persons person
      on person.id = candidate.person_id and person.project_id = p_project_id
    where candidate.shared_source_count >= p_min_shared
      and not (
        person.is_living
        and person.privacy_status in ('private', 'confidential')
        and not can_edit
      )
  ),
  ranked_candidates as materialized (
    select candidate.*,
      row_number() over (
        order by candidate.relation_strength desc,
          candidate.shared_source_count desc, candidate.person_id
      ) as candidate_rank
    from visible_candidates candidate
  ),
  selected_candidates as materialized (
    select candidate.* from ranked_candidates candidate
    where candidate.candidate_rank > p_offset
      and candidate.candidate_rank <= p_offset + p_limit
  ),
  representative_sources as materialized (
    select
      source.person_id,
      source.source_kind,
      source.source_id,
      max(source.weight) as weight,
      max(source.source_year) as source_year,
      max(source.updated_at) as updated_at,
      max(source.source_label) as source_label
    from (
      select
        shared.person_id,
        'finding'::text as source_kind,
        shared.source_id,
        10 as weight,
        extract(year from shared.date_from)::integer as source_year,
        shared.updated_at,
        case
          when not can_edit then 'Знахідка'
          else coalesce(nullif(btrim(shared.finding_type), ''), 'Знахідка')
        end as source_label
      from shared_findings shared
      join selected_candidates selected on selected.person_id = shared.person_id
      union all
      select
        shared.person_id,
        'document',
        shared.document_id,
        case
          when shared.has_finding_context then 9
          when shared.has_event_context then 6
          else 4
        end,
        extract(year from shared.date_from)::integer,
        shared.updated_at,
        case
          when not can_edit then 'Документ'
          else coalesce(nullif(btrim(document.title), ''), 'Документ')
        end
      from shared_documents shared
      join selected_candidates selected on selected.person_id = shared.person_id
      join public.documents document
        on document.id = shared.document_id and document.project_id = p_project_id
    ) source
    group by source.person_id, source.source_kind, source.source_id
  ),
  ranked_sources as materialized (
    select source.*,
      row_number() over (
        partition by source.person_id
        order by source.weight desc, source.source_year desc nulls last,
          source.source_kind, source.source_id
      ) as source_rank
    from representative_sources source
  ),
  finding_document_reference_cap_state as (
    select exists (
      select 1
      from shared_findings shared
      cross join lateral (
        select 1
        from (
          select shared.document_id where shared.document_id is not null
          union
          select reference.document_id
          from public.finding_document_references reference
          where reference.project_id = p_project_id
            and reference.finding_id = shared.source_id
        ) source
        order by source.document_id
        offset 100
        limit 1
      ) overflow
    ) as was_truncated
  ),
  cap_state as (
    select
      (select count(*) > source_cap from center_finding_candidates)
      or (select count(*) > source_cap from center_event_candidates)
      or (select count(*) > source_cap from center_direct_name_candidates)
      or (select count(*) > pair_cap from shared_finding_candidates)
      or (select count(*) > pair_cap from shared_event_candidates)
      or (select count(*) > pair_cap from direct_document_candidates)
      or (select count(*) > pair_cap from shared_document_context_candidates)
      or coalesce((select bool_or(source_truncated) from shared_finding_candidates), false)
      or coalesce((select bool_or(source_truncated) from shared_event_candidates), false)
      or coalesce((select bool_or(source_truncated) from direct_document_candidates), false)
      or (select was_truncated from finding_document_reference_cap_state)
        as was_truncated
  )
  select jsonb_build_object(
    'centerPersonId', p_person_id,
    'algorithmVersion', 'cooccurrence_v1',
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'personId', candidate.person_id,
          'displayName', coalesce(
            nullif(btrim(candidate.full_name), ''),
            nullif(btrim(concat_ws(
              ' ', candidate.surname, candidate.given_name, candidate.patronymic
            )), ''),
            'Особа'
          ),
          'masked', false,
          'sharedFindingCount', candidate.shared_finding_count,
          'sharedDocumentCount', candidate.shared_document_count,
          'sharedEventCount', candidate.shared_event_count,
          'sharedSourceCount', candidate.shared_source_count,
          -- Independent evidence contexts are scored once: 10 per Finding and
          -- 4 per direct citation/fragment Document provenance not covered by
          -- that Finding. A real Event is a quality counter anchored by its
          -- Finding and therefore never receives duplicate strength points.
          'relationStrength', candidate.relation_strength,
          'firstYear', case when candidate.first_year_value = 10000
            then null else candidate.first_year_value end,
          'lastYear', case when candidate.last_year_value = 0
            then null else candidate.last_year_value end,
          'topSources', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'kind', source.source_kind,
                'id', source.source_id,
                'label', source.source_label,
                'year', source.source_year
              ) order by source.source_rank
            )
            from ranked_sources source
            where source.person_id = candidate.person_id and source.source_rank <= 5
          ), '[]'::jsonb)
        ) order by candidate.candidate_rank
      ) from selected_candidates candidate
    ), '[]'::jsonb),
    'total', (select count(*) from ranked_candidates),
    'truncated', (
      (select was_truncated from cap_state)
      or (select count(*) > p_offset + p_limit from ranked_candidates)
    )
  ) into result;

  return result;
end;
$function$;

comment on function security_private.list_person_context_cooccurrences_v1(
  uuid, uuid, integer, integer, uuid, integer, integer, integer
) is
  'Bounded privacy-filtered co-occurrence_v1. Score = 10*shared Findings + 4*independent direct Document provenance. Real Events share one source_finding_id and are counted without duplicate score; no Person pair is persisted.';

create or replace function public.list_person_context_cooccurrences_v1(
  p_project_id uuid,
  p_person_id uuid,
  p_year_from integer default null,
  p_year_to integer default null,
  p_place_id uuid default null,
  p_min_shared integer default 1,
  p_limit integer default 20,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select security_private.list_person_context_cooccurrences_v1(
    p_project_id, p_person_id, p_year_from, p_year_to, p_place_id,
    p_min_shared, p_limit, p_offset
  );
$function$;

revoke all on function security_private.list_person_context_cooccurrences_v1(
  uuid, uuid, integer, integer, uuid, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function security_private.list_person_context_cooccurrences_v1(
  uuid, uuid, integer, integer, uuid, integer, integer, integer
) to authenticated, service_role;
revoke all on function public.list_person_context_cooccurrences_v1(
  uuid, uuid, integer, integer, uuid, integer, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.list_person_context_cooccurrences_v1(
  uuid, uuid, integer, integer, uuid, integer, integer, integer
) to authenticated, service_role;

commit;
