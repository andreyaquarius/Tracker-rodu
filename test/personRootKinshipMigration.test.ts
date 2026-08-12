import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608120002_family_tree_root_kinship.sql",
    import.meta.url,
  ),
  "utf8",
);

test("root kinship RPC is tied to the persisted root and project membership", () => {
  assert.match(migration, /#variable_conflict use_column/i);
  assert.match(migration, /select tree\.project_id, tree\.root_person_id/i);
  assert.match(migration, /persisted_root_person_id <> target_root_person_id/i);
  assert.match(migration, /public\.is_project_member\(current_project_id\)/i);
  assert.match(migration, /member\.member_role <> 'hidden'/i);
  assert.match(migration, /public\.assert_family_tree_feature_access\(\)/i);
});

test("kinship closure is not coupled to the former 599-person rendering limit", () => {
  assert.doesNotMatch(migration, /maxNodes|\b599\b|\b600\b/i);
  assert.match(migration, /_root_kinship_sources/i);
  assert.match(migration, /_root_kinship_down_frontier/i);
  assert.match(migration, /partner_steps integer/i);
  assert.match(migration, /'ancestor'[\s\S]*?'descendant'[\s\S]*?'collateral'/i);
  assert.match(migration, /'affinal'::text/i);
});

test("pedigree collapse keeps direct ancestors authoritative", () => {
  assert.match(migration, /_root_kinship_best\.down_steps <> 0/i);
  assert.match(migration, /A pedigree-collapse ancestor[\s\S]*?direct-line status must remain authoritative/i);
});

test("parent and partner edges follow privacy and evidence filters", () => {
  assert.match(migration, /from public\.parent_sets parent_set/i);
  assert.match(migration, /relation\.evidence_status <> 'disproven'/i);
  assert.match(migration, /relation\.privacy_status <> 'confidential'[\s\S]*?public\.can_edit_project/i);
  assert.match(migration, /from public\.partner_relationships partner/i);
  assert.match(migration, /partner\.evidence_status <> 'disproven'/i);
});
