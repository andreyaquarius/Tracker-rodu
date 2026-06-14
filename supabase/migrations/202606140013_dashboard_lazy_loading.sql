begin;

create or replace function public.get_dashboard_stats(target_project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
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
  );
$$;

revoke all on function public.get_dashboard_stats(uuid) from public, anon;
grant execute on function public.get_dashboard_stats(uuid) to authenticated;

commit;
