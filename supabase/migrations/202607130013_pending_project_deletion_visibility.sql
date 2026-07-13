begin;

-- Projects remain readable to their members while deletion_pending is true;
-- only writes are blocked by migration 011. Expose the matching durable job
-- through a narrow security-definer RPC so the UI can resume monitoring the
-- existing job without creating another job. Failed jobs may still use the
-- idempotent start RPC to requeue that exact job id.
create or replace function public.list_accessible_project_deletions()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_is_admin boolean;
  result jsonb;
begin
  if actor_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;

  actor_is_admin := public.is_app_admin(actor_id);

  select coalesce(
    jsonb_agg(
      private.project_deletion_job_payload(job.id)
      order by job.created_at desc
    ),
    '[]'::jsonb
  )
  into result
  from private.project_deletion_jobs job
  left join public.projects project on project.id = job.project_id
  where job.status in ('queued', 'running', 'failed')
    and (
      job.requested_by = actor_id
      or project.owner_id = actor_id
      or actor_is_admin
    );

  return result;
end;
$$;

revoke execute on function public.list_accessible_project_deletions()
  from public, anon;
grant execute on function public.list_accessible_project_deletions()
  to authenticated;

comment on function public.list_accessible_project_deletions() is
  'Lists active durable project-deletion jobs visible to the requester, project owner, or app administrator.';

commit;
