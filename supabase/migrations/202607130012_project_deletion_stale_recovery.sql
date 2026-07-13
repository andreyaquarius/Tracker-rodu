begin;

-- Queue workers are a recovery mechanism, not a second live worker for every
-- active deletion. New jobs can be claimed immediately. A running/failed job
-- is reclaimed only after it has stopped updating for two minutes, which is
-- comfortably longer than the 85-second targeted Edge worker budget.
create or replace function public.process_next_project_deletion(
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  next_job_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;

  select job.id
  into next_job_id
  from private.project_deletion_jobs job
  where job.status = 'queued'
     or (
       job.status in ('running', 'failed')
       and job.updated_at <= pg_catalog.clock_timestamp() - interval '2 minutes'
     )
  order by
    case when job.status = 'queued' then 0 else 1 end,
    job.updated_at,
    job.created_at
  for update skip locked
  limit 1;

  if next_job_id is null then
    return null;
  end if;

  return public.process_project_deletion(next_job_id, batch_size);
end;
$$;

revoke execute on function public.process_next_project_deletion(integer)
  from public, anon, authenticated;
grant execute on function public.process_next_project_deletion(integer)
  to service_role;

comment on function public.process_next_project_deletion(integer) is
  'Claims queued deletions immediately and safely recovers running/failed jobs only after two minutes without progress.';

commit;
