begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(70);

-- This file verifies the share contract itself.  The rollout boundary has a
-- dedicated test; enable the global feature here so owner/share behaviour is
-- exercised beyond that boundary.
update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_table(
  'security_private', 'context_graph_saved_view_shares',
  'share verifiers stay outside the exposed public schema'
);
select hasnt_table(
  'public', 'context_graph_saved_view_shares',
  'no public share table exposes bearer verifiers'
);
select has_table(
  'security_private', 'context_graph_share_post_guard',
  'private no-op write guard forces bearer resolution to POST-only transactions'
);
select has_column(
  'security_private', 'context_graph_saved_view_shares', 'token_hash',
  'share stores a token verifier'
);
select has_column(
  'security_private', 'context_graph_saved_view_shares',
  'source_view_lock_version',
  'share is pinned to one explicitly published saved-view version'
);
select has_table(
  'security_private', 'context_graph_saved_view_share_audit',
  'share lifecycle has a dedicated sanitized append-only audit'
);
select hasnt_column(
  'security_private', 'context_graph_saved_view_share_audit', 'token_hash',
  'audit never duplicates the bearer verifier'
);
select is(
  (select count(*)::text
   from pg_constraint constraint_row
   where constraint_row.conrelid =
     'security_private.context_graph_saved_view_share_audit'::regclass
     and constraint_row.contype='f' and constraint_row.confdeltype='c'),
  '4','all audit identities cascade on account/project/view/share deletion'
);
select fk_ok(
  'security_private', 'context_graph_saved_view_shares',
  array['view_id','project_id','owner_id'],
  'security_private', 'context_graph_saved_views',
  array['id','project_id','owner_id'],
  'share cannot outlive its exact owner-scoped saved view'
);
select has_function(
  'public', 'list_context_graph_view_shares_v1', array['uuid','uuid'],
  'owner share-list RPC exists'
);
select has_function(
  'public', 'create_context_graph_view_share_v1',
  array['uuid','uuid','text','timestamp with time zone','text','integer'],
  'owner share-create/rotate RPC exists'
);
select has_function(
  'public', 'update_context_graph_view_share_v1',
  array['uuid','uuid','text','timestamp with time zone','text','integer'],
  'owner share-update RPC exists'
);
select has_function(
  'public', 'revoke_context_graph_view_share_v1',
  array['uuid','uuid','integer'],
  'owner share-revoke RPC exists'
);
select has_function(
  'public', 'get_shared_context_graph_view_v1', array['text'],
  'anonymous sanitized share resolver exists'
);
select ok(
  (select procedure.provolatile = 'v'
   from pg_proc procedure
   where procedure.oid =
     'public.get_shared_context_graph_view_v1(text)'::regprocedure)
  and (select procedure.provolatile = 'v'
   from pg_proc procedure
   where procedure.oid =
     'security_private.get_shared_context_graph_view_guarded_v1(text)'::regprocedure)
  and (select procedure.provolatile = 'v'
   from pg_proc procedure
   where procedure.oid =
     'security_private.get_shared_context_graph_view_v1(text)'::regprocedure),
  'resolvers are VOLATILE so POST is READ WRITE and the write guard can reject GET/HEAD'
);
select ok(
  pg_get_functiondef(
    'security_private.get_shared_context_graph_view_v1(text)'::regprocedure
  ) ilike '%delete from security_private.context_graph_share_post_guard where false%'
  and (select count(*) = 0
       from security_private.context_graph_share_post_guard),
  'resolver uses a zero-row write gate that rejects read-only GET without persisting data'
);
select ok(
  not (select p.prosecdef from pg_proc p where p.oid =
    'public.list_context_graph_view_shares_v1(uuid,uuid)'::regprocedure)
  and not (select p.prosecdef from pg_proc p where p.oid =
    'public.create_context_graph_view_share_v1(uuid,uuid,text,timestamp with time zone,text,integer)'::regprocedure)
  and not (select p.prosecdef from pg_proc p where p.oid =
    'public.update_context_graph_view_share_v1(uuid,uuid,text,timestamp with time zone,text,integer)'::regprocedure)
  and not (select p.prosecdef from pg_proc p where p.oid =
    'public.revoke_context_graph_view_share_v1(uuid,uuid,integer)'::regprocedure)
  and not (select p.prosecdef from pg_proc p where p.oid =
    'public.get_shared_context_graph_view_v1(text)'::regprocedure),
  'all public share functions are SECURITY INVOKER facades'
);
select ok(
  has_function_privilege('authenticated',
    'public.create_context_graph_view_share_v1(uuid,uuid,text,timestamp with time zone,text,integer)',
    'EXECUTE')
  and not has_function_privilege('anon',
    'public.create_context_graph_view_share_v1(uuid,uuid,text,timestamp with time zone,text,integer)',
    'EXECUTE')
  and not has_function_privilege('service_role',
    'public.create_context_graph_view_share_v1(uuid,uuid,text,timestamp with time zone,text,integer)',
    'EXECUTE')
  and has_function_privilege('anon',
    'public.get_shared_context_graph_view_v1(text)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'public.get_shared_context_graph_view_v1(text)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'public.get_shared_context_graph_view_v1(text)', 'EXECUTE'),
  'management is authenticated-only while resolve is anon/auth without service'
);
select ok(
  not has_table_privilege('anon',
    'security_private.context_graph_saved_view_shares','SELECT')
  and not has_table_privilege('authenticated',
    'security_private.context_graph_saved_view_shares','SELECT')
  and not has_table_privilege('service_role',
    'security_private.context_graph_saved_view_shares','SELECT')
  and not has_table_privilege('anon',
    'security_private.context_graph_share_post_guard','SELECT')
  and not has_table_privilege('authenticated',
    'security_private.context_graph_share_post_guard','SELECT')
  and not has_table_privilege('service_role',
    'security_private.context_graph_share_post_guard','SELECT'),
  'no API role can read token hashes or access the POST-only guard directly'
);
select ok(
  not has_function_privilege('anon',
    'security_private.get_public_context_graph_share_v1(security_private.context_graph_saved_views,bytea)',
    'EXECUTE')
  and not has_function_privilege('authenticated',
    'security_private.context_graph_share_entity_public_v1(uuid,text,uuid)',
    'EXECUTE')
  and not has_function_privilege('anon',
    'security_private.get_shared_context_graph_view_v1(text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'security_private.get_shared_context_graph_view_v1(text)', 'EXECUTE')
  and has_function_privilege('anon',
    'security_private.get_shared_context_graph_view_guarded_v1(text)', 'EXECUTE')
  and has_function_privilege('authenticated',
    'security_private.get_shared_context_graph_view_guarded_v1(text)', 'EXECUTE')
  and not has_function_privilege('service_role',
    'security_private.get_shared_context_graph_view_guarded_v1(text)', 'EXECUTE'),
  'only the rollout-guarded resolver body is exposed to anon and authenticated'
);

delete from public.projects where id in (
  'cc200000-0000-4000-8000-000000000001',
  'cc200000-0000-4000-8000-000000000002'
);
delete from auth.users where id in (
  'cc100000-0000-4000-8000-000000000001',
  'cc100000-0000-4000-8000-000000000002',
  'cc100000-0000-4000-8000-000000000003',
  'cc100000-0000-4000-8000-000000000004'
);

insert into auth.users(
  instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values
  ('00000000-0000-0000-0000-000000000000','cc100000-0000-4000-8000-000000000001','authenticated','authenticated','share-owner@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-4000-000000000000','cc100000-0000-4000-8000-000000000002','authenticated','authenticated','share-editor@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-4000-000000000000','cc100000-0000-4000-8000-000000000003','authenticated','authenticated','share-viewer@example.test','',now(),'{}','{}',now(),now()),
  ('00000000-0000-0000-4000-000000000000','cc100000-0000-4000-8000-000000000004','authenticated','authenticated','share-outsider@example.test','',now(),'{}','{}',now(),now());

insert into public.profiles(user_id,email,display_name) values
  ('cc100000-0000-4000-8000-000000000001','share-owner@example.test','Share owner'),
  ('cc100000-0000-4000-8000-000000000002','share-editor@example.test','Share editor'),
  ('cc100000-0000-4000-8000-000000000003','share-viewer@example.test','Share viewer'),
  ('cc100000-0000-4000-8000-000000000004','share-outsider@example.test','Share outsider')
on conflict(user_id) do update set email=excluded.email,display_name=excluded.display_name;

insert into public.projects(id,owner_id,name) values
  ('cc200000-0000-4000-8000-000000000001','cc100000-0000-4000-8000-000000000001','Public share fixture'),
  ('cc200000-0000-4000-8000-000000000002','cc100000-0000-4000-8000-000000000004','Foreign public share fixture');
insert into public.project_members(project_id,user_id,role,invited_by) values
  ('cc200000-0000-4000-8000-000000000001','cc100000-0000-4000-8000-000000000002','editor','cc100000-0000-4000-8000-000000000001'),
  ('cc200000-0000-4000-8000-000000000001','cc100000-0000-4000-8000-000000000003','viewer','cc100000-0000-4000-8000-000000000001');

insert into public.persons(
  id,project_id,full_name,birth_date,death_date,is_living,privacy_status,created_by
) values
  ('cc300000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000001','Public center','1800','1870',false,'public','cc100000-0000-4000-8000-000000000001'),
  ('cc300000-0000-4000-8000-000000000002','cc200000-0000-4000-8000-000000000001','Public deceased neighbor','1810','1880',false,'public','cc100000-0000-4000-8000-000000000001'),
  ('cc300000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000001','SECRET LIVING PERSON','','',true,'public','cc100000-0000-4000-8000-000000000001'),
  ('cc300000-0000-4000-8000-000000000004','cc200000-0000-4000-8000-000000000001','SECRET PRIVATE DECEASED','1820','1890',false,'private','cc100000-0000-4000-8000-000000000001'),
  ('cc300000-0000-4000-8000-000000000005','cc200000-0000-4000-8000-000000000001','SECRET UNKNOWN-LIVING STATUS','1830','невідомо',false,'public','cc100000-0000-4000-8000-000000000001'),
  ('cc300000-0000-4000-8000-000000000006','cc200000-0000-4000-8000-000000000001','SECRET FUTURE DEATH STATUS','1835','9999',false,'public','cc100000-0000-4000-8000-000000000001');

insert into public.places(
  id,project_id,canonical_name,modern_name,status,verification_status,
  is_public,published_at,created_by
) values
  ('cc400000-0000-4000-8000-000000000001',null,'Public global place','Modern public place','active','verified',true,now(),'cc100000-0000-4000-8000-000000000001'),
  ('cc400000-0000-4000-8000-000000000002','cc200000-0000-4000-8000-000000000001','SECRET PRIVATE PLACE','','active','verified',false,null,'cc100000-0000-4000-8000-000000000001');

insert into public.documents(id,project_id,title,year_from,created_by) values (
  'cc410000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000001',
  'SECRET PRIVATE DOCUMENT','1870','cc100000-0000-4000-8000-000000000001'
);

select set_config('test.share_neighbor_type',(
  select id::text from public.context_relation_types
  where project_id is null and code='neighbor'
),true);
select set_config('test.share_located_type',(
  select id::text from public.context_relation_types
  where project_id is null and code='located_at'
),true);
select set_config('test.share_documented_type',(
  select id::text from public.context_relation_types
  where project_id is null and code='documented_in'
),true);
select set_config('test.share_other_type',(
  select id::text from public.context_relation_types
  where project_id is null and code='other'
),true);

insert into public.person_context_relations(
  id,project_id,relation_type_id,source_person_id,target_person_id,
  valid_from,evidence_status,confidence,privacy_status,assertion_kind,
  notes,created_by
) values
  ('cc500000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000001',current_setting('test.share_neighbor_type')::uuid,'cc300000-0000-4000-8000-000000000001','cc300000-0000-4000-8000-000000000002','1860-01-01','proven',90,'public','manual','PUBLIC EDGE PRIVATE NOTE','cc100000-0000-4000-8000-000000000001'),
  ('cc500000-0000-4000-8000-000000000002','cc200000-0000-4000-8000-000000000001',current_setting('test.share_neighbor_type')::uuid,'cc300000-0000-4000-8000-000000000001','cc300000-0000-4000-8000-000000000003','1861-01-01','proven',90,'public','manual','SECRET LIVING EDGE','cc100000-0000-4000-8000-000000000001'),
  ('cc500000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000001',current_setting('test.share_neighbor_type')::uuid,'cc300000-0000-4000-8000-000000000001','cc300000-0000-4000-8000-000000000004','1862-01-01','proven',90,'public','manual','SECRET PRIVATE EDGE','cc100000-0000-4000-8000-000000000001'),
  ('cc500000-0000-4000-8000-000000000004','cc200000-0000-4000-8000-000000000001',current_setting('test.share_other_type')::uuid,'cc300000-0000-4000-8000-000000000001','cc300000-0000-4000-8000-000000000002','1863-01-01','proven',90,'private','manual','SECRET PRIVATE RELATION','cc100000-0000-4000-8000-000000000001'),
  ('cc500000-0000-4000-8000-000000000007','cc200000-0000-4000-8000-000000000001',current_setting('test.share_neighbor_type')::uuid,'cc300000-0000-4000-8000-000000000001','cc300000-0000-4000-8000-000000000005','1863-02-01','proven',90,'public','manual','SECRET UNKNOWN STATUS EDGE','cc100000-0000-4000-8000-000000000001'),
  ('cc500000-0000-4000-8000-000000000008','cc200000-0000-4000-8000-000000000001',current_setting('test.share_neighbor_type')::uuid,'cc300000-0000-4000-8000-000000000001','cc300000-0000-4000-8000-000000000006','1863-03-01','proven',90,'public','manual','SECRET FUTURE DEATH EDGE','cc100000-0000-4000-8000-000000000001');

insert into public.context_relations(
  id,project_id,relation_type_id,source_entity_type,source_entity_id,
  target_entity_type,target_entity_id,valid_from,evidence_status,confidence,
  privacy_status,assertion_kind,notes,created_by
) values
  ('cc500000-0000-4000-8000-000000000005','cc200000-0000-4000-8000-000000000001',current_setting('test.share_located_type')::uuid,'person','cc300000-0000-4000-8000-000000000001','place','cc400000-0000-4000-8000-000000000001','1864-01-01','likely',80,'public','manual','PUBLIC PLACE EDGE NOTE','cc100000-0000-4000-8000-000000000001'),
  ('cc500000-0000-4000-8000-000000000006','cc200000-0000-4000-8000-000000000001',current_setting('test.share_documented_type')::uuid,'person','cc300000-0000-4000-8000-000000000001','document','cc410000-0000-4000-8000-000000000001','1865-01-01','proven',90,'public','manual','SECRET DOCUMENT EDGE','cc100000-0000-4000-8000-000000000001');

insert into public.family_trees(
  id,project_id,title,root_person_id,privacy_status,created_by
) values (
  'cc600000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000001',
  'Share-unaffected tree','cc300000-0000-4000-8000-000000000001','project',
  'cc100000-0000-4000-8000-000000000001'
);
select set_config('test.share_tree_version',(
  select graph_version::text from public.family_trees
  where id='cc600000-0000-4000-8000-000000000001'
),true);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select set_config('test.share_view_id',(
  public.save_context_graph_saved_view_v1(
    'cc200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'configVersion',1,
      'name','SECRET OWNER VIEW NAME',
      'description','SECRET OWNER RESEARCH DESCRIPTION',
      'centerEntityType','person',
      'centerEntityId','cc300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object(
        'depth',2,
        'entityTypes',jsonb_build_array('person','place','document'),
        'validFrom','1800','validTo','1900',
        'includeUndated',false,'maxNodes',100,'maxEdges',220
      ),
      'viewState',jsonb_build_object(
        'layoutId','hierarchical','zoom',1.1,
        'viewport',jsonb_build_object('x',10,'y',20,'width',800,'height',600)
      )
    ),null
  )->>'id'
),true);

