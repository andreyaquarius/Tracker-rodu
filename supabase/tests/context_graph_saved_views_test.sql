begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(47);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_table(
  'security_private', 'context_graph_saved_views',
  'saved Research Graph views are stored outside the exposed public schema'
);
select hasnt_table(
  'public', 'context_graph_saved_views',
  'no public saved-view table exposes personal graph configuration'
);
select has_column(
  'security_private', 'context_graph_saved_views', 'config_version',
  'saved configuration has an explicit version'
);
select ok(
  (select pg_get_constraintdef(constraint_row.oid)
     from pg_constraint constraint_row
    where constraint_row.conrelid =
      'security_private.context_graph_saved_views'::regclass
      and constraint_row.conname = 'context_graph_saved_views_layout')
    like '%radial%'
  and (select pg_get_constraintdef(constraint_row.oid)
     from pg_constraint constraint_row
    where constraint_row.conrelid =
      'security_private.context_graph_saved_views'::regclass
      and constraint_row.conname = 'context_graph_saved_views_layout')
    like '%hierarchical%'
  and (select pg_get_constraintdef(constraint_row.oid)
     from pg_constraint constraint_row
    where constraint_row.conrelid =
      'security_private.context_graph_saved_views'::regclass
      and constraint_row.conname = 'context_graph_saved_views_layout')
    like '%force%',
  'saved-view table allowlists exactly the three section 26 layout families'
);
select has_function(
  'public', 'list_context_graph_saved_views_v1',
  array['uuid','text','uuid','integer','integer'],
  'list saved views RPC exists'
);
select has_function(
  'public', 'get_context_graph_saved_view_v1', array['uuid','uuid'],
  'get saved view RPC exists'
);
select has_function(
  'public', 'save_context_graph_saved_view_v1', array['uuid','jsonb','integer'],
  'save saved view RPC exists'
);
select has_function(
  'public', 'delete_context_graph_saved_view_v1', array['uuid','uuid','integer'],
  'delete saved view RPC exists'
);
select ok(
  not (select procedure.prosecdef from pg_proc procedure
    where procedure.oid = 'public.list_context_graph_saved_views_v1(uuid,text,uuid,integer,integer)'::regprocedure)
  and not (select procedure.prosecdef from pg_proc procedure
    where procedure.oid = 'public.get_context_graph_saved_view_v1(uuid,uuid)'::regprocedure)
  and not (select procedure.prosecdef from pg_proc procedure
    where procedure.oid = 'public.save_context_graph_saved_view_v1(uuid,jsonb,integer)'::regprocedure)
  and not (select procedure.prosecdef from pg_proc procedure
    where procedure.oid = 'public.delete_context_graph_saved_view_v1(uuid,uuid,integer)'::regprocedure),
  'all public saved-view functions are SECURITY INVOKER facades'
);
select ok(
  has_function_privilege('authenticated',
    'public.list_context_graph_saved_views_v1(uuid,text,uuid,integer,integer)','EXECUTE')
  and has_function_privilege('authenticated',
    'public.get_context_graph_saved_view_v1(uuid,uuid)','EXECUTE')
  and has_function_privilege('authenticated',
    'public.save_context_graph_saved_view_v1(uuid,jsonb,integer)','EXECUTE')
  and has_function_privilege('authenticated',
    'public.delete_context_graph_saved_view_v1(uuid,uuid,integer)','EXECUTE')
  and not has_function_privilege('anon',
    'public.list_context_graph_saved_views_v1(uuid,text,uuid,integer,integer)','EXECUTE')
  and not has_function_privilege('service_role',
    'public.list_context_graph_saved_views_v1(uuid,text,uuid,integer,integer)','EXECUTE'),
  'saved-view facade is authenticated-only'
);
select ok(
  not has_table_privilege('authenticated',
    'security_private.context_graph_saved_views','SELECT')
  and not has_table_privilege('authenticated',
    'security_private.context_graph_saved_views','INSERT')
  and not has_table_privilege('service_role',
    'security_private.context_graph_saved_views','SELECT'),
  'private saved-view rows cannot be accessed directly'
);
select ok(
  not has_function_privilege('authenticated',
    'security_private.context_graph_saved_view_json_v1(security_private.context_graph_saved_views)','EXECUTE')
  and not has_function_privilege('authenticated',
    'security_private.context_graph_saved_view_canonical_place_v1(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated',
    'security_private.validate_context_graph_saved_view_v1(security_private.context_graph_saved_views)','EXECUTE')
  and has_function_privilege('authenticated',
    'security_private.save_context_graph_saved_view_v1(uuid,jsonb,integer)','EXECUTE')
  and has_function_privilege('authenticated',
    'security_private.save_context_graph_saved_view_layout_v1(uuid,jsonb,integer)','EXECUTE')
  and not has_function_privilege('anon',
    'security_private.save_context_graph_saved_view_layout_v1(uuid,jsonb,integer)','EXECUTE')
  and not has_function_privilege('service_role',
    'security_private.save_context_graph_saved_view_layout_v1(uuid,jsonb,integer)','EXECUTE'),
  'only checked private RPC bodies are executable by authenticated callers'
);
select fk_ok(
  'security_private', 'context_graph_saved_views', array['project_id','owner_id'],
  'public', 'project_members', array['project_id','user_id'],
  'saved views are deleted when current project membership is revoked'
);
select fk_ok(
  'security_private', 'context_graph_saved_views', array['center_entity_id','project_id'],
  'public', 'persons', array['id','project_id'],
  'saved views cannot outlive their project-scoped center person'
);

