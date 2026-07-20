import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607180002_family_tree_root_lineage.sql",
    import.meta.url,
  ),
  "utf8",
);

const implementationStart = migration.indexOf(
  "create or replace function security_private.get_family_tree_root_lineage_v1",
);
const implementationEnd = migration.indexOf(
  "$implementation$;",
  implementationStart,
);
const implementation = migration.slice(
  implementationStart,
  implementationEnd,
);
const traversalStart = implementation.indexOf(
  "with parent_candidates as materialized",
);
const traversalEnd = implementation.indexOf(
  "select coalesce(jsonb_agg(person_json",
  traversalStart,
);
const traversal = implementation.slice(traversalStart, traversalEnd);

test("root-lineage RPC follows the trusted implementation plus public invoker facade architecture", () => {
  assert.ok(implementationStart >= 0 && implementationEnd > implementationStart);
  assert.match(implementation, /language plpgsql[\s\S]*?security definer/i);
  assert.match(implementation, /set search_path = pg_temp, public/i);
  assert.match(implementation, /perform public\.assert_family_tree_feature_access\(\)/i);
  assert.match(implementation, /auth\.uid\(\) is null/i);
  assert.match(implementation, /public\.is_project_member\(current_project_id\)/i);

  assert.match(
    migration,
    /create or replace function public\.get_family_tree_root_lineage_v1[\s\S]*?security invoker[\s\S]*?set search_path = pg_catalog[\s\S]*?select security_private\.get_family_tree_root_lineage_v1\(\$1\)/i,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.get_family_tree_root_lineage_v1\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_family_tree_root_lineage_v1\(jsonb\)[\s\S]*?to authenticated, service_role/i,
  );
  assert.doesNotMatch(
    migration,
    /create or replace function public\.get_family_tree_root_lineage_v1[\s\S]*?security definer/i,
  );
});

test("root-lineage traversal is bounded and expands only readable direct parents", () => {
  assert.ok(traversalStart >= 0 && traversalEnd > traversalStart);
  assert.match(
    implementation,
    /requested_ancestor_depth := greatest\([\s\S]*?least\([\s\S]*?16\)[\s\S]*?\);/i,
  );
  assert.match(
    implementation,
    /requested_max_nodes := greatest\([\s\S]*?least\([\s\S]*?600\)[\s\S]*?\);/i,
  );
  assert.match(traversal, /relation\.child_id = frontier\.person_id/i);
  assert.match(traversal, /relation\.parent_id/i);
  assert.match(traversal, /parent_member\.member_role <> 'hidden'/i);
  assert.match(traversal, /relation\.evidence_status <> 'disproven'/i);
  assert.match(
    traversal,
    /relation\.privacy_status <> 'confidential'[\s\S]*?public\.can_edit_project\(relation\.project_id\)/i,
  );
  assert.match(
    traversal,
    /limit greatest\(requested_max_nodes - selected_count, 0\)/i,
  );
  assert.doesNotMatch(traversal, /family_tree_neighbor_page/i);
  assert.doesNotMatch(traversal, /family_tree_populate_continuations/i);
});

test("root-lineage response preserves graph and privacy contracts without continuation work", () => {
  assert.match(implementation, /then 'Приватна особа'/i);
  assert.match(implementation, /jsonb_build_object\('privacy', 'masked'\)/i);
  assert.doesNotMatch(implementation, /custom_fields/i);
  assert.doesNotMatch(implementation, /'notes'/i);
  assert.match(implementation, /'persons', persons_payload/i);
  assert.match(implementation, /'unions', unions_payload/i);
  assert.match(implementation, /'parentChildRelations', relations_payload/i);
  assert.match(implementation, /'continuations', '\[\]'::jsonb/i);
  assert.match(implementation, /'familyContinuations', '\[\]'::jsonb/i);
  assert.match(implementation, /'graphVersion', current_graph_version::text/i);
  assert.match(implementation, /'permissionFingerprint', permission_fingerprint/i);
  assert.match(implementation, /TREE_GRAPH_VERSION_CHANGED/i);
  assert.match(implementation, /TREE_PERMISSION_SCOPE_CHANGED/i);
});
