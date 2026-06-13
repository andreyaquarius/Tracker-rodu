begin;

create index if not exists person_relations_project_updated_idx
  on public.person_relations (project_id, updated_at desc);

create index if not exists finding_participants_project_created_idx
  on public.finding_participants (project_id, created_at);

create index if not exists custom_field_definitions_project_position_idx
  on public.custom_field_definitions (project_id, position);
create index if not exists custom_sections_project_position_idx
  on public.custom_sections (project_id, position);
create index if not exists custom_section_fields_project_position_idx
  on public.custom_section_fields (project_id, position);
create index if not exists custom_records_project_updated_idx
  on public.custom_records (project_id, updated_at desc);
create index if not exists record_links_project_idx
  on public.record_links (project_id);

commit;
