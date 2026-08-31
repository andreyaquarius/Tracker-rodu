begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Public Data API facades remain SECURITY INVOKER and call narrowly
-- allow-listed implementations in this non-exposed schema.  Schema USAGE is
-- therefore required for name resolution, while per-function EXECUTE grants
-- continue to control what each role may actually call.
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

-- The GeneHelp notification migration reset the shared schema ACL and omitted
-- anon.  Restore the established contract without exposing the schema through
-- PostgREST and without granting access to any table or function.
revoke all on schema security_private from public;
revoke create on schema security_private from anon, authenticated, service_role;
grant usage on schema security_private to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
