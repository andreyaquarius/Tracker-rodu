begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(45);

update public.app_feature_flags
set is_enabled = true
where key = 'person_context_graphs_v1';

select is(
  (
    select relation_type.label_uk
    from public.context_relation_types relation_type
    where relation_type.project_id is null
      and relation_type.code = 'sponsor_for_bride'
  ),
  'Поручитель по нареченій',
  'the exact bride-side sponsor type exists'
);

select is(
  (
    select relation_type.label_uk
    from public.context_relation_types relation_type
    where relation_type.project_id is null
      and relation_type.code = 'sponsor_for_groom'
  ),
  'Поручитель по нареченому',
  'the exact groom-side sponsor type exists'
);

select ok(
  (
    select relation_type.metadata @> '{"legacyAmbiguous":true,"allowNewManualAssertions":false}'::jsonb
      and relation_type.is_active
    from public.context_relation_types relation_type
    where relation_type.project_id is null and relation_type.code = 'sponsor'
  ),
  'the generic sponsor remains readable but cannot be asserted manually'
);

select is(
  security_private.finding_context_type_code_v1('Шлюб', 'Поручитель по нареченій'),
  'sponsor_for_bride',
  'a bride-side sponsor maps to the exact context type'
);

select is(
  security_private.finding_context_type_code_v1('Шлюб', 'Поручитель по нареченому'),
  'sponsor_for_groom',
  'a groom-side sponsor maps to the exact context type'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Шлюб', 'sponsor_for_bride', 'Наречена'
  ),
  0,
  'the bride is the only valid bride-side sponsor target'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Шлюб', 'sponsor_for_bride', 'Наречений'
  ),
  null::integer,
  'the groom is rejected for a bride-side sponsor'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Шлюб', 'sponsor_for_groom', 'Наречений'
  ),
  0,
  'the groom is the only valid groom-side sponsor target'
);

select is(
  security_private.finding_context_target_priority_v1(
    'Шлюб', 'sponsor_for_groom', 'Наречена'
  ),
  null::integer,
  'the bride is rejected for a groom-side sponsor'
);

select is(
  security_private.legacy_person_context_type_code_v1('Поручитель нареченої'),
  'sponsor_for_bride',
  'legacy exact bride-side wording is preserved precisely'
);

select has_function(
  'public', 'list_person_church_role_network_v1',
  array[
    'uuid','uuid','text[]','integer','integer','text[]','integer','integer','integer'
  ],
  'the surname-cluster church-role network RPC exists'
);

select ok(
  not (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'public.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)'::regprocedure
  )
  and (
    select function_row.prosecdef
    from pg_catalog.pg_proc function_row
    where function_row.oid =
      'security_private.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)'::regprocedure
  ),
  'the public RPC is an invoker facade over a checked private body'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)',
    'EXECUTE'
  ),
  'only authenticated and service roles execute the public RPC'
);

delete from public.projects
where id in (
  'cf200000-0000-4000-8000-000000000001',
  'cf200000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'cf100000-0000-4000-8000-000000000001',
  'cf100000-0000-4000-8000-000000000002',
  'cf100000-0000-4000-8000-000000000003'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    'cf100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
    'church-network-owner@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'cf100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
    'church-network-editor@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    'cf100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated',
    'church-network-viewer@example.test', '', now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, email, display_name) values
  ('cf100000-0000-4000-8000-000000000001', 'church-network-owner@example.test', 'Network owner'),
  ('cf100000-0000-4000-8000-000000000002', 'church-network-editor@example.test', 'Network editor'),
  ('cf100000-0000-4000-8000-000000000003', 'church-network-viewer@example.test', 'Network viewer')
on conflict (user_id) do update
set email = excluded.email, display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
  ('cf200000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001', 'Church network fixture'),
  ('cf200000-0000-4000-8000-000000000002', 'cf100000-0000-4000-8000-000000000001', 'Foreign network fixture');

