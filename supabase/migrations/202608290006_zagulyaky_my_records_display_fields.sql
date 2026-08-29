begin;

-- Keep the bounded owner feed introduced in 202608270004, but include the
-- four small place labels needed by the private cards.  In particular this
-- lets the client replace legacy import markers with useful human text
-- without fetching the wide payload/original-text columns.
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
        'found_location_text', r.found_location_text,
        'found_location_normalized', r.found_location_normalized,
        'source_location_text', r.source_location_text,
        'source_location_normalized', r.source_location_normalized,
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

  return jsonb_build_object(
    'items', page_items,
    'total', filtered_total,
    'overallTotal', overall_total,
    'statusCounts', status_counts_json,
    'limit', safe_limit,
    'offset', safe_offset
  );
end;
$function$;

comment on function security_private.get_my_zagulyaky_page_v1(text, integer, integer) is
  'Owner-only paged Zagulyaky summaries with safe compact place labels.';

notify pgrst, 'reload schema';

commit;
