begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(27);

select has_function(
  'public',
  'get_family_tree_descendants_frontier_v1',
  array['jsonb'],
  'the progressive descendant-frontier RPC exists'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.get_family_tree_descendants_frontier_v1(jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_family_tree_descendants_frontier_v1(jsonb)',
    'EXECUTE'
  ),
  'only authenticated API users receive execute permission'
);

select ok(
  lower(pg_get_functiondef(
    'public.get_family_tree_descendants_frontier_v1(jsonb)'::regprocedure
  )) like '%set statement_timeout to ''15s''%',
  'the progressive RPC owns a production statement timeout'
);

select ok(
  pg_get_functiondef(
    'public.get_family_tree_descendants_frontier_v1(jsonb)'::regprocedure
  ) not like '%WITH RECURSIVE%'
  and pg_get_functiondef(
    'public.get_family_tree_descendants_frontier_v1(jsonb)'::regprocedure
  ) not like '%get_family_tree_neighborhood_%',
  'one page never recursively scans or materializes the whole tree'
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
    'd0000000-0000-0000-0000-000000000001',
    'authenticated',
    'authenticated',
    'progressive-descendants-owner@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'd0000000-0000-0000-0000-000000000002',
    'authenticated',
    'authenticated',
    'progressive-descendants-viewer@example.test',
    '',
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{}'::jsonb,
    now(),
    now()
  );

insert into public.profiles (user_id, email, display_name)
values
  (
    'd0000000-0000-0000-0000-000000000001',
    'progressive-descendants-owner@example.test',
    'Progressive descendants owner'
  ),
  (
    'd0000000-0000-0000-0000-000000000002',
    'progressive-descendants-viewer@example.test',
    'Progressive descendants viewer'
  )
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'd1000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  'Progressive descendants 2,480-person stress test'
);

insert into public.project_members (project_id, user_id, role, invited_by)
values
  (
    'd1000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000001',
    'owner',
    null
  ),
  (
    'd1000000-0000-0000-0000-000000000001',
    'd0000000-0000-0000-0000-000000000002',
    'viewer',
    'd0000000-0000-0000-0000-000000000001'
  )
on conflict (project_id, user_id) do update
set role = excluded.role,
    invited_by = excluded.invited_by;

insert into public.family_trees (
  id,
  project_id,
  title,
  privacy_status,
  created_by
) values (
  'd2000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',
  'Progressive 2,480-person stress tree',
  'project',
  'd0000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id,
  project_id,
  full_name,
  given_name,
  is_living,
  privacy_status,
  created_by
) values (
  'd3000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',
  'Stress Root',
  'Stress Root',
  false,
  'project',
  'd0000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id,
  project_id,
  full_name,
  given_name,
  birth_date,
  is_living,
  privacy_status,
  created_by
)
select
  ('d4000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'd1000000-0000-0000-0000-000000000001',
  'Stress Child ' || lpad(i::text, 4, '0'),
  'Stress Child ' || lpad(i::text, 4, '0'),
  case when i = 1 then '2000-01-01' else '' end,
  i = 1,
  case when i = 1 then 'private' else 'project' end,
  'd0000000-0000-0000-0000-000000000001'
from generate_series(1, 2479) children(i);

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role,
  display_order
) values (
  'd1000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001',
  'root',
  0
);

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role,
  display_order
)
select
  'd1000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  ('d4000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'member',
  i
from generate_series(1, 2479) children(i);

update public.family_trees
set root_person_id = 'd3000000-0000-0000-0000-000000000001'
where id = 'd2000000-0000-0000-0000-000000000001';

