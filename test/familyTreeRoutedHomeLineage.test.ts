import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mergeNeighborhood } from "../src/features/family-tree-view/data/neighborhoodClient.ts";
import { buildRoutedHomeLineageProjection } from "../src/features/family-tree-view/state/routedHomeLineageProjection.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

function relation(
  id: string,
  parentId: string,
  childId: string,
  unionId?: string,
): ParentChildRelation {
  return {
    id,
    parentId,
    childId,
    ...(unionId ? { unionId } : {}),
    kind: "biological",
  };
}

function union(
  id: string,
  kind: TreeUnion["kind"],
  memberIds: readonly string[],
): TreeUnion {
  return { id, kind, memberIds };
}

function ids(values: readonly { id: string }[]): string[] {
  return values.map(value => value.id).sort();
}

function homeAncestorNeighborhood(): FamilyGraphData {
  const personIds = [
    "target-father",
    "target-mother",
    "great-great-grandfather",
    "target-partner",
    "great-grandparent",
    "great-grandparent-partner",
    "grandparent",
    "grandparent-partner",
    "parent",
    "parent-partner",
    "home",
    "side-child",
    "unrelated",
  ];
  return {
    persons: personIds.map(id => ({ id, displayName: id })),
    unions: [
      union("target-parents", "parent-set", ["target-father", "target-mother"]),
      union("target-partnership", "partnership", [
        "great-great-grandfather",
        "target-partner",
      ]),
      union("target-line-family", "parent-set", [
        "great-great-grandfather",
        "target-partner",
      ]),
      union("target-side-family", "parent-set", [
        "great-great-grandfather",
        "target-partner",
      ]),
      union("great-family", "parent-set", [
        "great-grandparent",
        "great-grandparent-partner",
      ]),
      union("grand-family", "parent-set", [
        "grandparent",
        "grandparent-partner",
      ]),
      union("parent-family", "parent-set", ["parent", "parent-partner"]),
    ],
    parentChildRelations: [
      relation(
        "target-father-target",
        "target-father",
        "great-great-grandfather",
        "target-parents",
      ),
      relation(
        "target-mother-target",
        "target-mother",
        "great-great-grandfather",
        "target-parents",
      ),
      relation(
        "target-great",
        "great-great-grandfather",
        "great-grandparent",
        "target-line-family",
      ),
      relation(
        "target-partner-great",
        "target-partner",
        "great-grandparent",
        "target-line-family",
      ),
      relation(
        "target-side",
        "great-great-grandfather",
        "side-child",
        "target-side-family",
      ),
      relation(
        "target-partner-side",
        "target-partner",
        "side-child",
        "target-side-family",
      ),
      relation("great-grand", "great-grandparent", "grandparent", "great-family"),
      relation(
        "great-partner-grand",
        "great-grandparent-partner",
        "grandparent",
        "great-family",
      ),
      relation("grand-parent", "grandparent", "parent", "grand-family"),
      relation(
        "grand-partner-parent",
        "grandparent-partner",
        "parent",
        "grand-family",
      ),
      relation("parent-home", "parent", "home", "parent-family"),
      relation(
        "parent-partner-home",
        "parent-partner",
        "home",
        "parent-family",
      ),
    ],
    continuations: [
      {
        id: "home-parents",
        personId: "home",
        direction: "parents",
        token: "home:parents",
      },
    ],
    familyContinuations: [],
    graphVersion: "version-9",
    permissionFingerprint: "permission-project-a",
  };
}

test("routed lineage keeps the complete great-great-grandparent to home path and removes side branches", () => {
  const graph = homeAncestorNeighborhood();
  const before = structuredClone(graph);

  const projection = buildRoutedHomeLineageProjection({
    graph,
    routedPersonId: "great-great-grandfather",
    homePersonId: "home",
  });

  assert.equal(projection.hasCompletePath, true);
  assert.deepEqual(projection.lineagePersonIds, [
    "grandparent",
    "great-grandparent",
    "great-great-grandfather",
    "home",
    "parent",
  ]);
  assert.deepEqual(projection.connectorPersonIds, [
    "grandparent-partner",
    "great-grandparent-partner",
    "parent-partner",
    "target-partner",
  ]);
  assert.deepEqual(ids(projection.graph.persons), [
    "grandparent",
    "grandparent-partner",
    "great-grandparent",
    "great-grandparent-partner",
    "great-great-grandfather",
    "home",
    "parent",
    "parent-partner",
    "target-partner",
  ]);
  assert.deepEqual(ids(projection.graph.parentChildRelations), [
    "grand-parent",
    "grand-partner-parent",
    "great-grand",
    "great-partner-grand",
    "parent-home",
    "parent-partner-home",
    "target-great",
    "target-partner-great",
  ]);
  assert.equal(projection.graph.persons.some(person => person.id === "side-child"), false);
  assert.equal(projection.graph.persons.some(person => person.id === "unrelated"), false);
  assert.equal(
    projection.graph.persons.some(person => person.id === "target-father"),
    false,
  );
  assert.deepEqual(projection.graph.continuations, []);
  assert.deepEqual(graph, before);
});

