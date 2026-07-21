import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PersonRelation } from "../src/types/index.ts";
import { reconcileProjectPersonRelationsForPair } from "../src/utils/personRelationReconciliation.ts";

function relation(
  id: string,
  personId: string,
  relatedPersonId: string,
): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    relationType: "інше" as PersonRelation["relationType"],
    status: "доведено" as PersonRelation["status"],
    evidenceText: "",
    notes: "",
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

test("authoritative pair reconciliation removes stale relations even without deleted legacy ids", () => {
  const unrelated = relation("unrelated", "left", "third");
  const staleForward = relation("stale-forward", "left", "right");
  const staleReverse = relation("stale-reverse", "right", "left");

  const next = reconcileProjectPersonRelationsForPair(
    [unrelated, staleForward, staleReverse],
    [],
    "left",
    "right",
    [],
  );

  assert.deepEqual(next, [unrelated]);
});

test("authoritative pair reconciliation replaces the pair and preserves unrelated records", () => {
  const unrelated = relation("unrelated", "left", "third");
  const stale = relation("stale", "left", "right");
  const surviving = relation("surviving", "right", "left");
  const wrongPair = relation("wrong-pair", "left", "fourth");

  const next = reconcileProjectPersonRelationsForPair(
    [unrelated, stale],
    [surviving, wrongPair, surviving],
    "left",
    "right",
    ["stale"],
  );

  assert.deepEqual(next, [unrelated, surviving]);
});

test("detach frontend contract requires the complete RPC result and an authoritative pair refresh", () => {
  const mutationService = readFileSync(
    new URL("../src/services/familyTreeMutationService.ts", import.meta.url),
    "utf8",
  );
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const productionPage = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );
  const attachDialog = readFileSync(
    new URL("../src/components/familyTree/FamilyTreeAttachPersonDialog.tsx", import.meta.url),
    "utf8",
  );

  for (const field of [
    "deletedRelationshipIds",
    "leftPersonId",
    "rightPersonId",
    "remainingLogicalEdges",
  ]) {
    assert.match(mutationService, new RegExp(`record\\.${field}`));
  }
  assert.match(
    mutationService,
    /deletedRelationshipIds\.includes\(input\.relationshipId\)/,
  );
  assert.match(
    mutationService,
    /uniqueDeletedRelationshipIds\.size !== deletedRelationshipIds\.length/,
  );
  assert.match(mutationService, /remainingLogicalEdges !== 0/);
  assert.match(
    productionPage,
    /await onPersonRelationsDetached\?\.\(result\)/,
  );
  assert.doesNotMatch(
    productionPage,
    /onPersonRelationsDetached\?\.\(result\.deletedLegacyRelationIds\)/,
  );
  assert.match(app, /listProjectPersonRelationsBetween\(/);
  assert.match(app, /reconcileProjectPersonRelationsForPair\(/);
  assert.match(attachDialog, /submitInFlightRef\.current/);
  assert.match(attachDialog, /if \(submitInFlightRef\.current \|\| isSaving\) return/);
});

test("attaching an existing parent or child is idempotent after a partial retry", () => {
  const mutationService = readFileSync(
    new URL("../src/services/familyTreeMutationService.ts", import.meta.url),
    "utf8",
  );
  const existingParent = mutationService.slice(
    mutationService.indexOf("export async function attachExistingParentToPerson"),
    mutationService.indexOf("export async function attachExistingPartnerToPerson"),
  );
  const existingChild = mutationService.slice(
    mutationService.indexOf("export async function attachExistingChildToPerson"),
    mutationService.indexOf("export async function createParentSet"),
  );

  assert.match(existingParent, /duplicateMode:\s*"ignore"/);
  assert.equal(existingChild.match(/duplicateMode:\s*"ignore"/g)?.length, 2);
});
