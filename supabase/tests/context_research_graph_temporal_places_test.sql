begin;

create extension if not exists pgtap with schema extensions;
set search_path=public,extensions;
select plan(45);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_function(
  'public','get_person_research_context_graph_v2',
  array['uuid','uuid','integer','text[]','uuid[]','text[]','text[]','date','date','integer','boolean','date','integer','uuid[]','boolean','integer','integer'],
  'temporal/place Research Graph v2 RPC exists'
);
select ok(
  not (select pro.prosecdef from pg_proc pro where pro.oid=
    'public.get_person_research_context_graph_v2(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer)'::regprocedure)
  and (select pro.prosecdef from pg_proc pro where pro.oid=
    'security_private.get_person_research_context_graph_v2(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer)'::regprocedure),
  'public v2 is an invoker wrapper over a checked definer body'
);
select ok(
  has_function_privilege('authenticated',
    'public.get_person_research_context_graph_v2(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer)','EXECUTE')
  and not has_function_privilege('anon',
    'public.get_person_research_context_graph_v2(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer)','EXECUTE'),
  'v2 is authenticated-only'
);
select ok(
  not has_function_privilege('authenticated','security_private.context_partial_date_bound_v1(text,boolean)','EXECUTE')
  and not has_function_privilege('authenticated','security_private.context_entity_temporal_descriptor_v1(uuid,text,uuid,boolean,date,date,date,integer)','EXECUTE')
  and not has_function_privilege('authenticated','security_private.context_entity_visible_for_temporal_graph_v1(uuid,text,uuid,boolean)','EXECUTE')
  and not has_function_privilege('authenticated','security_private.context_entity_matches_places_v1(uuid,text,uuid,uuid[])','EXECUTE')
  and not has_function_privilege('authenticated','security_private.context_relation_matches_places_v1(uuid,uuid,uuid[])','EXECUTE')
  and not has_function_privilege('authenticated','security_private.context_place_temporal_context_v1(uuid,uuid,boolean,date,date)','EXECUTE')
  and has_function_privilege('authenticated','security_private.get_person_research_context_graph_v2(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer)','EXECUTE')
  and not has_function_privilege('anon','security_private.get_person_research_context_graph_v2(uuid,uuid,integer,text[],uuid[],text[],text[],date,date,integer,boolean,date,integer,uuid[],boolean,integer,integer)','EXECUTE'),
  'helpers are sealed while the checked v2 body is authenticated-only'
);
select has_function(
  'public','get_person_research_context_graph_v1',
  array['uuid','uuid','integer','text[]','uuid[]','text[]','text[]','date','date','integer','boolean','integer','integer'],
  'deployed v1 contract remains present'
);

delete from public.projects where id in (
  'aa200000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000002'
);
delete from auth.users where id in (
  'aa100000-0000-4000-8000-000000000001','aa100000-0000-4000-8000-000000000002',
  'aa100000-0000-4000-8000-000000000003','aa100000-0000-4000-8000-000000000004'
);

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
  ('00000000-0000-0000-0000-000000000000','aa100000-0000-4000-8000-000000000001','authenticated','authenticated','temporal-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','aa100000-0000-4000-8000-000000000002','authenticated','authenticated','temporal-editor@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','aa100000-0000-4000-8000-000000000003','authenticated','authenticated','temporal-viewer@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','aa100000-0000-4000-8000-000000000004','authenticated','authenticated','temporal-outsider@example.test','',now(),'{}','{}',now(),now());
insert into public.profiles(user_id,email,display_name) values
  ('aa100000-0000-4000-8000-000000000001','temporal-owner@example.test','Temporal owner'),
  ('aa100000-0000-4000-8000-000000000002','temporal-editor@example.test','Temporal editor'),
  ('aa100000-0000-4000-8000-000000000003','temporal-viewer@example.test','Temporal viewer'),
  ('aa100000-0000-4000-8000-000000000004','temporal-outsider@example.test','Temporal outsider')
