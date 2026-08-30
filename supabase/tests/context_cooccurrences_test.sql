begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(43);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_function(
  'public', 'list_person_context_cooccurrences_v1',
  array['uuid','uuid','integer','integer','uuid','integer','integer','integer'],
  'calculated Person co-occurrence RPC exists'
);

select ok(
  not (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'public.list_person_context_cooccurrences_v1(uuid,uuid,integer,integer,uuid,integer,integer,integer)'::regprocedure
  )
  and (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'security_private.list_person_context_cooccurrences_v1(uuid,uuid,integer,integer,uuid,integer,integer,integer)'::regprocedure
  ),
  'public co-occurrence API is an invoker facade over a checked private body'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.list_person_context_cooccurrences_v1(uuid,uuid,integer,integer,uuid,integer,integer,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.list_person_context_cooccurrences_v1(uuid,uuid,integer,integer,uuid,integer,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.list_person_context_cooccurrences_v1(uuid,uuid,integer,integer,uuid,integer,integer,integer)',
    'EXECUTE'
  ),
  'only authenticated and service roles can execute the public co-occurrence facade'
);

-- Reserved fixture IDs make this file independently rerunnable after an
-- interrupted pgTAP invocation.
delete from public.projects
where id in (
  'ce200000-0000-4000-8000-000000000001',
  'ce200000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'ce100000-0000-4000-8000-000000000001',
  'ce100000-0000-4000-8000-000000000002',
  'ce100000-0000-4000-8000-000000000003'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'ce100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'cooccurrence-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ce100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'cooccurrence-editor@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'ce100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'cooccurrence-viewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('ce100000-0000-4000-8000-000000000001', 'cooccurrence-owner@example.test', 'Co-occurrence owner'),
  ('ce100000-0000-4000-8000-000000000002', 'cooccurrence-editor@example.test', 'Co-occurrence editor'),
  ('ce100000-0000-4000-8000-000000000003', 'cooccurrence-viewer@example.test', 'Co-occurrence viewer')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
  ('ce200000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000001', 'Co-occurrence fixture'),
  ('ce200000-0000-4000-8000-000000000002', 'ce100000-0000-4000-8000-000000000001', 'Foreign co-occurrence fixture');

insert into public.project_members (project_id, user_id, role, invited_by) values
  ('ce200000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000002', 'editor', 'ce100000-0000-4000-8000-000000000001'),
  ('ce200000-0000-4000-8000-000000000001', 'ce100000-0000-4000-8000-000000000003', 'viewer', 'ce100000-0000-4000-8000-000000000001');

insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
) values
  ('ce300000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'Co-occurrence center', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-000000000001', 'Alpha participant', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000003', 'ce200000-0000-4000-8000-000000000001', 'Beta participant', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000004', 'ce200000-0000-4000-8000-000000000001', 'SECRET_LIVING_PARTICIPANT', true, 'private', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000005', 'ce200000-0000-4000-8000-000000000001', 'SECRET_LIVING_CENTER', true, 'confidential', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000006', 'ce200000-0000-4000-8000-000000000002', 'FOREIGN_PROJECT_PERSON', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000007', 'ce200000-0000-4000-8000-000000000001', 'Gamma participant', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000008', 'ce200000-0000-4000-8000-000000000001', 'Document-envelope-only participant', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000009', 'ce200000-0000-4000-8000-000000000001', 'Different birth in same register', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000010', 'ce200000-0000-4000-8000-000000000001', 'Same fragment participant', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000011', 'ce200000-0000-4000-8000-000000000001', 'Different fragment participant', false, 'project', 'ce100000-0000-4000-8000-000000000001'),
  ('ce300000-0000-4000-8000-000000000012', 'ce200000-0000-4000-8000-000000000001', 'Same fragment outside range', false, 'project', 'ce100000-0000-4000-8000-000000000001');

insert into public.documents (
  id, project_id, title, document_type, year_from, year_to, url, notes, created_by
) values
  (
    'ce400000-0000-4000-8000-000000000001',
    'ce200000-0000-4000-8000-000000000001',
    'SECRET_DOCUMENT_1877', 'parish_register', '1877', '1877',
    'https://secret-1877.example.test', 'SECRET_DOCUMENT_NOTE_1877',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce400000-0000-4000-8000-000000000002',
    'ce200000-0000-4000-8000-000000000001',
    'SECRET_DOCUMENT_1905', 'parish_register', '1905', '1905',
    'https://secret-1905.example.test', 'SECRET_DOCUMENT_NOTE_1905',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce400000-0000-4000-8000-000000000003',
    'ce200000-0000-4000-8000-000000000001',
    'SECRET_DOCUMENT_1878', 'parish_register', '1878', '1878',
    'https://secret-1878.example.test', 'SECRET_DOCUMENT_NOTE_1878',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce400000-0000-4000-8000-000000000004',
    'ce200000-0000-4000-8000-000000000001',
    'SECRET_LARGE_REGISTER_1800_1910', 'parish_register', '1800', '1910',
    'https://secret-large-register.example.test', 'SECRET_LARGE_REGISTER_NOTE',
    'ce100000-0000-4000-8000-000000000001'
  );

insert into public.findings (
  id, project_id, document_id, finding_type, event_date, transcription,
  notes, source_url, created_by
) values
  (
    'ce500000-0000-4000-8000-000000000001',
    'ce200000-0000-4000-8000-000000000001',
    'ce400000-0000-4000-8000-000000000001',
    'birth_record', '1877-05-09', 'SECRET_TRANSCRIPTION_1877',
    'SECRET_FINDING_NOTE_1877', 'https://secret-finding-1877.example.test',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce500000-0000-4000-8000-000000000002',
    'ce200000-0000-4000-8000-000000000001',
    'ce400000-0000-4000-8000-000000000001',
    '', '', 'SECRET_TRANSCRIPTION_UNDATED',
    'SECRET_FINDING_NOTE_UNDATED', 'https://secret-finding-undated.example.test',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce500000-0000-4000-8000-000000000003',
    'ce200000-0000-4000-8000-000000000001',
    'ce400000-0000-4000-8000-000000000002',
    'marriage_record', '1905-02-03', 'SECRET_TRANSCRIPTION_1905',
    'SECRET_FINDING_NOTE_1905', 'https://secret-finding-1905.example.test',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce500000-0000-4000-8000-000000000004',
    'ce200000-0000-4000-8000-000000000001',
    'ce400000-0000-4000-8000-000000000003',
    'baptism_record', '1878', 'SECRET_TRANSCRIPTION_1878',
    'SECRET_FINDING_NOTE_1878', 'https://secret-finding-1878.example.test',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'ce500000-0000-4000-8000-000000000005',
    'ce200000-0000-4000-8000-000000000001',
    'ce400000-0000-4000-8000-000000000004',
    'census', '1870', 'SECRET_SHARED_RECORD_IN_LARGE_REGISTER',
    'SECRET_SHARED_RECORD_NOTE', 'https://secret-shared-large.example.test',
    'ce100000-0000-4000-8000-000000000001'
  );

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role, notes
) values
  ('ce600000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000001', 'Center', 'subject', 'SECRET_PARTICIPANT_NOTE'),
  ('ce600000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000002', 'Alpha', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000003', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000003', 'Beta', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000004', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000004', 'Private', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000005', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000001', 'ce300000-0000-4000-8000-000000000007', 'Gamma', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000006', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000002', 'ce300000-0000-4000-8000-000000000001', 'Center', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000007', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000002', 'ce300000-0000-4000-8000-000000000002', 'Alpha', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000008', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000003', 'ce300000-0000-4000-8000-000000000001', 'Center', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000009', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000003', 'ce300000-0000-4000-8000-000000000002', 'Alpha', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000010', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000004', 'ce300000-0000-4000-8000-000000000001', 'Center', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000011', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000004', 'ce300000-0000-4000-8000-000000000002', 'Alpha', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000012', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000002', 'ce300000-0000-4000-8000-000000000009', 'Different birth', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000013', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000005', 'ce300000-0000-4000-8000-000000000001', 'Center', 'subject', ''),
  ('ce600000-0000-4000-8000-000000000014', 'ce200000-0000-4000-8000-000000000001', 'ce500000-0000-4000-8000-000000000005', 'ce300000-0000-4000-8000-000000000002', 'Alpha', 'subject', '');

-- One large multi-year register contains 120 other records. None of their
-- Persons shares the center's concrete Finding, so document-envelope fanout
-- must not turn them into co-occurrences.
insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
)
select
  md5('cooccurrence-large-person-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  'Large register unrelated ' || series.value,
  false, 'project', 'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 120) as series(value);

insert into public.findings (
  id, project_id, document_id, finding_type, event_date, transcription,
  notes, source_url, created_by
)
select
  md5('cooccurrence-large-finding-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  'ce400000-0000-4000-8000-000000000004',
  'mention', (1850 + (series.value % 61))::text,
  'SECRET_LARGE_RECORD_' || series.value, '', '',
  'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 120) as series(value);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role, notes
)
select
  md5('cooccurrence-large-participant-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  md5('cooccurrence-large-finding-' || series.value)::uuid,
  md5('cooccurrence-large-person-' || series.value)::uuid,
  'Unrelated ' || series.value, 'subject', ''
from generate_series(1, 120) as series(value);

-- Real shared events require the same canonical Finding, type and compatible
-- date. The two document-only rows and the different-Finding birth use the
-- same Document/date on purpose and must not become shared events.
insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date,
  source_document_id, source_finding_id
) values
  (
    'ce900000-0000-4000-8000-000000000001',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    'birth', 'Center birth', '1877-05-09',
    'ce400000-0000-4000-8000-000000000001',
    'ce500000-0000-4000-8000-000000000001'
  ),
  (
    'ce900000-0000-4000-8000-000000000002',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000002',
    'birth', 'Alpha in same birth', '1877-05-09',
    'ce400000-0000-4000-8000-000000000001',
    'ce500000-0000-4000-8000-000000000001'
  ),
  (
    'ce900000-0000-4000-8000-000000000003',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000002',
    'birth', 'Duplicate Alpha event row', '1877-05-09',
    'ce400000-0000-4000-8000-000000000001',
    'ce500000-0000-4000-8000-000000000001'
  ),
  (
    'ce900000-0000-4000-8000-000000000004',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000009',
    'birth', 'Different birth in same book and date', '1877-05-09',
    'ce400000-0000-4000-8000-000000000001',
    'ce500000-0000-4000-8000-000000000002'
  ),
  (
    'ce900000-0000-4000-8000-000000000005',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    'mention', 'Center document-only event', '1878',
    'ce400000-0000-4000-8000-000000000003', null
  ),
  (
    'ce900000-0000-4000-8000-000000000006',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000008',
    'mention', 'Other document-only event', '1878',
    'ce400000-0000-4000-8000-000000000003', null
  );

-- Exact canonical fragment provenance is the only direct Document fallback.
-- Hundreds of duplicate rows for one Person must remain one membership and
-- must not falsely set truncated=true.
insert into public.person_names (
  id, project_id, person_id, name_type, full_name, original_text,
  valid_from, valid_to, source_document_id, document_fragment_id, created_by
) values (
  'cea00000-0000-4000-8000-000000000001',
  'ce200000-0000-4000-8000-000000000001',
  'ce300000-0000-4000-8000-000000000001',
  'other', 'Center fragment name', 'Center fragment name',
  '1888', '1888', 'ce400000-0000-4000-8000-000000000002',
  'ceb00000-0000-4000-8000-000000000001',
  'ce100000-0000-4000-8000-000000000001'
);

insert into public.person_names (
  id, project_id, person_id, name_type, full_name, original_text,
  valid_from, valid_to, source_document_id, document_fragment_id, created_by
)
select
  md5('cooccurrence-direct-duplicate-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  'ce300000-0000-4000-8000-000000000010',
  'other', 'Same fragment name ' || series.value,
  'Same fragment name ' || series.value,
  '1888', '1888', 'ce400000-0000-4000-8000-000000000002',
  'ceb00000-0000-4000-8000-000000000001',
  'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 510) as series(value);

insert into public.person_names (
  id, project_id, person_id, name_type, full_name, original_text,
  valid_from, valid_to, source_document_id, document_fragment_id, created_by
) values
  (
    'cea00000-0000-4000-8000-000000000002',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000011',
    'other', 'Different fragment name', 'Different fragment name',
    '1888', '1888', 'ce400000-0000-4000-8000-000000000002',
    'ceb00000-0000-4000-8000-000000000002',
    'ce100000-0000-4000-8000-000000000001'
  ),
  (
    'cea00000-0000-4000-8000-000000000003',
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000012',
    'other', 'Same fragment outside range', 'Same fragment outside range',
    '1950', '1950', 'ce400000-0000-4000-8000-000000000002',
    'ceb00000-0000-4000-8000-000000000001',
    'ce100000-0000-4000-8000-000000000001'
  );

-- Duplicate Finding provenance for Alpha arrives through participant, two
-- real Event rows and 510 name rows, but is still one distinct membership.
insert into public.person_names (
  id, project_id, person_id, name_type, full_name, original_text,
  valid_from, valid_to, source_finding_id, created_by
)
select
  md5('cooccurrence-finding-duplicate-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  'ce300000-0000-4000-8000-000000000002',
  'other', 'Alpha duplicate finding name ' || series.value,
  'Alpha duplicate finding name ' || series.value,
  '1877', '1877', 'ce500000-0000-4000-8000-000000000001',
  'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 510) as series(value);

insert into public.places (
  id, project_id, canonical_name, modern_name, latitude, longitude,
  status, verification_status, created_by
) values
  ('ce700000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'Confirmed 1877 place', 'Confirmed 1877 place', 49.1, 28.1, 'active', 'verified', 'ce100000-0000-4000-8000-000000000001'),
  ('ce700000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-000000000001', 'Confirmed 1905 place', 'Confirmed 1905 place', 49.2, 28.2, 'active', 'verified', 'ce100000-0000-4000-8000-000000000001'),
  ('ce700000-0000-4000-8000-000000000003', 'ce200000-0000-4000-8000-000000000001', 'Unconfirmed place', 'Unconfirmed place', 49.3, 28.3, 'active', 'verified', 'ce100000-0000-4000-8000-000000000001'),
  ('ce700000-0000-4000-8000-000000000004', 'ce200000-0000-4000-8000-000000000002', 'Foreign project place', 'Foreign project place', 49.4, 28.4, 'active', 'verified', 'ce100000-0000-4000-8000-000000000001');

insert into public.document_place_links (
  id, document_id, place_id, project_id, relation_type, original_text,
  source_finding_id, resolution_status, created_by
) values
  ('ce800000-0000-4000-8000-000000000001', 'ce400000-0000-4000-8000-000000000001', 'ce700000-0000-4000-8000-000000000001', 'ce200000-0000-4000-8000-000000000001', 'event_place', 'SECRET_PLACE_TEXT_1877', 'ce500000-0000-4000-8000-000000000001', 'confirmed', 'ce100000-0000-4000-8000-000000000001'),
  ('ce800000-0000-4000-8000-000000000002', 'ce400000-0000-4000-8000-000000000002', 'ce700000-0000-4000-8000-000000000002', 'ce200000-0000-4000-8000-000000000001', 'event_place', 'SECRET_PLACE_TEXT_1905', 'ce500000-0000-4000-8000-000000000003', 'confirmed', 'ce100000-0000-4000-8000-000000000001'),
  ('ce800000-0000-4000-8000-000000000003', 'ce400000-0000-4000-8000-000000000003', 'ce700000-0000-4000-8000-000000000003', 'ce200000-0000-4000-8000-000000000001', 'event_place', 'SECRET_UNCONFIRMED_PLACE_TEXT', 'ce500000-0000-4000-8000-000000000004', 'needs_review', 'ce100000-0000-4000-8000-000000000001');

-- This candidate cites the same canonical Finding/type as the center, but has
-- no usable date and an explicitly confirmed different Place. It must not
-- borrow the center's year or Place when filters are applied.
insert into public.person_timeline_events (
  id, project_id, person_id, event_type, title, event_date, date_from, date_to,
  source_document_id, source_finding_id, place_id, place_resolution_status
) values (
  'ce900000-0000-4000-8000-000000000007',
  'ce200000-0000-4000-8000-000000000001',
  'ce300000-0000-4000-8000-000000000007',
  'birth', 'Gamma undated birth in another place', '', '', '',
  'ce400000-0000-4000-8000-000000000001',
  'ce500000-0000-4000-8000-000000000001',
  'ce700000-0000-4000-8000-000000000002', 'confirmed'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ce100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select set_config(
  'test.cooccurrence_payload',
  public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text,
  true
);

select is(
  (
    select array_agg(key order by key)::text
    from jsonb_object_keys(current_setting('test.cooccurrence_payload')::jsonb) key
  ),
  '{algorithmVersion,centerPersonId,items,total,truncated}',
  'root response exposes only the versioned co-occurrence contract'
);

select is(
  (current_setting('test.cooccurrence_payload')::jsonb->>'algorithmVersion')
    || ':' || (current_setting('test.cooccurrence_payload')::jsonb->>'centerPersonId'),
  'cooccurrence_v1:ce300000-0000-4000-8000-000000000001',
  'response identifies both the algorithm and center Person'
);

select is(
  (current_setting('test.cooccurrence_payload')::jsonb->>'total')
    || ':' || jsonb_array_length(current_setting('test.cooccurrence_payload')::jsonb->'items')::text
    || ':' || (current_setting('test.cooccurrence_payload')::jsonb->>'truncated'),
  '6:6:false',
  'viewer sees six valid candidates and duplicate provenance does not falsely truncate'
);

select is(
  (
    select array_agg(key order by key)::text
    from jsonb_object_keys(current_setting('test.cooccurrence_payload')::jsonb #> '{items,0}') key
  ),
  '{displayName,firstYear,lastYear,masked,personId,relationStrength,sharedDocumentCount,sharedEventCount,sharedFindingCount,sharedSourceCount,topSources}',
  'each item exposes the exact allowlisted camelCase contract'
);

select ok(
  (
    select max(jsonb_array_length(item->'topSources')) <= 5
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
  )
  and not exists (
    select 1
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item,
         jsonb_array_elements(item->'topSources') source
    where source->>'kind' not in ('finding','document')
       or (
         select array_agg(key order by key)::text
         from jsonb_object_keys(source) key
       ) <> '{id,kind,label,year}'
  ),
  'topSources is bounded and never mislabels a Finding UUID as an Event UUID'
);

select ok(
  current_setting('test.cooccurrence_payload') not like '%ce300000-0000-4000-8000-000000000004%'
  and current_setting('test.cooccurrence_payload') not like '%SECRET_LIVING_PARTICIPANT%'
  and current_setting('test.cooccurrence_payload') not like '%ce300000-0000-4000-8000-000000000006%'
  and current_setting('test.cooccurrence_payload') not like '%FOREIGN_PROJECT_PERSON%'
  and current_setting('test.cooccurrence_payload') not like '%SECRET_TRANSCRIPTION%'
  and current_setting('test.cooccurrence_payload') not like '%SECRET_FINDING_NOTE%'
  and current_setting('test.cooccurrence_payload') not like '%SECRET_DOCUMENT_NOTE%'
  and current_setting('test.cooccurrence_payload') not like '%secret-%example.test%'
  and current_setting('test.cooccurrence_payload') not like '%SECRET_PLACE_TEXT%',
  'privacy and project filters run before source summaries are assembled'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount')
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  '5:4:1:5',
  'distinct provenance paths collapse into five Findings, four Documents and one real Event for Alpha'
);

select is(
  (
    select (item->>'relationStrength')::integer
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  50,
  'cooccurrence_v1 scores each shared Finding once and does not double-score its Event or Document'
);

select is(
  (
    select (item->>'firstYear') || ':' || (item->>'lastYear')
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  '1870:1905',
  'firstYear and lastYear span all parseable shared sources'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item,
         jsonb_array_elements(item->'topSources') source
    where source->>'label' not in ('Знахідка','Документ')
  )
  and current_setting('test.cooccurrence_payload') not like '%SECRET_DOCUMENT_%',
  'viewer source labels are generic even though the underlying rows have titles'
);

select is(
  public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  ),
  current_setting('test.cooccurrence_payload')::jsonb,
  'the same inputs reproduce an identical calculated response'
);

select is(
  (
    select (item->>'sharedEventCount')::integer
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  1,
  'two real Event rows for Alpha on the same Finding/type deduplicate to one canonical shared event context'
);

select is(
  (
    select (item->>'sharedEventCount')::integer
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000003'
  ),
  0,
  'a Finding co-participant without a matching timeline Event does not receive an inferred event'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount') || ':'
      || (item->>'relationStrength')
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000009'
  ),
  '1:1:0:1:10',
  'two different births in one Document on the same date are not one shared Event'
);

select ok(
  current_setting('test.cooccurrence_payload') not like '%ce300000-0000-4000-8000-000000000008%',
  'bare same-Document timeline membership never creates a co-occurrence candidate'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount') || ':'
      || (item->>'relationStrength')
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000010'
  ),
  '0:1:0:1:4',
  'same canonical document fragment provides one independent direct Document source'
);

select ok(
  current_setting('test.cooccurrence_payload') not like '%ce300000-0000-4000-8000-000000000011%',
  'the same Document with a different fragment is not direct co-occurrence provenance'
);

select is(
  (
    select count(*)
    from jsonb_array_elements(current_setting('test.cooccurrence_payload')::jsonb->'items') item
    where item->>'displayName' like 'Large register unrelated %'
  ),
  0::bigint,
  '120 Persons in separate Findings of one large register do not fan out from the Document envelope'
);

select is(
  (
    with payload as (
      select public.list_person_context_cooccurrences_v1(
        'ce200000-0000-4000-8000-000000000001',
        'ce300000-0000-4000-8000-000000000001',
        1870, 1870, null, 1, 20, 0
      ) as value
    )
    select (value->>'total') || ':' || (value #>> '{items,0,personId}') || ':'
      || (value #>> '{items,0,sharedFindingCount}') || ':'
      || (value #>> '{items,0,sharedDocumentCount}')
    from payload
  ),
  '1:ce300000-0000-4000-8000-000000000002:1:1',
  'year 1870 uses the concrete shared Finding inside the multi-year register'
);

select is(
  (
    with payload as (
      select public.list_person_context_cooccurrences_v1(
        'ce200000-0000-4000-8000-000000000001',
        'ce300000-0000-4000-8000-000000000001',
        1888, 1888, null, 1, 20, 0
      ) as value
    )
    select (value->>'total') || ':' || (value #>> '{items,0,personId}')
    from payload
  ),
  '1:ce300000-0000-4000-8000-000000000010',
  'year filter applies to both sides of direct fragment provenance and excludes the 1950 candidate'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      null, null, 'ce700000-0000-4000-8000-000000000001', 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000009'
  ),
  'Place filter is bound to Finding 1 and does not leak to Finding 2 in the same Document'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount') || ':'
      || (item->>'relationStrength')
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      1877, 1877, null, 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  '1:1:1:1:10',
  'year 1877 keeps only overlapping Finding and Document sources'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount') || ':'
      || (item->>'relationStrength')
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      1905, 1905, null, 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  '1:1:0:1:10',
  'year 1905 selects its concrete shared Finding and attached Document without inferring an Event'
);

select is(
  (public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    1800, 1800, null, 1, 20, 0
  )->>'total')::integer,
  0,
  'a period with no parseable shared source returns an empty ranking'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount') || ':'
      || (item->>'relationStrength')
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      null, null, 'ce700000-0000-4000-8000-000000000001', 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  '1:1:1:1:10',
  'confirmed place filter retains only the concrete Finding linked to that Place'
);

select is(
  (
    select (item->>'sharedFindingCount') || ':'
      || (item->>'sharedDocumentCount') || ':'
      || (item->>'sharedEventCount') || ':'
      || (item->>'sharedSourceCount') || ':'
      || (item->>'relationStrength')
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      null, null, 'ce700000-0000-4000-8000-000000000002', 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000002'
  ),
  '2:2:0:2:20',
  'a second confirmed canonical place selects only sources explicitly linked to that place'
);

select is(
  (
    select (item->>'sharedEventCount')::integer
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      1877, 1877, null, 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000007'
  ),
  0,
  'Event year filter is satisfied independently by both event rows'
);

select is(
  (
    select (item->>'sharedEventCount')::integer
    from jsonb_array_elements(public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      null, null, 'ce700000-0000-4000-8000-000000000001', 1, 20, 0
    )->'items') item
    where item->>'personId' = 'ce300000-0000-4000-8000-000000000007'
  ),
  0,
  'Event Place filter is satisfied independently by both event rows'
);

select is(
  (public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, 'ce700000-0000-4000-8000-000000000003', 1, 20, 0
  )->>'total')::integer,
  0,
  'an unconfirmed Place link cannot satisfy the canonical Place filter'
);

select is(
  (public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 3, 20, 0
  )->>'total')::integer,
  1,
  'minimum shared-source filter is applied before pagination'
);

select is(
  (
    with payload as (
      select public.list_person_context_cooccurrences_v1(
        'ce200000-0000-4000-8000-000000000001',
        'ce300000-0000-4000-8000-000000000001',
        null, null, null, 1, 1, 1
      ) as value
    )
    select (value->>'total') || ':' || (value->>'truncated') || ':'
      || jsonb_array_length(value->'items')::text || ':'
      || (value #>> '{items,0,personId}')
    from payload
  ),
  '6:true:1:ce300000-0000-4000-8000-000000000003',
  'pagination keeps the total and uses deterministic Person-ID tie breaking'
);

reset role;

insert into public.documents (
  id, project_id, title, document_type, year_from, year_to, created_by
)
select
  md5('cooccurrence-overflow-document-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  'Overflow document ' || series.value, 'other', '1877', '1877',
  'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 101) as series(value);

insert into public.document_sources (
  id, project_id, document_id, provider, original_url, access_mode, created_by
)
select
  md5('cooccurrence-overflow-source-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  md5('cooccurrence-overflow-document-' || series.value)::uuid,
  'direct_pdf',
  'https://cooccurrence-overflow-' || series.value || '.example.test/source.pdf',
  'direct_cors', 'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 101) as series(value);

insert into public.finding_document_references (
  id, project_id, finding_id, document_id, document_source_id, page_index,
  source_fingerprint, created_by
)
select
  md5('cooccurrence-overflow-reference-' || series.value)::uuid,
  'ce200000-0000-4000-8000-000000000001',
  'ce500000-0000-4000-8000-000000000001',
  md5('cooccurrence-overflow-document-' || series.value)::uuid,
  md5('cooccurrence-overflow-source-' || series.value)::uuid,
  1, '{}'::jsonb, 'ce100000-0000-4000-8000-000000000001'
from generate_series(1, 101) as series(value);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"ce100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select is(
  public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )->>'truncated',
  'true',
  'more than 100 Documents attached to one Finding reports truncation'
);

select is(
  (
    with payload as (
      select public.list_person_context_cooccurrences_v1(
        'ce200000-0000-4000-8000-000000000001',
        'ce300000-0000-4000-8000-000000000005',
        null, null, null, 1, 20, 0
      ) as value
    )
    select (value->>'total') || ':' || jsonb_array_length(value->'items')::text
      || ':' || (value->>'truncated')
    from payload
  ),
  '0:0:false',
  'viewer receives no neighbourhood for a private living center'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"ce100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select ok(
  public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text like '%ce300000-0000-4000-8000-000000000004%'
  and public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text like '%SECRET_LIVING_PARTICIPANT%',
  'project editor may inspect a private living co-participant'
);

select ok(
  public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text like '%SECRET_DOCUMENT_%'
  and public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text not like '%SECRET_DOCUMENT_NOTE%'
  and public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text not like '%secret-%example.test%'
  and public.list_person_context_cooccurrences_v1(
    'ce200000-0000-4000-8000-000000000001',
    'ce300000-0000-4000-8000-000000000001',
    null, null, null, 1, 20, 0
  )::text not like '%SECRET_TRANSCRIPTION%',
  'editor receives safe source titles but never notes, URLs or transcriptions'
);

select throws_ok(
  $$
    select public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      1905, 1877, null, 1, 20, 0
    )
  $$,
  '22023',
  'CONTEXT_COOCCURRENCE_YEAR_RANGE_INVALID',
  'invalid year range is rejected before reading sources'
);

select throws_ok(
  $$
    select public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      null, null, null, 1, 101, 0
    )
  $$,
  '22023',
  'CONTEXT_COOCCURRENCE_LIMIT_OUT_OF_RANGE',
  'oversized page request is rejected'
);

select throws_ok(
  $$
    select public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000001',
      'ce300000-0000-4000-8000-000000000001',
      null, null, 'ce700000-0000-4000-8000-000000000004', 1, 20, 0
    )
  $$,
  '42501',
  'CONTEXT_COOCCURRENCE_PLACE_NOT_FOUND_OR_FORBIDDEN',
  'Place filter cannot reference a private Place from another project'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"ce100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select throws_ok(
  $$
    select public.list_person_context_cooccurrences_v1(
      'ce200000-0000-4000-8000-000000000002',
      'ce300000-0000-4000-8000-000000000006',
      null, null, null, 1, 20, 0
    )
  $$,
  '42501',
  'PROJECT_ACCESS_REQUIRED',
  'project membership is required before a center Person is inspected'
);

reset role;

select is(
  (select count(*) from public.person_context_relations where project_id = 'ce200000-0000-4000-8000-000000000001')::text
    || ':' || (select count(*) from public.context_relation_evidence where project_id = 'ce200000-0000-4000-8000-000000000001')::text
    || ':' || (select count(*) from public.person_relations where project_id = 'ce200000-0000-4000-8000-000000000001')::text
    || ':' || (select count(*) from public.parent_child_relationships where project_id = 'ce200000-0000-4000-8000-000000000001')::text
    || ':' || (select count(*) from public.partner_relationships where project_id = 'ce200000-0000-4000-8000-000000000001')::text,
  '0:0:0:0:0',
  'calculated co-occurrence reads create neither context pairs nor family edges'
);

select * from finish();
rollback;
