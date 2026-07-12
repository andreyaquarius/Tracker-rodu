begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(36);

select has_function(
  'public',
  'get_family_tree_neighborhood_v1',
  array['jsonb'],
  'the rollback-safe neighborhood v1 RPC still exists'
);
select has_function(
  'public',
  'get_family_tree_neighborhood_v2',
  array['jsonb'],
  'the family-aware neighborhood v2 RPC exists'
);
select has_function(
  'public',
  'get_family_tree_family_children_v1',
  array['jsonb'],
  'the bounded family-children RPC exists'
);
select ok(
  pg_get_functiondef(
    'public.get_family_tree_neighborhood_v2(jsonb)'::regprocedure
  ) not like '%family_tree_parent_set_scope_id_v1(%',
  'v2 does not perform one parent-set helper call per rendered union'
);
select ok(
  pg_get_functiondef(
    'public.get_family_tree_neighborhood_v2(jsonb)'::regprocedure
  ) like '%seed_parent_set_ids%',
  'v2 narrows candidate parent sets from the bounded selected people first'
);
select ok(
  pg_get_functiondef(
    'public.get_family_tree_family_children_v1(jsonb)'::regprocedure
  ) not like '%page.page_order::text%',
  'family relations are ordered by integer page order rather than text'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'family-scope-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'family-scope-outsider@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'b0000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated', 'family-scope-viewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name)
values
  ('b0000000-0000-0000-0000-000000000001', 'family-scope-owner@example.test', 'Family scope owner'),
  ('b0000000-0000-0000-0000-000000000002', 'family-scope-outsider@example.test', 'Family scope outsider'),
  ('b0000000-0000-0000-0000-000000000003', 'family-scope-viewer@example.test', 'Family scope viewer')
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'b1000000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000001',
  'Family-scope contract test'
);

insert into public.project_members (project_id, user_id, role, invited_by)
values
  (
    'b1000000-0000-0000-0000-000000000001',
    'b0000000-0000-0000-0000-000000000001',
    'owner',
    null
  ),
  (
    'b1000000-0000-0000-0000-000000000001',
    'b0000000-0000-0000-0000-000000000003',
    'viewer',
    'b0000000-0000-0000-0000-000000000001'
  )
on conflict (project_id, user_id) do update
set role = excluded.role,
    invited_by = excluded.invited_by;

insert into public.family_trees (
  id, project_id, title, privacy_status, created_by
) values (
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'Exact family scopes',
  'project',
  'b0000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id, project_id, full_name, gender, birth_date, birth_year_from,
  is_living, privacy_status, created_by
)
select
  person_id,
  'b1000000-0000-0000-0000-000000000001',
  display_name,
  gender,
  birth_date,
  coalesce(birth_year, ''),
  false,
  'project',
  'b0000000-0000-0000-0000-000000000001'
from (values
  ('b3000000-0000-0000-0000-000000000001'::uuid, 'Parent A', 'male',   ''::text, null::text),
  ('b3000000-0000-0000-0000-000000000002'::uuid, 'Parent B', 'female', ''::text, null::text),
  ('b3000000-0000-0000-0000-000000000003'::uuid, 'Parent C', 'female', ''::text, null::text),
  ('b3000000-0000-0000-0000-000000000011'::uuid, 'Oldest child', 'female', '1900-01-02', null::text),
  ('b3000000-0000-0000-0000-000000000012'::uuid, 'Year-only child', 'male', '', '1910'),
  ('b3000000-0000-0000-0000-000000000013'::uuid, 'Undated child', 'female', '', null::text),
  ('b3000000-0000-0000-0000-000000000014'::uuid, 'Other-partner child', 'male', '1920-01-01', null::text),
  ('b3000000-0000-0000-0000-000000000015'::uuid, 'Single-parent child one', 'male', '1930', null::text),
  ('b3000000-0000-0000-0000-000000000016'::uuid, 'Single-parent child two', 'female', '1940', null::text),
  ('b3000000-0000-0000-0000-000000000017'::uuid, 'Leaked-group A plus C child', 'female', '1945', null::text)
) fixture(person_id, display_name, gender, birth_date, birth_year);

