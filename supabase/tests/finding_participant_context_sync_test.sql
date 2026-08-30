begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(77);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select has_column(
  'public', 'finding_participants', 'context_target_participant_id',
  'a finding social-role participant can point at one concrete participant'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_context_target_fkey'
      and constraint_row.condeferrable
  ),
  'the explicit context target is same-finding constrained and deferrable'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.finding_participants'::regclass
      and constraint_row.conname = 'finding_participants_context_target_not_self'
  ),
  'a participant cannot target itself'
);

select has_trigger(
  'public', 'finding_participants', 'finding_participants_80_context_sync_insert',
  'participant inserts reconcile social context once per statement'
);

select has_trigger(
  'public', 'finding_participants', 'finding_participants_80_context_sync_update',
  'participant updates reconcile all roles and targets in the finding'
);

select has_trigger(
  'public', 'finding_participants', 'finding_participants_80_context_sync_delete',
  'participant deletes archive their generated context assertion'
);

select is(
  security_private.finding_context_type_code_v1('Народження', 'Хрещений батько'),
  'godfather',
  'an exact godfather role maps to the exact context type'
);

select is(
  security_private.finding_context_type_code_v1('Хрещення', 'Хрещена мати'),
  'godmother',
  'an exact godmother role maps to the exact context type'
);

select is(
  security_private.finding_context_type_code_v1('Шлюб', 'Свідок по нареченій'),
  'witness_for_bride',
  'a bride-side witness maps to the exact context type'
);

select is(
  security_private.finding_context_type_code_v1('Шлюб', 'Свідок по нареченому'),
  'witness_for_groom',
  'a groom-side witness maps to the exact context type'
);

select is(
  security_private.finding_context_type_code_v1('Шлюб', 'Свідок'),
  null::text,
  'a generic marriage witness is fail-closed because the side is unknown'
);

select is(
  security_private.finding_context_type_code_v1('Судова справа', 'Свідок'),
  'event_witness',
  'a generic witness outside marriage uses the precise event-witness type'
);

select is(
  security_private.finding_context_type_code_v1('Хрещення', 'Хрещений'),
  null::text,
  'a shorthand masculine godparent role is fail-closed until clarified'
);

select is(
  security_private.finding_context_type_code_v1('Хрещення', 'Хрещена'),
  null::text,
  'a shorthand feminine godparent role is fail-closed until clarified'
);

select is(
  array[
    security_private.finding_context_type_code_v1('Судова справа', 'Автор або укладач'),
    security_private.finding_context_type_code_v1('Судова справа', 'Укладач'),
    security_private.finding_context_type_code_v1('Судова справа', 'Командир'),
    security_private.finding_context_type_code_v1('Судова справа', 'Суддя'),
    security_private.finding_context_type_code_v1('Судова справа', 'Представник')
  ],
  array['official', 'official', 'official', 'official', 'official']::text[],
  'all structured official labels share the same exact SQL mapping contract'
);

select is(
  array[
    security_private.finding_context_type_code_v1('Народження', 'Рабин'),
    security_private.finding_context_type_code_v1('Народження', 'Пастор')
  ],
  array['clergy', 'clergy']::text[],
  'rabbi and pastor structured labels map to clergy'
);

select is(
  array[
    security_private.finding_kind_for_context_v1('Погосподарська книга'),
    security_private.finding_kind_for_context_v1('Сповідний розпис'),
    security_private.finding_kind_for_context_v1('Revision list')
  ],
  array['household', 'household', 'household']::text[],
  'household source aliases match the UI finding-kind contract'
);

select is(
  security_private.finding_context_type_code_v1('Судова справа', 'Інша особа'),
  null::text,
  'an unstructured other-person role never creates an automatic edge'
);

select is(
  (
    select relation_type.code || ':' || relation_type.source_role_uk || ':' || relation_type.target_role_uk
    from public.context_relation_types relation_type
    where relation_type.project_id is null
      and relation_type.code = 'event_witness'
  ),
  'event_witness:Свідок при події:Учасник події',
  'the non-marriage witness type exposes canonical directed endpoint labels'
);

select is(
  security_private.finding_context_type_code_v1('Народження', 'Батько'),
  null::text,
  'family roles never create a context relation'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Народження', null, 'Дитина'
  ),
  null::integer,
  'target selection is fail-closed when the source role has no context type'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Посімейний список', 'household_head', 'Член господарства'
  ),
  0,
  'a household member is a valid concrete target for the household head'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Посімейний список', 'household_head', 'Син'
  ),
  null::integer,
  'a family-only child role is not silently duplicated as a household-head context edge'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'cd100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'finding-context-test@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'cd100000-0000-4000-8000-000000000001',
  'finding-context-test@example.test',
  'Finding context test'
)
on conflict (user_id) do update
set email = excluded.email,
    display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values (
  'cd200000-0000-4000-8000-000000000001',
  'cd100000-0000-4000-8000-000000000001',
  'Finding context synchronization fixture'
);

insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
) values
  ('cd300000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000001', 'Child', false, 'private', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000002', 'cd200000-0000-4000-8000-000000000001', 'Godfather', false, 'confidential', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000003', 'cd200000-0000-4000-8000-000000000001', 'Godmother', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000004', 'cd200000-0000-4000-8000-000000000001', 'Midwife', false, 'public', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000005', 'cd200000-0000-4000-8000-000000000001', 'Father', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000006', 'cd200000-0000-4000-8000-000000000001', 'Bride', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000007', 'cd200000-0000-4000-8000-000000000001', 'Groom', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000008', 'cd200000-0000-4000-8000-000000000001', 'Generic witness', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000009', 'cd200000-0000-4000-8000-000000000001', 'Bride witness', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000010', 'cd200000-0000-4000-8000-000000000001', 'Groom witness', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000011', 'cd200000-0000-4000-8000-000000000001', 'Second child', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000012', 'cd200000-0000-4000-8000-000000000001', 'Ambiguous godfather', false, 'project', 'cd100000-0000-4000-8000-000000000001');

insert into public.documents (
  id, project_id, title, description, notes, created_by
) values (
  'cd400000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000001',
  'Private source fixture', 'TOP-SECRET-DOCUMENT-DESCRIPTION',
  'TOP-SECRET-DOCUMENT-NOTES', 'cd100000-0000-4000-8000-000000000001'
);

insert into public.findings (
  id, project_id, document_id, finding_type, event_date,
  summary, description, transcription, conclusion, notes, created_by
) values (
  'cd500000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000001',
  'cd400000-0000-4000-8000-000000000001',
  'Народження', '01.01.1900',
  'TOP-SECRET-SUMMARY', 'TOP-SECRET-DESCRIPTION', 'TOP-SECRET-TRANSCRIPTION',
  'TOP-SECRET-CONCLUSION', 'TOP-SECRET-FINDING-NOTES',
  'cd100000-0000-4000-8000-000000000001'
);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role, notes,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000001', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000001', 'Child', 'Дитина', '', null),
  ('cd600000-0000-4000-8000-000000000002', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000002', 'Godfather', 'Хрещений батько', 'TOP-SECRET-PARTICIPANT-NOTES', 'cd600000-0000-4000-8000-000000000001'),
  ('cd600000-0000-4000-8000-000000000003', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000003', 'Godmother', 'Хрещена мати', '', 'cd600000-0000-4000-8000-000000000001'),
  ('cd600000-0000-4000-8000-000000000004', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000004', 'Midwife', 'Повитуха', '', 'cd600000-0000-4000-8000-000000000001'),
  ('cd600000-0000-4000-8000-000000000005', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000001', 'cd300000-0000-4000-8000-000000000005', 'Father', 'Батько', '', null);

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000001'
      and relation.deleted_at is null
  ),
  3,
  'one statement creates godfather, godmother and midwife relations'
);

select is(
  (
    select array_agg(relation_type.code order by relation_type.code)::text
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000001'
      and relation.deleted_at is null
  ),
  '{godfather,godmother,midwife}',
  'the birth roles keep exact semantic type codes'
);

select is(
  (
    select count(*)::integer
    from public.person_context_relations relation
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000001'
      and relation.source_person_id in (
        'cd300000-0000-4000-8000-000000000002',
        'cd300000-0000-4000-8000-000000000003',
        'cd300000-0000-4000-8000-000000000004'
      )
      and relation.target_person_id = 'cd300000-0000-4000-8000-000000000001'
      and relation.deleted_at is null
  ),
  3,
  'the role holder is source and the concrete child is target'
);

select is(
  (
    select relation.source_role_label || ':' || relation.target_role_label
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
  ),
  'Хрещений батько:Хрещеник або хрещениця',
  'generated endpoint labels describe the directed social relation, not raw event roles'
);

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000005'
  ),
  0,
  'the biological father remains exclusively a family relation'
);

select is(
  (
    select count(*)::integer
    from public.context_relation_evidence evidence
    join public.person_context_relations relation on relation.id = evidence.relation_id
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000001'
      and evidence.source_finding_id = 'cd500000-0000-4000-8000-000000000001'
      and evidence.finding_participant_id is not null
      and evidence.source_locator = 'finding:cd500000-0000-4000-8000-000000000001'
      and evidence.deleted_at is null
  ),
  3,
  'each generated relation retains structured finding provenance and a durable locator'
);

select ok(
  not exists (
    select 1
    from public.context_relation_evidence evidence
    join public.person_context_relations relation on relation.id = evidence.relation_id
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000001'
      and (
        evidence.excerpt <> ''
        or evidence.notes <> ''
        or evidence.metadata::text ilike '%TOP-SECRET%'
        or relation.metadata::text ilike '%TOP-SECRET%'
        or relation.notes ilike '%TOP-SECRET%'
      )
  ),
  'generated graph rows never copy private source text or participant notes'
);

select is(
  (
    select relation.privacy_status
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
  ),
  'confidential',
  'the stricter confidential endpoint privacy is inherited'
);

select is(
  (
    select relation.privacy_status
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000004'
  ),
  'private',
  'a private endpoint keeps an otherwise public role-holder relation private'
);

update public.persons
set privacy_status = 'public'
where id = 'cd300000-0000-4000-8000-000000000001';

select is(
  (
    select relation.privacy_status
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000004'
  ),
  'project',
  'changing endpoint privacy immediately reconciles generated relation privacy'
);

update public.persons
set privacy_status = 'private'
where id = 'cd300000-0000-4000-8000-000000000001';

