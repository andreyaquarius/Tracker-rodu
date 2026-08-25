begin;

select plan(34);

select has_table(
  'public',
  'zagulyaky_record_origins',
  'the retained generic record-origin table exists'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.zagulyaky_record_origins'::regclass),
  'retained record origins have RLS enabled'
);

select ok(
  not has_table_privilege('authenticated', 'public.zagulyaky_record_origins', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zagulyaky_record_origins', 'INSERT')
  and has_table_privilege('service_role', 'public.zagulyaky_record_origins', 'SELECT'),
  'retained private origin rows are service-only'
);

select hasnt_table('public', 'zagulyaky_tabular_import_record_origins', 'tabular origin ledger is removed');
select hasnt_table('public', 'zagulyaky_tabular_import_card_records', 'tabular card mapping is removed');
select hasnt_table('public', 'zagulyaky_tabular_import_qc', 'tabular QC ledger is removed');
select hasnt_table('public', 'zagulyaky_tabular_import_chunks', 'tabular chunk receipts are removed');
select hasnt_table('public', 'zagulyaky_tabular_import_participants', 'tabular participants are removed');
select hasnt_table('public', 'zagulyaky_tabular_import_event_sources', 'tabular event sources are removed');
select hasnt_table('public', 'zagulyaky_tabular_import_cards', 'tabular cards are removed');
select hasnt_table('public', 'zagulyaky_tabular_import_events', 'tabular events are removed');
select hasnt_table('public', 'zagulyaky_tabular_import_source_posts', 'tabular source posts are removed');
select hasnt_table('public', 'zagulyaky_tabular_import_batches', 'tabular batches are removed');
select hasnt_table('public', 'zagulyaky_ingestion_structured_candidates', 'structured candidates are removed');
select hasnt_table('public', 'zagulyaky_structuring_tasks', 'structuring tasks are removed');
select hasnt_table('public', 'zagulyaky_structuring_runs', 'structuring runs are removed');
select hasnt_table('public', 'zagulyaky_ingestion_audit_events', 'ingestion audit events are removed');
select hasnt_table('public', 'zagulyaky_ingestion_item_records', 'ingestion record links are removed');
select hasnt_table('public', 'zagulyaky_ingestion_attachments', 'ingestion attachments are removed');
select hasnt_table('public', 'zagulyaky_ingestion_links', 'ingestion links are removed');
select hasnt_table('public', 'zagulyaky_extraction_jobs', 'extraction jobs are removed');
select hasnt_table('public', 'zagulyaky_ingestion_item_errors', 'ingestion errors are removed');
select hasnt_table('public', 'zagulyaky_ingestion_chunks', 'ingestion chunks are removed');
select hasnt_table('public', 'zagulyaky_ingestion_batch_items', 'ingestion batch membership is removed');
select hasnt_table('public', 'zagulyaky_ingestion_media_assets', 'ingestion media assets are removed');
select hasnt_table('public', 'zagulyaky_ingestion_items', 'ingestion items are removed');
select hasnt_table('public', 'zagulyaky_ingestion_batches', 'ingestion batches are removed');

select hasnt_function(
  'public',
  'admin_begin_zagulyaky_facebook_import_v1',
  array['text', 'text', 'timestamptz', 'text', 'integer', 'text', 'jsonb'],
  'Facebook import RPC is removed'
);
select hasnt_function(
  'public',
  'admin_begin_zagulyaky_tabular_event_import_v1',
  array['text', 'text', 'jsonb', 'text'],
  'XLSX import RPC is removed'
);
select hasnt_function(
  'public',
  'admin_start_zagulyaky_structuring_run_v1',
  array['uuid', 'text', 'text', 'text', 'boolean', 'text', 'integer', 'integer'],
  'staging structuring RPC is removed'
);
select hasnt_function(
  'security_private',
  'zagulyaky_commit_recovery_eligible_v1',
  array['public.zagulyaky_ingestion_batches'],
  'ingestion recovery helper is removed before its composite table type'
);
select hasnt_function(
  'security_private',
  'zagulyaky_structured_candidate_search_text_v1',
  array['jsonb'],
  'structured candidate helper is removed with the retired pipeline'
);

select has_function(
  'public',
  'get_public_zagulyaka_v1',
  array['text'],
  'public catalogue detail RPC remains'
);
select has_function(
  'public',
  'admin_get_zagulyaka_review_bundle_v1',
  array['uuid', 'integer', 'integer'],
  'ordinary moderation review RPC remains'
);

select * from finish();

rollback;
