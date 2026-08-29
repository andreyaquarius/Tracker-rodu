begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(42);

select has_table('public', 'context_relation_types', 'context relation type catalogue exists');
select has_table('public', 'person_context_relations', 'project context relation table exists');
select hasnt_column('public', 'person_context_relations', 'tree_id', 'context relations have no family tree scope');
select has_table('public', 'context_relation_evidence', 'context relation evidence table exists');
select has_table('public', 'context_graph_revisions', 'context graph has an independent revision table');

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_finding_project_fkey'
      and constraint_row.contype = 'f'
      and constraint_row.convalidated
  )
  and exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_person_project_fkey'
      and constraint_row.contype = 'f'
      and constraint_row.convalidated
  ),
  'finding participants have validated composite project-scope foreign keys'
);

select has_function(
  'public', 'list_person_context_relations_v1',
  array['uuid', 'uuid', 'boolean', 'integer', 'integer'],
  'bounded context relation read RPC exists'
);
select has_function(
  'public', 'save_person_context_relation_v1',
  array['uuid', 'jsonb', 'integer'],
  'optimistic-lock context relation write RPC exists'
);
select has_function(
  'public', 'save_context_relation_evidence_v1',
  array['uuid', 'jsonb', 'integer'],
  'evidence write RPC exists'
);

select ok(
  not (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'public.save_person_context_relation_v1(uuid,jsonb,integer)'::regprocedure
  )
  and (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'security_private.save_person_context_relation_v1(uuid,jsonb,integer)'::regprocedure
  ),
  'public context write API is an invoker facade over a checked private body'
);

select ok(
  not has_table_privilege('authenticated', 'public.person_context_relations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.person_context_relations', 'INSERT')
  and has_function_privilege(
    'authenticated',
    'public.list_person_context_relations_v1(uuid,uuid,boolean,integer,integer)',
    'EXECUTE'
  ),
  'authenticated clients use RPCs instead of direct context table grants'
);

-- A prior interrupted pgTAP invocation may have committed part of its fixture
-- before the runner stopped. Remove only this test's reserved identities so
-- the file remains independently rerunnable and full-suite order agnostic.
delete from public.projects
where id in (
  'ca200000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000002'
);

delete from auth.users
where id in (
  'ca100000-0000-4000-8000-000000000001',
  'ca100000-0000-4000-8000-000000000002',
  'ca100000-0000-4000-8000-000000000003'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'ca100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'context-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ca100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'context-editor@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ca100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'context-viewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('ca100000-0000-4000-8000-000000000001', 'context-owner@example.test', 'Context owner'),
  ('ca100000-0000-4000-8000-000000000002', 'context-editor@example.test', 'Context editor'),
  ('ca100000-0000-4000-8000-000000000003', 'context-viewer@example.test', 'Context viewer')
on conflict (user_id) do update
set
  email = excluded.email,
  display_name = excluded.display_name;

insert into public.projects (id, owner_id, name)
values
  ('ca200000-0000-4000-8000-000000000001', 'ca100000-0000-4000-8000-000000000001', 'Context graph fixture'),
  ('ca200000-0000-4000-8000-000000000002', 'ca100000-0000-4000-8000-000000000001', 'Foreign evidence fixture');

insert into public.project_members (project_id, user_id, role, invited_by) values
  ('ca200000-0000-4000-8000-000000000001', 'ca100000-0000-4000-8000-000000000002', 'editor', 'ca100000-0000-4000-8000-000000000001'),
  ('ca200000-0000-4000-8000-000000000001', 'ca100000-0000-4000-8000-000000000003', 'viewer', 'ca100000-0000-4000-8000-000000000001');

insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
) values
  ('ca300000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000001', 'Context person one', false, 'project', 'ca100000-0000-4000-8000-000000000001'),
  ('ca300000-0000-4000-8000-000000000002', 'ca200000-0000-4000-8000-000000000001', 'Context person two', false, 'project', 'ca100000-0000-4000-8000-000000000001'),
  ('ca300000-0000-4000-8000-000000000003', 'ca200000-0000-4000-8000-000000000001', 'Context person three', true, 'private', 'ca100000-0000-4000-8000-000000000001'),
  ('ca300000-0000-4000-8000-000000000004', 'ca200000-0000-4000-8000-000000000002', 'Foreign project person', false, 'project', 'ca100000-0000-4000-8000-000000000001');

insert into public.findings (id, project_id, finding_type, created_by) values
  ('ca800000-0000-4000-8000-000000000001', 'ca200000-0000-4000-8000-000000000001', 'Local finding', 'ca100000-0000-4000-8000-000000000001'),
  ('ca800000-0000-4000-8000-000000000002', 'ca200000-0000-4000-8000-000000000002', 'Foreign finding', 'ca100000-0000-4000-8000-000000000001');

