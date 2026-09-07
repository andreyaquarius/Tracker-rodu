import assert from "node:assert/strict";
import test from "node:test";
import { layoutDirectAncestors } from "../src/features/family-tree-view/layout/directAncestorLayout.ts";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { layoutDirectPedigree } from "../src/features/family-tree-view/layout/layoutDirectPedigree.ts";
import { multipleParentSetsPedigree } from "./fixtures/family-tree/multipleParentSets.ts";
import type { LayoutResult } from "../src/features/family-tree-view/types.ts";

test("three or more parents do not disable the recursive ancestor grid", () => {
  const result = layoutDirectAncestors([
    { occurrenceId: "root", width: 100, path: [] },
    { occurrenceId: "father", width: 100, path: [0], parentSetOrder: 0 },
    { occurrenceId: "mother", width: 100, path: [6_000_001], parentSetOrder: 0 },
    { occurrenceId: "adoptive-father", width: 100, path: [1_000], parentSetOrder: 1 },
    { occurrenceId: "adoptive-mother", width: 100, path: [6_001_001], parentSetOrder: 1 },
  ], { sectorGap: 12 });
  assert.ok(result, "a third parent must not send the entire pedigree to generic packing");
  const centers = result.centerByOccurrenceId;
  assert.equal(centers.size, 5);
  assert.equal((centers.get("father")! + centers.get("mother")!) / 2, centers.get("root"));
  assert.ok(centers.get("mother")! + 100 < centers.get("adoptive-father")!, "keep each pair together, not all fathers then all mothers");
});

test("two parents in separate source sets keep the established midpoint layout", () => {
  const items = [
    { occurrenceId: "root", width: 100, path: [] },
    { occurrenceId: "father", width: 100, path: [0], parentSetOrder: 1 },
    { occurrenceId: "mother", width: 100, path: [6_000_001], parentSetOrder: 0 },
  ];
  const baseline = layoutDirectAncestors(items.map(({ parentSetOrder: _order, ...item }) => item), { sectorGap: 12 });
  assert.deepEqual(layoutDirectAncestors(items, { sectorGap: 12 }), baseline);
});

for (const [mode, calculate] of [["classic", layoutFamilyGraph], ["direct", layoutDirectPedigree]] as const) {
  test(`${mode}: all parent sets preserve disjoint seven-generation sectors through repeated toggles`, () => {
    const { graph, parentsByChild } = multipleParentSetsPedigree();
    const snapshot = structuredClone(graph);
    const axis = (node: LayoutResult["nodes"][number]) => mode === "classic"
      ? { start: node.x, end: node.x + node.width, center: node.x + node.width / 2 }
      : { start: node.y, end: node.y + node.height, center: node.y + node.height / 2 };
    let previous: LayoutResult | undefined;
    const baselines = new Map<boolean, unknown>();
    for (const showAllParentSets of [false, true, false, true]) {
      const result = calculate({ graph, options: {
        focusPersonId: "root", ancestorDepth: 7, descendantDepth: 0, collateralDepth: 0,
        maxVisibleNodes: 600, showAllParentSets,
        activeParentSetByChild: { root: "parents:root:0" },
        previousPositions: previous?.nodes.map(({ occurrenceId, x, y }) => ({ occurrenceId, x, y })),
      } });
      const nodes = result.nodes.filter(node => node.personId);
      const byId = new Map(nodes.map(node => [node.personId!, node]));
      assert.equal(nodes.length, showAllParentSets ? graph.persons.length : 255);
      for (const [childId, allParents] of parentsByChild) {
        if (!byId.has(childId)) continue;
        const parents = allParents.filter(id => byId.has(id));
        const childCenter = axis(byId.get(childId)!).center;
        assert.ok(Math.abs(childCenter - (axis(byId.get(parents[0]!)!).center + axis(byId.get(parents[1]!)!).center) / 2) < 0.001,
          `${showAllParentSets}: ${childId} must remain below its primary parent midpoint`);
        for (let index = 1; index < parents.length; index++) {
          const branch = (id: string) => nodes.filter(node => node.personId === id || node.personId!.startsWith(`${id}/`));
          const leftEnd = Math.max(...branch(parents[index - 1]!).map(node => axis(node).end));
          const rightStart = Math.min(...branch(parents[index]!).map(node => axis(node).start));
          assert.ok(rightStart - leftEnd >= (mode === "classic" ? 11.99 : 1.99),
            `${showAllParentSets}: sectors ${parents[index - 1]} and ${parents[index]} overlap by ${leftEnd - rightStart}`);
        }
      }
      for (const left of nodes) for (const right of nodes) {
        if (left.occurrenceId >= right.occurrenceId) continue;
        assert.ok(!(left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height),
          `cards overlap: ${left.personId} / ${right.personId}`);
      }
      const positions = nodes.map(({ personId, x, y }) => ({ personId, x, y }));
      if (baselines.has(showAllParentSets)) assert.deepEqual(positions, baselines.get(showAllParentSets), "saved positions must not rearrange the sectors");
      baselines.set(showAllParentSets, positions);
      previous = result;
    }
    const reordered = calculate({ graph: {
      persons: [...graph.persons].reverse(), unions: [...graph.unions].reverse(), parentChildRelations: [...graph.parentChildRelations].reverse(),
    }, options: {
      focusPersonId: "root", ancestorDepth: 7, descendantDepth: 0, collateralDepth: 0, maxVisibleNodes: 600, showAllParentSets: true,
      previousPositions: previous!.nodes.map(({ occurrenceId, x, y }) => ({ occurrenceId, x: -x, y: -y })),
    } });
    assert.deepEqual(reordered.nodes.filter(node => node.personId).map(({ personId, x, y }) => ({ personId, x, y })), baselines.get(true));
    assert.deepEqual(graph, snapshot);
  });
}

