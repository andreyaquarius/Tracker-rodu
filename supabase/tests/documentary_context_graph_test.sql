begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_function(
  'public', 'get_person_documentary_context_graph_v1',
  array['uuid', 'uuid', 'integer', 'text[]', 'text[]', 'text[]', 'integer', 'integer', 'uuid', 'integer', 'integer'],
  'bounded documentary context graph RPC exists'
);

select ok(
  not (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'public.get_person_documentary_context_graph_v1(uuid,uuid,integer,text[],text[],text[],integer,integer,uuid,integer,integer)'::regprocedure
  )
  and (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'security_private.get_person_documentary_context_graph_v1(uuid,uuid,integer,text[],text[],text[],integer,integer,uuid,integer,integer)'::regprocedure
  ),
  'public documentary API is an invoker facade over a checked private body'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.get_person_documentary_context_graph_v1(uuid,uuid,integer,text[],text[],text[],integer,integer,uuid,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.get_person_documentary_context_graph_v1(uuid,uuid,integer,text[],text[],text[],integer,integer,uuid,integer,integer)',
    'EXECUTE'
  ),
  'authenticated members use the documentary RPC and anonymous callers cannot execute it'
);

select ok(
  (
    select count(*) = 3
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname in (
      'findings_document_project_fkey',
      'person_timeline_events_document_project_fkey',
      'person_timeline_events_finding_project_fkey'
    )
      and constraint_row.contype = 'f'
      and constraint_row.convalidated
  ),
  'documentary source foreign keys are validated and project-consistent'
);

delete from public.projects
where id in (
  'da200000-0000-4000-8000-000000000001',
  'da200000-0000-4000-8000-000000000002'
);

delete from auth.users
where id in (
  'da100000-0000-4000-8000-000000000001',
  'da100000-0000-4000-8000-000000000002',
  'da100000-0000-4000-8000-000000000003'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'da100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'documentary-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'da100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'documentary-editor@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'da100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'documentary-viewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('da100000-0000-4000-8000-000000000001', 'documentary-owner@example.test', 'Documentary owner'),
  ('da100000-0000-4000-8000-000000000002', 'documentary-editor@example.test', 'Documentary editor'),
  ('da100000-0000-4000-8000-000000000003', 'documentary-viewer@example.test', 'Documentary viewer')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
  ('da200000-0000-4000-8000-000000000001', 'da100000-0000-4000-8000-000000000001', 'Documentary graph fixture'),
  ('da200000-0000-4000-8000-000000000002', 'da100000-0000-4000-8000-000000000001', 'Foreign documentary fixture');

insert into public.project_members (project_id, user_id, role, invited_by) values
  ('da200000-0000-4000-8000-000000000001', 'da100000-0000-4000-8000-000000000002', 'editor', 'da100000-0000-4000-8000-000000000001'),
  ('da200000-0000-4000-8000-000000000001', 'da100000-0000-4000-8000-000000000003', 'viewer', 'da100000-0000-4000-8000-000000000001');

insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
) values
  ('da300000-0000-4000-8000-000000000001', 'da200000-0000-4000-8000-000000000001', 'Documentary center', false, 'project', 'da100000-0000-4000-8000-000000000001'),
  ('da300000-0000-4000-8000-000000000002', 'da200000-0000-4000-8000-000000000001', 'Documentary participant', false, 'project', 'da100000-0000-4000-8000-000000000001'),
  ('da300000-0000-4000-8000-000000000003', 'da200000-0000-4000-8000-000000000001', 'Secret living participant', true, 'private', 'da100000-0000-4000-8000-000000000001'),
  ('da300000-0000-4000-8000-000000000004', 'da200000-0000-4000-8000-000000000001', 'Secret living center', true, 'confidential', 'da100000-0000-4000-8000-000000000001'),
  ('da300000-0000-4000-8000-000000000005', 'da200000-0000-4000-8000-000000000002', 'Foreign project person', false, 'project', 'da100000-0000-4000-8000-000000000001'),
  ('da300000-0000-4000-8000-000000000006', 'da200000-0000-4000-8000-000000000001', 'Unconfirmed place center', false, 'project', 'da100000-0000-4000-8000-000000000001');

insert into public.documents (
  id, project_id, title, document_type, file_reference, year_from, year_to,
  url, notes, created_by
) values (
  'da400000-0000-4000-8000-000000000001',
  'da200000-0000-4000-8000-000000000001',
  'SECRET_DOCUMENT_TITLE', 'parish_register', 'SECRET_FILE_REFERENCE',
  '1877', '1877', 'https://secret-document.example.test', 'SECRET_DOCUMENT_NOTES',
  'da100000-0000-4000-8000-000000000001'
);