delete from public.projects where id in (
  'bb200000-0000-4000-8000-000000000001',
  'bb200000-0000-4000-8000-000000000002'
);
delete from auth.users where id in (
  'bb100000-0000-4000-8000-000000000001',
  'bb100000-0000-4000-8000-000000000002',
  'bb100000-0000-4000-8000-000000000003',
  'bb100000-0000-4000-8000-000000000004'
);

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
  ('00000000-0000-0000-0000-000000000000','bb100000-0000-4000-8000-000000000001','authenticated','authenticated','saved-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','bb100000-0000-4000-8000-000000000002','authenticated','authenticated','saved-editor@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','bb100000-0000-4000-8000-000000000003','authenticated','authenticated','saved-viewer@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','bb100000-0000-4000-8000-000000000004','authenticated','authenticated','saved-outsider@example.test','',now(),'{}','{}',now(),now());

insert into public.profiles(user_id,email,display_name) values
  ('bb100000-0000-4000-8000-000000000001','saved-owner@example.test','Saved owner'),
  ('bb100000-0000-4000-8000-000000000002','saved-editor@example.test','Saved editor'),
  ('bb100000-0000-4000-8000-000000000003','saved-viewer@example.test','Saved viewer'),
  ('bb100000-0000-4000-8000-000000000004','saved-outsider@example.test','Saved outsider')
on conflict(user_id) do update set email=excluded.email,display_name=excluded.display_name;

insert into public.projects(id,owner_id,name) values
  ('bb200000-0000-4000-8000-000000000001','bb100000-0000-4000-8000-000000000001','Saved view project'),
  ('bb200000-0000-4000-8000-000000000002','bb100000-0000-4000-8000-000000000001','Other saved view project');
insert into public.project_members(project_id,user_id,role,invited_by) values
  ('bb200000-0000-4000-8000-000000000001','bb100000-0000-4000-8000-000000000002','editor','bb100000-0000-4000-8000-000000000001'),
  ('bb200000-0000-4000-8000-000000000001','bb100000-0000-4000-8000-000000000003','viewer','bb100000-0000-4000-8000-000000000001');

insert into public.persons(
  id,project_id,full_name,is_living,privacy_status,created_by
) values
  ('bb300000-0000-4000-8000-000000000001','bb200000-0000-4000-8000-000000000001','Saved center',false,'project','bb100000-0000-4000-8000-000000000001'),
  ('bb300000-0000-4000-8000-000000000002','bb200000-0000-4000-8000-000000000002','Foreign center',false,'project','bb100000-0000-4000-8000-000000000001'),
  ('bb300000-0000-4000-8000-000000000003','bb200000-0000-4000-8000-000000000001','Disposable center',false,'project','bb100000-0000-4000-8000-000000000001');