insert into public.project_members (project_id, user_id, role, invited_by) values
  ('cf200000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000002', 'editor', 'cf100000-0000-4000-8000-000000000001'),
  ('cf200000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000003', 'viewer', 'cf100000-0000-4000-8000-000000000001');

insert into public.persons (
  id, project_id, surname, given_name, full_name,
  is_living, privacy_status, created_by
) values
  ('cf300000-0000-4000-8000-000000000001', 'cf200000-0000-4000-8000-000000000001', 'Каленський', 'Петро', 'Каленський Петро', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000002', 'cf200000-0000-4000-8000-000000000001', 'Каленський', 'Марія', 'Каленська Марія', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000003', 'cf200000-0000-4000-8000-000000000001', 'Мерзляк', 'Іван', 'Мерзляк Іван', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000004', 'cf200000-0000-4000-8000-000000000001', 'Мерзляк', 'Ганна', 'Мерзляк Ганна', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000005', 'cf200000-0000-4000-8000-000000000001', 'Каленський', 'Семен', 'Каленський Семен', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000006', 'cf200000-0000-4000-8000-000000000001', '', 'Безпрізвищний', 'Безпрізвищний поручитель', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000007', 'cf200000-0000-4000-8000-000000000001', 'Секретний', 'Живий', 'SECRET_LIVING_SPONSOR', true, 'private', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000008', 'cf200000-0000-4000-8000-000000000001', 'Кухар', 'Федір', 'Кухар Федір', false, 'project', 'cf100000-0000-4000-8000-000000000001'),
  ('cf300000-0000-4000-8000-000000000009', 'cf200000-0000-4000-8000-000000000001', 'Закритий', 'Центр', 'SECRET_LIVING_CENTER', true, 'confidential', 'cf100000-0000-4000-8000-000000000001');

insert into public.documents (
  id, project_id, title, document_type, year_from, year_to,
  url, notes, created_by
) values (
  'cf400000-0000-4000-8000-000000000001',
  'cf200000-0000-4000-8000-000000000001',
  'SECRET_CHURCH_REGISTER', 'parish_register', '1870', '1879',
  'https://secret-network.example.test', 'SECRET_NETWORK_DOCUMENT_NOTE',
  'cf100000-0000-4000-8000-000000000001'
);

insert into public.findings (
  id, project_id, document_id, finding_type, event_date,
  transcription, notes, source_url, created_by
) values
  ('cf500000-0000-4000-8000-000000000001', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1870', 'SECRET_FINDING_ONE', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000002', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1872', 'SECRET_FINDING_TWO', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000003', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1873', 'SECRET_FINDING_SAME_GROUP', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000004', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1874', 'SECRET_FINDING_NO_SURNAME', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000005', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1875', 'SECRET_FINDING_PRIVATE', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000006', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1876', 'SECRET_FINDING_LEGACY', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000007', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1800', 'SECRET_OUT_OF_PERIOD_FINDING', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf500000-0000-4000-8000-000000000008', 'cf200000-0000-4000-8000-000000000001', 'cf400000-0000-4000-8000-000000000001', 'Хрещення', '1900', 'SECRET_IN_PERIOD_FINDING', '', '', 'cf100000-0000-4000-8000-000000000001');

insert into public.person_context_relations (
  id, project_id, relation_type_id, source_person_id, target_person_id,
  valid_from, valid_to, evidence_status, confidence, privacy_status,
  assertion_kind, created_by, updated_by
) values
  ('cf600000-0000-4000-8000-000000000001', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godfather'), 'cf300000-0000-4000-8000-000000000003', 'cf300000-0000-4000-8000-000000000001', '1870-01-01', '1870-12-31', 'proven', 90, 'project', 'generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000002', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godmother'), 'cf300000-0000-4000-8000-000000000004', 'cf300000-0000-4000-8000-000000000002', '1872-01-01', '1872-12-31', 'likely', 80, 'project', 'generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000003', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godfather'), 'cf300000-0000-4000-8000-000000000003', 'cf300000-0000-4000-8000-000000000001', '1870-01-01', '1870-12-31', 'proven', 70, 'project', 'manual', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000004', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='sponsor'), 'cf300000-0000-4000-8000-000000000003', 'cf300000-0000-4000-8000-000000000001', '1871-01-01', '1871-12-31', 'unknown', 50, 'project', 'legacy_import', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000005', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godfather'), 'cf300000-0000-4000-8000-000000000005', 'cf300000-0000-4000-8000-000000000001', '1873-01-01', '1873-12-31', 'proven', 80, 'project', 'generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000006', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godmother'), 'cf300000-0000-4000-8000-000000000006', 'cf300000-0000-4000-8000-000000000001', '1874-01-01', '1874-12-31', 'proven', 80, 'project', 'generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000007', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godfather'), 'cf300000-0000-4000-8000-000000000007', 'cf300000-0000-4000-8000-000000000001', '1875-01-01', '1875-12-31', 'proven', 80, 'project', 'generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000008', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godparent'), 'cf300000-0000-4000-8000-000000000008', 'cf300000-0000-4000-8000-000000000001', '1876-01-01', '1876-12-31', 'proven', 60, 'project', 'legacy_import', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000009', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godfather'), 'cf300000-0000-4000-8000-000000000008', 'cf300000-0000-4000-8000-000000000001', null, null, 'disputed', 40, 'project', 'manual', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf600000-0000-4000-8000-000000000010', 'cf200000-0000-4000-8000-000000000001', (select id from public.context_relation_types where project_id is null and code='godfather'), 'cf300000-0000-4000-8000-000000000008', 'cf300000-0000-4000-8000-000000000001', null, null, 'disputed', 80, 'project', 'generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001');

