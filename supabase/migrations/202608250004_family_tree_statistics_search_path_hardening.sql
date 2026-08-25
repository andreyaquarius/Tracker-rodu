begin;

-- These functions create and share session-local scratch relations.  Their old
-- path put pg_temp first, which is unnecessary once every scratch-table read
-- and write is schema-qualified.  Keep CREATE TEMPORARY TABLE unqualified:
-- PostgreSQL deliberately rejects a schema-qualified target for a temporary
-- table, while the TEMPORARY keyword itself always selects this session's
-- temporary schema.
--
-- Rebuild the *currently installed* definitions rather than copying their
-- large bodies.  That preserves follow-up fixes (for example the first-marriage
-- drill-down patch) on both new and existing projects.
do $migration$
declare
  function_identifier regprocedure;
  function_definition text;
  scratch_relation text;
  placeholder text;
  function_identifiers regprocedure[] := array[
    'security_private.prepare_family_tree_statistics_v1(jsonb)'::regprocedure,
    'security_private.family_tree_statistics_profile_scores_v1()'::regprocedure,
    'security_private.get_family_tree_statistics_tab_v1(jsonb,text)'::regprocedure,
    'public.list_family_tree_statistics_people_v1(jsonb)'::regprocedure
  ];
  scratch_relations text[] := array[
    '_ft_stats_kinship',
    '_ft_stats_direct_ancestors',
    '_ft_stats_population',
    '_ft_stats_parent_edges',
    '_ft_stats_ancestor_occurrences',
    '_ft_stats_detail_matches'
  ];
begin
  foreach function_identifier in array function_identifiers loop
    select pg_get_functiondef(function_identifier)
      into function_definition;

    if function_definition is null then
      raise exception 'FAMILY_TREE_STATISTICS_FUNCTION_NOT_FOUND: %', function_identifier;
    end if;

    foreach scratch_relation in array scratch_relations loop
      -- Preserve references that were already qualified before replacing the
      -- remaining unqualified occurrences.  The marker is intentionally
      -- generated from the relation name, so a definition that already has
      -- qualified names is transformed safely.
      placeholder := format('__tracker_rodu_stats_temp_%s__', md5(scratch_relation));
      function_definition := replace(
        function_definition,
        format('pg_temp.%s', scratch_relation),
        placeholder
      );
      function_definition := replace(
        function_definition,
        scratch_relation,
        format('pg_temp.%s', scratch_relation)
      );
      function_definition := replace(
        function_definition,
        placeholder,
        format('pg_temp.%s', scratch_relation)
      );

      -- CREATE TEMPORARY TABLE cannot name a schema.  Its TEMPORARY modifier
      -- is the explicit session-scratch guarantee; every later access uses
      -- pg_temp.<relation> and is therefore immune to search_path shadowing.
      function_definition := regexp_replace(
        function_definition,
        format(
          'create[[:space:]]+temporary[[:space:]]+table[[:space:]]+pg_temp[.]%s',
          scratch_relation
        ),
        format('create temporary table %s', scratch_relation),
        'gi'
      );
    end loop;

    execute function_definition;
    execute format(
      'alter function %s set search_path = pg_catalog, public, security_private, pg_temp',
      function_identifier::text
    );
  end loop;
end;
$migration$;

-- The drill-down endpoint is called by the browser, but its authoritative
-- implementation must not remain a SECURITY DEFINER function in the exposed
-- public schema. Moving it preserves the function OID/body/dependencies; the
-- compatibility facade below deliberately has no elevated privileges.
alter function public.list_family_tree_statistics_people_v1(jsonb)
  set schema security_private;

alter function security_private.list_family_tree_statistics_people_v1(jsonb)
  set statement_timeout = '45s';

revoke all on function security_private.list_family_tree_statistics_people_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function security_private.list_family_tree_statistics_people_v1(jsonb)
  to authenticated, service_role;

create function public.list_family_tree_statistics_people_v1(
  p_request jsonb
)
returns jsonb
language sql
volatile
security invoker
set search_path = pg_catalog
as $wrapper$
  select security_private.list_family_tree_statistics_people_v1($1);
$wrapper$;

revoke all on function public.list_family_tree_statistics_people_v1(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.list_family_tree_statistics_people_v1(jsonb)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
