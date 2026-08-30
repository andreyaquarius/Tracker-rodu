begin;

create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select plan(27);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_function('public','get_context_relation_evidence_v2',array['uuid','uuid','integer','integer'],'bounded evidence listing RPC exists');
select ok(
  to_regprocedure('public.list_context_relation_evidence_v2(uuid,uuid,integer,integer)') is null,
  'obsolete public evidence-list alias is not exposed'
);
select ok(
  not (select pro.prosecdef from pg_proc pro where pro.oid='public.get_context_relation_evidence_v2(uuid,uuid,integer,integer)'::regprocedure)
  and (select pro.prosecdef from pg_proc pro where pro.oid='security_private.list_context_relation_evidence_v2(uuid,uuid,integer,integer)'::regprocedure),
  'evidence list is an invoker wrapper over a checked definer body'
);
select ok(
  has_function_privilege('authenticated','public.get_context_relation_evidence_v2(uuid,uuid,integer,integer)','EXECUTE')
  and not has_function_privilege('anon','public.get_context_relation_evidence_v2(uuid,uuid,integer,integer)','EXECUTE'),
  'evidence list is authenticated-only'
);
select ok(
  not has_function_privilege('authenticated','security_private.context_entity_visible_v2(uuid,text,uuid,boolean)','EXECUTE'),
  'actor-aware endpoint visibility helper is not client callable'
);
select ok(exists(
  select 1 from pg_trigger trigger_row
  where trigger_row.tgrelid='public.context_relations'::regclass
    and trigger_row.tgname='context_relations_25_archive_evidence' and not trigger_row.tgisinternal
),'central evidence soft-delete trigger exists');

delete from public.projects where id='f2000000-0000-4000-8000-000000000001';
delete from auth.users where id in (
  'f1000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','f1000000-0000-4000-8000-000000000003'
);
delete from public.places where id='f7000000-0000-4000-8000-000000000001';
delete from public.archive_resources where id='f7100000-0000-4000-8000-000000000001';

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
  ('00000000-0000-0000-0000-000000000000','f1000000-0000-4000-8000-000000000001','authenticated','authenticated','hard-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','f1000000-0000-4000-8000-000000000002','authenticated','authenticated','hard-editor@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','f1000000-0000-4000-8000-000000000003','authenticated','authenticated','hard-viewer@example.test','',now(),'{}','{}',now(),now());
insert into public.profiles(user_id,email,display_name) values
  ('f1000000-0000-4000-8000-000000000001','hard-owner@example.test','Hard owner'),
  ('f1000000-0000-4000-8000-000000000002','hard-editor@example.test','Hard editor'),
  ('f1000000-0000-4000-8000-000000000003','hard-viewer@example.test','Hard viewer')
on conflict(user_id) do update set email=excluded.email,display_name=excluded.display_name;
insert into public.projects(id,owner_id,name) values
  ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000001','Research hardening fixture');
insert into public.project_members(project_id,user_id,role,invited_by) values
  ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000002','editor','f1000000-0000-4000-8000-000000000001'),
  ('f2000000-0000-4000-8000-000000000001','f1000000-0000-4000-8000-000000000003','viewer','f1000000-0000-4000-8000-000000000001');
insert into public.persons(id,project_id,full_name,is_living,privacy_status,created_by) values
  ('f3000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','Graph center',false,'project','f1000000-0000-4000-8000-000000000001'),
  ('f3000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000001','Chain A',false,'project','f1000000-0000-4000-8000-000000000001'),
  ('f3000000-0000-4000-8000-000000000003','f2000000-0000-4000-8000-000000000001','Chain B',false,'project','f1000000-0000-4000-8000-000000000001'),
  ('f3000000-0000-4000-8000-000000000004','f2000000-0000-4000-8000-000000000001','Chain C',false,'project','f1000000-0000-4000-8000-000000000001'),
  ('f3000000-0000-4000-8000-000000000005','f2000000-0000-4000-8000-000000000001','Private event owner',true,'private','f1000000-0000-4000-8000-000000000001');
insert into public.documents(id,project_id,title,created_by) values
  ('f4000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','Evidence document','f1000000-0000-4000-8000-000000000001'),
  ('f4000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000001','Cleanup document','f1000000-0000-4000-8000-000000000001');
insert into public.hypotheses(id,project_id,title,status,created_by) values
  ('f5000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','Legacy linked hypothesis','active','f1000000-0000-4000-8000-000000000001');
insert into public.hypothesis_links(project_id,hypothesis_id,target_type,target_id) values
  ('f2000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-000000000001','person','f3000000-0000-4000-8000-000000000001');
insert into public.person_timeline_events(id,project_id,person_id,event_type,title,event_date) values
  ('f6000000-0000-4000-8000-000000000001','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','mention','Public event','1877-01-01'),
  ('f6000000-0000-4000-8000-000000000002','f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000005','mention','Private owner event','1878-01-01');
