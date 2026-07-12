-- Keep person cards independent from the full project work/analysis collections.
-- The JSONB GIN index supports the containment query for imported finding links:
-- custom_fields @> '{"__trackerRoduFindingMeta":{"personIds":["..."]}}'.
begin;

create index if not exists findings_custom_fields_path_gin_idx
  on public.findings using gin (custom_fields jsonb_path_ops);

create index if not exists task_persons_project_person_task_idx
  on public.task_persons (project_id, person_id, task_id);

create index if not exists hypothesis_links_project_person_target_idx
  on public.hypothesis_links (project_id, target_id, hypothesis_id)
  where target_type = 'person';

create index if not exists archive_request_persons_project_person_request_idx
  on public.archive_request_persons (project_id, person_id, archive_request_id);

create index if not exists finding_participants_project_finding_idx
  on public.finding_participants (project_id, finding_id, id);

commit;
