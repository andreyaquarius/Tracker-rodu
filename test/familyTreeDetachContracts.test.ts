import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/familyTreeMutationService.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607210004_logical_family_tree_relationship_detach.sql",
    import.meta.url,
  ),
  "utf8",
);
const pgTap = readFileSync(
  new URL(
    "../supabase/tests/family_tree_relationship_detach_test.sql",
    import.meta.url,
  ),
  "utf8",
);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source boundary: ${start}`);
  assert.ok(endIndex > startIndex, `missing source boundary: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("relationship inventory uses four exact project-and-tree queries", () => {
  const inventory = section(
    service,
    "export async function listDetachableFamilyTreeRelationships",
    "export async function deleteRelationship",
  );

  assert.equal(
    inventory.match(/\.from\("parent_child_relationships"\)/g)?.length,
    2,
  );
  assert.equal(
    inventory.match(/\.from\("partner_relationships"\)/g)?.length,
    2,
  );
  assert.equal(inventory.match(/\.eq\("project_id", input\.projectId\)/g)?.length, 4);
  assert.equal(inventory.match(/\.eq\("tree_id", input\.treeId\)/g)?.length, 4);
  assert.equal(inventory.match(/\.eq\("child_id", input\.personId\)/g)?.length, 1);
  assert.equal(inventory.match(/\.eq\("parent_id", input\.personId\)/g)?.length, 1);
  assert.equal(inventory.match(/\.eq\("person_a_id", input\.personId\)/g)?.length, 1);
  assert.equal(inventory.match(/\.eq\("person_b_id", input\.personId\)/g)?.length, 1);
  assert.doesNotMatch(inventory, /\.or\s*\(/);
});

test("detach RPC sends the exact target and accepts only a strict confirmation", () => {
  const detach = section(
    service,
    "export async function deleteRelationship",
    "async function createCanonicalPerson",
  );

  assert.match(detach, /\.rpc\(\s*"detach_family_tree_relationship"/);
  assert.match(detach, /target_project_id:\s*input\.projectId/);
  assert.match(detach, /target_tree_id:\s*input\.treeId/);
  assert.match(detach, /target_kind:\s*input\.kind/);
  assert.match(detach, /target_relationship_id:\s*input\.relationshipId/);
  assert.deepEqual(
    [...detach.matchAll(/\b(target_[a-z_]+):/g)].map((match) => match[1]),
    [
      "target_project_id",
      "target_tree_id",
      "target_kind",
      "target_relationship_id",
    ],
  );

  assert.match(detach, /record\.deleted !== true/);
  assert.match(detach, /record\.kind !== input\.kind/);
  assert.match(detach, /record\.relationshipId !== input\.relationshipId/);
  assert.match(detach, /record\.treeId !== input\.treeId/);
  assert.match(detach, /deletedMappings === null/);
  assert.match(detach, /deletedLegacyRelations === null/);
  assert.match(detach, /!Array\.isArray\(record\.deletedLegacyRelationIds\)/);
  assert.match(
    detach,
    /deletedLegacyRelationIds\.length !== record\.deletedLegacyRelationIds\.length/,
  );
  assert.match(
    detach,
    /typeof value === "number" && Number\.isInteger\(value\) && value >= 0/,
  );
});

test("detach migration deletes mappings, logical duplicates, then only orphan legacy rows", () => {
  const mappingDelete = migration.indexOf(
    "delete from public.legacy_person_relation_graph_edges mapping",
  );
  const parentDelete = migration.indexOf(
    "delete from public.parent_child_relationships relationship",
    mappingDelete,
  );
  const partnerDelete = migration.indexOf(
    "delete from public.partner_relationships relationship",
    mappingDelete,
  );
  const associationDelete = migration.indexOf(
    "delete from public.association_relationships relationship",
    mappingDelete,
  );
  const legacyDelete = migration.indexOf(
    "delete from public.person_relations relation",
    mappingDelete,
  );

  for (const index of [mappingDelete, parentDelete, partnerDelete, associationDelete, legacyDelete]) {
    assert.ok(index >= 0);
  }
  assert.ok(mappingDelete < parentDelete);
  assert.ok(mappingDelete < partnerDelete);
  assert.ok(mappingDelete < associationDelete);
  assert.ok(parentDelete < legacyDelete);
  assert.ok(partnerDelete < legacyDelete);
  assert.ok(associationDelete < legacyDelete);
  assert.match(
    migration.slice(legacyDelete),
    /relation\.id = any\(candidate_relation_ids\)[\s\S]*?and not exists\s*\([\s\S]*?from public\.legacy_person_relation_graph_edges remaining[\s\S]*?remaining\.relation_id = relation\.id/,
  );
  assert.doesNotMatch(migration, /delete from public\.persons\b/i);
  assert.doesNotMatch(migration, /delete from public\.family_tree_persons\b/i);
  assert.doesNotMatch(migration, /delete from public\.parent_sets\b/i);
  assert.doesNotMatch(migration, /delete from public\.family_groups\b/i);
});

test("detach migration enforces project/tree scope and exposes an authenticated invoker wrapper", () => {
  const privateFunction = section(
    migration,
    "create or replace function security_private.detach_family_tree_relationship",
    "create or replace function public.detach_family_tree_relationship",
  );
  const wrapper = migration.slice(
    migration.indexOf("create or replace function public.detach_family_tree_relationship"),
  );

  assert.match(privateFunction, /security definer/i);
  assert.match(privateFunction, /if not security_private\.can_edit_project\(target_project_id\)/i);
  assert.match(privateFunction, /relationship\.project_id = target_project_id/g);
  assert.match(privateFunction, /relationship\.tree_id = target_tree_id/g);
  assert.match(privateFunction, /mapping\.project_id = target_project_id/g);
  assert.match(privateFunction, /mapping\.tree_id = target_tree_id/g);
  assert.match(privateFunction, /FAMILY_TREE_RELATIONSHIP_NOT_FOUND/);
  assert.match(privateFunction, /FAMILY_TREE_RELATIONSHIP_CHANGED/);
  assert.match(privateFunction, /FAMILY_TREE_RELATIONSHIP_DELETE_RACE/);

  assert.match(wrapper, /language sql[\s\S]*?security invoker/i);
  assert.match(
    wrapper,
    /select security_private\.detach_family_tree_relationship\(\$1, \$2, \$3, \$4\)/,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.detach_family_tree_relationship\(uuid, uuid, text, uuid\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant execute on function security_private\.detach_family_tree_relationship\(uuid, uuid, text, uuid\)[\s\S]*?to authenticated, service_role/,
  );
  assert.match(
    migration,
    /revoke all on function public\.detach_family_tree_relationship\(uuid, uuid, text, uuid\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant execute on function public\.detach_family_tree_relationship\(uuid, uuid, text, uuid\)[\s\S]*?to authenticated, service_role/,
  );
});

test("logical detach exposes the pair reconciliation contract and narrow GEDCOM repair", () => {
  assert.match(migration, /'deletedRelationshipIds',\s*pg_catalog\.to_jsonb\(deleted_relationship_ids\)/);
  assert.match(migration, /'leftPersonId',\s*left_person_id/);
  assert.match(migration, /'rightPersonId',\s*right_person_id/);
  assert.match(migration, /'remainingLogicalEdges',\s*remaining_logical_edges/);
  assert.match(migration, /target_relationship_id\s*=\s*any\(deleted_relationship_ids\)/);
  assert.match(migration, /remaining_logical_edges\s*<>\s*0/);
  assert.match(
    migration,
    /backfill_gedcom_relation_graph_mappings[\s\S]*?settings\s*->>\s*'import_source_key'[\s\S]*?relation\.import_source_key[\s\S]*?gedcom_metadata\s*->>\s*'familyXref'/,
  );
  assert.match(
    migration,
    /relationship\.parent_id\s*=\s*left_person_id[\s\S]*?relationship\.child_id\s*=\s*right_person_id[\s\S]*?relationship\.relationship_type\s*=\s*logical_relationship_type/,
  );
});

test("logical-detach pgTAP fixture keeps its declared plan and rollback boundary", () => {
  const plan = Number(pgTap.match(/select\s+plan\((\d+)\)/i)?.[1]);
  const assertions = pgTap.match(
    /^select\s+(?:has_function|is|isnt|ok|throws_ok|lives_ok)\s*\(/gim,
  ) ?? [];

  assert.equal(plan, 32);
  assert.equal(assertions.length, plan);
  assert.match(pgTap, /^begin;/i);
  assert.match(pgTap, /select \* from finish\(\);\s*rollback;\s*$/i);
  assert.match(pgTap, /an edge id from another tree cannot be detached/);
  assert.match(pgTap, /an edge id from another project cannot be detached/);
  assert.match(pgTap, /a different exact edge for the same pair survives/);
  assert.match(pgTap, /logical detach removes every same-pair same-type canonical duplicate/);
  assert.match(pgTap, /the GEDCOM fixture starts without a compatibility mapping/);
  assert.match(pgTap, /a legacy assertion mapped to another tree survives logical detach/);
  assert.match(pgTap, /the same logical relationship can be attached again after detach/);
  assert.match(pgTap, /detaching a relationship never deletes either person/);
  assert.match(pgTap, /detaching a relationship preserves both tree memberships/);
});
