import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { layoutFamilyGraph } from "../src/features/family-tree-view/layout/layoutFamilyGraph.ts";
import { layoutDescendantForest } from "../src/features/family-tree-view/layout/layoutDescendantForest.ts";
import type {
  FamilyGraphData,
  FamilyTreeLayoutInput,
  LayoutResult,
  PersonId,
  TreePerson,
} from "../src/features/family-tree-view/types.ts";

const HOME_PERSON_ID = "home";
const HOME_DIRECT_LINEAGE = [
  HOME_PERSON_ID,
  "father",
  "mother",
  "paternal-grandfather",
  "paternal-grandmother",
] as const;

function person(id: PersonId, sex: TreePerson["sex"]): TreePerson {
  return {
    id,
    displayName: id,
    sex,
  };
}

function rootLineageFixture(): FamilyGraphData {
  return {
    persons: [
      person("paternal-grandfather", "male"),
      person("paternal-grandmother", "female"),
      person("father", "male"),
      person("mother", "female"),
      person(HOME_PERSON_ID, "male"),
      person("home-partner", "female"),
      person("home-child", "female"),
      person("father-sibling", "female"),
    ],
    unions: [
      {
        id: "paternal-grandparents",
        kind: "parent-set",
        memberIds: ["paternal-grandfather", "paternal-grandmother"],
      },
      {
        id: "home-parents",
        kind: "parent-set",
        memberIds: ["father", "mother"],
      },
      {
        id: "home-family",
        kind: "parent-set",
        memberIds: [HOME_PERSON_ID, "home-partner"],
      },
    ],
    parentChildRelations: [
      {
        id: "paternal-grandfather-to-father",
        parentId: "paternal-grandfather",
        childId: "father",
        unionId: "paternal-grandparents",
        kind: "biological",
        role: "father",
      },
      {
        id: "paternal-grandmother-to-father",
        parentId: "paternal-grandmother",
        childId: "father",
        unionId: "paternal-grandparents",
        kind: "biological",
        role: "mother",
      },
      {
        id: "paternal-grandfather-to-side-child",
        parentId: "paternal-grandfather",
        childId: "father-sibling",
        unionId: "paternal-grandparents",
        kind: "biological",
        role: "father",
      },
      {
        id: "paternal-grandmother-to-side-child",
        parentId: "paternal-grandmother",
        childId: "father-sibling",
        unionId: "paternal-grandparents",
        kind: "biological",
        role: "mother",
      },
      {
        id: "father-to-home",
        parentId: "father",
        childId: HOME_PERSON_ID,
        unionId: "home-parents",
        kind: "biological",
        role: "father",
      },
      {
        id: "mother-to-home",
        parentId: "mother",
        childId: HOME_PERSON_ID,
        unionId: "home-parents",
        kind: "biological",
        role: "mother",
      },
      {
        id: "home-to-child",
        parentId: HOME_PERSON_ID,
        childId: "home-child",
        unionId: "home-family",
        kind: "biological",
        role: "father",
      },
      {
        id: "home-partner-to-child",
        parentId: "home-partner",
        childId: "home-child",
        unionId: "home-family",
        kind: "biological",
        role: "mother",
      },
    ],
  };
}

function layout(
  mode: "family-graph" | "descendant-forest",
  visualFocusPersonId: PersonId,
): LayoutResult {
  const input: FamilyTreeLayoutInput = {
    graph: rootLineageFixture(),
    options: {
      focusPersonId: visualFocusPersonId,
      layoutMode: mode,
      ancestorDepth: 20,
      descendantDepth: 20,
      collateralDepth: 20,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
      primaryLineagePersonIds: HOME_DIRECT_LINEAGE,
      lineageTargetPersonId: HOME_PERSON_ID,
      lineageGroupDepth: 2,
    },
  };
  return mode === "descendant-forest"
    ? layoutDescendantForest(input)
    : layoutFamilyGraph(input);
}

function assertFillRemainsRootedAtHome(
  result: LayoutResult,
  context: string,
): void {
  const rolesFor = (personId: PersonId) => result.nodes
    .filter(node => node.personId === personId)
    .map(node => node.lineageRole);
  const hasLineageFill = (personId: PersonId) => rolesFor(personId).some(
    role => role === "focus" || role === "direct-ancestor",
  );

  assert.ok(
    hasLineageFill(HOME_PERSON_ID),
    `${context}: one concrete home occurrence must own the root-lineage fill`,
  );
  for (const ancestorId of HOME_DIRECT_LINEAGE.slice(1)) {
    assert.ok(
      hasLineageFill(ancestorId),
      `${context}: ${ancestorId} must be filled on its concrete root-lineage occurrence`,
    );
  }
  for (const collateralId of ["home-child", "home-partner", "father-sibling"]) {
    assert.ok(
      rolesFor(collateralId).every(role => role === undefined),
      `${context}: ${collateralId} must not inherit the root-lineage fill`,
    );
  }
}

