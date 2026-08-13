begin;

-- Keep the canonical asynchronous project-deletion contract in sync with
-- per-user tree preferences. The preferences belong to a project and must be
-- removed before their family tree row.
create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'legacy_person_relation_graph_edges',
    'ai_hypothesis_reviews',
    'family_tree_research_issues',
    'tree_layout_positions',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'person_timeline_events',
    'person_names',
    'association_relationships',
    'parent_child_relationships',
    'parent_sets',
    'partner_relationships',
    'family_group_members',
    'family_groups',
    'family_tree_persons',
    'gedcom_import_batches',
    'family_tree_user_preferences',
    'family_trees',
    'pdf_access_sessions',
    'finding_document_references',
    'finding_participants',
    'task_persons',
    'task_notifications',
    'archive_request_persons',
    'hypothesis_links',
    'record_links',
    'custom_records',
    'custom_section_fields',
    'attachments',
    'activity_log',
    'year_matrix',
    'tasks',
    'findings',
    'hypotheses',
    'archive_requests',
    'person_relations',
    'document_sources',
    'documents',
    'persons',
    'custom_field_definitions',
    'custom_sections',
    'researches',
    'project_invitations'
  ]::text[];
$$;

revoke execute on function private.project_deletion_phase_names()
  from public, anon, authenticated;

do $$
declare
  uncovered_tables text[] := private.project_deletion_uncovered_table_names();
begin
  if coalesce(cardinality(uncovered_tables), 0) > 0 then
    raise exception 'PROJECT_DELETION_PHASES_MISSING_TABLES: %',
      array_to_string(uncovered_tables, ', ');
  end if;
end;
$$;

commit;