update public.persons
set is_living = true,
    privacy_status = 'private'
where id = 'b3000000-0000-0000-0000-000000000013';

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
)
select
  'b1000000-0000-0000-0000-000000000001'::uuid,
  'b2000000-0000-0000-0000-000000000001'::uuid,
  person_id,
  case when person_id = 'b3000000-0000-0000-0000-000000000011'::uuid
    then 'root' else 'member' end,
  display_order
from (values
  ('b3000000-0000-0000-0000-000000000001'::uuid, 1),
  ('b3000000-0000-0000-0000-000000000002'::uuid, 2),
  ('b3000000-0000-0000-0000-000000000003'::uuid, 3),
  ('b3000000-0000-0000-0000-000000000011'::uuid, 11),
  ('b3000000-0000-0000-0000-000000000012'::uuid, 12),
  ('b3000000-0000-0000-0000-000000000013'::uuid, 13),
  ('b3000000-0000-0000-0000-000000000014'::uuid, 14),
  ('b3000000-0000-0000-0000-000000000015'::uuid, 15),
  ('b3000000-0000-0000-0000-000000000016'::uuid, 16),
  ('b3000000-0000-0000-0000-000000000017'::uuid, 17)
) members(person_id, display_order);

update public.family_trees
set root_person_id = 'b3000000-0000-0000-0000-000000000011'
where id = 'b2000000-0000-0000-0000-000000000001';

insert into public.family_groups (
  id, project_id, tree_id, group_type, primary_partner_1_id,
  primary_partner_2_id, created_by
) values
  (
    'b4000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001',
    'couple',
    'b3000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000002',
    'b0000000-0000-0000-0000-000000000001'
  ),
  (
    'b4000000-0000-0000-0000-000000000002',
    'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001',
    'couple',
    'b3000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000003',
    'b0000000-0000-0000-0000-000000000001'
  );

insert into public.partner_relationships (
  id, project_id, tree_id, family_group_id, person_a_id, person_b_id,
  relationship_type, status, evidence_status, privacy_status, created_by
) values
  (
    'b7000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000002',
    'marriage', 'active', 'proven', 'project',
    'b0000000-0000-0000-0000-000000000001'
  ),
  (
    'b7000000-0000-0000-0000-000000000002',
    'b1000000-0000-0000-0000-000000000001',
    'b2000000-0000-0000-0000-000000000001',
    'b4000000-0000-0000-0000-000000000002',
    'b3000000-0000-0000-0000-000000000001',
    'b3000000-0000-0000-0000-000000000003',
    'marriage', 'active', 'proven', 'project',
    'b0000000-0000-0000-0000-000000000001'
  );

insert into public.parent_sets (
  id, project_id, tree_id, child_id, family_group_id, set_type,
  is_preferred_for_display, is_default_for_pedigree, display_order, created_by
) values
  ('b5000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000011', 'b4000000-0000-0000-0000-000000000001', 'biological', true, true, 1, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000012', 'b4000000-0000-0000-0000-000000000001', 'biological', true, true, 2, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000012', 'b4000000-0000-0000-0000-000000000001', 'unknown', false, false, 3, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000004', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000013', 'b4000000-0000-0000-0000-000000000001', 'biological', true, true, 4, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000005', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000014', 'b4000000-0000-0000-0000-000000000002', 'biological', true, true, 5, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000006', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000015', null, 'biological', true, true, 6, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000007', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000016', null, 'biological', true, true, 7, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000008', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000017', 'b4000000-0000-0000-0000-000000000001', 'biological', true, true, 8, 'b0000000-0000-0000-0000-000000000001'),
  ('b5000000-0000-0000-0000-000000000010', 'b1000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001', 'b3000000-0000-0000-0000-000000000012', 'b4000000-0000-0000-0000-000000000001', 'unknown', false, false, 10, 'b0000000-0000-0000-0000-000000000001');