insert into public.places(
  id,project_id,canonical_name,status,verification_status,is_public,published_at,created_by
) values
  ('bb400000-0000-4000-8000-000000000001',null,'Canonical saved place','active','verified',true,now(),'bb100000-0000-4000-8000-000000000001'),
  ('bb400000-0000-4000-8000-000000000002',null,'Merged saved place','active','verified',true,now(),'bb100000-0000-4000-8000-000000000001'),
  ('bb400000-0000-4000-8000-000000000003','bb200000-0000-4000-8000-000000000002','Foreign private place','active','verified',false,null,'bb100000-0000-4000-8000-000000000001'),
  ('bb400000-0000-4000-8000-000000000004','bb200000-0000-4000-8000-000000000001','Archived private place','archived','verified',false,null,'bb100000-0000-4000-8000-000000000001');
update public.places
set status='merged', verification_status='unverified', is_public=false,
    merged_into_place_id='bb400000-0000-4000-8000-000000000001'
where id='bb400000-0000-4000-8000-000000000002';

insert into public.context_relation_types(
  id,project_id,code,category,directionality,label_uk,is_system,is_active,created_by
) values (
  'bb500000-0000-4000-8000-000000000001','bb200000-0000-4000-8000-000000000001',
  'saved_view_stale_type','research','symmetric','Тимчасовий тип',false,true,
  'bb100000-0000-4000-8000-000000000001'
);

insert into public.family_trees(
  id,project_id,title,root_person_id,privacy_status,created_by
) values (
  'bb600000-0000-4000-8000-000000000001','bb200000-0000-4000-8000-000000000001',
  'Unaffected saved-view tree','bb300000-0000-4000-8000-000000000001','project',
  'bb100000-0000-4000-8000-000000000001'
);
select set_config('test.saved_tree_version',(
  select graph_version::text from public.family_trees
  where id='bb600000-0000-4000-8000-000000000001'
),true);
select set_config('test.saved_neighbor_type',(
  select id::text from public.context_relation_types
  where project_id is null and code='neighbor'
),true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select set_config('test.saved_view_id',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'configVersion',1,
      'name','  Поручителі   1870  ',
      'description','Особистий вигляд без приватних проєкцій',
      'centerEntityType','person',
      'centerEntityId','bb300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object(
        'depth',3,
        'entityTypes',jsonb_build_array('place','person','person'),
        'relationTypeIds',jsonb_build_array(current_setting('test.saved_neighbor_type')),
        'evidenceStatuses',jsonb_build_array('proven'),
        'assertionKinds',jsonb_build_array('manual'),
        'validFrom','1860','validTo','1880-06',
        'minConfidence',60,'hasEvidence',true,
        'focusYear',1870,
        'placeIds',jsonb_build_array('bb400000-0000-4000-8000-000000000002'),
        'includeUndated',false,'maxNodes',100,'maxEdges',220
      ),
      'viewState',jsonb_build_object(
        'layoutId','radial','zoom',1.25,
        'viewport',jsonb_build_object('x',120,'y',40,'width',900,'height',600)
      )
    ),null
  )->>'id'
),true);

select is(
  public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )->>'configVersion',
  '1','a project viewer can create and load their own versioned private view'
);
select ok(
  public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )->>'name'='Поручителі 1870'
  and public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>>'{filters,placeIds,0}'='bb400000-0000-4000-8000-000000000001'
  and jsonb_array_length(public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>'{filters,entityTypes}')=2
  and public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>>'{filters,validFrom}'='1860-01-01'
  and public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>>'{filters,validTo}'='1880-06-30'
  and public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>>'{viewState,layoutId}'='radial',
  'save normalizes names, arrays, partial dates and merged places to canonical configuration IDs'
);
reset role;
select ok(
  not exists (
    select 1 from information_schema.columns column_row
    where column_row.table_schema='security_private'
      and column_row.table_name='context_graph_saved_views'
      and column_row.column_name in (
        'nodes','edges','snapshot','person_label','place_label','projected_text'
      )
  )
  and position('Saved center' in (
    select row_to_json(saved)::text
    from security_private.context_graph_saved_views saved
    where saved.id=current_setting('test.saved_view_id')::uuid
  ))=0,
  'saved rows persist configuration IDs only, never graph projections or labels'
);
set local role authenticated;
select is(
  public.list_context_graph_saved_views_v1(
    'bb200000-0000-4000-8000-000000000001',null,null,50,0
  )->>'total','1',
  'owner-scoped list returns the viewer own saved view'
);
select is(
  public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )->>'id',current_setting('test.saved_view_id'),
  'get returns the requested owner view'
);

