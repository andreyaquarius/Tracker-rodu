import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608120003_fix_person_pedigree_rpc_column_conflicts.sql",
    import.meta.url,
  ),
  "utf8",
);

test("pedigree RPC hotfix patches both catalogue functions", () => {
  assert.match(migration, /list_family_tree_direct_ancestor_order_v1\(uuid,uuid\)/i);
  assert.match(migration, /list_family_tree_root_kinship_v1\(uuid,uuid\)/i);
  assert.match(migration, /#variable_conflict use_column/i);
  assert.match(migration, /pg_get_functiondef/i);
});

test("pedigree RPC hotfix is idempotent and reloads PostgREST", () => {
  assert.match(migration, /position\('#variable_conflict use_column' in function_definition\) = 0/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});