test("pedigree fill remains anchored to the persisted home when visual focus is an ancestor", () => {
  const result = layout("family-graph", "paternal-grandfather");

  assert.equal(
    result.nodes.find(node => node.personId === "paternal-grandfather")
      ?.occurrenceId,
    result.focusOccurrenceId,
    "the visual focus must remain independent from the lineage target",
  );
  assertFillRemainsRootedAtHome(result, "pedigree ancestor focus");
});

test("family-corridor fill remains anchored to the persisted home when visual focus is a descendant", () => {
  const result = layout("family-graph", "home-child");

  assert.equal(
    result.nodes.find(node => node.personId === "home-child")?.occurrenceId,
    result.focusOccurrenceId,
    "the corridor may move the visual focus without becoming the lineage root",
  );
  assertFillRemainsRootedAtHome(result, "family corridor descendant focus");
});

test("all-descendants fill uses the persisted home lineage instead of the descendant-view root", () => {
  const result = layout("descendant-forest", "paternal-grandfather");

  assert.equal(
    result.nodes.find(node => node.personId === "paternal-grandfather")
      ?.occurrenceId,
    result.focusOccurrenceId,
    "the selected descendant-view root remains the visual focus",
  );
  assertFillRemainsRootedAtHome(result, "all descendants ancestor root");
});

test("descendant convergence cannot erase the persisted root person's ancestors", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("root", "male"),
      person("root-partner", "female"),
      person("a", "male"),
      person("a-partner", "female"),
      person("b", "male"),
      person("b-partner", "female"),
      person("x", "male"),
      person("y", "female"),
    ],
    unions: [
      { id: "root-family", kind: "parent-set", memberIds: ["root", "root-partner"] },
      { id: "a-family", kind: "parent-set", memberIds: ["a", "a-partner"] },
      { id: "b-family", kind: "parent-set", memberIds: ["b", "b-partner"] },
      { id: "xy-partnership", kind: "partnership", memberIds: ["x", "y"] },
    ],
    parentChildRelations: [
      { id: "root-a", parentId: "root", childId: "a", unionId: "root-family", kind: "biological", role: "father" },
      { id: "root-partner-a", parentId: "root-partner", childId: "a", unionId: "root-family", kind: "biological", role: "mother" },
      { id: "root-b", parentId: "root", childId: "b", unionId: "root-family", kind: "biological", role: "father" },
      { id: "root-partner-b", parentId: "root-partner", childId: "b", unionId: "root-family", kind: "biological", role: "mother" },
      { id: "a-x", parentId: "a", childId: "x", unionId: "a-family", kind: "biological", role: "father" },
      { id: "a-partner-x", parentId: "a-partner", childId: "x", unionId: "a-family", kind: "biological", role: "mother" },
      { id: "b-y", parentId: "b", childId: "y", unionId: "b-family", kind: "biological", role: "father" },
      { id: "b-partner-y", parentId: "b-partner", childId: "y", unionId: "b-family", kind: "biological", role: "mother" },
    ],
  };
  const result = layoutDescendantForest({
    graph,
    options: {
      focusPersonId: "root",
      layoutMode: "descendant-forest",
      ancestorDepth: 20,
      descendantDepth: 20,
      collateralDepth: 20,
      maxVisibleNodes: 100,
      showAllParentSets: true,
      showUnknownParentPlaceholders: false,
      primaryLineagePersonIds: ["root", "a", "x"],
      lineageTargetPersonId: "y",
      lineageGroupDepth: 2,
    },
  });
  const roleFor = (personId: PersonId) => result.nodes.find(
    node => node.personId === personId,
  )?.lineageRole;

  assert.equal(roleFor("y"), "focus");
  for (const ancestorId of ["b", "b-partner", "root", "root-partner"]) {
    assert.equal(
      roleFor(ancestorId),
      "direct-ancestor",
      `${ancestorId} remains in y's root-based lineage after convergence`,
    );
  }
  for (const collateralId of ["a", "a-partner", "x"]) {
    assert.equal(roleFor(collateralId), undefined);
  }
  assert.ok(
    result.nodes.some(node => node.kind === "convergence"),
    "fixture must exercise the convergence-portal rewrite",
  );
});

test("production passes the persisted home as one lineage target for every perspective", () => {
  const productionPage = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    productionPage,
    /const homePersonId = entryPoint\.rootPersonId!;/,
    "the lineage anchor must come from the persisted tree root",
  );
  assert.match(
    productionPage,
    /const lineageTargetPersonId = homePersonId;/,
    "temporary pedigree/corridor/descendant focus must not replace the root lineage target",
  );
  assert.match(
    productionPage,
    /const layoutOptions = useMemo<FamilyTreeLayoutOptions>[\s\S]*?lineageTargetPersonId,/,
    "the shared options passed to both layout solvers must carry the stable target",
  );
  assert.doesNotMatch(
    productionPage,
    /const lineageTargetPersonId = perspective\./,
    "a viewing perspective is not allowed to choose the direct-lineage root",
  );
});