insert into public.parent_sets (
  id,
  project_id,
  tree_id,
  child_id,
  set_type,
  display_order,
  created_by
)
select
  ('d5000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'd1000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  ('d4000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'biological',
  i,
  'd0000000-0000-0000-0000-000000000001'
from generate_series(1, 2479) children(i);

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
)
select
  ('d6000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'd1000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001',
  ('d4000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('d5000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'biological',
  'parent',
  'proven',
  'project',
  'd0000000-0000-0000-0000-000000000001'
from generate_series(1, 2479) children(i);

select is(
  (
    select count(*)::integer
    from public.family_tree_persons
    where tree_id = 'd2000000-0000-0000-0000-000000000001'
  ),
  2480,
  'stress fixture contains exactly 2,480 canonical people'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes index_record
    where index_record.schemaname = 'public'
      and index_record.tablename = 'parent_child_relationships'
      and index_record.indexname =
        'parent_child_relationships_descendant_frontier_idx'
      and index_record.indexdef like '%tree_id, parent_id, child_id%'
  ),
  'the direct-frontier keyset index exists'
);

create temporary table progressive_descendant_results (
  result_kind text primary key,
  payload jsonb not null
) on commit drop;

select set_config(
  'request.jwt.claims',
  '{"sub":"d0000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

set local statement_timeout = '15s';

select lives_ok(
  $$
    insert into pg_temp.progressive_descendant_results (result_kind, payload)
    values (
      'owner-page-1',
      public.get_family_tree_descendants_frontier_v1(
        '{
          "treeId":"d2000000-0000-0000-0000-000000000001",
          "rootPersonId":"d3000000-0000-0000-0000-000000000001",
          "frontier":{
            "generation":0,
            "personIds":["d3000000-0000-0000-0000-000000000001"]
          },
          "pageSize":999
        }'::jsonb
      )
    )
  $$,
  'the first wide-family page completes inside the 15-second guard'
);

select is(
  (
    select (payload -> 'progress' ->> 'pageSize')::integer
    from progressive_descendant_results
    where result_kind = 'owner-page-1'
  ),
  200,
  'pageSize is hard-clamped to 200'
);

select is(
  (
    select jsonb_array_length(payload -> 'nextFrontier' -> 'personIds')
    from progressive_descendant_results
    where result_kind = 'owner-page-1'
  ),
  200,
  'one response contributes no more than 200 descendants to the next frontier'
);

select is(
  (
    select jsonb_array_length(payload -> 'persons')
    from progressive_descendant_results
    where result_kind = 'owner-page-1'
  ),
  200,
  'the 2,480-person tree is not returned in one persons payload'
);

select is(
  (
    select jsonb_array_length(payload -> 'parentChildRelations')
    from progressive_descendant_results
    where result_kind = 'owner-page-1'
  ),
  200,
  'the graph page contains exactly the 200 traversed parent-child edges'
);

select is(
  (
    select jsonb_array_length(payload -> 'unions')
    from progressive_descendant_results
    where result_kind = 'owner-page-1'
  ),
  200,
  'the graph page contains the 200 matching parent-set unions'
);

select ok(
  (
    select (payload ->> 'hasMore')::boolean
      and payload ? 'nextCursor'
      and not (payload -> 'progress' ->> 'frontierComplete')::boolean
      and (payload -> 'progress' ->> 'pageNumber')::integer = 1
      and (payload -> 'progress' ->> 'returnedDescendantCount')::integer = 200
    from progressive_descendant_results
    where result_kind = 'owner-page-1'
  ),
  'hasMore, cursor and first-page progress are internally consistent'
);

select is(
  (
    select person ->> 'displayName'
    from progressive_descendant_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'owner-page-1'
      and person ->> 'id' = 'd4000000-0000-0000-0000-000000000001'
  ),
  'Stress Child 0001',
  'an owner sees the private living descendant without masking'
);

select lives_ok(
  $$
    insert into pg_temp.progressive_descendant_results (result_kind, payload)
    select
      'owner-page-2',
      public.get_family_tree_descendants_frontier_v1(jsonb_build_object(
        'treeId', 'd2000000-0000-0000-0000-000000000001',
        'rootPersonId', 'd3000000-0000-0000-0000-000000000001',
        'frontier', jsonb_build_object(
          'generation', 0,
          'personIds', jsonb_build_array(
            'd3000000-0000-0000-0000-000000000001'
          )
        ),
        'pageSize', 999,
        'cursor', first_page.payload ->> 'nextCursor',
        'knownGraphVersion', first_page.payload ->> 'graphVersion',
        'permissionFingerprint',
          first_page.payload ->> 'permissionFingerprint'
      ))
    from pg_temp.progressive_descendant_results first_page
    where first_page.result_kind = 'owner-page-1'
  $$,
  'the stateless second page completes inside the timeout guard'
);

select is(
  (
    with first_ids as (
      select person_id.value #>> '{}' as person_id
      from progressive_descendant_results first_page,
        lateral jsonb_array_elements(
          first_page.payload -> 'nextFrontier' -> 'personIds'
        ) person_id(value)
      where first_page.result_kind = 'owner-page-1'
    ), second_ids as (
      select person_id.value #>> '{}' as person_id
      from progressive_descendant_results second_page,
        lateral jsonb_array_elements(
          second_page.payload -> 'nextFrontier' -> 'personIds'
        ) person_id(value)
      where second_page.result_kind = 'owner-page-2'
    )
    select count(*)::integer
    from first_ids
    join second_ids using (person_id)
  ),
  0,
  'keyset cursor pages are disjoint'
);

select ok(
  (
    select
      (payload -> 'progress' ->> 'pageNumber')::integer = 2
      and (payload -> 'progress' ->> 'currentGeneration')::integer = 0
      and (payload -> 'nextFrontier' ->> 'generation')::integer = 1
    from progressive_descendant_results
    where result_kind = 'owner-page-2'
  ),
  'the second page preserves BFS generation metadata'
);

select lives_ok(
  $$
    insert into pg_temp.progressive_descendant_results (result_kind, payload)
    select
      'empty-generation-1',
      public.get_family_tree_descendants_frontier_v1(jsonb_build_object(
        'treeId', 'd2000000-0000-0000-0000-000000000001',
        'rootPersonId', 'd3000000-0000-0000-0000-000000000001',
        'frontier', jsonb_build_object(
          'generation', 1,
          'personIds', first_page.payload -> 'nextFrontier' -> 'personIds'
        ),
        'pageSize', 200,
        'knownGraphVersion', first_page.payload ->> 'graphVersion',
        'permissionFingerprint',
          first_page.payload ->> 'permissionFingerprint'
      ))
    from pg_temp.progressive_descendant_results first_page
    where first_page.result_kind = 'owner-page-1'
  $$,
  'a full 200-person next-generation frontier remains bounded'
);

select ok(
  (
    select
      jsonb_array_length(payload -> 'persons') = 0
      and jsonb_array_length(payload -> 'nextFrontier' -> 'personIds') = 0
      and not (payload ->> 'hasMore')::boolean
      and (payload -> 'progress' ->> 'frontierComplete')::boolean
      and (payload -> 'nextFrontier' ->> 'generation')::integer = 2
    from progressive_descendant_results
    where result_kind = 'empty-generation-1'
  ),
  'a leaf frontier terminates cleanly without fabricating descendants'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d0000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

select lives_ok(
  $$
    insert into pg_temp.progressive_descendant_results (result_kind, payload)
    values (
      'viewer-page-1',
      public.get_family_tree_descendants_frontier_v1(
        '{
          "treeId":"d2000000-0000-0000-0000-000000000001",
          "rootPersonId":"d3000000-0000-0000-0000-000000000001",
          "frontier":{
            "generation":0,
            "personIds":["d3000000-0000-0000-0000-000000000001"]
          },
          "pageSize":1
        }'::jsonb
      )
    )
  $$,
  'a project viewer can request a masked descendant page'
);

select ok(
  (
    select
      person ->> 'displayName' = 'Приватна особа'
      and not (person ? 'givenName')
      and not (person ? 'birth')
      and person -> 'badges' ->> 'privacy' = 'masked'
    from progressive_descendant_results result,
      lateral jsonb_array_elements(result.payload -> 'persons') person
    where result.result_kind = 'viewer-page-1'
      and person ->> 'id' = 'd4000000-0000-0000-0000-000000000001'
  ),
  'the progressive page reuses neighborhood living-person masking'
);

select is(
  (
    select payload ->> 'permissionFingerprint'
    from progressive_descendant_results
    where result_kind = 'viewer-page-1'
  ),
  'project-viewer:living-masked:v1',
  'viewer responses expose the cache permission fingerprint'
);

select throws_ok(
  $$
    select public.get_family_tree_descendants_frontier_v1(
      '{
        "treeId":"d2000000-0000-0000-0000-000000000001",
        "rootPersonId":"d3000000-0000-0000-0000-000000000001",
        "frontier":{
          "generation":0,
          "personIds":["d3000000-0000-0000-0000-000000000001"]
        },
        "permissionFingerprint":"project-editor:private-visible:v1"
      }'::jsonb
    )
  $$,
  '40001',
  'TREE_PERMISSION_SCOPE_CHANGED',
  'a permission-scope change invalidates progressive traversal state'
);

select throws_ok(
  $$
    select public.get_family_tree_descendants_frontier_v1(
      '{
        "treeId":"d2000000-0000-0000-0000-000000000001",
        "rootPersonId":"d3000000-0000-0000-0000-000000000001",
        "frontier":{
          "generation":0,
          "personIds":["d3000000-0000-0000-0000-000000000001"]
        },
        "cursor":"not-a-valid-descendant-cursor"
      }'::jsonb
    )
  $$,
  '22023',
  'INVALID_OR_STALE_DESCENDANTS_CURSOR',
  'a malformed stateless cursor is rejected'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"d0000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$
    select public.get_family_tree_descendants_frontier_v1(
      '{
        "treeId":"d2000000-0000-0000-0000-000000000001",
        "rootPersonId":"d3000000-0000-0000-0000-000000000001",
        "frontier":{
          "generation":0,
          "personIds":["d3000000-0000-0000-0000-000000000001"]
        },
        "knownGraphVersion":"-1"
      }'::jsonb
    )
  $$,
  '40001',
  'TREE_GRAPH_VERSION_CHANGED',
  'a graph-version change invalidates progressive traversal state'
);

