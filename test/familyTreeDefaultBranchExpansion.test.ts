import assert from "node:assert/strict";
import test from "node:test";
import { nextDefaultBranchExpansion } from "../src/features/family-tree-view/state/defaultBranchExpansion.ts";
import type {
  FamilyContinuation,
  FamilyGraphData,
  ParentChildRelation,
  TreeContinuation,
} from "../src/features/family-tree-view/types.ts";

function continuation(
  id: string,
  personId: string,
  direction: TreeContinuation["direction"],
): TreeContinuation {
  return { id, personId, direction, token: `cursor:${id}` };
}

function family(id: string, parentIds: readonly string[]): FamilyContinuation {
  return {
    id: `continuation:${id}`,
    scope: { id, parentIds },
    token: `family-cursor:${id}`,
  };
}

function relation(parentId: string, childId: string): ParentChildRelation {
  return {
    id: `${parentId}:${childId}`,
    parentId,
    childId,
    kind: "biological",
  };
}

function graph(input: {
  relations?: readonly ParentChildRelation[];
  continuations?: readonly TreeContinuation[];
  familyContinuations?: readonly FamilyContinuation[];
}): FamilyGraphData {
  return {
    persons: [],
    unions: [],
    parentChildRelations: input.relations ?? [],
    continuations: input.continuations ?? [],
    familyContinuations: input.familyContinuations ?? [],
  };
}

test("default expansion opens only the focus partners and direct-child families", () => {
  const current = graph({
    continuations: [
      continuation("focus-partners", "focus", "partners"),
      continuation("father-siblings", "father", "siblings"),
    ],
    familyContinuations: [
      family("focus-family-a", ["focus", "focus-partner-a"]),
      family("focus-family-b", ["focus", "focus-partner-b"]),
      family("father-family", ["father", "mother"]),
    ],
  });
  const attemptedPeople = new Set<string>();
  const attemptedFamilies = new Set<string>();

  const partners = nextDefaultBranchExpansion({
    graph: current,
    focusPersonId: "focus",
    includeCousinDescendants: false,
    attemptedPersonContinuationIds: attemptedPeople,
    attemptedFamilyScopeIds: attemptedFamilies,
  });
  assert.equal(partners?.kind, "person");
  assert.equal(partners?.reason, "focus-partners");
  if (partners?.kind === "person") {
    attemptedPeople.add(partners.continuation.id);
  }

  const children = nextDefaultBranchExpansion({
    graph: current,
    focusPersonId: "focus",
    includeCousinDescendants: false,
    attemptedPersonContinuationIds: attemptedPeople,
    attemptedFamilyScopeIds: attemptedFamilies,
  });
  assert.equal(children?.kind, "family");
  assert.equal(children?.reason, "focus-family");
  if (children?.kind === "family") {
    attemptedFamilies.add(children.continuation.scope.id);
  }

  const secondFamily = nextDefaultBranchExpansion({
    graph: current,
    focusPersonId: "focus",
    includeCousinDescendants: false,
    attemptedPersonContinuationIds: attemptedPeople,
    attemptedFamilyScopeIds: attemptedFamilies,
  });
  assert.equal(secondFamily?.kind, "family");
  assert.equal(secondFamily?.reason, "focus-family");
  if (secondFamily?.kind === "family") {
    attemptedFamilies.add(secondFamily.continuation.scope.id);
  }
  assert.deepEqual(
    [...attemptedFamilies].sort(),
    ["focus-family-a", "focus-family-b"],
  );

  assert.equal(nextDefaultBranchExpansion({
    graph: current,
    focusPersonId: "focus",
    includeCousinDescendants: false,
    attemptedPersonContinuationIds: attemptedPeople,
    attemptedFamilyScopeIds: attemptedFamilies,
  }), undefined);
});

test("cousin defaults use only parent and grandparent sibling origins, then continue downward", () => {
  const current = graph({
    relations: [
      relation("father", "focus"),
      relation("mother", "focus"),
      relation("paternal-grandfather", "father"),
      relation("paternal-grandmother", "father"),
      relation("paternal-grandfather", "uncle"),
      relation("paternal-grandmother", "uncle"),
      relation("great-grandfather", "paternal-grandfather"),
      relation("great-grandmother", "paternal-grandfather"),
      relation("great-grandfather", "great-uncle"),
      relation("great-grandmother", "great-uncle"),
      relation("uncle", "focus-cousin"),
      relation("focus-cousin", "focus-cousin-child"),
      relation("focus-cousin-child", "focus-cousin-grandchild"),
      relation("great-uncle", "father-cousin"),
      relation("father-cousin", "father-cousin-child"),
    ],
    continuations: [
      continuation("father-siblings", "father", "siblings"),
      continuation("grandfather-siblings", "paternal-grandfather", "siblings"),
      continuation("too-deep-siblings", "great-grandfather", "siblings"),
    ],
    familyContinuations: [
      family("uncle-family", ["uncle", "uncle-partner"]),
      family("great-uncle-family", ["great-uncle", "great-uncle-partner"]),
      family("focus-cousin-family", ["focus-cousin", "cousin-partner"]),
      family("focus-cousin-child-family", ["focus-cousin-child"]),
      family("father-cousin-family", ["father-cousin"]),
      family("direct-ancestor-family", ["father", "mother"]),
      family("unrelated-family", ["unrelated"]),
    ],
  });
  const attemptedPeople = new Set([
    "father-siblings",
    "grandfather-siblings",
  ]);
  const attemptedFamilies = new Set<string>();

  const next = nextDefaultBranchExpansion({
    graph: current,
    focusPersonId: "focus",
    includeCousinDescendants: true,
    attemptedPersonContinuationIds: attemptedPeople,
    attemptedFamilyScopeIds: attemptedFamilies,
  });
  assert.equal(next?.kind, "family");
  assert.equal(next?.reason, "cousin-descendants");
  assert.ok(
    next?.kind === "family" &&
      [
        "uncle-family",
        "great-uncle-family",
        "focus-cousin-family",
        "focus-cousin-child-family",
        "father-cousin-family",
      ].includes(next.continuation.scope.id),
  );

  for (const allowedScopeId of [
    "uncle-family",
    "great-uncle-family",
    "focus-cousin-family",
    "focus-cousin-child-family",
    "father-cousin-family",
  ]) {
    attemptedFamilies.add(allowedScopeId);
  }
  const remaining = nextDefaultBranchExpansion({
    graph: current,
    focusPersonId: "focus",
    includeCousinDescendants: true,
    attemptedPersonContinuationIds: attemptedPeople,
    attemptedFamilyScopeIds: attemptedFamilies,
  });
  assert.equal(remaining, undefined);
  assert.equal(attemptedPeople.has("too-deep-siblings"), false);
});
