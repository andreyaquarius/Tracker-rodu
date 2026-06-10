alter table public.custom_sections
  add column if not exists parent_key text;

create index if not exists custom_sections_project_parent_idx
  on public.custom_sections (project_id, parent_key, position);