select throws_ok(
  $$
    select public.get_family_tree_descendants_frontier_v1(jsonb_build_object(
      'treeId', 'd2000000-0000-0000-0000-000000000001',
      'rootPersonId', 'd3000000-0000-0000-0000-000000000001',
      'frontier', jsonb_build_object(
        'generation', 1,
        'personIds', jsonb_build_array(
          'd4000000-0000-0000-0000-000000000001'
        )
      ),
      'cursor', first_page.payload ->> 'nextCursor'
    ))
    from pg_temp.progressive_descendant_results first_page
    where first_page.result_kind = 'owner-page-1'
  $$,
  '22023',
  'INVALID_OR_STALE_DESCENDANTS_CURSOR',
  'a cursor cannot be replayed against another BFS generation/frontier'
);

select throws_ok(
  $$
    select public.get_family_tree_descendants_frontier_v1(
      '{
        "treeId":"d2000000-0000-0000-0000-000000000001",
        "rootPersonId":"d3000000-0000-0000-0000-000000000001",
        "frontier":{
          "generation":0,
          "personIds":[
            "d3000000-0000-0000-0000-000000000001",
            "d4000000-0000-0000-0000-000000000001"
          ]
        }
      }'::jsonb
    )
  $$,
  '22023',
  'INVALID_DESCENDANTS_ROOT_FRONTIER',
  'generation zero is strictly bound to the selected root person'
);

select * from finish();
rollback;
