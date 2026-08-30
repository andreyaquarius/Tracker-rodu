begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(28);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_table('public','context_relations','polymorphic context relation table exists');
select has_table('public','context_relation_evidence_links','generic evidence table exists');
select hasnt_column('public','context_relations','tree_id','generic context remains independent of family trees');
select has_function(
  'public','save_context_relation_v2',array['uuid','jsonb','integer'],
  'generic optimistic-lock write RPC exists'
);
select has_function(
  'public','get_person_research_context_graph_v1',
  array['uuid','uuid','integer','text[]','uuid[]','text[]','text[]','date','date','integer','boolean','integer','integer'],
  'bounded research graph RPC exists'
);
select ok(
  not (select pro.prosecdef from pg_proc pro where pro.oid = 'public.save_context_relation_v2(uuid,jsonb,integer)'::regprocedure)
  and (select pro.prosecdef from pg_proc pro where pro.oid = 'security_private.save_context_relation_v2(uuid,jsonb,integer)'::regprocedure),
  'public write wrapper is invoker over a checked private body'
);
select ok(
  has_function_privilege('authenticated','public.get_person_research_context_graph_v1(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer)','EXECUTE')
  and not has_function_privilege('anon','public.get_person_research_context_graph_v1(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,integer,integer)','EXECUTE'),
  'research graph RPC is authenticated-only'
);
select ok(
  not has_table_privilege('authenticated','public.context_relations','SELECT')
  and not has_table_privilege('authenticated','public.context_relations','INSERT'),
  'authenticated clients cannot bypass the RPC surface'
);

delete from public.projects where id in (
  'e2000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000002'
);
delete from auth.users where id in (
  'e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000003'
);

insert into auth.users (
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
  ('00000000-0000-0000-0000-000000000000','e1000000-0000-4000-8000-000000000001','authenticated','authenticated','poly-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','e1000000-0000-4000-8000-000000000002','authenticated','authenticated','poly-editor@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','e1000000-0000-4000-8000-000000000003','authenticated','authenticated','poly-viewer@example.test','',now(),'{}','{}',now(),now());
insert into public.profiles(user_id,email,display_name) values
  ('e1000000-0000-4000-8000-000000000001','poly-owner@example.test','Poly owner'),
  ('e1000000-0000-4000-8000-000000000002','poly-editor@example.test','Poly editor'),
  ('e1000000-0000-4000-8000-000000000003','poly-viewer@example.test','Poly viewer')
on conflict (user_id) do update set email=excluded.email,display_name=excluded.display_name;
insert into public.projects(id,owner_id,name) values
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','Polymorphic graph fixture'),
  ('e2000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000001','Foreign polymorphic fixture');
insert into public.project_members(project_id,user_id,role,invited_by) values
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002','editor','e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003','viewer','e1000000-0000-4000-8000-000000000001');

insert into public.persons(id,project_id,full_name,is_living,privacy_status,created_by) values
  ('e3000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Research center',false,'project','e1000000-0000-4000-8000-000000000001'),
  ('e3000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','Legacy neighbor',false,'project','e1000000-0000-4000-8000-000000000001');
insert into public.documents(id,project_id,title,year_from,created_by) values
  ('e4000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Evidence document','1877','e1000000-0000-4000-8000-000000000001');
insert into public.document_sources(
  id,project_id,document_id,provider,original_url,access_mode,created_by
) values (
  'e4100000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001',
  'e4000000-0000-4000-8000-000000000001','direct_pdf','https://example.test/evidence.pdf','direct_cors',
  'e1000000-0000-4000-8000-000000000001'
);
insert into public.hypotheses(id,project_id,title,status,created_by) values
  ('e5000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Candidate identity','active','e1000000-0000-4000-8000-000000000001'),
  ('e5000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000002','Foreign hypothesis','active','e1000000-0000-4000-8000-000000000001');
insert into public.archive_resources(id,project_id,resource_type,title,archive_name,created_by) values
  ('e6000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','archive','Test archive','Archive name','e1000000-0000-4000-8000-000000000001');
insert into public.family_trees(id,project_id,title,root_person_id,privacy_status,created_by) values
  ('e7000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','Unrelated family tree','e3000000-0000-4000-8000-000000000001','project','e1000000-0000-4000-8000-000000000001');
insert into public.family_groups(id,project_id,tree_id,group_type,display_label,created_by) values
  ('e7100000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e7000000-0000-4000-8000-000000000001','research_group','Context family','e1000000-0000-4000-8000-000000000001');

select set_config('test.poly_tree_version',(select graph_version::text from public.family_trees where id='e7000000-0000-4000-8000-000000000001'),true);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);

select set_config('test.poly_hyp_relation',public.save_context_relation_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','supports_hypothesis','sourceEntityType','person','sourceEntityId','e3000000-0000-4000-8000-000000000001',
    'targetEntityType','hypothesis','targetEntityId','e5000000-0000-4000-8000-000000000001',
    'assertionKind','research_hypothesis','evidenceStatus','likely','confidence',80,'notes','private editor note'
  ),null
)->>'id',true);
select isnt(current_setting('test.poly_hyp_relation'),'','editor creates Person-to-Hypothesis relation');

select set_config('test.poly_evidence',public.save_context_relation_evidence_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationId',current_setting('test.poly_hyp_relation'),'evidenceEntityType','document',
    'evidenceEntityId','e4000000-0000-4000-8000-000000000001','sourceLocator','арк. 12','excerpt','Evidence text'
  ),null
)->>'id',true);
select isnt(current_setting('test.poly_evidence'),'','generic evidence is attached through RPC');