select set_config('test.share_unknown_center_view',(
  public.save_context_graph_saved_view_v1(
    'cc200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'configVersion',1,'name','Unknown-status center view',
      'centerEntityType','person',
      'centerEntityId','cc300000-0000-4000-8000-000000000005',
      'filters',jsonb_build_object(
        'depth',1,'entityTypes',jsonb_build_array('person'),
        'maxNodes',100,'maxEdges',220
      ),
      'viewState',jsonb_build_object(
        'layoutId','radial','zoom',1,
        'viewport',jsonb_build_object('x',0,'y',0,'width',0,'height',0)
      )
    ),null
  )->>'id'
),true);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_unknown_center_view')::uuid)$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'public unknown-status center with non-parseable death text cannot be published'
);

select set_config('test.share_first_create_view',(
  public.save_context_graph_saved_view_v1(
    'cc200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'configVersion',1,'name','First-create lock fixture',
      'centerEntityType','person',
      'centerEntityId','cc300000-0000-4000-8000-000000000001',
      'filters',jsonb_build_object(
        'depth',1,'entityTypes',jsonb_build_array('person'),
        'maxNodes',100,'maxEdges',220
      ),
      'viewState',jsonb_build_object(
        'layoutId','radial','zoom',1,
        'viewport',jsonb_build_object('x',0,'y',0,'width',0,'height',0)
      )
    ),null
  )->>'id'
),true);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_first_create_view')::uuid,
    'public_readonly',null,null,1)$$,
  '40001','CONTEXT_GRAPH_SHARE_VERSION_CONFLICT',
  'initial create accepts only a null expected share lock'
);

