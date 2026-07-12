begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(26);

-- Stable fixture identifiers make failures readable and keep cursor assertions
-- deterministic across local and CI database resets.
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
)
select
  '00000000-0000-0000-0000-000000000000'::uuid,
  user_id,
  'authenticated',
  'authenticated',
  email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
from (values
  ('10000000-0000-0000-0000-000000000001'::uuid, 'tree-owner@example.test'),
  ('10000000-0000-0000-0000-000000000002'::uuid, 'tree-editor@example.test'),
  ('10000000-0000-0000-0000-000000000003'::uuid, 'tree-viewer@example.test'),
  ('10000000-0000-0000-0000-000000000004'::uuid, 'tree-outsider@example.test')
) as fixture(user_id, email);

insert into public.profiles (user_id, email, display_name)
select id, email, split_part(email, '@', 1)
from auth.users
where id::text like '10000000-0000-0000-0000-00000000000%'
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Family tree RPC test'
);

insert into public.project_members (project_id, user_id, role, invited_by)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner', null),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'editor', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', 'viewer', '10000000-0000-0000-0000-000000000001')
on conflict (project_id, user_id) do update set role = excluded.role;

insert into public.family_trees (
  id, project_id, title, privacy_status, created_by
) values (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'Privacy and pagination tree',
  'project',
  '10000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id, project_id, full_name, given_name, surname, gender, birth_date,
  is_living, privacy_status, created_by
) values
  (
    '40000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'Публічний корінь', 'Публічний', 'Корінь', 'male', '1900-01-01',
    false, 'project', '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    'Секретне Ім’я', 'Секретне', 'Ім’я', 'female', '1990-02-03',
    true, 'private', '10000000-0000-0000-0000-000000000001'
  ),
  (
    '40000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000001',
    'Публічна дитина', 'Публічна', 'Дитина', 'female', '1930',
    false, 'project', '10000000-0000-0000-0000-000000000001'
  );

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
) values
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'root', 0),
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'member', 1),
  ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 'member', 2);

update public.family_trees
set root_person_id = '40000000-0000-0000-0000-000000000001'
where id = '30000000-0000-0000-0000-000000000001';

-- primary_partner_2_id is deliberately present even if membership data were
-- incomplete; the exact family-group policy must still hide this row.
insert into public.family_groups (
  id, project_id, tree_id, group_type, display_label,
  primary_partner_1_id, primary_partner_2_id, created_by
) values (
  '50000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'couple',
  'Private partnership label',
  '40000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001'
);