select set_config(
  'test.finding_context_relation_version',
  (
    select relation.lock_version::text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
  ),
  true
);
select set_config(
  'test.finding_context_evidence_version',
  (
    select evidence.lock_version::text
    from public.context_relation_evidence evidence
    join public.person_context_relations relation on relation.id = evidence.relation_id
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
      and evidence.origin_key = 'finding_participant:cd600000-0000-4000-8000-000000000002'
  ),
  true
);
select set_config(
  'test.finding_context_relation_id',
  (
    select relation.id::text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
  ),
  true
);

update public.finding_participants
set role = role
where id = 'cd600000-0000-4000-8000-000000000001';

select is(
  (
    select relation.lock_version::text
    from public.person_context_relations relation
    where relation.id = current_setting('test.finding_context_relation_id')::uuid
  ),
  current_setting('test.finding_context_relation_version'),
  'an idempotent finding save does not rewrite the generated relation'
);

select is(
  (
    select evidence.lock_version::text
    from public.context_relation_evidence evidence
    where evidence.relation_id = current_setting('test.finding_context_relation_id')::uuid
      and evidence.origin_key = 'finding_participant:cd600000-0000-4000-8000-000000000002'
  ),
  current_setting('test.finding_context_evidence_version'),
  'an idempotent finding save does not rewrite generated evidence'
);

update public.finding_participants
set role = 'Хрещена мати'
where id = 'cd600000-0000-4000-8000-000000000002';

select is(
  (
    select relation.id::text || ':' || relation_type.code
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
  ),
  current_setting('test.finding_context_relation_id') || ':godmother',
  'changing a structured role updates the same generated assertion in place'
);

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
  ),
  1,
  'the provenance origin remains unique across repeated reconciliation'
);

delete from public.finding_participants
where id = 'cd600000-0000-4000-8000-000000000002';

select ok(
  (
    select relation.deleted_at is not null
      and evidence.deleted_at is not null
    from public.person_context_relations relation
    join public.context_relation_evidence evidence on evidence.relation_id = relation.id
    where relation.id = current_setting('test.finding_context_relation_id')::uuid
      and evidence.origin_key = 'finding_participant:cd600000-0000-4000-8000-000000000002'
  ),
  'deleting the source participant soft-archives its generated relation and evidence'
);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values (
  'cd600000-0000-4000-8000-000000000002',
  'cd200000-0000-4000-8000-000000000001',
  'cd500000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000002',
  'Godfather', 'Хрещений батько',
  'cd600000-0000-4000-8000-000000000001'
);

select is(
  (
    select count(*)::text || ':'
      || (array_agg(relation.id order by relation.id))[1]::text || ':'
      || (array_agg(relation_type.code order by relation_type.code))[1]
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000002'
      and relation.deleted_at is null
  ),
  '1:' || current_setting('test.finding_context_relation_id') || ':godfather',
  'delete-all/reinsert restores the same origin without a duplicate relation'
);

insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000002',
  'cd200000-0000-4000-8000-000000000001',
  'Шлюб', 'cd100000-0000-4000-8000-000000000001'
);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000006', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000002', 'cd300000-0000-4000-8000-000000000006', 'Bride', 'Наречена', null),
  ('cd600000-0000-4000-8000-000000000007', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000002', 'cd300000-0000-4000-8000-000000000007', 'Groom', 'Наречений', null),
  ('cd600000-0000-4000-8000-000000000008', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000002', 'cd300000-0000-4000-8000-000000000008', 'Generic witness', 'Свідок', null),
  ('cd600000-0000-4000-8000-000000000009', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000002', 'cd300000-0000-4000-8000-000000000009', 'Bride witness', 'Свідок по нареченій', 'cd600000-0000-4000-8000-000000000006'),
  ('cd600000-0000-4000-8000-000000000010', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000002', 'cd300000-0000-4000-8000-000000000010', 'Groom witness', 'Свідок по нареченому', 'cd600000-0000-4000-8000-000000000007');

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000002'
      and relation.deleted_at is null
  ),
  2,
  'only the two exact wedding-side witnesses form automatic relations'
);

select is(
  (
    select count(*)::integer
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000002'
      and (
        relation_type.code = 'witness_for_bride'
        and relation.source_person_id = 'cd300000-0000-4000-8000-000000000009'
        and relation.target_person_id = 'cd300000-0000-4000-8000-000000000006'
        or relation_type.code = 'witness_for_groom'
        and relation.source_person_id = 'cd300000-0000-4000-8000-000000000010'
        and relation.target_person_id = 'cd300000-0000-4000-8000-000000000007'
      )
      and relation.deleted_at is null
  ),
  2,
  'each exact wedding witness targets the correct concrete spouse'
);

select is(
  (
    select count(*)::integer
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.metadata ->> 'findingId' = 'cd500000-0000-4000-8000-000000000002'
      and relation.source_role_label = relation_type.source_role_uk
      and relation.target_role_label = relation_type.target_role_uk
      and relation_type.code in ('witness_for_bride', 'witness_for_groom')
      and relation.deleted_at is null
  ),
  2,
  'both wedding-side witnesses store canonical forward and inverse endpoint labels'
);

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000008'
  ),
  0,
  'a generic marriage witness never creates an inferred relation'
);

insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000004',
  'cd200000-0000-4000-8000-000000000001',
  'Судова справа', 'cd100000-0000-4000-8000-000000000001'
);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role
) values
  ('cd600000-0000-4000-8000-000000000014', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000004', 'cd300000-0000-4000-8000-000000000006', 'Plaintiff', 'Позивач'),
  ('cd600000-0000-4000-8000-000000000015', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000004', 'cd300000-0000-4000-8000-000000000007', 'Defendant', 'Відповідач'),
  ('cd600000-0000-4000-8000-000000000016', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000004', 'cd300000-0000-4000-8000-000000000008', 'Witness', 'Свідок');

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000016'
  ),
  0,
  'a court witness with plaintiff and defendant remains ambiguous without an explicit target'
);

update public.finding_participants
set context_target_participant_id = 'cd600000-0000-4000-8000-000000000014'
where id = 'cd600000-0000-4000-8000-000000000016';

select is(
  (
    select relation.target_person_id::text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000016'
      and relation.deleted_at is null
  ),
  'cd300000-0000-4000-8000-000000000006',
  'an explicit court target forms one concrete witness relation'
);

select is(
  (
    select relation_type.code || ':' || relation.source_role_label || ':' || relation.target_role_label
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000016'
      and relation.deleted_at is null
  ),
  'event_witness:Свідок при події:Учасник події',
  'a non-marriage witness keeps its distinct type and canonical endpoint labels'
);

insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000003',
  'cd200000-0000-4000-8000-000000000001',
  'Народження', 'cd100000-0000-4000-8000-000000000001'
);

insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role
) values
  ('cd600000-0000-4000-8000-000000000011', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000003', 'cd300000-0000-4000-8000-000000000001', 'First twin', 'Дитина'),
  ('cd600000-0000-4000-8000-000000000012', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000003', 'cd300000-0000-4000-8000-000000000011', 'Second twin', 'Дитина'),
  ('cd600000-0000-4000-8000-000000000013', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000003', 'cd300000-0000-4000-8000-000000000012', 'Godfather', 'Хрещений батько');

select is(
  (
    select count(*)::integer from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000013'
  ),
  0,
  'two equally valid children remain ambiguous instead of creating a false link'
);

update public.finding_participants
set context_target_participant_id = 'cd600000-0000-4000-8000-000000000012'
where id = 'cd600000-0000-4000-8000-000000000013';

select is(
  (
    select relation.target_person_id::text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000013'
      and relation.deleted_at is null
  ),
  'cd300000-0000-4000-8000-000000000011',
  'an explicit participant target resolves an otherwise ambiguous finding'
);

select set_config(
  'test.ambiguous_relation_id',
  (
    select relation.id::text from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000013'
  ),
  true
);

update public.finding_participants
set context_target_participant_id = 'cd600000-0000-4000-8000-000000000011'
where id = 'cd600000-0000-4000-8000-000000000013';

select is(
  (
    select relation.id::text || ':' || relation.target_person_id::text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000013'
  ),
  current_setting('test.ambiguous_relation_id') || ':cd300000-0000-4000-8000-000000000001',
  'changing the explicit target updates the same generated relation'
);

update public.finding_participants
set role = 'Мати'
where id = 'cd600000-0000-4000-8000-000000000011';

select ok(
  (
    select relation.deleted_at is not null
    from public.person_context_relations relation
    where relation.id = current_setting('test.ambiguous_relation_id')::uuid
  ),
  'an explicit godparent target is fail-closed after its target stops being a child'
);

update public.finding_participants
set role = 'Дитина'
where id = 'cd600000-0000-4000-8000-000000000011';

select ok(
  (
    select relation.deleted_at is null
      and relation.target_person_id = 'cd300000-0000-4000-8000-000000000001'
    from public.person_context_relations relation
    where relation.id = current_setting('test.ambiguous_relation_id')::uuid
  ),
  'restoring a semantically valid target role restores the same generated relation'
);

delete from public.finding_participants
where id = 'cd600000-0000-4000-8000-000000000011';

select ok(
  (
    select source.context_target_participant_id is null
      and relation.deleted_at is not null
      and relation.target_person_id <> 'cd300000-0000-4000-8000-000000000011'
    from public.finding_participants source
    join public.person_context_relations relation
      on relation.legacy_source_table = 'finding_participants'
     and relation.legacy_source_id = source.id
    where source.id = 'cd600000-0000-4000-8000-000000000013'
      and relation.id = current_setting('test.ambiguous_relation_id')::uuid
  ),
  'deleting an explicit target archives the relation and never retargets the remaining twin'
);

update public.finding_participants
set context_target_participant_id = 'cd600000-0000-4000-8000-000000000012'
where id = 'cd600000-0000-4000-8000-000000000013';

select ok(
  (
    select relation.deleted_at is null
      and relation.target_person_id = 'cd300000-0000-4000-8000-000000000011'
    from public.person_context_relations relation
    where relation.id = current_setting('test.ambiguous_relation_id')::uuid
  ),
  'an explicit replacement target restores the same generated relation'
);

select throws_ok(
  $$
    update public.finding_participants
    set context_target_participant_id = id
    where id = 'cd600000-0000-4000-8000-000000000013'
  $$,
  '23514',
  null,
  'a participant cannot be its own explicit context target'
);

insert into public.findings (id, project_id, finding_type, created_by) values
  (
    'cd500000-0000-4000-8000-000000000005',
    'cd200000-0000-4000-8000-000000000001',
    'Народження', 'cd100000-0000-4000-8000-000000000001'
  ),
  (
    'cd500000-0000-4000-8000-000000000006',
    'cd200000-0000-4000-8000-000000000001',
    'Народження', 'cd100000-0000-4000-8000-000000000001'
  );

-- These rows model data that existed before context_target_participant_id. The
-- normal trigger intentionally leaves NULL targets untouched; only the private
-- migration backfill below may persist a unique safe candidate once.
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role
) values
  ('cd600000-0000-4000-8000-000000000017', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000005', 'cd300000-0000-4000-8000-000000000001', 'Legacy child', 'Дитина'),
  ('cd600000-0000-4000-8000-000000000018', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000005', 'cd300000-0000-4000-8000-000000000003', 'Legacy godmother', 'Хрещена мати'),
  ('cd600000-0000-4000-8000-000000000019', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000006', 'cd300000-0000-4000-8000-000000000001', 'Legacy first twin', 'Дитина'),
  ('cd600000-0000-4000-8000-000000000020', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000006', 'cd300000-0000-4000-8000-000000000011', 'Legacy second twin', 'Дитина'),
  ('cd600000-0000-4000-8000-000000000021', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000006', 'cd300000-0000-4000-8000-000000000012', 'Legacy ambiguous godfather', 'Хрещений батько');

select is(
  security_private.backfill_finding_context_targets_v1(),
  1,
  'legacy backfill persists exactly one unambiguous semantic target'
);

select is(
  (
    select source.context_target_participant_id::text || ':' || relation.target_person_id::text
    from public.finding_participants source
    join public.person_context_relations relation
      on relation.legacy_source_table = 'finding_participants'
     and relation.legacy_source_id = source.id
     and relation.deleted_at is null
    where source.id = 'cd600000-0000-4000-8000-000000000018'
  ),
  'cd600000-0000-4000-8000-000000000017:cd300000-0000-4000-8000-000000000001',
  'legacy unique-target backfill persists and projects the chosen child'
);

select ok(
  (
    select source.context_target_participant_id is null
      and not exists (
        select 1 from public.person_context_relations relation
        where relation.legacy_source_table = 'finding_participants'
          and relation.legacy_source_id = source.id
      )
    from public.finding_participants source
    where source.id = 'cd600000-0000-4000-8000-000000000021'
  ),
  'legacy backfill leaves equal-priority twin candidates unresolved'
);

select is(
  security_private.backfill_finding_context_targets_v1(),
  0,
  're-running legacy backfill is idempotent and creates no new assignment'
);

select ok(
  (
    select participant.context_target_participant_id is null
    from public.finding_participants participant
    where participant.id = 'cd600000-0000-4000-8000-000000000005'
  ),
  'legacy backfill never assigns a target to a family-only participant role'
);

update public.finding_participants
set role = 'Хрещений батько'
where id = 'cd600000-0000-4000-8000-000000000005';

select ok(
  (
    select participant.context_target_participant_id is null
      and not exists (
        select 1 from public.person_context_relations relation
        where relation.legacy_source_table = 'finding_participants'
          and relation.legacy_source_id = participant.id
      )
    from public.finding_participants participant
    where participant.id = 'cd600000-0000-4000-8000-000000000005'
  ),
  'changing a formerly family-only role cannot activate a stale inferred target'
);

-- Legacy clients used the exact marker below when they wrote a social edge to
-- person_relations after creating people from a finding. Because that row has
-- no finding_id, reconciliation first creates the lossless per-finding origin
-- and then archives only the old derived projection.
insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000007',
  'cd200000-0000-4000-8000-000000000001',
  'Народження', 'cd100000-0000-4000-8000-000000000001'
);
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000022', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000007', 'cd300000-0000-4000-8000-000000000001', 'Suppression child', 'Дитина', null),
  ('cd600000-0000-4000-8000-000000000023', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000007', 'cd300000-0000-4000-8000-000000000002', 'Suppression godfather', 'Хрещений батько', 'cd600000-0000-4000-8000-000000000022');
insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type, status,
  evidence_text, notes, created_by
) values (
  'cd700000-0000-4000-8000-000000000001',
  'cd200000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000002',
  'Хрещений батько', 'доведено', '',
  'Створено автоматично зі знахідки після створення пов’язаних осіб.',
  'cd100000-0000-4000-8000-000000000001'
);
update public.finding_participants
set role = role
where id = 'cd600000-0000-4000-8000-000000000023';

select is(
  (
    select count(*) filter (
      where relation.legacy_source_table = 'person_relations'
        and relation.deleted_at is null
    )::text || ':' || count(*) filter (
      where relation.legacy_source_table = 'finding_participants'
        and relation.deleted_at is null
    )::text || ':' || max(relation.privacy_status) filter (
      where relation.legacy_source_table = 'finding_participants'
        and relation.deleted_at is null
    ) || ':' || (
      select count(*)::text
      from public.context_relation_evidence evidence
      join public.person_context_relations generated_relation
        on generated_relation.id = evidence.relation_id
      where generated_relation.legacy_source_table = 'finding_participants'
        and generated_relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000023'
        and evidence.source_finding_id = 'cd500000-0000-4000-8000-000000000007'
        and evidence.finding_participant_id = 'cd600000-0000-4000-8000-000000000023'
        and evidence.deleted_at is null
    )
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.project_id = 'cd200000-0000-4000-8000-000000000001'
      and relation_type.code = 'godfather'
      and relation.source_person_id = 'cd300000-0000-4000-8000-000000000002'
      and relation.target_person_id = 'cd300000-0000-4000-8000-000000000001'
      and relation.legacy_source_id in (
        'cd700000-0000-4000-8000-000000000001',
        'cd600000-0000-4000-8000-000000000023'
      )
  ),
  '0:1:confidential:1',
  'an exact old auto projection is archived only after lossless finding provenance exists'
);

insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000011',
  'cd200000-0000-4000-8000-000000000001',
  'Народження', 'cd100000-0000-4000-8000-000000000001'
);
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000030', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000011', 'cd300000-0000-4000-8000-000000000001', 'Second provenance child', 'Дитина', null),
  ('cd600000-0000-4000-8000-000000000031', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000011', 'cd300000-0000-4000-8000-000000000002', 'Second provenance godfather', 'Хрещений батько', 'cd600000-0000-4000-8000-000000000030');

select is(
  (
    select count(distinct relation.id)::text || ':'
      || count(distinct evidence.source_finding_id)::text
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    join public.context_relation_evidence evidence
      on evidence.relation_id = relation.id
     and evidence.deleted_at is null
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id in (
        'cd600000-0000-4000-8000-000000000023',
        'cd600000-0000-4000-8000-000000000031'
      )
      and relation_type.code = 'godfather'
      and relation.deleted_at is null
  ),
  '2:2',
  'two findings for the same people and role retain two generated origins and two provenances'
);

update public.person_relations
set status = 'імовірно'
where id = 'cd700000-0000-4000-8000-000000000001';

select is(
  (
    select count(*) filter (
      where relation.legacy_source_table = 'person_relations'
        and relation.deleted_at is null
    )::text || ':' || count(distinct relation.id) filter (
      where relation.legacy_source_table = 'finding_participants'
        and relation.deleted_at is null
    )::text || ':' || count(distinct evidence.source_finding_id) filter (
      where relation.legacy_source_table = 'finding_participants'
        and relation.deleted_at is null
        and evidence.deleted_at is null
    )::text
    from public.person_context_relations relation
    left join public.context_relation_evidence evidence on evidence.relation_id = relation.id
    where relation.legacy_source_id in (
      'cd700000-0000-4000-8000-000000000001',
      'cd600000-0000-4000-8000-000000000023',
      'cd600000-0000-4000-8000-000000000031'
    )
  ),
  '0:2:2',
  'updating an old auto source cannot resurrect its evidence-free legacy duplicate'
);

delete from public.person_relations
where id = 'cd700000-0000-4000-8000-000000000001';

select is(
  (
    select count(distinct relation.id)::text || ':'
      || count(distinct evidence.source_finding_id)::text
    from public.person_context_relations relation
    join public.context_relation_evidence evidence
      on evidence.relation_id = relation.id
     and evidence.deleted_at is null
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id in (
        'cd600000-0000-4000-8000-000000000023',
        'cd600000-0000-4000-8000-000000000031'
      )
      and relation.deleted_at is null
  ),
  '2:2',
  'deleting the old auto legacy source never removes structured finding relations or evidence'
);

-- If the old auto projection gained independent/manual evidence, keep it
-- visible alongside the per-finding generated relation rather than guessing
-- which finding owns that evidence.
insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type, status,
  evidence_text, notes, created_by
) values (
  'cd700000-0000-4000-8000-000000000004',
  'cd200000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000011',
  'cd300000-0000-4000-8000-000000000003',
  'Хрещена мати', 'доведено', '',
  'Створено автоматично зі знахідки після створення пов’язаних осіб.',
  'cd100000-0000-4000-8000-000000000001'
);
insert into public.context_relation_evidence (
  project_id, relation_id, evidence_kind, notes, origin_key,
  created_by, updated_by
) values (
  'cd200000-0000-4000-8000-000000000001',
  (
    select relation.id
    from public.person_context_relations relation
    where relation.legacy_source_table = 'person_relations'
      and relation.legacy_source_id = 'cd700000-0000-4000-8000-000000000004'
  ),
  'note', 'Незалежна ручна примітка, яку не можна прив’язати до однієї знахідки.',
  'manual-old-auto-projection',
  'cd100000-0000-4000-8000-000000000001',
  'cd100000-0000-4000-8000-000000000001'
);
insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000012',
  'cd200000-0000-4000-8000-000000000001',
  'Народження', 'cd100000-0000-4000-8000-000000000001'
);
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000032', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000012', 'cd300000-0000-4000-8000-000000000011', 'Evidence-preserving child', 'Дитина', null),
  ('cd600000-0000-4000-8000-000000000033', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000012', 'cd300000-0000-4000-8000-000000000003', 'Evidence-preserving godmother', 'Хрещена мати', 'cd600000-0000-4000-8000-000000000032');

select is(
  (
    select count(*) filter (
      where relation.legacy_source_table = 'person_relations'
        and relation.deleted_at is null
    )::text || ':' || count(*) filter (
      where relation.legacy_source_table = 'finding_participants'
        and relation.deleted_at is null
    )::text || ':' || count(*) filter (
      where relation.legacy_source_table = 'person_relations'
        and evidence.origin_key = 'manual-old-auto-projection'
        and evidence.deleted_at is null
    )::text || ':' || count(*) filter (
      where relation.legacy_source_table = 'finding_participants'
        and evidence.source_finding_id = 'cd500000-0000-4000-8000-000000000012'
        and evidence.deleted_at is null
    )::text
    from public.person_context_relations relation
    left join public.context_relation_evidence evidence on evidence.relation_id = relation.id
    where relation.legacy_source_id in (
      'cd700000-0000-4000-8000-000000000004',
      'cd600000-0000-4000-8000-000000000033'
    )
  ),
  '1:1:1:1',
  'independent evidence keeps the legacy projection visible without replacing finding provenance'
);

insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000008',
  'cd200000-0000-4000-8000-000000000001',
  'Народження', 'cd100000-0000-4000-8000-000000000001'
);
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000024', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000008', 'cd300000-0000-4000-8000-000000000001', 'Manual coexistence child', 'Дитина', null),
  ('cd600000-0000-4000-8000-000000000025', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000008', 'cd300000-0000-4000-8000-000000000003', 'Manual coexistence godmother', 'Хрещена мати', 'cd600000-0000-4000-8000-000000000024');
insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type, status,
  evidence_text, notes, created_by
) values (
  'cd700000-0000-4000-8000-000000000002',
  'cd200000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000003',
  'Хрещена мати', 'доведено',
  'Створено автоматично зі знахідки після створення пов’язаних осіб.',
  'Ручний запис з окремим описом.',
  'cd100000-0000-4000-8000-000000000001'
);
insert into public.person_context_relations (
  project_id, relation_type_id, source_person_id, target_person_id,
  assertion_kind, notes, created_by, updated_by
) values (
  'cd200000-0000-4000-8000-000000000001',
  (select id from public.context_relation_types where project_id is null and code = 'godmother'),
  'cd300000-0000-4000-8000-000000000003',
  'cd300000-0000-4000-8000-000000000001',
  'manual',
  'Створено автоматично зі знахідки після створення пов’язаних осіб.',
  'cd100000-0000-4000-8000-000000000001',
  'cd100000-0000-4000-8000-000000000001'
);
update public.finding_participants
set role = role
where id = 'cd600000-0000-4000-8000-000000000025';

