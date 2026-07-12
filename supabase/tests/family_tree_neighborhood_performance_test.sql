begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(11);

-- A deliberately wide family reproduces the production failure mode: the
-- root has 2,479 direct children, so continuation discovery must account for
-- 2,480 canonical people without repeatedly scanning every sibling set.
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
  '90000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'family-tree-performance-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  '90000000-0000-0000-0000-000000000001',
  'family-tree-performance-owner@example.test',
  'Family tree performance owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  '91000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'Family tree neighborhood performance test'
);

insert into public.project_members (project_id, user_id, role, invited_by)
values (
  '91000000-0000-0000-0000-000000000001',
  '90000000-0000-0000-0000-000000000001',
  'owner',
  null
)
on conflict (project_id, user_id) do update set role = excluded.role;

insert into public.family_trees (
  id, project_id, title, privacy_status, created_by
) values (
  '92000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  '2,480-person stress tree',
  'project',
  '90000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id, project_id, full_name, given_name, is_living, privacy_status, created_by
) values (
  '93000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000001',
  'Stress Root',
  'Stress Root',
  false,
  'project',
  '90000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id, project_id, full_name, given_name, is_living, privacy_status, created_by
)
select
  ('94000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '91000000-0000-0000-0000-000000000001',
  'Stress Child ' || lpad(i::text, 4, '0'),
  'Stress Child ' || lpad(i::text, 4, '0'),
  false,
  'project',
  '90000000-0000-0000-0000-000000000001'
from generate_series(1, 2479) as children(i);

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
) values (
  '91000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  'root',
  0
);

insert into public.family_tree_persons (
  project_id, tree_id, person_id, member_role, display_order
)
select
  '91000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  ('94000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'member',
  i
from generate_series(1, 2479) as children(i);

update public.family_trees
set root_person_id = '93000000-0000-0000-0000-000000000001'
where id = '92000000-0000-0000-0000-000000000001';

