begin;

-- Keep the existing exact, privacy-filtered computation intact. Only the public
-- counters are cached; no private records, identities, or source payloads.
do $migration$
begin
  if to_regprocedure('security_private.compute_zagulyaky_public_stats_v1()') is null then
    alter function security_private.get_zagulyaky_public_stats_v1()
      rename to compute_zagulyaky_public_stats_v1;
  end if;
end
$migration$;
revoke all on function security_private.compute_zagulyaky_public_stats_v1()
  from public, anon, authenticated, service_role;

create table if not exists security_private.zagulyaky_public_stats_cache (
  singleton boolean primary key default true check (singleton),
  payload jsonb,
  expires_at timestamptz not null default '-infinity'
);
revoke all on table security_private.zagulyaky_public_stats_cache from public, anon, authenticated, service_role;
insert into security_private.zagulyaky_public_stats_cache(singleton) values (true) on conflict do nothing;

-- Append-only invalidations avoid a singleton lock on every catalogue write.
-- One small row per transaction, drained by the next statistics refresh.
create table if not exists security_private.zagulyaky_stats_invalidations (
  transaction_id bigint primary key
);
revoke all on table security_private.zagulyaky_stats_invalidations from public, anon, authenticated, service_role;

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

  -- Preserve read-only/GET consumers. The application uses POST RPC, but an
  -- explicitly read-only transaction must still receive correct uncached data.
  if current_setting('transaction_read_only') = 'on' then
    return security_private.compute_zagulyaky_public_stats_v1();
  end if;

  -- Serialize cold readers only. Writers never acquire this advisory lock.
  perform pg_advisory_xact_lock(709100002::bigint);
  select payload into result from security_private.zagulyaky_public_stats_cache
    where singleton and expires_at > clock_timestamp()
      and not exists(select 1 from security_private.zagulyaky_stats_invalidations);
  if result is not null then return result; end if;
  -- Drain BEFORE computing. Concurrent/uncommitted invalidations are not in
  -- this DELETE's snapshot and survive to invalidate the newly computed value.
  delete from security_private.zagulyaky_stats_invalidations;
  result := security_private.compute_zagulyaky_public_stats_v1();
  update security_private.zagulyaky_public_stats_cache
    set payload = result, expires_at = clock_timestamp() + interval '60 seconds'
    where singleton;
  return result;
end
$function$;

-- The facade must be VOLATILE too: a cache miss is allowed to refresh the row.
create or replace function public.get_zagulyaky_public_stats_v1()
returns jsonb language sql volatile security invoker
set search_path = ''
as $wrapper$ select security_private.get_zagulyaky_public_stats_v1() $wrapper$;

create or replace function security_private.invalidate_zagulyaky_public_stats_v1()
returns trigger language plpgsql volatile security definer
set search_path = pg_catalog, public, security_private, pg_temp
as $function$
begin
  insert into security_private.zagulyaky_stats_invalidations(transaction_id)
    values (txid_current()) on conflict do nothing;
  return null;
end
$function$;
revoke all on function security_private.invalidate_zagulyaky_public_stats_v1()
  from public, anon, authenticated, service_role;

-- These are also every dependency of the living-person clearance fingerprint.
-- Statements, not individual rows, invalidate the cache during a bulk import.
do $migration$
declare table_name text;
begin
  foreach table_name in array array['zagulyaky_records', 'zagulyaky_participants',
    'zagulyaky_sources', 'zagulyaky_record_sources', 'zagulyaky_document_discoveries',
    'zagulyaky_privacy_clearances']
  loop
    execute format('drop trigger if exists zagulyaky_stats_invalidate on public.%I', table_name);
    execute format('create trigger zagulyaky_stats_invalidate after insert or update or delete or truncate
      on public.%I for each statement execute function security_private.invalidate_zagulyaky_public_stats_v1()', table_name);
  end loop;
end
$migration$;

revoke all on function public.get_zagulyaky_public_stats_v1() from public, anon, authenticated, service_role;
revoke all on function security_private.get_zagulyaky_public_stats_v1() from public, anon, authenticated, service_role;
grant execute on function public.get_zagulyaky_public_stats_v1() to anon, authenticated, service_role;
grant execute on function security_private.get_zagulyaky_public_stats_v1() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