on conflict(user_id) do update set email=excluded.email,display_name=excluded.display_name;
insert into public.projects(id,owner_id,name) values
  ('aa200000-0000-4000-8000-000000000001','aa100000-0000-4000-8000-000000000001','Temporal graph fixture'),
  ('aa200000-0000-4000-8000-000000000002','aa100000-0000-4000-8000-000000000001','Foreign temporal fixture');
insert into public.project_members(project_id,user_id,role,invited_by) values
  ('aa200000-0000-4000-8000-000000000001','aa100000-0000-4000-8000-000000000002','editor','aa100000-0000-4000-8000-000000000001'),
  ('aa200000-0000-4000-8000-000000000001','aa100000-0000-4000-8000-000000000003','viewer','aa100000-0000-4000-8000-000000000001');

insert into public.persons(id,project_id,full_name,is_living,privacy_status,created_by) values
  ('aa300000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','Canonical Center',true,'private','aa100000-0000-4000-8000-000000000001'),
  ('aa300000-0000-4000-8000-000000000002','aa200000-0000-4000-8000-000000000001','Person at A',false,'project','aa100000-0000-4000-8000-000000000001'),
  ('aa300000-0000-4000-8000-000000000003','aa200000-0000-4000-8000-000000000001','Person at B',false,'project','aa100000-0000-4000-8000-000000000001'),
  ('aa300000-0000-4000-8000-000000000004','aa200000-0000-4000-8000-000000000001','Evidence-only at A',false,'project','aa100000-0000-4000-8000-000000000001'),
  ('aa300000-0000-4000-8000-000000000005','aa200000-0000-4000-8000-000000000001','Unconfirmed at A',false,'project','aa100000-0000-4000-8000-000000000001');

insert into public.person_names(
  id,project_id,person_id,name_type,full_name,original_text,is_preferred,
  valid_from,valid_to,date_precision,created_by
) values
  ('aa310000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','aa300000-0000-4000-8000-000000000001','historical','Historical Center','Historical Center',true,'1870','1879','range','aa100000-0000-4000-8000-000000000001'),
  ('aa310000-0000-4000-8000-000000000003','aa200000-0000-4000-8000-000000000001','aa300000-0000-4000-8000-000000000001','historical','Alternate Center','Alternate Center',false,'1874','1876','range','aa100000-0000-4000-8000-000000000001'),
  ('aa310000-0000-4000-8000-000000000002','aa200000-0000-4000-8000-000000000001','aa300000-0000-4000-8000-000000000001','historical','Uncertain Center','Uncertain Center',true,'бл. 1885',null,'circa','aa100000-0000-4000-8000-000000000001');

insert into public.places(
  id,project_id,canonical_name,modern_name,status,verification_status,is_public,published_at,created_by
) values
  ('aa400000-0000-4000-8000-000000000001',null,'Canonical Place A','Modern Place A','active','verified',true,now(),'aa100000-0000-4000-8000-000000000001'),
  ('aa400000-0000-4000-8000-000000000002',null,'Canonical Place B','Modern Place B','active','verified',true,now(),'aa100000-0000-4000-8000-000000000001'),
  ('aa400000-0000-4000-8000-000000000003','aa200000-0000-4000-8000-000000000002','Foreign private place','','active','verified',false,null,'aa100000-0000-4000-8000-000000000001'),
  ('aa400000-0000-4000-8000-000000000004',null,'Historical Parent Region','','active','verified',true,now(),'aa100000-0000-4000-8000-000000000001');
insert into public.places(
  id,project_id,canonical_name,status,verification_status,is_public,created_by
) values (
  'aa400000-0000-4000-8000-000000000005',null,'Merged Place A','active','verified',true,
  'aa100000-0000-4000-8000-000000000001'
);
insert into public.place_names(
  id,place_id,name,original_text,name_type,valid_from,valid_to,is_primary,confidence,created_by
) values
  ('aa410000-0000-4000-8000-000000000001','aa400000-0000-4000-8000-000000000001','Historical Place A','Historical Place A','historical','1860-01-01','1880-12-31',true,95,'aa100000-0000-4000-8000-000000000001');