select set_config('test.share_create',(
  public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',null,'Публічна мережа 1860-х'
  )::text
),true);
select set_config('test.share_token',(
  current_setting('test.share_create')::jsonb->>'token'
),true);
select set_config('test.share_id',(
  current_setting('test.share_create')::jsonb#>>'{share,id}'
),true);
select set_config('test.share_lock',(
  current_setting('test.share_create')::jsonb#>>'{share,lockVersion}'
),true);

select matches(
  current_setting('test.share_token'),'^[A-Za-z0-9_-]{43}$',
  'create returns one 256-bit base64url bearer token'
);
select ok(
  (current_setting('test.share_create')::jsonb#>>'{share,expiresAt}')::timestamptz
    between clock_timestamp()+interval '29 days'
      and clock_timestamp()+interval '31 days',
  'default share expiry is thirty days'
);
select is(
  current_setting('test.share_create')::jsonb#>>'{share,accessMode}',
  'public_readonly','MVP access mode is explicit and read-only'
);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',null,'Stale tab rotate',null)$$,
  '40001','CONTEXT_GRAPH_SHARE_VERSION_CONFLICT',
  'an existing link cannot be rotated without its current optimistic lock'
);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',null,'Stale tab rotate',99)$$,
  '40001','CONTEXT_GRAPH_SHARE_VERSION_CONFLICT',
  'a stale tab cannot rotate a newer bearer token'
);

