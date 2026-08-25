begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(18);

create temporary table expected_security_advisor_functions (
  signature text primary key,
  implementation_signature text,
  moved_to_private boolean not null,
  anonymous_execute boolean not null default false,
  authenticated_execute boolean not null,
  service_execute boolean not null
) on commit drop;

insert into expected_security_advisor_functions (
  signature,
  moved_to_private,
  authenticated_execute,
  service_execute
) values
  ('public.accept_project_invitation(uuid)', true, true, true),
  ('public.admin_list_family_tree_feature_access()', true, true, true),
  ('public.admin_set_family_tree_feature_access(uuid,boolean)', true, true, true),
  ('public.begin_ai_credit_usage(uuid,text,integer,integer,integer,text,jsonb)', true, true, true),
  ('public.begin_table_import(uuid)', true, true, true),
  ('public.can_edit_project(uuid)', true, true, true),
  ('public.can_read_exact_family_group(uuid,uuid)', true, true, true),
  ('public.can_read_exact_family_tree_person(uuid,uuid)', true, true, true),
  ('public.can_read_exact_parent_set(uuid,uuid)', true, true, true),
  ('public.can_use_family_tree_feature()', true, true, true),
  ('public.cancel_legacy_gedcom_cleanup(uuid)', true, true, false),
  ('public.cancel_my_subscription()', true, true, true),
  ('public.clear_project_records_for_restore(uuid,integer)', true, true, true),
  ('public.complete_gedcom_import_operation(uuid)', true, true, true),
  ('public.get_dashboard_stats(uuid)', true, true, true),
  ('public.get_family_tree_descendants_frontier_v1(jsonb)', true, true, true),
  ('public.get_family_tree_family_children_v1(jsonb)', true, true, true),
  ('public.get_family_tree_neighborhood_v1(jsonb)', true, true, true),
  ('public.get_family_tree_neighborhood_v2(jsonb)', true, true, true),
  ('public.get_legacy_gedcom_cleanup_status(uuid)', true, true, true),
  ('public.get_my_subscription_context(uuid)', true, true, true),
  ('public.get_project_deletion_status(uuid)', true, true, true),
  ('public.is_app_admin(uuid)', true, true, true),
  ('public.is_project_member(uuid)', true, true, true),
  ('public.is_project_owner(uuid)', true, true, true),
  ('public.list_accessible_project_deletions()', true, true, true),
  ('public.process_project_deletion(uuid,integer)', true, false, true),
  ('public.register_gedcom_import_archive(uuid,uuid)', true, true, true),
  ('public.register_gedcom_import_entities(uuid,text,uuid[])', true, true, true),
  ('public.register_gedcom_import_tree(uuid,uuid)', true, true, true),
  ('public.rollback_gedcom_import_operation(uuid,integer)', true, true, true),
  ('public.seal_gedcom_import_operation(uuid)', true, true, true),
  ('public.start_gedcom_import_operation(uuid,text)', true, true, true),
  ('public.start_legacy_gedcom_cleanup(uuid,text,integer)', true, true, false),
  ('public.start_project_deletion(uuid)', true, true, true),
  ('public.touch_gedcom_import_operation(uuid)', true, true, true);

