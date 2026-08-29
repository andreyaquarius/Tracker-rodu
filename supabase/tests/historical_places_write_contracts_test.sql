begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(50);

select ok(
  to_regprocedure('public.patch_project_place_v1(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.add_place_name_v1(uuid,jsonb)') is not null
  and to_regprocedure('public.update_place_name_v1(uuid,integer,jsonb)') is not null
  and to_regprocedure('public.add_place_hierarchy_relation_v1(uuid,uuid,jsonb)') is not null
  and to_regprocedure('public.add_place_parish_relation_v1(uuid,uuid,jsonb)') is not null
  and to_regprocedure('public.create_archive_resource_v1(uuid,jsonb)') is not null
  and to_regprocedure('public.add_place_archive_relation_v1(uuid,uuid,jsonb)') is not null
  and to_regprocedure('public.create_and_link_place_archive_resource_v1(uuid,jsonb,jsonb)') is not null
  and to_regprocedure('public.add_document_place_link_v1(uuid,uuid,jsonb)') is not null
  and to_regprocedure('public.list_place_audit_history_v1(uuid,integer,bigint)') is not null,
  'versioned historical-place write and audit RPCs exist'
);

select ok(
  not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.patch_project_place_v1(uuid,integer,jsonb)'::regprocedure)
  and (select prosecdef from pg_catalog.pg_proc
       where oid = 'security_private.patch_project_place_v1(uuid,integer,jsonb)'::regprocedure)
  and not (select prosecdef from pg_catalog.pg_proc
       where oid = 'public.list_place_audit_history_v1(uuid,integer,bigint)'::regprocedure)
  and (select prosecdef from pg_catalog.pg_proc
       where oid = 'security_private.list_place_audit_history_v1(uuid,integer,bigint)'::regprocedure),
  'public APIs are invoker facades over explicitly authorized definer bodies'
);

select ok(
  has_function_privilege('authenticated', 'public.patch_project_place_v1(uuid,integer,jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.add_place_name_v1(uuid,jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_place_audit_history_v1(uuid,integer,bigint)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.patch_project_place_v1(uuid,integer,jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.list_place_audit_history_v1(uuid,integer,bigint)', 'EXECUTE'),
  'write and private audit contracts are authenticated-only'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'security_private.assert_historical_place_payload_v1(jsonb,text[],text,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'security_private.require_historical_place_edit_v1(uuid)',
    'EXECUTE'
  ),
  'authorization and payload helpers are not directly callable by clients'
);