reset role;
select ok(
  (select token_hash = extensions.digest(
      current_setting('test.share_token'),'sha256'
    ) and octet_length(token_hash)=32
   from security_private.context_graph_saved_view_shares
   where id=current_setting('test.share_id')::uuid),
  'database stores only the SHA-256 verifier for a high-entropy token'
);
select ok(
  position(current_setting('test.share_token') in (
    select to_jsonb(share_row)::text
    from security_private.context_graph_saved_view_shares share_row
    where share_row.id=current_setting('test.share_id')::uuid
  ))=0,
  'raw bearer token is absent from the persisted share row'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is(
  public.list_context_graph_view_shares_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid
  )->>'total','1','owner list contains exactly one current share row'
);
select ok(
  not (public.list_context_graph_view_shares_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid
  )::text like '%'||current_setting('test.share_token')||'%')
  and not (public.list_context_graph_view_shares_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid
  )::text like '%tokenHash%'),
  'management list never returns the raw token or its verifier'
);

select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'project_members',null,null)$$,
  '22023','CONTEXT_GRAPH_SHARE_ACCESS_MODE_INVALID',
  'unsupported audience cannot weaken the public contract'
);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',clock_timestamp()+interval '2 minutes',null)$$,
  '22023','CONTEXT_GRAPH_SHARE_EXPIRY_OUT_OF_RANGE',
  'too-short expiry is rejected'
);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',clock_timestamp()+interval '91 days',null)$$,
  '22023','CONTEXT_GRAPH_SHARE_EXPIRY_OUT_OF_RANGE',
  'expiry is capped at ninety days'
);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',null,E'bad\ntitle')$$,
  '22023','CONTEXT_GRAPH_SHARE_PUBLIC_TITLE_INVALID',
  'public title rejects control characters'
);