select set_config('test.saved_view_lock',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'id',current_setting('test.saved_view_id'),'configVersion',1,
      'name','Поручителі 1870 — оновлено',
      'centerEntityType','person','centerEntityId','bb300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object('depth',2,'entityTypes',jsonb_build_array('person')),
      'viewState',jsonb_build_object('layoutId','radial','zoom',1)
    ),1
  )->>'lockVersion'
),true);
select is(current_setting('test.saved_view_lock'),'2','update advances optimistic lock version');
select set_config('test.saved_view_force_lock',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'id',current_setting('test.saved_view_id'),'configVersion',1,
      'name','Поручителі 1870 — силова схема',
      'centerEntityType','person','centerEntityId','bb300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object('depth',2,'entityTypes',jsonb_build_array('person')),
      'viewState',jsonb_build_object('layoutId','force','zoom',1.15)
    ),2
  )->>'lockVersion'
),true);
select is(
  public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>>'{viewState,layoutId}',
  'force','force layout round-trips through the owner-scoped v1 contract'
);
select set_config('test.saved_view_hierarchical_lock',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'id',current_setting('test.saved_view_id'),'configVersion',1,
      'name','Поручителі 1870 — ієрархічна схема',
      'centerEntityType','person','centerEntityId','bb300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object('depth',2,'entityTypes',jsonb_build_array('person')),
      'viewState',jsonb_build_object('layoutId','hierarchical','zoom',0.9)
    ),current_setting('test.saved_view_force_lock')::integer
  )->>'lockVersion'
),true);
select ok(
  current_setting('test.saved_view_hierarchical_lock')='4'
  and public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )#>>'{viewState,layoutId}'='hierarchical',
  'hierarchical layout round-trips and still advances the optimistic lock'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'id',current_setting('test.saved_view_id'),'configVersion',1,'name','Race',
      'centerEntityType','person','centerEntityId','bb300000-0000-4000-8000-000000000001'
    ),1
  )$$,
  '40001','CONTEXT_GRAPH_SAVED_VIEW_VERSION_CONFLICT',
  'stale update cannot overwrite a newer saved view'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid
  )$$,
  'P0002','CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND',
  'project editor cannot read another member private saved view'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.delete_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.saved_view_id')::uuid,2
  )$$,
  'P0002','CONTEXT_GRAPH_SAVED_VIEW_NOT_FOUND',
  'project owner cannot delete another member private saved view'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000004","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.list_context_graph_saved_views_v1(
    'bb200000-0000-4000-8000-000000000001'
  )$$,
  '42501','PROJECT_ACCESS_REQUIRED',
  'outsider cannot list project saved views'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Foreign center","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000002"}'::jsonb,null
  )$$,
  'P0002','CONTEXT_GRAPH_SAVED_VIEW_CENTER_NOT_VISIBLE',
  'center person from another project is rejected'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"name":"No version","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001"}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_CONFIG_VERSION_UNSUPPORTED',
  'missing configuration version fails closed'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":2,"name":"Future version","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001"}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_CONFIG_VERSION_UNSUPPORTED',
  'unknown future configuration version fails closed'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Projection leak","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","nodes":[{"label":"private"}]}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_PAYLOAD_FIELD_INVALID',
  'unknown projection fields are rejected instead of persisted'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Depth 4","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","filters":{"depth":4}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_DEPTH_OUT_OF_RANGE',
  'saved depth is capped by the currently supported graph contract'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Unsupported render cap","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","filters":{"maxNodes":80,"maxEdges":200}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_MAX_NODES_OUT_OF_RANGE',
  'v1 accepts only the exact rendering caps that the current UI restores'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Two focuses","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","filters":{"focusDate":"1870-01-01","focusYear":1870}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_TEMPORAL_FOCUS_AMBIGUOUS',
  'date and year focus cannot be saved together'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Unknown layout","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","viewState":{"layoutId":"grid"}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_LAYOUT_INVALID',
  'v1 rejects layouts outside the section 26 allowlist'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Huge zoom","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","viewState":{"layoutId":"radial","zoom":3}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_ZOOM_OUT_OF_RANGE',
  'saved zoom is bounded to the implemented canvas controls'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Bad viewport","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","viewState":{"layoutId":"radial","viewport":{"x":-1}}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_VIEWPORT_X_OUT_OF_RANGE',
  'saved viewport coordinates are bounded'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Bad relation","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","filters":{"relationTypeIds":["bb500000-0000-4000-8000-000000000099"]}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_RELATION_TYPES_INVALID',
  'unknown relation type identifier is rejected'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Foreign place","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","filters":{"placeIds":["bb400000-0000-4000-8000-000000000003"]}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_PLACE_NOT_CANONICAL',
  'private place from another project cannot be saved as a filter'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Archived place","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001","filters":{"placeIds":["bb400000-0000-4000-8000-000000000004"]}}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_PLACE_NOT_CANONICAL',
  'archived project Place cannot be persisted as an applicable v1 filter'
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"поручителі 1870 — ІЄРАРХІЧНА СХЕМА","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001"}'::jsonb,null
  )$$,
  '23505','CONTEXT_GRAPH_SAVED_VIEW_NAME_EXISTS',
  'saved-view names are unique case-insensitively per owner and project'
);

