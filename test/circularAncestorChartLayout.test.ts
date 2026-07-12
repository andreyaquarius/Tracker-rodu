import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCircularAncestorChartModel,
  CIRCULAR_ANCESTOR_FOCUS_RADIUS,
  CIRCULAR_ANCESTOR_RING_WIDTH,
  MAX_CIRCULAR_ANCESTOR_OCCURRENCES,
} from "../src/features/family-tree-view/circular/circularAncestorChartLayout.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

function person(
  id: string,
  sex: TreePerson["sex"] = "unknown",
): TreePerson {
  return { id, displayName: id, sex };
}

function relation(
  id: string,
  parentId: string,
  childId: string,
  unionId: string,
  role: ParentChildRelation["role"],
  overrides: Partial<ParentChildRelation> = {},
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    unionId,
    role,
    kind: "biological",
    ...overrides,
  };
}

function parentSet(
  id: string,
  memberIds: readonly string[],
  overrides: Partial<TreeUnion> = {},
): TreeUnion {
  return {
    id,
    kind: "parent-set",
    memberIds,
    ...overrides,
  };
}

function completeTwoGenerationGraph(): FamilyGraphData {
  return {
    persons: [
      person("mm", "female"),
      person("focus"),
      person("father", "male"),
      person("mf", "male"),
      person("mother", "female"),
      person("fm", "female"),
      person("ff", "male"),
    ],
    unions: [
      parentSet("mother-parents", ["mf", "mm"]),
      parentSet("focus-parents", ["father", "mother"]),
      parentSet("father-parents", ["ff", "fm"]),
    ],
    // Deliberately reversed and mixed to prove role/sex-based determinism.
    parentChildRelations: [
      relation("mm-mother", "mm", "mother", "mother-parents", "mother"),
      relation("fm-father", "fm", "father", "father-parents", "mother"),
      relation("mother-focus", "mother", "focus", "focus-parents", "mother"),
      relation("mf-mother", "mf", "mother", "mother-parents", "father"),
      relation("father-focus", "father", "focus", "focus-parents", "father"),
      relation("ff-father", "ff", "father", "father-parents", "father"),
    ],
  };
}

function compact(model: ReturnType<typeof buildCircularAncestorChartModel>) {
  return model.occurrences.map(occurrence => ({
    personId: occurrence.personId,
    slot: occurrence.slot,
    generation: occurrence.generation,
    index: occurrence.index,
    branch: occurrence.branch,
  }));
}

test("assigns stable Ahnentafel slots and complete-circle geometry", () => {
  const model = buildCircularAncestorChartModel(
    completeTwoGenerationGraph(),
    "focus",
    2,
  );

  assert.deepEqual(compact(model), [
    { personId: "focus", slot: 1, generation: 0, index: 0, branch: "focus" },
    { personId: "father", slot: 2, generation: 1, index: 0, branch: "paternal" },
    { personId: "mother", slot: 3, generation: 1, index: 1, branch: "maternal" },
    { personId: "ff", slot: 4, generation: 2, index: 0, branch: "paternal" },
    { personId: "fm", slot: 5, generation: 2, index: 1, branch: "paternal" },
    { personId: "mf", slot: 6, generation: 2, index: 2, branch: "maternal" },
    { personId: "mm", slot: 7, generation: 2, index: 3, branch: "maternal" },
  ]);

  const focus = model.occurrences[0]!;
  const father = model.occurrences[1]!;
  const mother = model.occurrences[2]!;
  const ff = model.occurrences[3]!;
  assert.deepEqual(
    [focus.startAngle, focus.endAngle, focus.innerRadius, focus.outerRadius],
    [-90, 270, 0, CIRCULAR_ANCESTOR_FOCUS_RADIUS],
  );
  assert.deepEqual(
    [father.startAngle, father.endAngle, father.innerRadius, father.outerRadius],
    [-90, 90, 72, 72 + CIRCULAR_ANCESTOR_RING_WIDTH],
  );
  assert.deepEqual(
    [mother.startAngle, mother.endAngle],
    [90, 270],
  );
  assert.deepEqual(
    [ff.startAngle, ff.endAngle, ff.innerRadius, ff.outerRadius],
    [-90, 0, 130, 188],
  );
  assert.deepEqual(model.warnings, []);
});

test("a sparse maternal line keeps its Ahnentafel positions instead of compacting", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("mother", "female"),
      person("maternal-grandfather", "male"),
    ],
    unions: [
      parentSet("focus-parents", ["mother"]),
      parentSet("mother-parents", ["maternal-grandfather"]),
    ],
    parentChildRelations: [
      relation("mother-focus", "mother", "focus", "focus-parents", "mother"),
      relation(
        "mgf-mother",
        "maternal-grandfather",
        "mother",
        "mother-parents",
        "father",
      ),
    ],
  };

  const model = buildCircularAncestorChartModel(graph, "focus", 2);
  assert.deepEqual(
    model.occurrences.map(item => [item.personId, item.slot, item.branch]),
    [
      ["focus", 1, "focus"],
      ["mother", 3, "maternal"],
      ["maternal-grandfather", 6, "maternal"],
    ],
  );
});

