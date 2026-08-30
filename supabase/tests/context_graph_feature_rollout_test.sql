begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(26);

select has_column(
  'public', 'app_feature_flags', 'supports_private_preview',
  'feature flags declare whether a private self-preview is supported'
);
select has_table(
  'security_private', 'app_feature_user_access',
  'per-account preview grants stay outside the exposed schema'
);
select has_function(
  'public', 'get_my_app_feature_access_v1', array['text'],
  'an authenticated account can resolve only its own effective access'
);
select has_function(
  'public', 'admin_set_my_feature_preview_v1', array['text','boolean'],
  'an administrator has an explicit self-preview mutation'
);
select has_function(
  'security_private', 'get_shared_context_graph_view_guarded_v1', array['text'],
  'anonymous graph resolution has a rollout-aware private entry point'
);

select ok(
  not has_table_privilege(
    'anon', 'security_private.app_feature_user_access', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'security_private.app_feature_user_access', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'security_private.app_feature_user_access', 'SELECT'
  )
  and (select relation.relrowsecurity
       from pg_catalog.pg_class relation
       where relation.oid =
         'security_private.app_feature_user_access'::regclass),
  'preview rows are hidden from browser roles and remain maintainable by service_role'
);
select ok(
  not has_function_privilege(
    'anon',
    'security_private.app_feature_access_for_user_v1(text,uuid,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'security_private.app_feature_access_for_user_v1(text,uuid,boolean)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'security_private.app_feature_access_for_user_v1(text,uuid,boolean)',
    'EXECUTE'
  ),
  'no API role can probe another account through the internal access predicate'
);
select ok(
  not has_function_privilege(
    'anon', 'security_private.get_shared_context_graph_view_v1(text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'security_private.get_shared_context_graph_view_v1(text)', 'EXECUTE'
  )
  and has_function_privilege(
    'anon',
    'security_private.get_shared_context_graph_view_guarded_v1(text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'security_private.get_shared_context_graph_view_guarded_v1(text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'security_private.get_shared_context_graph_view_guarded_v1(text)',
    'EXECUTE'
  ),
  'only the rollout-guarded bearer resolver is callable by browser roles'
);
select ok(
  not exists (
    select 1
    from (
      values
        ('public', 'context_relation_types'),
        ('public', 'person_context_relations'),
        ('public', 'context_relation_evidence'),
        ('public', 'context_graph_revisions'),
        ('public', 'context_relations'),
        ('public', 'context_relation_evidence_links'),
        ('security_private', 'context_graph_audit_log'),
        ('security_private', 'context_graph_saved_views'),
        ('security_private', 'context_graph_saved_view_shares'),
        ('security_private', 'context_graph_saved_view_share_audit'),
        ('security_private', 'context_graph_share_post_guard')
    ) as context_table(schema_name, table_name)
    where has_table_privilege(
            'anon',
            context_table.schema_name || '.' || context_table.table_name,
            'SELECT'
          )
       or has_table_privilege(
            'anon',
            context_table.schema_name || '.' || context_table.table_name,
            'INSERT'
          )
       or has_table_privilege(
            'anon',
            context_table.schema_name || '.' || context_table.table_name,
            'UPDATE'
          )
       or has_table_privilege(
            'anon',
            context_table.schema_name || '.' || context_table.table_name,
            'DELETE'
          )
       or has_table_privilege(
            'authenticated',
            context_table.schema_name || '.' || context_table.table_name,
            'SELECT'
          )
       or has_table_privilege(
            'authenticated',
            context_table.schema_name || '.' || context_table.table_name,
            'INSERT'
          )
       or has_table_privilege(
            'authenticated',
            context_table.schema_name || '.' || context_table.table_name,
            'UPDATE'
          )
       or has_table_privilege(
            'authenticated',
            context_table.schema_name || '.' || context_table.table_name,
            'DELETE'
          )
  )
  and not exists (
    select 1
    from (
      values
        ('context_relation_types'),
        ('person_context_relations'),
        ('context_relation_evidence'),
        ('context_graph_revisions'),
        ('context_relations'),
        ('context_relation_evidence_links')
    ) as context_table(table_name)
    where not has_table_privilege(
                'service_role', 'public.' || context_table.table_name, 'SELECT'
              )
       or not has_table_privilege(
                'service_role', 'public.' || context_table.table_name, 'INSERT'
              )
       or not has_table_privilege(
                'service_role', 'public.' || context_table.table_name, 'UPDATE'
              )
       or not has_table_privilege(
                'service_role', 'public.' || context_table.table_name, 'DELETE'
              )
  ),
  'context storage has no direct browser-role bypass and public context tables remain available to service_role'
);

update public.app_feature_flags
set is_enabled = false
where key = 'person_context_graphs_v1';
delete from security_private.app_feature_user_access
where feature_key = 'person_context_graphs_v1';

select is(
  (select is_enabled from public.app_feature_flags
   where key = 'person_context_graphs_v1'),
  false,
  'the production rollout starts globally disabled'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.get_app_feature_flags()', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_app_feature_flags()', 'EXECUTE'
  )
  and not has_function_privilege(
    'service_role', 'public.get_app_feature_flags()', 'EXECUTE'
  ),
  'effective account flags are authenticated-only'
);

