import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608250004_family_tree_statistics_search_path_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);

test("family-tree statistics keeps pg_temp last and qualifies shared scratch relations", () => {
  const protectedFunctions = [
    "security_private.prepare_family_tree_statistics_v1(jsonb)",
    "security_private.family_tree_statistics_profile_scores_v1()",
    "security_private.get_family_tree_statistics_tab_v1(jsonb,text)",
    "public.list_family_tree_statistics_people_v1(jsonb)",
  ];
  const scratchRelations = [
    "_ft_stats_kinship",
    "_ft_stats_direct_ancestors",
    "_ft_stats_population",
    "_ft_stats_parent_edges",
    "_ft_stats_ancestor_occurrences",
    "_ft_stats_detail_matches",
  ];

  assert.match(migration, /select pg_get_functiondef\(function_identifier\)/i);
  assert.match(migration, /execute function_definition/i);
  assert.match(
    migration,
    /alter function %s set search_path = pg_catalog, public, security_private, pg_temp/i,
  );
  assert.doesNotMatch(
    migration,
    /set search_path\s*=\s*pg_temp\s*,\s*public/i,
  );

  for (const functionIdentifier of protectedFunctions) {
    assert.match(migration, new RegExp(`'${functionIdentifier.replace(/[().]/g, "\\$&")}'::regprocedure`));
  }
  for (const scratchRelation of scratchRelations) {
    assert.match(migration, new RegExp(`'${scratchRelation}'`));
    assert.match(migration, /format\('pg_temp\.%s', scratch_relation\)/);
  }

  assert.match(
    migration,
    /create\[\[:space:\]\]\+temporary\[\[:space:\]\]\+table\[\[:space:\]\]\+pg_temp\[\.\]\%s[\s\S]*?create temporary table %s/i,
    "temporary-table creation stays valid while all later scratch-table accesses are qualified",
  );
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});

test("the statistics drill-down keeps its definer implementation outside the public API schema", () => {
  assert.match(
    migration,
    /alter function public\.list_family_tree_statistics_people_v1\(jsonb\)\s+set schema security_private/i,
  );
  assert.match(
    migration,
    /alter function security_private\.list_family_tree_statistics_people_v1\(jsonb\)\s+set statement_timeout = '45s'/i,
  );
  assert.match(
    migration,
    /create function public\.list_family_tree_statistics_people_v1\(\s*p_request jsonb\s*\)[\s\S]*?returns jsonb[\s\S]*?language sql[\s\S]*?volatile[\s\S]*?security invoker[\s\S]*?set search_path = pg_catalog[\s\S]*?security_private\.list_family_tree_statistics_people_v1\(\$1\)/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.list_family_tree_statistics_people_v1\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute on function public\.list_family_tree_statistics_people_v1\(jsonb\)[\s\S]*?to authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.list_family_tree_statistics_people_v1\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role;[\s\S]*?grant execute on function security_private\.list_family_tree_statistics_people_v1\(jsonb\)[\s\S]*?to authenticated, service_role;/i,
  );
});