insert into public.parent_child_relationships (
  id, project_id, tree_id, parent_id, child_id, parent_set_id,
  family_group_id, relationship_type, parent_role_label, evidence_status,
  privacy_status, created_by
)
select
  relation_id,
  'b1000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  parent_id,
  child_id,
  parent_set_id,
  family_group_id,
  'biological',
  role_label,
  'proven',
  'project',
  'b0000000-0000-0000-0000-000000000001'
from (values
  ('b6000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000011'::uuid, 'b5000000-0000-0000-0000-000000000001'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'father'),
  ('b6000000-0000-0000-0000-000000000002'::uuid, 'b3000000-0000-0000-0000-000000000002'::uuid, 'b3000000-0000-0000-0000-000000000011'::uuid, 'b5000000-0000-0000-0000-000000000001'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'mother'),
  ('b6000000-0000-0000-0000-000000000003'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000012'::uuid, 'b5000000-0000-0000-0000-000000000002'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'father'),
  ('b6000000-0000-0000-0000-000000000004'::uuid, 'b3000000-0000-0000-0000-000000000002'::uuid, 'b3000000-0000-0000-0000-000000000012'::uuid, 'b5000000-0000-0000-0000-000000000002'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'mother'),
  ('b6000000-0000-0000-0000-000000000005'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000012'::uuid, 'b5000000-0000-0000-0000-000000000003'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'father'),
  ('b6000000-0000-0000-0000-000000000006'::uuid, 'b3000000-0000-0000-0000-000000000002'::uuid, 'b3000000-0000-0000-0000-000000000012'::uuid, 'b5000000-0000-0000-0000-000000000003'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'mother'),
  ('b6000000-0000-0000-0000-000000000007'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000013'::uuid, 'b5000000-0000-0000-0000-000000000004'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'father'),
  ('b6000000-0000-0000-0000-000000000008'::uuid, 'b3000000-0000-0000-0000-000000000002'::uuid, 'b3000000-0000-0000-0000-000000000013'::uuid, 'b5000000-0000-0000-0000-000000000004'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'mother'),
  ('b6000000-0000-0000-0000-000000000009'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000014'::uuid, 'b5000000-0000-0000-0000-000000000005'::uuid, 'b4000000-0000-0000-0000-000000000002'::uuid, 'father'),
  ('b6000000-0000-0000-0000-000000000010'::uuid, 'b3000000-0000-0000-0000-000000000003'::uuid, 'b3000000-0000-0000-0000-000000000014'::uuid, 'b5000000-0000-0000-0000-000000000005'::uuid, 'b4000000-0000-0000-0000-000000000002'::uuid, 'mother'),
  ('b6000000-0000-0000-0000-000000000011'::uuid, 'b3000000-0000-0000-0000-000000000003'::uuid, 'b3000000-0000-0000-0000-000000000015'::uuid, 'b5000000-0000-0000-0000-000000000006'::uuid, null::uuid, 'parent'),
  ('b6000000-0000-0000-0000-000000000012'::uuid, 'b3000000-0000-0000-0000-000000000003'::uuid, 'b3000000-0000-0000-0000-000000000016'::uuid, 'b5000000-0000-0000-0000-000000000007'::uuid, null::uuid, 'parent'),
  ('b6000000-0000-0000-0000-000000000013'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000017'::uuid, 'b5000000-0000-0000-0000-000000000008'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'father'),
  ('b6000000-0000-0000-0000-000000000014'::uuid, 'b3000000-0000-0000-0000-000000000003'::uuid, 'b3000000-0000-0000-0000-000000000017'::uuid, 'b5000000-0000-0000-0000-000000000008'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'mother'),
  ('b6000000-0000-0000-0000-000000000015'::uuid, 'b3000000-0000-0000-0000-000000000001'::uuid, 'b3000000-0000-0000-0000-000000000012'::uuid, 'b5000000-0000-0000-0000-000000000010'::uuid, 'b4000000-0000-0000-0000-000000000001'::uuid, 'parent')
) relations(relation_id, parent_id, child_id, parent_set_id, family_group_id, role_label);

-- Deliberately malformed domain data with nine visible parents proves that v2
-- never advertises a family scope which the bounded family RPC would reject.
insert into public.persons (
  id, project_id, full_name, gender, birth_date, is_living,
  privacy_status, created_by
)
select
  format(
    'b3100000-0000-0000-0000-%s',
    lpad(parent_no::text, 12, '0')
  )::uuid,
  'b1000000-0000-0000-0000-000000000001',
  'Oversized parent ' || parent_no,
  'unknown',
  '',
  false,
  'project',
  'b0000000-0000-0000-0000-000000000001'
from generate_series(1, 8) as series(parent_no);

insert into public.persons (
  id, project_id, full_name, gender, birth_date, is_living,
  privacy_status, created_by
) values (
  'b3200000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'Oversized-family child',
  'unknown',
  '1950',
  false,
  'project',
  'b0000000-0000-0000-0000-000000000001'
);

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
)
select
  'b1000000-0000-0000-0000-000000000001'::uuid,
  'b2000000-0000-0000-0000-000000000001'::uuid,
  format(
    'b3100000-0000-0000-0000-%s',
    lpad(parent_no::text, 12, '0')
  )::uuid,
  'member',
  100 + parent_no
from generate_series(1, 8) as series(parent_no)
union all
select
  'b1000000-0000-0000-0000-000000000001'::uuid,
  'b2000000-0000-0000-0000-000000000001'::uuid,
  'b3200000-0000-0000-0000-000000000001'::uuid,
  'member',
  120;

insert into public.family_groups (
  id, project_id, tree_id, group_type, primary_partner_1_id,
  primary_partner_2_id, created_by
) values (
  'b4000000-0000-0000-0000-000000000009',
  'b1000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'other',
  'b3000000-0000-0000-0000-000000000001',
  'b3100000-0000-0000-0000-000000000001',
  'b0000000-0000-0000-0000-000000000001'
);

insert into public.parent_sets (
  id, project_id, tree_id, child_id, family_group_id, set_type,
  is_preferred_for_display, is_default_for_pedigree, display_order, created_by
) values (
  'b5000000-0000-0000-0000-000000000009',
  'b1000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'b3200000-0000-0000-0000-000000000001',
  'b4000000-0000-0000-0000-000000000009',
  'other',
  true,
  true,
  9,
  'b0000000-0000-0000-0000-000000000001'
);

insert into public.parent_child_relationships (
  id, project_id, tree_id, parent_id, child_id, parent_set_id,
  family_group_id, relationship_type, parent_role_label, evidence_status,
  privacy_status, created_by
)
select
  format(
    'b6100000-0000-0000-0000-%s',
    lpad((parent_no + 1)::text, 12, '0')
  )::uuid,
  'b1000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  case
    when parent_no = 0
      then 'b3000000-0000-0000-0000-000000000001'::uuid
    else format(
      'b3100000-0000-0000-0000-%s',
      lpad(parent_no::text, 12, '0')
    )::uuid
  end,
  'b3200000-0000-0000-0000-000000000001',
  'b5000000-0000-0000-0000-000000000009',
  'b4000000-0000-0000-0000-000000000009',
  'other',
  'parent',
  'proven',
  'project',
  'b0000000-0000-0000-0000-000000000001'
from generate_series(0, 8) as series(parent_no);

select set_config(
  'request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.family_tree_parent_set_scope_id_v1(
    'b2000000-0000-0000-0000-000000000001',
    'b5000000-0000-0000-0000-000000000001'
  ),
  'family-group:b4000000-0000-0000-0000-000000000001',
  'a persisted family group wins over a derived parent signature'
);
select isnt(
  public.family_tree_parent_set_scope_id_v1(
    'b2000000-0000-0000-0000-000000000001',
    'b5000000-0000-0000-0000-000000000006'
  ),
  public.family_tree_parent_set_scope_id_v1(
    'b2000000-0000-0000-0000-000000000001',
    'b5000000-0000-0000-0000-000000000007'
  ),
  'ambiguous single-parent sets never collapse into one family scope'
);
select is(
  public.family_tree_parent_set_scope_id_v1(
    'b2000000-0000-0000-0000-000000000001',
    'b5000000-0000-0000-0000-000000000010'
  ),
  'family-group:b4000000-0000-0000-0000-000000000001',
  'a one-parent child set remains inside its canonical two-parent family'
);
select is(
  public.family_tree_parent_set_scope_id_v1(
    'b2000000-0000-0000-0000-000000000001',
    'b5000000-0000-0000-0000-000000000008'
  ),
  'parents:b3000000-0000-0000-0000-000000000001,b3000000-0000-0000-0000-000000000003',
  'a leaked A plus C parent set falls back from the A plus B family group to its exact parent scope'
);

create temporary table family_scope_results (
  result_kind text primary key,
  payload jsonb not null
) on commit drop;

insert into family_scope_results (result_kind, payload)
values (
  'initial',
  public.get_family_tree_neighborhood_v2(jsonb_build_object(
    'treeId', 'b2000000-0000-0000-0000-000000000001',
    'focusPersonId', 'b3000000-0000-0000-0000-000000000011',
    'ancestorDepth', 1,
    'descendantDepth', 0,
    'collateralDepth', 0,
    'maxNodes', 20
  ))
);

select is(
  (
    select count(*)::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'initial'
      and continuation -> 'scope' ->> 'id' =
        'family-group:b4000000-0000-0000-0000-000000000001'
  ),
  1,
  'one couple produces one family continuation even when both parents are visible'
);
select is(
  (
    select (continuation ->> 'hiddenCount')::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'initial'
      and continuation -> 'scope' ->> 'id' =
        'family-group:b4000000-0000-0000-0000-000000000001'
  ),
  2,
  'hidden count uses DISTINCT child_id across duplicate parent sets'
);
select is(
  (
    select count(*)::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'initial'
      and continuation -> 'scope' ->> 'id' =
        'family-group:b4000000-0000-0000-0000-000000000002'
  ),
  1,
  'a genuinely different partner keeps a separate children continuation'
);
select is(
  (
    select count(*)::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'initial'
      and continuation -> 'scope' ->> 'id' =
        'parents:b3000000-0000-0000-0000-000000000001,b3000000-0000-0000-0000-000000000003'
  ),
  1,
  'a reused family-group id exposes the leaked A plus C child as a separate exact-parent scope'
);
select is(
  (
    select count(*)::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'initial'
      and continuation -> 'scope' ->> 'id' =
        'family-group:b4000000-0000-0000-0000-000000000009'
  ),
  0,
  'v2 never emits a greater-than-eight-parent scope rejected by the family RPC'
);
select is(
  (
    select count(*)::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'continuations') continuation
    where result.result_kind = 'initial'
      and continuation ->> 'direction' = 'children'
  ),
  0,
  'v2 removes duplicate legacy per-parent children continuations'
);
select is(
  (
    select union_row ->> 'familyGroupId'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'unions') union_row
    where result.result_kind = 'initial'
      and union_row ->> 'id' = 'parent-set:b5000000-0000-0000-0000-000000000001'
  ),
  'b4000000-0000-0000-0000-000000000001',
  'v2 enriches a parent-set union with the persisted familyGroupId'
);

insert into family_scope_results (result_kind, payload)
select
  'leaked-page',
  public.get_family_tree_family_children_v1(jsonb_build_object(
    'treeId', 'b2000000-0000-0000-0000-000000000001',
    'scope', continuation -> 'scope',
    'cursor', continuation ->> 'token',
    'pageSize', 10,
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'permissionFingerprint', initial.payload ->> 'permissionFingerprint'
  ))
from family_scope_results initial,
  lateral jsonb_array_elements(initial.payload -> 'familyContinuations') continuation
where initial.result_kind = 'initial'
  and continuation -> 'scope' ->> 'id' =
    'parents:b3000000-0000-0000-0000-000000000001,b3000000-0000-0000-0000-000000000003';

select is(
  (
    select person ->> 'id'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'leaked-page'
      and person ->> 'id' not in (
        'b3000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000003'
      )
  ),
  'b3000000-0000-0000-0000-000000000017',
  'the dedicated RPC applies the same derived scope and returns only the leaked A plus C child'
);

insert into family_scope_results (result_kind, payload)
select
  'ordered-page',
  public.get_family_tree_family_children_v1(jsonb_build_object(
    'treeId', 'b2000000-0000-0000-0000-000000000001',
    'scope', continuation -> 'scope',
    'pageSize', 1,
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'permissionFingerprint', initial.payload ->> 'permissionFingerprint'
  ))
from family_scope_results initial,
  lateral jsonb_array_elements(initial.payload -> 'familyContinuations') continuation
where initial.result_kind = 'initial'
  and continuation -> 'scope' ->> 'id' =
    'family-group:b4000000-0000-0000-0000-000000000001';

select is(
  (
    select person ->> 'id'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'ordered-page'
      and person ->> 'id' not in (
        'b3000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000002'
      )
  ),
  'b3000000-0000-0000-0000-000000000011',
  'an unfiltered family page starts with the oldest child'
);

insert into family_scope_results (result_kind, payload)
select
  'page-1',
  public.get_family_tree_family_children_v1(jsonb_build_object(
    'treeId', 'b2000000-0000-0000-0000-000000000001',
    'scope', continuation -> 'scope',
    'cursor', continuation ->> 'token',
    'pageSize', 1,
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'permissionFingerprint', initial.payload ->> 'permissionFingerprint'
  ))
from family_scope_results initial,
  lateral jsonb_array_elements(initial.payload -> 'familyContinuations') continuation
where initial.result_kind = 'initial'
  and continuation -> 'scope' ->> 'id' =
    'family-group:b4000000-0000-0000-0000-000000000001';

select is(
  (
    select person ->> 'id'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'page-1'
      and person ->> 'id' not in (
        'b3000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000002'
      )
  ),
  'b3000000-0000-0000-0000-000000000012',
  'the continuation excludes the already visible oldest child and returns the year-only child'
);
select is(
  (
    select (continuation ->> 'hiddenCount')::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'page-1'
  ),
  1,
  'first page reports one remaining hidden child'
);
select is(
  (
    select payload ->> 'nextCursor'
    from family_scope_results
    where result_kind = 'page-1'
  ),
  (
    select continuation ->> 'token'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'familyContinuations') continuation
    where result.result_kind = 'page-1'
  ),
  'top-level nextCursor matches the mergeable family continuation token'
);
select is(
  (
    select public.family_tree_cursor_decode(payload ->> 'nextCursor')
      ->> 'excludedChildDigest'
    from family_scope_results
    where result_kind = 'page-1'
  ),
  (
    select public.family_tree_cursor_decode(continuation ->> 'token')
      ->> 'excludedChildDigest'
    from family_scope_results initial,
      lateral jsonb_array_elements(initial.payload -> 'familyContinuations') continuation
    where initial.result_kind = 'initial'
      and continuation -> 'scope' ->> 'id' =
        'family-group:b4000000-0000-0000-0000-000000000001'
  ),
  'nextCursor preserves the stable excluded-child digest across pages'
);