select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid)$$,
  '42501','CONTEXT_GRAPH_SHARE_PROJECT_OWNER_REQUIRED',
  'project editor cannot publish even a known saved view'
);
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select throws_ok(
  $$select public.list_context_graph_view_shares_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid)$$,
  '42501','CONTEXT_GRAPH_SHARE_PROJECT_OWNER_REQUIRED',
  'project viewer cannot inspect owner share metadata'
);
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000004","role":"authenticated"}',true);
select throws_ok(
  $$select public.list_context_graph_view_shares_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid)$$,
  '42501','CONTEXT_GRAPH_SHARE_PROJECT_OWNER_REQUIRED',
  'outsider cannot probe share metadata'
);

set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select set_config('test.share_public_response',(
  public.get_shared_context_graph_view_v1(
    current_setting('test.share_token')
  )::text
),true);
select is(
  current_setting('test.share_public_response')::jsonb#>>'{view,title}',
  'Публічна мережа 1860-х','anonymous bearer resolves the explicit public title'
);
select is(
  current_setting('test.share_public_response')::jsonb#>>'{view,layoutId}',
  'hierarchical','anonymous projection preserves the allowlisted saved layout'
);
select is(
  jsonb_array_length(current_setting('test.share_public_response')::jsonb#>'{graph,nodes}')::text,
  '3','public graph contains only center, public deceased neighbor, and public place'
);
select is(
  jsonb_array_length(current_setting('test.share_public_response')::jsonb#>'{graph,edges}')::text,
  '2','incident, private, and unsupported-entity edges are omitted before counting'
);
select ok(
  current_setting('test.share_public_response') not like '%SECRET%'
  and current_setting('test.share_public_response') not like '%PRIVATE NOTE%'
  and current_setting('test.share_public_response') not like '%PRIVATE RELATION%',
  'living/private/document labels, notes, and relations never enter public JSON'
);
select ok(
  current_setting('test.share_public_response') not like
    '%SECRET UNKNOWN-LIVING STATUS%'
  and current_setting('test.share_public_response') not like
    '%SECRET UNKNOWN STATUS EDGE%'
  and current_setting('test.share_public_response') not like
    '%SECRET FUTURE DEATH STATUS%'
  and current_setting('test.share_public_response') not like
    '%SECRET FUTURE DEATH EDGE%',
  'unknown or future death evidence never makes a person publicly eligible'
);
select ok(
  not (current_setting('test.share_public_response')::jsonb ? 'projectId')
  and not (current_setting('test.share_public_response')::jsonb ? 'ownerId')
  and not (current_setting('test.share_public_response')::jsonb ? 'savedViewId')
  and current_setting('test.share_public_response') not like '%SECRET OWNER VIEW NAME%'
  and current_setting('test.share_public_response') not like '%SECRET OWNER RESEARCH DESCRIPTION%',
  'public response omits project, owner, saved-view identity, name, and description'
);
select ok(
  current_setting('test.share_public_response') not like '%cc300000-%'
  and current_setting('test.share_public_response') not like '%cc400000-%'
  and current_setting('test.share_public_response') not like '%cc500000-%'
  and current_setting('test.share_public_response') not like
    '%'||current_setting('test.share_id')||'%'
  and current_setting('test.share_public_response') not like
    '%'||current_setting('test.share_neighbor_type')||'%',
  'public projection contains no raw entity, edge, relation-type, or share UUID'
);
select ok(
  (select bool_and((node->>'id') ~ '^[A-Za-z0-9_-]{43}$')
   from jsonb_array_elements(
     current_setting('test.share_public_response')::jsonb#>'{graph,nodes}'
   ) node)
  and (select bool_and((edge->>'id') ~ '^[A-Za-z0-9_-]{43}$'
      and (edge->>'source') ~ '^[A-Za-z0-9_-]{43}$'
      and (edge->>'target') ~ '^[A-Za-z0-9_-]{43}$')
    from jsonb_array_elements(
      current_setting('test.share_public_response')::jsonb#>'{graph,edges}'
    ) edge)
  and (current_setting('test.share_public_response')::jsonb#>>'{graph,centerNodeId}')
    ~ '^[A-Za-z0-9_-]{43}$',
  'all public graph identifiers are deterministic share-scoped opaque values'
);
select ok(
  not exists (
    select 1 from jsonb_array_elements(
      current_setting('test.share_public_response')::jsonb#>'{graph,edges}'
    ) edge where edge ? 'metadata' or edge ? 'notes'
      or edge ? 'sourceRoleLabel' or edge ? 'targetRoleLabel'
      or edge ? 'relationTypeId' or edge ? 'sourceEntityId'
      or edge ? 'targetEntityId'
  ),
  'public edge whitelist excludes raw IDs, arbitrary metadata, notes, and role text'
);
select is(
  (select array_agg(key order by key)::text
   from jsonb_object_keys(
     current_setting('test.share_public_response')::jsonb#>'{graph}'
   ) key),
  '{centerNodeId,edges,nodes}',
  'public graph root uses the minimal documented whitelist'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is(
  public.get_shared_context_graph_view_v1(
    current_setting('test.share_token')
  )::text,
  current_setting('test.share_public_response'),
  'authenticated editor receives byte-identical public bearer projection'
);

reset role;
alter table public.projects disable trigger projects_prevent_owner_transfer;
update public.projects set owner_id='cc100000-0000-4000-8000-000000000002'
where id='cc200000-0000-4000-8000-000000000001';
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1(
    current_setting('test.share_token'))$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'project ownership transfer suspends every link published by the former owner'
);
reset role;
update public.projects set owner_id='cc100000-0000-4000-8000-000000000001'
where id='cc200000-0000-4000-8000-000000000001';
alter table public.projects enable trigger projects_prevent_owner_transfer;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.share_update',(
  public.update_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_id')::uuid,'public_readonly',
    clock_timestamp()+interval '40 days','Оновлений публічний заголовок',
    current_setting('test.share_lock')::integer
  )::text
),true);
select is(
  current_setting('test.share_update')::jsonb#>>'{share,publicTitle}',
  'Оновлений публічний заголовок','owner can update safe public metadata'
);
select throws_ok(
  $$select public.update_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_id')::uuid,'public_readonly',
    clock_timestamp()+interval '40 days','Stale update',
    current_setting('test.share_lock')::integer)$$,
  '40001','CONTEXT_GRAPH_SHARE_VERSION_CONFLICT',
  'share update uses optimistic locking'
);
select set_config('test.share_lock',
  current_setting('test.share_update')::jsonb#>>'{share,lockVersion}',true);

reset role;
update security_private.context_graph_saved_views
set lock_version=lock_version+1,updated_at=clock_timestamp()
where id=current_setting('test.share_view_id')::uuid;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1(
    current_setting('test.share_token'))$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'editing the saved view suspends the link until explicit republish'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select is(
  public.list_context_graph_view_shares_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid
  )#>>'{items,0,status}',
  'suspended','owner sees that an edited view requires explicit republish'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.share_old_token',current_setting('test.share_token'),true);
select set_config('test.share_rotate',(
  public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',null,'Повторно опублікований граф',
    current_setting('test.share_lock')::integer
  )::text
),true);
select set_config('test.share_token',
  current_setting('test.share_rotate')::jsonb->>'token',true);
