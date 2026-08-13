import assert from "node:assert/strict";
import test from "node:test";
import { pedigreeRanksFromAncestorOrderRows } from "../src/utils/personPedigreeOrder.ts";

test("complete ancestor order is not truncated at the former 600-node boundary", () => {
  const rows = [
    { person_id: "root", generation: 0, order_path: "" },
    ...Array.from({ length: 908 }, (_, index) => ({
      person_id: `ancestor-${String(index + 1).padStart(4, "0")}`,
      generation: Math.floor(Math.log2(index + 2)),
      order_path: `/${String(index + 1).padStart(6, "0")}`,
    })),
  ];

  const result = pedigreeRanksFromAncestorOrderRows("root", rows);
  assert.equal(result.familyOrder.size, 909);
  assert.equal(result.directAncestorIds.size, 908);
  assert.equal(result.familyOrder.get("root"), 0);
  assert.ok(result.familyOrder.has("ancestor-0908"));
});

test("pedigree collapse keeps the nearest and earliest stable occurrence", () => {
  const result = pedigreeRanksFromAncestorOrderRows("root", [
    { person_id: "root", generation: 0, order_path: "" },
    { person_id: "shared", generation: 5, order_path: "/1/1/1/1/1" },
    { person_id: "shared", generation: 3, order_path: "/1/0/0" },
    { person_id: "mother", generation: 1, order_path: "/1" },
    { person_id: "father", generation: 1, order_path: "/0" },
  ]);

  assert.deepEqual([...result.familyOrder.keys()], [
    "root",
    "father",
    "mother",
    "shared",
  ]);
  assert.deepEqual([...result.directAncestorIds], ["father", "mother", "shared"]);
});

test("296 occupied pedigree positions with collapse produce 284 unique catalogue ancestors", () => {
  const uniqueAncestors = Array.from({ length: 284 }, (_, index) => ({
    person_id: `ancestor-${String(index + 1).padStart(3, "0")}`,
    generation: Math.min(16, Math.floor(Math.log2(index + 2))),
    order_path: `/primary/${String(index + 1).padStart(3, "0")}`,
  }));
  const repeatedPositions = uniqueAncestors.slice(0, 12).map((ancestor, index) => ({
    ...ancestor,
    generation: Math.min(16, ancestor.generation + 2),
    order_path: `/collapsed/${String(index + 1).padStart(3, "0")}`,
  }));

  assert.equal(uniqueAncestors.length + repeatedPositions.length, 296);
  const result = pedigreeRanksFromAncestorOrderRows("root", [
    { person_id: "root", generation: 0, order_path: "" },
    ...uniqueAncestors,
    ...repeatedPositions,
  ]);

  assert.equal(result.directAncestorIds.size, 284);
  assert.equal(result.familyOrder.size, 285);
});
