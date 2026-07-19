import assert from "node:assert/strict";
import test from "node:test";
import { pedigreeRanksFromOccurrences } from "../src/utils/personPedigreeOrder.ts";

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