select ok(
  exists (
    select 1
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000025'
      and relation.deleted_at is null
  ) and (
    select relation.privacy_status = 'project'
    from public.person_context_relations relation
    where relation.legacy_source_table = 'person_relations'
      and relation.legacy_source_id = 'cd700000-0000-4000-8000-000000000002'
  ),
  'manual rows and legacy evidence text resembling the marker do not suppress generation'
);

insert into public.findings (id, project_id, finding_type, created_by) values (
  'cd500000-0000-4000-8000-000000000009',
  'cd200000-0000-4000-8000-000000000001',
  'Шлюб', 'cd100000-0000-4000-8000-000000000001'
);
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000026', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000009', 'cd300000-0000-4000-8000-000000000006', 'Precise bride', 'Наречена', null),
  ('cd600000-0000-4000-8000-000000000027', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000009', 'cd300000-0000-4000-8000-000000000009', 'Precise bride witness', 'Свідок по нареченій', 'cd600000-0000-4000-8000-000000000026');
insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type, status,
  evidence_text, notes, created_by
) values (
  'cd700000-0000-4000-8000-000000000003',
  'cd200000-0000-4000-8000-000000000001',
  'cd300000-0000-4000-8000-000000000006',
  'cd300000-0000-4000-8000-000000000009',
  'свідок', 'доведено', '',
  'Створено автоматично зі знахідки після створення пов’язаних осіб.',
  'cd100000-0000-4000-8000-000000000001'
);
update public.finding_participants
set role = role
where id = 'cd600000-0000-4000-8000-000000000027';

