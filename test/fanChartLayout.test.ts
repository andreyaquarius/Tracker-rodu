import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAncestorFanChartModel,
  buildDescendantFanChartModel,
  buildFanChartModel,
  FAN_CHART_FOCUS_RADIUS,
  FAN_CHART_RING_WIDTH,
  fanChartSectorGapDegrees,
  MAX_ANCESTOR_FAN_GENERATIONS,
  MAX_DESCENDANT_FAN_GENERATIONS,
  MAX_FAN_CHART_OCCURRENCES,
  normalizeFanChartGenerations,
} from "../src/features/family-tree-view/fan/fanChartLayout.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

function person(
  id: string,
  sex: TreePerson["sex"] = "unknown",
  overrides: Partial<TreePerson> = {},
): TreePerson {
  return { id, displayName: id, sex, ...overrides };
}

function relation(
  id: string,
  parentId: string,
  childId: string,
  overrides: Partial<ParentChildRelation> = {},
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    kind: "biological",
    ...overrides,
  };
}

function parentSet(
  id: string,
  memberIds: readonly string[],
): TreeUnion {
  return { id, kind: "parent-set", memberIds };
}

function ancestorGraph(): FamilyGraphData {
  return {
    persons: [
      person("focus"),
      person("father", "male"),
      person("mother", "female"),
      person("ff", "male"),
      person("fm", "female"),
      person("mf", "male"),
      person("mm", "female"),
    ],
    unions: [
      parentSet("focus-parents", ["father", "mother"]),
      parentSet("father-parents", ["ff", "fm"]),
      parentSet("mother-parents", ["mf", "mm"]),
    ],
    parentChildRelations: [
      relation("mother-focus", "mother", "focus", {
        unionId: "focus-parents",
        role: "mother",
      }),
      relation("father-focus", "father", "focus", {
        unionId: "focus-parents",
        role: "father",
      }),
      relation("fm-father", "fm", "father", {
        unionId: "father-parents",
        role: "mother",
      }),
      relation("ff-father", "ff", "father", {
        unionId: "father-parents",
        role: "father",
      }),
      relation("mm-mother", "mm", "mother", {
        unionId: "mother-parents",
        role: "mother",
      }),
      relation("mf-mother", "mf", "mother", {
        unionId: "mother-parents",
        role: "father",
      }),
    ],
  };
}

test("ancestor fan preserves Ahnentafel slots with the father's branch on the left", () => {
  const model = buildAncestorFanChartModel(ancestorGraph(), "focus", 2);

  assert.equal(model.direction, "ancestors");
  assert.deepEqual(
    model.occurrences.map(item => ({
      personId: item.personId,
      slot: item.slot,
      generation: item.generation,
      index: item.index,
      branch: item.branch,
      angles: [item.startAngle, item.endAngle],
    })),
    [
      { personId: "focus", slot: 1, generation: 0, index: 0, branch: "focus", angles: [-180, 180] },
      { personId: "father", slot: 2, generation: 1, index: 0, branch: "paternal", angles: [-90, 0] },
      { personId: "mother", slot: 3, generation: 1, index: 1, branch: "maternal", angles: [-180, -90] },
      { personId: "ff", slot: 4, generation: 2, index: 0, branch: "paternal", angles: [-45, 0] },
      { personId: "fm", slot: 5, generation: 2, index: 1, branch: "paternal", angles: [-90, -45] },
      { personId: "mf", slot: 6, generation: 2, index: 2, branch: "maternal", angles: [-135, -90] },
      { personId: "mm", slot: 7, generation: 2, index: 3, branch: "maternal", angles: [-180, -135] },
    ],
  );

  assert.deepEqual(
    [
      model.occurrences[1]?.innerRadius,
      model.occurrences[1]?.outerRadius,
      model.occurrences[3]?.innerRadius,
      model.occurrences[3]?.outerRadius,
    ],
    [
      FAN_CHART_FOCUS_RADIUS,
      FAN_CHART_FOCUS_RADIUS + FAN_CHART_RING_WIDTH,
      FAN_CHART_FOCUS_RADIUS + FAN_CHART_RING_WIDTH,
      FAN_CHART_FOCUS_RADIUS + 2 * FAN_CHART_RING_WIDTH,
    ],
  );
  assert.equal(model.occurrences[1]?.parentOccurrenceId, "fan-ancestor:1");
});