insert into public.context_relation_evidence (
  id, project_id, relation_id, evidence_kind,
  source_document_id, source_finding_id, source_locator,
  origin_key, created_by, updated_by
) values
  ('cf700000-0000-4000-8000-000000000001', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000001', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000001', 'finding:one', 'network:f1:generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000002', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000002', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000002', 'finding:two', 'network:f2:generated', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000003', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000003', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000001', 'finding:one', 'network:f1:manual', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000004', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000005', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000003', 'finding:same', 'network:f3', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000005', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000006', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000004', 'finding:no-surname', 'network:f4', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000006', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000007', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000005', 'finding:private', 'network:f5', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000007', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000008', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000006', 'finding:legacy', 'network:f6', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000008', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000009', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000007', 'finding:out-of-period', 'network:f7', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001'),
  ('cf700000-0000-4000-8000-000000000009', 'cf200000-0000-4000-8000-000000000001', 'cf600000-0000-4000-8000-000000000010', 'finding', 'cf400000-0000-4000-8000-000000000001', 'cf500000-0000-4000-8000-000000000008', 'finding:in-period', 'network:f8', 'cf100000-0000-4000-8000-000000000001', 'cf100000-0000-4000-8000-000000000001');

insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type,
  status, evidence_text, notes, created_by
) values
  ('cf800000-0000-4000-8000-000000000001', 'cf200000-0000-4000-8000-000000000001', 'cf300000-0000-4000-8000-000000000002', 'cf300000-0000-4000-8000-000000000008', 'Поручитель по нареченій', '', '', '', 'cf100000-0000-4000-8000-000000000001'),
  ('cf800000-0000-4000-8000-000000000002', 'cf200000-0000-4000-8000-000000000001', 'cf300000-0000-4000-8000-000000000001', 'cf300000-0000-4000-8000-000000000008', 'Поручитель по нареченому', '', '', '', 'cf100000-0000-4000-8000-000000000001');