select set_config('test.share_lock',
  current_setting('test.share_rotate')::jsonb#>>'{share,lockVersion}',true);
select isnt(
  current_setting('test.share_token'),current_setting('test.share_old_token'),
  'republish rotates the bearer token'
);
reset role;
select is(
  (select count(*)::text from security_private.context_graph_saved_view_shares
   where view_id=current_setting('test.share_view_id')::uuid),
  '1','rotation retains exactly one verifier row per saved view'
);
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1(
    current_setting('test.share_old_token'))$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'rotated token immediately becomes unavailable'
);
select lives_ok(
  $$select public.get_shared_context_graph_view_v1(
    current_setting('test.share_token'))$$,
  'newly republished token resolves'
);

reset role;
update public.persons set is_living=true
where id='cc300000-0000-4000-8000-000000000002';
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select is(
  jsonb_array_length(public.get_shared_context_graph_view_v1(
    current_setting('test.share_token'))#>'{graph,nodes}')::text,
  '2','privacy flip removes the newly living person on the next request'
);
select ok(
  not exists (
    select 1 from jsonb_array_elements(public.get_shared_context_graph_view_v1(
      current_setting('test.share_token'))#>'{graph,edges}') edge
    where edge->>'sourceEntityId'='cc300000-0000-4000-8000-000000000002'
       or edge->>'targetEntityId'='cc300000-0000-4000-8000-000000000002'
  ),
  'privacy flip also removes every incident edge dynamically'
);
reset role;
update public.persons set is_living=false
where id='cc300000-0000-4000-8000-000000000002';

update security_private.context_graph_saved_views
set place_ids=array['cc400000-0000-4000-8000-000000000002'::uuid],
    lock_version=lock_version+1
where id=current_setting('test.share_view_id')::uuid;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid)$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'private place filter fails closed instead of being dropped'
);
reset role;
update security_private.context_graph_saved_views
set place_ids='{}'::uuid[],has_evidence=true,lock_version=lock_version+1
where id=current_setting('test.share_view_id')::uuid;
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok(
  $$select public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid)$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'evidence-presence filter is not allowed to leak private source existence'
);
reset role;
update security_private.context_graph_saved_views
set has_evidence=null,lock_version=lock_version+1
where id=current_setting('test.share_view_id')::uuid;

