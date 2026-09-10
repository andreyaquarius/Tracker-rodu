-- Local/staging regression only. All fixtures, function replacements and cache
-- writes are rolled back. Unlike the PGlite suite, this loads real pg-safeupdate.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
load 'safeupdate';
set local safeupdate.enabled = on;

select plan(13);

create temporary table stats_safeupdate_probe(id integer primary key);
insert into stats_safeupdate_probe values (1);
select throws_ok(
  'delete from stats_safeupdate_probe', '21000', 'DELETE requires a WHERE clause',
  'the real guard rejects an unqualified DELETE in this session'
);
select throws_ok(
  'update stats_safeupdate_probe set id=2', '21000', 'UPDATE requires a WHERE clause',
  'the real guard also protects unqualified UPDATE statements'
);

-- Keep this test independent of the size/content of the local catalogue.
-- The complete real aggregation and privacy rules are exercised by the PGlite
-- integration suite; here the real guard must permit the nested cache writes.
create or replace function security_private.compute_zagulyaky_public_stats_v1()
returns jsonb language sql stable security definer
set search_path = ''
as $fixture$
  select '{"people":17,"documents":3,"archives":2}'::jsonb
$fixture$;

update security_private.zagulyaky_public_stats_cache
  set payload=null, expires_at='-infinity' where singleton;
insert into security_private.zagulyaky_stats_invalidations(transaction_id)
  values (txid_current()) on conflict do nothing;

set local role anon;
select lives_ok(
  'select public.get_zagulyaky_public_stats_v1()',
  'anonymous cold RPC succeeds with safeupdate enabled'
);
reset role;
select is(
  (select payload from security_private.zagulyaky_public_stats_cache where singleton),
  '{"people":17,"documents":3,"archives":2}'::jsonb,
  'a successful cold request fills the cache with the exact result'
);
select is(
  (select count(*) from security_private.zagulyaky_stats_invalidations), 0::bigint,
  'the qualified DELETE drains the visible service markers'
);

create temporary table stats_cache_before_warm on commit drop as
  select expires_at from security_private.zagulyaky_public_stats_cache where singleton;
set local role anon;
select lives_ok(
  'select public.get_zagulyaky_public_stats_v1()',
  'anonymous warm RPC succeeds with safeupdate enabled'
);
reset role;
select is(
  (select expires_at from security_private.zagulyaky_public_stats_cache where singleton),
  (select expires_at from stats_cache_before_warm),
  'a warm request does not rewrite the cache expiry'
);

insert into security_private.zagulyaky_stats_invalidations(transaction_id)
  values (txid_current()) on conflict do nothing;
set local role authenticated;
select lives_ok(
  'select public.get_zagulyaky_public_stats_v1()',
  'an authenticated request refreshes an invalidated warm cache'
);
reset role;
select is(
  (select count(*) from security_private.zagulyaky_stats_invalidations), 0::bigint,
  'an authenticated refresh also drains the markers'
);

update security_private.zagulyaky_public_stats_cache
  set expires_at='-infinity' where singleton;
set local role service_role;
select lives_ok(
  'select public.get_zagulyaky_public_stats_v1()',
  'an expired cache with no invalidations refreshes for service_role'
);
reset role;

select throws_ok(
  'delete from stats_safeupdate_probe', '21000', 'DELETE requires a WHERE clause',
  'cache refreshes did not disable the real guard'
);
select ok(
  current_setting('safeupdate.enabled')::boolean,
  'safeupdate remains enabled after every public RPC'
);
select ok(
  not has_table_privilege('anon', 'security_private.zagulyaky_public_stats_cache', 'SELECT')
  and not has_table_privilege('authenticated', 'security_private.zagulyaky_stats_invalidations', 'SELECT')
  and not has_function_privilege('anon', 'security_private.compute_zagulyaky_public_stats_v1()', 'EXECUTE'),
  'the private cache, markers and exact computation remain inaccessible directly'
);

select * from finish();
rollback;