test("parent-set preference is deterministic and falls back to biological priority", () => {
  const persons = [
    person("focus"),
    person("bio-father", "male"),
    person("bio-mother", "female"),
    person("default-father", "male"),
    person("default-mother", "female"),
    person("preferred-father", "male"),
    person("preferred-mother", "female"),
  ];
  const relations: ParentChildRelation[] = [
    relation("bio-f", "bio-father", "focus", "z-bio", "father"),
    relation("bio-m", "bio-mother", "focus", "z-bio", "mother"),
    relation(
      "default-f",
      "default-father",
      "focus",
      "m-default",
      "father",
      { kind: "adoptive" },
    ),
    relation(
      "default-m",
      "default-mother",
      "focus",
      "m-default",
      "mother",
      { kind: "adoptive" },
    ),
    relation(
      "preferred-f",
      "preferred-father",
      "focus",
      "a-preferred",
      "father",
      { kind: "social_parent", isPreferred: true },
    ),
    relation(
      "preferred-m",
      "preferred-mother",
      "focus",
      "a-preferred",
      "mother",
      { kind: "social_parent", isPreferred: true },
    ),
  ];
  const graph: FamilyGraphData = {
    persons,
    unions: [
      parentSet("z-bio", ["bio-father", "bio-mother"]),
      parentSet(
        "m-default",
        ["default-father", "default-mother"],
        { isDefaultForPedigree: true },
      ),
      parentSet(
        "a-preferred",
        ["preferred-father", "preferred-mother"],
        { isPreferredForDisplay: true },
      ),
    ],
    parentChildRelations: relations,
  };

  assert.deepEqual(
    buildCircularAncestorChartModel(graph, "focus", 1).occurrences
      .map(item => item.personId),
    ["focus", "default-father", "default-mother"],
  );

  const relationPreferred: FamilyGraphData = {
    ...graph,
    unions: graph.unions.map(union => ({
      ...union,
      isDefaultForPedigree: false,
    })),
  };
  assert.deepEqual(
    buildCircularAncestorChartModel(
      relationPreferred,
      "focus",
      1,
    ).occurrences.map(item => item.personId),
    ["focus", "preferred-father", "preferred-mother"],
  );

  const unionPreferred: FamilyGraphData = {
    ...relationPreferred,
    parentChildRelations: relations.map(relation => ({
      ...relation,
      isPreferred: false,
    })),
  };
  assert.deepEqual(
    buildCircularAncestorChartModel(
      unionPreferred,
      "focus",
      1,
    ).occurrences.map(item => item.personId),
    ["focus", "preferred-father", "preferred-mother"],
  );

  const withoutExplicitPreference: FamilyGraphData = {
    ...unionPreferred,
    unions: unionPreferred.unions.map(union => ({
      ...union,
      isPreferredForDisplay: false,
    })),
  };
  assert.deepEqual(
    buildCircularAncestorChartModel(
      withoutExplicitPreference,
      "focus",
      1,
    ).occurrences.map(item => item.personId),
    ["focus", "bio-father", "bio-mother"],
  );

  const reversed: FamilyGraphData = {
    ...graph,
    persons: [...graph.persons].reverse(),
    unions: [...graph.unions].reverse(),
    parentChildRelations: [...graph.parentChildRelations].reverse(),
  };
  assert.deepEqual(
    compact(buildCircularAncestorChartModel(reversed, "focus", 1)),
    compact(buildCircularAncestorChartModel(graph, "focus", 1)),
  );
});

test("pedigree collapse keeps separate slots and marks every repeated occurrence", () => {
  const graph: FamilyGraphData = {
    persons: [
      person("focus"),
      person("father", "male"),
      person("mother", "female"),
      person("shared", "male"),
    ],
    unions: [
      parentSet("focus-parents", ["father", "mother"]),
      parentSet("father-parents", ["shared"]),
      parentSet("mother-parents", ["shared"]),
    ],
    parentChildRelations: [
      relation("father-focus", "father", "focus", "focus-parents", "father"),
      relation("mother-focus", "mother", "focus", "focus-parents", "mother"),
      relation("shared-father", "shared", "father", "father-parents", "father"),
      relation("shared-mother", "shared", "mother", "mother-parents", "father"),
    ],
  };

  const repeated = buildCircularAncestorChartModel(graph, "focus", 2)
    .occurrences.filter(item => item.personId === "shared");
  assert.deepEqual(repeated.map(item => item.slot), [4, 6]);
  assert.deepEqual(
    repeated.map(item => item.occurrenceId),
    ["circular-ancestor:4", "circular-ancestor:6"],
  );
  assert.equal(repeated.every(item => item.duplicate), true);
});