select is(
  (
    select array_agg(relation_type.code order by relation_type.code)::text
    from public.person_context_relations relation
    join public.context_relation_types relation_type on relation_type.id = relation.relation_type_id
    where relation.legacy_source_id in (
      'cd700000-0000-4000-8000-000000000003',
      'cd600000-0000-4000-8000-000000000027'
    )
      and relation.deleted_at is null
  ),
  '{witness,witness_for_bride}',
  'a generic legacy auto projection never erases a precise generated witness role'
);

insert into public.persons (
  id, project_id, full_name, is_living, privacy_status, created_by
) values
  ('cd300000-0000-4000-8000-000000000013', 'cd200000-0000-4000-8000-000000000001', 'Dated child', false, 'project', 'cd100000-0000-4000-8000-000000000001'),
  ('cd300000-0000-4000-8000-000000000014', 'cd200000-0000-4000-8000-000000000001', 'Dated midwife', false, 'project', 'cd100000-0000-4000-8000-000000000001');
insert into public.findings (
  id, project_id, finding_type, event_date, created_by
) values (
  'cd500000-0000-4000-8000-000000000010',
  'cd200000-0000-4000-8000-000000000001',
  'Народження', '1877', 'cd100000-0000-4000-8000-000000000001'
);
insert into public.finding_participants (
  id, project_id, finding_id, person_id, name, role,
  context_target_participant_id
) values
  ('cd600000-0000-4000-8000-000000000028', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000010', 'cd300000-0000-4000-8000-000000000013', 'Dated child', 'Дитина', null),
  ('cd600000-0000-4000-8000-000000000029', 'cd200000-0000-4000-8000-000000000001', 'cd500000-0000-4000-8000-000000000010', 'cd300000-0000-4000-8000-000000000014', 'Dated midwife', 'Повитуха', 'cd600000-0000-4000-8000-000000000028');

select is(
  (
    select relation.valid_from::text || ':' || relation.valid_to::text || ':' || relation.period_text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000029'
  ),
  '1877-01-01:1877-12-31:1877',
  'a partial finding year becomes a closed whole-year graph interval'
);

update public.findings
set event_date = '1877-05-09'
where id = 'cd500000-0000-4000-8000-000000000010';

select is(
  (
    select relation.valid_from::text || ':' || relation.valid_to::text || ':' || relation.period_text
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000029'
  ),
  '1877-05-09:1877-05-09:1877-05-09',
  'an exact ISO finding date becomes the same lower and upper graph bound'
);

update public.findings
set event_date = '9 травня 1877'
where id = 'cd500000-0000-4000-8000-000000000010';

select ok(
  (
    select relation.valid_from is null
      and relation.valid_to is null
      and relation.period_text = '9 травня 1877'
    from public.person_context_relations relation
    where relation.legacy_source_table = 'finding_participants'
      and relation.legacy_source_id = 'cd600000-0000-4000-8000-000000000029'
  ),
  'an unparseable historical date remains raw text without invented bounds'
);

update public.findings
set event_date = '1877'
where id = 'cd500000-0000-4000-8000-000000000010';

delete from public.findings
where id = 'cd500000-0000-4000-8000-000000000001';

select ok(
  (
    select evidence.source_finding_id is null
      and evidence.finding_participant_id is null
      and evidence.source_locator = 'finding:cd500000-0000-4000-8000-000000000001'
    from public.context_relation_evidence evidence
    where evidence.relation_id = current_setting('test.finding_context_relation_id')::uuid
      and evidence.origin_key = 'finding_participant:cd600000-0000-4000-8000-000000000002'
  ),
  'finding deletion survives both SET NULL cascades because provenance has a durable locator'
);

select ok(
  (
    select relation.deleted_at is not null
    from public.person_context_relations relation
    where relation.id = current_setting('test.finding_context_relation_id')::uuid
  ),
  'deleting a finding archives its generated social assertions'
);

select set_config(
  'test.ambiguous_relation_version',
  (
    select relation.lock_version::text
    from public.person_context_relations relation
    where relation.id = current_setting('test.ambiguous_relation_id')::uuid
  ),
  true
);
select set_config(
  'test.ambiguous_evidence_id',
  (
    select evidence.id::text
    from public.context_relation_evidence evidence
    where evidence.relation_id = current_setting('test.ambiguous_relation_id')::uuid
      and evidence.origin_key = 'finding_participant:cd600000-0000-4000-8000-000000000013'
  ),
  true
);
select set_config(
  'test.ambiguous_evidence_version',
  (
    select evidence.lock_version::text
    from public.context_relation_evidence evidence
    where evidence.id = current_setting('test.ambiguous_evidence_id')::uuid
  ),
  true
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"cd100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  format(
    'select public.archive_person_context_relation_v1(%L::uuid, %L::uuid, %s)',
    'cd200000-0000-4000-8000-000000000001',
    current_setting('test.ambiguous_relation_id'),
    current_setting('test.ambiguous_relation_version')::integer
  ),
  '22023',
  'CONTEXT_RELATION_GENERATED_READ_ONLY',
  'the public manual archive RPC cannot archive a generated finding projection'
);

