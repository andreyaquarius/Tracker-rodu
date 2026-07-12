begin;

-- Deep OFFSET pages over a large GEDCOM import reached statement_timeout.
-- Keep the legacy updated-at order index for older clients and add stable ID
-- cursors used by the optimized client.
create index if not exists findings_project_updated_id_idx
  on public.findings (project_id, updated_at desc, id asc);
create index if not exists findings_project_id_cursor_idx
  on public.findings (project_id, id asc);
create index if not exists finding_participants_project_id_cursor_idx
  on public.finding_participants (project_id, id asc);

-- The application has one Realtime subscription and it listens only to the
-- compact activity_log stream. Publishing every imported person/finding caused
-- the Realtime decoder to inspect tens of thousands of irrelevant WAL changes.
-- Keep activity_log published and stop decoding the large source tables.
do $$
declare
  table_name text;
  realtime_tables text[] := array[
    'projects', 'researches', 'persons', 'person_relations', 'documents',
    'year_matrix', 'tasks', 'task_persons', 'findings',
    'finding_participants', 'hypotheses', 'hypothesis_links',
    'archive_requests', 'archive_request_persons',
    'custom_field_definitions', 'custom_sections',
    'custom_section_fields', 'custom_records', 'record_links'
  ];
begin
  foreach table_name in array realtime_tables loop
    if exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format(
        'alter publication supabase_realtime drop table public.%I',
        table_name
      );
    end if;

    -- FULL was needed only while these tables were sent through Realtime.
    execute format('alter table public.%I replica identity default', table_name);
  end loop;
end;
$$;

commit;