select is(
  (
    select count(*)
    from public.person_context_relations relation
    join public.context_relation_types relation_type
      on relation_type.id = relation.relation_type_id
    where relation.legacy_source_table = 'person_relations'
      and relation.legacy_source_id in (
        'cf800000-0000-4000-8000-000000000001',
        'cf800000-0000-4000-8000-000000000002'
      )
      and relation.source_person_id = 'cf300000-0000-4000-8000-000000000008'
      and (
        (relation_type.code = 'sponsor_for_bride'
          and relation.target_person_id = 'cf300000-0000-4000-8000-000000000002')
        or (relation_type.code = 'sponsor_for_groom'
          and relation.target_person_id = 'cf300000-0000-4000-8000-000000000001')
      )
  ),
  2::bigint,
  'legacy exact sponsor wording keeps the role holder as source and the concrete spouse as target'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"cf100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);

select is(
  public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    null, null, null, null, 1, 50, 0
  ) ->> 'groupingKind',
  'surname_cluster',
  'the response identifies surname clustering explicitly'
);

select is(
  public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    null, null, null, null, 1, 50, 0
  ) ->> 'groupingIsGenealogicalFact',
  'false',
  'surname grouping is explicitly not a genealogical fact'
);

select is(
  (
    public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) #>> '{centerGroup,memberCount}'
  )::integer,
  3,
  'the center cluster includes all visible persons with the normalized surname'
);

