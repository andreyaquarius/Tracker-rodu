begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(16);

-- This fixture mirrors the large Persons module project that exposed the RLS
-- timeout. One private living person is deliberately linked to a public person
-- so the optimized set-based policies must preserve the exact privacy rule.
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
  ('b1000000-0000-0000-0000-000000000001'::uuid, 'people-timeout-owner@example.test'),
  ('b1000000-0000-0000-0000-000000000002'::uuid, 'people-timeout-editor@example.test'),
  ('b1000000-0000-0000-0000-000000000003'::uuid, 'people-timeout-viewer@example.test')
) as fixture(user_id, email);

insert into public.profiles (user_id, email, display_name)
select id, email, split_part(email, '@', 1)
from auth.users
where id in (
  'b1000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000002',
  'b1000000-0000-0000-0000-000000000003'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'b2000000-0000-0000-0000-000000000001',
  'b1000000-0000-0000-0000-000000000001',
  'People list RLS timeout regression'
);

insert into public.project_members (project_id, user_id, role, invited_by)
values
  (
    'b2000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000001',
    'owner',
    null
  ),
  (
    'b2000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000002',
    'editor',
    'b1000000-0000-0000-0000-000000000001'
  ),
  (
    'b2000000-0000-0000-0000-000000000001',
    'b1000000-0000-0000-0000-000000000003',
    'viewer',
    'b1000000-0000-0000-0000-000000000001'
  )
on conflict (project_id, user_id) do update set role = excluded.role;