select set_config('test.cross_finding_scope_sqlstate', 'none', true);
do $cross_finding$
begin
  begin
    insert into public.finding_participants (
      id, project_id, finding_id, person_id, name, role
    ) values (
      'ca900000-0000-4000-8000-000000000001',
      'ca200000-0000-4000-8000-000000000001',
      'ca800000-0000-4000-8000-000000000002',
      'ca300000-0000-4000-8000-000000000001',
      'Cross-project finding participant', 'witness'
    );
  exception when foreign_key_violation then
    perform set_config('test.cross_finding_scope_sqlstate', sqlstate, true);
  end;
end;
$cross_finding$;

select is(
  current_setting('test.cross_finding_scope_sqlstate'),
  '23503',
  'finding participants reject a Finding from another project'
);

select set_config('test.cross_person_scope_sqlstate', 'none', true);
do $cross_person$
begin
  begin
    insert into public.finding_participants (
      id, project_id, finding_id, person_id, name, role
    ) values (
      'ca900000-0000-4000-8000-000000000002',
      'ca200000-0000-4000-8000-000000000001',
      'ca800000-0000-4000-8000-000000000001',
      'ca300000-0000-4000-8000-000000000004',
      'Cross-project Person participant', 'witness'
    );
  exception when foreign_key_violation then
    perform set_config('test.cross_person_scope_sqlstate', sqlstate, true);
  end;
end;
$cross_person$;

select is(
  current_setting('test.cross_person_scope_sqlstate'),
  '23503',
  'finding participants reject a Person from another project'
);

insert into public.documents (id, project_id, title, created_by) values (
  'ca700000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000002',
  'Foreign project document',
  'ca100000-0000-4000-8000-000000000001'
);

insert into public.family_trees (
  id, project_id, title, root_person_id, is_default, privacy_status, created_by
) values (
  'ca400000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'Unrelated family tree',
  'ca300000-0000-4000-8000-000000000001',
  true, 'project', 'ca100000-0000-4000-8000-000000000001'
);

select ok(
  (select count(*) >= 15 from public.context_relation_types where project_id is null and is_system),
  'system social and documentary relation types are seeded'
);

select set_config(
  'test.context_family_version',
  (select graph_version::text from public.family_trees where id = 'ca400000-0000-4000-8000-000000000001'),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ca100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select set_config(
  'test.context_relation_id',
  public.save_person_context_relation_v1(
    'ca200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'relationTypeCode', 'godparent',
      'sourcePersonId', 'ca300000-0000-4000-8000-000000000001',
      'targetPersonId', 'ca300000-0000-4000-8000-000000000002',
      'evidenceStatus', 'likely',
      'confidence', 75,
      'privacyStatus', 'project',
      'notes', 'Editor-created contextual assertion'
    ),
    null
  ) ->> 'id',
  true
);

select isnt(
  current_setting('test.context_relation_id', true),
  '',
  'an editor creates a project-level contextual relation through the RPC'
);

