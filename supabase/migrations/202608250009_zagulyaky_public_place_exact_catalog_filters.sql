begin;

-- A connection is grouped by canonical `origin_geo`/`found_geo` points.  The
-- human-readable source and found-location texts are intentionally separate
-- historic evidence fields, so they must not be used to re-open a connection
-- in the public catalogue.  Extend the trusted search implementation with two
-- opaque point-key selectors.  The public wrapper and its signature stay
-- unchanged.
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
as $function$
declare
  safe_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
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
  if (p_filters ? 'yearFrom' and coalesce(p_filters->>'yearFrom', '') !~ '^\d{1,4}$')
    or (p_filters ? 'yearTo' and coalesce(p_filters->>'yearTo', '') !~ '^\d{1,4}$') then
    raise exception 'INVALID_YEAR_FILTER' using errcode = '22023';
  end if;
  if (p_filters ? 'originPlaceKey' and lower(coalesce(p_filters->>'originPlaceKey', '')) !~ '^[0-9a-f]{32}$')
    or (p_filters ? 'foundPlaceKey' and lower(coalesce(p_filters->>'foundPlaceKey', '')) !~ '^[0-9a-f]{32}$') then
    raise exception 'INVALID_ZAGULYAKY_PLACE_KEY_FILTER' using errcode = '22023';
  end if;
  if p_filters ? 'eventRole'
    and (
      jsonb_typeof(p_filters -> 'eventRole') not in ('string', 'null')
      or char_length(coalesce(p_filters ->> 'eventRole', '')) > 80
    ) then
    raise exception 'INVALID_ZAGULYAKY_EVENT_ROLE_FILTER' using errcode = '22023';
  end if;

  with matched as (
    select r.*
    from public.zagulyaky_records r
    where r.kind = p_kind
      and r.status = 'published'
      and r.privacy_status = 'cleared'
      and (
        not r.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(r.id)
      )
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or r.search_vector @@ websearch_to_tsquery('simple'::regconfig, p_query)
        or lower(
          coalesce(r.title, '') || ' ' ||
          coalesce(r.summary, '') || ' ' ||
          coalesce(r.original_text, '') || ' ' ||
          coalesce(r.normalized_text, '') || ' ' ||
          coalesce(r.original_language, '') || ' ' ||
          coalesce(r.event_type, '') || ' ' ||
          coalesce(r.event_date_text, '') || ' ' ||
          coalesce(r.event_year_from::text, '') || ' ' ||
          coalesce(r.event_year_to::text, '') || ' ' ||
          coalesce(r.date_precision, '') || ' ' ||
          coalesce(r.source_location_text, '') || ' ' ||
          coalesce(r.source_location_normalized, '') || ' ' ||
          coalesce(r.found_location_text, '') || ' ' ||
          coalesce(r.found_location_normalized, '') || ' ' ||
          coalesce(r.classification_reason, '') || ' ' ||
          coalesce(r.verification_status, '')
        ) like '%' || lower(p_query) || '%'
        or exists (
          select 1
          from public.zagulyaky_participants participant
          where participant.record_id = r.id
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
            ) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
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
            ) like '%' || lower(p_query) || '%'
        )
        or exists (
          select 1
          from public.zagulyaky_document_discoveries discovery
          where discovery.record_id = r.id
            and lower(
              coalesce(discovery.official_location_text, '') || ' ' ||
              coalesce(discovery.discovered_location_text, '') || ' ' ||
              coalesce(array_to_string(discovery.record_types, ' '), '') || ' ' ||
              coalesce(discovery.page_from, '') || ' ' ||
              coalesce(discovery.page_to, '') || ' ' ||
              coalesce(discovery.notes, '')
            ) like '%' || lower(p_query) || '%'
        )
      )
      and (not (p_filters ? 'eventType') or r.event_type = p_filters->>'eventType')
      and (
        not (p_filters ? 'eventRole')
        or exists (
          select 1
          from public.zagulyaky_participants participant
          where participant.record_id = r.id
            and participant.event_role_code = lower(p_filters->>'eventRole')
        )
      )
      and (not (p_filters ? 'verificationStatus') or r.verification_status = p_filters->>'verificationStatus')
      and (not (p_filters ? 'yearFrom') or coalesce(r.event_year_to, r.event_year_from, 2200) >= (p_filters->>'yearFrom')::integer)
      and (not (p_filters ? 'yearTo') or coalesce(r.event_year_from, r.event_year_to, 1) <= (p_filters->>'yearTo')::integer)
      -- The visible labels stay in the catalogue controls after a connection
      -- click, but an opaque map-point key is authoritative.  Source text can
      -- legitimately use a historic spelling which differs from the map label.
      and (
        not (p_filters ? 'sourceLocation')
        or p_filters ? 'originPlaceKey'
        or coalesce(r.source_location_normalized, r.source_location_text, '') ilike '%' || (p_filters->>'sourceLocation') || '%'
      )
      and (
        not (p_filters ? 'foundLocation')
        or p_filters ? 'foundPlaceKey'
        or coalesce(r.found_location_normalized, r.found_location_text, '') ilike '%' || (p_filters->>'foundLocation') || '%'
      )
      and (
        not (p_filters ? 'originPlaceKey')
        or security_private.zagulyaky_public_place_key_v1(r.origin_geo) = lower(p_filters->>'originPlaceKey')
      )
      and (
        not (p_filters ? 'foundPlaceKey')
        or security_private.zagulyaky_public_place_key_v1(r.found_geo) = lower(p_filters->>'foundPlaceKey')
      )
      and (
        not (p_filters ? 'archiveName')
        or exists (
          select 1
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources s on s.id = rs.source_id
          where rs.record_id = r.id
            and coalesce(s.archive_name, '') ilike '%' || (p_filters->>'archiveName') || '%'
        )
      )
      and (
        p_cursor_published_at is null
        or r.published_at < p_cursor_published_at
        or (r.published_at = p_cursor_published_at and r.id < p_cursor_id)
      )
    order by r.published_at desc, r.id desc
    limit safe_limit + 1
  ), page_rows as (
    select * from matched order by published_at desc, id desc limit safe_limit
  ), last_row as (
    select published_at, id from page_rows order by published_at, id limit 1
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
          from public.zagulyaky_record_sources rs
          join public.zagulyaky_sources source on source.id = rs.source_id
          where rs.record_id = r.id
          order by rs.is_primary desc, source.created_at, source.id
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
          select count(*) from public.zagulyaky_confirmations c
          where c.record_id = r.id and c.confirmation_type in ('confirm', 'source_checked')
        )
      ) order by r.published_at desc, r.id desc)
      from page_rows r
    ), '[]'::jsonb),
    'nextCursor', case when (select count(*) from matched) > safe_limit then (
      select jsonb_build_object('publishedAt', published_at, 'id', id) from last_row
    ) else null end
  ) into result;

  return result;
end;
$function$;

comment on function security_private.search_zagulyaky_v1(text, text, jsonb, integer, timestamptz, uuid) is
  'Trusted public Zagulyaky search. originPlaceKey/foundPlaceKey are exact opaque confirmed-geo selectors for settlement connections.';

notify pgrst, 'reload schema';

commit;