test("ancestor fan keeps sparse maternal positions and circular-model warnings", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("mother", "female"), person("mgf", "male")],
    unions: [
      parentSet("focus-parents", ["mother"]),
      parentSet("mother-parents", ["mgf", "missing-mgm"]),
    ],
    parentChildRelations: [
      relation("mother-focus", "mother", "focus", {
        unionId: "focus-parents",
        role: "mother",
      }),
      relation("mgf-mother", "mgf", "mother", {
        unionId: "mother-parents",
        role: "father",
      }),
      relation("missing-mgm-mother", "missing-mgm", "mother", {
        unionId: "mother-parents",
        role: "mother",
      }),
    ],
  };

  const model = buildAncestorFanChartModel(graph, "focus", 2);
  assert.deepEqual(
    model.occurrences.map(item => [item.personId, item.slot, item.startAngle, item.endAngle]),
    [
      ["focus", 1, -180, 180],
      ["mother", 3, -180, -90],
      ["mgf", 6, -135, -90],
    ],
  );
  assert.equal(model.warnings.length, 1);
  assert.match(model.warnings[0]!, /missing-mgm/);
});

function weightedDescendantGraph(): FamilyGraphData {
  return {
    persons: [
      person("focus"),
      person("anna", "female", { birth: { sort: "1880" } }),
      person("boris", "male", { birth: { sort: "1900" } }),
      person("anna-1"),
      person("anna-2"),
      person("anna-3"),
      person("boris-1"),
    ],
    unions: [],
    parentChildRelations: [
      relation("focus-boris", "focus", "boris"),
      relation("anna-3", "anna", "anna-3"),
      relation("focus-anna", "focus", "anna"),
      relation("boris-1", "boris", "boris-1"),
      relation("anna-2", "anna", "anna-2"),
      relation("anna-1", "anna", "anna-1"),
    ],
  };
}

function compactDescendants(model: ReturnType<typeof buildDescendantFanChartModel>) {
  return model.occurrences.map(item => ({
    personId: item.personId,
    generation: item.generation,
    index: item.index,
    relationId: item.relationId,
    parentOccurrenceId: item.parentOccurrenceId,
    angles: [item.startAngle, item.endAngle],
    subtreeWeight: item.subtreeWeight,
  }));
}

test("descendant fan allocates angles by leaf weight and remains deterministic", () => {
  const graph = weightedDescendantGraph();
  const model = buildDescendantFanChartModel(graph, "focus", 2);

  assert.equal(model.direction, "descendants");
  assert.deepEqual(compactDescendants(model), [
    {
      personId: "focus",
      generation: 0,
      index: 0,
      relationId: undefined,
      parentOccurrenceId: undefined,
      angles: [-180, 180],
      subtreeWeight: 4,
    },
    {
      personId: "anna",
      generation: 1,
      index: 0,
      relationId: "focus-anna",
      parentOccurrenceId: "fan-descendant:1",
      angles: [0, 135],
      subtreeWeight: 3,
    },
    {
      personId: "boris",
      generation: 1,
      index: 1,
      relationId: "focus-boris",
      parentOccurrenceId: "fan-descendant:1",
      angles: [135, 180],
      subtreeWeight: 1,
    },
    {
      personId: "anna-1",
      generation: 2,
      index: 0,
      relationId: "anna-1",
      parentOccurrenceId: "fan-descendant:2",
      angles: [0, 45],
      subtreeWeight: 1,
    },
    {
      personId: "anna-2",
      generation: 2,
      index: 1,
      relationId: "anna-2",
      parentOccurrenceId: "fan-descendant:2",
      angles: [45, 90],
      subtreeWeight: 1,
    },
    {
      personId: "anna-3",
      generation: 2,
      index: 2,
      relationId: "anna-3",
      parentOccurrenceId: "fan-descendant:2",
      angles: [90, 135],
      subtreeWeight: 1,
    },
    {
      personId: "boris-1",
      generation: 2,
      index: 3,
      relationId: "boris-1",
      parentOccurrenceId: "fan-descendant:3",
      angles: [135, 180],
      subtreeWeight: 1,
    },
  ]);

  const reversed: FamilyGraphData = {
    persons: [...graph.persons].reverse(),
    unions: [],
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  assert.deepEqual(
    compactDescendants(buildDescendantFanChartModel(reversed, "focus", 2)),
    compactDescendants(model),
  );
});

test("parallel relations to one child collapse to the preferred canonical edge", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("child")],
    unions: [],
    parentChildRelations: [
      relation("social", "focus", "child", { kind: "social_parent" }),
      relation("preferred", "focus", "child", {
        kind: "adoptive",
        isPreferred: true,
      }),
      relation("biological", "focus", "child"),
    ],
  };

  const model = buildDescendantFanChartModel(graph, "focus", 1);
  assert.equal(model.occurrences.length, 2);
  assert.equal(model.occurrences[1]?.relationId, "preferred");
});

