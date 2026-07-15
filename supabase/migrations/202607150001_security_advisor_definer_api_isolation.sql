begin;

-- Security Advisor lint 0029 reports an exposed SECURITY DEFINER function
-- whenever authenticated can execute it through the public Data API schema.
-- Keep elevated implementations in a dedicated, non-exposed schema and leave
-- only SECURITY INVOKER compatibility facades in public.  ALTER ... SET SCHEMA
-- preserves each implementation's OID, body, owner and dependency graph, so
-- existing RLS policies continue to call the same trusted function object.
create schema if not exists security_private;
comment on schema security_private is
  'Trusted SECURITY DEFINER implementations. Do not add this schema to the PostgREST exposed schemas list.';

-- PostgREST injects this setting into API connections. It may be absent on a
-- direct migration connection, so this is a fail-fast check when available;
-- the deployment checklist must still verify the project API configuration.
do $exposed_schema_guard$
begin
  if 'security_private' = any(
    pg_catalog.regexp_split_to_array(
      coalesce(pg_catalog.current_setting('pgrst.db_schemas', true), ''),
      '[[:space:]]*,[[:space:]]*'
    )
  ) then
    raise exception 'SECURITY_PRIVATE_SCHEMA_MUST_NOT_BE_EXPOSED';
  end if;
end;
$exposed_schema_guard$;

revoke all on schema security_private from public, anon, authenticated, service_role;
grant usage on schema security_private to authenticated, service_role;
revoke create on schema security_private from public, anon, authenticated, service_role;

-- Every schema in a SECURITY DEFINER search_path must be non-writable by the
-- calling API roles. PostgreSQL 15 installations normally have this revoked
-- already, but make the invariant explicit for upgraded projects as well.
revoke create on schema public from public, anon, authenticated, service_role;

alter default privileges in schema security_private
  revoke execute on functions from public;

alter function public.accept_project_invitation(uuid)
  set schema security_private;
alter function public.admin_list_family_tree_feature_access()
  set schema security_private;
alter function public.admin_set_family_tree_feature_access(uuid, boolean)
  set schema security_private;
alter function public.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb)
  set schema security_private;
alter function public.begin_table_import(uuid)
  set schema security_private;
alter function public.can_edit_project(uuid)
  set schema security_private;
alter function public.can_read_exact_family_group(uuid, uuid)
  set schema security_private;
alter function public.can_read_exact_family_tree_person(uuid, uuid)
  set schema security_private;
alter function public.can_read_exact_parent_set(uuid, uuid)
  set schema security_private;
alter function public.can_use_family_tree_feature()
  set schema security_private;
alter function public.cancel_legacy_gedcom_cleanup(uuid)
  set schema security_private;
alter function public.cancel_my_subscription()
  set schema security_private;
alter function public.clear_project_records_for_restore(uuid, integer)
  set schema security_private;
alter function public.complete_gedcom_import_operation(uuid)
  set schema security_private;
alter function public.get_dashboard_stats(uuid)
  set schema security_private;
alter function public.get_family_tree_descendants_frontier_v1(jsonb)
  set schema security_private;
alter function public.get_family_tree_family_children_v1(jsonb)
  set schema security_private;
alter function public.get_family_tree_neighborhood_v1(jsonb)
  set schema security_private;
alter function public.get_family_tree_neighborhood_v2(jsonb)
  set schema security_private;
alter function public.get_legacy_gedcom_cleanup_status(uuid)
  set schema security_private;
alter function public.get_my_subscription_context(uuid)
  set schema security_private;
alter function public.get_project_deletion_status(uuid)
  set schema security_private;
alter function public.is_app_admin(uuid)
  set schema security_private;
alter function public.is_project_member(uuid)
  set schema security_private;
alter function public.is_project_owner(uuid)
  set schema security_private;
alter function public.list_accessible_project_deletions()
  set schema security_private;
alter function public.process_project_deletion(uuid, integer)
  set schema security_private;
alter function public.register_gedcom_import_archive(uuid, uuid)
  set schema security_private;
alter function public.register_gedcom_import_entities(uuid, text, uuid[])
  set schema security_private;
alter function public.register_gedcom_import_tree(uuid, uuid)
  set schema security_private;
alter function public.rollback_gedcom_import_operation(uuid, integer)
  set schema security_private;
alter function public.seal_gedcom_import_operation(uuid)
  set schema security_private;
alter function public.start_gedcom_import_operation(uuid, text)
  set schema security_private;
alter function public.start_legacy_gedcom_cleanup(uuid, text, integer)
  set schema security_private;
alter function public.start_project_deletion(uuid)
  set schema security_private;
alter function public.touch_gedcom_import_operation(uuid)
  set schema security_private;