insert into public.place_type_assignments(
  id,place_id,place_type_code,valid_from,valid_to,is_primary,confidence,created_by
) values
  ('aa420000-0000-4000-8000-000000000001','aa400000-0000-4000-8000-000000000001','village','1860-01-01','1880-12-31',true,95,'aa100000-0000-4000-8000-000000000001'),
  ('aa420000-0000-4000-8000-000000000002','aa400000-0000-4000-8000-000000000001','town','1870-01-01','1878-12-31',false,60,'aa100000-0000-4000-8000-000000000001');
insert into public.place_hierarchy_relations(
  id,child_place_id,parent_place_id,relation_type,valid_from,valid_to,confidence,created_by
) values (
  'aa430000-0000-4000-8000-000000000001','aa400000-0000-4000-8000-000000000001',
  'aa400000-0000-4000-8000-000000000004','administrative_parent','1800-01-01','1900-12-31',90,
  'aa100000-0000-4000-8000-000000000001'
);

insert into public.documents(id,project_id,title,created_by) values
  ('aa440000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','Document at A','aa100000-0000-4000-8000-000000000001'),
  ('aa440000-0000-4000-8000-000000000002','aa200000-0000-4000-8000-000000000001','Document unconfirmed at A','aa100000-0000-4000-8000-000000000001');
insert into public.findings(id,project_id,document_id,summary,created_by) values
  ('aa450000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','aa440000-0000-4000-8000-000000000001','Finding at A','aa100000-0000-4000-8000-000000000001');
insert into public.hypotheses(id,project_id,title,status,created_by) values
  ('aa460000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','Undated hypothesis','active','aa100000-0000-4000-8000-000000000001');
insert into public.document_place_links(
  id,document_id,place_id,project_id,relation_type,source_finding_id,resolution_status,created_by
) values
  ('aa470000-0000-4000-8000-000000000001','aa440000-0000-4000-8000-000000000001','aa400000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','mentions','aa450000-0000-4000-8000-000000000001','confirmed','aa100000-0000-4000-8000-000000000001'),
  ('aa470000-0000-4000-8000-000000000002','aa440000-0000-4000-8000-000000000002','aa400000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','mentions',null,'needs_review','aa100000-0000-4000-8000-000000000001');

insert into public.person_timeline_events(
  id,project_id,person_id,event_type,title,event_date,place_name,place_id,
  place_original_text,place_resolution_status
) values
  ('aa500000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','aa300000-0000-4000-8000-000000000002','residence','At A','1875','Historical Place A','aa400000-0000-4000-8000-000000000001','Historical Place A','confirmed'),
  ('aa500000-0000-4000-8000-000000000002','aa200000-0000-4000-8000-000000000001','aa300000-0000-4000-8000-000000000003','residence','At B','1905','Canonical Place B','aa400000-0000-4000-8000-000000000002','Canonical Place B','confirmed'),
  ('aa500000-0000-4000-8000-000000000003','aa200000-0000-4000-8000-000000000001','aa300000-0000-4000-8000-000000000005','residence','Needs review at A','1875','Historical Place A','aa400000-0000-4000-8000-000000000001','Historical Place A','needs_review');

insert into public.family_trees(id,project_id,title,root_person_id,privacy_status,created_by) values
  ('aa600000-0000-4000-8000-000000000001','aa200000-0000-4000-8000-000000000001','Unaffected tree','aa300000-0000-4000-8000-000000000001','project','aa100000-0000-4000-8000-000000000001');
select set_config('test.temporal_tree_version',(select graph_version::text from public.family_trees where id='aa600000-0000-4000-8000-000000000001'),true);