insert into public.family_group_members (
  project_id, family_group_id, person_id, member_role, display_order
) values
  ('20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'partner', 0),
  ('20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', 'partner', 1);

insert into public.partner_relationships (
  id, project_id, tree_id, family_group_id, person_a_id, person_b_id,
  relationship_type, status, start_date, evidence_status, privacy_status,
  created_by
) values (
  '60000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000002',
  'marriage', 'active', '2020-01-02', 'proven', 'project',
  '10000000-0000-0000-0000-000000000001'
);

insert into public.parent_sets (
  id, project_id, tree_id, child_id, family_group_id, set_type,
  is_preferred_for_display, is_default_for_pedigree, display_order, created_by
) values (
  '50000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000003',
  '50000000-0000-0000-0000-000000000001',
  'biological', true, true, 0,
  '10000000-0000-0000-0000-000000000001'
);

insert into public.parent_child_relationships (
  id, project_id, tree_id, parent_id, child_id, parent_set_id,
  family_group_id, relationship_type, parent_role_label, evidence_status,
  privacy_status, created_by
) values
  (
    '60000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000003',
    '50000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000001',
    'biological', 'father', 'proven', 'project',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '60000000-0000-0000-0000-000000000003',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000002',
    '40000000-0000-0000-0000-000000000003',
    '50000000-0000-0000-0000-000000000002',
    '50000000-0000-0000-0000-000000000001',
    'biological', 'mother', 'proven', 'project',
    '10000000-0000-0000-0000-000000000001'
  );

-- 200 canonical children exercise stable keyset pagination without creating
-- 200 appearance cards in the browser or relying on offset pagination.
insert into public.persons (
  id, project_id, full_name, given_name, birth_year_from,
  is_living, privacy_status, created_by
)
select
  ('41000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '20000000-0000-0000-0000-000000000001',
  'Дитина ' || i,
  'Дитина ' || i,
  (1800 + i)::text,
  false,
  'project',
  '10000000-0000-0000-0000-000000000001'
from generate_series(1, 200) i;

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
)
select
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  ('41000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'member',
  i + 10
from generate_series(1, 200) i;

insert into public.parent_sets (
  id, project_id, tree_id, child_id, set_type, display_order, created_by
)
select
  ('51000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  ('41000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'biological',
  i,
  '10000000-0000-0000-0000-000000000001'
from generate_series(1, 200) i;

insert into public.parent_child_relationships (
  id, project_id, tree_id, parent_id, child_id, parent_set_id,
  relationship_type, parent_role_label, evidence_status, privacy_status,
  created_by
)
select
  ('61000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  ('41000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('51000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'biological', 'father', 'proven', 'project',
  '10000000-0000-0000-0000-000000000001'
from generate_series(1, 200) i;

create temporary table family_tree_rpc_results (
  result_kind text primary key,
  payload jsonb not null
);

select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '10000000-0000-0000-0000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select lives_ok(
  $$
    select public.get_family_tree_neighborhood_v1(
      '{
        "treeId":"30000000-0000-0000-0000-000000000001",
        "focusPersonId":"40000000-0000-0000-0000-000000000001",
        "ancestorDepth":1,
        "descendantDepth":1,
        "collateralDepth":1,
        "maxNodes":50
      }'::jsonb
    )
  $$,
  'viewer can read a bounded neighborhood'
);

insert into family_tree_rpc_results (result_kind, payload)
values (
  'viewer-initial',
  public.get_family_tree_neighborhood_v1(
    '{
      "treeId":"30000000-0000-0000-0000-000000000001",
      "focusPersonId":"40000000-0000-0000-0000-000000000001",
      "ancestorDepth":1,
      "descendantDepth":1,
      "collateralDepth":1,
      "maxNodes":50
    }'::jsonb
  )
);

select is(
  (
    select person ->> 'displayName'
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'viewer-initial'
      and person ->> 'id' = '40000000-0000-0000-0000-000000000002'
  ),
  'Приватна особа',
  'private living display name is masked in the network payload'
);

select ok(
  (
    select payload::text not like '%Секретне Ім’я%'
      and payload::text not like '%1990-02-03%'
    from family_tree_rpc_results
    where result_kind = 'viewer-initial'
  ),
  'exact private living name and date never enter the viewer response'
);

select ok(
  (
    select not (person ? 'birth')
      and person ->> 'sex' = 'unknown'
      and person -> 'badges' ->> 'privacy' = 'masked'
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'viewer-initial'
      and person ->> 'id' = '40000000-0000-0000-0000-000000000002'
  ),
  'private living fields and status are semantically masked'
);

select is(
  (
    select payload ->> 'permissionFingerprint'
    from family_tree_rpc_results
    where result_kind = 'viewer-initial'
  ),
  'project-viewer:living-masked:v1',
  'response identifies the viewer masking policy for cache isolation'
);

select is(
  (
    select union_row ->> 'parentSetType'
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'unions') union_row
    where result.result_kind = 'viewer-initial'
      and union_row ->> 'id' = 'parent-set:50000000-0000-0000-0000-000000000002'
  ),
  'unknown',
  'parent-set semantics are masked when a living private parent participates'
);

select is(
  (
    select relation ->> 'kind'
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'parentChildRelations') relation
    where result.result_kind = 'viewer-initial'
      and relation ->> 'id' = '60000000-0000-0000-0000-000000000003'
  ),
  'unknown',
  'private parent relationship type is masked'
);

select cmp_ok(
  (
    select (continuation ->> 'hiddenCount')::integer
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'continuations') continuation
    where result.result_kind = 'viewer-initial'
      and continuation ->> 'personId' = '40000000-0000-0000-0000-000000000001'
      and continuation ->> 'direction' = 'children'
  ),
  '>=',
  150,
  '200-child fan-out is bounded and reports hidden canonical people'
);

