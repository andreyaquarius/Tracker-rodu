import test from "node:test";
import assert from "node:assert/strict";
import { positionFamilyContinuations } from "../src/features/family-tree-view/react/familyContinuationLayout.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  FamilyScope,
  LayoutNode,
  LayoutResult,
} from "../src/features/family-tree-view/types.ts";

function personNode(personId: string, x: number): LayoutNode {
  return {
    occurrenceId: `person:${personId}`,
    personId,
    kind: "person",
    generation: 0,
    x,
    y: 40,
    width: 100,
    height: 120,
    orderKey: personId,
  };
}

function familyScope(
  id: string,
  parentIds: readonly string[],
  familyGroupId: string,
  unionId: string,
): FamilyScope {
  return {
    id,
    parentIds,
    familyGroupId,
    unionIds: [unionId],
  };
}

function continuation(
  scope: FamilyScope,
  input: { expanded?: boolean; hiddenCount?: number } = {},
): FamilyContinuation {
  return {
    id: `continuation:${scope.id}`,
    scope,
    token: input.expanded
      ? `local:active:${scope.id}`
      : `server:${scope.id}`,
    ...(input.expanded
      ? { expanded: true }
      : { hiddenCount: input.hiddenCount ?? 1 }),
  };
}

function fixture(
  familyContinuations: readonly FamilyContinuation[],
  personIds: readonly string[] = ["father", "mother"],
): { graph: FamilyGraphData; layout: LayoutResult } {
  const nodes = personIds.map((personId, index) =>
    personNode(personId, 80 + index * 180),
  );
  return {
    graph: {
      persons: personIds.map(id => ({ id, displayName: id })),
      unions: [],
      parentChildRelations: [],
      familyContinuations,
    },
    layout: {
      nodes,
      unions: [],
      edges: [],
      bounds: { left: 80, top: 40, right: 800, bottom: 240 },
      generationBands: [],
      warnings: [],
    },
  };
}

function owners(
  controls: ReturnType<typeof positionFamilyContinuations>,
): string[] {
  return controls.map(control => control.ownerPersonId).sort();
}

function assertAtMostOneControlPerPerson(
  controls: ReturnType<typeof positionFamilyContinuations>,
): void {
  const ownerIds = controls.map(control => control.ownerPersonId);
  assert.equal(ownerIds.length, new Set(ownerIds).size);
}

test("equivalent family scopes render only one down control below each parent", () => {
  const canonical = familyScope(
    "family-group:shared",
    ["father", "mother"],
    "shared",
    "partnership:shared",
  );
  const duplicate = familyScope(
    "parent-set:legacy-child",
    ["mother", "father"],
    "shared",
    "parent-set:legacy-child",
  );
  const { graph, layout } = fixture([
    continuation(canonical, { hiddenCount: 1 }),
    continuation(duplicate, { hiddenCount: 1 }),
  ]);

  const controls = positionFamilyContinuations(graph, layout);

  assert.deepEqual(owners(controls), ["father", "mother"]);
  assertAtMostOneControlPerPerson(controls);
  assert.equal(new Set(controls.map(control => control.id)).size, 2);
});

test("opening an equivalent scope leaves one control only below the parent who opened it, and collapse restores one per parent", () => {
  const canonical = familyScope(
    "family-group:shared",
    ["father", "mother"],
    "shared",
    "partnership:shared",
  );
  const duplicate = familyScope(
    "parent-set:legacy-child",
    ["father", "mother"],
    "shared",
    "parent-set:legacy-child",
  );
  const expandedFixture = fixture([
    continuation(canonical, { expanded: true }),
    continuation(duplicate, { hiddenCount: 1 }),
  ]);
  const collapsedFixture = fixture([
    continuation(canonical, { hiddenCount: 1 }),
    continuation(duplicate, { hiddenCount: 1 }),
  ]);
  const ownerByScope = new Map([[canonical.id, "mother"]]);

  const expanded = positionFamilyContinuations(
    expandedFixture.graph,
    expandedFixture.layout,
    { activeOwnerByScope: ownerByScope },
  );
  const collapsed = positionFamilyContinuations(
    collapsedFixture.graph,
    collapsedFixture.layout,
    { activeOwnerByScope: ownerByScope },
  );

  assert.deepEqual(owners(expanded), ["mother"]);
  assert.equal(expanded[0]?.continuation.expanded, true);
  assertAtMostOneControlPerPerson(expanded);
  assert.deepEqual(owners(collapsed), ["father", "mother"]);
  assertAtMostOneControlPerPerson(collapsed);
});

test("the counterpart keeps one control for a genuinely different partner family", () => {
  const shared = familyScope(
    "family-group:shared",
    ["father", "mother"],
    "shared",
    "partnership:shared",
  );
  const sharedAlias = familyScope(
    "parent-set:shared-alias",
    ["mother", "father"],
    "shared",
    "parent-set:shared-alias",
  );
  const otherFamily = familyScope(
    "family-group:other",
    ["mother", "other-partner"],
    "other",
    "partnership:other",
  );
  const otherAlias = familyScope(
    "parent-set:other-alias",
    ["other-partner", "mother"],
    "other",
    "parent-set:other-alias",
  );
  const { graph, layout } = fixture(
    [
      continuation(shared, { expanded: true }),
      continuation(sharedAlias),
      continuation(otherFamily),
      continuation(otherAlias),
    ],
    ["father", "mother", "other-partner"],
  );

  const controls = positionFamilyContinuations(graph, layout, {
    activeOwnerByScope: new Map([[shared.id, "father"]]),
  });

  assert.deepEqual(owners(controls), ["father", "mother", "other-partner"]);
  assertAtMostOneControlPerPerson(controls);
  assert.equal(
    controls.find(control => control.ownerPersonId === "father")?.continuation
      .expanded,
    true,
  );
  assert.equal(
    controls.find(control => control.ownerPersonId === "mother")?.continuation
      .scope.familyGroupId,
    "other",
  );
});
