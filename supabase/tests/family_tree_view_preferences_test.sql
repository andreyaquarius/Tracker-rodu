begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(21);

select has_table(
  'public',
  'family_tree_view_preferences',
  'private family tree view preferences have a dedicated table'
);

select hasnt_column(
  'public',
  'family_tree_view_preferences',
  'project_id',
  'the view preference row derives project membership through its tree'
);

select has_column(
  'public',
  'family_tree_view_preferences',
  'view_settings',
  'the dedicated table stores normalized view settings'
);

select ok(
  (
    select column_row.is_nullable = 'NO'
      and column_row.column_default = '''{}''::jsonb'
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'family_tree_view_preferences'
      and column_row.column_name = 'view_settings'
  )
  and exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.family_tree_view_preferences'::regclass
      and constraint_row.contype = 'c'
      and position(
        'jsonb_typeof(view_settings)'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
      and position(
        'object'
        in pg_get_constraintdef(constraint_row.oid)
      ) > 0
  ),
  'view settings are a required JSON object with an empty-object default'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.family_tree_view_preferences'::regclass
      and constraint_row.contype = 'p'
      and pg_get_constraintdef(constraint_row.oid) =
        'PRIMARY KEY (user_id, tree_id)'
  ),
  'one user has one private view preference row per tree'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'fa100000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'tree-view-owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fa100000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'tree-view-member@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'fa100000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'tree-view-outsider@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.projects (id, owner_id, name) values (
  'fa200000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001',
  'Private family tree view preferences'
);

insert into public.project_members (
  project_id,
  user_id,
  role,
  invited_by
) values (
  'fa200000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000002',
  'viewer',
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.family_trees (
  id,
  project_id,
  title,
  privacy_status,
  created_by
) values (
  'fa300000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Shared family tree',
  'project',
  'fa100000-0000-4000-8000-000000000001'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.family_tree_user_preferences (
  user_id,
  project_id,
  tree_id,
  appearance
) values (
  'fa100000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  '{"theme":"owner-original"}'::jsonb
);

insert into public.family_tree_view_preferences (
  user_id,
  tree_id,
  view_settings
) values (
  'fa100000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  '{
    "ancestorDepth":9,
    "descendantDepth":4,
    "collateralDepth":1,
    "showAllParentSets":true,
    "activeParentSetByChild":{"owner-child":"owner-parent-set"}
  }'::jsonb
);

select is(
  (select count(*) from public.family_tree_view_preferences),
  1::bigint,
  'the owner sees exactly their own view preference row'
);

select ok(
  (select view_settings ->> 'ancestorDepth'
   from public.family_tree_view_preferences) = '9'
  and (select view_settings ->> 'descendantDepth'
       from public.family_tree_view_preferences) = '4'
  and (select view_settings #>> '{activeParentSetByChild,owner-child}'
       from public.family_tree_view_preferences) = 'owner-parent-set',
  'the owner view settings round-trip through the private row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_tree_view_preferences),
  0::bigint,
  'a second project member cannot see the owner view preference row'
);

insert into public.family_tree_user_preferences (
  user_id,
  project_id,
  tree_id,
  appearance
) values (
  'fa100000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  '{"theme":"member-original"}'::jsonb
);

insert into public.family_tree_view_preferences (
  user_id,
  tree_id,
  view_settings
) values (
  'fa100000-0000-4000-8000-000000000002',
  'fa300000-0000-4000-8000-000000000001',
  '{
    "ancestorDepth":6,
    "descendantDepth":2,
    "collateralDepth":0,
    "showAllParentSets":false,
    "activeParentSetByChild":{"member-child":"member-parent-set"}
  }'::jsonb
);

select is(
  (select count(*) from public.family_tree_view_preferences),
  1::bigint,
  'the second member sees exactly their own view preference row'
);

select ok(
  (select user_id from public.family_tree_view_preferences) =
    'fa100000-0000-4000-8000-000000000002'::uuid
  and (select view_settings ->> 'ancestorDepth'
       from public.family_tree_view_preferences) = '6'
  and (select view_settings #>> '{activeParentSetByChild,member-child}'
       from public.family_tree_view_preferences) = 'member-parent-set',
  'members of one shared tree retain different view settings'
);

select is(
  (
    select count(*)
    from public.family_tree_view_preferences
    where user_id = 'fa100000-0000-4000-8000-000000000001'
  ),
  0::bigint,
  'the member cannot query the owner row even by its user id'
);

update public.family_tree_view_preferences
set view_settings = '{
  "ancestorDepth":11,
  "descendantDepth":5,
  "collateralDepth":1,
  "showAllParentSets":true,
  "activeParentSetByChild":{"member-child":"member-parent-set-updated"}
}'::jsonb
where user_id = 'fa100000-0000-4000-8000-000000000002';

select is(
  (
    select appearance ->> 'theme'
    from public.family_tree_user_preferences
    where user_id = 'fa100000-0000-4000-8000-000000000002'
  ),
  'member-original',
  'updating the dedicated view row does not change appearance'
);

update public.family_tree_user_preferences
set appearance = '{"theme":"member-updated"}'::jsonb
where user_id = 'fa100000-0000-4000-8000-000000000002';

select ok(
  (select view_settings ->> 'ancestorDepth'
   from public.family_tree_view_preferences) = '11'
  and (select view_settings ->> 'descendantDepth'
       from public.family_tree_view_preferences) = '5'
  and (select view_settings #>> '{activeParentSetByChild,member-child}'
       from public.family_tree_view_preferences) =
        'member-parent-set-updated',
  'updating appearance does not change the dedicated view row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_tree_view_preferences),
  1::bigint,
  'switching back restores the owner-only RLS view'
);

select ok(
  (select appearance ->> 'theme'
   from public.family_tree_user_preferences) = 'owner-original'
  and (select view_settings ->> 'ancestorDepth'
       from public.family_tree_view_preferences) = '9'
  and (select view_settings #>> '{activeParentSetByChild,owner-child}'
       from public.family_tree_view_preferences) = 'owner-parent-set',
  'the second member updates never overwrite the owner preferences'
);

select is(
  (
    select count(*)
    from public.family_tree_view_preferences
    where user_id = 'fa100000-0000-4000-8000-000000000002'
  ),
  0::bigint,
  'the owner cannot query the second member view row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.family_tree_view_preferences),
  0::bigint,
  'an outsider cannot read view preferences for the shared tree'
);

select throws_ok(
  $$
    insert into public.family_tree_view_preferences (
      user_id,
      tree_id,
      view_settings
    ) values (
      'fa100000-0000-4000-8000-000000000003',
      'fa300000-0000-4000-8000-000000000001',
      '{"ancestorDepth":100}'::jsonb
    )
  $$,
  '42501',
  'new row violates row-level security policy for table "family_tree_view_preferences"',
  'an outsider cannot write view preferences for a project tree'
);

reset role;

select is(
  (select count(*) from public.family_tree_view_preferences),
  2::bigint,
  'the database stores one independent view row per user for the same tree'
);

select ok(
  (
    select count(distinct view_settings ->> 'ancestorDepth')
    from public.family_tree_view_preferences
    where tree_id = 'fa300000-0000-4000-8000-000000000001'
  ) = 2,
  'the two persisted rows keep distinct view settings'
);

select is(
  (
    select count(*)
    from public.family_tree_user_preferences
    where tree_id = 'fa300000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'view persistence does not create or replace appearance preference rows'
);

select * from finish();
rollback;