select is(
  (
    select (item ->> 'occurrenceCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  2,
  'two concrete findings produce two occurrences even in one document'
);

select is(
  (
    select (item ->> 'relationCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  4,
  'relationCount includes sourced and unsourced assertions separately'
);

select is(
  (
    select (item ->> 'personPairCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  2,
  'duplicate assertions do not inflate the person-pair count'
);

select is(
  (
    select (item ->> 'generatedCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  2,
  'generated assertions are counted without hiding manual assertions'
);

select is(
  (
    select (item ->> 'manualCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  1,
  'manual assertions remain visible while the ambiguous sponsor stays legacy-only'
);

select is(
  (
    select jsonb_array_length(item -> 'sources')
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  2,
  'top sources preserve two concrete findings from the same document'
);

select is(
  (
    select (item ->> 'incomingCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  2,
  'role holders pointing to the center surname cluster are incoming occurrences'
);

select is(
  (
    public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) ->> 'sameGroupOccurrenceCount'
  )::integer,
  1,
  'same-surname ties are counted separately'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'каленський'
  ),
  'same-surname ties never become between-group items'
);

select is(
  (
    public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) ->> 'omittedWithoutSurnameCount'
  )::integer,
  1,
  'concrete occurrences without a counterpart surname are reported as omitted'
);

select is(
  (
    select (item ->> 'ambiguousRoleCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'кухар'
  ),
  1,
  'a legacy generic godparent is labelled as ambiguous'
);

select is(
  (
    select role_count ->> 'code'
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item,
    lateral jsonb_array_elements(item -> 'roleCounts') role_count
    where item #>> '{counterpartGroup,normalizedSurname}' = 'кухар'
    limit 1
  ),
  'godparent',
  'roleCounts keeps the legacy role code visible instead of guessing its sex'
);

select ok(
  not (
    public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    )::text like '%секретний%'
    or public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    )::text like '%SECRET_LIVING_SPONSOR%'
  ),
  'a private living endpoint is removed before labels and counts are aggregated'
);

select ok(
  not (
    public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    )::text like '%SECRET_CHURCH_REGISTER%'
    or public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    )::text like '%secret-network.example.test%'
  ),
  'viewer sources contain no private document title or URL'
);

select is(
  (
    select sample #>> '{source,label}'
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item,
    lateral jsonb_array_elements(item -> 'samples') sample
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
      and sample -> 'source' is not null
    limit 1
  ),
  'Знахідка',
  'viewer sample sources use a safe generic label'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item,
    lateral jsonb_array_elements(item -> 'samples') sample
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
      and (sample ->> 'evidenceCount')::integer >= 1
      and sample -> 'source' is not null
  ),
  'samples expose only evidence counts and a safe source identity'
);

select is(
  (
    select (item ->> 'occurrenceCount')::integer
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, 1872, 1879, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
  ),
  1,
  'year filtering is applied before family-network aggregation'
);

select ok(
  (
    select
      (item ->> 'occurrenceCount')::integer = 1
      and (item ->> 'relationCount')::integer = 1
      and (item ->> 'generatedCount')::integer = 1
      and (item ->> 'manualCount')::integer = 0
      and jsonb_array_length(item -> 'samples') = 1
      and (item #>> '{samples,0,year}')::integer = 1900
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      array['godfather'], 1900, 1900, array['disputed'], 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'кухар'
  ),
  'mixed-period groups exclude out-of-period relations, counters and samples'
);

select is(
  jsonb_array_length(public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    null, null, null, array['proven'], 1, 50, 0
  ) -> 'items'),
  2,
  'evidence-status filtering excludes likely and unknown assertions before aggregation'
);

select is(
  jsonb_array_length(public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000009',
    null, null, null, null, 1, 50, 0
  ) -> 'items'),
  0,
  'a confidential living center returns an empty network to a viewer'
);

select ok(
  (public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    null, null, null, null, 1, 1, 0
  ) ->> 'truncated')::boolean
  and public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    null, null, null, null, 1, 1, 0
  ) -> 'capReasons' ? 'pagination',
  'pagination is explicit in truncated and capReasons'
);

select throws_ok(
  $$ select public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    array['parent'], null, null, null, 1, 50, 0
  ) $$,
  '22023',
  'CHURCH_ROLE_NETWORK_ROLE_CODES_INVALID',
  'family role codes are rejected by the social-network RPC'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"cf100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item
    where item #>> '{counterpartGroup,normalizedSurname}' = 'секретний'
  ),
  'an editor may see the private living endpoint inside the project'
);

select is(
  (
    select source ->> 'label'
    from jsonb_array_elements(public.list_person_church_role_network_v1(
      'cf200000-0000-4000-8000-000000000001',
      'cf300000-0000-4000-8000-000000000001',
      null, null, null, null, 1, 50, 0
    ) -> 'items') item,
    lateral jsonb_array_elements(item -> 'sources') source
    where item #>> '{counterpartGroup,normalizedSurname}' = 'мерзляк'
    order by source ->> 'year'
    limit 1
  ),
  'Хрещення',
  'an editor receives the safe finding type, never transcription or notes'
);

reset role;

create temporary table church_network_before_counts on commit drop as
select
  (select count(*) from public.person_context_relations) as context_relations,
  (select count(*) from public.family_trees) as family_trees,
  (select count(*) from public.family_groups) as family_groups,
  (select count(*) from public.family_group_members) as family_group_members,
  (select count(*) from public.parent_child_relationships) as parent_links,
  (select count(*) from public.partner_relationships) as partner_links;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"cf100000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select count(*) filter (where invocation.payload is not null)
from (
  select public.list_person_church_role_network_v1(
    'cf200000-0000-4000-8000-000000000001',
    'cf300000-0000-4000-8000-000000000001',
    null, null, null, null, 1, 50, 0
  ) as payload
) invocation;
reset role;

select is(
  (select count(*) from public.person_context_relations),
  (select context_relations from church_network_before_counts),
  'the calculated network creates no cached context pairs'
);

select is(
  row(
    (select count(*) from public.family_trees),
    (select count(*) from public.family_groups),
    (select count(*) from public.family_group_members),
    (select count(*) from public.parent_child_relationships),
    (select count(*) from public.partner_relationships)
  )::text,
  (
    select row(
      family_trees, family_groups, family_group_members,
      parent_links, partner_links
    )::text
    from church_network_before_counts
  ),
  'the RPC neither reads into nor writes any family-tree relationship model'
);

select ok(
  pg_get_functiondef(
    'security_private.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)'::regprocedure
  ) like '%relation_cap constant integer := 10000%',
  'the backend enforces a hard relation scan cap'
);

select ok(
  pg_get_functiondef(
    'security_private.list_person_church_role_network_v1(uuid,uuid,text[],integer,integer,text[],integer,integer,integer)'::regprocedure
  ) like '%source_relation_candidates%target_relation_candidates%',
  'the network traverses indexed source and target branches instead of all Person pairs'
);

select * from finish();
rollback;