-- The remaining current Advisor surface: 28 Zagulyaky RPCs and the
-- family-tree statistics drill-down.  The five catalogue functions are the
-- only endpoints intentionally callable without signing in.
insert into expected_security_advisor_functions (
  signature,
  implementation_signature,
  moved_to_private,
  anonymous_execute,
  authenticated_execute,
  service_execute
) values
  ('public.get_public_zagulyaka_v1(text)', 'security_private.get_public_zagulyaka_api_v1(text)', true, true, true, true),
  ('public.get_zagulyaky_public_stats_v1()', null, true, true, true, true),
  ('public.list_public_zagulyaky_indexing_v1(text,integer,text)', null, true, true, true, true),
  ('public.search_zagulyaky_documents_v1(text,jsonb,integer,timestamptz,uuid)', null, true, true, true, true),
  ('public.search_zagulyaky_people_v1(text,jsonb,integer,timestamptz,uuid)', null, true, true, true, true),
  ('public.admin_list_zagulyaky_claims_v1(text,integer,integer)', null, true, false, true, true),
  ('public.admin_list_zagulyaky_queue_v1(text,integer,integer)', null, true, false, true, true),
  ('public.admin_review_zagulyaka_v1(uuid,integer,text,text,text,text,text)', null, true, false, true, true),
  ('public.attach_my_zagulyaka_file_v1(uuid,integer,text,text,text,bigint,text)', null, true, false, true, true),
  ('public.confirm_zagulyaka_v1(uuid,text,text)', null, true, false, true, true),
  ('public.create_zagulyaka_claim_v1(uuid,text,text)', null, true, false, true, true),
  ('public.create_zagulyaka_draft_v1(text,jsonb)', null, true, false, true, true),
  ('public.delete_my_zagulyaka_attachment_v2(uuid,uuid,integer)', null, true, false, true, true),
  ('public.delete_my_zagulyaka_draft_v3(uuid,integer)', null, true, false, true, true),
  ('public.delete_my_zagulyaky_saved_place_v1(uuid)', null, true, false, true, true),
  ('public.delete_my_zagulyaky_saved_source_preset_v1(uuid)', null, true, false, true, true),
  ('public.get_my_zagulyaka_draft_v1(uuid)', null, true, false, true, true),
  ('public.get_my_zagulyaky_page_v1(text,integer,integer)', null, true, false, true, true),
  ('public.get_my_zagulyaky_v1(text,integer,integer)', null, true, false, true, true),
  ('public.list_my_zagulyaky_saved_places_v1(text,integer)', null, true, false, true, true),
  ('public.list_my_zagulyaky_saved_source_presets_v1(text,integer)', null, true, false, true, true),
  ('public.replace_my_zagulyaka_details_v1(uuid,integer,jsonb,jsonb,jsonb)', null, true, false, true, true),
  ('public.set_zagulyaka_bookmark_v1(uuid,boolean)', null, true, false, true, true),
  ('public.submit_zagulyaka_v1(uuid,integer)', null, true, false, true, true),
  ('public.update_my_zagulyaka_draft_v1(uuid,integer,jsonb)', null, true, false, true, true),
  ('public.upsert_my_zagulyaky_saved_place_v1(jsonb)', null, true, false, true, true),
  ('public.upsert_my_zagulyaky_saved_source_preset_v1(jsonb)', null, true, false, true, true),
  ('public.withdraw_zagulyaka_v1(uuid,integer)', null, true, false, true, true),
  ('public.list_family_tree_statistics_people_v1(jsonb)', null, true, false, true, true);

create temporary table expected_rls_helper_functions (
  signature text primary key
) on commit drop;

insert into expected_rls_helper_functions (signature) values
  ('security_private.can_edit_project(uuid)'),
  ('security_private.can_read_exact_family_group(uuid,uuid)'),
  ('security_private.can_read_exact_family_tree_person(uuid,uuid)'),
  ('security_private.can_read_exact_parent_set(uuid,uuid)'),
  ('security_private.can_use_family_tree_feature()'),
  ('security_private.is_app_admin(uuid)'),
  ('security_private.is_project_member(uuid)'),
  ('security_private.is_project_owner(uuid)');

select is(
  (select count(*)::integer from expected_security_advisor_functions),
  65,
  'the regression list covers all 65 protected Security Advisor entry points'
);

select has_schema(
  'security_private',
  'elevated implementations live outside the public Data API schema'
);

select ok(
  has_schema_privilege('authenticated', 'security_private', 'USAGE')
  and not has_schema_privilege('authenticated', 'security_private', 'CREATE')
  and has_schema_privilege('anon', 'security_private', 'USAGE')
  and not has_schema_privilege('anon', 'security_private', 'CREATE')
  and has_schema_privilege('service_role', 'security_private', 'USAGE')
  and not has_schema_privilege('service_role', 'security_private', 'CREATE')
  and not has_schema_privilege('authenticated', 'public', 'CREATE')
  and not has_schema_privilege('anon', 'public', 'CREATE'),
  'API roles cannot create objects in trusted search-path schemas'
);

select ok(
  bool_and(to_regprocedure(signature) is not null),
  'all public RPC signatures remain available'
)
from expected_security_advisor_functions;

select ok(
  bool_and(not function_record.prosecdef),
  'all moved public entry points are SECURITY INVOKER facades'
)
from expected_security_advisor_functions expected
join pg_proc function_record
  on function_record.oid = to_regprocedure(expected.signature)
where expected.moved_to_private;

select ok(
  bool_and(private_function.oid is not null and private_function.prosecdef),
  'all moved implementations remain SECURITY DEFINER in the trusted schema'
)
from expected_security_advisor_functions expected
left join pg_proc private_function
  on private_function.oid = to_regprocedure(coalesce(
    expected.implementation_signature,
    regexp_replace(expected.signature, '^public\.', 'security_private.')
  ))
where expected.moved_to_private;

select ok(
  bool_and(
    public_function.proargnames is not distinct from private_function.proargnames
    and pg_get_function_arguments(public_function.oid)
      = pg_get_function_arguments(private_function.oid)
    and public_function.provolatile = private_function.provolatile
    and pg_get_function_result(public_function.oid)
      = pg_get_function_result(private_function.oid)
  ),
  'facades preserve argument names, exact defaults, volatility and return contracts'
)
from expected_security_advisor_functions expected
join pg_proc public_function
  on public_function.oid = to_regprocedure(expected.signature)
join pg_proc private_function
  on private_function.oid = to_regprocedure(coalesce(
    expected.implementation_signature,
    regexp_replace(expected.signature, '^public\.', 'security_private.')
  ))