test("merging the narrow route lineage preserves the target neighborhood without changing the persisted home", () => {
  const loadedHomeAncestors = homeAncestorNeighborhood();
  const targetNeighborhood: FamilyGraphData = {
    persons: loadedHomeAncestors.persons.filter(person => [
      "target-father",
      "target-mother",
      "great-great-grandfather",
      "target-partner",
      "great-grandparent",
      "side-child",
    ].includes(person.id)),
    unions: loadedHomeAncestors.unions.filter(value => [
      "target-parents",
      "target-partnership",
      "target-line-family",
      "target-side-family",
    ].includes(value.id)),
    parentChildRelations: loadedHomeAncestors.parentChildRelations.filter(value => [
      "target-father-target",
      "target-mother-target",
      "target-great",
      "target-partner-great",
      "target-side",
      "target-partner-side",
    ].includes(value.id)),
    continuations: [],
    familyContinuations: [],
    graphVersion: "version-9",
    permissionFingerprint: "permission-project-a",
  };
  const projection = buildRoutedHomeLineageProjection({
    graph: loadedHomeAncestors,
    routedPersonId: "great-great-grandfather",
    homePersonId: "home",
  });
  const persistedHomePersonId = "home";

  const merged = mergeNeighborhood(targetNeighborhood, {
    ...projection.graph,
    continuations: projection.graph.continuations ?? [],
  });

  assert.equal(persistedHomePersonId, "home");
  assert.equal(merged.persons.some(person => person.id === persistedHomePersonId), true);
  assert.equal(merged.persons.some(person => person.id === "target-father"), true);
  assert.equal(merged.persons.some(person => person.id === "target-mother"), true);
  assert.deepEqual(
    merged.parentChildRelations
      .filter(value => value.parentId === "great-great-grandfather")
      .map(value => value.childId)
      .sort(),
    ["great-grandparent", "side-child"],
  );
  assert.deepEqual(
    [
      "great-great-grandfather",
      "great-grandparent",
      "grandparent",
      "parent",
      "home",
    ].filter(personId => !merged.persons.some(person => person.id === personId)),
    [],
  );
  assert.equal(merged.persons.some(person => person.id === "unrelated"), false);
  assert.equal(merged.graphVersion, "version-9");
  assert.equal(merged.permissionFingerprint, "permission-project-a");
});

test("production overlays one stable root closure after every perspective projection", () => {
  const production = readFileSync(
    new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    production,
    /const homeLineageOverlayActive\s*=\s*perspective\.kind !== "pedigree" \|\| focusPersonId !== homePersonId/,
  );
  assert.match(
    production,
    /const homeLineageNeighborhood = useFamilyTreeNeighborhood\(\{[\s\S]*?focusPersonId:\s*homePersonId,[\s\S]*?enabled:\s*homeLineageRequestEnabled,[\s\S]*?sessionKey:\s*homeLineageOverlayActive[\s\S]*?`home-lineage:\$\{entryPoint\.id\}:\$\{homePersonId\}`[\s\S]*?structuralOnly:\s*true,[\s\S]*?descendantDepth:\s*0,/,
  );
  assert.match(
    production,
    /const primaryGraphIsReady\s*=\s*!pedigreeNeighborhood\.loading[\s\S]*?!pedigreeNeighborhood\.error[\s\S]*?person\.id === focusPersonId/,
    "the root overlay must wait until the routed pedigree has loaded",
  );
  assert.match(
    production,
    /buildRootLineageProjection\(\{[\s\S]*?rootPersonId:\s*homePersonId,[\s\S]*?connectPersonId:\s*layoutFocusPersonId/,
  );
  assert.match(
    production,
    /lineageBridgePersonIds:\s*rootLineageProjection\.bridgePersonIds/,
    "every partnership on the structural bridge must remain traversable",
  );
  assert.match(
    production,
    /const perspectiveGraph = perspective\.kind === "pedigree"[\s\S]*?corridorProjection\?\.graph[\s\S]*?allDescendantsProjection\?\.graph[\s\S]*?const rootLineageSourceGraph[\s\S]*?const displayedGraphWithoutPhotos = useMemo\([\s\S]*?mergeRootLineageOverlay\([\s\S]*?perspectiveGraph,[\s\S]*?rootLineageProjection\.graph/,
  );
  assert.match(
    production,
    /const layoutFocusPersonId = perspective\.kind === "pedigree"\s*\? focusPersonId/,
  );
  assert.match(
    production,
    /onActiveContextChange\?\.\(\{[\s\S]*?rootPersonId:\s*selectedEntry\.rootPersonId/,
  );

  const homeOverlaySource = production.slice(
    production.indexOf("const homeLineageNeighborhood"),
    production.indexOf("const specialFocusPersonId"),
  );
  assert.doesNotMatch(
    homeOverlaySource,
    /sessionKey:[\s\S]*?focusPersonId/,
    "temporary focus changes must not restart the identical home request",
  );
  assert.match(
    production,
    /onClick=\{homeLineageNeighborhood\.reload\}/,
    "a failed root overlay must have an isolated retry action",
  );
  assert.doesNotMatch(
    production,
    /buildRoutedHomeLineageProjection\(/,
    "a directed ancestor-only corridor cannot be the source of global root fill",
  );
});
