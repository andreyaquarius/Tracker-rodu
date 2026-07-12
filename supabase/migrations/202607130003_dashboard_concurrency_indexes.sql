begin;

-- Dashboard counters and the recent-task preview are read on every project
-- entry.  Keep their filters index-only on large projects and during bursts
-- of concurrent logins.
create index if not exists documents_project_review_status_idx
  on public.documents (project_id, review_status);

create index if not exists tasks_project_status_updated_idx
  on public.tasks (project_id, status, updated_at desc);

create index if not exists hypotheses_project_status_idx
  on public.hypotheses (project_id, status);

create index if not exists year_matrix_project_status_idx
  on public.year_matrix (project_id, status);

commit;