select ok(
  not has_table_privilege('authenticated', 'public.places', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.place_names', 'UPDATE'),
  'authenticated clients cannot bypass optimistic Place and PlaceName RPC updates'
);

select is(
  private.project_deletion_uncovered_table_names(),
  array[]::text[],
  'write contracts add no uncovered project-owned persistence'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
(
  '00000000-0000-0000-0000-000000000000',
  'fc100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'places-write-owner@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
),
(
  '00000000-0000-0000-0000-000000000000',
  'fc100000-0000-4000-8000-000000000002',
  'authenticated', 'authenticated', 'places-write-other@example.test', '', now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()
);

insert into public.profiles (user_id, email, display_name) values
('fc100000-0000-4000-8000-000000000001', 'places-write-owner@example.test', 'Places write owner'),
('fc100000-0000-4000-8000-000000000002', 'places-write-other@example.test', 'Places write other')
on conflict (user_id) do update set
  email = excluded.email,
  display_name = excluded.display_name;

insert into public.projects (id, owner_id, name) values
('fc200000-0000-4000-8000-000000000001', 'fc100000-0000-4000-8000-000000000001', 'Places write project'),
('fc200000-0000-4000-8000-000000000002', 'fc100000-0000-4000-8000-000000000002', 'Other places project'),
('fc200000-0000-4000-8000-000000000003', 'fc100000-0000-4000-8000-000000000001', 'Places write cascade project');

insert into public.researches (id, project_id, title, created_by) values
('fc300000-0000-4000-8000-000000000001', 'fc200000-0000-4000-8000-000000000001', 'Places write research', 'fc100000-0000-4000-8000-000000000001'),
('fc300000-0000-4000-8000-000000000002', 'fc200000-0000-4000-8000-000000000002', 'Other places research', 'fc100000-0000-4000-8000-000000000002'),
('fc300000-0000-4000-8000-000000000003', 'fc200000-0000-4000-8000-000000000003', 'Cascade places research', 'fc100000-0000-4000-8000-000000000001');

insert into public.documents (
  id, project_id, research_id, title, place, created_by
) values
(
  'fc400000-0000-4000-8000-000000000001',
  'fc200000-0000-4000-8000-000000000001',
  'fc300000-0000-4000-8000-000000000001',
  'Метрична книга', 'при селі Старому',
  'fc100000-0000-4000-8000-000000000001'
),
(
  'fc400000-0000-4000-8000-000000000002',
  'fc200000-0000-4000-8000-000000000002',
  'fc300000-0000-4000-8000-000000000002',
  'Чужий документ', 'чуже місце',
  'fc100000-0000-4000-8000-000000000002'
);

insert into public.places (
  id, project_id, canonical_name, modern_name, status,
  verification_status, created_by
) values
('fc500000-0000-4000-8000-000000000001', 'fc200000-0000-4000-8000-000000000001', 'Старе село', '', 'active', 'unverified', 'fc100000-0000-4000-8000-000000000001'),
('fc500000-0000-4000-8000-000000000002', 'fc200000-0000-4000-8000-000000000001', 'Старий повіт', '', 'active', 'unverified', 'fc100000-0000-4000-8000-000000000001'),
('fc500000-0000-4000-8000-000000000003', 'fc200000-0000-4000-8000-000000000001', 'Парафія святого Миколая', '', 'active', 'unverified', 'fc100000-0000-4000-8000-000000000001'),
('fc500000-0000-4000-8000-000000000004', 'fc200000-0000-4000-8000-000000000002', 'Чуже місце', '', 'active', 'unverified', 'fc100000-0000-4000-8000-000000000002'),
('fc500000-0000-4000-8000-000000000005', null, 'Глобальне перевірене місце', '', 'active', 'verified', null),
('fc500000-0000-4000-8000-000000000006', null, 'Глобальне неперевірене місце', '', 'active', 'unverified', null),
('fc500000-0000-4000-8000-000000000007', 'fc200000-0000-4000-8000-000000000003', 'Каскадне місце', '', 'active', 'unverified', 'fc100000-0000-4000-8000-000000000001');

insert into public.archive_resources (
  id, project_id, resource_type, title, original_text, created_by
) values (
  'fc600000-0000-4000-8000-000000000002',
  'fc200000-0000-4000-8000-000000000002',
  'archive', 'Чужий архів', 'Чужий архів',
  'fc100000-0000-4000-8000-000000000002'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fc100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.places
   where id = 'fc500000-0000-4000-8000-000000000001'),
  1::bigint,
  'RLS lets an owner read a private place in their project'
);

select is(
  (select count(*) from public.places
   where id = 'fc500000-0000-4000-8000-000000000004'),
  0::bigint,
  'RLS hides another project private place'
);

select is(
  public.patch_project_place_v1(
    'fc500000-0000-4000-8000-000000000001', 1,
    '{"canonicalName":"Старе (історичне) село","description":"Уточнено за джерелом","latitude":49.12,"longitude":28.45}'::jsonb
  ) ->> 'canonicalName',
  'Старе (історичне) село',
  'owner can patch a project-private Place'
);

select is(
  (select lock_version from public.places
   where id = 'fc500000-0000-4000-8000-000000000001'),
  2,
  'Place patch increments the optimistic lock version'
);

select is(
  (select row(modern_name, status, verification_status, metadata)::text
   from public.places
   where id = 'fc500000-0000-4000-8000-000000000001'),
  row('', 'active', 'unverified', '{}'::jsonb)::text,
  'an omitted Place PATCH field is preserved instead of being cleared'
);

select throws_ok(
  $$update public.places
    set description = 'direct optimistic-lock bypass'
    where id = 'fc500000-0000-4000-8000-000000000001'$$,
  '42501', 'permission denied for table places',
  'direct authenticated Place UPDATE cannot bypass expected_lock_version'
);

select throws_ok(
  $$select public.patch_project_place_v1(
    'fc500000-0000-4000-8000-000000000001', 1,
    '{"description":"stale"}'::jsonb
  )$$,
  '40001', 'PLACE_VERSION_CONFLICT',
  'a stale Place patch is rejected'
);

select throws_ok(
  $$select public.patch_project_place_v1(
    'fc500000-0000-4000-8000-000000000001', 2,
    '{"projectId":"fc200000-0000-4000-8000-000000000002"}'::jsonb
  )$$,
  '22023', 'PLACE_PATCH_FIELD_NOT_ALLOWED: projectId',
  'Place scope and unsupported fields cannot be patched'
);

select throws_ok(
  $$select public.patch_project_place_v1(
    'fc500000-0000-4000-8000-000000000005', 1,
    '{"description":"direct global edit"}'::jsonb
  )$$,
  '42501', 'GLOBAL_PLACE_CHANGE_REQUEST_REQUIRED',
  'authenticated global Place edits require a change request'
);

select is(
  public.add_place_name_v1(
    'fc500000-0000-4000-8000-000000000001',
    '{"name":"Старое село","originalText":"изъ села Старого","languageCode":"ru","nameType":"historical","validFrom":"1800-01-01","validTo":"1899-12-31"}'::jsonb
  ) ->> 'originalText',
  'изъ села Старого',
  'adding a historical name stores exact source text'
);

select set_config(
  'test.place_name_id',
  (select id::text from public.place_names
   where place_id = 'fc500000-0000-4000-8000-000000000001'
     and original_text = 'изъ села Старого'),
  true
);

select is(
  public.update_place_name_v1(
    current_setting('test.place_name_id')::uuid, 1,
    '{"name":"Старе село","languageCode":"uk","note":"Нормалізована форма"}'::jsonb
  ) ->> 'originalText',
  'изъ села Старого',
  'name metadata can be updated without changing exact source wording'
);

select is(
  (select original_text from public.place_names
   where id = current_setting('test.place_name_id')::uuid),
  'изъ села Старого',
  'the stored original_text remains byte-for-byte unchanged'
);

select throws_ok(
  format(
    'update public.place_names set original_text = %L where id = %L::uuid',
    'переписаний напряму текст',
    current_setting('test.place_name_id')
  ),
  '42501', 'permission denied for table place_names',
  'direct authenticated PlaceName UPDATE cannot rewrite exact evidence'
);

select throws_ok(
  format(
    'select public.update_place_name_v1(%L::uuid, 2, %L::jsonb)',
    current_setting('test.place_name_id'),
    '{"originalText":"переписаний текст"}'
  ),
  '22023', 'PLACE_NAME_PATCH_FIELD_NOT_ALLOWED: originalText',
  'the name update contract does not accept originalText'
);

select throws_ok(
  format(
    'select public.update_place_name_v1(%L::uuid, 1, %L::jsonb)',
    current_setting('test.place_name_id'),
    '{"note":"stale"}'
  ),
  '40001', 'PLACE_NAME_VERSION_CONFLICT',
  'a stale historical-name update is rejected'
);

select is(
  public.add_place_hierarchy_relation_v1(
    'fc500000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000002',
    '{"relationType":"administrative_parent","validFrom":"1800-01-01","validTo":"1899-12-31","sourceReference":"Метрична книга"}'::jsonb
  ) ->> 'validFrom',
  '1800-01-01',
  'owner can add a dated hierarchy relation'
);

select throws_ok(
  $$select public.add_place_hierarchy_relation_v1(
    'fc500000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000004', '{}'::jsonb
  )$$,
  '22023', 'HIERARCHY_PROJECT_SCOPE_MISMATCH',
  'hierarchy relations cannot cross private project scopes'
);

select is(
  public.add_place_parish_relation_v1(
    'fc500000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000003',
    '{"religion":"orthodox","validFrom":"1810-01-01","validTo":"1900-12-31","originalText":"приходъ св. Николая"}'::jsonb
  ) ->> 'originalText',
  'приходъ св. Николая',
  'owner can add a dated parish relation with exact evidence wording'
);

select throws_ok(
  $$select public.add_place_parish_relation_v1(
    'fc500000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000004',
    '{"religion":"orthodox"}'::jsonb
  )$$,
  '22023', 'PLACE_RELATION_PROJECT_SCOPE_MISMATCH',
  'parish relations cannot cross private project scopes'
);

select set_config(
  'test.archive_id',
  public.create_archive_resource_v1(
    'fc200000-0000-4000-8000-000000000001',
    '{"resourceType":"file","title":"Метрична книга 1862","archiveName":"ЦДІАК","fund":"127","inventory":"1012","fileReference":"45","originalText":"ЦДІАК, ф. 127, оп. 1012, спр. 45"}'::jsonb
  ) ->> 'id',
  true
);

select is(
  (select original_text from public.archive_resources
   where id = current_setting('test.archive_id')::uuid),
  'ЦДІАК, ф. 127, оп. 1012, спр. 45',
  'owner can create a project-private archive resource'
);

select is(
  public.add_place_archive_relation_v1(
    'fc500000-0000-4000-8000-000000000001',
    current_setting('test.archive_id')::uuid,
    '{"validFrom":"1800-01-01","validTo":"1899-12-31","originalText":"матеріали про Старе село"}'::jsonb
  ) ->> 'archiveResourceId',
  current_setting('test.archive_id'),
  'owner can link a project archive resource to a Place'
);

select set_config(
  'test.atomic_archive_id',
  public.create_and_link_place_archive_resource_v1(
    'fc500000-0000-4000-8000-000000000001',
    '{"resourceType":"inventory","title":"Атомарний опис 1862","archiveName":"ЦДІАК","originalText":"ф. 127, оп. 1012"}'::jsonb,
    '{"validFrom":"1862-01-01","validTo":"1862-12-31","originalText":"матеріали за 1862 рік"}'::jsonb
  ) #>> '{resource,id}',
  true
);

select is(
  (
    select count(*)::integer
    from public.archive_resources resource_row
    join public.place_archive_relations relation_row
      on relation_row.archive_resource_id = resource_row.id
    where resource_row.id = current_setting('test.atomic_archive_id')::uuid
      and relation_row.place_id = 'fc500000-0000-4000-8000-000000000001'
  ),
  1,
  'atomic archive RPC creates the resource and its Place relation together'
);

select throws_ok(
  $$select public.create_and_link_place_archive_resource_v1(
    'fc500000-0000-4000-8000-000000000001',
    '{"resourceType":"file","title":"Не має лишитися","originalText":"тимчасовий ресурс"}'::jsonb,
    '{"validFrom":"1900-01-01","validTo":"1800-01-01","originalText":"помилковий період"}'::jsonb
  )$$,
  '23514',
  'new row for relation "place_archive_relations" violates check constraint "place_archive_relations_valid_period_check"',
  'an invalid relation aborts the atomic archive RPC'
);

select is(
  (
    select count(*)::integer
    from public.archive_resources
    where title = 'Не має лишитися'
      and project_id = 'fc200000-0000-4000-8000-000000000001'
  ),
  0,
  'a failed atomic archive link leaves no orphan resource'
);

select is(
  public.add_document_place_link_v1(
    'fc400000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000001',
    '{"relationType":"mentions","originalText":"изъ села Старого","confidence":95}'::jsonb
  ) ->> 'originalText',
  'изъ села Старого',
  'owner can explicitly link a document to a Place with exact source text'
);

select is(
  (select place from public.documents
   where id = 'fc400000-0000-4000-8000-000000000001'),
  'при селі Старому',
  'linking a canonical Place does not rewrite the legacy document place field'
);

select is(
  (select original_text from public.document_place_links
   where document_id = 'fc400000-0000-4000-8000-000000000001'
     and place_id = 'fc500000-0000-4000-8000-000000000001'),
  'изъ села Старого',
  'document link retains exact source wording separately from the canonical Place'
);

select throws_ok(
  $$select public.add_document_place_link_v1(
    'fc400000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000004',
    '{"originalText":"чуже місце"}'::jsonb
  )$$,
  '22023', 'DOCUMENT_PLACE_PROJECT_SCOPE_MISMATCH',
  'document links cannot cross private project scopes'
);

select is(
  public.add_document_place_link_v1(
    'fc400000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000005',
    '{"originalText":"глобальне місце"}'::jsonb
  ) ->> 'placeId',
  'fc500000-0000-4000-8000-000000000005',
  'a project document may reference an active verified global Place'
);

select throws_ok(
  $$select public.add_document_place_link_v1(
    'fc400000-0000-4000-8000-000000000001',
    'fc500000-0000-4000-8000-000000000006',
    '{"originalText":"неперевірене місце"}'::jsonb
  )$$,
  '42501', 'DOCUMENT_PLACE_GLOBAL_ACCESS_REQUIRED',
  'an unverified global Place cannot be linked by an authenticated client'
);

select ok(
  jsonb_array_length(public.list_place_audit_history_v1(
    'fc500000-0000-4000-8000-000000000001', 100, null
  )) >= 6,
  'project owner can read a bounded history covering Place edits and child records'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.list_place_audit_history_v1(
      'fc500000-0000-4000-8000-000000000001', 100, null
    )) history_row
    where history_row ->> 'entityTable' = 'places'
      and history_row ->> 'action' = 'update'
  ),
  'Place audit history includes the optimistic patch event'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.list_place_audit_history_v1(
      'fc500000-0000-4000-8000-000000000001', 100, null
    )) history_row
    where history_row ->> 'entityTable' in (
      'place_names','place_hierarchy_relations','place_parish_relations',
      'place_archive_relations','document_place_links'
    )
      and history_row ->> 'actorId' = 'fc100000-0000-4000-8000-000000000001'
  ),
  'audited child changes retain the authenticated actor'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fc100000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.list_place_audit_history_v1(
    'fc500000-0000-4000-8000-000000000001', 50, null
  )$$,
  '42501', 'PLACE_AUDIT_ACCESS_REQUIRED',
  'another project member cannot read private Place audit history'
);

