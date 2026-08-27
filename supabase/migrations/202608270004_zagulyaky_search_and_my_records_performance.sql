begin;

-- The first Koreni materialisation adds tens of thousands of records to one
-- account.  The old private list materialised every wide record (including
-- original text, payload and the stored search vector) before it counted and
-- paged the result.  These two indexes support the owner feed with and without
-- a workflow-status filter, including the deterministic id tie-breaker.
create index if not exists zagulyaky_records_owner_updated_id_idx
  on public.zagulyaky_records (created_by, updated_at desc, id desc);

create index if not exists zagulyaky_records_owner_status_updated_id_idx
  on public.zagulyaky_records (created_by, status, updated_at desc, id desc);

create or replace function security_private.get_my_zagulyaky_page_v1(
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '5s'
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  current_user_id uuid := auth.uid();
  requested_status text := nullif(btrim(coalesce(p_status, '')), '');
  safe_limit integer := coalesce(p_limit, 50);
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
  page_ids uuid[] := '{}'::uuid[];
  page_items jsonb := '[]'::jsonb;
  filtered_total integer := 0;
  overall_total integer := 0;
  status_counts_json jsonb := '{}'::jsonb;
  result jsonb;
begin
  if current_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if requested_status is not null and requested_status not in (
    'draft', 'pending_review', 'needs_changes', 'published',
    'rejected', 'withdrawn', 'merged', 'archived'
  ) then
    raise exception 'INVALID_ZAGULYAKA_STATUS' using errcode = '22023';
  end if;

  if safe_limit not in (10, 20, 50) then
    raise exception 'INVALID_ZAGULYAKY_PAGE_SIZE' using errcode = '22023';
  end if;

  with status_counts as (
    select r.status, count(*)::integer as record_count
    from public.zagulyaky_records r
    where r.created_by = current_user_id
    group by r.status
  )
  select
    coalesce(sum(counts.record_count)::integer, 0),
    coalesce(jsonb_object_agg(counts.status, counts.record_count), '{}'::jsonb)
  into overall_total, status_counts_json
  from status_counts counts;

  filtered_total := case
    when requested_status is null then overall_total
    else coalesce((status_counts_json ->> requested_status)::integer, 0)
  end;

  if requested_status is null then
    select coalesce(array_agg(page.id order by page.updated_at desc, page.id desc), '{}'::uuid[])
    into page_ids
    from (
      select r.id, r.updated_at
      from public.zagulyaky_records r
      where r.created_by = current_user_id
      order by r.updated_at desc, r.id desc
      limit safe_limit
      offset safe_offset
    ) page;
  else
    select coalesce(array_agg(page.id order by page.updated_at desc, page.id desc), '{}'::uuid[])
    into page_ids
    from (
      select r.id, r.updated_at
      from public.zagulyaky_records r
      where r.created_by = current_user_id
        and r.status = requested_status
      order by r.updated_at desc, r.id desc
      limit safe_limit
      offset safe_offset
    ) page;
  end if;

  select coalesce(jsonb_agg(page.item order by page.updated_at desc, page.id desc), '[]'::jsonb)
  into page_items
  from (
    select
      jsonb_build_object(
        'id', r.id,
        'kind', r.kind,
        'title', r.title,
        'status', r.status,
        'moderation_note', r.moderation_note,
        'created_at', r.created_at,
        'updated_at', r.updated_at,
        'submitted_at', r.submitted_at,
        'public_slug', r.public_slug,
        'lock_version', r.lock_version
      ) as item,
      r.updated_at,
      r.id
    from public.zagulyaky_records r
    where r.id = any(page_ids)
  ) page;

  result := jsonb_build_object(
    'items', page_items,
    'total', filtered_total,
    'overallTotal', overall_total,
    'statusCounts', status_counts_json,
    'limit', safe_limit,
    'offset', safe_offset
  );

  return result;
end;
$function$;

comment on function security_private.get_my_zagulyaky_page_v1(text, integer, integer) is
  'Owner-only paged Zagulyaky summaries. Counts and page scans avoid materialising wide record bodies.';

-- Related filters are deliberately isolated from the no-query feed branch.
-- For the normal unfiltered catalogue this lets PostgreSQL walk the partial
-- public-feed index and stop after 21/51 ids.  The helper is still exact when a
-- caller explicitly selects an event role or an archive.
create or replace function security_private.zagulyaky_matches_catalog_related_filters_v1(
  p_record_id uuid,
  p_filters jsonb
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  select
    (
      not (coalesce(p_filters, '{}'::jsonb) ? 'eventRole')
      or exists (
        select 1
        from public.zagulyaky_participants participant
        where participant.record_id = p_record_id
          and participant.event_role_code = lower(p_filters ->> 'eventRole')
      )
    )
    and (
      not (coalesce(p_filters, '{}'::jsonb) ? 'archiveName')
      or exists (
        select 1
        from public.zagulyaky_record_sources link
        join public.zagulyaky_sources source on source.id = link.source_id
        where link.record_id = p_record_id
          and coalesce(source.archive_name, '') ilike '%' || (p_filters ->> 'archiveName') || '%'
      )
    )
$function$;

comment on function security_private.zagulyaky_matches_catalog_related_filters_v1(uuid, jsonb) is
  'Internal event-role/archive predicate used after the public record visibility boundary.';

revoke all on function security_private.zagulyaky_matches_catalog_related_filters_v1(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function security_private.zagulyaky_matches_catalog_related_filters_v1(uuid, jsonb)
  to service_role;

-- The broad public search covers related public card fields.  Index the two
-- compact related projections that grew beyond the original v1 trigrams.  We
-- intentionally do not add a giant trigram index over record.original_text:
-- the existing stored tsvector remains its scalable full-body index, while
-- substring matching stays on compact indexable card/metadata projections.
create index if not exists zagulyaky_participants_catalog_search_trgm_idx
  on public.zagulyaky_participants using gin ((lower(
    coalesce(original_full_name, '') || ' ' ||
    coalesce(normalized_uk_full_name, '') || ' ' ||
    coalesce(surname, '') || ' ' ||
    coalesce(given_name, '') || ' ' ||
    coalesce(patronymic, '') || ' ' ||
    coalesce(maiden_name, '') || ' ' ||
    coalesce(age_text, '') || ' ' ||
    coalesce(origin_text, '') || ' ' ||
    coalesce(residence_text, '') || ' ' ||
    coalesce(social_estate_text, '') || ' ' ||
    coalesce(occupation_or_rank_text, '') || ' ' ||
    coalesce(marital_status_text, '') || ' ' ||
    coalesce(relation_original, '') || ' ' ||
    coalesce(evidence_excerpt, '') || ' ' ||
    coalesce(notes, '') || ' ' ||
    coalesce(role, '') || ' ' ||
    coalesce(event_role_code, '') || ' ' ||
    coalesce(event_role_custom, '')
  )) extensions.gin_trgm_ops);

create index if not exists zagulyaky_sources_catalog_search_trgm_idx
  on public.zagulyaky_sources using gin ((lower(
    coalesce(source_type, '') || ' ' ||
    coalesce(title, '') || ' ' ||
    coalesce(archive_name, '') || ' ' ||
    coalesce(fond, '') || ' ' ||
    coalesce(inventory, '') || ' ' ||
    coalesce(file_number, '') || ' ' ||
    coalesce(page_from, '') || ' ' ||
    coalesce(page_to, '') || ' ' ||
    coalesce(citation, '')
  )) extensions.gin_trgm_ops);

create index if not exists zagulyaky_records_catalog_metadata_trgm_idx
  on public.zagulyaky_records using gin ((lower(
    coalesce(original_language, '') || ' ' ||
    coalesce(event_type, '') || ' ' ||
    coalesce(event_date_text, '') || ' ' ||
    coalesce(event_year_from::text, '') || ' ' ||
    coalesce(event_year_to::text, '') || ' ' ||
    coalesce(date_precision, '') || ' ' ||
    coalesce(classification_reason, '') || ' ' ||
    coalesce(verification_status, '')
  )) extensions.gin_trgm_ops)
  where status = 'published' and privacy_status = 'cleared';

-- `array_to_string(anyarray, text)` is not declared IMMUTABLE for every
-- possible element type.  This narrow text[] wrapper is immutable and gives
-- the complete public discovery projection one exact indexable expression.
create or replace function security_private.zagulyaky_document_discovery_catalog_text_v1(
  p_official_location_text text,
  p_discovered_location_text text,
  p_record_types text[],
  p_page_from text,
  p_page_to text,
  p_notes text
)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $function$
  select lower(
    coalesce(p_official_location_text, '') || ' ' ||
    coalesce(p_discovered_location_text, '') || ' ' ||
    coalesce(array_to_string(p_record_types, ' '), '') || ' ' ||
    coalesce(p_page_from, '') || ' ' ||
    coalesce(p_page_to, '') || ' ' ||
    coalesce(p_notes, '')
  )
$function$;

revoke all on function security_private.zagulyaky_document_discovery_catalog_text_v1(
  text, text, text[], text, text, text
) from public, anon;
grant execute on function security_private.zagulyaky_document_discovery_catalog_text_v1(
  text, text, text[], text, text, text
) to authenticated, service_role;

create index if not exists zagulyaky_document_discoveries_catalog_search_trgm_idx
  on public.zagulyaky_document_discoveries using gin ((
    security_private.zagulyaky_document_discovery_catalog_text_v1(
      official_location_text,
      discovered_location_text,
      record_types,
      page_from,
      page_to,
      notes
    )
  ) extensions.gin_trgm_ops);

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
set plan_cache_mode = 'force_custom_plan'
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  normalized_query text := nullif(btrim(coalesce(p_query, '')), '');
  candidate_ids uuid[] := '{}'::uuid[];
  page_ids uuid[] := '{}'::uuid[];
  has_more boolean := false;
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
  if (p_filters ? 'yearFrom' and coalesce(p_filters ->> 'yearFrom', '') !~ '^\d{1,4}$')
    or (p_filters ? 'yearTo' and coalesce(p_filters ->> 'yearTo', '') !~ '^\d{1,4}$') then
    raise exception 'INVALID_YEAR_FILTER' using errcode = '22023';
  end if;
  if (p_filters ? 'originPlaceKey' and lower(coalesce(p_filters ->> 'originPlaceKey', '')) !~ '^[0-9a-f]{32}$')
    or (p_filters ? 'foundPlaceKey' and lower(coalesce(p_filters ->> 'foundPlaceKey', '')) !~ '^[0-9a-f]{32}$') then
    raise exception 'INVALID_ZAGULYAKY_PLACE_KEY_FILTER' using errcode = '22023';
  end if;
  if p_filters ? 'eventRole'
    and (
      jsonb_typeof(p_filters -> 'eventRole') not in ('string', 'null')
      or char_length(coalesce(p_filters ->> 'eventRole', '')) > 80
    ) then
    raise exception 'INVALID_ZAGULYAKY_EVENT_ROLE_FILTER' using errcode = '22023';
  end if;

  if normalized_query is null then
    -- This is the hot path on first catalogue load.  Keep it free from search
    -- joins and wide text predicates so the partial feed index can stop as soon
    -- as the bounded id page has been found.
    with candidate_rows as (
      select r.id, r.published_at
      from public.zagulyaky_records r
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and (
          not r.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(r.id)
        )
        and (not (p_filters ? 'eventType') or r.event_type = p_filters ->> 'eventType')
        and (not (p_filters ? 'verificationStatus') or r.verification_status = p_filters ->> 'verificationStatus')
        and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters ->> 'yearFrom')::integer)
        and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters ->> 'yearTo')::integer)
        and (
          not (p_filters ? 'sourceLocation')
          or p_filters ? 'originPlaceKey'
          or coalesce(r.source_location_normalized, r.source_location_text, '') ilike '%' || (p_filters ->> 'sourceLocation') || '%'
        )
        and (
          not (p_filters ? 'foundLocation')
          or p_filters ? 'foundPlaceKey'
          or coalesce(r.found_location_normalized, r.found_location_text, '') ilike '%' || (p_filters ->> 'foundLocation') || '%'
        )
        and (
          not (p_filters ? 'originPlaceKey')
          or security_private.zagulyaky_public_place_key_v1(r.origin_geo) = lower(p_filters ->> 'originPlaceKey')
        )
        and (
          not (p_filters ? 'foundPlaceKey')
          or security_private.zagulyaky_public_place_key_v1(r.found_geo) = lower(p_filters ->> 'foundPlaceKey')
        )
        and security_private.zagulyaky_matches_catalog_related_filters_v1(r.id, p_filters)
        and (
          p_cursor_published_at is null
          or r.published_at < p_cursor_published_at
          or (r.published_at = p_cursor_published_at and r.id < p_cursor_id)
        )
      order by r.published_at desc, r.id desc
      limit safe_limit + 1
    )
    select coalesce(
      array_agg(candidate.id order by candidate.published_at desc, candidate.id desc),
      '{}'::uuid[]
    )
    into candidate_ids
    from candidate_rows candidate;
  else
    -- Search each public relation once and union only record ids.  This avoids
    -- the old correlated EXISTS work for every record and lets the stored FTS
    -- and compact trigram indexes participate independently.
    with matching_ids as materialized (
      select r.id
      from public.zagulyaky_records r
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and r.search_vector @@ websearch_to_tsquery('simple'::regconfig, normalized_query)

      union

      select r.id
      from public.zagulyaky_records r
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and lower(r.title) like '%' || lower(normalized_query) || '%'

      union

      select r.id
      from public.zagulyaky_records r
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and lower(
          coalesce(r.source_location_normalized, r.source_location_text, '') || ' ' ||
          coalesce(r.found_location_normalized, r.found_location_text, '')
        ) like '%' || lower(normalized_query) || '%'

      union

      select r.id
      from public.zagulyaky_records r
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and lower(
          coalesce(r.original_language, '') || ' ' ||
          coalesce(r.event_type, '') || ' ' ||
          coalesce(r.event_date_text, '') || ' ' ||
          coalesce(r.event_year_from::text, '') || ' ' ||
          coalesce(r.event_year_to::text, '') || ' ' ||
          coalesce(r.date_precision, '') || ' ' ||
          coalesce(r.classification_reason, '') || ' ' ||
          coalesce(r.verification_status, '')
        ) like '%' || lower(normalized_query) || '%'

      union

      select participant.record_id
      from public.zagulyaky_participants participant
      join public.zagulyaky_records r on r.id = participant.record_id
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
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
        ) like '%' || lower(normalized_query) || '%'

      union

      select link.record_id
      from public.zagulyaky_record_sources link
      join public.zagulyaky_sources source on source.id = link.source_id
      join public.zagulyaky_records r on r.id = link.record_id
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
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
        ) like '%' || lower(normalized_query) || '%'

      union

      select discovery.record_id
      from public.zagulyaky_document_discoveries discovery
      join public.zagulyaky_records r on r.id = discovery.record_id
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and security_private.zagulyaky_document_discovery_catalog_text_v1(
          discovery.official_location_text,
          discovery.discovered_location_text,
          discovery.record_types,
          discovery.page_from,
          discovery.page_to,
          discovery.notes
        ) like '%' || lower(normalized_query) || '%'
    ), candidate_rows as (
      select r.id, r.published_at
      from matching_ids matched
      join public.zagulyaky_records r on r.id = matched.id
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and (
          not r.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(r.id)
        )
        and (not (p_filters ? 'eventType') or r.event_type = p_filters ->> 'eventType')
        and (not (p_filters ? 'verificationStatus') or r.verification_status = p_filters ->> 'verificationStatus')
        and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters ->> 'yearFrom')::integer)
        and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters ->> 'yearTo')::integer)
        and (
          not (p_filters ? 'sourceLocation')
          or p_filters ? 'originPlaceKey'
          or coalesce(r.source_location_normalized, r.source_location_text, '') ilike '%' || (p_filters ->> 'sourceLocation') || '%'
        )
        and (
          not (p_filters ? 'foundLocation')
          or p_filters ? 'foundPlaceKey'
          or coalesce(r.found_location_normalized, r.found_location_text, '') ilike '%' || (p_filters ->> 'foundLocation') || '%'
        )
        and (
          not (p_filters ? 'originPlaceKey')
          or security_private.zagulyaky_public_place_key_v1(r.origin_geo) = lower(p_filters ->> 'originPlaceKey')
        )
        and (
          not (p_filters ? 'foundPlaceKey')
          or security_private.zagulyaky_public_place_key_v1(r.found_geo) = lower(p_filters ->> 'foundPlaceKey')
        )
        and security_private.zagulyaky_matches_catalog_related_filters_v1(r.id, p_filters)
        and (
          p_cursor_published_at is null
          or r.published_at < p_cursor_published_at
          or (r.published_at = p_cursor_published_at and r.id < p_cursor_id)
        )
      order by r.published_at desc, r.id desc
      limit safe_limit + 1
    )
    select coalesce(
      array_agg(candidate.id order by candidate.published_at desc, candidate.id desc),
      '{}'::uuid[]
    )
    into candidate_ids
    from candidate_rows candidate;
  end if;

  has_more := cardinality(candidate_ids) > safe_limit;
  page_ids := coalesce(candidate_ids[1:safe_limit], '{}'::uuid[]);

  -- Only the bounded page is joined to card details.  Large source text and
  -- payload columns never enter the candidate materialisation.
  with page_rows as (
    select
      r.id,
      r.public_slug,
      r.kind,
      r.title,
      r.summary,
      r.event_type,
      r.event_date_text,
      r.event_year_from,
      r.event_year_to,
      r.date_precision,
      r.source_location_normalized,
      r.source_location_text,
      r.found_location_normalized,
      r.found_location_text,
      r.verification_status,
      r.published_at
    from public.zagulyaky_records r
    where r.id = any(page_ids)
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
          from public.zagulyaky_record_sources link
          join public.zagulyaky_sources source on source.id = link.source_id
          where link.record_id = r.id
          order by link.is_primary desc, source.created_at, source.id
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
          select count(*)
          from public.zagulyaky_confirmations confirmation
          where confirmation.record_id = r.id
            and confirmation.confirmation_type in ('confirm', 'source_checked')
        )
      ) order by r.published_at desc, r.id desc)
      from page_rows r
    ), '[]'::jsonb),
    'nextCursor', (
      select jsonb_build_object('publishedAt', cursor_row.published_at, 'id', cursor_row.id)
      from page_rows cursor_row
      where has_more
      order by cursor_row.published_at, cursor_row.id
      limit 1
    )
  ) into result;

  return result;
end;
$function$;

comment on function security_private.search_zagulyaky_v1(text, text, jsonb, integer, timestamptz, uuid) is
  'Trusted public Zagulyaky search with a feed-index blank-query path and id-only bounded candidate materialisation.';

-- CREATE OR REPLACE normally retains ACLs.  Reassert them explicitly so a
-- repaired or partially restored project cannot acquire PostgreSQL's default
-- PUBLIC EXECUTE on either SECURITY DEFINER entry point.
revoke all on function security_private.get_my_zagulyaky_page_v1(text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_my_zagulyaky_page_v1(text, integer, integer)
  to authenticated, service_role;

revoke all on function security_private.search_zagulyaky_v1(
  text, text, jsonb, integer, timestamptz, uuid
) from public, anon, authenticated, service_role;
grant execute on function security_private.search_zagulyaky_v1(
  text, text, jsonb, integer, timestamptz, uuid
) to service_role;

notify pgrst, 'reload schema';

commit;
