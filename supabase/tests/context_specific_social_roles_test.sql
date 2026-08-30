begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

select is(
  (
    select count(*)::integer
    from public.context_relation_types
    where project_id is null
      and code in ('godfather', 'godmother', 'witness_for_bride', 'witness_for_groom')
      and is_system
      and is_active
      and directionality = 'directed'
  ),
  4,
  'four exact directed system roles are active'
);

select is(
  (select source_role_uk from public.context_relation_types where project_id is null and code = 'godfather'),
  'Хрещений батько',
  'godfather has an exact source-person role'
);

select is(
  (select source_role_uk from public.context_relation_types where project_id is null and code = 'godmother'),
  'Хрещена мати',
  'godmother has an exact source-person role'
);

select is(
  (select target_role_uk from public.context_relation_types where project_id is null and code = 'witness_for_bride'),
  'Учасник шлюбу',
  'bride-side witness targets a concrete marriage participant Person without inferring sex'
);

select is(
  (select target_role_uk from public.context_relation_types where project_id is null and code = 'witness_for_groom'),
  'Учасник шлюбу',
  'groom-side witness targets a concrete marriage participant Person without inferring sex'
);

select ok(
  (
    select bool_and((metadata ->> 'specificPersonRole')::boolean)
    from public.context_relation_types
    where project_id is null
      and code in ('godfather', 'godmother', 'witness_for_bride', 'witness_for_groom')
  ),
  'exact role types expose specific-Person semantics to clients'
);

select is(
  (
    select count(*)::integer
    from public.context_relation_types
    where project_id is null
      and code in ('godparent', 'witness')
      and is_active
      and (metadata ->> 'isGenericPersonRole')::boolean
      and (metadata ->> 'legacyAmbiguous')::boolean
      and not (metadata ->> 'allowNewManualAssertions')::boolean
  ),
  2,
  'generic historical types remain active as explicit fallbacks'
);

select is(
  security_private.legacy_person_context_type_code_v1('Хрещений батько'),
  'godfather',
  'legacy godfather wording maps to the exact role'
);

select is(
  security_private.legacy_person_context_type_code_v1('Хрещена мати'),
  'godmother',
  'legacy godmother wording maps to the exact role'
);

select is(
  security_private.legacy_person_context_type_code_v1('Свідок по нареченій'),
  'witness_for_bride',
  'legacy bride-side witness wording maps to the exact role'
);

select is(
  security_private.legacy_person_context_type_code_v1('Свідок по нареченому'),
  'witness_for_groom',
  'legacy groom-side witness wording maps to the exact role'
);

select is(
  security_private.legacy_person_context_type_code_v1('Свідок'),
  'witness',
  'ambiguous legacy witness wording remains generic'
);

create temporary table context_manual_type_policy_probe (
  relation_type_id uuid not null,
  assertion_kind text not null,
  marker text not null default ''
) on commit drop;

create trigger context_manual_type_policy_probe_trigger
before insert or update on context_manual_type_policy_probe
for each row execute function security_private.enforce_context_relation_manual_type_v1();

select throws_ok(
  $$
    insert into context_manual_type_policy_probe (relation_type_id, assertion_kind)
    select id, 'manual'
    from public.context_relation_types
    where project_id is null and code = 'godparent'
  $$,
  '22023',
  'CONTEXT_RELATION_TYPE_LEGACY_ONLY',
  'a new manual assertion cannot select the generic godparent type'
);

select throws_ok(
  $$
    insert into context_manual_type_policy_probe (relation_type_id, assertion_kind)
    select id, 'research_hypothesis'
    from public.context_relation_types
    where project_id is null and code = 'witness'
  $$,
  '22023',
  'CONTEXT_RELATION_TYPE_LEGACY_ONLY',
  'a new research hypothesis cannot select the generic witness type'
);

insert into context_manual_type_policy_probe (relation_type_id, assertion_kind, marker)
select id, 'legacy_import', 'legacy-before'
from public.context_relation_types
where project_id is null and code = 'godparent';

select is(
  (select count(*)::integer from context_manual_type_policy_probe where assertion_kind = 'legacy_import'),
  1,
  'legacy import synchronization may keep the generic type'
);

insert into context_manual_type_policy_probe (relation_type_id, assertion_kind, marker)
select id, 'generated', 'generated'
from public.context_relation_types
where project_id is null and code = 'witness';

select is(
  (select count(*)::integer from context_manual_type_policy_probe where assertion_kind = 'generated'),
  1,
  'generated synchronization may keep the generic type'
);

