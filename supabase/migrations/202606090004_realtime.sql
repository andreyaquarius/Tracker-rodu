begin;

alter table public.projects replica identity full;
alter table public.researches replica identity full;
alter table public.persons replica identity full;
alter table public.person_relations replica identity full;
alter table public.documents replica identity full;
alter table public.year_matrix replica identity full;
alter table public.tasks replica identity full;
alter table public.task_persons replica identity full;
alter table public.findings replica identity full;
alter table public.finding_participants replica identity full;
alter table public.hypotheses replica identity full;
alter table public.hypothesis_links replica identity full;
alter table public.archive_requests replica identity full;
alter table public.archive_request_persons replica identity full;
alter table public.custom_field_definitions replica identity full;
alter table public.custom_sections replica identity full;
alter table public.custom_section_fields replica identity full;
alter table public.custom_records replica identity full;
alter table public.record_links replica identity full;
alter table public.activity_log replica identity full;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'projects', 'researches', 'persons', 'person_relations', 'documents',
    'year_matrix', 'tasks', 'task_persons', 'findings',
    'finding_participants', 'hypotheses', 'hypothesis_links',
    'archive_requests', 'archive_request_persons',
    'custom_field_definitions', 'custom_sections',
    'custom_section_fields', 'custom_records', 'record_links',
    'activity_log'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        table_name
      );
    end if;
  end loop;
end;
$$;

commit;