insert into family_tree_rpc_results (result_kind, payload)
select
  'viewer-next-page',
  public.get_family_tree_neighborhood_v1(jsonb_build_object(
    'treeId', '30000000-0000-0000-0000-000000000001',
    'focusPersonId', '40000000-0000-0000-0000-000000000001',
    'knownGraphVersion', initial.payload ->> 'graphVersion',
    'maxNodes', 50,
    'branches', jsonb_build_array(jsonb_build_object(
      'requestId', 'next-children',
      'personId', '40000000-0000-0000-0000-000000000001',
      'directions', jsonb_build_array('children'),
      'cursors', jsonb_build_object('children', continuation ->> 'token')
    ))
  ))
from family_tree_rpc_results initial,
  lateral jsonb_array_elements(initial.payload -> 'continuations') continuation
where initial.result_kind = 'viewer-initial'
  and continuation ->> 'personId' = '40000000-0000-0000-0000-000000000001'
  and continuation ->> 'direction' = 'children';

select cmp_ok(
  (
    select jsonb_array_length(payload -> 'persons')
    from family_tree_rpc_results
    where result_kind = 'viewer-next-page'
  ),
  '<=',
  50,
  'branch expansion respects the hard request node budget'
);

select is(
  (
    with initial_ids as (
      select person ->> 'id' as person_id
      from family_tree_rpc_results result,
        lateral jsonb_array_elements(result.payload -> 'persons') person
      where result.result_kind = 'viewer-initial'
        and person ->> 'id' <> '40000000-0000-0000-0000-000000000001'
    ), next_ids as (
      select person ->> 'id' as person_id
      from family_tree_rpc_results result,
        lateral jsonb_array_elements(result.payload -> 'persons') person
      where result.result_kind = 'viewer-next-page'
        and person ->> 'id' <> '40000000-0000-0000-0000-000000000001'
    )
    select count(*)::integer
    from initial_ids join next_ids using (person_id)
  ),
  0,
  'keyset branch expansion does not repeat the previous child page'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);

select is(
  (select count(*)::integer from public.persons where id = '40000000-0000-0000-0000-000000000002'),
  0,
  'viewer cannot query the exact private living person row directly'
);
select is(
  (select count(*)::integer from public.persons where id = '40000000-0000-0000-0000-000000000001'),
  1,
  'viewer can query an allowed canonical person row'
);
select is(
  (select count(*)::integer from public.parent_sets where id = '50000000-0000-0000-0000-000000000002'),
  0,
  'viewer cannot infer exact parent-set semantics through direct RLS access'
);
select is(
  (select count(*)::integer from public.family_groups where id = '50000000-0000-0000-0000-000000000001'),
  0,
  'viewer cannot infer a private primary partner from an exact family-group row'
);
select is(
  (select count(*)::integer from public.partner_relationships where id = '60000000-0000-0000-0000-000000000001'),
  0,
  'viewer cannot query an exact partnership involving a private living person'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

insert into family_tree_rpc_results (result_kind, payload)
values (
  'editor-initial',
  public.get_family_tree_neighborhood_v1(
    '{
      "treeId":"30000000-0000-0000-0000-000000000001",
      "focusPersonId":"40000000-0000-0000-0000-000000000001",
      "ancestorDepth":1,
      "descendantDepth":1,
      "collateralDepth":0,
      "maxNodes":50
    }'::jsonb
  )
);

select is(
  (
    select person ->> 'displayName'
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'editor-initial'
      and person ->> 'id' = '40000000-0000-0000-0000-000000000002'
  ),
  'Секретне Ім’я',
  'editor receives exact private fields through the same RPC'
);