test("duplicate semantic sets do not duplicate cards, change colors or reposition the same ancestry", () => {
  const fixture = multipleParentSetsPedigree().graph;
  const persons = fixture.persons.filter(person => !person.id.split("/").some(segment => segment.startsWith("1")));
  const ids = new Set(persons.map(person => person.id));
  const unions = fixture.unions.filter(union => union.memberIds.every(id => ids.has(id)));
  const relations = fixture.parentChildRelations.filter(relation => ids.has(relation.parentId) && ids.has(relation.childId));
  const graph = {
    persons,
    unions: [...unions, ...unions.map(union => ({ ...union, id: `legal:${union.id}` }))],
    parentChildRelations: [...relations, ...relations.map(relation => ({ ...relation, id: `legal:${relation.id}`, unionId: `legal:${relation.unionId}`, kind: "adoptive" as const }))],
  };
  for (const calculate of [layoutFamilyGraph, layoutDirectPedigree]) {
    const run = (showAllParentSets: boolean) => calculate({ graph, options: {
      focusPersonId: "root", ancestorDepth: 7, descendantDepth: 0, collateralDepth: 0, maxVisibleNodes: 600, lineageGroupDepth: 2, showAllParentSets,
    } }).nodes.filter(node => node.personId).map(({ personId, x, y, lineageGroup, lineageRole }) => ({ personId, x, y, lineageGroup, lineageRole }));
    assert.deepEqual(run(true), run(false));
  }
});

test("sets sharing one parent keep that parent's single card and all three ancestor branches", () => {
  const fixture = multipleParentSetsPedigree().graph;
  const sharedFather = "root/00";
  const keep = (id: string) => !id.startsWith("root/10") && id.split("/").length <= 4;
  const persons = fixture.persons.filter(person => keep(person.id));
  const relations = fixture.parentChildRelations
    .filter(relation => keep(relation.childId) && (keep(relation.parentId) || relation.parentId === "root/10"))
    .map(relation => relation.parentId === "root/10" ? { ...relation, parentId: sharedFather } : relation);
  const unionIds = new Set(relations.map(relation => relation.unionId));
  const unions = fixture.unions.filter(union => unionIds.has(union.id)).map(union => ({ ...union,
    memberIds: union.memberIds.map(id => id === "root/10" ? sharedFather : id).filter(keep),
  }));
  const result = layoutFamilyGraph({ graph: { persons, unions, parentChildRelations: relations }, options: {
    focusPersonId: "root", ancestorDepth: 7, descendantDepth: 0, collateralDepth: 0, showAllParentSets: true, maxVisibleNodes: 600,
  } });
  assert.equal(result.nodes.filter(node => node.personId === sharedFather).length, 1);
  const people = result.nodes.filter(node => node.personId);
  assert.equal(people.length, persons.length);
  for (const [left, right] of [["root/00", "root/01"], ["root/01", "root/11"]]) {
    const leftEnd = Math.max(...people.filter(node => node.personId === left || node.personId!.startsWith(`${left}/`)).map(node => node.x + node.width));
    const rightStart = Math.min(...people.filter(node => node.personId === right || node.personId!.startsWith(`${right}/`)).map(node => node.x));
    assert.ok(leftEnd < rightStart);
  }
  for (const relation of relations) assert.ok(result.edges.some(edge => edge.relationIds?.includes(relation.id)), `lost source relation ${relation.id}`);
});