test("a cycle is cut only on its current ancestry path", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("father", "male")],
    unions: [
      parentSet("focus-parents", ["father"]),
      parentSet("father-parents", ["focus"]),
    ],
    parentChildRelations: [
      relation("father-focus", "father", "focus", "focus-parents", "father"),
      relation("focus-father", "focus", "father", "father-parents", "father"),
    ],
  };

  const model = buildCircularAncestorChartModel(graph, "focus", 16);
  assert.deepEqual(model.occurrences.map(item => item.slot), [1, 2]);
  assert.equal(model.warnings.length, 1);
  assert.match(model.warnings[0]!, /циклічний зв’язок/);
});

test("pedigree-collapse expansion is capped before it can create an exponential SVG", () => {
  const persons: TreePerson[] = [person("focus")];
  const unions: TreeUnion[] = [];
  const relations: ParentChildRelation[] = [];
  let children = ["focus"];

  for (let generation = 1; generation <= 16; generation += 1) {
    const fatherId = `father-${generation}`;
    const motherId = `mother-${generation}`;
    persons.push(person(fatherId, "male"), person(motherId, "female"));
    for (const childId of children) {
      const unionId = `parents:${childId}`;
      unions.push(parentSet(unionId, [fatherId, motherId]));
      relations.push(
        relation(`${fatherId}:${childId}`, fatherId, childId, unionId, "father"),
        relation(`${motherId}:${childId}`, motherId, childId, unionId, "mother"),
      );
    }
    children = [fatherId, motherId];
  }

  const model = buildCircularAncestorChartModel(
    { persons, unions, parentChildRelations: relations },
    "focus",
    16,
  );
  assert.equal(model.occurrences.length, MAX_CIRCULAR_ANCESTOR_OCCURRENCES);
  assert.equal(model.warnings.some(message => message.includes("обмежено")), true);
});

test("a sixteen-generation sparse chain stays bounded and geometrically finite", () => {
  const people = Array.from({ length: 19 }, (_, index) =>
    person(index === 0 ? "focus" : `ancestor-${index}`, "male"),
  );
  const relations = Array.from({ length: 18 }, (_, index) =>
    relation(
      `relation-${index + 1}`,
      `ancestor-${index + 1}`,
      index === 0 ? "focus" : `ancestor-${index}`,
      `parents-${index}`,
      "father",
    ),
  );
  const graph: FamilyGraphData = {
    persons: people,
    unions: Array.from({ length: 18 }, (_, index) =>
      parentSet(`parents-${index}`, [`ancestor-${index + 1}`]),
    ),
    parentChildRelations: relations,
  };

  const model = buildCircularAncestorChartModel(graph, "focus", 100);
  assert.equal(model.maxGeneration, 16);
  assert.equal(model.occurrences.length, 17);
  assert.equal(model.occurrences.at(-1)?.generation, 16);
  assert.equal(model.occurrences.at(-1)?.slot, 2 ** 16);
  for (const occurrence of model.occurrences) {
    assert.equal(Number.isFinite(occurrence.startAngle), true);
    assert.equal(Number.isFinite(occurrence.endAngle), true);
    assert.equal(Number.isFinite(occurrence.innerRadius), true);
    assert.equal(Number.isFinite(occurrence.outerRadius), true);
    assert.equal(occurrence.endAngle > occurrence.startAngle, true);
    assert.equal(occurrence.outerRadius > occurrence.innerRadius, true);
  }

  const minimum = buildCircularAncestorChartModel(graph, "focus", 0);
  assert.equal(minimum.maxGeneration, 1);
  assert.deepEqual(minimum.occurrences.map(item => item.slot), [1, 2]);
});

test("missing canonical people are omitted without shifting known parent slots", () => {
  const graph: FamilyGraphData = {
    persons: [person("focus"), person("mother", "female")],
    unions: [parentSet("focus-parents", ["missing-father", "mother"])],
    parentChildRelations: [
      relation(
        "missing-father-focus",
        "missing-father",
        "focus",
        "focus-parents",
        "father",
      ),
      relation("mother-focus", "mother", "focus", "focus-parents", "mother"),
    ],
  };

  const model = buildCircularAncestorChartModel(graph, "focus", 1);
  assert.deepEqual(model.occurrences.map(item => item.slot), [1, 3]);
  assert.equal(model.warnings.length, 1);
  assert.match(model.warnings[0]!, /missing-father/);
});