set local role authenticated;
select is(
  (select count(*)::integer from public.persons where id = '40000000-0000-0000-0000-000000000002'),
  1,
  'editor can query the exact private living row'
);
reset role;

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    select public.get_family_tree_neighborhood_v1(
      '{
        "treeId":"30000000-0000-0000-0000-000000000001",
        "focusPersonId":"40000000-0000-0000-0000-000000000001",
        "maxNodes":10
      }'::jsonb
    )
  $$,
  '42501',
  'TREE_NOT_FOUND_OR_FORBIDDEN',
  'non-member cannot read another tenant tree'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    select public.get_family_tree_neighborhood_v1(
      '{
        "treeId":"30000000-0000-0000-0000-000000000001",
        "focusPersonId":"40000000-0000-0000-0000-000000000001",
        "maxNodes":10,
        "branches":[{
          "personId":"40000000-0000-0000-0000-000000000001",
          "directions":["children"],
          "cursors":{"children":"not-a-valid-cursor"}
        }]
      }'::jsonb
    )
  $$,
  '22023',
  'INVALID_OR_STALE_BRANCH_CURSOR',
  'malformed branch cursor is rejected'
);

select throws_ok(
  $$
    select public.get_family_tree_neighborhood_v1(
      '{
        "treeId":"30000000-0000-0000-0000-000000000001",
        "focusPersonId":"40000000-0000-0000-0000-000000000001",
        "maxNodes":10,
        "branches":[
          {"personId":"40000000-0000-0000-0000-000000000001","directions":["children"]},
          {"personId":"40000000-0000-0000-0000-000000000001","directions":["children"]}
        ]
      }'::jsonb
    )
  $$,
  '22023',
  'DUPLICATE_BRANCH_DIRECTION',
  'duplicate branch-direction cursor floors are rejected deterministically'
);

-- Server-side cycle rejection and graph-version invalidation.
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

insert into public.parent_sets (
  id, project_id, tree_id, child_id, set_type, display_order, created_by
) values (
  '50000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001',
  'biological', 999,
  '10000000-0000-0000-0000-000000000001'
);

