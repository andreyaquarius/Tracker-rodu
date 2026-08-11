import assert from "node:assert/strict";
import test from "node:test";
import { layoutDirectPedigree } from "../src/features/family-tree-view/layout/layoutDirectPedigree.ts";
import { buildRootLineageProjection } from "../src/features/family-tree-view/state/rootLineageProjection.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

function person(id: PersonId, sex: TreePerson["sex"] = "unknown"): TreePerson {
  return { id, displayName: id, sex };
}

function relation(
  id: string,
  parentId: PersonId,
  childId: PersonId,
  unionId: string,
  role: ParentChildRelation["role"] = "parent",
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    unionId,
    kind: "biological",
    role,
  };
}

function directPedigreeFixture(): FamilyGraphData {
  const persons = [
    person("root"),
    person("father", "male"),
    person("mother", "female"),
    person("paternal-grandfather", "male"),
    person("paternal-grandmother", "female"),
    person("maternal-grandfather", "male"),
    person("maternal-grandmother", "female"),
    person("sibling"),
    person("spouse"),
    person("child"),
  ];
  const unions: TreeUnion[] = [
    {
      id: "root-parents",
      kind: "parent-set",
      memberIds: ["father", "mother"],
      expectedParentSlots: 2,
    },
    {
      id: "root-parents-partnership",
      kind: "partnership",
      memberIds: ["father", "mother"],
    },
    {
      id: "father-parents",
      kind: "parent-set",
      memberIds: ["paternal-grandfather", "paternal-grandmother"],
    },
    {
      id: "mother-parents",
      kind: "parent-set",
      memberIds: ["maternal-grandfather", "maternal-grandmother"],
    },
    { id: "root-spouse", kind: "partnership", memberIds: ["root", "spouse"] },
    { id: "root-child", kind: "parent-set", memberIds: ["root", "spouse"] },
  ];
  return {
    persons,
    unions,
    parentChildRelations: [
      relation("father-root", "father", "root", "root-parents", "father"),
      relation("mother-root", "mother", "root", "root-parents", "mother"),
      relation("father-sibling", "father", "sibling", "root-parents", "father"),
      relation("mother-sibling", "mother", "sibling", "root-parents", "mother"),
      relation(
        "paternal-grandfather-father",
        "paternal-grandfather",
        "father",
        "father-parents",
        "father",
      ),
      relation(
        "paternal-grandmother-father",
        "paternal-grandmother",
        "father",
        "father-parents",
        "mother",
      ),
      relation(
        "maternal-grandfather-mother",
        "maternal-grandfather",
        "mother",
        "mother-parents",
        "father",
      ),
      relation(
        "maternal-grandmother-mother",
        "maternal-grandmother",
        "mother",
        "mother-parents",
        "mother",
      ),
      relation("root-child", "root", "child", "root-child", "father"),
      relation("spouse-child", "spouse", "child", "root-child", "mother"),
    ],
  };
}

test("direct pedigree projection excludes descendants, siblings, and spouses", () => {
  const projection = buildRootLineageProjection({
    graph: directPedigreeFixture(),
    rootPersonId: "root",
  });

  const visibleIds = new Set(projection.graph.persons.map(value => value.id));
  assert.deepEqual(
    ["root", "father", "mother", "paternal-grandfather", "paternal-grandmother", "maternal-grandfather", "maternal-grandmother"]
      .filter(personId => !visibleIds.has(personId)),
    [],
  );
  assert.equal(visibleIds.has("sibling"), false);
  assert.equal(visibleIds.has("spouse"), false);
  assert.equal(visibleIds.has("child"), false);
  assert.deepEqual(projection.graph.continuations, []);
  assert.deepEqual(projection.graph.familyContinuations, []);
});

test("direct pedigree lays generations from left to right with upright cards", () => {
  const projection = buildRootLineageProjection({
    graph: directPedigreeFixture(),
    rootPersonId: "root",
  });
  const layout = layoutDirectPedigree({
    graph: projection.graph,
    options: {
      focusPersonId: "root",
      layoutMode: "direct-pedigree",
      ancestorDepth: 10,
      descendantDepth: 0,
      collateralDepth: 0,
      maxVisibleNodes: 100,
      showUnknownParentPlaceholders: true,
    },
  });
  const nodeFor = (personId: string) => {
    const node = layout.nodes.find(value => value.personId === personId);
    assert.ok(node, `${personId} must be visible`);
    return node;
  };
  const centerX = (personId: string) => {
    const node = nodeFor(personId);
    return node.x + node.width / 2;
  };

  assert.ok(centerX("root") < centerX("father"));
  assert.ok(centerX("father") < centerX("paternal-grandfather"));
  assert.ok(centerX("mother") < centerX("maternal-grandmother"));
  assert.ok(nodeFor("father").y < nodeFor("mother").y);
  assert.deepEqual(layout.generationBands, []);
  assert.equal(layout.warnings.some(value => value.code === "INVALID_COORDINATE"), false);
});

test("direct pedigree keeps recursive ordering beyond the sample depth", () => {
  const persons = [person("root")];
  const unions: TreeUnion[] = [];
  const parentChildRelations: ParentChildRelation[] = [];
  let childId = "root";
  for (let generation = 1; generation <= 9; generation += 1) {
    const parentId = `ancestor-${generation}`;
    const unionId = `parents-${generation}`;
    persons.push(person(parentId, "male"));
    unions.push({ id: unionId, kind: "parent-set", memberIds: [parentId] });
    parentChildRelations.push(
      relation(`relation-${generation}`, parentId, childId, unionId, "father"),
    );
    childId = parentId;
  }
  const graph: FamilyGraphData = { persons, unions, parentChildRelations };
  const projection = buildRootLineageProjection({ graph, rootPersonId: "root" });
  const layout = layoutDirectPedigree({
    graph: projection.graph,
    options: {
      focusPersonId: "root",
      layoutMode: "direct-pedigree",
      ancestorDepth: 12,
      maxVisibleNodes: 100,
    },
  });
  const centers = ["root", ...Array.from({ length: 9 }, (_, index) => `ancestor-${index + 1}`)]
    .map(personId => {
      const node = layout.nodes.find(value => value.personId === personId);
      assert.ok(node, `${personId} must be visible`);
      return node.x + node.width / 2;
    });
  for (let index = 1; index < centers.length; index += 1) {
    assert.ok(centers[index]! > centers[index - 1]!, `generation ${index} must move right`);
  }
});