insert into family_scope_results (result_kind, payload)
select
  'page-2',
  public.get_family_tree_family_children_v1(jsonb_build_object(
    'treeId', 'b2000000-0000-0000-0000-000000000001',
    'scope', page.payload -> 'scope',
    'cursor', continuation ->> 'token',
    'pageSize', 1,
    'knownGraphVersion', page.payload ->> 'graphVersion',
    'permissionFingerprint', page.payload ->> 'permissionFingerprint'
  ))
from family_scope_results page,
  lateral jsonb_array_elements(page.payload -> 'familyContinuations') continuation
where page.result_kind = 'page-1';

select is(
  (
    select person ->> 'id'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'page-2'
      and person ->> 'id' not in (
        'b3000000-0000-0000-0000-000000000001',
        'b3000000-0000-0000-0000-000000000002'
      )
  ),
  'b3000000-0000-0000-0000-000000000013',
  'a child without a date or year is sorted last'
);
select is(
  (
    select jsonb_array_length(payload -> 'familyContinuations')
    from family_scope_results
    where result_kind = 'page-2'
  ),
  0,
  'the final page authoritatively clears the family continuation'
);
select ok(
  (
    select not (payload ? 'nextCursor')
    from family_scope_results
    where result_kind = 'page-2'
  ),
  'the final family page omits top-level nextCursor'
);
select is(
  (
    select count(*)::integer
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind like 'page-%'
      and person ->> 'id' in (
        'b3000000-0000-0000-0000-000000000014',
        'b3000000-0000-0000-0000-000000000017'
      )
  ),
  0,
  'exact family filtering never includes a child from another partner'
);

