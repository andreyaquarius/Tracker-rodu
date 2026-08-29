begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(33);

select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid =
      'security_private.historical_place_audit_log'::regclass
      and constraint_row.conname =
        'historical_place_audit_log_project_id_fkey'
      and constraint_row.confdeltype = 'c'
  ),
  'historical-place audit project ownership cascades on project deletion'
);

select ok(
  to_regclass('public.person_timeline_events_project_place_date_idx') is not null
  and pg_get_indexdef(
    'public.person_timeline_events_project_place_date_idx'::regclass
  ) like '%(project_id, place_id, event_date, id)%WHERE (place_id IS NOT NULL)%',
  'person event place/date profile index exists with a partial predicate'
);

select has_function(
  'public', 'get_place_profile_v1', array['uuid', 'date'],
  'place profile RPC exists'
);
select has_function(
  'public', 'list_place_names_v1', array['uuid'],
  'place names RPC exists'
);
select has_function(
  'public', 'list_place_hierarchy_history_v1', array['uuid'],
  'place hierarchy history RPC exists'
);
select has_function(
  'public', 'set_person_event_place_v1',
  array['uuid', 'uuid', 'text', 'text', 'timestamp with time zone'],
  'person event place setter RPC exists'
);
select has_function(
  'public', 'clear_person_event_place_v1',
  array['uuid', 'boolean', 'timestamp with time zone'],
  'person event place clearer RPC exists'
);

select ok(
  not (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'public.get_place_profile_v1(uuid,date)'::regprocedure
  )
  and (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'security_private.get_place_profile_v1(uuid,date)'::regprocedure
  ),
  'public profile API is an invoker facade over a trusted definer body'
);

select ok(
  not has_function_privilege(
    'anon', 'public.get_place_profile_v1(uuid,date)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.set_person_event_place_v1(uuid,uuid,text,text,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'authenticated', 'public.get_place_profile_v1(uuid,date)', 'EXECUTE'
  )
  and has_function_privilege(
    'authenticated',
    'public.set_person_event_place_v1(uuid,uuid,text,text,timestamptz)',
    'EXECUTE'
  ),
  'rich place APIs are authenticated-only'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  'fa100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'places-core-owner@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  now(), now()
),
(
  '00000000-0000-0000-0000-000000000000',
  'fa100000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'places-core-other@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  now(), now()
);

insert into public.profiles (user_id, email, display_name) values
(
  'fa100000-0000-4000-8000-000000000001',
  'places-core-owner@example.test', 'Places core owner'
),
(
  'fa100000-0000-4000-8000-000000000002',
  'places-core-other@example.test', 'Places core other'
)
on conflict (user_id) do update set
  email = excluded.email,
  display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
(
  'fa200000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000001',
  'Places core owner project'
),
(
  'fa200000-0000-4000-8000-000000000002',
  'fa100000-0000-4000-8000-000000000002',
  'Places core other project'
),
(
  'fa200000-0000-4000-8000-000000000003',
  'fa100000-0000-4000-8000-000000000001',
  'Places core cascade project'
);

insert into public.researches (id, project_id, title, created_by)
values (
  'fa300000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Places core research',
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, is_living, privacy_status, created_by
) values (
  'fa400000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'fa300000-0000-4000-8000-000000000001',
  'proven', 'unknown', 'Тестова', 'Особа', '', 'Тестова Особа',
  false, 'project', 'fa100000-0000-4000-8000-000000000001'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, status,
  verification_status, created_by
) values
(
  'fa500000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Трубіївка', 'Трубіївка', 'active', 'unverified',
  'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'Старий повіт', 'Сучасний район', 'active', 'unverified',
  'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000003',
  'fa200000-0000-4000-8000-000000000001',
  'Новий район', '', 'active', 'unverified',
  'fa100000-0000-4000-8000-000000000001'
),
(
  'fa500000-0000-4000-8000-000000000004',
  'fa200000-0000-4000-8000-000000000002',
  'Чуже приватне місце', '', 'active', 'unverified',
  'fa100000-0000-4000-8000-000000000002'
);

