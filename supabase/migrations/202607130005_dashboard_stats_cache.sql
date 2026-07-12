begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.project_dashboard_stats_cache (
  project_id uuid primary key references public.projects(id) on delete cascade,
  stats jsonb not null,
  refreshed_at timestamptz not null default clock_timestamp()
);

revoke all on table private.project_dashboard_stats_cache
  from public, anon, authenticated;

-- The cache has a short lifetime so collaborative changes remain fresh. An
-- advisory lock prevents a burst of project opens from running the same set of
-- counts hundreds of times at once.
create or replace function public.get_dashboard_stats(target_project_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
set statement_timeout = '5s'
as $$
declare
  cached_stats jsonb;
  computed_stats jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  if target_project_id is null
     or not public.is_project_member(target_project_id) then
    raise exception 'PROJECT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  select cache.stats
  into cached_stats
  from private.project_dashboard_stats_cache cache
  where cache.project_id = target_project_id
    and cache.refreshed_at >= clock_timestamp() - interval '20 seconds';

  if cached_stats is not null then
    return cached_stats;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_project_id::text, 0)
  );

  -- Another request may have filled the cache while this transaction waited.
  select cache.stats
  into cached_stats
  from private.project_dashboard_stats_cache cache
  where cache.project_id = target_project_id
    and cache.refreshed_at >= clock_timestamp() - interval '20 seconds';

  if cached_stats is not null then
    return cached_stats;
  end if;

  select jsonb_build_object(
    'researches', (
      select count(*) from public.researches where project_id = target_project_id
    ),
    'documents', (
      select count(*) from public.documents where project_id = target_project_id
    ),
    'documents_in_progress', (
      select count(*) from public.documents
      where project_id = target_project_id and review_status = 'в роботі'
    ),
    'documents_reviewed', (
      select count(*) from public.documents
      where project_id = target_project_id and review_status = 'переглянуто'
    ),
    'open_tasks', (
      select count(*) from public.tasks
      where project_id = target_project_id
        and status not in ('закрито', 'перевірено')
    ),
    'completed_tasks', (
      select count(*) from public.tasks
      where project_id = target_project_id
        and status in ('закрито', 'перевірено')
    ),
    'findings', (
      select count(*) from public.findings where project_id = target_project_id
    ),
    'archive_requests', (
      select count(*) from public.archive_requests where project_id = target_project_id
    ),
    'persons', (
      select count(*) from public.persons where project_id = target_project_id
    ),
    'active_hypotheses', (
      select count(*) from public.hypotheses
      where project_id = target_project_id and status = 'активна'
    ),
    'year_gaps', (
      select count(*) from public.year_matrix
      where project_id = target_project_id and status = 'прогалина'
    ),
    'unchecked_years', (
      select count(*) from public.year_matrix
      where project_id = target_project_id and status = 'не перевірено'
    )
  ) into computed_stats;

  insert into private.project_dashboard_stats_cache (
    project_id,
    stats,
    refreshed_at
  ) values (
    target_project_id,
    computed_stats,
    clock_timestamp()
  )
  on conflict (project_id) do update
  set stats = excluded.stats,
      refreshed_at = excluded.refreshed_at;

  return computed_stats;
end;
$$;

revoke execute on function public.get_dashboard_stats(uuid)
  from public, anon;
grant execute on function public.get_dashboard_stats(uuid)
  to authenticated;

comment on function public.get_dashboard_stats(uuid) is
  'Returns membership-scoped dashboard counters with a 20-second anti-stampede cache.';

commit;