select set_config('test.poly_doc_relation',public.save_context_relation_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','e3000000-0000-4000-8000-000000000001',
    'targetEntityType','document','targetEntityId','e4000000-0000-4000-8000-000000000001','confidence',90
  ),null
)->>'id',true);
select public.save_context_relation_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','derived_from_source','sourceEntityType','document','sourceEntityId','e4000000-0000-4000-8000-000000000001',
    'targetEntityType','source','targetEntityId','e4100000-0000-4000-8000-000000000001','confidence',90
  ),null
);
select public.save_context_relation_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','held_by_repository','sourceEntityType','document','sourceEntityId','e4000000-0000-4000-8000-000000000001',
    'targetEntityType','repository','targetEntityId','e6000000-0000-4000-8000-000000000001','confidence',90
  ),null
);
select public.save_context_relation_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','other','sourceEntityType','person','sourceEntityId','e3000000-0000-4000-8000-000000000001',
    'targetEntityType','family','targetEntityId','e7100000-0000-4000-8000-000000000001','confidence',60
  ),null
);

select ok(exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
  )->'nodes') node where node->>'entityType'='hypothesis'
),'research graph contains Hypothesis nodes');
select ok(exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
  )->'nodes') node where node->>'entityType'='source'
),'depth two traverses to the canonical Source registry');
select ok(exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
  )->'nodes') node where node->>'entityType'='repository'
),'depth two traverses to the canonical Repository registry');
select is((select edge->>'evidenceCount' from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
)->'edges') edge where edge->>'id'=current_setting('test.poly_hyp_relation')),'1','edge exposes evidence count');
select ok(not exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
  )->'edges') edge where edge ? 'notes'
),'graph snapshot never exposes relation notes');
select ok((public.get_person_research_context_graph_v1(
  'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
)->'nodes'->0) ? 'secondaryLabel','nodes expose a secondary-label fallback');
select is(jsonb_array_length(public.get_person_research_context_graph_v1(
  'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2,
  null,null,null,null,null,null,null,true
)->'edges'),1,'has-evidence filter keeps only supported assertions');
select ok(not exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2,
    null,null,null,null,null,null,81
  )->'edges') edge where edge->>'id'=current_setting('test.poly_hyp_relation')
),'minimum-confidence filter excludes weaker assertions');

select set_config('test.poly_bad_depth','none',true);
do $bad_depth$ begin
  begin perform public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',4
  ); exception when sqlstate '22023' then perform set_config('test.poly_bad_depth',sqlstate,true); end;
end $bad_depth$;
select is(current_setting('test.poly_bad_depth'),'22023','depth is server bounded to three');

select set_config('test.poly_legacy_relation',public.save_person_context_relation_v1(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','neighbor','sourcePersonId','e3000000-0000-4000-8000-000000000001',
    'targetPersonId','e3000000-0000-4000-8000-000000000002','confidence',55
  ),null
)->>'id',true);
reset role;
select is((select person_context_relation_id::text from public.context_relations where id=current_setting('test.poly_legacy_relation')::uuid),current_setting('test.poly_legacy_relation'),'v1 Person relation is projected with the same UUID');
select is((select confidence::text from public.context_relations where id=current_setting('test.poly_legacy_relation')::uuid),'55','v1 values are synchronized to the generic projection');
select is((select graph_version::text from public.family_trees where id='e7000000-0000-4000-8000-000000000001'),current_setting('test.poly_tree_version'),'context writes never bump family-tree graph version');
select ok(exists(
  select 1 from security_private.context_graph_audit_log audit
  where audit.entity_table='context_relations' and audit.entity_id=current_setting('test.poly_hyp_relation')::uuid
),'generic relation writes are audited');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select set_config('test.poly_cross_project','none',true);
do $cross_project$ begin
  begin perform public.save_context_relation_v2(
    'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
      'relationTypeCode','supports_hypothesis','sourceEntityType','person','sourceEntityId','e3000000-0000-4000-8000-000000000001',
      'targetEntityType','hypothesis','targetEntityId','e5000000-0000-4000-8000-000000000002'
    ),null
  ); exception when foreign_key_violation then perform set_config('test.poly_cross_project',sqlstate,true); end;
end $cross_project$;
select is(current_setting('test.poly_cross_project'),'23503','cross-project polymorphic endpoints are rejected');

select public.save_context_relation_v2(
  'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','held_by_repository','sourceEntityType','person','sourceEntityId','e3000000-0000-4000-8000-000000000001',
    'targetEntityType','repository','targetEntityId','e6000000-0000-4000-8000-000000000001','privacyStatus','confidential'
  ),null
);
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select ok(jsonb_array_length(public.get_person_research_context_graph_v1(
  'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
)->'nodes') > 1,'project viewer may read the bounded graph');
select ok(not exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',2
  )->'edges') edge where edge->>'privacyStatus'='confidential'
),'confidential assertion is hidden from a viewer');
select set_config('test.poly_viewer_write','none',true);
do $viewer_write$ begin
  begin perform public.save_context_relation_v2(
    'e2000000-0000-4000-8000-000000000001',jsonb_build_object(
      'relationTypeCode','other','sourceEntityType','person','sourceEntityId','e3000000-0000-4000-8000-000000000001',
      'targetEntityType','hypothesis','targetEntityId','e5000000-0000-4000-8000-000000000001'
    ),null
  ); exception when insufficient_privilege then perform set_config('test.poly_viewer_write',sqlstate,true); end;
end $viewer_write$;
select is(current_setting('test.poly_viewer_write'),'42501','viewer cannot write contextual assertions');

reset role;
select ok((select count(*)=2 from unnest(private.project_deletion_phase_names()) phase(name) where name in ('context_relations','context_relation_evidence_links')),'project deletion covers both new tables');
select * from finish();
rollback;
