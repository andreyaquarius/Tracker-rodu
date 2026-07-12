begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(7);

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
) values (
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'family-tree-initial-scope@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'a0000000-0000-0000-0000-000000000001',
  'family-tree-initial-scope@example.test',
  'Family tree initial scope owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'a1000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'Family tree initial scope test'
);

insert into public.project_members (project_id, user_id, role, invited_by)
values (
  'a1000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'owner',
  null
)
on conflict (project_id, user_id) do update set role = excluded.role;

insert into public.family_trees (
  id,
  project_id,
  title,
  privacy_status,
  created_by
) values (
  'a2000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'Direct ancestors by default',
  'project',
  'a0000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id,
  project_id,
  full_name,
  is_living,
  privacy_status,
  created_by
)
select
  person_id,
  'a1000000-0000-0000-0000-000000000001',
  display_name,
  false,
  'project',
  'a0000000-0000-0000-0000-000000000001'
from (values
  ('a3000000-0000-0000-0000-000000000001'::uuid, 'Focus'),
  ('a3000000-0000-0000-0000-000000000002'::uuid, 'Direct parent'),
  ('a3000000-0000-0000-0000-000000000003'::uuid, 'Direct grandparent'),
  ('a3000000-0000-0000-0000-000000000004'::uuid, 'Descendant'),
  ('a3000000-0000-0000-0000-000000000005'::uuid, 'Side sibling'),
  ('a3000000-0000-0000-0000-000000000006'::uuid, 'Ancestor extra partner')
) people(person_id, display_name);

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role,
  display_order
)
select
  'a1000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  person_id,
  case
    when person_id = 'a3000000-0000-0000-0000-000000000001'::uuid
      then 'root'
    else 'member'
  end,
  display_order
from (values
  ('a3000000-0000-0000-0000-000000000001'::uuid, 1),
  ('a3000000-0000-0000-0000-000000000002'::uuid, 2),
  ('a3000000-0000-0000-0000-000000000003'::uuid, 3),
  ('a3000000-0000-0000-0000-000000000004'::uuid, 4),
  ('a3000000-0000-0000-0000-000000000005'::uuid, 5),
  ('a3000000-0000-0000-0000-000000000006'::uuid, 6)
) members(person_id, display_order);

update public.family_trees
set root_person_id = 'a3000000-0000-0000-0000-000000000001'
where id = 'a2000000-0000-0000-0000-000000000001';

insert into public.parent_sets (
  id,
  project_id,
  tree_id,
  child_id,
  set_type,
  display_order,
  created_by
) values
  (
    'a4000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001',
    'biological',
    1,
    'a0000000-0000-0000-0000-000000000001'
  ),
  (
    'a4000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000002',
    'biological',
    2,
    'a0000000-0000-0000-0000-000000000001'
  ),
  (
    'a4000000-0000-0000-0000-000000000003',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000004',
    'biological',
    3,
    'a0000000-0000-0000-0000-000000000001'
  ),
  (
    'a4000000-0000-0000-0000-000000000004',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000005',
    'biological',
    4,
    'a0000000-0000-0000-0000-000000000001'
  );

insert into public.parent_child_relationships (
  id,
  project_id,
  tree_id,
  parent_id,
  child_id,
  parent_set_id,
  relationship_type,
  parent_role_label,
  evidence_status,
  privacy_status,
  created_by
) values
  (
    'a5000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000002',
    'a3000000-0000-0000-0000-000000000001',
    'a4000000-0000-0000-0000-000000000001',
    'biological',
    'parent',
    'proven',
    'project',
    'a0000000-0000-0000-0000-000000000001'
  ),
  (
    'a5000000-0000-0000-0000-000000000002',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000003',
    'a3000000-0000-0000-0000-000000000002',
    'a4000000-0000-0000-0000-000000000002',
    'biological',
    'parent',
    'proven',
    'project',
    'a0000000-0000-0000-0000-000000000001'
  ),
  (
    'a5000000-0000-0000-0000-000000000003',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000004',
    'a4000000-0000-0000-0000-000000000003',
    'biological',
    'parent',
    'proven',
    'project',
    'a0000000-0000-0000-0000-000000000001'
  ),
  (
    'a5000000-0000-0000-0000-000000000004',
    'a1000000-0000-0000-0000-000000000001',
    'a2000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000002',
    'a3000000-0000-0000-0000-000000000005',
    'a4000000-0000-0000-0000-000000000004',
    'biological',
    'parent',
    'proven',
    'project',
    'a0000000-0000-0000-0000-000000000001'
  );

insert into public.partner_relationships (
  id,
  project_id,
  tree_id,
  person_a_id,
  person_b_id,
  relationship_type,
  status,
  evidence_status,
  privacy_status,
  created_by
) values (
  'a6000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000001',
  'a2000000-0000-0000-0000-000000000001',
  'a3000000-0000-0000-0000-000000000002',
  'a3000000-0000-0000-0000-000000000006',
  'marriage',
  'active',
  'proven',
  'project',
  'a0000000-0000-0000-0000-000000000001'
);

create temporary table family_tree_initial_scope_results (
  result_kind text primary key,
  payload jsonb not null
) on commit drop;

