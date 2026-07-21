begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

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
  'd8100000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'person-status-evidence@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'd8100000-0000-0000-0000-000000000001',
  'person-status-evidence@example.test',
  'Person status evidence owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'd8200000-0000-0000-0000-000000000001',
  'd8100000-0000-0000-0000-000000000001',
  'Person status evidence fixture'
);

insert into public.persons (
  id,
  project_id,
  status,
  gender,
  surname,
  given_name,
  full_name,
  birth_date,
  birth_place,
  created_by
) values (
  'd8300000-0000-0000-0000-000000000001',
  'd8200000-0000-0000-0000-000000000001',
  'відома документально',
  'жінка',
  'Документальна',
  'Особа',
  'Документальна Особа',
  '1900-01-02',
  'Київ',
  'd8100000-0000-0000-0000-000000000001'
);

select is(
  (
    select evidence_status
    from public.person_names
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and is_primary
  ),
  'proven',
  'documented knowledge projects the primary name as proven'
);

select is(
  (
    select evidence_status
    from public.person_timeline_events
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and event_type = 'birth'
      and metadata ->> 'source' = 'persons_projection'
  ),
  'proven',
  'documented knowledge projects generated events as proven'
);

update public.persons
set surname = 'Документальна-Оновлена',
    full_name = 'Документальна-Оновлена Особа'
where id = 'd8300000-0000-0000-0000-000000000001';

select is(
  (
    select evidence_status
    from public.person_names
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and is_primary
  ),
  'proven',
  'a later name edit preserves documented evidence'
);

select is(
  (
    select evidence_status
    from public.person_timeline_events
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and event_type = 'birth'
      and metadata ->> 'source' = 'persons_projection'
  ),
  'proven',
  'events rebuilt by a name edit retain documented evidence'
);

update public.persons
set status = 'відома з переказів'
where id = 'd8300000-0000-0000-0000-000000000001';

select is(
  (
    select evidence_status
    from public.person_names
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and is_primary
  ),
  'likely',
  'oral-tradition knowledge projects the primary name as likely'
);

select is(
  (
    select evidence_status
    from public.person_timeline_events
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and event_type = 'birth'
      and metadata ->> 'source' = 'persons_projection'
  ),
  'likely',
  'oral-tradition knowledge projects generated events as likely'
);

update public.persons
set status = 'відома особисто'
where id = 'd8300000-0000-0000-0000-000000000001';

select is(
  (
    select evidence_status
    from public.person_names
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and is_primary
  ),
  'proven',
  'personal knowledge projects the primary name as proven'
);

select is(
  (
    select evidence_status
    from public.person_timeline_events
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and event_type = 'birth'
      and metadata ->> 'source' = 'persons_projection'
  ),
  'proven',
  'personal knowledge projects generated events as proven'
);

update public.person_names
set updated_at = '2000-01-01 00:00:00+00'::timestamptz
where person_id = 'd8300000-0000-0000-0000-000000000001'
  and is_primary;

update public.person_timeline_events
set updated_at = '2000-01-01 00:00:00+00'::timestamptz
where person_id = 'd8300000-0000-0000-0000-000000000001'
  and metadata ->> 'source' = 'persons_projection';

-- Mirrors a PostgREST UPSERT whose target list includes every projected
-- column even though no stored value changed.
update public.persons
set status = status,
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
    residence_places = residence_places
where id = 'd8300000-0000-0000-0000-000000000001';

select is(
  (
    select updated_at
    from public.person_names
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and is_primary
  ),
  '2000-01-01 00:00:00+00'::timestamptz,
  'a no-op UPSERT does not rewrite the corrected primary name projection'
);

select is(
  (
    select count(*)::integer
    from public.person_timeline_events
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and metadata ->> 'source' = 'persons_projection'
      and updated_at = '2000-01-01 00:00:00+00'::timestamptz
  ),
  (
    select count(*)::integer
    from public.person_timeline_events
    where person_id = 'd8300000-0000-0000-0000-000000000001'
      and metadata ->> 'source' = 'persons_projection'
  ),
  'a no-op UPSERT neither rebuilds nor rewrites corrected timeline projections'
);

select * from finish();
rollback;