select throws_ok(
  $$select public.patch_project_place_v1(
    'fc500000-0000-4000-8000-000000000001', 2,
    '{"description":"unauthorized"}'::jsonb
  )$$,
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED',
  'another project owner cannot patch the private Place'
);

select throws_ok(
  $$select public.create_archive_resource_v1(
    'fc200000-0000-4000-8000-000000000001',
    '{"resourceType":"archive","title":"unauthorized"}'::jsonb
  )$$,
  '42501', 'PROJECT_EDIT_ACCESS_REQUIRED',
  'another project owner cannot create archive data in this project'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"fc100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select public.create_archive_resource_v1(
    null,
    '{"resourceType":"archive","title":"direct global archive"}'::jsonb
  )$$,
  '42501', 'GLOBAL_ARCHIVE_CHANGE_REQUEST_REQUIRED',
  'authenticated clients cannot create global archive resources directly'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.patch_project_place_v1(
    'fc500000-0000-4000-8000-000000000005', 1,
    '{"description":"curated by service"}'::jsonb
  ) ->> 'description',
  'curated by service',
  'service role remains the explicit direct mutation path for a global Place'
);

select throws_ok(
  format(
    'update public.place_names set original_text = %L where id = %L::uuid',
    'service rewrite must also fail',
    current_setting('test.place_name_id')
  ),
  '22023', 'HISTORICAL_ORIGINAL_TEXT_IMMUTABLE',
  'even a service write cannot overwrite non-empty exact source evidence'
);