insert into public.persons (
  id,
  project_id,
  full_name,
  given_name,
  is_living,
  privacy_status,
  created_by
)
select
  ('b3000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
  'b2000000-0000-0000-0000-000000000001',
  'People timeout person ' || lpad(i::text, 4, '0'),
  'Person ' || lpad(i::text, 4, '0'),
  i = 2480,
  case when i = 2480 then 'private' else 'project' end,
  'b1000000-0000-0000-0000-000000000001'
from generate_series(1, 2480) as people(i);

insert into public.person_relations (
  id,
  project_id,
  person_id,
  related_person_id,
  relation_type,
  status,
  created_by
) values (
  'b4000000-0000-0000-0000-000000000001',
  'b2000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000000001',
  'b3000000-0000-0000-0000-000000002480',
  'test-only relation',
  'proven',
  'b1000000-0000-0000-0000-000000000001'
);

select is(
  (
    select count(*)::integer
    from public.persons
    where project_id = 'b2000000-0000-0000-0000-000000000001'
  ),
  2480,
  'fixture contains exactly 2,480 people'
);

select is(
  (
    select count(*)::integer
    from public.persons
    where project_id = 'b2000000-0000-0000-0000-000000000001'
      and is_living
      and privacy_status = 'private'
  ),
  1,
  'fixture contains exactly one private living person'
);

select is(
  (
    select count(*)::integer
    from public.person_relations
    where project_id = 'b2000000-0000-0000-0000-000000000001'
  ),
  1,
  'fixture contains one relation touching the private living person'
);

create temporary table family_tree_people_timeout_counts (
  member_role text primary key,
  visible_person_count bigint not null,
  visible_relation_count bigint not null
) on commit drop;

grant select, insert on pg_temp.family_tree_people_timeout_counts to authenticated;

set local statement_timeout = '5s';

select is(
  current_setting('statement_timeout'),
  '5s',
  'large people-list reads run under a bounded statement timeout'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);
set local role authenticated;

select lives_ok(
  $$
    insert into pg_temp.family_tree_people_timeout_counts (
      member_role,
      visible_person_count,
      visible_relation_count
    )
    select
      'owner',
      (
        select count(*)
        from public.persons
        where project_id = 'b2000000-0000-0000-0000-000000000001'
      ),
      (
        select count(*)
        from public.person_relations
        where project_id = 'b2000000-0000-0000-0000-000000000001'
      )
  $$,
  'owner people and relation SELECTs complete within statement_timeout'
);

select is(
  (
    select format('%s/%s', visible_person_count, visible_relation_count)
    from pg_temp.family_tree_people_timeout_counts
    where member_role = 'owner'
  ),
  '2480/1',
  'owner can select all people and the relation'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);
set local role authenticated;

select lives_ok(
  $$
    insert into pg_temp.family_tree_people_timeout_counts (
      member_role,
      visible_person_count,
      visible_relation_count
    )
    select
      'editor',
      (
        select count(*)
        from public.persons
        where project_id = 'b2000000-0000-0000-0000-000000000001'
      ),
      (
        select count(*)
        from public.person_relations
        where project_id = 'b2000000-0000-0000-0000-000000000001'
      )
  $$,
  'editor people and relation SELECTs complete within statement_timeout'
);

select is(
  (
    select format('%s/%s', visible_person_count, visible_relation_count)
    from pg_temp.family_tree_people_timeout_counts
    where member_role = 'editor'
  ),
  '2480/1',
  'editor can select all people and the relation'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);
set local role authenticated;

select lives_ok(
  $$
    insert into pg_temp.family_tree_people_timeout_counts (
      member_role,
      visible_person_count,
      visible_relation_count
    )
    select
      'viewer',
      (
        select count(*)
        from public.persons
        where project_id = 'b2000000-0000-0000-0000-000000000001'
      ),
      (
        select count(*)
        from public.person_relations
        where project_id = 'b2000000-0000-0000-0000-000000000001'
      )
  $$,
  'viewer privacy-filtered SELECTs complete within statement_timeout'
);

select is(
  (
    select format('%s/%s', visible_person_count, visible_relation_count)
    from pg_temp.family_tree_people_timeout_counts
    where member_role = 'viewer'
  ),
  '2479/0',
  'viewer sees public people but no relation that exposes the private person'
);

select is(
  (
    select count(*)::integer
    from public.persons
    where id = 'b3000000-0000-0000-0000-000000002480'
  ),
  0,
  'viewer cannot select the private living person'
);

select is(
  (
    select count(*)::integer
    from public.person_relations
    where id = 'b4000000-0000-0000-0000-000000000001'
  ),
  0,
  'viewer cannot select a person_relation touching the private living person'
);

reset role;

-- Inspect catalog key metadata so changes in either column position or sort
-- direction break the contract. indnatts also rejects hidden INCLUDE columns.
select is(
  (
    select array_agg(
      format(
        '%s %s',
        attribute.attname,
        case
          when (key_option.option_bits & 1) = 1 then 'desc'
          else 'asc'
        end
      )
      order by key_column.key_ordinal
    )
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    cross join lateral unnest(index_record.indkey::smallint[]) with ordinality
      as key_column(attnum, key_ordinal)
    cross join lateral unnest(index_record.indoption::smallint[]) with ordinality
      as key_option(option_bits, option_ordinal)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = index_record.indrelid
     and attribute.attnum = key_column.attnum
    where index_record.indrelid = 'public.persons'::regclass
      and index_relation.relname = 'persons_project_updated_id_idx'
      and index_record.indisvalid
      and index_record.indisready
      and index_record.indnkeyatts = 3
      and index_record.indnatts = 3
      and key_option.option_ordinal = key_column.key_ordinal
  ),
  array['project_id asc', 'updated_at desc', 'id asc']::text[],
  'persons list index has exact project, update-descending, id key order'
);

select is(
  (
    select array_agg(
      format(
        '%s %s',
        attribute.attname,
        case
          when (key_option.option_bits & 1) = 1 then 'desc'
          else 'asc'
        end
      )
      order by key_column.key_ordinal
    )
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    cross join lateral unnest(index_record.indkey::smallint[]) with ordinality
      as key_column(attnum, key_ordinal)
    cross join lateral unnest(index_record.indoption::smallint[]) with ordinality
      as key_option(option_bits, option_ordinal)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = index_record.indrelid
     and attribute.attnum = key_column.attnum
    where index_record.indrelid = 'public.person_relations'::regclass
      and index_relation.relname = 'person_relations_project_updated_id_idx'
      and index_record.indisvalid
      and index_record.indisready
      and index_record.indnkeyatts = 3
      and index_record.indnatts = 3
      and key_option.option_ordinal = key_column.key_ordinal
  ),
  array['project_id asc', 'updated_at desc', 'id asc']::text[],
  'person-relations index has exact project, update-descending, id key order'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and (tablename, policyname) in (
        ('persons', 'persons_select'),
        ('person_relations', 'person_relations_select')
      )
      and cmd = 'SELECT'
  ),
  2,
  'optimized SELECT policies exist for persons and person_relations'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and (tablename, policyname) in (
        ('persons', 'persons_select'),
        ('person_relations', 'person_relations_select')
      )
      and concat_ws(' ', qual, with_check)
        ~* 'can_read_exact_family_tree_person'
  ),
  0,
  'people-list policies do not call can_read_exact_family_tree_person per row'
);

select * from finish();
rollback;