-- API roles need EXECUTE here because the SECURITY INVOKER facades and RLS
-- policies run as those roles. Data API isolation therefore depends on this
-- schema remaining outside PostgREST's exposed schemas. The deletion
-- processor is service-only even inside the trusted schema.
revoke all on function
  security_private.accept_project_invitation(uuid),
  security_private.admin_list_family_tree_feature_access(),
  security_private.admin_set_family_tree_feature_access(uuid, boolean),
  security_private.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb),
  security_private.begin_table_import(uuid),
  security_private.can_edit_project(uuid),
  security_private.can_read_exact_family_group(uuid, uuid),
  security_private.can_read_exact_family_tree_person(uuid, uuid),
  security_private.can_read_exact_parent_set(uuid, uuid),
  security_private.can_use_family_tree_feature(),
  security_private.cancel_legacy_gedcom_cleanup(uuid),
  security_private.cancel_my_subscription(),
  security_private.clear_project_records_for_restore(uuid, integer),
  security_private.complete_gedcom_import_operation(uuid),
  security_private.get_dashboard_stats(uuid),
  security_private.get_family_tree_descendants_frontier_v1(jsonb),
  security_private.get_family_tree_family_children_v1(jsonb),
  security_private.get_family_tree_neighborhood_v1(jsonb),
  security_private.get_family_tree_neighborhood_v2(jsonb),
  security_private.get_legacy_gedcom_cleanup_status(uuid),
  security_private.get_my_subscription_context(uuid),
  security_private.get_project_deletion_status(uuid),
  security_private.is_app_admin(uuid),
  security_private.is_project_member(uuid),
  security_private.is_project_owner(uuid),
  security_private.list_accessible_project_deletions(),
  security_private.process_project_deletion(uuid, integer),
  security_private.register_gedcom_import_archive(uuid, uuid),
  security_private.register_gedcom_import_entities(uuid, text, uuid[]),
  security_private.register_gedcom_import_tree(uuid, uuid),
  security_private.rollback_gedcom_import_operation(uuid, integer),
  security_private.seal_gedcom_import_operation(uuid),
  security_private.start_gedcom_import_operation(uuid, text),
  security_private.start_legacy_gedcom_cleanup(uuid, text, integer),
  security_private.start_project_deletion(uuid),
  security_private.touch_gedcom_import_operation(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  security_private.accept_project_invitation(uuid),
  security_private.admin_list_family_tree_feature_access(),
  security_private.admin_set_family_tree_feature_access(uuid, boolean),
  security_private.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb),
  security_private.begin_table_import(uuid),
  security_private.can_edit_project(uuid),
  security_private.can_read_exact_family_group(uuid, uuid),
  security_private.can_read_exact_family_tree_person(uuid, uuid),
  security_private.can_read_exact_parent_set(uuid, uuid),
  security_private.can_use_family_tree_feature(),
  security_private.cancel_my_subscription(),
  security_private.clear_project_records_for_restore(uuid, integer),
  security_private.complete_gedcom_import_operation(uuid),
  security_private.get_dashboard_stats(uuid),
  security_private.get_family_tree_descendants_frontier_v1(jsonb),
  security_private.get_family_tree_family_children_v1(jsonb),
  security_private.get_family_tree_neighborhood_v1(jsonb),
  security_private.get_family_tree_neighborhood_v2(jsonb),
  security_private.get_legacy_gedcom_cleanup_status(uuid),
  security_private.get_my_subscription_context(uuid),
  security_private.get_project_deletion_status(uuid),
  security_private.is_app_admin(uuid),
  security_private.is_project_member(uuid),
  security_private.is_project_owner(uuid),
  security_private.list_accessible_project_deletions(),
  security_private.register_gedcom_import_archive(uuid, uuid),
  security_private.register_gedcom_import_entities(uuid, text, uuid[]),
  security_private.register_gedcom_import_tree(uuid, uuid),
  security_private.rollback_gedcom_import_operation(uuid, integer),
  security_private.seal_gedcom_import_operation(uuid),
  security_private.start_gedcom_import_operation(uuid, text),
  security_private.start_project_deletion(uuid),
  security_private.touch_gedcom_import_operation(uuid)
  to authenticated, service_role;

grant execute on function
  security_private.cancel_legacy_gedcom_cleanup(uuid),
  security_private.start_legacy_gedcom_cleanup(uuid, text, integer)
  to authenticated;

grant execute on function security_private.process_project_deletion(uuid, integer)
  to service_role;

create function public.accept_project_invitation(invitation_id uuid)
returns uuid
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.accept_project_invitation($1);
$wrapper$;

