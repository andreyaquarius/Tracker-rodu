begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(4);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'ff100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'place-retry@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'ff100000-0000-4000-8000-000000000001', 'place-retry@example.test', 'Retry owner'
)
on conflict (user_id) do update set
  email = excluded.email,
  display_name = excluded.display_name;
insert into public.projects (id, owner_id, name) values (
  'ff200000-0000-4000-8000-000000000001',
  'ff100000-0000-4000-8000-000000000001', 'Retry project'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ff100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select set_config(
  'test.retry_place_id',
  public.create_project_place_v2(
    'ff200000-0000-4000-8000-000000000001',
    '{"canonicalName":"Місце повторного збереження","placeType":"village","wikidataId":"Q987","externalIds":{"osm":"node/987"}}'::jsonb
  ) #>> '{place,id}',
  true
);

select lives_ok(
  format(
    'select public.patch_project_place_v2(%L::uuid,%s,%L::jsonb)',
    current_setting('test.retry_place_id'),
    (select lock_version from public.places where id = current_setting('test.retry_place_id')::uuid),
    '{"canonicalName":"Місце повторного збереження","description":"повторно збережено","placeType":"village","wikidataId":"Q987","externalIds":{"osm":"node/987"}}'
  ),
  'an unchanged full-profile payload can be saved again'
);

select is(
  (select count(*) from public.place_type_assignments
   where place_id = current_setting('test.retry_place_id')::uuid),
  1::bigint,
  'retry does not create a duplicate type assignment'
);

select is(
  (select count(*) from public.place_external_identifiers
   where place_id = current_setting('test.retry_place_id')::uuid),
  2::bigint,
  'retry does not create duplicate external identifiers'
);

select is(
  (select description from public.places
   where id = current_setting('test.retry_place_id')::uuid),
  'повторно збережено',
  'the ordinary profile edit is committed during an idempotent retry'
);

select * from finish();
rollback;