select throws_ok(
  $$
    select public.get_family_tree_family_children_v1(
      '{
        "treeId":"b2000000-0000-0000-0000-000000000001",
        "scope":{
          "id":"parents:b3000000-0000-0000-0000-000000000001,b3000000-0000-0000-0000-000000000002",
          "parentIds":["b3000000-0000-0000-0000-000000000002","b3000000-0000-0000-0000-000000000001"]
        }
      }'::jsonb
    )
  $$,
  '42501',
  'FAMILY_SCOPE_NOT_FOUND_OR_FORBIDDEN',
  'a derived signature cannot alias a persisted family-group scope'
);

select throws_ok(
  $$
    select public.get_family_tree_family_children_v1(
      '{
        "treeId":"b2000000-0000-0000-0000-000000000001",
        "scope":{
          "id":"family-group:b4000000-0000-0000-0000-000000000001",
          "parentIds":["b3000000-0000-0000-0000-000000000001","b3000000-0000-0000-0000-000000000002"],
          "familyGroupId":"b4000000-0000-0000-0000-000000000001"
        },
        "cursor":"not-a-valid-family-cursor"
      }'::jsonb
    )
  $$,
  '22023',
  'INVALID_OR_STALE_FAMILY_CURSOR',
  'a malformed family cursor is rejected before graph traversal'
);

