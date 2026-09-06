import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path,import.meta.url),"utf8");
test("saving a finding with no linked people still synchronizes former participants", () => {
  const app = source("../src/App.tsx");
  const block = app.slice(app.indexOf('syncEntityAttachmentMetadata("findings", saved)'),app.indexOf('const deleteFinding ='));
  assert.ok(block.includes('await syncFindingPersonFacts(projectId, saved.id)'));
  assert.ok(!block.includes('if (saved.participants.some('));
  assert.ok(block.includes('mergePersons(current)'));
});
test("hotfix keeps constraints and source/child data, rather than disabling uniqueness", () => {
  const sql = source("../supabase/migrations/202609060004_finding_fact_unlink_and_relink.sql");
  assert.match(sql,/on conflict \(tree_id, least\(primary_partner_1_id,primary_partner_2_id\), greatest/);
  assert.match(sql,/do nothing;\s*select fg.id into strict group_id/);
  assert.doesNotMatch(sql,/drop (index|constraint)|delete from public\.(family_groups|parent_sets|parent_child_relationships|persons|findings|finding_participants)\b/i);
  assert.match(sql,/affected := to_jsonb\(removed_ids\)/);
  assert.match(sql,/not public.can_edit_project\(p_project_id\)/);
  assert.match(sql,/revoke all on function security_private.remove_finding_owned_fields_v1/);
});
