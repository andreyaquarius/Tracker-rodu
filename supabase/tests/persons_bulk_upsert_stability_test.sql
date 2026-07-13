begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

select ok(
  exists (
    select 1
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    where index_record.indrelid = 'public.person_timeline_events'::regclass
      and index_relation.relname = 'person_timeline_events_persons_projection_person_idx'
      and index_record.indisvalid
      and index_record.indisready
  ),
  'persons_projection timeline index is valid and ready'
);

select is(
  (
    select array_agg(attribute.attname order by key_column.key_ordinal)
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    cross join lateral unnest(index_record.indkey::smallint[]) with ordinality
      as key_column(attnum, key_ordinal)
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = index_record.indrelid
     and attribute.attnum = key_column.attnum
    where index_record.indrelid = 'public.person_timeline_events'::regclass
      and index_relation.relname = 'person_timeline_events_persons_projection_person_idx'
      and index_record.indnkeyatts = 1
      and index_record.indnatts = 1
  ),
  array['person_id']::name[],
  'persons_projection timeline index is person-first with no extra keys'
);

select ok(
  (
    select pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid)
           like '%persons_projection%'
    from pg_catalog.pg_index index_record
    join pg_catalog.pg_class index_relation
      on index_relation.oid = index_record.indexrelid
    where index_record.indrelid = 'public.person_timeline_events'::regclass
      and index_relation.relname = 'person_timeline_events_persons_projection_person_idx'
  ),
  'timeline index is partial and only covers persons_projection rows'
);

select ok(
  (
    select pg_catalog.pg_get_triggerdef(trigger_record.oid) ~* 'AFTER INSERT ON public.persons'
    from pg_catalog.pg_trigger trigger_record
    where trigger_record.tgrelid = 'public.persons'::regclass
      and trigger_record.tgname = 'persons_family_tree_projection_sync_insert'
      and not trigger_record.tgisinternal
  ),
  'person INSERT projection remains unconditional'
);

select ok(
  (
    select pg_catalog.pg_get_triggerdef(trigger_record.oid)
           ~* 'AFTER UPDATE .* WHEN .* IS DISTINCT FROM '
    from pg_catalog.pg_trigger trigger_record
    where trigger_record.tgrelid = 'public.persons'::regclass
      and trigger_record.tgname = 'persons_family_tree_projection_sync'
      and not trigger_record.tgisinternal
  ),
  'person UPDATE projection has a null-safe value-change guard'
);

select ok(
  (
    select pg_catalog.pg_get_triggerdef(trigger_record.oid)
           ~* 'AFTER UPDATE .* WHEN .* IS DISTINCT FROM '
    from pg_catalog.pg_trigger trigger_record
    where trigger_record.tgrelid = 'public.persons'::regclass
      and trigger_record.tgname = 'persons_bump_family_tree_graph_versions'
      and not trigger_record.tgisinternal
  ),
  'person graph-version trigger has a null-safe value-change guard'
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
) values (
  '00000000-0000-0000-0000-000000000000',
  'd1000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'persons-upsert-stability@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'd1000000-0000-0000-0000-000000000001',
  'persons-upsert-stability@example.test',
  'Persons upsert owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'd2000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',
  'Persons bulk upsert stability fixture'
);

insert into public.researches (id, project_id, title, created_by)
values (
  'd2500000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'GEDCOM import',
  'd1000000-0000-0000-0000-000000000001'
);

insert into public.family_trees (
  id,
  project_id,
  title,
  privacy_status,
  created_by
) values (
  'd3000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'Bulk upsert tree',
  'project',
  'd1000000-0000-0000-0000-000000000001'
);

insert into public.persons (
  id,
  project_id,
  research_id,
  status,
  gender,
  surname,
  given_name,
  full_name,
  birth_date,
  birth_place,
  is_living,
  privacy_status,
  created_by
) values (
  'd4000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'd2500000-0000-0000-0000-000000000001',
  'proven',
  'male',
  'Fixture',
  'Person',
  'Fixture Person',
  '1900-01-02',
  'Kyiv',
  false,
  'project',
  'd1000000-0000-0000-0000-000000000001'
);

insert into public.family_tree_persons (
  project_id,
  tree_id,
  person_id,
  member_role
) values (
  'd2000000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001',
  'd4000000-0000-0000-0000-000000000001',
  'root'
);

