begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(10);

select ok(
  to_regprocedure('security_private.lock_historical_place_ids_v1(uuid[],boolean)') is not null
  and to_regprocedure('security_private.lock_historical_place_child_write_v1()') is not null,
  'one private advisory-lock contract serves RPC and trigger write paths'
);

select ok(
  pg_get_functiondef('security_private.lock_historical_place_ids_v1(uuid[],boolean)'::regprocedure)
    like '%select distinct candidate.place_id%'
  and pg_get_functiondef('security_private.lock_historical_place_ids_v1(uuid[],boolean)'::regprocedure)
    like '%order by candidate.place_id%'
  and pg_get_functiondef('security_private.lock_historical_place_ids_v1(uuid[],boolean)'::regprocedure)
    like '%pg_try_advisory_xact_lock%',
  'Place UUID locks are deterministic and support a fail-fast row-trigger path'
);

select ok(
  not has_function_privilege('anon', 'security_private.lock_historical_place_ids_v1(uuid[],boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'security_private.lock_historical_place_ids_v1(uuid[],boolean)', 'EXECUTE')
  and not has_function_privilege('service_role', 'security_private.lock_historical_place_ids_v1(uuid[],boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'security_private.lock_historical_place_child_write_v1()', 'EXECUTE'),
  'clients cannot forge internal historical Place lock operations'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_trigger trigger_row
    where trigger_row.tgname = 'place_names_12_historical_place_lock'
       or trigger_row.tgname = 'place_external_identifiers_12_historical_place_lock'
       or trigger_row.tgname = 'place_type_assignments_12_historical_place_lock'
       or trigger_row.tgname = 'place_hierarchy_relations_12_historical_place_lock'
       or trigger_row.tgname = 'place_boundaries_12_historical_place_lock'
       or trigger_row.tgname = 'place_relations_12_historical_place_lock'
       or trigger_row.tgname = 'place_parish_relations_12_historical_place_lock'
       or trigger_row.tgname = 'place_archive_relations_12_historical_place_lock'
       or trigger_row.tgname = 'document_place_links_12_historical_place_lock'
       or trigger_row.tgname = 'person_timeline_events_12_historical_place_lock'
  ),
  10,
  'every merge-managed child table has the common Place lock trigger'
);

select ok(
  position(
    'lock_historical_place_ids_v1' in
    pg_get_functiondef('security_private.merge_places_v1(uuid,uuid,integer,integer,text)'::regprocedure)
  ) < position(
    'for update' in lower(pg_get_functiondef(
      'security_private.merge_places_v1(uuid,uuid,integer,integer,text)'::regprocedure
    ))
  )
  and position(
    'lock_historical_place_ids_v1' in
    pg_get_functiondef('security_private.merge_places_v1(uuid,uuid,integer,integer,text)'::regprocedure)
  ) < position(
    'preview_data :=' in pg_get_functiondef(
      'security_private.merge_places_v1(uuid,uuid,integer,integer,text)'::regprocedure
    )
  ),
  'merge acquires both identity locks before row locks and its evidence snapshot'
);

select ok(
  position(
    'lock_historical_place_ids_v1' in
    pg_get_functiondef('security_private.set_person_event_place_v1(uuid,uuid,text,text,timestamp with time zone)'::regprocedure)
  ) < position(
    'for update' in lower(pg_get_functiondef(
      'security_private.set_person_event_place_v1(uuid,uuid,text,text,timestamp with time zone)'::regprocedure
    ))
  )
  and position(
    'lock_historical_place_ids_v1' in
    pg_get_functiondef('security_private.clear_person_event_place_v1(uuid,boolean,timestamp with time zone)'::regprocedure)
  ) < position(
    'for update' in lower(pg_get_functiondef(
      'security_private.clear_person_event_place_v1(uuid,boolean,timestamp with time zone)'::regprocedure
    ))
  ),
  'person-event link RPCs lock Place identities before event rows'
);

select ok(
  position(
    'lock_historical_place_ids_v1' in
    pg_get_functiondef('security_private.sync_person_event_places_from_person_v1()'::regprocedure)
  ) < position(
    'delete from public.person_timeline_events' in
    pg_get_functiondef('security_private.sync_person_event_places_from_person_v1()'::regprocedure)
  ),
  'person save bridge prelocks all old and requested Place identities before projection DML'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'security_private.add_place_name_v1(uuid,jsonb)',
      'security_private.update_place_name_v1(uuid,integer,jsonb)',
      'security_private.add_place_hierarchy_relation_v1(uuid,uuid,jsonb)',
      'security_private.add_place_parish_relation_v1(uuid,uuid,jsonb)',
      'security_private.add_place_archive_relation_v1(uuid,uuid,jsonb)',
      'security_private.create_and_link_place_archive_resource_v1(uuid,jsonb,jsonb)',
      'security_private.add_document_place_link_v1(uuid,uuid,jsonb)'
    ]) function_signature
    where pg_get_functiondef(function_signature::regprocedure)
      not like '%lock_historical_place_ids_v1%'
  ),
  'all Place child write RPCs acquire advisory locks before DML'
);

select ok(
  not exists (
    select 1
    from (
      values
        ('security_private.add_place_name_v1(uuid,jsonb)', 'insert into public.place_names'),
        ('security_private.update_place_name_v1(uuid,integer,jsonb)', 'update public.place_names'),
        ('security_private.add_place_hierarchy_relation_v1(uuid,uuid,jsonb)', 'insert into public.place_hierarchy_relations'),
        ('security_private.add_place_parish_relation_v1(uuid,uuid,jsonb)', 'insert into public.place_parish_relations'),
        ('security_private.add_place_archive_relation_v1(uuid,uuid,jsonb)', 'insert into public.place_archive_relations'),
        ('security_private.create_and_link_place_archive_resource_v1(uuid,jsonb,jsonb)', 'create_archive_resource_v1'),
        ('security_private.add_document_place_link_v1(uuid,uuid,jsonb)', 'insert into public.document_place_links')
    ) contract(function_signature, dml_marker)
    where position(
      'lock_historical_place_ids_v1' in
      lower(pg_get_functiondef(contract.function_signature::regprocedure))
    ) = 0
       or position(
         'lock_historical_place_ids_v1' in
         lower(pg_get_functiondef(contract.function_signature::regprocedure))
       ) > position(
         contract.dml_marker in
         lower(pg_get_functiondef(contract.function_signature::regprocedure))
       )
  ),
  'each child write RPC takes its Place lock before its first child-table DML'
);

select is(
  security_private.lock_historical_place_ids_v1(
    array[
      'fd900000-0000-4000-8000-000000000002'::uuid,
      'fd900000-0000-4000-8000-000000000001'::uuid,
      'fd900000-0000-4000-8000-000000000002'::uuid,
      null::uuid
    ],
    false
  ),
  true,
  'the nonblocking path accepts reversed duplicate UUID input and acquires the free distinct locks'
);

select * from finish();
rollback;