insert into public.place_names (
  id, place_id, project_id, name, original_text, language_code,
  name_type, valid_from, valid_to, is_primary, created_by
) values
(
  'fa600000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Трубіевка', 'села Трубіевки', 'uk', 'historical',
  '1800-01-01', '1899-12-31', false,
  'fa100000-0000-4000-8000-000000000001'
),
(
  'fa600000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'Трубіївка', 'Трубіївка', 'uk', 'official',
  '1900-01-01', null, true,
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.place_type_assignments (
  id, place_id, project_id, place_type_code, is_primary, created_by
) values (
  'fa650000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'village', true,
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.place_hierarchy_relations (
  id, child_place_id, parent_place_id, project_id, relation_type,
  valid_from, valid_to, confidence, created_by
) values
(
  'fa700000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000002',
  'fa200000-0000-4000-8000-000000000001',
  'administrative_parent', '1800-01-01', '1899-12-31', 90,
  'fa100000-0000-4000-8000-000000000001'
),
(
  'fa700000-0000-4000-8000-000000000002',
  'fa500000-0000-4000-8000-000000000001',
  'fa500000-0000-4000-8000-000000000003',
  'fa200000-0000-4000-8000-000000000001',
  'administrative_parent', '1900-01-01', null, 95,
  'fa100000-0000-4000-8000-000000000001'
);

insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date,
  place_name, place_original_text, place_resolution_status, metadata
) values (
  'fa800000-0000-4000-8000-000000000001',
  'fa200000-0000-4000-8000-000000000001',
  'fa400000-0000-4000-8000-000000000001',
  'birth', 'Народження', '1862-07-01',
  'с. Трубіевка', 'села Трубіевки', 'unresolved', '{}'::jsonb
);

insert into security_private.historical_place_audit_log (
  entity_table, entity_id, place_id, project_id, actor_id,
  action, before_data, after_data
) values (
  'places', null, null,
  'fa200000-0000-4000-8000-000000000003',
  'fa100000-0000-4000-8000-000000000001',
  'insert', null, '{"fixture":true}'::jsonb
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01'
  ) #>> '{activeName,name}',
  'Трубіевка',
  'profile resolves the historically active place name'
);

select is(
  public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01'
  ) #>> '{place,placeType}',
  'village',
  'profile returns the active time-aware place type assignment'
);

select is(
  public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01'
  ) #>> '{hierarchy,hierarchy,0,place,canonicalName}',
  'Старий повіт',
  'profile embeds the hierarchy active at the requested date'
);

select is(
  public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01'
  ) #>> '{hierarchy,hierarchy,0,place,displayName}',
  'Старий повіт',
  'dated hierarchy falls back to the historical canonical name, not modern_name'
);

select is(
  public.search_places_v1(
    'Старий повіт', '1862-07-01',
    'fa200000-0000-4000-8000-000000000001', 20
  ) #>> '{0,displayName}',
  'Старий повіт',
  'dated search falls back to the historical canonical name, not modern_name'
);

select is(
  public.resolve_place_hierarchy_v1(
    'fa500000-0000-4000-8000-000000000001', '1862-07-01', 12
  ) #>> '{hierarchy,0,place,canonicalName}',
  'Старий повіт',
  'hierarchy resolver selects the old administrative parent'
);

select is(
  public.resolve_place_hierarchy_v1(
    'fa500000-0000-4000-8000-000000000001', '1910-01-01', 12
  ) #>> '{hierarchy,0,place,canonicalName}',
  'Новий район',
  'hierarchy resolver selects the later administrative parent'
);

select is(
  jsonb_array_length(public.list_place_names_v1(
    'fa500000-0000-4000-8000-000000000001'
  )),
  2,
  'member can read the complete name timeline'
);

select is(
  public.list_place_names_v1(
    'fa500000-0000-4000-8000-000000000001'
  ) #>> '{0,lockVersion}',
  '1',
  'name timeline returns the optimistic lock version required for updates'
);