insert into public.parent_sets (
  id, project_id, tree_id, child_id, set_type, display_order, created_by
)
select
  ('95000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '91000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  ('94000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'biological',
  i,
  '90000000-0000-0000-0000-000000000001'
from generate_series(1, 2479) as children(i);

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
  ('96000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  '91000000-0000-0000-0000-000000000001',
  '92000000-0000-0000-0000-000000000001',
  '93000000-0000-0000-0000-000000000001',
  ('94000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  ('95000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'biological',
  'parent',
  'proven',
  'project',
  '90000000-0000-0000-0000-000000000001'
from generate_series(1, 2479) as children(i);

select is(
  (
    select count(*)::integer
    from public.family_tree_persons
    where tree_id = '92000000-0000-0000-0000-000000000001'
  ),
  2480,
  'stress fixture contains exactly 2,480 canonical tree people'
);

create temporary table family_tree_perf_results (
  result_kind text primary key,
  payload jsonb not null
) on commit drop;

select set_config(
  'request.jwt.claims',
  '{"sub":"90000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

set local statement_timeout = '15s';

select is(
  current_setting('statement_timeout'),
  '15s',
  'stress RPCs run with the production timeout regression guard enabled'
);

select lives_ok(
  $$
    insert into pg_temp.family_tree_perf_results (result_kind, payload)
    values (
      'initial',
      public.get_family_tree_neighborhood_v1(
        '{
          "treeId":"92000000-0000-0000-0000-000000000001",
          "focusPersonId":"93000000-0000-0000-0000-000000000001",
          "ancestorDepth":0,
          "descendantDepth":1,
          "collateralDepth":0,
          "maxNodes":600
        }'::jsonb
      )
    )
  $$,
  '2,480-person initial neighborhood completes within statement_timeout'
);

select is(
  (
    select jsonb_array_length(payload -> 'persons')
    from family_tree_perf_results
    where result_kind = 'initial'
  ),
  600,
  'initial neighborhood fills the 600-person hard node budget'
);

select is(
  (
    select (continuation ->> 'hiddenCount')::integer
    from family_tree_perf_results result,
      lateral jsonb_array_elements(result.payload -> 'continuations') continuation
    where result.result_kind = 'initial'
      and continuation ->> 'personId' = '93000000-0000-0000-0000-000000000001'
      and continuation ->> 'direction' = 'children'
  ),
  1880,
  'root continuation reports the exact 2,479 - 599 hidden child count'
);

select lives_ok(
  $$
    insert into pg_temp.family_tree_perf_results (result_kind, payload)
    select
      'next-page',
      public.get_family_tree_neighborhood_v1(jsonb_build_object(
        'treeId', '92000000-0000-0000-0000-000000000001',
        'focusPersonId', '93000000-0000-0000-0000-000000000001',
        'knownGraphVersion', initial.payload ->> 'graphVersion',
        'maxNodes', 600,
        'branches', jsonb_build_array(jsonb_build_object(
          'requestId', 'stress-next-children',
          'personId', '93000000-0000-0000-0000-000000000001',
          'directions', jsonb_build_array('children'),
          'cursors', jsonb_build_object('children', continuation ->> 'token')
        ))
      ))
    from pg_temp.family_tree_perf_results initial,
      lateral jsonb_array_elements(initial.payload -> 'continuations') continuation
    where initial.result_kind = 'initial'
      and continuation ->> 'personId' = '93000000-0000-0000-0000-000000000001'
      and continuation ->> 'direction' = 'children'
  $$,
  '600-person cursor expansion completes within statement_timeout'
);

select is(
  (
    select jsonb_array_length(payload -> 'persons')
    from family_tree_perf_results
    where result_kind = 'next-page'
  ),
  600,
  'cursor expansion also fills the bounded 600-person page'
);

select is(
  (
    with initial_ids as (
      select person ->> 'id' as person_id
      from family_tree_perf_results result,
        lateral jsonb_array_elements(result.payload -> 'persons') person
      where result.result_kind = 'initial'
        and person ->> 'id' <> '93000000-0000-0000-0000-000000000001'
    ), next_ids as (
      select person ->> 'id' as person_id
      from family_tree_perf_results result,
        lateral jsonb_array_elements(result.payload -> 'persons') person
      where result.result_kind = 'next-page'
        and person ->> 'id' <> '93000000-0000-0000-0000-000000000001'
    )
    select count(*)::integer
    from initial_ids
    join next_ids using (person_id)
  ),
  0,
  'continuation cursor returns a page disjoint from the initial child page'
);

-- Assert index shapes by key columns and predicate instead of implementation
-- names, so harmless index renames do not weaken the regression contract.
select ok(
  exists (
    select 1
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class table_record
      on table_record.oid = index_record.indrelid
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    join pg_catalog.pg_am access_method
      on access_method.oid = index_relation.relam
    where table_record.relnamespace = pg_my_temp_schema()
      and table_record.relname = '_family_tree_queue'
      and access_method.amname = 'btree'
      and index_record.indisvalid
      and index_record.indisready
      and index_record.indpred is not null
      and pg_get_expr(index_record.indpred, index_record.indrelid) ~* 'processed'
      and (
        select array_agg(attribute.attname::text order by key_column.key_ordinal)
        from unnest(index_record.indkey::smallint[]) with ordinality
          as key_column(attnum, key_ordinal)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_record.indrelid
         and attribute.attnum = key_column.attnum
        where key_column.key_ordinal <= index_record.indnkeyatts
      ) = array['seq']::text[]
  ),
  'queue has a partial pending-state btree on seq for indexed FIFO dequeue'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class table_record
      on table_record.oid = index_record.indrelid
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    join pg_catalog.pg_am access_method
      on access_method.oid = index_relation.relam
    where table_record.relnamespace = pg_my_temp_schema()
      and table_record.relname = '_family_tree_queue'
      and access_method.amname = 'btree'
      and index_record.indisvalid
      and index_record.indisready
      and (
        select array_agg(attribute.attname::text order by key_column.key_ordinal)
        from unnest(index_record.indkey::smallint[]) with ordinality
          as key_column(attnum, key_ordinal)
        join pg_catalog.pg_attribute attribute
          on attribute.attrelid = index_record.indrelid
         and attribute.attnum = key_column.attnum
        where key_column.key_ordinal <= index_record.indnkeyatts
      ) = array[
        'person_id',
        'ancestor_depth',
        'descendant_depth',
        'collateral_depth'
      ]::text[]
  ),
  'queue has the composite btree used by nondominated-state checks'
);

with ddl_guard as (
  select lower(pg_get_functiondef(
    'public.ensure_foreign_key_covering_indexes_after_ddl()'::regprocedure
  )) as function_definition
)
select ok(
  function_definition like '%pg_event_trigger_ddl_commands()%'
    and function_definition ~
      'schema_name[[:space:]]*=[[:space:]]*''public''',
  'foreign-key DDL event trigger audits only commands in the public schema'
)
from ddl_guard;

select * from finish();
rollback;