select throws_ok(
  format(
    'select public.get_family_tree_family_children_v1(%L::jsonb)',
    jsonb_build_object(
      'treeId', 'b2000000-0000-0000-0000-000000000001',
      'scope', jsonb_build_object(
        'id', 'family-group:b4000000-0000-0000-0000-000000000001',
        'parentIds', jsonb_build_array(
          'b3000000-0000-0000-0000-000000000001',
          'b3000000-0000-0000-0000-000000000002'
        ),
        'familyGroupId', 'b4000000-0000-0000-0000-000000000001'
      ),
      'cursor', public.family_tree_cursor_encode(jsonb_build_object(
        'version', 1,
        'kind', 'family-children',
        'treeId', 'b2000000-0000-0000-0000-000000000001',
        'familyScopeId', 'family-group:b4000000-0000-0000-0000-000000000001',
        'graphVersion', initial.payload ->> 'graphVersion',
        'permissionFingerprint', initial.payload ->> 'permissionFingerprint',
        'birthMissing', null,
        'birthSort', '',
        'childId', '00000000-0000-0000-0000-000000000000'
      ))
    )::text
  ),
  '22023',
  'INVALID_OR_STALE_FAMILY_CURSOR',
  'a JSON null birthMissing cursor is rejected rather than returning an empty page'
)
from family_scope_results initial
where initial.result_kind = 'initial';

