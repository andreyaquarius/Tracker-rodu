-- Exact, owner-scoped pagination for the private "My Zagulyaky" list.
--
-- Keep the original get_my_zagulyaky_v1 contract in place for already loaded
-- clients.  This paged contract supplies exact totals and status counters so
-- the client never has to infer them from an incomplete page.

begin;

create or replace function public.get_my_zagulyaky_page_v1(
  p_status text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
declare
  current_user_id uuid := auth.uid();
  requested_status text := nullif(btrim(coalesce(p_status, '')), '');
  safe_limit integer := coalesce(p_limit, 50);
  safe_offset integer := greatest(coalesce(p_offset, 0), 0);
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

  -- The UI deliberately offers only these sizes.  Rejecting any other value
  -- makes the server-side contract explicit and prevents an unbounded query.
  if safe_limit not in (10, 20, 50) then
    raise exception 'INVALID_ZAGULYAKY_PAGE_SIZE' using errcode = '22023';
  end if;

  with owner_records as materialized (
    select r.*
    from public.zagulyaky_records r
    where r.created_by = current_user_id
  ),
  filtered_records as materialized (
    select r.*
    from owner_records r
    where requested_status is null or r.status = requested_status
  ),
  status_counts as (
    select r.status, count(*)::integer as record_count
    from owner_records r
    group by r.status
  ),
  paged as (
    select
      (to_jsonb(r) - 'search_vector' - 'created_by' - 'moderated_by') as item,
      r.updated_at,
      r.id
    from filtered_records r
    order by r.updated_at desc, r.id desc
    limit safe_limit
    offset safe_offset
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(page.item order by page.updated_at desc, page.id desc)
      from paged page
    ), '[]'::jsonb),
    -- "total" changes with the selected status.  "overallTotal" does not.
    'total', (select count(*) from filtered_records),
    'overallTotal', (select count(*) from owner_records),
    'statusCounts', coalesce((
      select jsonb_object_agg(counts.status, counts.record_count)
      from status_counts counts
    ), '{}'::jsonb),
    'limit', safe_limit,
    'offset', safe_offset
  ) into result;

  return result;
end;
$function$;

-- New PostgreSQL functions receive PUBLIC EXECUTE by default.  This endpoint
-- contains private author data, so it must never be exposed to anonymous API
-- roles; the function itself additionally scopes every read to auth.uid().
revoke all on function public.get_my_zagulyaky_page_v1(text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.get_my_zagulyaky_page_v1(text,integer,integer)
  to authenticated, service_role;

notify pgrst, 'reload schema';
commit;
