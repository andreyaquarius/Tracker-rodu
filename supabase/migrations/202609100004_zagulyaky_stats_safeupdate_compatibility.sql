begin;

-- Forward-only fix for 202609100002, which may already be applied by the
-- Supabase GitHub integration. Do not rewrite its migration history or disable
-- the database's protection against unqualified DELETE/UPDATE statements.
create or replace function security_private.get_zagulyaky_public_stats_v1()
returns jsonb language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
set statement_timeout = '10s'
as $function$
declare result jsonb;
begin
  select payload into result from security_private.zagulyaky_public_stats_cache
    where singleton and expires_at > clock_timestamp()
      and not exists(select 1 from security_private.zagulyaky_stats_invalidations);
  if result is not null then return result; end if;

  if current_setting('transaction_read_only') = 'on' then
    return security_private.compute_zagulyaky_public_stats_v1();
  end if;

  -- Keep the existing serialization for cold readers only. Catalogue writers
  -- still append invalidations without acquiring this advisory lock.
  perform pg_advisory_xact_lock(709100002::bigint);
  select payload into result from security_private.zagulyaky_public_stats_cache
    where singleton and expires_at > clock_timestamp()
      and not exists(select 1 from security_private.zagulyaky_stats_invalidations);
  if result is not null then return result; end if;

  -- This private queue contains only cache invalidation transaction IDs, never
  -- genealogy records. The primary key is NOT NULL: deliberately drain all
  -- markers visible to this DELETE, with an explicit condition for pg-safeupdate.
  -- Drain BEFORE computing; concurrently inserted/uncommitted markers outside
  -- this statement's snapshot must survive for the next refresh.
  delete from security_private.zagulyaky_stats_invalidations
    where transaction_id is not null;
  result := security_private.compute_zagulyaky_public_stats_v1();
  update security_private.zagulyaky_public_stats_cache
    set payload = result, expires_at = clock_timestamp() + interval '60 seconds'
    where singleton;
  return result;
end
$function$;

-- Preserve the existing private implementation/public invoker facade boundary.
revoke all on function security_private.get_zagulyaky_public_stats_v1()
  from public, anon, authenticated, service_role;
grant execute on function security_private.get_zagulyaky_public_stats_v1()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