insert into public.places(id,project_id,canonical_name,status,verification_status,is_public,published_at,created_by) values
  ('f7000000-0000-4000-8000-000000000001',null,'Global visible place','active','verified',true,now(),'f1000000-0000-4000-8000-000000000001');
insert into public.archive_resources(id,project_id,resource_type,title,status,is_public,created_by) values
  ('f7100000-0000-4000-8000-000000000001',null,'archive','Global visible repository','active',true,'f1000000-0000-4000-8000-000000000001');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);

select set_config('test.hard_legacy_edge',(select edge->>'id' from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'edges') edge where edge->>'targetEntityType'='hypothesis'),true);
select isnt(current_setting('test.hard_legacy_edge'),'','legacy hypothesis link is visible without migration into context_relations');
select is((select edge->>'assertionKind' from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'edges') edge where edge->>'id'=current_setting('test.hard_legacy_edge')),'legacy_import','legacy projection is explicitly labelled');
select is(current_setting('test.hard_legacy_edge'),(select edge->>'id' from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'edges') edge where edge->>'targetEntityType'='hypothesis'),'legacy edge UUID is deterministic');

select set_config('test.hard_hidden_hyp_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','supports_hypothesis','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001',
    'targetEntityType','hypothesis','targetEntityId','f5000000-0000-4000-8000-000000000001','privacyStatus','confidential'
  ),null
)->>'id',true);
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select is((select edge->>'assertionKind' from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'edges') edge where edge->>'targetEntityType'='hypothesis'),'legacy_import',
  'confidential generic duplicate does not suppress a legacy edge visible to a viewer');
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select public.archive_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',current_setting('test.hard_hidden_hyp_relation')::uuid,1
);

select set_config('test.hard_hyp_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','supports_hypothesis','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001',
    'targetEntityType','hypothesis','targetEntityId','f5000000-0000-4000-8000-000000000001','confidence',75
  ),null
)->>'id',true);
select is((select count(*)::text||':'||min(edge->>'assertionKind') from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'edges') edge where edge->>'relationTypeCode'='supports_hypothesis'),'1:manual','visible generic assertion replaces its duplicate legacy projection');

select set_config('test.hard_hyp_evidence',public.save_context_relation_evidence_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationId',current_setting('test.hard_hyp_relation'),'evidenceEntityType','document',
    'evidenceEntityId','f4000000-0000-4000-8000-000000000001','sourceLocator','арк. 5',
    'excerpt','Visible excerpt','notes','SECRET_EVIDENCE_NOTE'
  ),null
)->>'id',true);
select is(public.get_context_relation_evidence_v2(
  'f2000000-0000-4000-8000-000000000001',current_setting('test.hard_hyp_relation')::uuid
)->>'count','1','active generic evidence is listed');
select ok(position('SECRET_EVIDENCE_NOTE' in public.get_context_relation_evidence_v2(
  'f2000000-0000-4000-8000-000000000001',current_setting('test.hard_hyp_relation')::uuid
)::text)=0,'evidence listing never leaks notes');

select set_config('test.hard_event_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','other','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001',
    'targetEntityType','event','targetEntityId','f6000000-0000-4000-8000-000000000001'
  ),null
)->>'id',true);
select is((select node#>>'{metadata,personId}' from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'nodes') node where node->>'entityType'='event' and node->>'entityId'='f6000000-0000-4000-8000-000000000001'),
  'f3000000-0000-4000-8000-000000000001','event metadata exposes only the owner personId needed for navigation');

select set_config('test.hard_private_event_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','other','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001',
    'targetEntityType','event','targetEntityId','f6000000-0000-4000-8000-000000000002'
  ),null
)->>'id',true);
select set_config('test.hard_place_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','located_at','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001',
    'targetEntityType','place','targetEntityId','f7000000-0000-4000-8000-000000000001'
  ),null
)->>'id',true);
select set_config('test.hard_repo_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','held_by_repository','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001',
    'targetEntityType','repository','targetEntityId','f7100000-0000-4000-8000-000000000001'
  ),null
)->>'id',true);

select set_config('test.hard_archive_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000002',
    'targetEntityType','document','targetEntityId','f4000000-0000-4000-8000-000000000001'
  ),null
)->>'id',true);
select public.save_context_relation_evidence_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationId',current_setting('test.hard_archive_relation'),'sourceLocator','one'),null);
select public.save_context_relation_evidence_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationId',current_setting('test.hard_archive_relation'),'sourceLocator','two'),null);
select public.archive_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',current_setting('test.hard_archive_relation')::uuid,1
);

select set_config('test.hard_cleanup_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000003',
    'targetEntityType','document','targetEntityId','f4000000-0000-4000-8000-000000000002'
  ),null
)->>'id',true);
select public.save_context_relation_evidence_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationId',current_setting('test.hard_cleanup_relation'),'sourceLocator','alpha'),null);
select public.save_context_relation_evidence_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationId',current_setting('test.hard_cleanup_relation'),'sourceLocator','beta'),null);