select set_config('test.temporal_neighbor_type',(
  select id::text from public.context_relation_types where project_id is null and code='neighbor'
),true);
select set_config('test.temporal_located_type',(
  select id::text from public.context_relation_types where project_id is null and code='located_at'
),true);

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa100000-0000-4000-8000-000000000002","role":"authenticated"}',true);

select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','person','targetEntityId','aa300000-0000-4000-8000-000000000002',
    'validFrom','1870-01-01','validTo','1880-12-31','notes','TEMPORAL_SECRET_NOTE'
  ),null
);
select set_config('test.temporal_legacy_evidence_relation',public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','person','targetEntityId','aa300000-0000-4000-8000-000000000004',
    'validFrom','1870-01-01','validTo','1880-12-31'
  ),null
)->>'id',true);
select public.save_context_relation_evidence_v1(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationId',current_setting('test.temporal_legacy_evidence_relation'),
    'evidenceKind','finding','sourceFindingId','aa450000-0000-4000-8000-000000000001'
  ),null
);
select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','person','targetEntityId','aa300000-0000-4000-8000-000000000005',
    'validFrom','1870-01-01','validTo','1880-12-31'
  ),null
);
select set_config('test.temporal_month_relation',public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','document','targetEntityId','aa440000-0000-4000-8000-000000000001',
    'periodText','1875-06'
  ),null
)->>'id',true);
select set_config('test.temporal_mixed_relation',public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','document','targetEntityId','aa440000-0000-4000-8000-000000000001',
    'validFrom','1875-01-01','periodText','1800'
  ),null
)->>'id',true);
select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','document','targetEntityId','aa440000-0000-4000-8000-000000000002'
  ),null
);
select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','documented_in','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','finding','targetEntityId','aa450000-0000-4000-8000-000000000001'
  ),null
);
select set_config('test.temporal_undated_relation',public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','supports_hypothesis','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','hypothesis','targetEntityId','aa460000-0000-4000-8000-000000000001'
  ),null
)->>'id',true);
select public.save_context_relation_evidence_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationId',current_setting('test.temporal_undated_relation'),
    'evidenceEntityType','place','evidenceEntityId','aa400000-0000-4000-8000-000000000001'
  ),null
);
select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','neighbor','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','person','targetEntityId','aa300000-0000-4000-8000-000000000003',
    'validFrom','1900-01-01','validTo','1910-12-31'
  ),null
);
select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','located_at','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','place','targetEntityId','aa400000-0000-4000-8000-000000000001',
    'validFrom','1860-01-01','validTo','1880-12-31'
  ),null
);
select public.save_context_relation_v2(
  'aa200000-0000-4000-8000-000000000001',jsonb_build_object(
    'relationTypeCode','located_at','sourceEntityType','person','sourceEntityId','aa300000-0000-4000-8000-000000000001',
    'targetEntityType','place','targetEntityId','aa400000-0000-4000-8000-000000000005',
    'validFrom','1860-01-01','validTo','1880-12-31'
  ),null
);

reset role;
update public.places
set status='merged',verification_status='unverified',is_public=false,
    merged_into_place_id='aa400000-0000-4000-8000-000000000001'
where id='aa400000-0000-4000-8000-000000000005';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"aa100000-0000-4000-8000-000000000002","role":"authenticated"}',true);