delete from public.projects
where id = 'fe200000-0000-4000-8000-000000000001';
delete from auth.users
where id in (
  'fe100000-0000-4000-8000-000000000001',
  'fe100000-0000-4000-8000-000000000002'
);

insert into auth.users(
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'fe100000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'context-preview-admin@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fe100000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'context-preview-member@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into public.profiles(user_id, email, display_name) values
  (
    'fe100000-0000-4000-8000-000000000001',
    'context-preview-admin@example.test',
    'Context preview admin'
  ),
  (
    'fe100000-0000-4000-8000-000000000002',
    'context-preview-member@example.test',
    'Context preview member'
  )
on conflict (user_id) do update
set email = excluded.email,
    display_name = excluded.display_name;

insert into public.app_admins(user_id, granted_by) values (
  'fe100000-0000-4000-8000-000000000001',
  'fe100000-0000-4000-8000-000000000001'
)
on conflict (user_id) do nothing;

insert into public.projects(id, owner_id, name) values (
  'fe200000-0000-4000-8000-000000000001',
  'fe100000-0000-4000-8000-000000000001',
  'Context feature rollout fixture'
);
insert into public.project_members(project_id, user_id, role, invited_by) values (
  'fe200000-0000-4000-8000-000000000001',
  'fe100000-0000-4000-8000-000000000002',
  'editor',
  'fe100000-0000-4000-8000-000000000001'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fe100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select is(
  (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'effectiveEnabled')::boolean,
  false,
  'an ordinary project member has no access while the global rollout is off'
);
select throws_ok(
  $$select public.admin_set_my_feature_preview_v1(
    'person_context_graphs_v1', true
  )$$,
  '42501',
  'APP_ADMIN_REQUIRED',
  'a non-admin cannot grant itself a private preview'
);
select throws_ok(
  $$select public.list_context_relation_types_v1(
    'fe200000-0000-4000-8000-000000000001'::uuid,
    false
  )$$,
  '42501',
  'APP_FEATURE_DISABLED:person_context_graphs_v1',
  'the server rejects a direct context RPC while the feature is unavailable'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fe100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select is(
  (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'effectiveEnabled')::boolean,
  false,
  'administrator status alone does not silently enable a private preview'
);
select throws_ok(
  $$select public.admin_set_my_feature_preview_v1(
    'person_context_graphs_v1', null
  )$$,
  '22023',
  'FEATURE_PREVIEW_STATE_REQUIRED',
  'a null preview state cannot accidentally revoke or grant access'
);

select public.admin_set_my_feature_preview_v1(
  'person_context_graphs_v1', true
);
select ok(
  not (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'globalEnabled')::boolean
  and (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'previewEnabled')::boolean
  and (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'effectiveEnabled')::boolean,
  'self-preview enables only the current administrator without changing global state'
);
select is(
  (public.get_app_feature_flags() ->> 'person_context_graphs_v1')::boolean,
  true,
  'the ordinary feature-flags RPC returns the current account effective value'
);
select is(
  jsonb_typeof(public.list_context_relation_types_v1(
    'fe200000-0000-4000-8000-000000000001'::uuid,
    false
  )),
  'array',
  'the preview administrator can call a protected context RPC'
);

reset role;
select is(
  (select count(*)::integer
   from security_private.app_feature_user_access preview
   where preview.feature_key = 'person_context_graphs_v1'
     and preview.user_id = 'fe100000-0000-4000-8000-000000000001'
     and preview.granted_by = 'fe100000-0000-4000-8000-000000000001'),
  1,
  'the preview grant is owner-specific and records the granting administrator'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fe100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select is(
  (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'effectiveEnabled')::boolean,
  false,
  'one administrator preview never leaks to another account'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1('not-a-valid-token')$$,
  '42501',
  'APP_FEATURE_DISABLED:person_context_graphs_v1',
  'anonymous shared graphs stay closed while the global rollout is off'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  jsonb_typeof(public.list_context_relation_types_v1(
    'fe200000-0000-4000-8000-000000000001'::uuid,
    false
  )),
  'array',
  'service_role maintenance bypass remains available while the rollout is off'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fe100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select public.admin_set_feature_flag('person_context_graphs_v1', true);

select set_config(
  'request.jwt.claims',
  '{"sub":"fe100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select is(
  (public.get_my_app_feature_access_v1('person_context_graphs_v1')
    ->> 'effectiveEnabled')::boolean,
  true,
  'the global switch grants an ordinary authenticated project member access'
);
select is(
  jsonb_typeof(public.list_context_relation_types_v1(
    'fe200000-0000-4000-8000-000000000001'::uuid,
    false
  )),
  'array',
  'the global rollout opens protected context RPCs without weakening project membership'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select throws_ok(
  $$select public.get_shared_context_graph_view_v1('not-a-valid-token')$$,
  'P0002',
  'CONTEXT_GRAPH_SHARE_UNAVAILABLE',
  'after global release anonymous resolution reaches the bearer-token validator'
);

reset role;
select * from finish();
rollback;
