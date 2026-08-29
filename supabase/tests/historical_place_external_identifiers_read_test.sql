begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(7);

select has_function(
  'public',
  'list_place_external_identifiers_v1',
  array['uuid'],
  'external identifier read contract exists'
);

select ok(
  not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.list_place_external_identifiers_v1(uuid)'::regprocedure),
  'public external identifier reader is a SECURITY INVOKER facade'
);

select ok(
  (select prosecdef from pg_catalog.pg_proc
   where oid = 'security_private.list_place_external_identifiers_v1(uuid)'::regprocedure),
  'private external identifier reader owns the checked SECURITY DEFINER body'
);

select ok(
  has_function_privilege('authenticated', 'public.list_place_external_identifiers_v1(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_place_external_identifiers_v1(uuid)', 'EXECUTE'),
  'only signed-in clients can call the public reader'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'fe100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'place-identifiers@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'fe100000-0000-4000-8000-000000000001',
  'place-identifiers@example.test',
  'Place identifiers owner'
)
on conflict (user_id) do update set
  email = excluded.email,
  display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values (
  'fe200000-0000-4000-8000-000000000001',
  'fe100000-0000-4000-8000-000000000001',
  'Place identifiers project'
);

insert into public.places (
  id, project_id, canonical_name, status, verification_status, created_by
) values (
  'fe300000-0000-4000-8000-000000000001',
  'fe200000-0000-4000-8000-000000000001',
  'Тестове місце', 'active', 'unverified',
  'fe100000-0000-4000-8000-000000000001'
);

insert into public.place_external_identifiers (
  id, place_id, provider, external_identifier, is_primary, created_by
) values
(
  'fe400000-0000-4000-8000-000000000001',
  'fe300000-0000-4000-8000-000000000001',
  'wikidata', 'Q12345', true,
  'fe100000-0000-4000-8000-000000000001'
),
(
  'fe400000-0000-4000-8000-000000000002',
  'fe300000-0000-4000-8000-000000000001',
  'osm', 'node/123', false,
  'fe100000-0000-4000-8000-000000000001'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fe100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  jsonb_array_length(public.list_place_external_identifiers_v1(
    'fe300000-0000-4000-8000-000000000001'
  )),
  2,
  'reader returns every identifier for the place'
);

select is(
  public.list_place_external_identifiers_v1(
    'fe300000-0000-4000-8000-000000000001'
  ) #>> '{0,provider}',
  'wikidata',
  'primary identifier is returned first'
);

select is(
  public.list_place_external_identifiers_v1(
    'fe300000-0000-4000-8000-000000000001'
  ) #>> '{1,externalIdentifier}',
  'node/123',
  'identifier values round-trip without normalization loss'
);

select * from finish();
rollback;