select is(
  jsonb_array_length(public.list_place_hierarchy_history_v1(
    'fa500000-0000-4000-8000-000000000001'
  )),
  2,
  'member can read both periods of hierarchy history'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.get_place_profile_v1(
    'fa500000-0000-4000-8000-000000000001', null
  )$$,
  '42501', 'PLACE_ACCESS_REQUIRED',
  'non-member cannot read a private place profile'
);

select throws_ok(
  $$select public.list_place_names_v1(
    'fa500000-0000-4000-8000-000000000001'
  )$$,
  '42501', 'PLACE_ACCESS_REQUIRED',
  'non-member cannot read private place names'
);

select throws_ok(
  $$select public.list_place_hierarchy_history_v1(
    'fa500000-0000-4000-8000-000000000001'
  )$$,
  '42501', 'PLACE_ACCESS_REQUIRED',
  'non-member cannot read private hierarchy history'
);

select throws_ok(
  $$select public.set_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000001',
    'села Трубіевки', 'confirmed', null
  )$$,
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED',
  'non-editor cannot change another project event place'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fa100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.set_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000001',
    'села Трубіевки', 'confirmed', null
  ) ->> 'placeId',
  'fa500000-0000-4000-8000-000000000001',
  'editor can confirm a project event place'
);

select is(
  (
    select event_row.place_original_text
    from public.person_timeline_events event_row
    where event_row.id = 'fa800000-0000-4000-8000-000000000001'
  ),
  'села Трубіевки',
  'confirming a canonical place keeps exact source wording'
);

select is(
  public.set_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000003',
    null, 'needs_review', null
  ) ->> 'placeOriginalText',
  'села Трубіевки',
  'omitting original text preserves the previous exact wording'
);

select is(
  (public.clear_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001', true, null
  ) ->> 'resolutionStatus'),
  'unresolved',
  'clearing a link returns the event to unresolved status'
);

select is(
  (
    select row(
      event_row.place_id,
      event_row.place_original_text,
      event_row.place_resolution_status
    )::text
    from public.person_timeline_events event_row
    where event_row.id = 'fa800000-0000-4000-8000-000000000001'
  ),
  row(null::uuid, 'села Трубіевки', 'unresolved')::text,
  'clear preserves original wording while removing only the canonical link'
);

select throws_ok(
  $$select public.set_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000004',
    null, 'confirmed', null
  )$$,
  '22023', 'PERSON_EVENT_PLACE_SCOPE_MISMATCH',
  'an event cannot link to another project private place'
);

select throws_ok(
  $$select public.set_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000001',
    null, 'confirmed', '2000-01-01 00:00:00+00'::timestamptz
  )$$,
  '40001', 'PERSON_EVENT_VERSION_CONFLICT',
  'stale clients cannot overwrite a newer event place link'
);

do $do$
begin
  perform public.set_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001',
    'fa500000-0000-4000-8000-000000000001',
    null, 'confirmed', null
  );
  perform public.clear_person_event_place_v1(
    'fa800000-0000-4000-8000-000000000001', false, null
  );
end;
$do$;

select is(
  (
    select event_row.place_original_text
    from public.person_timeline_events event_row
    where event_row.id = 'fa800000-0000-4000-8000-000000000001'
  ),
  '',
  'explicit destructive clear can remove copied original wording'
);

update public.person_timeline_events
set place_original_text = ''
where id = 'fa800000-0000-4000-8000-000000000001';

select is(
  (
    select event_row.place_original_text
    from public.person_timeline_events event_row
    where event_row.id = 'fa800000-0000-4000-8000-000000000001'
  ),
  'с. Трубіевка',
  'ordinary updates cannot forge the private clear marker or erase source wording'
);

reset role;

delete from public.projects
where id = 'fa200000-0000-4000-8000-000000000003';

select is(
  (
    select count(*)::integer
    from security_private.historical_place_audit_log audit_row
    where audit_row.project_id = 'fa200000-0000-4000-8000-000000000003'
  ),
  0,
  'project deletion cascades private historical-place audit rows'
);

select * from finish();
rollback;