select set_config(
  'request.jwt.claims',
  '{"sub":"a0000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

insert into family_tree_initial_scope_results (result_kind, payload)
values (
  'initial',
  public.get_family_tree_neighborhood_v1(
    '{
      "treeId":"a2000000-0000-0000-0000-000000000001",
      "focusPersonId":"a3000000-0000-0000-0000-000000000001",
      "maxNodes":50
    }'::jsonb
  )
);

select is(
  (
    select string_agg(person ->> 'id', ',' order by person ->> 'id')
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'initial'
  ),
  concat_ws(',',
    'a3000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000002',
    'a3000000-0000-0000-0000-000000000003'
  ),
  'omitted depths return only the focus and its direct ancestor chain'
);

select ok(
  exists (
    select 1
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'continuations') continuation
    where result.result_kind = 'initial'
      and continuation ->> 'personId' = 'a3000000-0000-0000-0000-000000000001'
      and continuation ->> 'direction' = 'children'
  ),
  'omitted descendants remain available through a focus children continuation'
);

select ok(
  exists (
    select 1
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'continuations') continuation
    where result.result_kind = 'initial'
      and continuation ->> 'personId' = 'a3000000-0000-0000-0000-000000000001'
      and continuation ->> 'direction' = 'siblings'
  ),
  'omitted side relatives remain available through a focus siblings continuation'
);

select ok(
  exists (
    select 1
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'continuations') continuation
    where result.result_kind = 'initial'
      and continuation ->> 'personId' = 'a3000000-0000-0000-0000-000000000002'
      and continuation ->> 'direction' = 'partners'
  ),
  'an ancestor extra partner remains available through a partner continuation'
);

insert into family_tree_initial_scope_results (result_kind, payload)
select
  'partner-branch',
  public.get_family_tree_neighborhood_v1(jsonb_build_object(
    'treeId', 'a2000000-0000-0000-0000-000000000001',
    'focusPersonId', 'a3000000-0000-0000-0000-000000000001',
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'maxNodes', 50,
    'branches', jsonb_build_array(jsonb_build_object(
      'personId', 'a3000000-0000-0000-0000-000000000002',
      'directions', jsonb_build_array('partners'),
      'cursors', jsonb_build_object('partners', continuation ->> 'token')
    ))
  ))
from family_tree_initial_scope_results initial,
  lateral jsonb_array_elements(initial.payload -> 'continuations') continuation
where initial.result_kind = 'initial'
  and continuation ->> 'personId' = 'a3000000-0000-0000-0000-000000000002'
  and continuation ->> 'direction' = 'partners';

insert into family_tree_initial_scope_results (result_kind, payload)
select
  'children-branch',
  public.get_family_tree_neighborhood_v1(jsonb_build_object(
    'treeId', 'a2000000-0000-0000-0000-000000000001',
    'focusPersonId', 'a3000000-0000-0000-0000-000000000001',
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'maxNodes', 50,
    'branches', jsonb_build_array(jsonb_build_object(
      'personId', 'a3000000-0000-0000-0000-000000000001',
      'directions', jsonb_build_array('children'),
      'cursors', jsonb_build_object('children', continuation ->> 'token')
    ))
  ))
from family_tree_initial_scope_results initial,
  lateral jsonb_array_elements(initial.payload -> 'continuations') continuation
where initial.result_kind = 'initial'
  and continuation ->> 'personId' = 'a3000000-0000-0000-0000-000000000001'
  and continuation ->> 'direction' = 'children';

insert into family_tree_initial_scope_results (result_kind, payload)
select
  'siblings-branch',
  public.get_family_tree_neighborhood_v1(jsonb_build_object(
    'treeId', 'a2000000-0000-0000-0000-000000000001',
    'focusPersonId', 'a3000000-0000-0000-0000-000000000001',
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'maxNodes', 50,
    'branches', jsonb_build_array(jsonb_build_object(
      'personId', 'a3000000-0000-0000-0000-000000000001',
      'directions', jsonb_build_array('siblings'),
      'cursors', jsonb_build_object('siblings', continuation ->> 'token')
    ))
  ))
from family_tree_initial_scope_results initial,
  lateral jsonb_array_elements(initial.payload -> 'continuations') continuation
where initial.result_kind = 'initial'
  and continuation ->> 'personId' = 'a3000000-0000-0000-0000-000000000001'
  and continuation ->> 'direction' = 'siblings';

select is(
  (
    select string_agg(person ->> 'id', ',' order by person ->> 'id')
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'partner-branch'
  ),
  concat_ws(',',
    'a3000000-0000-0000-0000-000000000002',
    'a3000000-0000-0000-0000-000000000006'
  ),
  'partner branch loads only its anchor and the requested extra partner'
);

select is(
  (
    select string_agg(person ->> 'id', ',' order by person ->> 'id')
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'children-branch'
  ),
  concat_ws(',',
    'a3000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000004'
  ),
  'children branch loads only its anchor and the requested descendant'
);

select is(
  (
    select string_agg(person ->> 'id', ',' order by person ->> 'id')
    from family_tree_initial_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'siblings-branch'
  ),
  concat_ws(',',
    'a3000000-0000-0000-0000-000000000001',
    'a3000000-0000-0000-0000-000000000002',
    'a3000000-0000-0000-0000-000000000005'
  ),
  'siblings branch loads the requested sibling plus its required parent connector'
);

select * from finish();
rollback;
