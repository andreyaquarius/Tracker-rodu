begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(21);

select has_function(
  'security_private', 'sync_person_event_places_from_person_v1', array[]::text[],
  'person save bridge function exists'
);
select has_trigger(
  'public', 'persons', 'zz_persons_historical_place_event_bridge_insert',
  'person insert atomically projects stable event-place links'
);
select has_trigger(
  'public', 'persons', 'zz_persons_historical_place_event_bridge_update',
  'person update atomically reconciles stable event-place links'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'fb100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'place-bridge@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'fb100000-0000-4000-8000-000000000001',
  'place-bridge@example.test', 'Place bridge owner'
) on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name) values (
  'fb200000-0000-4000-8000-000000000001',
  'fb100000-0000-4000-8000-000000000001',
  'Place bridge project'
);

insert into public.researches (id, project_id, title, created_by) values (
  'fb300000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001',
  'Place bridge research',
  'fb100000-0000-4000-8000-000000000001'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, status,
  verification_status, created_by
) values (
  'fb500000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001',
  'Трубіївка', 'Трубіївка', 'active', 'unverified',
  'fb100000-0000-4000-8000-000000000001'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fb100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, birth_date, birth_place,
  marriage_date, marriage_place, death_date, death_place, is_living,
  privacy_status, custom_fields, created_by
) values (
  'fb400000-0000-4000-8000-000000000001',
  'fb200000-0000-4000-8000-000000000001',
  'fb300000-0000-4000-8000-000000000001',
  'proven', 'unknown', 'Тестова', 'Особа', '', 'Тестова Особа',
  '1862-07-01', 'Трубіївка',
  '1881-02-03', 'Трубіївка, церква',
  '1912-11-12', 'Трубіївка, кладовище', false, 'project',
  jsonb_build_object('__trackerRoduPersonEvents', jsonb_build_array(
    jsonb_build_object(
      'id', 'birth', 'type', 'birth', 'title', 'Народження',
      'date', '1862-07-01', 'placeName', 'Трубіївка (для картки)',
      'placeId', 'fb500000-0000-4000-8000-000000000001',
      'placeOriginalText', 'села Трубіевки',
      'placeResolutionStatus', 'confirmed'
    ),
    jsonb_build_object(
      'id', 'marriage', 'type', 'marriage', 'title', 'Шлюб',
      'date', '1881-02-03', 'placeName', 'Трубіївка, церква',
      'placeId', 'fb500000-0000-4000-8000-000000000001',
      'placeOriginalText', 'въ церкви села Трубіевки',
      'placeResolutionStatus', 'confirmed'
    ),
    jsonb_build_object(
      'id', 'death', 'type', 'death', 'title', 'Смерть',
      'date', '1912-11-12', 'placeName', 'Трубіївка, кладовище',
      'placeId', 'fb500000-0000-4000-8000-000000000001',
      'placeOriginalText', 'умеръ въ селѣ Трубіевкѣ',
      'placeResolutionStatus', 'confirmed'
    ),
    jsonb_build_object(
      'id', 'custom-census-a', 'type', 'census', 'title', 'Перепис A',
      'date', '1862–1865', 'placeName', 'Трубіївка, повіт',
      'placeId', 'fb500000-0000-4000-8000-000000000001',
      'placeOriginalText', 'въ селѣ Трубіевкѣ',
      'placeResolutionStatus', 'confirmed'
    ),
    jsonb_build_object(
      'id', 'custom-census-b', 'type', 'census', 'title', 'Перепис B',
      'date', 'після 1865', 'placeName', 'Трубіївка',
      'placeId', null, 'placeOriginalText', 'Трубіевка',
      'placeResolutionStatus', 'unresolved'
    )
  )),
  'fb100000-0000-4000-8000-000000000001'
);

select is(
  (
    select count(*)::integer
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.event_type in ('birth', 'marriage', 'death')
      and event_row.place_id = 'fb500000-0000-4000-8000-000000000001'
      and event_row.place_resolution_status = 'confirmed'
  ),
  3,
  'birth, marriage, and death projections all retain their confirmed historical Place identity'
);

select is(
  (
    select row(event_row.place_name, event_row.place_original_text, event_row.date_text)::text
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.event_type = 'marriage'
      and event_row.metadata ->> 'source' = 'persons_projection'
  ),
  row('Трубіївка, церква', 'въ церкви села Трубіевки', '1881-02-03')::text,
  'marriage keeps legacy display, exact source wording, and date as separate values'
);

select is(
  (
    select row(event_row.place_name, event_row.place_original_text, event_row.date_text)::text
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.event_type = 'death'
      and event_row.metadata ->> 'source' = 'persons_projection'
  ),
  row('Трубіївка, кладовище', 'умеръ въ селѣ Трубіевкѣ', '1912-11-12')::text,
  'death keeps legacy display, exact source wording, and date as separate values'
);

select is(
  (
    select count(*)::integer
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.event_type = 'census'
  ),
  2,
  'multiple events of one type are retained by distinct client identities'
);

select is(
  (
    select event_row.place_original_text
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'clientEventId' = 'custom-census-a'
  ),
  'въ селѣ Трубіевкѣ',
  'exact source wording is not replaced by the canonical or display name'
);

select is(
  (
    select event_row.place_name
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'clientEventId' = 'custom-census-a'
  ),
  'Трубіївка, повіт',
  'legacy display place stays independent from exact source wording'
);

select is(
  (
    select row(event_row.event_date, event_row.date_from, event_row.date_to, event_row.date_text)::text
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'clientEventId' = 'custom-census-a'
  ),
  row('', '', '', '1862–1865')::text,
  'a period remains exact text and does not invent a calendar day'
);