select throws_ok(
  format(
    'select public.save_context_relation_evidence_v1(%L::uuid, %L::jsonb, %s)',
    'cd200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'id', current_setting('test.ambiguous_evidence_id'),
      'relationId', current_setting('test.ambiguous_relation_id'),
      'evidenceKind', 'note',
      'notes', 'tampered managed provenance'
    )::text,
    current_setting('test.ambiguous_evidence_version')::integer
  ),
  '22023',
  'CONTEXT_EVIDENCE_GENERATED_READ_ONLY',
  'an editor cannot rewrite synchronizer-managed finding evidence'
);

select throws_ok(
  format(
    'select public.archive_context_relation_evidence_v1(%L::uuid, %L::uuid, %s)',
    'cd200000-0000-4000-8000-000000000001',
    current_setting('test.ambiguous_evidence_id'),
    current_setting('test.ambiguous_evidence_version')::integer
  ),
  '22023',
  'CONTEXT_EVIDENCE_GENERATED_READ_ONLY',
  'an editor cannot archive synchronizer-managed finding evidence'
);

select lives_ok(
  format(
    'select public.save_context_relation_evidence_v1(%L::uuid, %L::jsonb, null)',
    'cd200000-0000-4000-8000-000000000001',
    jsonb_build_object(
      'relationId', current_setting('test.ambiguous_relation_id'),
      'evidenceKind', 'note',
      'notes', 'Окрема ручна примітка до автоматичного зв’язку'
    )::text
  ),
  'an editor may attach separate manual evidence to a generated relation'
);

select is(
  jsonb_array_length(
    public.get_person_context_graph_v1(
      'cd200000-0000-4000-8000-000000000001',
      'cd300000-0000-4000-8000-000000000014',
      1, 100, null, null,
      '1900-01-01'::date, '1900-12-31'::date, 250
    ) -> 'edges'
  ),
  0,
  'the context graph date filter excludes a generated 1877 edge from 1900'
);

reset role;

select * from finish();
rollback;