create function public.admin_list_family_tree_feature_access()
returns table (
  user_id uuid,
  email text,
  display_name text,
  is_enabled boolean,
  is_admin boolean,
  granted_at timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select * from security_private.admin_list_family_tree_feature_access();
$wrapper$;

create function public.admin_set_family_tree_feature_access(
  target_user_id uuid,
  target_is_enabled boolean
)
returns void
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.admin_set_family_tree_feature_access($1, $2);
$wrapper$;

create function public.begin_ai_credit_usage(
  target_project_id uuid,
  feature_key text,
  credits_requested integer default 1,
  input_chars integer default 0,
  output_chars integer default 0,
  model text default null,
  metadata jsonb default '{}'::jsonb
)
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
begin
  if length(coalesce(feature_key, '')) > 64 then
    raise exception 'AI_FEATURE_KEY_TOO_LONG' using errcode = '22023';
  end if;
  if length(coalesce(model, '')) > 200 then
    raise exception 'AI_MODEL_NAME_TOO_LONG' using errcode = '22023';
  end if;
  if pg_catalog.octet_length(coalesce(metadata, '{}'::jsonb)::text) > 65536 then
    raise exception 'AI_METADATA_TOO_LARGE' using errcode = '22023';
  end if;
  return security_private.begin_ai_credit_usage(
    target_project_id,
    feature_key,
    credits_requested,
    greatest(0, least(coalesce(input_chars, 0), 10000000)),
    greatest(0, least(coalesce(output_chars, 0), 10000000)),
    model,
    metadata
  );
end;
$wrapper$;

create function public.begin_table_import(target_project_id uuid)
returns integer
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.begin_table_import($1);
$wrapper$;

create function public.can_edit_project(target_project_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.can_edit_project($1);
$wrapper$;

create function public.can_read_exact_family_group(
  target_project_id uuid,
  target_family_group_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.can_read_exact_family_group($1, $2);
$wrapper$;

create function public.can_read_exact_family_tree_person(
  target_project_id uuid,
  target_person_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.can_read_exact_family_tree_person($1, $2);
$wrapper$;

create function public.can_read_exact_parent_set(
  target_project_id uuid,
  target_parent_set_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.can_read_exact_parent_set($1, $2);
$wrapper$;

create function public.can_use_family_tree_feature()
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.can_use_family_tree_feature();
$wrapper$;

create function public.cancel_legacy_gedcom_cleanup(target_job_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.cancel_legacy_gedcom_cleanup($1);
$wrapper$;

create function public.cancel_my_subscription()
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.cancel_my_subscription();
$wrapper$;

create function public.clear_project_records_for_restore(
  target_project_id uuid,
  batch_size integer default 500
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.clear_project_records_for_restore($1, $2);
$wrapper$;

create function public.complete_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.complete_gedcom_import_operation($1);
$wrapper$;

create function public.get_dashboard_stats(target_project_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_dashboard_stats($1);
$wrapper$;

create function public.get_family_tree_descendants_frontier_v1(p_request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_family_tree_descendants_frontier_v1($1);
$wrapper$;

create function public.get_family_tree_family_children_v1(p_request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_family_tree_family_children_v1($1);
$wrapper$;

create function public.get_family_tree_neighborhood_v1(p_request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_family_tree_neighborhood_v1($1);
$wrapper$;

create function public.get_family_tree_neighborhood_v2(p_request jsonb)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_family_tree_neighborhood_v2($1);
$wrapper$;

create function public.get_legacy_gedcom_cleanup_status(target_job_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_legacy_gedcom_cleanup_status($1);
$wrapper$;

create function public.get_my_subscription_context(target_project_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_my_subscription_context($1);
$wrapper$;

create function public.get_project_deletion_status(target_job_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.get_project_deletion_status($1);
$wrapper$;

-- Preserve the existing target-user contract: plan and quota helpers inspect
-- project owners other than the current caller. Authorization-sensitive admin
-- mutations still enforce their own current-user admin guard.
create function public.is_app_admin(target_user_id uuid default auth.uid())
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.is_app_admin($1);
$wrapper$;

create function public.is_project_member(target_project_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.is_project_member($1);
$wrapper$;

create function public.is_project_owner(target_project_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.is_project_owner($1);
$wrapper$;

create function public.list_accessible_project_deletions()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_accessible_project_deletions();
$wrapper$;

-- Destructive deletion batches are executed only by the service-role Edge
-- worker.  Browser clients continue to use start/status plus the worker wake.
create function public.process_project_deletion(
  target_job_id uuid,
  batch_size integer default 250
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  return security_private.process_project_deletion(target_job_id, batch_size);
end;
$wrapper$;

create function public.register_gedcom_import_archive(
  target_operation_id uuid,
  target_import_batch_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.register_gedcom_import_archive($1, $2);
$wrapper$;

create function public.register_gedcom_import_entities(
  target_operation_id uuid,
  target_entity_type text,
  target_entity_ids uuid[]
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.register_gedcom_import_entities($1, $2, $3);
$wrapper$;

create function public.register_gedcom_import_tree(
  target_operation_id uuid,
  target_tree_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.register_gedcom_import_tree($1, $2);
$wrapper$;

create function public.rollback_gedcom_import_operation(
  target_operation_id uuid,
  batch_size integer default 250
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.rollback_gedcom_import_operation($1, $2);
$wrapper$;

create function public.seal_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.seal_gedcom_import_operation($1);
$wrapper$;

create function public.start_gedcom_import_operation(
  target_project_id uuid,
  target_source_key text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.start_gedcom_import_operation($1, $2);
$wrapper$;

create function public.start_legacy_gedcom_cleanup(
  target_project_id uuid,
  target_source_key text,
  expected_person_count integer
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.start_legacy_gedcom_cleanup($1, $2, $3);
$wrapper$;

create function public.start_project_deletion(target_project_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.start_project_deletion($1);
$wrapper$;

create function public.touch_gedcom_import_operation(target_operation_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.touch_gedcom_import_operation($1);
$wrapper$;

revoke all on function
  public.accept_project_invitation(uuid),
  public.admin_list_family_tree_feature_access(),
  public.admin_set_family_tree_feature_access(uuid, boolean),
  public.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb),
  public.begin_table_import(uuid),
  public.can_edit_project(uuid),
  public.can_read_exact_family_group(uuid, uuid),
  public.can_read_exact_family_tree_person(uuid, uuid),
  public.can_read_exact_parent_set(uuid, uuid),
  public.can_use_family_tree_feature(),
  public.cancel_legacy_gedcom_cleanup(uuid),
  public.cancel_my_subscription(),
  public.clear_project_records_for_restore(uuid, integer),
  public.complete_gedcom_import_operation(uuid),
  public.get_dashboard_stats(uuid),
  public.get_family_tree_descendants_frontier_v1(jsonb),
  public.get_family_tree_family_children_v1(jsonb),
  public.get_family_tree_neighborhood_v1(jsonb),
  public.get_family_tree_neighborhood_v2(jsonb),
  public.get_legacy_gedcom_cleanup_status(uuid),
  public.get_my_subscription_context(uuid),
  public.get_project_deletion_status(uuid),
  public.is_app_admin(uuid),
  public.is_project_member(uuid),
  public.is_project_owner(uuid),
  public.list_accessible_project_deletions(),
  public.process_project_deletion(uuid, integer),
  public.register_gedcom_import_archive(uuid, uuid),
  public.register_gedcom_import_entities(uuid, text, uuid[]),
  public.register_gedcom_import_tree(uuid, uuid),
  public.rollback_gedcom_import_operation(uuid, integer),
  public.seal_gedcom_import_operation(uuid),
  public.start_gedcom_import_operation(uuid, text),
  public.start_legacy_gedcom_cleanup(uuid, text, integer),
  public.start_project_deletion(uuid),
  public.touch_gedcom_import_operation(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.accept_project_invitation(uuid),
  public.admin_list_family_tree_feature_access(),
  public.admin_set_family_tree_feature_access(uuid, boolean),
  public.begin_ai_credit_usage(uuid, text, integer, integer, integer, text, jsonb),
  public.begin_table_import(uuid),
  public.can_edit_project(uuid),
  public.can_read_exact_family_group(uuid, uuid),
  public.can_read_exact_family_tree_person(uuid, uuid),
  public.can_read_exact_parent_set(uuid, uuid),
  public.can_use_family_tree_feature(),
  public.cancel_my_subscription(),
  public.clear_project_records_for_restore(uuid, integer),
  public.complete_gedcom_import_operation(uuid),
  public.get_dashboard_stats(uuid),
  public.get_family_tree_descendants_frontier_v1(jsonb),
  public.get_family_tree_family_children_v1(jsonb),
  public.get_family_tree_neighborhood_v1(jsonb),
  public.get_family_tree_neighborhood_v2(jsonb),
  public.get_legacy_gedcom_cleanup_status(uuid),
  public.get_my_subscription_context(uuid),
  public.get_project_deletion_status(uuid),
  public.is_app_admin(uuid),
  public.is_project_member(uuid),
  public.is_project_owner(uuid),
  public.list_accessible_project_deletions(),
  public.register_gedcom_import_archive(uuid, uuid),
  public.register_gedcom_import_entities(uuid, text, uuid[]),
  public.register_gedcom_import_tree(uuid, uuid),
  public.rollback_gedcom_import_operation(uuid, integer),
  public.seal_gedcom_import_operation(uuid),
  public.start_gedcom_import_operation(uuid, text),
  public.start_project_deletion(uuid),
  public.touch_gedcom_import_operation(uuid)
  to authenticated, service_role;

grant execute on function
  public.cancel_legacy_gedcom_cleanup(uuid),
  public.start_legacy_gedcom_cleanup(uuid, text, integer)
  to authenticated;

grant execute on function public.process_project_deletion(uuid, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
