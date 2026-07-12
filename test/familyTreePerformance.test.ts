import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import type { FamilyGraphData, ParentChildRelation, TreePerson } from "../src/features/family-tree-view/types.ts";

function wideGraph(personCount: number): FamilyGraphData {
  const persons: TreePerson[] = Array.from({ length: personCount }, (_, index) => ({
    id: `p${index}`,
    displayName: `Особа ${index}`,
    birth: { sort: String(1800 + (index % 220)) },
  }));
  const parentChildRelations: ParentChildRelation[] = [];
  for (let index = 1; index < personCount; index += 1) {
    parentChildRelations.push({
      id: `r${index}`,
      parentId: `p${Math.max(0, Math.floor((index - 1) / 3))}`,
      childId: `p${index}`,
      kind: "biological",
    });
  }
  return { persons, unions: [], parentChildRelations };
}

function measureLayout(graph: FamilyGraphData, iterations: number): { p95: number; maxNodes: number } {
  const samples: number[] = [];
  let maxNodes = 0;
  for (let index = 0; index < iterations + 5; index += 1) {
    const startedAt = performance.now();
    const result = layoutFamilyGraph({
      graph,
      options: {
        focusPersonId: "p0",
        ancestorDepth: 7,
        descendantDepth: 7,
        collateralDepth: 1,
        maxVisibleNodes: 400,
      },
    });
    const duration = performance.now() - startedAt;
    maxNodes = Math.max(
      maxNodes,
      result.nodes.filter((node) => node.kind === "person" || node.kind === "reference").length,
    );
    if (index >= 5) samples.push(duration);
  }
  samples.sort((left, right) => left - right);
  return {
    p95: samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0,
    maxNodes,
  };
}

test("10k canonical records stay within the 400-occurrence and 120ms p95 layout budgets", () => {
  const result = measureLayout(wideGraph(10_000), 20);
  assert.ok(result.maxNodes <= 400, `mounted/layout occurrence budget exceeded: ${result.maxNodes}`);
  assert.ok(result.p95 <= 120, `layout p95 ${result.p95.toFixed(2)}ms exceeded 120ms`);
});

test("100k canonical records still produce at most 400 visible occurrences", () => {
  const graph = wideGraph(100_000);
  const result = layoutFamilyGraph({
    graph,
    options: {
      focusPersonId: "p0",
      ancestorDepth: 7,
      descendantDepth: 7,
      collateralDepth: 1,
      maxVisibleNodes: 400,
    },
  });
  assert.ok(result.nodes.filter((node) => node.kind === "person" || node.kind === "reference").length <= 400);
});

test("expanding by 100 canonical people stays within the 120ms p95 relayout budget", () => {
  const initial = layoutFamilyGraph({
    graph: wideGraph(300),
    options: {
      focusPersonId: "p0",
      ancestorDepth: 7,
      descendantDepth: 7,
      collateralDepth: 1,
      maxVisibleNodes: 400,
    },
  });
  const previousPositions = initial.nodes.map((node) => ({
    occurrenceId: node.occurrenceId,
    x: node.x,
    y: node.y,
  }));
  const expanded = wideGraph(400);
  const samples: number[] = [];
  for (let index = 0; index < 25; index += 1) {
    const startedAt = performance.now();
    const result = layoutFamilyGraph({
      graph: expanded,
      options: {
        focusPersonId: "p0",
        ancestorDepth: 7,
        descendantDepth: 7,
        collateralDepth: 1,
        maxVisibleNodes: 400,
        previousPositions,
      },
    });
    const duration = performance.now() - startedAt;
    assert.ok(result.nodes.filter((node) => node.kind === "person" || node.kind === "reference").length <= 400);
    if (index >= 5) samples.push(duration);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.max(0, Math.ceil(samples.length * 0.95) - 1)] ?? 0;
  assert.ok(p95 <= 120, `expand relayout p95 ${p95.toFixed(2)}ms exceeded 120ms`);
});
