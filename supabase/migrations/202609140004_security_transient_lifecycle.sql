begin;
set local lock_timeout = '5s';
-- Append rather than reorder phases: preserve resumable deletion cursors.
create or replace function private.project_deletion_phase_names()
returns text[]
language sql
immutable
set search_path = ''
as $function$
  select array[
    'photo_person_tags',
    'context_relation_evidence_links',
    'context_relations',
    'context_relation_evidence',
    'person_context_relations',
    'context_relation_types',
    'context_graph_revisions',
    'legacy_person_relation_graph_edges',
    'ai_hypothesis_reviews',
    'family_tree_research_issues',
    'tree_layout_positions',
    'gedcom_xref_maps',
    'family_tree_merge_history',
    'person_timeline_events',
    'place_merge_preserved_rows',
    'place_merge_operations',
    'document_place_links',
    'place_archive_relations',
    'place_parish_relations',
    'place_relations',
    'place_boundaries',
    'archive_resources',
    'place_change_requests',
    'place_external_identifiers',
    'place_hierarchy_relations',
    'place_names',
    'place_type_assignments',
    'places',
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
    'project_invitations',
    'project_change_events'
  ]::text[];
$function$;
revoke execute on function private.project_deletion_phase_names() from public, anon, authenticated;

create index project_change_events_retention_idx on public.project_change_events(created_at);
create index invitation_email_retention_idx on security_private.invitation_email_deliveries(created_at);
create function security_private.prune_security_transients_v1() returns void
language plpgsql security definer set search_path = '' as $$
begin
  -- Bounded maintenance of transient signals/delivery receipts, NOT history.
  delete from public.project_change_events where id in
    (select id from public.project_change_events where created_at < now()-interval '2 days' order by created_at limit 10000);
  delete from security_private.invitation_email_deliveries where id in
    (select id from security_private.invitation_email_deliveries where created_at < now()-interval '30 days' order by created_at limit 10000);
end $$;
revoke all on function security_private.prune_security_transients_v1() from public, anon, authenticated, service_role;
do $$ begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    perform cron.schedule('security-transient-retention', '17 * * * *', 'select security_private.prune_security_transients_v1()');
  end if;
end $$;
commit;

