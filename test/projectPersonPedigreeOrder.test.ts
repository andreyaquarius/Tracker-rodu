import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeCanonicalAncestorKinship,
  mergeCanonicalFamilyOrder,
  pedigreeRanksFromOccurrences,
  type PedigreeKinshipRank,
} from "../src/utils/personPedigreeOrder.ts";

test("catalogue pedigree order follows Ahnentafel slots and deduplicates collapsed ancestors", () => {
  const result = pedigreeRanksFromOccurrences("root", [
    { personId: "maternal-grandmother", slot: 7 },
    { personId: "root", slot: 1 },
    { personId: "father", slot: 2 },
    { personId: "mother", slot: 3 },
    { personId: "shared-grandfather", slot: 6 },
    { personId: "paternal-grandmother", slot: 5 },
    { personId: "shared-grandfather", slot: 4 },
  ]);

  assert.deepEqual([...result.familyOrder], [
    ["root", 0],
    ["father", 1],
    ["mother", 2],
    ["shared-grandfather", 3],
    ["paternal-grandmother", 4],
    ["maternal-grandmother", 5],
  ]);
  assert.deepEqual([...result.directAncestorIds], [
    "father",
    "mother",
    "shared-grandfather",
    "paternal-grandmother",
    "maternal-grandmother",
  ]);
});

test("an empty or inaccessible pedigree produces an empty deterministic order", () => {
  const result = pedigreeRanksFromOccurrences("missing", []);
  assert.deepEqual([...result.familyOrder], []);
  assert.deepEqual([...result.directAncestorIds], []);
});

test("canonical ancestors override a smaller broad-kinship traversal", () => {
  const broad = new Map<string, PedigreeKinshipRank>([
    ["root", kinship("root", 0, "")],
    ["father", kinship("ancestor", 1, "/0")],
    ["shared", kinship("collateral", 2, "/0>sibling")],
    ["child", kinship("descendant", 0, ">child", 1)],
  ]);
  const canonical = new Map<string, PedigreeKinshipRank>([
    ["root", kinship("root", 0, "")],
    ["father", kinship("ancestor", 1, "/0")],
    ["mother", kinship("ancestor", 1, "/1")],
    ["shared", kinship("ancestor", 3, "/0/1/0")],
  ]);

  const merged = mergeCanonicalAncestorKinship(broad, canonical);

  assert.equal(merged.get("shared")?.kind, "ancestor");
  assert.equal(merged.get("shared")?.upSteps, 3);
  assert.equal(merged.get("mother")?.kind, "ancestor");
  assert.equal(merged.get("child")?.kind, "descendant");
});

test("canonical Ahnentafel order remains first while broader relatives are appended", () => {
  const merged = mergeCanonicalFamilyOrder(
    new Map([
      ["root", 0],
      ["father", 1],
      ["mother", 2],
      ["shared", 3],
    ]),
    new Map([
      ["root", 0],
      ["father", 1],
      ["child", 2],
      ["shared", 3],
      ["partner", 4],
    ]),
  );

  assert.deepEqual([...merged.keys()], [
    "root",
    "father",
    "mother",
    "shared",
    "child",
    "partner",
  ]);
});

function kinship(
  kind: PedigreeKinshipRank["kind"],
  upSteps: number,
  orderPath: string,
  downSteps = 0,
): PedigreeKinshipRank {
  return { kind, upSteps, downSteps, partnerSteps: 0, orderPath };
}