select is(
  (public.list_person_context_relations_v1(
    'ca200000-0000-4000-8000-000000000001',
    'ca300000-0000-4000-8000-000000000001',
    false, 100, 0
  ) #>> '{items,0,projectId}')
  || ':' ||
  (public.list_person_context_relations_v1(
    'ca200000-0000-4000-8000-000000000001',
    'ca300000-0000-4000-8000-000000000001',
    false, 100, 0
  ) #>> '{items,0,sourcePersonId}')
  || ':' ||
  (public.list_person_context_relations_v1(
    'ca200000-0000-4000-8000-000000000001',
    'ca300000-0000-4000-8000-000000000001',
    false, 100, 0
  ) #>> '{items,0,targetPersonId}'),
  'ca200000-0000-4000-8000-000000000001:ca300000-0000-4000-8000-000000000001:ca300000-0000-4000-8000-000000000002',
  'the relation retains exact project and Person endpoints without a tree'
);

select is(
  (select graph_version::text from public.family_trees where id = 'ca400000-0000-4000-8000-000000000001'),
  current_setting('test.context_family_version'),
  'creating a contextual relation does not bump family_trees.graph_version'
);

select is(
  public.list_person_context_relations_v1(
    'ca200000-0000-4000-8000-000000000001',
    'ca300000-0000-4000-8000-000000000001',
    false, 100, 0
  ) #>> '{items,0,lockVersion}',
  '1',
  'new contextual relations start at lock version one'
);

select set_config(
  'test.context_evidence_id',
  public.save_context_relation_evidence_v1(
    'ca200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'relationId', current_setting('test.context_relation_id'),
      'evidenceKind', 'note',
      'excerpt', 'Evidence excerpt'
    ),
    null
  ) ->> 'id',
  true
);

select isnt(
  current_setting('test.context_evidence_id', true),
  '',
  'an editor attaches an independent evidence item'
);

select is(
  jsonb_array_length(
    public.list_person_context_relations_v1(
      'ca200000-0000-4000-8000-000000000001',
      'ca300000-0000-4000-8000-000000000001',
      false, 100, 0
    ) #> '{items,0,evidence}'
  ),
  1,
  'the relation exposes one active evidence item'
);

select throws_ok(
  format(
    $sql$
      select public.save_context_relation_evidence_v1(
        %L::uuid,
        jsonb_build_object(
          'relationId', %L,
          'evidenceKind', 'document',
          'sourceDocumentId', %L
        ),
        null
      )
    $sql$,
    'ca200000-0000-4000-8000-000000000001',
    current_setting('test.context_relation_id'),
    'ca700000-0000-4000-8000-000000000001'
  ),
  '22023',
  'CONTEXT_EVIDENCE_DOCUMENT_PROJECT_MISMATCH',
  'evidence cannot reference a document from another project'
);

select is(
  public.save_person_context_relation_v1(
    'ca200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'relationTypeCode', 'neighbor',
      'sourcePersonId', 'ca300000-0000-4000-8000-000000000001',
      'targetPersonId', 'ca300000-0000-4000-8000-000000000003',
      'privacyStatus', 'project'
    ),
    null
  ) #>> '{projectId}',
  'ca200000-0000-4000-8000-000000000001',
  'an editor can see and create context involving a living private person'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"ca100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select is(
  public.list_person_context_relations_v1(
    'ca200000-0000-4000-8000-000000000001',
    'ca300000-0000-4000-8000-000000000001',
    false, 100, 0
  ) ->> 'total',
  '1',
  'a project viewer sees ordinary context but cannot infer a relation touching a living private endpoint'
);

select throws_ok(
  $$
    select public.save_person_context_relation_v1(
      'ca200000-0000-4000-8000-000000000001'::uuid,
      jsonb_build_object(
        'relationTypeCode', 'neighbor',
        'sourcePersonId', 'ca300000-0000-4000-8000-000000000001',
        'targetPersonId', 'ca300000-0000-4000-8000-000000000003'
      ),
      null
    )
  $$,
  '42501',
  'PROJECT_EDIT_REQUIRED',
  'a project viewer cannot create contextual relations'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"ca100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  format(
    'select public.archive_person_context_relation_v1(%L::uuid, %L::uuid, 999)',
    'ca200000-0000-4000-8000-000000000001',
    current_setting('test.context_relation_id')
  ),
  '40001',
  'CONTEXT_RELATION_STALE_OR_NOT_FOUND',
  'stale relation mutations fail closed'
);

select ok(
  (public.archive_context_relation_evidence_v1(
    'ca200000-0000-4000-8000-000000000001',
    current_setting('test.context_evidence_id')::uuid,
    1
  ) ->> 'deletedAt') is not null,
  'evidence is soft-deleted with an optimistic lock'
);

select set_config(
  'test.archived_context_relation',
  public.archive_person_context_relation_v1(
    'ca200000-0000-4000-8000-000000000001',
    current_setting('test.context_relation_id')::uuid,
    1
  )::text,
  true
);

select ok(
  (current_setting('test.archived_context_relation')::jsonb ->> 'deletedAt') is not null,
  'contextual relations are soft-deleted instead of erasing evidence history'
);

select is(
  current_setting('test.archived_context_relation')::jsonb ->> 'lockVersion',
  '2',
  'soft deletion advances the relation lock version'
);

reset role;
select set_config('request.jwt.claims', '{}', true);

insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type,
  status, evidence_text, notes, created_by
) values (
  'ca500000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000002',
  'ca300000-0000-4000-8000-000000000003',
  'свідок', 'доведено', 'Legacy evidence', 'Legacy note',
  'ca100000-0000-4000-8000-000000000001'
);

select is(
  (
    select count(*)::integer from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'ca500000-0000-4000-8000-000000000001'
      and deleted_at is null
  ),
  1,
  'ongoing person_relations writes project into exactly one context assertion'
);

select is(
  (
    select evidence.excerpt
    from public.context_relation_evidence evidence
    join public.person_context_relations relation on relation.id = evidence.relation_id
    where relation.legacy_source_table = 'person_relations'
      and relation.legacy_source_id = 'ca500000-0000-4000-8000-000000000001'
      and evidence.deleted_at is null
  ),
  'Legacy evidence',
  'legacy evidence text is preserved as a separate evidence item'
);