create temp table bridge_event_ids as
select event_row.metadata ->> 'clientEventId' as client_event_id, event_row.id
from public.person_timeline_events event_row
where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
  and event_row.metadata ? 'clientEventId';

update public.persons person_row
set custom_fields = jsonb_set(
  person_row.custom_fields,
  '{__trackerRoduPersonEvents}',
  (
    select jsonb_agg(item.value order by item.position desc)
    from jsonb_array_elements(
      person_row.custom_fields -> '__trackerRoduPersonEvents'
    ) with ordinality item(value, position)
  )
)
where person_row.id = 'fb400000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from bridge_event_ids saved
    join public.person_timeline_events current_event
      on current_event.id = saved.id
     and current_event.metadata ->> 'clientEventId' = saved.client_event_id
  ),
  5,
  'reordering the saved JSON keeps every projected event id stable'
);

-- Compatibility contract: an older client can round-trip the event JSON
-- without fields introduced by the historical-place module. That must not
-- silently detach a canonical place selected by a newer client.
update public.persons person_row
set custom_fields = jsonb_set(
  person_row.custom_fields,
  '{__trackerRoduPersonEvents}',
  (
    select jsonb_agg(
      case
        when item.value ->> 'id' = 'custom-census-a' then
          (item.value - 'placeId' - 'placeOriginalText' - 'placeResolutionStatus')
          || jsonb_build_object('notes', 'Змінено старішим клієнтом')
        else item.value
      end
      order by item.position
    )
    from jsonb_array_elements(
      person_row.custom_fields -> '__trackerRoduPersonEvents'
    ) with ordinality item(value, position)
  )
)
where person_row.id = 'fb400000-0000-4000-8000-000000000001';

select is(
  (
    select row(
      event_row.place_id,
      event_row.place_original_text,
      event_row.place_resolution_status,
      event_row.notes
    )::text
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'clientEventId' = 'custom-census-a'
  ),
  row(
    'fb500000-0000-4000-8000-000000000001'::uuid,
    'въ селѣ Трубіевкѣ',
    'confirmed',
    'Змінено старішим клієнтом'
  )::text,
  'legacy event edits preserve an existing additive place link and exact wording'
);

update public.persons
set birth_date = '1862-07-02',
    marriage_date = '1881-02-04',
    death_date = '1912-11-13'
where id = 'fb400000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from public.person_timeline_events event_row
    join (values
      ('birth', '1862-07-02', 'села Трубіевки'),
      ('marriage', '1881-02-04', 'въ церкви села Трубіевки'),
      ('death', '1912-11-13', 'умеръ въ селѣ Трубіевкѣ')
    ) expected(event_type, date_text, original_text)
      on expected.event_type = event_row.event_type
     and expected.date_text = event_row.date_text
     and expected.original_text = event_row.place_original_text
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'source' = 'persons_projection'
      and event_row.place_id = 'fb500000-0000-4000-8000-000000000001'
  ),
  3,
  'projection rebuilds update all core dates without losing exact historical-place links'
);

select is(
  (
    select event_row.id
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.event_type = 'birth'
      and event_row.metadata ->> 'source' = 'persons_projection'
  ),
  (
    select saved.id from bridge_event_ids saved where saved.client_event_id = 'birth'
  ),
  'legacy projection rebuild returns the core event to its stable id'
);

select is(
  (
    select row(event_row.place_id, event_row.place_original_text)::text
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.event_type = 'birth'
      and event_row.metadata ->> 'source' = 'persons_projection'
  ),
  row('fb500000-0000-4000-8000-000000000001'::uuid, 'села Трубіевки')::text,
  'projection rebuild preserves canonical identity and exact wording'
);

select throws_ok(
  $$update public.persons
    set custom_fields = jsonb_build_object(
      '__trackerRoduPersonEvents',
      jsonb_build_array(
        jsonb_build_object('id','duplicate','type','census','placeId',null),
        jsonb_build_object('id','duplicate','type','census','placeId',null)
      )
    )
    where id = 'fb400000-0000-4000-8000-000000000001'$$,
  '22023', 'PERSON_EVENT_CLIENT_ID_DUPLICATE',
  'duplicate client event identities fail closed instead of guessing by type'
);

update public.persons person_row
set custom_fields = jsonb_set(
  person_row.custom_fields,
  '{__trackerRoduPersonEvents}',
  (
    select jsonb_agg(item.value order by item.position)
    from jsonb_array_elements(
      person_row.custom_fields -> '__trackerRoduPersonEvents'
    ) with ordinality item(value, position)
    where item.value ->> 'id' <> 'custom-census-b'
  )
)
where person_row.id = 'fb400000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)::integer
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'clientEventId' = 'custom-census-b'
  ),
  0,
  'deleting one client event removes only its own bridge projection'
);

select is(
  (
    select count(*)::integer
    from public.person_timeline_events event_row
    where event_row.person_id = 'fb400000-0000-4000-8000-000000000001'
      and event_row.metadata ->> 'clientEventId' = 'custom-census-a'
  ),
  1,
  'a sibling event of the same type survives deletion unchanged'
);

reset role;

select is(
  security_private.person_event_exact_date_text_v1('31.12.1862'),
  '',
  'non-ISO exact text is not guessed or rewritten inside the database bridge'
);

select is(
  security_private.person_event_exact_date_text_v1('1862-12-31'),
  '1862-12-31',
  'a complete valid ISO date is retained as an exact event date'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'security_private.sync_person_event_places_from_person_v1()',
    'EXECUTE'
  ),
  'API roles cannot invoke the trusted person trigger body directly'
);

select * from finish();
rollback;