select throws_ok(
  format(
    'select public.get_family_tree_family_children_v1(%L::jsonb)',
    jsonb_build_object(
      'treeId', 'b2000000-0000-0000-0000-000000000001',
      'scope', jsonb_build_object(
        'id', 'family-group:b4000000-0000-0000-0000-000000000001',
        'parentIds', jsonb_build_array(
          'b3000000-0000-0000-0000-000000000001',
          'b3000000-0000-0000-0000-000000000002'
        ),
        'familyGroupId', 'b4000000-0000-0000-0000-000000000001'
      ),
      'cursor', public.family_tree_cursor_encode(jsonb_build_object(
        'version', 1,
        'kind', 'family-children',
        'treeId', 'b2000000-0000-0000-0000-000000000001',
        'familyScopeId', 'family-group:b4000000-0000-0000-0000-000000000001',
        'graphVersion', initial.payload ->> 'graphVersion',
        'permissionFingerprint', initial.payload ->> 'permissionFingerprint',
        'birthMissing', false,
        'birthSort', jsonb_build_object('invalid', true),
        'childId', '00000000-0000-0000-0000-000000000000'
      ))
    )::text
  ),
  '22023',
  'INVALID_OR_STALE_FAMILY_CURSOR',
  'a non-string birthSort cursor is rejected'
)
from family_scope_results initial
where initial.result_kind = 'initial';