insert into context_manual_type_policy_probe (relation_type_id, assertion_kind, marker)
select id, 'manual', 'specific'
from public.context_relation_types
where project_id is null and code = 'godfather';

select is(
  (select count(*)::integer from context_manual_type_policy_probe where assertion_kind = 'manual'),
  1,
  'a new manual assertion may select an exact role'
);

update context_manual_type_policy_probe
set marker = 'legacy-after'
where assertion_kind = 'legacy_import';

select is(
  (select marker from context_manual_type_policy_probe where assertion_kind = 'legacy_import'),
  'legacy-after',
  'an existing legacy generic assertion remains editable without changing its type'
);

select throws_ok(
  $$
    update context_manual_type_policy_probe
    set assertion_kind = 'manual'
    where assertion_kind = 'legacy_import'
  $$,
  '22023',
  'CONTEXT_RELATION_ASSERTION_KIND_IMMUTABLE',
  'a legacy-import assertion cannot be relabelled as manual to bypass the generic-type guard'
);

select throws_ok(
  $$
    update context_manual_type_policy_probe probe
    set relation_type_id = relation_type.id
    from public.context_relation_types relation_type
    where probe.assertion_kind = 'manual'
      and relation_type.project_id is null
      and relation_type.code = 'witness'
  $$,
  '22023',
  'CONTEXT_RELATION_TYPE_LEGACY_ONLY',
  'a manual assertion cannot be changed from an exact role to a generic type'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  'cb100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'specific-role-test@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values (
  'cb100000-0000-4000-8000-000000000001',
  'specific-role-test@example.test',
  'Specific role test'
)
on conflict (user_id) do update
set email = excluded.email,
    display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values (
  'cb200000-0000-4000-8000-000000000001',
  'cb100000-0000-4000-8000-000000000001',
  'Specific role direction fixture'
);

insert into public.persons (id, project_id, full_name, is_living, privacy_status, created_by)
values
  (
    'cb300000-0000-4000-8000-000000000001',
    'cb200000-0000-4000-8000-000000000001',
    'Person whose card owns the legacy relation', false, 'project',
    'cb100000-0000-4000-8000-000000000001'
  ),
  (
    'cb300000-0000-4000-8000-000000000002',
    'cb200000-0000-4000-8000-000000000001',
    'Concrete role person', false, 'project',
    'cb100000-0000-4000-8000-000000000001'
  );

insert into public.person_relations (
  id, project_id, person_id, related_person_id, relation_type, created_by
) values
  (
    'cb400000-0000-4000-8000-000000000001',
    'cb200000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000002',
    'Хрещений батько', 'cb100000-0000-4000-8000-000000000001'
  ),
  (
    'cb400000-0000-4000-8000-000000000002',
    'cb200000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000002',
    'Хрещена мати', 'cb100000-0000-4000-8000-000000000001'
  ),
  (
    'cb400000-0000-4000-8000-000000000003',
    'cb200000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000002',
    'Свідок по нареченій', 'cb100000-0000-4000-8000-000000000001'
  ),
  (
    'cb400000-0000-4000-8000-000000000004',
    'cb200000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000001',
    'cb300000-0000-4000-8000-000000000002',
    'Свідок по нареченому', 'cb100000-0000-4000-8000-000000000001'
  );

select is(
  (
    select source_person_id::text || ':' || target_person_id::text
    from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'cb400000-0000-4000-8000-000000000001'
  ),
  'cb300000-0000-4000-8000-000000000002:cb300000-0000-4000-8000-000000000001',
  'exact godfather import directs role Person to the card Person'
);

select is(
  (
    select source_person_id::text || ':' || target_person_id::text
    from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'cb400000-0000-4000-8000-000000000002'
  ),
  'cb300000-0000-4000-8000-000000000002:cb300000-0000-4000-8000-000000000001',
  'exact godmother import directs role Person to the card Person'
);

select is(
  (
    select source_person_id::text || ':' || target_person_id::text
    from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'cb400000-0000-4000-8000-000000000003'
  ),
  'cb300000-0000-4000-8000-000000000002:cb300000-0000-4000-8000-000000000001',
  'bride-side witness import directs witness Person to the marriage participant'
);

select is(
  (
    select source_person_id::text || ':' || target_person_id::text
    from public.person_context_relations
    where legacy_source_table = 'person_relations'
      and legacy_source_id = 'cb400000-0000-4000-8000-000000000004'
  ),
  'cb300000-0000-4000-8000-000000000002:cb300000-0000-4000-8000-000000000001',
  'groom-side witness import directs witness Person to the marriage participant'
);

select * from finish();
rollback;
