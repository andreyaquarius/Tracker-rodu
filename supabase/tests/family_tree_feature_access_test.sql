begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

select has_table(
  'public',
  'family_tree_feature_access',
  'the private family-tree allow-list exists'
);
select has_function(
  'public',
  'can_use_family_tree_feature',
  array[]::text[],
  'the server-side entitlement helper exists'
);
select has_function(
  'public',
  'get_my_family_tree_feature_access',
  array[]::text[],
  'an account can read its own entitlement'
);
select has_function(
  'public',
  'admin_set_family_tree_feature_access',
  array['uuid', 'boolean'],
  'an administrator can manage testers through an RPC'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_my_family_tree_feature_access()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_my_family_tree_feature_access()',
    'EXECUTE'
  ),
  'the entitlement endpoint is authenticated-only'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'fa000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'tree-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fa000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'tree-tester@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now()
  );

insert into public.profiles (user_id, email, display_name)
values
  (
    'fa000000-0000-0000-0000-000000000001',
    'tree-owner@example.test',
    'Tree owner'
  ),
  (
    'fa000000-0000-0000-0000-000000000002',
    'tree-tester@example.test',
    'Tree tester'
  )
on conflict (user_id) do update set email = excluded.email;

insert into public.app_admins (user_id, granted_by)
values (
  'fa000000-0000-0000-0000-000000000001',
  'fa000000-0000-0000-0000-000000000001'
)
on conflict (user_id) do nothing;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select is(
  public.get_my_family_tree_feature_access(),
  true,
  'the app administrator always has family-tree access'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.get_my_family_tree_feature_access(),
  false,
  'a registered user is denied before being invited'
);

select throws_ok(
  $$select public.admin_set_family_tree_feature_access(
    'fa000000-0000-0000-0000-000000000002'::uuid,
    true
  )$$,
  '42501',
  'APP_ADMIN_REQUIRED',
  'a non-admin cannot grant itself access'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select public.admin_set_family_tree_feature_access(
  'fa000000-0000-0000-0000-000000000002'::uuid,
  true
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.get_my_family_tree_feature_access(),
  true,
  'an invited tester receives access'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
select ok(
  exists (
    select 1
    from public.admin_list_family_tree_feature_access() access
    where access.user_id = 'fa000000-0000-0000-0000-000000000002'::uuid
      and access.is_enabled
      and not access.is_admin
  ),
  'the admin list shows the enabled tester'
);
select public.admin_set_family_tree_feature_access(
  'fa000000-0000-0000-0000-000000000002'::uuid,
  false
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select is(
  public.get_my_family_tree_feature_access(),
  false,
  'revoking the tester takes effect immediately'
);

reset role;
select ok(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and policyname = 'family_tree_feature_entitlement'
      and permissive = 'RESTRICTIVE'
  ) >= 16,
  'all family-tree projection tables have a restrictive entitlement policy'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_family_tree_neighborhood_v1_feature_impl(jsonb)',
    'EXECUTE'
  ),
  'authenticated users cannot bypass the gated neighborhood wrapper'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.get_family_tree_neighborhood_v1(jsonb)',
    'EXECUTE'
  ),
  'authenticated users call the entitlement-checking neighborhood wrapper'
);

select * from finish();
rollback;
