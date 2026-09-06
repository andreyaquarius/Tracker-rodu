begin;

set local lock_timeout = '5s';

-- Search RPC timeout hotfix. Do not raise the existing 5s query budget.
-- No backfill, changed visibility rules, source-data updates, or public grants
-- on catalogue tables. Existing public SECURITY INVOKER facades stay in place.

-- Optional role/archive filters must be visible to the planner, not invoked
-- through a SECURITY DEFINER helper for every candidate in a large catalogue.
create index if not exists zagulyaky_participants_event_role_record_idx
  on public.zagulyaky_participants (event_role_code, record_id);
create index if not exists zagulyaky_sources_archive_filter_trgm_idx
  on public.zagulyaky_sources using gin ((coalesce(archive_name, '')) extensions.gin_trgm_ops);

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
  search_pattern text;
  event_type_filter text;
  event_role_filter text;
  verification_status_filter text;
  source_location_pattern text;
  found_location_pattern text;
  archive_name_filter text;
  archive_name_pattern text;
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
  if (p_filters ? 'eventType' and (
      jsonb_typeof(p_filters -> 'eventType') not in ('string', 'null')
      or char_length(coalesce(p_filters ->> 'eventType', '')) > 80
    ))
    or (p_filters ? 'sourceLocation' and (
      jsonb_typeof(p_filters -> 'sourceLocation') not in ('string', 'null')
      or char_length(coalesce(p_filters ->> 'sourceLocation', '')) > 500
    ))
    or (p_filters ? 'foundLocation' and (
      jsonb_typeof(p_filters -> 'foundLocation') not in ('string', 'null')
      or char_length(coalesce(p_filters ->> 'foundLocation', '')) > 500
    ))
    or (p_filters ? 'archiveName' and (
      jsonb_typeof(p_filters -> 'archiveName') not in ('string', 'null')
      or char_length(coalesce(p_filters ->> 'archiveName', '')) > 500
    )) then
    raise exception 'INVALID_ZAGULYAKY_TEXT_FILTER' using errcode = '22023';
  end if;
  if p_filters ? 'verificationStatus'
    and (
      jsonb_typeof(p_filters -> 'verificationStatus') not in ('string', 'null')
      or (
        p_filters ->> 'verificationStatus' is not null
        and p_filters ->> 'verificationStatus' not in (
          'unverified', 'plausible', 'corroborated', 'verified', 'disputed'
        )
      )
    ) then
    raise exception 'INVALID_ZAGULYAKY_VERIFICATION_FILTER' using errcode = '22023';
  end if;

  -- A JSON null or blank optional text filter means "not selected".  The web
  -- client normally omits these keys, but treating direct RPC callers the same
  -- avoids an accidental active predicate that can never match.  Wildcards in
  -- user filters are escaped so '%' and '_' remain literal characters.
  event_type_filter := nullif(btrim(p_filters ->> 'eventType'), '');
  event_role_filter := nullif(btrim(p_filters ->> 'eventRole'), '');
  verification_status_filter := nullif(btrim(p_filters ->> 'verificationStatus'), '');

  if nullif(btrim(p_filters ->> 'sourceLocation'), '') is not null then
    source_location_pattern := '%' ||
      replace(
        replace(
          replace(btrim(p_filters ->> 'sourceLocation'), chr(92), chr(92) || chr(92)),
          '%', chr(92) || '%'
        ),
        '_', chr(92) || '_'
      ) || '%';
  end if;

  if nullif(btrim(p_filters ->> 'foundLocation'), '') is not null then
    found_location_pattern := '%' ||
      replace(
        replace(
          replace(btrim(p_filters ->> 'foundLocation'), chr(92), chr(92) || chr(92)),
          '%', chr(92) || '%'
        ),
        '_', chr(92) || '_'
      ) || '%';
  end if;

  if nullif(btrim(p_filters ->> 'archiveName'), '') is not null then
    archive_name_filter := btrim(p_filters ->> 'archiveName');
    archive_name_pattern := '%' || replace(replace(replace(archive_name_filter,
      chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') || '%';
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
        and (event_type_filter is null or r.event_type = event_type_filter)
        and (verification_status_filter is null or r.verification_status = verification_status_filter)
        and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters ->> 'yearFrom')::integer)
        and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters ->> 'yearTo')::integer)
        and (
          source_location_pattern is null
          or p_filters ? 'originPlaceKey'
          or coalesce(r.source_location_normalized, r.source_location_text, '') ilike source_location_pattern escape E'\\'
        )
        and (
          found_location_pattern is null
          or p_filters ? 'foundPlaceKey'
          or coalesce(r.found_location_normalized, r.found_location_text, '') ilike found_location_pattern escape E'\\'
        )
        and (
          not (p_filters ? 'originPlaceKey')
          or (r.origin_geo is not null
            and security_private.zagulyaky_public_place_key_v1(r.origin_geo) = lower(p_filters ->> 'originPlaceKey'))
        )
        and (
          not (p_filters ? 'foundPlaceKey')
          or (r.found_geo is not null
            and security_private.zagulyaky_public_place_key_v1(r.found_geo) = lower(p_filters ->> 'foundPlaceKey'))
        )
        and (
          event_role_filter is null
          or r.id in (
            select participant.record_id
            from public.zagulyaky_participants participant
            where participant.event_role_code = lower(event_role_filter)
          )
        )
        and (
          archive_name_filter is null
          or r.id in (
            select link.record_id
            from public.zagulyaky_sources source
            join public.zagulyaky_record_sources link on link.source_id = source.id
            where coalesce(source.archive_name, '') ilike archive_name_pattern escape E'\\'
          )
        )
        and (
          p_cursor_published_at is null
          or (r.published_at, r.id) < (p_cursor_published_at, p_cursor_id)
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
    -- Treat wildcard characters as user text.  Apart from preventing a single
    -- '%' from matching the whole catalogue, this keeps trigram selectivity
    -- predictable for the bounded explicit-search path.
    search_pattern := '%' ||
      replace(
        replace(
          replace(lower(normalized_query), chr(92), chr(92) || chr(92)),
          '%', chr(92) || '%'
        ),
        '_', chr(92) || '_'
      ) || '%';

    -- This CTE is an inline eligibility predicate, NOT an all-catalogue
    -- temporary table. Each branch must push its indexed search condition down
    -- to the base relation before checking visibility/filters and taking top K.
    -- Explicit columns avoid reading original text/payload; unused columns are
    -- pruned by the planner. Keep each branch's LIMIT AFTER all filters so rare
    -- matches and later cursor pages cannot be silently lost.
    with eligible_rows as not materialized (
      select r.id, r.published_at, r.search_vector, r.title,
        r.source_location_normalized, r.source_location_text,
        r.found_location_normalized, r.found_location_text,
        r.original_language, r.event_type, r.event_date_text,
        r.event_year_from, r.event_year_to, r.date_precision,
        r.classification_reason, r.verification_status
      from public.zagulyaky_records r
      where r.kind = p_kind
        and r.status = 'published'
        and r.privacy_status = 'cleared'
        and (
          not r.possible_living_person
          or security_private.zagulyaky_has_living_person_clearance_v1(r.id)
        )
        and (event_type_filter is null or r.event_type = event_type_filter)
        and (verification_status_filter is null or r.verification_status = verification_status_filter)
        and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters ->> 'yearFrom')::integer)
        and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters ->> 'yearTo')::integer)
        and (
          source_location_pattern is null
          or p_filters ? 'originPlaceKey'
          or coalesce(r.source_location_normalized, r.source_location_text, '') ilike source_location_pattern escape E'\\'
        )
        and (
          found_location_pattern is null
          or p_filters ? 'foundPlaceKey'
          or coalesce(r.found_location_normalized, r.found_location_text, '') ilike found_location_pattern escape E'\\'
        )
        and (
          not (p_filters ? 'originPlaceKey')
          or (r.origin_geo is not null
            and security_private.zagulyaky_public_place_key_v1(r.origin_geo) = lower(p_filters ->> 'originPlaceKey'))
        )
        and (
          not (p_filters ? 'foundPlaceKey')
          or (r.found_geo is not null
            and security_private.zagulyaky_public_place_key_v1(r.found_geo) = lower(p_filters ->> 'foundPlaceKey'))
        )
        and (
          event_role_filter is null
          or r.id in (
            select participant.record_id
            from public.zagulyaky_participants participant
            where participant.event_role_code = lower(event_role_filter)
          )
        )
        and (
          archive_name_filter is null
          or r.id in (
            select link.record_id
            from public.zagulyaky_sources source
            join public.zagulyaky_record_sources link on link.source_id = source.id
            where coalesce(source.archive_name, '') ilike archive_name_pattern escape E'\\'
          )
        )
        and (
          p_cursor_published_at is null
          or (r.published_at, r.id) < (p_cursor_published_at, p_cursor_id)
        )
    ), matching_rows as materialized (
      (
        select r.id, r.published_at
        from eligible_rows r
        where r.search_vector @@ websearch_to_tsquery('simple'::regconfig, normalized_query)
        order by r.published_at desc, r.id desc
        limit safe_limit + 1
      )

      union

      (
        select r.id, r.published_at
        from eligible_rows r
        where lower(r.title) like search_pattern escape E'\\'
        order by r.published_at desc, r.id desc
        limit safe_limit + 1
      )

      union

      (
        select r.id, r.published_at
        from eligible_rows r
        where lower(
          coalesce(r.source_location_normalized, r.source_location_text, '') || ' ' ||
          coalesce(r.found_location_normalized, r.found_location_text, '')
        ) like search_pattern escape E'\\'
        order by r.published_at desc, r.id desc
        limit safe_limit + 1
      )

      union

      (
        select r.id, r.published_at
        from eligible_rows r
        where lower(
          coalesce(r.original_language, '') || ' ' ||
          coalesce(r.event_type, '') || ' ' ||
          coalesce(r.event_date_text, '') || ' ' ||
          coalesce(r.event_year_from::text, '') || ' ' ||
          coalesce(r.event_year_to::text, '') || ' ' ||
          coalesce(r.date_precision, '') || ' ' ||
          coalesce(r.classification_reason, '') || ' ' ||
          coalesce(r.verification_status, '')
        ) like search_pattern escape E'\\'
        order by r.published_at desc, r.id desc
        limit safe_limit + 1
      )

      union

      (
        select distinct eligible.id, eligible.published_at
        from eligible_rows eligible
        join public.zagulyaky_participants participant on participant.record_id = eligible.id
        where lower(
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
        ) like search_pattern escape E'\\'
        order by eligible.published_at desc, eligible.id desc
        limit safe_limit + 1
      )

      union

      (
        select distinct eligible.id, eligible.published_at
        from eligible_rows eligible
        join public.zagulyaky_record_sources link on link.record_id = eligible.id
        join public.zagulyaky_sources source on source.id = link.source_id
        where lower(
          coalesce(source.source_type, '') || ' ' ||
          coalesce(source.title, '') || ' ' ||
          coalesce(source.archive_name, '') || ' ' ||
          coalesce(source.fond, '') || ' ' ||
          coalesce(source.inventory, '') || ' ' ||
          coalesce(source.file_number, '') || ' ' ||
          coalesce(source.page_from, '') || ' ' ||
          coalesce(source.page_to, '') || ' ' ||
          coalesce(source.citation, '')
        ) like search_pattern escape E'\\'
        order by eligible.published_at desc, eligible.id desc
        limit safe_limit + 1
      )

      union

      (
        select distinct eligible.id, eligible.published_at
        from eligible_rows eligible
        join public.zagulyaky_document_discoveries discovery on discovery.record_id = eligible.id
        where security_private.zagulyaky_document_discovery_catalog_text_v1(
          discovery.official_location_text,
          discovery.discovered_location_text,
          discovery.record_types,
          discovery.page_from,
          discovery.page_to,
          discovery.notes
        ) like search_pattern escape E'\\'
        order by eligible.published_at desc, eligible.id desc
        limit safe_limit + 1
      )
    ), candidate_rows as (
      select matched.id, matched.published_at
      from matching_rows matched
      order by matched.published_at desc, matched.id desc
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

-- Without MATERIALIZED PostgreSQL folds the payload expression into both
-- 'items' and 'nextCursor': one request then executes the full search twice.
-- Keep the defence-in-depth living-person guard, using the UUID primary key.
create or replace function security_private.search_zagulyaky_people_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as materialized (
    select security_private.search_zagulyaky_v1('person', $1, $2, $3, $4, $5) as payload
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(coalesce(source.payload -> 'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where not exists (
        select 1
        from public.zagulyaky_records record_row
        where record_row.id = (item.value ->> 'id')::uuid
          and record_row.possible_living_person
          and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
    ), '[]'::jsonb),
    'nextCursor', source.payload -> 'nextCursor'
  )
  from source
$function$;

create or replace function security_private.search_zagulyaky_documents_v1(
  p_query text default null,
  p_filters jsonb default '{}'::jsonb,
  p_limit integer default 20,
  p_cursor_published_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
  with source as materialized (
    select security_private.search_zagulyaky_v1('document', $1, $2, $3, $4, $5) as payload
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(coalesce(source.payload -> 'items', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where not exists (
        select 1
        from public.zagulyaky_records record_row
        where record_row.id = (item.value ->> 'id')::uuid
          and record_row.possible_living_person
          and not security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
    ), '[]'::jsonb),
    'nextCursor', source.payload -> 'nextCursor'
  )
  from source
$function$;

comment on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid) is
  'Public-only indexed Zagulyaky search: inline eligibility, bounded per-branch top K, narrow page enrichment.';

revoke all on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.search_zagulyaky_v1(text,text,jsonb,integer,timestamptz,uuid)
  to service_role;

revoke all on function security_private.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid),
  security_private.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)
  from public, anon, authenticated, service_role;
grant execute on function security_private.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid),
  security_private.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)
  to anon, authenticated, service_role;

-- Refresh estimates after adding filter indexes, including for large imports.
-- ANALYZE samples data for the planner; it does not rewrite source rows.
analyze public.zagulyaky_records;
analyze public.zagulyaky_participants;
analyze public.zagulyaky_sources;
analyze public.zagulyaky_record_sources;
analyze public.zagulyaky_document_discoveries;

notify pgrst, 'reload schema';
commit;