select set_config('test.hard_projected_relation',public.save_context_relation_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001','targetEntityType','person','targetEntityId','f3000000-0000-4000-8000-000000000002'),null)->>'id',true);
select public.save_context_relation_evidence_v2(
  'f2000000-0000-4000-8000-000000000001',
  jsonb_build_object('relationId',current_setting('test.hard_projected_relation'),'sourceLocator','projected'),
  null
);
select public.save_context_relation_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000002','targetEntityType','person','targetEntityId','f3000000-0000-4000-8000-000000000003'),null);
select public.save_context_relation_v2('f2000000-0000-4000-8000-000000000001',jsonb_build_object('relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000001','targetEntityType','person','targetEntityId','f3000000-0000-4000-8000-000000000004'),null);
select ok(jsonb_array_length(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',3,
  null,null,null,null,null,null,null,null,10,1
)->'nodes')<=2,'one-edge cap keeps only center and one connected neighbour');
select ok(not exists(
  select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
    'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',3,
    null,null,null,null,null,null,null,null,10,1
  )->'nodes') node
  where coalesce((node->>'isCenter')::boolean,false)=false
    and not exists(select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
      'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',3,
      null,null,null,null,null,null,null,null,10,1
    )->'edges') edge where edge->>'source'=node->>'id' or edge->>'target'=node->>'id')
),'capped graph contains no orphan nodes');
select public.archive_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',
  current_setting('test.hard_projected_relation')::uuid,
  1
);

reset role;
select is(
  (select count(*)::text from public.context_relation_evidence_links
   where relation_id=current_setting('test.hard_projected_relation')::uuid and deleted_at is null),
  '0',
  'archiving a projected person relation soft-deletes all generic evidence'
);
select is((select count(*)::text from public.context_relation_evidence_links where relation_id=current_setting('test.hard_archive_relation')::uuid and deleted_at is null),'0','archiving a relation soft-deletes all active evidence');
delete from public.documents where id='f4000000-0000-4000-8000-000000000002';
select ok((select deleted_at is not null from public.context_relations where id=current_setting('test.hard_cleanup_relation')::uuid),'endpoint cleanup archives its context relation');
select is((select count(*)::text from public.context_relation_evidence_links where relation_id=current_setting('test.hard_cleanup_relation')::uuid and deleted_at is null),'0','endpoint cleanup soft-deletes every active evidence item');

select set_config('test.hard_code_conflict','none',true);
do $code_conflict$ begin
  begin
    insert into public.context_relation_types(project_id,code,category,label_uk,is_system)
    values('f2000000-0000-4000-8000-000000000001','supports_hypothesis','research','Forbidden override',false);
  exception when unique_violation then perform set_config('test.hard_code_conflict',sqlstate,true); end;
end $code_conflict$;
select is(current_setting('test.hard_code_conflict'),'23505','project custom type cannot override a system code');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select ok(exists(select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'nodes') node where node->>'entityId'='f7000000-0000-4000-8000-000000000001'),'viewer sees a currently published global Place endpoint');
select ok(not exists(select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'nodes') node where node->>'entityId'='f6000000-0000-4000-8000-000000000002'),'viewer cannot see an Event owned by a living private Person');
select is(public.get_context_relation_evidence_v2(
  'f2000000-0000-4000-8000-000000000001',current_setting('test.hard_hyp_relation')::uuid
)->>'count','1','viewer can list evidence for a visible project relation');

reset role;
update public.places set is_public=false,published_at=null where id='f7000000-0000-4000-8000-000000000001';
update public.archive_resources set is_public=false,status='archived' where id='f7100000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select ok(not exists(select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'nodes') node where node->>'entityId'='f7000000-0000-4000-8000-000000000001'),'unpublished global Place disappears from SECURITY DEFINER graph reads');
select ok(not exists(select 1 from jsonb_array_elements(public.get_person_research_context_graph_v1(
  'f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001',1
)->'nodes') node where node->>'entityId'='f7100000-0000-4000-8000-000000000001'),'archived global Repository disappears from SECURITY DEFINER graph reads');

reset role;
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
set local role authenticated;
select set_config('test.hard_conf_relation',public.save_context_relation_v2(
  'f2000000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','contradicts_hypothesis','sourceEntityType','person','sourceEntityId','f3000000-0000-4000-8000-000000000004',
    'targetEntityType','hypothesis','targetEntityId','f5000000-0000-4000-8000-000000000001','privacyStatus','confidential'
  ),null
)->>'id',true);
select set_config('request.jwt.claims','{"sub":"f1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select set_config('test.hard_conf_read','none',true);
do $conf_read$ begin
  begin perform public.get_context_relation_evidence_v2(
    'f2000000-0000-4000-8000-000000000001',current_setting('test.hard_conf_relation')::uuid
  ); exception when no_data_found then perform set_config('test.hard_conf_read',sqlstate,true); end;
end $conf_read$;
select is(current_setting('test.hard_conf_read'),'P0002','viewer cannot probe evidence of a confidential relation');

reset role;
select * from finish();
rollback;
