begin;

-- The application loads every per-project table in full on project open and on
-- every realtime refresh, ordered by updated_at (or year_text for the matrix).
-- The composite indexes that backed those reads existed in the earlier
-- "оптимізація запитів" change but were dropped together with it when that work
-- was reverted; 202606130008 only restored a subset. Without them PostgreSQL has
-- to sort the whole table on every load, which on larger projects pushes the
-- request past statement_timeout and PostgREST aborts it with
-- "Warp server error: Thread killed by timeout manager".
create index if not exists researches_project_updated_idx
  on public.researches (project_id, updated_at desc);
create index if not exists persons_project_updated_idx
  on public.persons (project_id, updated_at desc);
create index if not exists documents_project_updated_idx
  on public.documents (project_id, updated_at desc);
create index if not exists tasks_project_updated_idx
  on public.tasks (project_id, updated_at desc);
create index if not exists findings_project_updated_idx
  on public.findings (project_id, updated_at desc);
create index if not exists hypotheses_project_updated_idx
  on public.hypotheses (project_id, updated_at desc);
create index if not exists archive_requests_project_updated_idx
  on public.archive_requests (project_id, updated_at desc);
create index if not exists year_matrix_project_year_idx
  on public.year_matrix (project_id, year_text);

-- Junction tables are filtered by project_id when a project loads, but their
-- primary keys lead with the linked record id, so "where project_id = ?" fell
-- back to a sequential scan over the entire table. Add the missing project_id
-- indexes so these reads keep using an index as the project grows.
create index if not exists task_persons_project_idx
  on public.task_persons (project_id);
create index if not exists hypothesis_links_project_idx
  on public.hypothesis_links (project_id);
create index if not exists archive_request_persons_project_idx
  on public.archive_request_persons (project_id);

commit;
