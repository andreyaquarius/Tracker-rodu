import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607110002_family_tree_family_scope.sql",
    import.meta.url,
  ),
  "utf8",
);
const pgTap = readFileSync(
  new URL("../supabase/tests/family_tree_family_scope_test.sql", import.meta.url),
  "utf8",
);

test("family-scope migration is additive and keeps neighborhood v1 intact", () => {
  assert.doesNotMatch(
    migration,
    /create\s+or\s+replace\s+function\s+public\.get_family_tree_neighborhood_v1/i,
  );
  assert.match(
    migration,
    /create\s+or\s+replace\s+function\s+public\.get_family_tree_neighborhood_v2/i,
  );
  assert.match(
    migration,
    /create\s+or\s+replace\s+function\s+public\.get_family_tree_family_children_v1/i,
  );
});

test("family-scope SQL narrows v2 work before family-group fanout", () => {
  const v2Start = migration.indexOf(
    "create or replace function public.get_family_tree_neighborhood_v2",
  );
  assert.ok(v2Start >= 0);
  const v2 = migration.slice(v2Start);
  assert.match(v2, /selected_people as materialized/);
  assert.match(v2, /seed_parent_set_ids as materialized/);
  assert.match(v2, /candidate_parent_set_ids as materialized/);
  assert.doesNotMatch(v2, /family_tree_parent_set_scope_id_v1\s*\(/);
});

test("family pagination binds visible-child exclusions and returns nextCursor", () => {
  assert.match(migration, /'excludedChildIds'/);
  assert.match(migration, /'excludedChildDigest'/);
  assert.match(migration, /'nextCursor'/);
  assert.match(migration, /jsonb_typeof\(cursor_payload -> 'birthMissing'\)/);
  assert.match(migration, /jsonb_typeof\(cursor_payload -> 'birthSort'\)/);
  assert.match(migration, /cardinality\(scope\.parent_ids\) between 1 and 8/);
});

test("family-scope pgTAP plan matches its assertion count", () => {
  const plan = Number(pgTap.match(/select\s+plan\((\d+)\)/i)?.[1]);
  const assertions = pgTap.match(
    /^select\s+(?:has_function|unlike|like|is|isnt|ok|throws_ok)\s*\(/gim,
  ) ?? [];
  assert.equal(plan, 36);
  assert.equal(assertions.length, plan);
  assert.match(pgTap, /leaked A plus C child as a separate exact-parent scope/);
});