select throws_ok(
  format(
    'select public.get_family_tree_family_children_v1(%L::jsonb)',
    jsonb_build_object(
      'treeId', 'b2000000-0000-0000-0000-000000000001',
      'scope', jsonb_build_object(
        'id', 'family-group:b4000000-0000-0000-0000-000000000001',
        'parentIds', jsonb_build_array(
          'b3000000-0000-0000-0000-000000000001',
          'b3000000-0000-0000-0000-000000000002'
        ),
        'familyGroupId', 'b4000000-0000-0000-0000-000000000001'
      ),
      'cursor', public.family_tree_cursor_encode(jsonb_build_object(
        'version', 1,
        'kind', 'family-children',
        'treeId', 'b2000000-0000-0000-0000-000000000001',
        'familyScopeId', 'family-group:b4000000-0000-0000-0000-000000000001',
        'graphVersion', initial.payload ->> 'graphVersion',
        'permissionFingerprint', initial.payload ->> 'permissionFingerprint',
        'birthMissing', false,
        'birthSort', '',
        'childId', '00000000-0000-0000-0000-000000000000',
        'excludedChildIds', jsonb_build_array(
          'b3000000-0000-0000-0000-000000000011'
        ),
        'excludedChildDigest', 'not-the-server-digest'
      ))
    )::text
  ),
  '22023',
  'INVALID_OR_STALE_FAMILY_CURSOR',
  'an excluded-child set with the wrong digest is rejected'
)
from family_scope_results initial
where initial.result_kind = 'initial';

select throws_ok(
  $$
    select public.get_family_tree_family_children_v1(
      '{
        "treeId":"b2000000-0000-0000-0000-000000000001",
        "scope":{
          "id":"family-group:b4000000-0000-0000-0000-000000000001",
          "parentIds":["b3000000-0000-0000-0000-000000000001","b3000000-0000-0000-0000-000000000002"],
          "familyGroupId":"b4000000-0000-0000-0000-000000000001"
        },
        "knownGraphVersion":"0"
      }'::jsonb
    )
  $$,
  '40001',
  'TREE_GRAPH_VERSION_CHANGED',
  'family pagination refuses a stale known graph version'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);

insert into family_scope_results (result_kind, payload)
values (
  'viewer-page',
  public.get_family_tree_family_children_v1(
    '{
      "treeId":"b2000000-0000-0000-0000-000000000001",
      "scope":{
        "id":"family-group:b4000000-0000-0000-0000-000000000001",
        "parentIds":["b3000000-0000-0000-0000-000000000001","b3000000-0000-0000-0000-000000000002"],
        "familyGroupId":"b4000000-0000-0000-0000-000000000001"
      },
      "pageSize":3
    }'::jsonb
  )
);

select is(
  (
    select person ->> 'displayName'
    from family_scope_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'viewer-page'
      and person ->> 'id' = 'b3000000-0000-0000-0000-000000000013'
  ),
  'Приватна особа',
  'family pages mask a private living child for a viewer'
);
select ok(
  (
    select payload::text not like '%Undated child%'
    from family_scope_results
    where result_kind = 'viewer-page'
  ),
  'exact private living fields never enter the family-page payload'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"b0000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    select public.get_family_tree_family_children_v1(
      '{
        "treeId":"b2000000-0000-0000-0000-000000000001",
        "scope":{
          "id":"family-group:b4000000-0000-0000-0000-000000000001",
          "parentIds":["b3000000-0000-0000-0000-000000000001","b3000000-0000-0000-0000-000000000002"],
          "familyGroupId":"b4000000-0000-0000-0000-000000000001"
        }
      }'::jsonb
    )
  $$,
  '42501',
  'TREE_NOT_FOUND_OR_FORBIDDEN',
  'an outsider cannot enumerate an exact family scope'
);

select * from finish();
rollback;