select is(
  (
    select count(*)::integer
    from public.person_names
    where person_id = 'd4000000-0000-0000-0000-000000000001'
      and is_primary
      and metadata ->> 'source' = 'persons_projection'
  ),
  1,
  'INSERT still creates one canonical primary-name projection'
);

select is(
  (
    select count(*)::integer
    from public.person_timeline_events
    where person_id = 'd4000000-0000-0000-0000-000000000001'
      and event_type = 'birth'
      and event_date = '1900-01-02'
      and metadata ->> 'source' = 'persons_projection'
  ),
  1,
  'INSERT still creates the canonical birth projection'
);

create temporary table persons_bulk_upsert_snapshot (
  graph_version bigint not null,
  event_count integer not null,
  event_ids uuid[] not null
) on commit drop;

insert into persons_bulk_upsert_snapshot (graph_version, event_count, event_ids)
select
  tree.graph_version,
  (
    select count(*)::integer
    from public.person_timeline_events event
    where event.person_id = 'd4000000-0000-0000-0000-000000000001'
      and event.metadata ->> 'source' = 'persons_projection'
  ),
  (
    select array_agg(event.id order by event.id)
    from public.person_timeline_events event
    where event.person_id = 'd4000000-0000-0000-0000-000000000001'
      and event.metadata ->> 'source' = 'persons_projection'
  )
from public.family_trees tree
where tree.id = 'd3000000-0000-0000-0000-000000000001';

-- Mirrors PostgREST UPSERT: every projected/display column appears in the
-- UPDATE target list even though none of its values changed.
update public.persons
set status = status,
    gender = gender,
    surname = surname,
    given_name = given_name,
    patronymic = patronymic,
    full_name = full_name,
    birth_date = birth_date,
    birth_year_from = birth_year_from,
    birth_year_to = birth_year_to,
    birth_place = birth_place,
    marriage_date = marriage_date,
    marriage_place = marriage_place,
    death_date = death_date,
    death_year_from = death_year_from,
    death_year_to = death_year_to,
    death_place = death_place,
    residence_places = residence_places,
    is_living = is_living,
    privacy_status = privacy_status
where id = 'd4000000-0000-0000-0000-000000000001';

select is(
  (
    select count(*)::integer
    from public.person_timeline_events
    where person_id = 'd4000000-0000-0000-0000-000000000001'
      and metadata ->> 'source' = 'persons_projection'
  ),
  (select event_count from persons_bulk_upsert_snapshot),
  'no-op UPSERT does not change the number of projection events'
);

select is(
  (
    select array_agg(event.id order by event.id)
    from public.person_timeline_events event
    where event.person_id = 'd4000000-0000-0000-0000-000000000001'
      and event.metadata ->> 'source' = 'persons_projection'
  ),
  (select event_ids from persons_bulk_upsert_snapshot),
  'no-op UPSERT does not delete and recreate projection events'
);

select is(
  (
    select graph_version
    from public.family_trees
    where id = 'd3000000-0000-0000-0000-000000000001'
  ),
  (select graph_version from persons_bulk_upsert_snapshot),
  'no-op UPSERT does not invalidate the family-tree graph'
);

update public.persons
set full_name = 'Fixture Person Updated',
    birth_date = '1900-02-03'
where id = 'd4000000-0000-0000-0000-000000000001';

select is(
  (
    select full_name
    from public.person_names
    where person_id = 'd4000000-0000-0000-0000-000000000001'
      and is_primary
  ),
  'Fixture Person Updated',
  'a real name change still refreshes the canonical projection'
);

select is(
  (
    select event_date
    from public.person_timeline_events
    where person_id = 'd4000000-0000-0000-0000-000000000001'
      and event_type = 'birth'
      and metadata ->> 'source' = 'persons_projection'
  ),
  '1900-02-03',
  'a real birth-date change still refreshes the timeline projection'
);

select ok(
  (
    select array_agg(event.id order by event.id)
    from public.person_timeline_events event
    where event.person_id = 'd4000000-0000-0000-0000-000000000001'
      and event.metadata ->> 'source' = 'persons_projection'
  ) is distinct from (select event_ids from persons_bulk_upsert_snapshot),
  'a real projection change rebuilds generated timeline rows'
);

select is(
  (
    select graph_version
    from public.family_trees
    where id = 'd3000000-0000-0000-0000-000000000001'
  ),
  (select graph_version + 1 from persons_bulk_upsert_snapshot),
  'a real display change increments graph_version exactly once'
);

select * from finish();
rollback;
