create or replace function public.get_dashboard_stats(target_project_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'researches', (select count(*) from public.researches where project_id = target_project_id),
    'documents', (select count(*) from public.documents where project_id = target_project_id),
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
      where project_id = target_project_id and status not in ('закрито', 'перевірено')
    ),
    'completed_tasks', (
      select count(*) from public.tasks
      where project_id = target_project_id and status in ('закрито', 'перевірено')
    ),
    'findings', (select count(*) from public.findings where project_id = target_project_id),
    'archive_requests', (select count(*) from public.archive_requests where project_id = target_project_id),
    'persons', (select count(*) from public.persons where project_id = target_project_id),
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

grant execute on function public.get_dashboard_stats(uuid) to authenticated;

create index if not exists researches_project_updated_idx on public.researches (project_id, updated_at desc);
create index if not exists documents_project_updated_idx on public.documents (project_id, updated_at desc);
create index if not exists documents_project_status_idx on public.documents (project_id, review_status);
create index if not exists documents_project_created_idx on public.documents (project_id, created_at desc);
create index if not exists documents_research_idx on public.documents (research_id);
create index if not exists persons_project_updated_idx on public.persons (project_id, updated_at desc);
create index if not exists persons_project_status_idx on public.persons (project_id, status);
create index if not exists persons_project_created_idx on public.persons (project_id, created_at desc);
create index if not exists tasks_project_updated_idx on public.tasks (project_id, updated_at desc);
create index if not exists tasks_project_status_idx on public.tasks (project_id, status);
create index if not exists tasks_project_created_idx on public.tasks (project_id, created_at desc);
create index if not exists tasks_document_idx on public.tasks (document_id);
create index if not exists findings_project_updated_idx on public.findings (project_id, updated_at desc);
create index if not exists findings_project_created_idx on public.findings (project_id, created_at desc);
create index if not exists findings_document_idx on public.findings (document_id);
create index if not exists hypotheses_project_updated_idx on public.hypotheses (project_id, updated_at desc);
create index if not exists hypotheses_project_status_idx on public.hypotheses (project_id, status);
create index if not exists archive_requests_project_updated_idx on public.archive_requests (project_id, updated_at desc);
create index if not exists archive_requests_project_status_idx on public.archive_requests (project_id, status);
create index if not exists year_matrix_project_year_idx on public.year_matrix (project_id, year_text);
create index if not exists year_matrix_project_status_idx on public.year_matrix (project_id, status);
create index if not exists year_matrix_document_idx on public.year_matrix (document_id);
create index if not exists person_relations_project_person_idx on public.person_relations (project_id, person_id);
create index if not exists person_relations_related_person_idx on public.person_relations (related_person_id);
create index if not exists task_persons_project_person_idx on public.task_persons (project_id, person_id);
create index if not exists task_persons_task_idx on public.task_persons (task_id);
create index if not exists finding_participants_project_person_idx on public.finding_participants (project_id, person_id);
create index if not exists finding_participants_finding_idx on public.finding_participants (finding_id);
create index if not exists hypothesis_links_project_target_idx on public.hypothesis_links (project_id, target_id);
create index if not exists hypothesis_links_hypothesis_idx on public.hypothesis_links (hypothesis_id);
create index if not exists archive_request_persons_project_person_idx on public.archive_request_persons (project_id, person_id);
create index if not exists archive_request_persons_request_idx on public.archive_request_persons (archive_request_id);
create index if not exists project_members_user_idx on public.project_members (user_id);
create index if not exists project_members_project_user_idx on public.project_members (project_id, user_id);
create index if not exists projects_owner_idx on public.projects (owner_id);
create index if not exists project_invitations_project_created_idx on public.project_invitations (project_id, created_at desc);
create index if not exists custom_field_definitions_project_idx on public.custom_field_definitions (project_id);
create index if not exists custom_sections_project_idx on public.custom_sections (project_id);
create index if not exists custom_section_fields_project_section_idx on public.custom_section_fields (project_id, section_id);
create index if not exists activity_log_project_created_idx on public.activity_log (project_id, created_at desc);
create index if not exists activity_log_actor_idx on public.activity_log (actor_id);