insert into public.findings (
  id, project_id, document_id, finding_type, event_date, place, page,
  transcription, reliability, notes, source_url, created_by
) values (
  'da500000-0000-4000-8000-000000000001',
  'da200000-0000-4000-8000-000000000001',
  'da400000-0000-4000-8000-000000000001',
  'marriage_record', '1877-05-09', 'UNCONFIRMED_RAW_PLACE', '12',
  'SECRET_TRANSCRIPTION', 'likely', 'SECRET_FINDING_NOTES',
  'https://secret-finding.example.test',
  'da100000-0000-4000-8000-000000000001'
);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role, notes
) values
  ('da600000-0000-4000-8000-000000000001', 'da200000-0000-4000-8000-000000000001', 'da500000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000001', 'Center as written', 'subject', 'SECRET_PARTICIPANT_NOTE'),
  ('da600000-0000-4000-8000-000000000002', 'da200000-0000-4000-8000-000000000001', 'da500000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000002', 'Participant as written', 'witness', ''),
  ('da600000-0000-4000-8000-000000000003', 'da200000-0000-4000-8000-000000000001', 'da500000-0000-4000-8000-000000000001', 'da300000-0000-4000-8000-000000000003', 'Private participant as written', 'witness', '');

insert into public.places (
  id, project_id, canonical_name, modern_name, latitude, longitude,
  status, verification_status, created_by
) values
  (
  'da700000-0000-4000-8000-000000000001',
  'da200000-0000-4000-8000-000000000001',
  'Тестове історичне місце', 'Тестове сучасне місце', 49.1, 28.2,
  'active', 'verified', 'da100000-0000-4000-8000-000000000001'
  ),
  (
  'da700000-0000-4000-8000-000000000002',
  'da200000-0000-4000-8000-000000000001',
  'Непідтверджене тестове місце', 'Непідтверджене сучасне місце', 49.2, 28.3,
  'active', 'verified', 'da100000-0000-4000-8000-000000000001'
  );

insert into public.document_place_links (
  id, document_id, place_id, project_id, relation_type, original_text,
  source_finding_id, resolution_status, created_by
) values (
  'da900000-0000-4000-8000-000000000001',
  'da400000-0000-4000-8000-000000000001',
  'da700000-0000-4000-8000-000000000001',
  'da200000-0000-4000-8000-000000000001',
  'mentions', 'Тестове місце у джерелі',
  'da500000-0000-4000-8000-000000000001', 'confirmed',
  'da100000-0000-4000-8000-000000000001'
);

insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date, date_text,
  place_name, place_id, place_original_text, place_resolution_status,
  event_role, evidence_status, confidence, source_document_id,
  source_finding_id, notes
) values
  (
  'da800000-0000-4000-8000-000000000001',
  'da200000-0000-4000-8000-000000000001',
  'da300000-0000-4000-8000-000000000001',
  'marriage', 'SECRET_EVENT_TITLE', '1877-05-09', '9 травня 1877',
  'UNCONFIRMED_EVENT_PLACE_TEXT', 'da700000-0000-4000-8000-000000000001',
  'Подільська губернія', 'confirmed', 'subject', 'likely', 80,
  'da400000-0000-4000-8000-000000000001',
  'da500000-0000-4000-8000-000000000001', 'SECRET_EVENT_NOTES'
  ),
  (
  'da800000-0000-4000-8000-000000000003',
  'da200000-0000-4000-8000-000000000001',
  'da300000-0000-4000-8000-000000000006',
  'residence', 'UNCONFIRMED_EVENT_TITLE', '1880', '1880',
  'UNCONFIRMED_EVENT_PLACE_NAME', 'da700000-0000-4000-8000-000000000002',
  'UNCONFIRMED_EVENT_PLACE_ORIGINAL', 'needs_review', 'subject', 'unknown', 40,
  null, null, 'UNCONFIRMED_EVENT_NOTES'
  );

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"da100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select set_config(
  'test.documentary_graph',
  public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 250
  )::text,
  true
);

select is(
  jsonb_array_length(current_setting('test.documentary_graph')::jsonb->'nodes'),
  6,
  'viewer graph contains center, finding, event, document, confirmed place and public participant'
);

select is(
  jsonb_array_length(current_setting('test.documentary_graph')::jsonb->'edges'),
  9,
  'viewer graph returns the de-duplicated documentary paths without pairwise person edges'
);

select is(
  (
    select count(distinct node->>'entityType')::integer
    from jsonb_array_elements(current_setting('test.documentary_graph')::jsonb->'nodes') node
  ),
  5,
  'all five documentary entity kinds are represented'
);

select ok(
  current_setting('test.documentary_graph') not like '%SECRET_%'
  and current_setting('test.documentary_graph') not like '%UNCONFIRMED_%'
  and current_setting('test.documentary_graph') not like '%secret-document.example.test%'
  and current_setting('test.documentary_graph') not like '%secret-finding.example.test%',
  'viewer payload omits source bodies, notes, URLs and unconfirmed place text'
);