select throws_ok(
  $$
    insert into public.parent_child_relationships (
      id, project_id, tree_id, parent_id, child_id, parent_set_id,
      relationship_type, parent_role_label, evidence_status, privacy_status,
      created_by
    ) values (
      '60000000-0000-0000-0000-000000000004',
      '20000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000003',
      '40000000-0000-0000-0000-000000000001',
      '50000000-0000-0000-0000-000000000003',
      'biological', 'parent', 'proven', 'project',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  '23514',
  'PARENT_CHILD_CYCLE',
  'inverse parent edge is rejected as a server-side cycle'
);

select throws_ok(
  $$
    insert into public.parent_child_relationships (
      id, project_id, tree_id, parent_id, child_id, parent_set_id,
      relationship_type, parent_role_label, evidence_status, privacy_status,
      created_by
    ) values (
      '60000000-0000-0000-0000-000000000005',
      '20000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      '40000000-0000-0000-0000-000000000001',
      '50000000-0000-0000-0000-000000000003',
      'biological', 'parent', 'proven', 'project',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  '23514',
  'PARENT_CHILD_SELF_RELATION',
  'self parent edge is rejected by the trigger'
);

create temporary table graph_version_before as
select graph_version
from public.family_trees
where id = '30000000-0000-0000-0000-000000000001';

update public.persons
set given_name = 'Оновлений корінь'
where id = '40000000-0000-0000-0000-000000000001';

select is(
  (
    select tree.graph_version
    from public.family_trees tree
    where tree.id = '30000000-0000-0000-0000-000000000001'
  ),
  (select graph_version + 1 from graph_version_before),
  'person display mutation increments the tree graph version exactly once'
);

select lives_ok(
  $$
    insert into public.partner_relationships (
      id, project_id, tree_id, person_a_id, person_b_id,
      relationship_type, status, evidence_status, privacy_status, created_by
    ) values (
      '60000000-0000-0000-0000-000000000006',
      '20000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001',
      '41000000-0000-0000-0000-000000000001',
      '41000000-0000-0000-0000-000000000002',
      'marriage', 'active', 'proven', 'project',
      '10000000-0000-0000-0000-000000000001'
    )
  $$,
  'partnership between related people is not a false-positive parent cycle'
);

-- With descendants explicitly enabled, a repeated ancestor is first reached
-- with exhausted ancestor depth through A <- P <- X, then with remaining
-- depth through A --partner-- B <- X. The nondominated state must requeue X
-- so its parent Y is still returned.
insert into public.family_trees (
  id, project_id, title, privacy_status, created_by
) values (
  '30000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000001',
  'Nondominated traversal tree',
  'project',
  '10000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
)
select
  person_id,
  '20000000-0000-0000-0000-000000000001',
  display_name,
  false,
  'project',
  '10000000-0000-0000-0000-000000000001'
from (values
  ('70000000-0000-0000-0000-000000000001'::uuid, 'A focus'),
  ('70000000-0000-0000-0000-000000000002'::uuid, 'P first parent'),
  ('70000000-0000-0000-0000-000000000003'::uuid, 'X repeated ancestor'),
  ('70000000-0000-0000-0000-000000000004'::uuid, 'B partner'),
  ('70000000-0000-0000-0000-000000000005'::uuid, 'Y must remain visible')
) as people(person_id, display_name);

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
)
select
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  person_id,
  case when person_id = '70000000-0000-0000-0000-000000000001'::uuid then 'root' else 'member' end,
  row_number() over (order by person_id)::integer
from (values
  ('70000000-0000-0000-0000-000000000001'::uuid),
  ('70000000-0000-0000-0000-000000000002'::uuid),
  ('70000000-0000-0000-0000-000000000003'::uuid),
  ('70000000-0000-0000-0000-000000000004'::uuid),
  ('70000000-0000-0000-0000-000000000005'::uuid)
) members(person_id);

insert into public.partner_relationships (
  id, project_id, tree_id, person_a_id, person_b_id,
  relationship_type, status, evidence_status, privacy_status, created_by
) values (
  '76000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000002',
  '70000000-0000-0000-0000-000000000001',
  '70000000-0000-0000-0000-000000000004',
  'marriage', 'active', 'proven', 'project',
  '10000000-0000-0000-0000-000000000001'
);

insert into public.parent_sets (
  id, project_id, tree_id, child_id, set_type, display_order, created_by
) values
  ('75000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 'biological', 1, '10000000-0000-0000-0000-000000000001'),
  ('75000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', 'biological', 2, '10000000-0000-0000-0000-000000000001'),
  ('75000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000004', 'biological', 3, '10000000-0000-0000-0000-000000000001'),
  ('75000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000003', 'biological', 4, '10000000-0000-0000-0000-000000000001');

insert into public.parent_child_relationships (
  id, project_id, tree_id, parent_id, child_id, parent_set_id,
  relationship_type, parent_role_label, evidence_status, privacy_status,
  created_by
) values
  ('76000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', '75000000-0000-0000-0000-000000000001', 'biological', 'parent', 'proven', 'project', '10000000-0000-0000-0000-000000000001'),
  ('76000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000002', '75000000-0000-0000-0000-000000000002', 'biological', 'parent', 'proven', 'project', '10000000-0000-0000-0000-000000000001'),
  ('76000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000004', '75000000-0000-0000-0000-000000000003', 'biological', 'parent', 'proven', 'project', '10000000-0000-0000-0000-000000000001'),
  ('76000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000005', '70000000-0000-0000-0000-000000000003', '75000000-0000-0000-0000-000000000004', 'biological', 'parent', 'proven', 'project', '10000000-0000-0000-0000-000000000001');

insert into family_tree_rpc_results (result_kind, payload)
values (
  'nondominated-path',
  public.get_family_tree_neighborhood_v1(
    '{
      "treeId":"30000000-0000-0000-0000-000000000002",
      "focusPersonId":"70000000-0000-0000-0000-000000000001",
      "ancestorDepth":2,
      "descendantDepth":1,
      "collateralDepth":0,
      "maxNodes":20
    }'::jsonb
  )
);

select is(
  (
    select count(*)::integer
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'nondominated-path'
      and person ->> 'id' = '70000000-0000-0000-0000-000000000003'
  ),
  1,
  'repeated ancestor remains one canonical person in the response'
);

select is(
  (
    select count(*)::integer
    from family_tree_rpc_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'nondominated-path'
      and person ->> 'id' = '70000000-0000-0000-0000-000000000005'
  ),
  1,
  'a later nondominated traversal state requeues the repeated ancestor'
);

select * from finish();
rollback;
