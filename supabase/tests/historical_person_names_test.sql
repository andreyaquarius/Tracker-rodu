begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'person_names'
      and column_name = 'valid_from'
  ),
  'text',
  'valid_from preserves partial and approximate historical dates as text'
);

select is(
  (
    select data_type
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'person_names'
      and column_name = 'valid_to'
  ),
  'text',
  'valid_to preserves partial and approximate historical dates as text'
);

select has_column(
  'public', 'person_names', 'citation_id',
  'person_names exposes an additive citation pointer'
);

select has_column(
  'public', 'person_names', 'document_fragment_id',
  'person_names exposes an additive document-fragment pointer'
);

select has_function(
  'public',
  'preview_project_person_name_normalization_v1',
  array['uuid', 'text'],
  'read-only name normalization preview RPC exists'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'e9100000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'historical-names-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'e9100000-0000-4000-8000-000000000001',
  'historical-names-owner@example.test',
  'Historical names owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'e9100000-0000-4000-8000-000000000002',
  'authenticated',
  'authenticated',
  'historical-names-non-owner@example.test',
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
);

insert into public.profiles (user_id, email, display_name)
values (
  'e9100000-0000-4000-8000-000000000002',
  'historical-names-non-owner@example.test',
  'Historical names non-owner'
)
on conflict (user_id) do update set email = excluded.email;

insert into public.projects (id, owner_id, name)
values (
  'e9200000-0000-4000-8000-000000000001',
  'e9100000-0000-4000-8000-000000000001',
  'Historical names fixture'
);

insert into public.researches (id, project_id, title, created_by)
values (
  'e9300000-0000-4000-8000-000000000001',
  'e9200000-0000-4000-8000-000000000001',
  'Historical names research',
  'e9100000-0000-4000-8000-000000000001'
);

insert into public.persons (
  id, project_id, research_id, status, gender, surname, given_name,
  patronymic, full_name, is_living, privacy_status, created_by
) values (
  'e9400000-0000-4000-8000-000000000001',
  'e9200000-0000-4000-8000-000000000001',
  'e9300000-0000-4000-8000-000000000001',
  'proven',
  'male',
  'Legacy',
  'Person',
  'Name',
  'Legacy Person Name',
  false,
  'project',
  'e9100000-0000-4000-8000-000000000001'
);

insert into public.person_names (
  id, project_id, person_id, name_type, language_code, script_code,
  surname, given_name, patronymic, full_name, original_text,
  full_normalized, is_primary, is_preferred, source_type, created_by,
  metadata
) values (
  'e9500000-0000-4000-8000-000000000001',
  'e9200000-0000-4000-8000-000000000001',
  'e9400000-0000-4000-8000-000000000001',
  'historical_orthography',
  'ru',
  'Cyrl',
  'Івановъ',
  'Іоаннъ',
  '',
  'Іоаннъ Івановъ',
  'Іоаннъ Івановъ',
  'Іван Іванов',
  false,
  false,
  'manual',
  'e9100000-0000-4000-8000-000000000001',
  '{"fixture":"historical_person_names"}'::jsonb
);

-- Simulate a client that has already loaded the V2 UI while PostgREST still
-- serves the pre-migration column cache. The legacy payload carries the new
-- fields in metadata; the database trigger must persist them into real columns.
insert into public.person_names (
  id, project_id, person_id, name_type, language_code, script_code,
  surname, given_name, patronymic, full_name, original_text,
  is_primary, is_preferred, source_document_id, source_finding_id,
  created_by, metadata
) values (
  'e9500000-0000-4000-8000-000000000002',
  'e9200000-0000-4000-8000-000000000001',
  'e9400000-0000-4000-8000-000000000001',
  'alias',
  'uk',
  'Cyrl',
  'Іванов',
  'Іван',
  '',
  'Іван Прізвисько',
  'Іван Прізвисько',
  false,
  false,
  null,
  null,
  'e9100000-0000-4000-8000-000000000001',
  jsonb_build_object(
    'tracker_person_name_v2', jsonb_build_object(
      'nameType', 'nickname',
      'fullNormalized', 'Іван Прізвисько',
      'isSearchable', false,
      'sourceType', 'archive',
      'orthography', 'pre-1918'
    )
  )
);

