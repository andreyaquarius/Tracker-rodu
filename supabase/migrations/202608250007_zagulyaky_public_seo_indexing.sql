begin;

-- A build-time renderer needs the complete *public* textual projection for
-- each Zagulyaka card.  Calling the detail endpoint once per card is slow and
-- makes a static publication unnecessarily fragile, so expose one bounded,
-- keyset-paginated public projection instead.
--
-- The cursor deliberately contains only a public slug.  Record UUIDs,
-- timestamps, creator data, source URLs, attachments, payloads, and private
-- notes must never enter the anonymous indexing response.
create index if not exists zagulyaky_records_public_indexing_slug_idx
  on public.zagulyaky_records (kind, lower(public_slug), public_slug)
  where status = 'published'
    and privacy_status = 'cleared'
    and public_slug is not null;

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
  result jsonb;
begin
  if safe_kind not in ('person', 'document') then
    raise exception 'INVALID_ZAGULYAKY_KIND' using errcode = '22023';
  end if;

  if safe_cursor_slug is not null
    and char_length(safe_cursor_slug) not between 3 and 180 then
    raise exception 'INVALID_ZAGULYAKY_INDEXING_CURSOR' using errcode = '22023';
  end if;

  -- Keep every visibility condition inside the bounded CTE.  In particular,
  -- a possible living person without a current clearance must not influence
  -- the page, its count, or the next cursor.
  with matched as materialized (
    select
      record_row.id,
      record_row.public_slug,
      record_row.kind,
      record_row.title,
      record_row.summary,
      record_row.original_text,
      record_row.normalized_text,
      record_row.original_language,
      record_row.event_type,
      record_row.event_date_text,
      record_row.event_year_from,
      record_row.event_year_to,
      record_row.date_precision,
      record_row.source_location_text,
      record_row.source_location_normalized,
      record_row.found_location_text,
      record_row.found_location_normalized
    from public.zagulyaky_records record_row
    where record_row.kind = safe_kind
      and record_row.status = 'published'
      and record_row.privacy_status = 'cleared'
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
      and (
        safe_cursor_slug is null
        or (lower(record_row.public_slug), record_row.public_slug)
          > (lower(safe_cursor_slug), safe_cursor_slug)
      )
    order by lower(record_row.public_slug), record_row.public_slug
    limit safe_limit + 1
  ), page_rows as (
    select *
    from matched
    order by lower(public_slug), public_slug
    limit safe_limit
  ), last_row as (
    select public_slug
    from page_rows
    order by lower(public_slug) desc, public_slug desc
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
      from page_rows record_row
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
      when (select count(*) from matched) > safe_limit
        then (select public_slug from last_row)
      else null
    end
  ) into result;

  return result;
end;
$function$;

comment on function security_private.list_public_zagulyaky_indexing_v1(text, integer, text) is
  'Trusted public-only Zagulyaky SEO indexing projection. Never expose this schema through PostgREST.';

-- The Data API facade stays SECURITY INVOKER.  The trusted implementation is
-- deliberately unreachable as a PostgREST endpoint because security_private
-- is not an exposed schema.
create or replace function public.list_public_zagulyaky_indexing_v1(
  p_kind text,
  p_limit integer default 100,
  p_cursor_slug text default null
)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_public_zagulyaky_indexing_v1($1, $2, $3);
$wrapper$;

comment on function public.list_public_zagulyaky_indexing_v1(text, integer, text) is
  'Anonymous, keyset-paginated public Zagulyaky SEO projection. Returns no IDs, URLs, authors, attachments, payloads, or private notes.';

-- New functions default to PUBLIC EXECUTE.  Preserve the catalogue contract:
-- anonymous visitors can use the facade and its non-exposed implementation,
-- while no broad PUBLIC grant remains.
revoke all on function security_private.list_public_zagulyaky_indexing_v1(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_public_zagulyaky_indexing_v1(text, integer, text)
  to anon, authenticated, service_role;

revoke all on function public.list_public_zagulyaky_indexing_v1(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_public_zagulyaky_indexing_v1(text, integer, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