select is((
  select node->>'label' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where coalesce((node->>'isCenter')::boolean,false)
),'Historical Center','machine-readable person-name range supplies the 1875 label');
select is((
  select node->>'label' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1885
  )->'nodes') node where coalesce((node->>'isCenter')::boolean,false)
),'Canonical Center','arbitrary circa text is not guessed into a temporal person label');
select is((
  select node#>>'{metadata,temporalLabelApplied}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1885
  )->'nodes') node where coalesce((node->>'isCenter')::boolean,false)
),'false','unparsed person-name date is explicitly not marked as temporal');
select is((
  select node->>'label' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_date=>'1875-06-15'
  )->'nodes') node where node->>'entityId'='aa400000-0000-4000-8000-000000000001'
),'Historical Place A','dated place name supplies the point-in-time label');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where node->>'entityId'='aa300000-0000-4000-8000-000000000003'
),'0','focus year uses full-year overlap and excludes the 1900 relation');
select is((
  select node#>>'{metadata,temporalNameAmbiguous}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where coalesce((node->>'isCenter')::boolean,false)
),'true','overlapping credible historical person names are marked ambiguous');
select is((
  select node#>>'{metadata,temporalPlaceType,code}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where node->>'entityId'='aa400000-0000-4000-8000-000000000001'
),'village','dated Place type is returned in node metadata');
select is((
  select node#>>'{metadata,temporalHierarchy,0,label}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where node->>'entityId'='aa400000-0000-4000-8000-000000000001'
),'Historical Parent Region','dated administrative hierarchy is returned in node metadata');
select is((
  select node#>>'{metadata,temporalContextAmbiguous}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where node->>'entityId'='aa400000-0000-4000-8000-000000000001'
),'true','overlapping Place types are explicitly marked ambiguous');
select is((
  select node#>>'{metadata,redirectPlaceId}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001'
  )->'nodes') node where node->>'entityId'='aa400000-0000-4000-8000-000000000005'
),'aa400000-0000-4000-8000-000000000001','all-time graph redirects a legacy merged Place endpoint to its canonical target');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where node->>'entityId'='aa460000-0000-4000-8000-000000000001'
),'0','fully undated relation is excluded while temporal focus is active by default');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875,
    p_include_undated=>true
  )->'nodes') node where node->>'entityId'='aa460000-0000-4000-8000-000000000001'
),'1','includeUndated opt-in restores fully undated relations');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_valid_from=>'1875-01-01',p_valid_to=>'1875-12-31'
  )->'nodes') node where node->>'entityId'='aa460000-0000-4000-8000-000000000001'
),'0','fully undated relation is excluded by a range-only date filter by default');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_valid_from=>'1875-01-01',p_valid_to=>'1875-12-31',p_include_undated=>true
  )->'nodes') node where node->>'entityId'='aa460000-0000-4000-8000-000000000001'
),'1','includeUndated opt-in also restores undated relations for range-only filtering');
select is((
  select edge->>'validFrom' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_date=>'1875-06-15'
  )->'edges') edge where edge->>'id'=current_setting('test.temporal_month_relation')
),'1875-06-01','strict YYYY-MM period text derives a safe lower temporal bound');
select is((
  select edge#>>'{metadata,temporalBoundsDerived}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_date=>'1875-06-15'
  )->'edges') edge where edge->>'id'=current_setting('test.temporal_month_relation')
),'true','derived period bounds are labelled in edge metadata');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_valid_from=>'1875-01-01',p_valid_to=>'1875-12-31'
  )->'edges') edge where edge->>'id'=current_setting('test.temporal_mixed_relation')
),'1','mixed explicit and textual dates preserve the explicit open interval without deriving its missing bound');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa300000-0000-4000-8000-000000000002'
),'1','Place A filter keeps a person whose canonical event is at A');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa300000-0000-4000-8000-000000000003'
),'0','Place A filter excludes a person whose canonical event is only at B');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa440000-0000-4000-8000-000000000001'
),'1','confirmed document_place_link matches the Place filter');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa440000-0000-4000-8000-000000000002'
),'0','needs-review document_place_link does not match the Place filter');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa450000-0000-4000-8000-000000000001'
),'1','confirmed Finding-to-Place link matches without fuzzy place text');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa300000-0000-4000-8000-000000000004'
),'1','legacy Finding evidence keeps a relation whose target has no timeline Place');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa300000-0000-4000-8000-000000000005'
),'0','unconfirmed person event does not match the Place filter');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )->'nodes') node where node->>'entityId'='aa460000-0000-4000-8000-000000000001'
),'1','generic exact Place evidence matches the Place filter');
select is((
  select count(*)::text from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_relation_type_ids=>array[current_setting('test.temporal_neighbor_type')::uuid]
  )->'edges') edge where edge->>'relationTypeCode'='located_at'
),'0','existing relation-type filter remains effective in v2');
select is(
  public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_focus_year=>1875,p_place_ids=>array['aa400000-0000-4000-8000-000000000001'::uuid]
  )#>>'{filters,focusYear}',
  '1875','applied temporal/place filters are echoed in the result contract'
);
select ok(position('TEMPORAL_SECRET_NOTE' in public.get_person_research_context_graph_v2(
  p_project_id=>'aa200000-0000-4000-8000-000000000001',
  p_center_person_id=>'aa300000-0000-4000-8000-000000000001'
)::text)=0,'relation notes remain absent from the graph snapshot');