select is(
  (
    select row(
      name.name_type,
      name.full_normalized,
      name.is_searchable,
      name.source_type,
      name.orthography
    )::text
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000002'
  ),
  row('nickname', 'Іван Прізвисько', false, 'archive', 'pre-1918')::text,
  'legacy schema-cache fallback is reconciled into searchable V2 columns'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"e9100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

create temporary table historical_primary_result on commit drop as
select public.set_project_person_name_primary_v1(
  'e9200000-0000-4000-8000-000000000001'::uuid,
  'e9400000-0000-4000-8000-000000000001'::uuid,
  'e9500000-0000-4000-8000-000000000001'::uuid
) result;

select is(
  (
    select row(person.surname, person.given_name, person.patronymic, person.full_name)::text
    from public.persons person
    where person.id = 'e9400000-0000-4000-8000-000000000001'
  ),
  row('Legacy', 'Person', 'Name', 'Legacy Person Name')::text,
  'selecting a display-primary name does not rewrite legacy persons fields'
);

select is(
  (
    select name.id
    from public.person_names name
    where name.person_id = 'e9400000-0000-4000-8000-000000000001'
      and name.is_primary
  ),
  'e9500000-0000-4000-8000-000000000001'::uuid,
  'the selected historical name becomes primary atomically'
);

select is(
  (
    select count(*)::integer
    from public.person_names name
    where name.person_id = 'e9400000-0000-4000-8000-000000000001'
      and name.is_primary
  ),
  1,
  'a person still has at most one primary name'
);

select is(
  (
    select name.original_text
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000001'
  ),
  'Іоаннъ Івановъ',
  'set-primary keeps exact historical original_text unchanged'
);

select throws_ok(
  $$
    update public.person_names
    set is_primary = false
    where id = 'e9500000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'PERSON_NAME_PRIMARY_DIRECT_CHANGE_FORBIDDEN',
  'authenticated editors cannot bypass the atomic primary-name RPC'
);

select set_config('tracker_rodu.person_name_primary_switch', 'on', true);
select throws_ok(
  $$
    update public.person_names
    set is_primary = false
    where id = 'e9500000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'PERSON_NAME_PRIMARY_DIRECT_CHANGE_FORBIDDEN',
  'a user-settable custom GUC cannot bypass the primary-name guard'
);

select throws_ok(
  $$
    delete from public.person_names
    where id = 'e9500000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'PERSON_NAME_PRIMARY_DELETE_FORBIDDEN',
  'authenticated editors cannot directly delete the display-primary name'
);

select throws_ok(
  $$
    update public.person_names
    set person_id = '00000000-0000-4000-8000-000000000099'
    where id = 'e9500000-0000-4000-8000-000000000001'
  $$,
  '23514',
  'PERSON_NAME_IDENTITY_MOVE_FORBIDDEN',
  'authenticated editors cannot move a name away from its Person by direct update'
);

update public.persons
set full_name = 'Legacy Person Name Updated',
    given_name = 'Person Updated'
where id = 'e9400000-0000-4000-8000-000000000001';

select is(
  (
    select name.id
    from public.person_names name
    where name.person_id = 'e9400000-0000-4000-8000-000000000001'
      and name.is_primary
  ),
  'e9500000-0000-4000-8000-000000000001'::uuid,
  'legacy person projection updates do not replace a manually selected primary name'
);

select is(
  (
    select name.full_name
    from public.person_names name
    where name.person_id = 'e9400000-0000-4000-8000-000000000001'
      and name.metadata ->> 'source' = 'persons_projection'
  ),
  'Legacy Person Name Updated',
  'legacy person edits still refresh their dedicated projection row'
);

select is(
  (
    select name.original_text
    from public.person_names name
    where name.person_id = 'e9400000-0000-4000-8000-000000000001'
      and name.metadata ->> 'source' = 'persons_projection'
  ),
  'Legacy Person Name',
  'projection refresh preserves its existing original_text'
);

select is(
  (
    select name.original_text
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000001'
  ),
  'Іоаннъ Івановъ',
  'projection refresh never touches a manual historical original_text'
);

select is(
  public.preflight_project_person_names_restore_v1(
    'e9200000-0000-4000-8000-000000000001'::uuid
  ) ->> 'contract',
  'historical-person-names-backup-v1',
  'the project owner can preflight exact historical-name restore before clearing data'
);

-- Capture the complete collection exactly as a client backup does: the
-- persons_projection row plus both manual rows. The primary source spelling
-- deliberately includes leading/trailing whitespace and a newline.
update public.person_names
set original_text = E'  Іоаннъ\nІвановъ  ',
    metadata = jsonb_build_object(
      'fixture', 'historical_person_names_restore',
      'nested', jsonb_build_object('preserve', true)
    )
where id = 'e9500000-0000-4000-8000-000000000001';

create temporary table historical_restore_expected on commit drop as
select
  name.id,
  name.person_id,
  name.name_type,
  name.language_code,
  name.script_code,
  name.surname,
  name.maiden_surname,
  name.given_name,
  name.patronymic,
  name.prefix,
  name.suffix,
  name.nickname,
  name.full_name,
  name.full_normalized,
  name.original_text,
  name.orthography,
  name.valid_from,
  name.valid_to,
  name.date_precision,
  name.is_primary,
  name.is_preferred,
  name.is_searchable,
  name.evidence_status,
  name.confidence,
  name.source_document_id,
  name.source_finding_id,
  name.source_type,
  name.source_id,
  name.citation_id,
  name.document_fragment_id,
  name.notes,
  name.metadata,
  name.created_by,
  name.lock_version,
  name.created_at,
  name.updated_at
from public.person_names name
where name.project_id = 'e9200000-0000-4000-8000-000000000001'::uuid;

create temporary table historical_restore_payload on commit drop as
select jsonb_agg(to_jsonb(expected) order by expected.id) payload
from historical_restore_expected expected;

-- Prove that the RPC restores captured values instead of merely accepting an
-- already-equal collection.
update public.person_names
set original_text = 'mutated after backup',
    metadata = '{"mutated":true}'::jsonb
where id = 'e9500000-0000-4000-8000-000000000001';

create temporary table historical_restore_result on commit drop as
select public.restore_project_person_names_v1(
  'e9200000-0000-4000-8000-000000000001'::uuid,
  (select payload from historical_restore_payload)
) result;

select is(
  (select (result ->> 'restored')::integer from historical_restore_result),
  3,
  'exact restore replaces the full projection-and-manual name collection'
);

select is(
  (
    select jsonb_agg(to_jsonb(actual) order by actual.id)::text
    from (
      select
        name.id,
        name.person_id,
        name.name_type,
        name.language_code,
        name.script_code,
        name.surname,
        name.maiden_surname,
        name.given_name,
        name.patronymic,
        name.prefix,
        name.suffix,
        name.nickname,
        name.full_name,
        name.full_normalized,
        name.original_text,
        name.orthography,
        name.valid_from,
        name.valid_to,
        name.date_precision,
        name.is_primary,
        name.is_preferred,
        name.is_searchable,
        name.evidence_status,
        name.confidence,
        name.source_document_id,
        name.source_finding_id,
        name.source_type,
        name.source_id,
        name.citation_id,
        name.document_fragment_id,
        name.notes,
        name.metadata,
        name.created_by,
        name.lock_version,
        name.created_at,
        name.updated_at
      from public.person_names name
      where name.project_id = 'e9200000-0000-4000-8000-000000000001'::uuid
    ) actual
  ),
  (
    select jsonb_agg(to_jsonb(expected) order by expected.id)::text
    from historical_restore_expected expected
  ),
  'restore preserves every backed-up core field, metadata, timestamps, and lock version exactly'
);

select is(
  (
    select name.original_text
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000001'
  ),
  E'  Іоаннъ\nІвановъ  ',
  'restore preserves source whitespace and newlines byte-for-byte'
);

select is(
  (
    select count(*)::integer
    from public.person_names name
    where name.project_id = 'e9200000-0000-4000-8000-000000000001'::uuid
      and name.is_primary
  ),
  1,
  'exact restore leaves exactly one primary name for the Person'
);

select is(
  (
    select count(*)::integer
    from public.person_names name
    where name.project_id = 'e9200000-0000-4000-8000-000000000001'::uuid
      and name.metadata ->> 'source' = 'persons_projection'
  ),
  1,
  'exact restore retains the managed persons_projection name row'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"e9100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$
    select public.preflight_project_person_names_restore_v1(
      'e9200000-0000-4000-8000-000000000001'::uuid
    )
  $$,
  '42501',
  'PROJECT_RESTORE_ACCESS_REQUIRED',
  'a non-owner cannot preflight project historical-name restore'
);

select throws_ok(
  $$
    select public.restore_project_person_names_v1(
      'e9200000-0000-4000-8000-000000000001'::uuid,
      '[]'::jsonb
    )
  $$,
  '42501',
  'PROJECT_RESTORE_ACCESS_REQUIRED',
  'a non-owner cannot replace the project historical-name collection'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"e9100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

-- Keep the original exact-search fixture below independent from the restore
-- round-trip's deliberate whitespace/newline case.
update public.person_names
set original_text = 'Іоаннъ Івановъ'
where id = 'e9500000-0000-4000-8000-000000000001';

create temporary table historical_search_result on commit drop as
select public.search_project_person_names_v1(
  'e9200000-0000-4000-8000-000000000001'::uuid,
  'Іоаннъ Івановъ',
  20
) result;

select ok(
  (
    select (result -> 0) ?& array[
      'personId', 'personNameId', 'displayName',
      'matchedName', 'matchType', 'score'
    ]
    from historical_search_result
  ),
  'search results expose the global-search JSON contract'
);

select is(
  (select result -> 0 ->> 'displayName' from historical_search_result),
  'Іван Іванов',
  'search returns the primary display name separately from the matched form'
);

select is(
  (select result -> 0 ->> 'matchedName' from historical_search_result),
  'Іоаннъ Івановъ',
  'search reports the exact historical form that matched'
);

select is(
  (select result -> 0 ->> 'matchType' from historical_search_result),
  'exact',
  'search labels a verbatim original-text match as exact'
);

select is(
  (
    select name.name_type
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000001'
  ),
  'historical_orthography',
  'a custom historical name-type slug survives the complete write and restore round-trip'
);

create temporary table historical_normalized_search_result on commit drop as
select public.search_project_person_names_v1(
  'e9200000-0000-4000-8000-000000000001'::uuid,
  'Іван Іванов',
  20
) result;

select is(
  (select result -> 0 ->> 'matchType' from historical_normalized_search_result),
  'normalized',
  'search does not label a normalized-only match as an exact source match'
);

select throws_ok(
  $$
    select public.search_project_person_names_v1(
      'e9200000-0000-4000-8000-000000000001'::uuid,
      repeat('x', 201),
      20
    )
  $$,
  '22023',
  'PERSON_NAME_QUERY_TOO_LONG',
  'search rejects an oversized query before normalization work begins'
);

create temporary table historical_preview_result on commit drop as
select public.preview_project_person_name_normalization_v1(
  'e9200000-0000-4000-8000-000000000001'::uuid,
  'Іоаннъ'
) result;

select ok(
  (
    select result ?& array['normalized', 'simplified', 'transliteration', 'tokens']
    from historical_preview_result
  ),
  'normalization preview returns derived values without writing a name'
);

reset role;

select is(
  (
    select count(*)::integer
    from security_private.person_name_restore_context context
    where context.project_id = 'e9200000-0000-4000-8000-000000000001'::uuid
  ),
  0,
  'successful exact restore removes its private transaction marker'
);

select ok(
  exists (
    select 1
    from security_private.person_name_audit_log audit
    where audit.person_name_id = 'e9500000-0000-4000-8000-000000000001'
      and audit.action = 'set_primary'
      and audit.actor_id = 'e9100000-0000-4000-8000-000000000001'
  ),
  'set-primary records a private per-name audit event'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"e9100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into public.documents (id, project_id, research_id, title, created_by)
values (
  'e9600000-0000-4000-8000-000000000001',
  'e9200000-0000-4000-8000-000000000001',
  'e9300000-0000-4000-8000-000000000001',
  'Historical name source deletion fixture',
  'e9100000-0000-4000-8000-000000000001'
);

insert into public.findings (
  id, project_id, research_id, finding_type, description, created_by
) values (
  'e9700000-0000-4000-8000-000000000001',
  'e9200000-0000-4000-8000-000000000001',
  'e9300000-0000-4000-8000-000000000001',
  'name_source',
  'Historical name finding deletion fixture',
  'e9100000-0000-4000-8000-000000000001'
);

insert into public.person_names (
  id, project_id, person_id, name_type, full_name, original_text,
  source_document_id, source_type, source_id
) values (
  'e9500000-0000-4000-8000-000000000003',
  'e9200000-0000-4000-8000-000000000001',
  'e9400000-0000-4000-8000-000000000001',
  'document',
  'Document deletion fixture',
  'Document deletion fixture',
  'e9600000-0000-4000-8000-000000000001',
  'document',
  'e9600000-0000-4000-8000-000000000001'
), (
  'e9500000-0000-4000-8000-000000000004',
  'e9200000-0000-4000-8000-000000000001',
  'e9400000-0000-4000-8000-000000000001',
  'document',
  'Finding deletion fixture',
  'Finding deletion fixture',
  null,
  'finding',
  'e9700000-0000-4000-8000-000000000001'
);

update public.person_names
set source_finding_id = 'e9700000-0000-4000-8000-000000000001'
where id = 'e9500000-0000-4000-8000-000000000004';

delete from public.documents
where id = 'e9600000-0000-4000-8000-000000000001';

select is(
  (
    select row(name.source_type, name.source_id, name.source_document_id)::text
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000003'
  ),
  row('document', null::uuid, null::uuid)::text,
  'deleting a source Document detaches both name pointers without blocking deletion'
);

delete from public.findings
where id = 'e9700000-0000-4000-8000-000000000001';

select is(
  (
    select row(name.source_type, name.source_id, name.source_finding_id)::text
    from public.person_names name
    where name.id = 'e9500000-0000-4000-8000-000000000004'
  ),
  row('finding', null::uuid, null::uuid)::text,
  'deleting a source Finding detaches both name pointers without blocking deletion'
);

select lives_ok(
  $$
    delete from public.persons
    where id = 'e9400000-0000-4000-8000-000000000001'
  $$,
  'cascading deletion of a Person is not blocked by name guards or audit foreign keys'
);

reset role;

select * from finish();
rollback;
