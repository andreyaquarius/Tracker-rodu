-- Add leftmost covering indexes for foreign keys reported by Supabase Performance Advisor.
-- Do not remove "unused" indexes here: on a young project they may simply have no planner usage yet.

create index if not exists ai_hypothesis_reviews_hypothesis_id_idx
  on public.ai_hypothesis_reviews (hypothesis_id);

create index if not exists ai_hypothesis_reviews_workspace_id_idx
  on public.ai_hypothesis_reviews (workspace_id);

create index if not exists app_admins_granted_by_idx
  on public.app_admins (granted_by);

create index if not exists archive_request_persons_person_id_idx
  on public.archive_request_persons (person_id);

create index if not exists archive_requests_created_by_idx
  on public.archive_requests (created_by);

create index if not exists archive_requests_research_id_idx
  on public.archive_requests (research_id);

create index if not exists attachments_uploaded_by_idx
  on public.attachments (uploaded_by);

create index if not exists custom_field_definitions_created_by_idx
  on public.custom_field_definitions (created_by);

create index if not exists custom_records_created_by_idx
  on public.custom_records (created_by);

create index if not exists custom_records_section_id_idx
  on public.custom_records (section_id);

create index if not exists custom_section_fields_section_id_idx
  on public.custom_section_fields (section_id);

create index if not exists custom_sections_created_by_idx
  on public.custom_sections (created_by);

create index if not exists documents_created_by_idx
  on public.documents (created_by);

create index if not exists finding_participants_person_id_idx
  on public.finding_participants (person_id);

create index if not exists findings_created_by_idx
  on public.findings (created_by);

create index if not exists findings_research_id_idx
  on public.findings (research_id);

create index if not exists hypotheses_created_by_idx
  on public.hypotheses (created_by);

create index if not exists hypotheses_research_id_idx
  on public.hypotheses (research_id);

create index if not exists person_relations_created_by_idx
  on public.person_relations (created_by);

create index if not exists person_relations_person_id_idx
  on public.person_relations (person_id);

create index if not exists persons_created_by_idx
  on public.persons (created_by);

create index if not exists project_invitations_accepted_by_idx
  on public.project_invitations (accepted_by);

create index if not exists project_invitations_invited_by_idx
  on public.project_invitations (invited_by);

create index if not exists project_members_invited_by_idx
  on public.project_members (invited_by);

create index if not exists record_links_created_by_idx
  on public.record_links (created_by);

create index if not exists researches_created_by_idx
  on public.researches (created_by);

create index if not exists subscription_events_new_plan_id_idx
  on public.subscription_events (new_plan_id);

create index if not exists subscription_events_performed_by_idx
  on public.subscription_events (performed_by);

create index if not exists subscription_events_previous_plan_id_idx
  on public.subscription_events (previous_plan_id);

create index if not exists subscription_events_subscription_id_idx
  on public.subscription_events (subscription_id);

create index if not exists subscription_events_user_id_idx
  on public.subscription_events (user_id);

create index if not exists task_persons_person_id_idx
  on public.task_persons (person_id);

create index if not exists tasks_created_by_idx
  on public.tasks (created_by);

create index if not exists tasks_research_id_idx
  on public.tasks (research_id);

create index if not exists user_subscriptions_plan_id_idx
  on public.user_subscriptions (plan_id);

create index if not exists year_matrix_created_by_idx
  on public.year_matrix (created_by);

create index if not exists year_matrix_research_id_idx
  on public.year_matrix (research_id);
