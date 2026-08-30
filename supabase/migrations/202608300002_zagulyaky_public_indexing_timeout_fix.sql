begin;

-- The public SEO index is ordered by (kind, lower(public_slug), public_slug),
-- but its partial predicate also requires public_slug IS NOT NULL.  The first
-- version of the RPC relied on the published-record CHECK constraint instead
-- of stating that predicate explicitly, so PostgreSQL could not prove that the
-- partial index was eligible.  On the production catalogue this caused a
-- wider public-feed scan plus a sort before LIMIT and eventually SQLSTATE
-- 57014.  Keep the candidate page narrow and index-ordered, then fetch the
-- large public transcriptions and related projections for at most one page.
create or replace function security_private.list_public_zagulyaky_indexing_v1(
  p_kind text,
  p_limit integer default 100,
  p_cursor_slug text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare
  safe_kind text := lower(btrim(coalesce(p_kind, '')));
  safe_limit integer := least(greatest(coalesce(p_limit, 100), 1), 250);
  safe_cursor_slug text := nullif(btrim(coalesce(p_cursor_slug, '')), '');
  -- Public slugs are constrained to at least three characters, so the empty
  -- value is a safe lower bound for the first page and avoids a nullable OR
  -- that would weaken the parameterized keyset index condition.
  cursor_floor_slug text := coalesce(safe_cursor_slug, '');
  result jsonb;
begin
  if safe_kind not in ('person', 'document') then
    raise exception 'INVALID_ZAGULYAKY_KIND' using errcode = '22023';
  end if;

  if safe_cursor_slug is not null
    and char_length(safe_cursor_slug) not between 3 and 180 then
    raise exception 'INVALID_ZAGULYAKY_INDEXING_CURSOR' using errcode = '22023';
  end if;

  with candidates as materialized (
    select
      record_row.id,
      record_row.public_slug
    from public.zagulyaky_records record_row
    where record_row.kind = safe_kind
      and record_row.status = 'published'
      and record_row.privacy_status = 'cleared'
      -- Required explicitly so the planner can use
      -- zagulyaky_records_public_indexing_slug_idx.
      and record_row.public_slug is not null
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
      and (lower(record_row.public_slug), record_row.public_slug)
        > (lower(cursor_floor_slug), cursor_floor_slug)
    order by lower(record_row.public_slug), record_row.public_slug
    limit safe_limit + 1
  ), page_candidates as materialized (
    select candidate.id, candidate.public_slug
    from candidates candidate
    order by lower(candidate.public_slug), candidate.public_slug
    limit safe_limit
  ), last_row as (
    select candidate.public_slug
    from page_candidates candidate
    order by lower(candidate.public_slug) desc, candidate.public_slug desc
    limit 1
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'slug', record_row.public_slug,
          'kind', record_row.kind,
          'title', record_row.title,
          'summary', record_row.summary,
          'originalText', record_row.original_text,
          'normalizedText', record_row.normalized_text,
          'originalLanguage', record_row.original_language,
          'eventType', record_row.event_type,
          'eventDateText', record_row.event_date_text,
          'eventYearFrom', record_row.event_year_from,
          'eventYearTo', record_row.event_year_to,
          'datePrecision', record_row.date_precision,
          'sourceLocationText', record_row.source_location_text,
          'sourceLocationNormalized', record_row.source_location_normalized,
          'foundLocationText', record_row.found_location_text,
          'foundLocationNormalized', record_row.found_location_normalized,
          'subject', subject.payload,
          'primarySource', primary_source.payload,
          'documentDiscovery', document_discovery.payload
        )
        order by lower(record_row.public_slug), record_row.public_slug
      )
      from page_candidates candidate
      join public.zagulyaky_records record_row on record_row.id = candidate.id
      left join lateral (
        select jsonb_build_object(
          'originalFullName', participant.original_full_name,
          'normalizedUkFullName', participant.normalized_uk_full_name
        ) as payload
        from public.zagulyaky_participants participant
        where participant.record_id = record_row.id
          and participant.role = 'subject'
        order by participant.sort_order, participant.id
        limit 1
      ) subject on true
      left join lateral (
        select jsonb_build_object(
          'sourceType', source.source_type,
          'title', source.title,
          'archiveName', source.archive_name,
          'citation', source.citation,
          'pageFrom', source.page_from,
          'pageTo', source.page_to
        ) as payload
        from public.zagulyaky_record_sources record_source
        join public.zagulyaky_sources source on source.id = record_source.source_id
        where record_source.record_id = record_row.id
        order by record_source.is_primary desc, source.created_at, source.id
        limit 1
      ) primary_source on true
      left join lateral (
        select jsonb_build_object(
          'officialLocationText', discovery.official_location_text,
          'discoveredLocationText', discovery.discovered_location_text,
          'recordTypes', discovery.record_types,
          'factualYearFrom', discovery.factual_year_from,
          'factualYearTo', discovery.factual_year_to,
          'pageFrom', discovery.page_from,
          'pageTo', discovery.page_to
        ) as payload
        from public.zagulyaky_document_discoveries discovery
        where discovery.record_id = record_row.id
        order by discovery.id
        limit 1
      ) document_discovery on true
    ), '[]'::jsonb),
    'nextCursor', case
      when (select count(*) from candidates) > safe_limit
        then (select public_slug from last_row)
      else null
    end
  ) into result;

  return result;
end;
$function$;

comment on function security_private.list_public_zagulyaky_indexing_v1(text, integer, text) is
  'Trusted public-only Zagulyaky SEO indexing projection with an index-ordered narrow candidate page. Never expose this schema through PostgREST.';

-- CREATE OR REPLACE preserves privileges, but reassert the intended boundary
-- explicitly so future edits cannot make the trusted implementation public.
revoke all on function security_private.list_public_zagulyaky_indexing_v1(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_public_zagulyaky_indexing_v1(text, integer, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