select security_private.sync_context_from_person_relation_v1(
  'ca500000-0000-4000-8000-000000000001', false
);

select is(
  (
    select count(*)::integer from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'ca500000-0000-4000-8000-000000000001'
  ),
  1,
  're-running the person relation backfill is idempotent'
);

update public.person_relations
set notes = 'Updated legacy note', evidence_text = 'Updated legacy evidence'
where id = 'ca500000-0000-4000-8000-000000000001';

select is(
  (
    select notes from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'ca500000-0000-4000-8000-000000000001'
  ),
  'Updated legacy note',
  'legacy updates continue to refresh their context assertion'
);

delete from public.person_relations
where id = 'ca500000-0000-4000-8000-000000000001';

select ok(
  (
    select deleted_at is not null from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'ca500000-0000-4000-8000-000000000001'
  ),
  'deleting a legacy assertion soft-deletes only its context projection'
);

insert into public.association_relationships (
  id, project_id, tree_id, person_a_id, person_b_id, association_type,
  privacy_status, created_by
) values (
  'ca600000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000001',
  'ca400000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000003',
  'neighbor', 'project', 'ca100000-0000-4000-8000-000000000001'
);

select is(
  (
    select count(*)::integer from public.person_context_relations
    where legacy_source_table = 'association_relationships'
      and legacy_source_id = 'ca600000-0000-4000-8000-000000000001'
      and deleted_at is null
  ),
  1,
  'ongoing tree-scoped association writes project into the tree-independent model'
);

delete from public.association_relationships
where id = 'ca600000-0000-4000-8000-000000000001';

select ok(
  (
    select deleted_at is not null from public.person_context_relations
    where legacy_source_table = 'association_relationships'
      and legacy_source_id = 'ca600000-0000-4000-8000-000000000001'
  ),
  'deleting an old association soft-deletes its context projection'
);

insert into public.family_trees (
  id, project_id, title, is_default, privacy_status, created_by
) values (
  'ca400000-0000-4000-8000-000000000002',
  'ca200000-0000-4000-8000-000000000001',
  'Disposable compatibility tree', false, 'project',
  'ca100000-0000-4000-8000-000000000001'
);

insert into public.association_relationships (
  id, project_id, tree_id, person_a_id, person_b_id, association_type,
  privacy_status, created_by
) values (
  'ca600000-0000-4000-8000-000000000002',
  'ca200000-0000-4000-8000-000000000001',
  'ca400000-0000-4000-8000-000000000002',
  'ca300000-0000-4000-8000-000000000001',
  'ca300000-0000-4000-8000-000000000002',
  'benefactor', 'project', 'ca100000-0000-4000-8000-000000000001'
);

select set_config(
  'test.main_tree_version_before_context_tree_delete',
  (select graph_version::text from public.family_trees where id = 'ca400000-0000-4000-8000-000000000001'),
  true
);

delete from public.family_trees
where id = 'ca400000-0000-4000-8000-000000000002';

select ok(
  exists (
    select 1 from public.person_context_relations
    where legacy_source_table = 'association_relationships'
      and legacy_source_id = 'ca600000-0000-4000-8000-000000000002'
      and deleted_at is null
  )
  and not exists (
    select 1 from public.association_relationships
    where id = 'ca600000-0000-4000-8000-000000000002'
  ),
  'deleting a family tree removes its compatibility edge but preserves the project social assertion'
);

select is(
  (select graph_version::text from public.family_trees where id = 'ca400000-0000-4000-8000-000000000001'),
  current_setting('test.main_tree_version_before_context_tree_delete'),
  'deleting another family-tree view does not change the surviving tree through context lifecycle hooks'
);

select ok(
  (select revision > 0 from public.context_graph_revisions where project_id = 'ca200000-0000-4000-8000-000000000001'),
  'context changes advance only the independent project context revision'
);

select ok(
  exists (
    select 1 from security_private.context_graph_audit_log
    where project_id = 'ca200000-0000-4000-8000-000000000001'
      and entity_table = 'person_context_relations'
  ),
  'context relation writes are recorded in the private audit trail'
);

select ok(
  array['context_relation_evidence', 'person_context_relations', 'context_relation_types', 'context_graph_revisions']
    <@ private.project_deletion_phase_names(),
  'all project-owned context tables participate in durable project deletion'
);

select ok(
  not exists (
    select 1
    from public.person_context_relations context_relation
    join public.parent_child_relationships family_relation
      on family_relation.id = context_relation.id
  ),
  'context assertion identities do not overlap family edge storage in the fixture'
);

select is(
  (select count(*)::integer from public.family_trees where project_id = 'ca200000-0000-4000-8000-000000000001'),
  1,
  'context CRUD never creates another family tree'
);

select * from finish();
rollback;
