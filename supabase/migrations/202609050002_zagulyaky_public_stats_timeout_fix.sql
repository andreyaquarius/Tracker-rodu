begin;

-- The previous implementation materialized SELECT * from zagulyaky_records and
-- reused that wide CTE for record counts, four location branches and archive
-- joins. Records may contain large transcriptions/payloads, so a statistics
-- request read and retained much more data than the response needs. Keep one
-- narrow, privacy-filtered projection and deduplicate only the final location
-- values. This preserves the exact public visibility and counting semantics.
create or replace function security_private.get_zagulyaky_public_stats_v1()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
  with visible as materialized (
    select
      record_row.id,
      record_row.kind,
      record_row.verification_status,
      record_row.created_by,
      record_row.published_at,
      record_row.event_year_from,
      record_row.event_year_to,
      nullif(btrim(coalesce(
        record_row.source_location_normalized,
        record_row.source_location_text
      )), '') as source_location,
      nullif(btrim(coalesce(
        record_row.found_location_normalized,
        record_row.found_location_text
      )), '') as found_location
    from public.zagulyaky_records record_row
    where record_row.status = 'published'
      and record_row.privacy_status = 'cleared'
      and (
        not record_row.possible_living_person
        or security_private.zagulyaky_has_living_person_clearance_v1(record_row.id)
      )
  ), locations as (
    select location_value.location
    from visible
    cross join lateral (values
      (visible.source_location),
      (visible.found_location)
    ) as location_value(location)
    where location_value.location is not null
    union all
    select location_value.location
    from public.zagulyaky_document_discoveries discovery
    join visible on visible.id = discovery.record_id
    cross join lateral (values
      (nullif(btrim(discovery.official_location_text), '')),
      (nullif(btrim(discovery.discovered_location_text), ''))
    ) as location_value(location)
    where location_value.location is not null
  ), record_totals as (
    select
      count(*) filter (where visible.kind = 'person') as people,
      count(*) filter (where visible.kind = 'document') as documents,
      count(*) filter (where visible.verification_status = 'verified') as verified,
      count(*) filter (
        where visible.verification_status in ('corroborated', 'verified')
      ) as corroborated_or_verified,
      count(distinct visible.created_by) filter (
        where visible.created_by is not null
      ) as contributors,
      count(*) filter (
        where visible.published_at >= now() - interval '30 days'
      ) as added_last_30_days,
      min(visible.event_year_from) as year_from,
      max(coalesce(visible.event_year_to, visible.event_year_from)) as year_to
    from visible
  ), location_totals as (
    select count(distinct locations.location) as places
    from locations
  ), archive_totals as (
    select count(distinct nullif(btrim(source.archive_name), '')) as archives
    from visible
    join public.zagulyaky_record_sources link on link.record_id = visible.id
    join public.zagulyaky_sources source on source.id = link.source_id
  )
  select jsonb_build_object(
    'people', record_totals.people,
    'documents', record_totals.documents,
    'verified', record_totals.verified,
    'corroboratedOrVerified', record_totals.corroborated_or_verified,
    'places', location_totals.places,
    'archives', archive_totals.archives,
    'contributors', record_totals.contributors,
    'addedLast30Days', record_totals.added_last_30_days,
    'yearFrom', record_totals.year_from,
    'yearTo', record_totals.year_to
  )
  from record_totals
  cross join location_totals
  cross join archive_totals
$function$;

comment on function security_private.get_zagulyaky_public_stats_v1() is
  'Exact public Zagulyaky catalogue totals using a narrow privacy-filtered projection.';

-- CREATE OR REPLACE preserves ACLs. Reassert the intended facade contract so
-- the private schema implementation cannot become callable accidentally.
revoke all on function security_private.get_zagulyaky_public_stats_v1()
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_zagulyaky_public_stats_v1()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