set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1('bad-token')$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'malformed token uses the same generic unavailable result'
);

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select set_config('test.share_republish',(
  public.create_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_view_id')::uuid,
    'public_readonly',null,null,current_setting('test.share_lock')::integer
  )::text
),true);
select set_config('test.share_token',
  current_setting('test.share_republish')::jsonb->>'token',true);
select set_config('test.share_lock',
  current_setting('test.share_republish')::jsonb#>>'{share,lockVersion}',true);
select set_config('test.share_revoke',(
  public.revoke_context_graph_view_share_v1(
    'cc200000-0000-4000-8000-000000000001',
    current_setting('test.share_id')::uuid,
    current_setting('test.share_lock')::integer
  )::text
),true);
select ok(
  (current_setting('test.share_revoke')::jsonb#>>'{share,revokedAt}') is not null,
  'project owner can revoke the current link'
);
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1(
    current_setting('test.share_token'))$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'revoked token uses the generic unavailable result'
);

reset role;
update security_private.context_graph_saved_view_shares
set revoked_at=null,revoked_by=null,created_at=clock_timestamp()-interval '2 days',
    expires_at=clock_timestamp()-interval '1 day'
where id=current_setting('test.share_id')::uuid;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1(
    current_setting('test.share_token'))$$,
  'P0002','CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'expired token uses the same generic unavailable result'
);

reset role;
select is(
  (select string_agg(action,',' order by id)
   from security_private.context_graph_saved_view_share_audit
   where share_id=current_setting('test.share_id')::uuid),
  'created,updated,rotated,rotated,revoked',
  'sanitized audit records create, update, republish rotations, and revoke'
);
select ok(
  not has_table_privilege('anon',
    'security_private.context_graph_saved_view_share_audit','SELECT')
  and not has_table_privilege('authenticated',
    'security_private.context_graph_saved_view_share_audit','SELECT')
  and not has_table_privilege('service_role',
    'security_private.context_graph_saved_view_share_audit','SELECT'),
  'share audit is not directly readable by API roles'
);
select is(
  (select graph_version::text from public.family_trees
   where id='cc600000-0000-4000-8000-000000000001'),
  current_setting('test.share_tree_version'),
  'share lifecycle never mutates the genealogical family graph'
);

select * from finish();
rollback;