where expected.moved_to_private;

select ok(
  bool_and(
    has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')
      = authenticated_execute
  ),
  'authenticated can execute only the intended public RPCs'
)
from expected_security_advisor_functions;

select ok(
  bool_and(
    has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')
      = service_execute
  ),
  'service_role retains only the intended public maintenance surface'
)
from expected_security_advisor_functions;

select ok(
  bool_and(
    has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')
      = anonymous_execute
  ),
  'anonymous callers can execute only the intended public catalogue RPCs'
)
from expected_security_advisor_functions;

select ok(
  bool_and(
    has_function_privilege(
      'authenticated',
      to_regprocedure(coalesce(
        implementation_signature,
        regexp_replace(signature, '^public\.', 'security_private.')
      )),
      'EXECUTE'
    ) = authenticated_execute
  ),
  'trusted implementations have the same authenticated ACL as their facades'
)
from expected_security_advisor_functions
where moved_to_private;

select ok(
  bool_and(
    has_function_privilege(
      'service_role',
      to_regprocedure(coalesce(
        implementation_signature,
        regexp_replace(signature, '^public\.', 'security_private.')
      )),
      'EXECUTE'
    ) = service_execute
  ),
  'service workers can execute only the intended moved implementations'
)
from expected_security_advisor_functions
where moved_to_private;

select ok(
  bool_and(
    has_function_privilege(
      'anon',
      to_regprocedure(coalesce(
        implementation_signature,
        regexp_replace(signature, '^public\.', 'security_private.')
      )),
      'EXECUTE'
    ) = anonymous_execute
  ),
  'anonymous callers can execute only the intended trusted catalogue implementations'
)
from expected_security_advisor_functions
where moved_to_private;

select is(
  (
    select count(*)
    from pg_proc function_record
    join pg_namespace schema_record
      on schema_record.oid = function_record.pronamespace
    where schema_record.nspname = any(
        case
          when coalesce(current_setting('pgrst.db_schemas', true), '') = ''
            then array['public']::text[]
          else regexp_split_to_array(
            current_setting('pgrst.db_schemas', true),
            '[[:space:]]*,[[:space:]]*'
          )
        end
      )
      and schema_record.nspname not in (
        '_timescaledb_cache',
        '_timescaledb_catalog',
        '_timescaledb_config',
        '_timescaledb_internal',
        'auth',
        'cron',
        'extensions',
        'graphql',
        'graphql_public',
        'information_schema',
        'net',
        'pgmq',
        'pgroonga',
        'pgsodium',
        'pgsodium_masks',
        'pgtle',
        'pgbouncer',
        'pg_catalog',
        'realtime',
        'repack',
        'storage',
        'supabase_functions',
        'supabase_migrations',
        'tiger',
        'topology',
        'vault'
      )
      and function_record.prosecdef
      and (
        has_function_privilege('authenticated', function_record.oid, 'EXECUTE')
        or has_function_privilege('anon', function_record.oid, 'EXECUTE')
      )
  ),
  0::bigint,
  'Security Advisor has no API-executable SECURITY DEFINER function in exposed schemas'
);

select ok(
  bool_and(function_record.proconfig @> array['search_path=pg_catalog']::text[]),
  'every exposed facade has a fixed trusted search_path'
)
from expected_security_advisor_functions expected
join pg_proc function_record
  on function_record.oid = to_regprocedure(expected.signature)
where expected.moved_to_private;

select ok(
  bool_and(
    exists (
      select 1
      from unnest(coalesce(function_record.proconfig, array[]::text[])) setting
      where setting like 'search_path=%'
    )
  ),
  'every elevated implementation retains an explicit search_path'
)
from expected_security_advisor_functions expected
join pg_proc function_record
  on function_record.oid = to_regprocedure(coalesce(
    expected.implementation_signature,
    regexp_replace(expected.signature, '^public\.', 'security_private.')
  ))
where expected.moved_to_private;

select ok(
  bool_and(owner_role.rolname not in ('anon', 'authenticated', 'authenticator', 'service_role')),
  'no API role owns an elevated implementation'
)
from expected_security_advisor_functions expected
join pg_proc function_record
  on function_record.oid = to_regprocedure(coalesce(
    expected.implementation_signature,
    regexp_replace(expected.signature, '^public\.', 'security_private.')
  ))
join pg_roles owner_role on owner_role.oid = function_record.proowner
where expected.moved_to_private;

select ok(
  bool_and(
    exists (
      select 1
      from pg_depend dependency_record
      where dependency_record.classid = 'pg_catalog.pg_policy'::regclass
        and dependency_record.refclassid = 'pg_catalog.pg_proc'::regclass
        and dependency_record.refobjid = to_regprocedure(expected.signature)
    )
  ),
  'every moved RLS helper retains at least one policy dependency'
)
from expected_rls_helper_functions expected;

select * from finish();
rollback;