test("pedigree convergence keeps separate descendant paths and marks duplicates", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("left"),
      person("right"),
      person("shared"),
    ],
    unions: [],
    parentChildRelations: [
      relation("focus-left", "focus", "left"),
      relation("focus-right", "focus", "right"),
      relation("left-shared", "left", "shared"),
      relation("right-shared", "right", "shared"),
    ],
  };

  const repeated = buildDescendantFanChartModel(graph, "focus", 2)
    .occurrences.filter(item => item.personId === "shared");
  assert.equal(repeated.length, 2);
  assert.equal(repeated.every(item => item.duplicate), true);
  assert.notEqual(repeated[0]?.pathKey, repeated[1]?.pathKey);
  assert.deepEqual(repeated.map(item => item.parentOccurrenceId), [
    "fan-descendant:2",
    "fan-descendant:3",
  ]);
});

test("a descendant cycle is cut only on its current path", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("child")],
    unions: [],
    parentChildRelations: [
      relation("focus-child", "focus", "child"),
      relation("child-focus", "child", "focus"),
    ],
  };

  const model = buildDescendantFanChartModel(graph, "focus", 10);
  assert.deepEqual(model.occurrences.map(item => item.personId), ["focus", "child"]);
  assert.equal(model.warnings.length, 1);
  assert.match(model.warnings[0]!, /циклічний зв’язок/);
});

test("missing descendants are reported without shifting known sectors", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("known")],
    unions: [],
    parentChildRelations: [
      relation("missing", "focus", "missing-child", { displayOrder: "a" }),
      relation("known", "focus", "known", { displayOrder: "b" }),
    ],
  };

  const model = buildDescendantFanChartModel(graph, "focus", 1);
  assert.deepEqual(model.occurrences.map(item => item.personId), ["focus", "known"]);
  assert.deepEqual(
    [model.occurrences[1]?.startAngle, model.occurrences[1]?.endAngle],
    [0, 180],
  );
  assert.equal(model.warnings.length, 1);
  assert.match(model.warnings[0]!, /missing-child/);
});

test("descendant occurrence expansion has a hard deterministic cap", () => {
  const children = Array.from(
    { length: MAX_FAN_CHART_OCCURRENCES + 5 },
    (_, index) => person(`child-${String(index).padStart(4, "0")}`),
  );
  const graph: FamilyGraphData = {
    persons: [person("focus"), ...children],
    unions: [],
    parentChildRelations: children.map(child =>
      relation(`relation-${child.id}`, "focus", child.id),
    ),
  };

  const model = buildDescendantFanChartModel(graph, "focus", 1);
  assert.equal(model.occurrences.length, MAX_FAN_CHART_OCCURRENCES);
  assert.equal(model.warnings.some(message => message.includes("обмежено")), true);
  assert.equal(
    model.occurrences.every(item =>
      Number.isFinite(item.startAngle) &&
      Number.isFinite(item.endAngle) &&
      item.endAngle > item.startAngle,
    ),
    true,
  );
});

test("generation normalization, dispatcher, gaps and missing focus stay bounded", () => {
  assert.equal(normalizeFanChartGenerations("ancestors", 0), 1);
  assert.equal(
    normalizeFanChartGenerations("ancestors", Number.POSITIVE_INFINITY),
    1,
  );
  assert.equal(
    normalizeFanChartGenerations("ancestors", 100),
    MAX_ANCESTOR_FAN_GENERATIONS,
  );
  assert.equal(
    normalizeFanChartGenerations("descendants", 100),
    MAX_DESCENDANT_FAN_GENERATIONS,
  );
  assert.equal(fanChartSectorGapDegrees(0, 180), 0.7);
  assert.equal(fanChartSectorGapDegrees(10, 10), 0);

  const graph: FamilyGraphData = {
    persons: [person("focus")],
    unions: [],
    parentChildRelations: [],
  };
  assert.equal(
    buildFanChartModel(graph, "focus", 3, "ancestors").direction,
    "ancestors",
  );
  assert.equal(
    buildFanChartModel(graph, "focus", 3, "descendants").direction,
    "descendants",
  );

  const missing = buildDescendantFanChartModel(graph, "missing", 2);
  assert.deepEqual(missing.occurrences, []);
  assert.match(missing.warnings[0]!, /Центральну особу missing/);
});