select ok(
  current_setting('test.documentary_graph') not like '%da300000-0000-4000-8000-000000000003%'
  and current_setting('test.documentary_graph') not like '%Secret living participant%',
  'private living co-participant is removed before graph assembly'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(current_setting('test.documentary_graph')::jsonb->'edges') edge
    where not exists (
      select 1 from jsonb_array_elements(current_setting('test.documentary_graph')::jsonb->'nodes') node
      where node->>'id' = edge->>'source'
    ) or not exists (
      select 1 from jsonb_array_elements(current_setting('test.documentary_graph')::jsonb->'nodes') node
      where node->>'id' = edge->>'target'
    )
  ),
  'every returned edge has two returned endpoints'
);

select is(
  jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    1, null, null, null, null, null, null, 100, 250
  )->'nodes'),
  4,
  'depth one contains only the center and direct documentary nodes'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.get_person_documentary_context_graph_v1(
      'da200000-0000-4000-8000-000000000001',
      'da300000-0000-4000-8000-000000000001',
      2, array['person','finding']::text[], null, null,
      null, null, null, 100, 250
    )->'edges') edge
    where split_part(edge->>'source', ':', 1) not in ('person','finding')
       or split_part(edge->>'target', ':', 1) not in ('person','finding')
  ),
  'entity filters cannot leave edges to omitted node kinds'
);

select is(
  jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, 1900, 1901, null, 100, 250
  )->'nodes'),
  1,
  'year filter outside the fixture period leaves only the center person'
);

select is(
  jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null,
    'da700000-0000-4000-8000-000000000001', 100, 250
  )->'nodes'),
  6,
  'confirmed canonical place filter retains its complete documentary path'
);

select ok(
  public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000006',
    2, null, null, null, null, null, null, 100, 250
  )::text not like '%da700000-0000-4000-8000-000000000002%'
  and not exists (
    select 1
    from jsonb_array_elements(public.get_person_documentary_context_graph_v1(
      'da200000-0000-4000-8000-000000000001',
      'da300000-0000-4000-8000-000000000006',
      2, null, null, null, null, null, null, 100, 250
    )->'edges') edge
    where edge->>'relationType' = 'occurred_at'
  )
  and jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000006',
    2, null, null, null, null, null,
    'da700000-0000-4000-8000-000000000002', 100, 250
  )->'nodes') = 1,
  'unconfirmed person-event place identity creates no place node, occurred-at edge or place-filter match'
);

select is(
  jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000004',
    2, null, null, null, null, null, null, 100, 250
  )->'nodes'),
  1,
  'viewer receives one masked node for a private living center'
);

select is(
  jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000004',
    2, null, null, null, null, null, null, 100, 250
  )->'edges'),
  0,
  'viewer receives no documentary neighbourhood for a private living center'
);

select ok(
  (public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000004',
    2, null, null, null, null, null, null, 100, 250
  ) #>> '{nodes,0,masked}')::boolean,
  'private living center is explicitly marked as masked'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"da100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select ok(
  public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 250
  )::text like '%da300000-0000-4000-8000-000000000003%',
  'project editor may inspect the living private participant'
);

select ok(
  public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 250
  )::text like '%SECRET_DOCUMENT_TITLE%',
  'project editor receives the document title but still not its source body'
);

select ok(
  public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 250
  )::text not like '%SECRET_TRANSCRIPTION%'
  and public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 250
  )::text not like '%SECRET_EVENT_NOTES%',
  'editor projection also omits transcript and note bodies'
);

select ok(
  (public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 1, 250
  )->>'truncated')::boolean
  and jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 1, 250
  )->'nodes') = 1,
  'node cap keeps the center and reports truncation'
);

select ok(
  (public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 1
  )->>'edgesTruncated')::boolean
  and jsonb_array_length(public.get_person_documentary_context_graph_v1(
    'da200000-0000-4000-8000-000000000001',
    'da300000-0000-4000-8000-000000000001',
    2, null, null, null, null, null, null, 100, 1
  )->'edges') = 1,
  'edge cap keeps one edge and reports truncation from bounded probes'
);

select set_config('test.cross_documentary_scope_sqlstate', 'none', true);
reset role;
do $cross_scope$
begin
  begin
    insert into public.person_timeline_events (
      id, project_id, person_id, event_type, source_document_id
    ) values (
      'da800000-0000-4000-8000-000000000002',
      'da200000-0000-4000-8000-000000000002',
      'da300000-0000-4000-8000-000000000005',
      'mention',
      'da400000-0000-4000-8000-000000000001'
    );
  exception when foreign_key_violation then
    perform set_config('test.cross_documentary_scope_sqlstate', sqlstate, true);
  end;
end;
$cross_scope$;

select is(
  current_setting('test.cross_documentary_scope_sqlstate'),
  '23503',
  'person event cannot cite a document from another project'
);

select * from finish();
rollback;