reset role;

select ok(
  exists (
    select 1 from security_private.historical_place_audit_log audit_row
    where audit_row.entity_table = 'archive_resources'
      and audit_row.entity_id = current_setting('test.archive_id')::uuid
      and audit_row.action = 'insert'
  ),
  'archive-resource writes fire the immutable audit trigger'
);

select ok(
  exists (
    select 1 from security_private.historical_place_audit_log audit_row
    where audit_row.place_id = 'fc500000-0000-4000-8000-000000000001'
      and audit_row.actor_id = 'fc100000-0000-4000-8000-000000000001'
  ),
  'private Place audit rows retain project and actor ownership'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"fc100000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  public.add_place_name_v1(
    'fc500000-0000-4000-8000-000000000007',
    '{"name":"Каскадне історичне","originalText":"Каскадне історичне"}'::jsonb
  ) ->> 'originalText',
  'Каскадне історичне',
  'cascade fixture is created through the same authenticated write contract'
);

reset role;

delete from public.projects
where id = 'fc200000-0000-4000-8000-000000000003';

select is(
  row(
    (select count(*) from public.places
     where project_id = 'fc200000-0000-4000-8000-000000000003'),
    (select count(*) from public.place_names
     where project_id = 'fc200000-0000-4000-8000-000000000003')
  )::text,
  row(0::bigint, 0::bigint)::text,
  'project deletion removes Place and historical-name rows created through RPCs'
);

select is(
  (select count(*) from security_private.historical_place_audit_log
   where project_id = 'fc200000-0000-4000-8000-000000000003'),
  0::bigint,
  'project deletion also removes the private historical-place audit history'
);

select * from finish();
rollback;