select set_config('test.stale_saved_view_id',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'configVersion',1,'name','Stale relation view',
      'centerEntityType','person','centerEntityId','bb300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object(
        'relationTypeIds',jsonb_build_array('bb500000-0000-4000-8000-000000000001')
      ),'viewState',jsonb_build_object('layoutId','radial')
    ),null
  )->>'id'
),true);
reset role;
update public.context_relation_types set is_active=false
where id='bb500000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select is(
  public.list_context_graph_saved_views_v1(
    'bb200000-0000-4000-8000-000000000001'
  )->>'total','2',
  'one stale saved view does not hide other owner views from the deletable list'
);
select throws_ok(
  $$select public.get_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.stale_saved_view_id')::uuid
  )$$,
  'P0002','CONTEXT_GRAPH_SAVED_VIEW_RELATION_FILTER_STALE',
  'loading a stale relation filter fails closed before graph application'
);
select is(
  public.delete_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',current_setting('test.stale_saved_view_id')::uuid,1
  )->>'deleted','true',
  'owner can delete a stale saved view without applying it'
);

reset role;
insert into security_private.context_graph_saved_views(
  project_id,owner_id,name,center_entity_id
)
select
  'bb200000-0000-4000-8000-000000000001',
  'bb100000-0000-4000-8000-000000000003',
  'Quota fixture ' || series.value,
  'bb300000-0000-4000-8000-000000000001'
from generate_series(1,49) series(value);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$select public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Fifty first","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001"}'::jsonb,null
  )$$,
  '22023','CONTEXT_GRAPH_SAVED_VIEW_QUOTA_EXCEEDED',
  'per-owner project quota is enforced at fifty views'
);

-- Make room for an independent center-cascade fixture after proving the cap.
reset role;
delete from security_private.context_graph_saved_views
where name='Quota fixture 49'
  and owner_id='bb100000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select set_config('test.disposable_view_id',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Disposable center view","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000003"}'::jsonb,null
  )->>'id'
),true);
reset role;
delete from public.persons where id='bb300000-0000-4000-8000-000000000003';
select is((
  select count(*)::text from security_private.context_graph_saved_views
  where id=current_setting('test.disposable_view_id')::uuid
),'0','deleting the center person cascades its saved view');

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"bb100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select set_config('test.editor_saved_view_id',(
  public.save_context_graph_saved_view_v1(
    'bb200000-0000-4000-8000-000000000001',
    '{"configVersion":1,"name":"Editor personal view","centerEntityType":"person","centerEntityId":"bb300000-0000-4000-8000-000000000001"}'::jsonb,null
  )->>'id'
),true);
reset role;
delete from public.project_members
where project_id='bb200000-0000-4000-8000-000000000001'
  and user_id='bb100000-0000-4000-8000-000000000002';
select is((
  select count(*)::text from security_private.context_graph_saved_views
  where id=current_setting('test.editor_saved_view_id')::uuid
),'0','revoking project membership cascades the former member private views');

select is(
  (select graph_version::text from public.family_trees
    where id='bb600000-0000-4000-8000-000000000001'),
  current_setting('test.saved_tree_version'),
  'saved-view CRUD does not mutate the genealogical family graph'
);

select * from finish();
rollback;