select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_focus_date=>'1875-01-01',p_focus_year=>1875
  )$$,
  '22023','CONTEXT_GRAPH_TEMPORAL_FOCUS_AMBIGUOUS',
  'date and year focus cannot be supplied together'
);
select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>10000
  )$$,
  '22023','CONTEXT_GRAPH_FOCUS_YEAR_OUT_OF_RANGE',
  'focus year is bounded'
);
select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array_fill('aa400000-0000-4000-8000-000000000001'::uuid,array[51])
  )$$,
  '22023','CONTEXT_GRAPH_PLACE_FILTER_LIMIT_EXCEEDED',
  'place filter is capped at fifty identifiers'
);
select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000003'::uuid]
  )$$,
  'P0002','CONTEXT_GRAPH_PLACE_NOT_FOUND_IN_SCOPE',
  'another project private place cannot be used as a filter'
);
select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',
    p_place_ids=>array['aa400000-0000-4000-8000-000000000005'::uuid]
  )$$,
  '22023','CONTEXT_GRAPH_PLACE_MERGED_USE_TARGET:aa400000-0000-4000-8000-000000000001',
  'merged Place filter returns the canonical target hint'
);
select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_max_nodes=>101
  )$$,
  '22023','CONTEXT_GRAPH_MAX_NODES_OUT_OF_RANGE',
  'node bound is preserved in v2'
);

select set_config('request.jwt.claims','{"sub":"aa100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select is((
  select node->>'label' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where coalesce((node->>'isCenter')::boolean,false)
),'Приватна особа','historical name does not reveal a private living center to a viewer');
select is((
  select node#>>'{metadata,temporalLabelApplied}' from jsonb_array_elements(public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001',p_focus_year=>1875
  )->'nodes') node where coalesce((node->>'isCenter')::boolean,false)
),'false','masked center carries no temporal-name metadata');

select set_config('request.jwt.claims','{"sub":"aa100000-0000-4000-8000-000000000004","role":"authenticated"}',true);
select throws_ok(
  $$select public.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001'
  )$$,
  '42501','PROJECT_ACCESS_REQUIRED',
  'non-member cannot read the temporal Research Graph'
);
select throws_ok(
  $$select security_private.get_person_research_context_graph_v2(
    p_project_id=>'aa200000-0000-4000-8000-000000000001',
    p_center_person_id=>'aa300000-0000-4000-8000-000000000001'
  )$$,
  '42501','PROJECT_ACCESS_REQUIRED',
  'non-member cannot bypass the public wrapper by calling the checked v2 body'
);

reset role;
select is(
  (select graph_version::text from public.family_trees where id='aa600000-0000-4000-8000-000000000001'),
  current_setting('test.temporal_tree_version'),
  'context temporal/place reads and writes do not mutate the family graph'
);
select is(
  (select count(*)::text from public.context_relations where project_id='aa200000-0000-4000-8000-000000000001' and deleted_at is null),
  '11','test fixture retained exactly its eleven independent context assertions'
);

select * from finish();
rollback;
