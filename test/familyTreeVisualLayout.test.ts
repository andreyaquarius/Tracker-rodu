import test from "node:test";
import assert from "node:assert/strict";
import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
} from "../src/types/familyTree.ts";
import {
  buildVisualGridModel,
  calculateBounds,
  calculateTreeLayout,
  calculateTreeLayoutWithCache,
  calculateVisualBounds,
  createUnionNodes,
  familyTreeLayoutCacheKey,
  familyTreeLayoutProjectionSignature,
  normalizeVisualFamilyGraph,
  resolveGenerations,
} from "../src/utils/familyTreeVisualLayout.ts";

const baseGraph: FamilyTreeGraphDto = {
  projectId: "project",
  treeId: "tree",
  mode: "family",
  rootPersonId: "root",
  tree: null,
  availablePersons: [],
  nodes: [],
  occurrences: [],
  edges: [],
  groups: [],
  issues: [],
  stats: {
    persons: 0,
    occurrences: 0,
    edges: 0,
    groups: 0,
    issues: 0,
    repeatedPersons: 0,
    hiddenDisprovenEdges: 0,
  },
};

function node(personId: string, gender: string): FamilyTreeNodeDto {
  return {
    personId,
    displayName: personId,
    primaryName: null,
    names: [],
    events: [],
    gender,
    status: "proven",
    isLiving: false,
    privacyStatus: "private",
    redacted: false,
    occurrenceIds: [`${personId}:0`],
  };
}

function birthEvent(personId: string, eventDate: string): FamilyTreeNodeDto["events"][number] {
  return {
    id: `${personId}:birth`,
    projectId: "project",
    personId,
    eventType: "birth",
    title: "Birth",
    eventDate,
    dateFrom: "",
    dateTo: "",
    dateText: "",
    placeName: "",
    geo: null,
    eventRole: "primary",
    evidenceStatus: "proven",
    confidence: 100,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: "",
    updatedAt: "",
  };
}

function occurrence(
  id: string,
  personId: string,
  generation: number,
  path: string[] = ["root", personId],
): FamilyTreeOccurrenceDto {
  return {
    id,
    personId,
    mode: "family",
    path,
    generation,
    depth: Math.abs(generation),
    duplicateIndex: 0,
    isRepeated: false,
  };
}

function parentChildEdge(
  id: string,
  parentId: string,
  childId: string,
  familyGroupId: string,
  role: "father" | "mother",
  relationshipType = "biological",
): FamilyTreeEdgeDto {
  return {
    id,
    kind: "parent_child",
    relationshipId: id,
    fromPersonId: parentId,
    toPersonId: childId,
    fromOccurrenceId: `${parentId}:0`,
    toOccurrenceId: `${childId}:0`,
    relationshipType,
    parentRoleLabel: role,
    evidenceStatus: "proven",
    confidence: 100,
    isBloodline: relationshipType === "biological",
    parentSetId: `${familyGroupId}:parents`,
    familyGroupId,
    sourceDocumentId: null,
    sourceFindingId: null,
    style: {
      lineStyle: relationshipType === "adoptive" ? "dashed" : "solid",
      visibility: "visible",
    },
    metadata: {},
  };
}

function partnerEdge(id: string, firstId: string, secondId: string, familyGroupId: string): FamilyTreeEdgeDto {
  return {
    id,
    kind: "partner",
    relationshipId: id,
    fromPersonId: firstId,
    toPersonId: secondId,
    fromOccurrenceId: `${firstId}:0`,
    toOccurrenceId: `${secondId}:0`,
    relationshipType: "marriage",
    evidenceStatus: "proven",
    confidence: 100,
    parentSetId: null,
    familyGroupId,
    sourceDocumentId: null,
    sourceFindingId: null,
    style: {
      lineStyle: "solid",
      visibility: "visible",
    },
    metadata: {},
  };
}

function associationEdge(id: string, firstId: string, secondId: string): FamilyTreeEdgeDto {
  return {
    id,
    kind: "association",
    relationshipId: id,
    fromPersonId: firstId,
    toPersonId: secondId,
    fromOccurrenceId: `${firstId}:0`,
    toOccurrenceId: `${secondId}:0`,
    relationshipType: "godparent",
    evidenceStatus: "proven",
    confidence: 100,
    parentSetId: null,
    familyGroupId: null,
    sourceDocumentId: null,
    sourceFindingId: null,
    style: {
      lineStyle: "dotted",
      visibility: "visible",
    },
    metadata: {},
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function assertNoSameRowOverlaps(nodes: Array<{ occurrence: FamilyTreeOccurrenceDto; x: number; y: number; width: number; height: number }>) {
  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const left = nodes[leftIndex];
      const right = nodes[rightIndex];
      if (Math.abs(left.y - right.y) >= Math.min(left.height, right.height)) continue;
      assert.equal(
        left.x + left.width <= right.x || right.x + right.width <= left.x,
        true,
        `${left.occurrence.id} does not overlap ${right.occurrence.id}`,
      );
    }
  }
}

function visualGraph(): FamilyTreeGraphDto {
  return {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("secondPartner", "female"),
      node("halfSibling", "male"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("father:0", "father", -1),
      occurrence("mother:0", "mother", -1),
      occurrence("secondPartner:0", "secondPartner", -1),
      occurrence("halfSibling:0", "halfSibling", 0),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "family-root", "father"),
      parentChildEdge("mother-root", "mother", "root", "family-root", "mother"),
      partnerEdge("father-mother", "father", "mother", "family-root"),
      parentChildEdge("father-halfSibling", "father", "halfSibling", "family-half", "father"),
      parentChildEdge("secondPartner-halfSibling", "secondPartner", "halfSibling", "family-half", "mother"),
      partnerEdge("father-secondPartner", "father", "secondPartner", "family-half"),
    ],
  };
}

function directAncestorGraph(depth: number): FamilyTreeGraphDto {
  const nodes: FamilyTreeNodeDto[] = [];
  const occurrences: FamilyTreeOccurrenceDto[] = [];
  const edges: FamilyTreeEdgeDto[] = [];
  const seen = new Set<string>();
  const pathByPerson = new Map<string, string[]>([["root", ["root"]]]);
  const generationByPerson = new Map<string, number>([["root", 0]]);
  const queue = ["root"];

  function addPerson(personId: string, gender: string, generation: number, path: string[]) {
    if (seen.has(personId)) return;
    seen.add(personId);
    nodes.push(node(personId, gender));
    occurrences.push(occurrence(`${personId}:0`, personId, generation, path));
  }

  addPerson("root", "male", 0, ["root"]);

  for (let level = 0; level < depth; level += 1) {
    const levelCount = queue.length;
    for (let index = 0; index < levelCount; index += 1) {
      const childId = queue.shift();
      if (!childId) continue;
      const childPath = pathByPerson.get(childId) ?? ["root", childId];
      const childGeneration = generationByPerson.get(childId) ?? 0;
      const fatherId = `${childId}F`;
      const motherId = `${childId}M`;
      const fatherPath = [...childPath, fatherId];
      const motherPath = [...childPath, motherId];
      const parentGeneration = childGeneration - 1;
      const familyGroupId = `family-${childId}`;

      pathByPerson.set(fatherId, fatherPath);
      pathByPerson.set(motherId, motherPath);
      generationByPerson.set(fatherId, parentGeneration);
      generationByPerson.set(motherId, parentGeneration);
      addPerson(fatherId, "male", parentGeneration, fatherPath);
      addPerson(motherId, "female", parentGeneration, motherPath);
      edges.push(parentChildEdge(`${fatherId}-${childId}`, fatherId, childId, familyGroupId, "father"));
      edges.push(parentChildEdge(`${motherId}-${childId}`, motherId, childId, familyGroupId, "mother"));
      edges.push(partnerEdge(`${fatherId}-${motherId}`, fatherId, motherId, familyGroupId));
      queue.push(fatherId, motherId);
    }
  }

  return {
    ...baseGraph,
    nodes,
    occurrences,
    edges,
  };
}

function addExpandedSiblingFamily(
  graph: FamilyTreeGraphDto,
  anchorId: string,
  siblingId: string,
  partnerId: string,
  childPrefix: string,
  childrenCount: number,
) {
  const anchorParentFamily = `family-${anchorId}`;
  const fatherId = `${anchorId}F`;
  const motherId = `${anchorId}M`;
  graph.nodes.push(node(siblingId, "male"), node(partnerId, "female"));
  graph.occurrences.push(
    occurrence(`${siblingId}:0`, siblingId, (graph.occurrences.find((item) => item.personId === anchorId)?.generation ?? 0), [
      "root",
      anchorId,
      siblingId,
    ]),
    occurrence(`${partnerId}:0`, partnerId, (graph.occurrences.find((item) => item.personId === anchorId)?.generation ?? 0), [
      "root",
      anchorId,
      siblingId,
      partnerId,
    ]),
  );
  graph.edges.push(
    parentChildEdge(`${fatherId}-${siblingId}`, fatherId, siblingId, anchorParentFamily, "father"),
    parentChildEdge(`${motherId}-${siblingId}`, motherId, siblingId, anchorParentFamily, "mother"),
    partnerEdge(`${siblingId}-${partnerId}`, siblingId, partnerId, `family-${siblingId}`),
  );

  for (let index = 0; index < childrenCount; index += 1) {
    const childId = `${childPrefix}${index + 1}`;
    const childGeneration = (graph.occurrences.find((item) => item.personId === anchorId)?.generation ?? 0) + 1;
    graph.nodes.push(node(childId, index % 2 === 0 ? "male" : "female"));
    graph.occurrences.push(occurrence(`${childId}:0`, childId, childGeneration, ["root", anchorId, siblingId, childId]));
    graph.edges.push(
      parentChildEdge(`${siblingId}-${childId}`, siblingId, childId, `family-${siblingId}`, "father"),
      parentChildEdge(`${partnerId}-${childId}`, partnerId, childId, `family-${siblingId}`, "mother"),
    );
  }
}

test("visual layout keeps partners on one generation and siblings on one generation", () => {
  const layout = calculateTreeLayout(visualGraph(), {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));

  assert.equal(nodeById.get("father:0")?.y, nodeById.get("mother:0")?.y);
  assert.equal(nodeById.get("father:0")?.y, nodeById.get("secondPartner:0")?.y);
  assert.equal(nodeById.get("root:0")?.y, nodeById.get("halfSibling:0")?.y);
  assert.equal(resolveGenerations(layout).get(0)?.map((item) => item.occurrence.id).sort().join(","), "halfSibling:0,root:0");
});

test("visual layout uses block-grid as the primary algorithm even with association edges", () => {
  const graph = {
    ...visualGraph(),
    nodes: [
      ...visualGraph().nodes,
      node("godparent", "male"),
    ],
    occurrences: [
      ...visualGraph().occurrences,
      occurrence("godparent:0", "godparent", 0, ["root", "godparent"]),
    ],
    edges: [
      ...visualGraph().edges,
      associationEdge("root-godparent", "root", "godparent"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const grid = buildVisualGridModel(graph, layout);

  assert.equal(layout.nodes.some((item) => item.occurrence.id === "godparent:0"), true);
  assert.equal(layout.edges.some((item) => item.edge.id === "root-godparent"), true);
  assert.equal(grid.blocks.some((block) => block.kind === "person" && block.occurrenceId === "godparent:0"), true);
});

test("visual layout uses compact defaults for the editable tree workspace", () => {
  const layout = calculateTreeLayout(visualGraph());
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  const father = nodeById.get("father:0");
  const mother = nodeById.get("mother:0");

  assert.ok(root);
  assert.ok(father);
  assert.ok(mother);
  assert.equal(root.width, 180);
  assert.equal(root.height, 88);
  assert.equal(father.y, -132);
  assert.equal(mother.y, -132);
  assert.equal(father.x + father.width <= mother.x, true);
  assert.equal(mother.x - (father.x + father.width) <= 50, true);
});

test("visual bounds include visually enlarged cards for fit-to-screen", () => {
  const layout = calculateTreeLayout(visualGraph(), {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const raw = calculateVisualBounds(layout, 1);
  const visual = calculateVisualBounds(layout, 2);

  assert.equal(visual.minX < raw.minX, true);
  assert.equal(visual.maxX > raw.maxX, true);
  assert.equal(visual.minY < raw.minY, true);
  assert.equal(visual.maxY > raw.maxY, true);
  assert.equal(visual.width > raw.width, true);
  assert.equal(visual.height > raw.height, true);
});

test("visual layout creates separate union anchors for children of different partners", () => {
  const layout = calculateTreeLayout(visualGraph(), {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const unions = createUnionNodes(layout);
  const rootUnion = unions.find((unit) => unit.childOccurrenceIds.includes("root:0"));
  const siblingUnion = unions.find((unit) => unit.childOccurrenceIds.includes("halfSibling:0"));

  assert.ok(rootUnion);
  assert.ok(siblingUnion);
  assert.notEqual(rootUnion.id, siblingUnion.id);
  assert.deepEqual(rootUnion.parentOccurrenceIds.sort(), ["father:0", "mother:0"]);
  assert.deepEqual(siblingUnion.parentOccurrenceIds.sort(), ["father:0", "secondPartner:0"]);
});

test("visual layout routes family unit edges as orthogonal trunk lines outside person cards", () => {
  const layout = calculateTreeLayout(visualGraph(), {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });

  assert.equal(layout.familyUnits.length, 2);
  for (const unit of layout.familyUnits) {
    const parentTop = Math.min(...unit.parents.map((parent) => parent.y));
    const parentBottom = Math.max(...unit.parents.map((parent) => parent.y + parent.height));
    const childTop = Math.min(...unit.children.map((child) => child.y));
    assert.match(unit.path, /[HVQ]/);
    assert.doesNotMatch(unit.path, /C/);
    assert.equal(unit.parentBusY > parentTop, true);
    assert.equal(unit.parentBusY < parentBottom, true);
    assert.equal(unit.childBusY < childTop, true);
  }
});

test("visual layout is stable across repeated calculations", () => {
  const graph = visualGraph();
  const first = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const second = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const firstCoordinates = first.nodes.map((node) => [node.occurrence.id, node.x, node.y]);
  const secondCoordinates = second.nodes.map((node) => [node.occurrence.id, node.x, node.y]);

  assert.deepEqual(firstCoordinates, secondCoordinates);
  assert.deepEqual(calculateBounds(first), calculateBounds(second));
});

test("visual layout cache restores persisted coordinates without rebuilding the projection", () => {
  const graph = visualGraph();
  const storage = memoryStorage();
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const first = calculateTreeLayoutWithCache(graph, options, { storage });
  const signature = familyTreeLayoutProjectionSignature(graph, options);
  const key = familyTreeLayoutCacheKey(graph, signature);
  const cached = JSON.parse(storage.getItem(key) ?? "{}") as {
    nodes: Array<{ occurrenceId: string; x: number }>;
  };
  const rootProjection = cached.nodes.find((node) => node.occurrenceId === "root:0");
  assert.ok(rootProjection);
  rootProjection.x += 37;
  storage.setItem(key, JSON.stringify(cached));

  const second = calculateTreeLayoutWithCache(graph, options, { storage });
  const firstRoot = first.nodes.find((node) => node.occurrence.id === "root:0");
  const secondRoot = second.nodes.find((node) => node.occurrence.id === "root:0");
  assert.ok(firstRoot);
  assert.ok(secondRoot);
  assert.equal(secondRoot.x, firstRoot.x + 37);
});

test("visual layout cache ignores stale layout versions after algorithm changes", () => {
  const graph = visualGraph();
  const storage = memoryStorage();
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const signature = familyTreeLayoutProjectionSignature(graph, options);
  const key = familyTreeLayoutCacheKey(graph, signature);
  storage.setItem(key, JSON.stringify({
    version: 17,
    signature,
    rootOccurrenceId: "root:0",
    nodes: graph.occurrences.map((occurrence) => ({
      occurrenceId: occurrence.id,
      x: occurrence.id === "root:0" ? 9999 : 0,
      y: 0,
      width: 100,
      height: 50,
    })),
  }));

  const layout = calculateTreeLayoutWithCache(graph, options, { storage });
  const root = layout.nodes.find((node) => node.occurrence.id === "root:0");
  assert.ok(root);
  assert.notEqual(root.x, 9999);
  const refreshed = JSON.parse(storage.getItem(key) ?? "{}") as { version?: number };
  assert.equal(refreshed.version, 18);
});

test("visual layout cache replaces old signatures instead of accumulating them", () => {
  const graph = visualGraph();
  const storage = memoryStorage();
  const firstOptions = { nodeWidth: 100, nodeHeight: 50, horizontalSpacing: 180 };
  const secondOptions = { ...firstOptions, horizontalSpacing: 220 };
  const firstSignature = familyTreeLayoutProjectionSignature(graph, firstOptions);
  const currentKey = familyTreeLayoutCacheKey(graph, firstSignature);
  const legacySignatureKey = `${currentKey}:${firstSignature}`;
  storage.setItem(legacySignatureKey, "legacy projection");
  storage.setItem("family-tree-layout:other-tree:root:ancestors:signature", "keep another tree");

  calculateTreeLayoutWithCache(graph, firstOptions, { storage });
  calculateTreeLayoutWithCache(graph, secondOptions, { storage });

  assert.equal(storage.getItem(legacySignatureKey), null);
  assert.ok(storage.getItem(currentKey));
  assert.ok(storage.getItem("family-tree-layout:other-tree:root:ancestors:signature"));
  const cached = JSON.parse(storage.getItem(currentKey) ?? "{}") as { signature?: string };
  assert.equal(cached.signature, familyTreeLayoutProjectionSignature(graph, secondOptions));
  assert.equal(storage.length, 2);
});

test("visual layout calculation still succeeds when cache storage is full", () => {
  const graph = visualGraph();
  const storage = memoryStorage();
  storage.setItem = () => {
    throw new DOMException("quota", "QuotaExceededError");
  };

  const layout = calculateTreeLayoutWithCache(graph, {}, { storage });

  assert.ok(layout.nodes.length > 0);
});

test("generation depth recalculates a compact direct-ancestor layout with fixed partner gaps", () => {
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const fourGenerations = calculateTreeLayout(directAncestorGraph(4), options);
  const sevenGenerations = calculateTreeLayout(directAncestorGraph(7), options);
  const fourBounds = calculateBounds(fourGenerations);
  const sevenBounds = calculateBounds(sevenGenerations);

  assert.equal(fourBounds.width < sevenBounds.width, true, "shallower generation view is recalculated as a narrower tree");

  const pairGaps = fourGenerations.familyUnits
    .filter((unit) => unit.parents.length === 2 && unit.children.length > 0)
    .map((unit) => {
      const parents = [...unit.parents].sort((left, right) => left.x - right.x);
      return parents[1].x - (parents[0].x + parents[0].width);
    });
  assert.equal(pairGaps.length > 0, true, "direct ancestor pairs are present");
  const expectedGap = pairGaps[0];
  for (const gap of pairGaps) {
    assert.equal(Math.abs(gap - expectedGap) <= 0.001, true, "partner pair gap stays fixed across generations");
  }
});

test("direct ancestor layout uses the manual block slot template instead of a binary grid", () => {
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const layout = calculateTreeLayout(directAncestorGraph(4), options);
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const scale = (options.nodeWidth + 28) / (180 + 28);
  const expected = new Map([
    ["rootFF:0", -1768.5 * scale],
    ["rootFM:0", -1560.5 * scale],
    ["rootMF:0", 906.3 * scale],
    ["rootMM:0", 1114.3 * scale],
    ["rootFFF:0", -2773.3 * scale],
    ["rootFFM:0", -2565.3 * scale],
    ["rootFMF:0", -940.9 * scale],
    ["rootFMM:0", -732.9 * scale],
    ["rootMFF:0", 592.7 * scale],
    ["rootMFM:0", 800.7 * scale],
    ["rootMMF:0", 1634.9 * scale],
    ["rootMMM:0", 1842.9 * scale],
  ]);

  for (const [id, expectedX] of expected.entries()) {
    const item = nodeById.get(id);
    assert.ok(item, `${id} is visible`);
    assert.equal(Math.abs(item.x - expectedX) <= 0.1, true, `${id} uses template x`);
  }

  const father = nodeById.get("rootF:0");
  const mother = nodeById.get("rootM:0");
  assert.ok(father);
  assert.ok(mother);
  assert.equal(mother.x - (father.x + father.width), 28);
});

test("direct ancestor slot template continues recursively past the provided four-generation sample", () => {
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const layout = calculateTreeLayout(directAncestorGraph(6), options);
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  assert.ok(root);
  const rootCenter = root.x + root.width / 2;

  for (const suffix of ["FFFF", "FFFM", "FFMF", "FFMM", "FMFF", "FMFM", "FMMF", "FMMM"]) {
    const father = nodeById.get(`root${suffix}F:0`);
    const mother = nodeById.get(`root${suffix}M:0`);
    assert.ok(father, `${suffix} father exists`);
    assert.ok(mother, `${suffix} mother exists`);
    assert.equal(Math.abs(mother.x - (father.x + father.width) - 28) <= 0.001, true, `${suffix} parent pair stays fixed`);
    assert.equal(mother.x + mother.width < rootCenter, true, `${suffix} remains inside paternal half`);
  }

  for (const suffix of ["MFFF", "MFFM", "MFMF", "MFMM", "MMFF", "MMFM", "MMMF", "MMMM"]) {
    const father = nodeById.get(`root${suffix}F:0`);
    const mother = nodeById.get(`root${suffix}M:0`);
    assert.ok(father, `${suffix} father exists`);
    assert.ok(mother, `${suffix} mother exists`);
    assert.equal(Math.abs(mother.x - (father.x + father.width) - 28) <= 0.001, true, `${suffix} parent pair stays fixed`);
    assert.equal(father.x >= rootCenter, true, `${suffix} remains inside maternal half`);
  }
});

test("grid layout normalizes family units and spouse family indexes", () => {
  const graph = visualGraph();
  const normalized = normalizeVisualFamilyGraph(graph);

  assert.equal(normalized.peopleById.size, 5);
  assert.equal(normalized.parentChildRelations.length, 4);
  assert.equal(normalized.partnerRelations.length, 2);
  assert.equal(normalized.familyUnits.length, 2);
  assert.deepEqual(
    normalized.parentFamilyByChild.get("root:0")?.parentOccurrenceIds,
    ["father:0", "mother:0"],
  );
  assert.deepEqual(
    normalized.spouseFamiliesByPerson.get("father:0")?.map((unit) => unit.childOccurrenceIds.join(",")),
    ["halfSibling:0", "root:0"],
  );
});

test("grid layout exposes person and union blocks on generation rows", () => {
  const graph = visualGraph();
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const grid = buildVisualGridModel(graph, layout);
  const personBlocks = grid.blocks.filter((block) => block.kind === "person");
  const unionBlocks = grid.blocks.filter((block) => block.kind === "union");

  assert.equal(personBlocks.length, layout.nodes.length);
  assert.equal(unionBlocks.length, layout.familyUnits.length);
  assert.equal(new Set(personBlocks.map((block) => block.occurrenceId)).size, personBlocks.length);
  assert.equal(personBlocks.find((block) => block.occurrenceId === "root:0")?.row, 0);
  assert.equal(personBlocks.find((block) => block.occurrenceId === "father:0")?.row, -1);
  assert.equal(personBlocks.find((block) => block.occurrenceId === "mother:0")?.row, -1);
});

test("grid layout keeps child axis under family unit center", () => {
  const graph = visualGraph();
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((node) => [node.occurrence.id, node]));
  const root = nodeById.get("root:0");
  const rootUnion = layout.familyUnits.find((unit) => unit.childOccurrenceIds.includes("root:0"));

  assert.ok(root);
  assert.ok(rootUnion);
  assert.equal(rootUnion.parents[0].x + rootUnion.parents[0].width / 2 < root.x + root.width / 2, true);
  assert.equal(root.x + root.width / 2 < rootUnion.parents[1].x + rootUnion.parents[1].width / 2, true);
  assert.equal(Math.abs(rootUnion.unitX - (root.x + root.width / 2)) < 0.001, true);
});

test("grid layout creates parent placeholder blocks for a person without parents", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [node("root", "male")],
    occurrences: [occurrence("root:0", "root", 0, ["root"])],
    edges: [],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const grid = buildVisualGridModel(graph, layout);
  const father = layout.placeholders?.find((placeholder) => placeholder.action === "add_father");
  const mother = layout.placeholders?.find((placeholder) => placeholder.action === "add_mother");
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");

  assert.ok(root);
  assert.ok(father);
  assert.ok(mother);
  assert.equal(father.row, -1);
  assert.equal(mother.row, -1);
  assert.equal(father.x + father.width < root.x + root.width / 2, true);
  assert.equal(root.x + root.width / 2 < mother.x, true);
  assert.match(father.connectionPath ?? "", /[HV]/);
  assert.match(mother.connectionPath ?? "", /[HV]/);
  assert.equal(grid.blocks.some((block) => block.kind === "placeholder" && block.placeholderId === father.id), true);
  assert.equal(layout.minY <= father.y - 20, true);
});

test("grid layout keeps partner and child actions inside the compact plus menu", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [node("root", "male")],
    occurrences: [occurrence("root:0", "root", 0, ["root"])],
    edges: [],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");
  const partner = layout.placeholders?.find((placeholder) => placeholder.action === "add_partner");
  const child = layout.placeholders?.find((placeholder) => placeholder.action === "add_child");
  const menu = layout.placeholders?.find((placeholder) => placeholder.action === "open_menu");

  assert.ok(root);
  assert.equal(partner, undefined);
  assert.equal(child, undefined);
  assert.ok(menu);
  assert.equal(menu.targetOccurrenceId, root.occurrence.id);
  assert.equal(menu.row, root.occurrence.generation);
});

test("grid layout sorts children by birth date before id fallback", () => {
  const older = {
    ...node("zOlder", "female"),
    events: [birthEvent("zOlder", "1985")],
  };
  const younger = {
    ...node("aYounger", "male"),
    events: [birthEvent("aYounger", "1990")],
  };
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("father", "male"),
      node("mother", "female"),
      older,
      younger,
    ],
    occurrences: [
      occurrence("father:0", "father", 0, ["father"]),
      occurrence("mother:0", "mother", 0, ["mother"]),
      occurrence("zOlder:0", "zOlder", 1, ["father", "zOlder"]),
      occurrence("aYounger:0", "aYounger", 1, ["father", "aYounger"]),
    ],
    edges: [
      parentChildEdge("father-younger", "father", "aYounger", "parents", "father"),
      parentChildEdge("mother-younger", "mother", "aYounger", "parents", "mother"),
      parentChildEdge("father-older", "father", "zOlder", "parents", "father"),
      parentChildEdge("mother-older", "mother", "zOlder", "parents", "mother"),
      partnerEdge("father-mother", "father", "mother", "parents"),
    ],
  };

  const normalized = normalizeVisualFamilyGraph(graph);
  assert.deepEqual(normalized.familyUnits[0]?.childOccurrenceIds, ["zOlder:0", "aYounger:0"]);
});

test("grid layout keeps placeholder blocks from overlapping in the same row", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("sibling", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("sibling:0", "sibling", 0, ["root", "sibling"]),
    ],
    edges: [],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 120,
    verticalSpacing: 100,
    padding: 20,
  });
  const rows = new Map<number, NonNullable<typeof layout.placeholders>>();
  for (const placeholder of layout.placeholders ?? []) {
    const row = rows.get(placeholder.row) ?? [];
    row.push(placeholder);
    rows.set(placeholder.row, row);
  }
  for (const row of rows.values()) {
    const sorted = [...row].sort((left, right) => left.x - right.x);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.equal(sorted[index].x >= sorted[index - 1].x + sorted[index - 1].width, true);
    }
  }
});

test("grid layout keeps a single known mother on the maternal side of the child axis", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("mother", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
    ],
    edges: [
      parentChildEdge("mother-root", "mother", "root", "family-root", "mother"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const root = layout.nodes.find((item) => item.occurrence.id === "root:0");
  const mother = layout.nodes.find((item) => item.occurrence.id === "mother:0");

  assert.ok(root);
  assert.ok(mother);
  assert.equal(mother.y < root.y, true);
  assert.equal(root.x + root.width / 2 < mother.x + mother.width / 2, true);
});

test("grid layout places missing parent placeholder beside the known parent", () => {
  const motherOnlyGraph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("mother", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
    ],
    edges: [
      parentChildEdge("mother-root", "mother", "root", "family-root", "mother"),
    ],
  };
  const fatherOnlyGraph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("father:0", "father", -1, ["root", "father"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "family-root", "father"),
    ],
  };
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };

  const motherOnlyLayout = calculateTreeLayout(motherOnlyGraph, options);
  const mother = motherOnlyLayout.nodes.find((item) => item.occurrence.id === "mother:0");
  const addFather = motherOnlyLayout.placeholders?.find((placeholder) =>
    placeholder.action === "add_father" &&
    placeholder.targetOccurrenceId === "root:0"
  );
  assert.ok(mother);
  assert.ok(addFather);
  assert.equal(addFather.y < mother.y + mother.height && addFather.y + addFather.height > mother.y, true);
  assert.equal(addFather.x + addFather.width <= mother.x, true);

  const fatherOnlyLayout = calculateTreeLayout(fatherOnlyGraph, options);
  const father = fatherOnlyLayout.nodes.find((item) => item.occurrence.id === "father:0");
  const addMother = fatherOnlyLayout.placeholders?.find((placeholder) =>
    placeholder.action === "add_mother" &&
    placeholder.targetOccurrenceId === "root:0"
  );
  assert.ok(father);
  assert.ok(addMother);
  assert.equal(addMother.y < father.y + father.height && addMother.y + addMother.height > father.y, true);
  assert.equal(father.x + father.width <= addMother.x, true);

  const ukrainianFatherOnlyGraph: FamilyTreeGraphDto = {
    ...fatherOnlyGraph,
    edges: [
      {
        ...parentChildEdge("father-root", "father", "root", "family-root", "father"),
        parentRoleLabel: "\u0431\u0430\u0442\u044c\u043a\u043e",
      },
    ],
  };
  const ukrainianFatherOnlyLayout = calculateTreeLayout(ukrainianFatherOnlyGraph, options);
  const ukrainianFather = ukrainianFatherOnlyLayout.nodes.find((item) => item.occurrence.id === "father:0");
  const ukrainianAddMother = ukrainianFatherOnlyLayout.placeholders?.find((placeholder) =>
    placeholder.action === "add_mother" &&
    placeholder.targetOccurrenceId === "root:0"
  );
  assert.ok(ukrainianFather);
  assert.ok(ukrainianAddMother);
  assert.equal(ukrainianAddMother.y < ukrainianFather.y + ukrainianFather.height && ukrainianAddMother.y + ukrainianAddMother.height > ukrainianFather.y, true);
  assert.equal(ukrainianFather.x + ukrainianFather.width <= ukrainianAddMother.x, true);
  assert.match(ukrainianAddMother.connectionPath ?? "", /[HV]/);
});

test("grid layout aligns parent placeholders that belong to the same generation row", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("paternalGrandfather", "male"),
      node("maternalGrandmother", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("father:0", "father", -1, ["root", "father"]),
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, ["root", "father", "paternalGrandfather"]),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, ["root", "mother", "maternalGrandmother"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "family-root", "father"),
      parentChildEdge("mother-root", "mother", "root", "family-root", "mother"),
      {
        ...parentChildEdge("paternal-grandfather-father", "paternalGrandfather", "father", "family-father", "father"),
        parentRoleLabel: "\u0431\u0430\u0442\u044c\u043a\u043e",
      },
      {
        ...parentChildEdge("maternal-grandmother-mother", "maternalGrandmother", "mother", "family-mother", "mother"),
        parentRoleLabel: "\u043c\u0430\u0442\u0438",
      },
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const addMotherForFather = layout.placeholders?.find((placeholder) =>
    placeholder.action === "add_mother" &&
    placeholder.targetOccurrenceId === "father:0"
  );
  const addFatherForMother = layout.placeholders?.find((placeholder) =>
    placeholder.action === "add_father" &&
    placeholder.targetOccurrenceId === "mother:0"
  );

  assert.ok(addMotherForFather);
  assert.ok(addFatherForMother);
  assert.equal(addMotherForFather.row, addFatherForMother.row);
  assert.equal(addMotherForFather.y, addFatherForMother.y);
  assert.match(addMotherForFather.connectionPath ?? "", /[HV]/);
  assert.match(addFatherForMother.connectionPath ?? "", /[HV]/);
});

test("grid layout places focus partner beside root and children below their union", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("partner", "female"),
      node("olderChild", "female"),
      node("youngerChild", "male"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("partner:0", "partner", 0, ["root", "partner"]),
      occurrence("olderChild:0", "olderChild", 1, ["root", "olderChild"]),
      occurrence("youngerChild:0", "youngerChild", 1, ["root", "youngerChild"]),
    ],
    edges: [
      partnerEdge("root-partner", "root", "partner", "family-root"),
      parentChildEdge("root-older", "root", "olderChild", "family-root", "father"),
      parentChildEdge("partner-older", "partner", "olderChild", "family-root", "mother"),
      parentChildEdge("root-younger", "root", "youngerChild", "family-root", "father"),
      parentChildEdge("partner-younger", "partner", "youngerChild", "family-root", "mother"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  const partner = nodeById.get("partner:0");
  const olderChild = nodeById.get("olderChild:0");
  const youngerChild = nodeById.get("youngerChild:0");
  const union = layout.familyUnits.find((item) => item.childOccurrenceIds.includes("olderChild:0"));

  assert.ok(root);
  assert.ok(partner);
  assert.ok(olderChild);
  assert.ok(youngerChild);
  assert.ok(union);
  assert.equal(partner.y, root.y);
  assert.equal(partner.x > root.x, true);
  assert.equal(olderChild.y > root.y, true);
  assert.equal(youngerChild.y, olderChild.y);
  assert.equal(olderChild.x + olderChild.width <= youngerChild.x, true);
  assert.equal(olderChild.x + olderChild.width / 2 < union.unitX, true);
  assert.equal(union.unitX < youngerChild.x + youngerChild.width / 2, true);
});

test("grid layout places a newly added child under its own non-primary parent union", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("primaryPartner", "female"),
      node("secondPartner", "female"),
      node("primaryChildOne", "male"),
      node("primaryChildTwo", "female"),
      node("newSecondFamilyChild", "male"),
    ],
    occurrences: [
      { ...occurrence("root:0", "root", 0, ["root"]), sideBranchesExpanded: true },
      occurrence("primaryPartner:0", "primaryPartner", 0, ["root", "primaryPartner"]),
      occurrence("secondPartner:0", "secondPartner", 0, ["root", "secondPartner"]),
      occurrence("primaryChildOne:0", "primaryChildOne", 1, ["root", "primaryChildOne"]),
      occurrence("primaryChildTwo:0", "primaryChildTwo", 1, ["root", "primaryChildTwo"]),
      occurrence("newSecondFamilyChild:0", "newSecondFamilyChild", 1, ["root", "secondPartner", "newSecondFamilyChild"]),
    ],
    edges: [
      partnerEdge("root-primary", "root", "primaryPartner", "primary-family"),
      parentChildEdge("root-primary-one", "root", "primaryChildOne", "primary-family", "father"),
      parentChildEdge("primary-partner-one", "primaryPartner", "primaryChildOne", "primary-family", "mother"),
      parentChildEdge("root-primary-two", "root", "primaryChildTwo", "primary-family", "father"),
      parentChildEdge("primary-partner-two", "primaryPartner", "primaryChildTwo", "primary-family", "mother"),
      partnerEdge("root-second", "root", "secondPartner", "second-family"),
      parentChildEdge("root-second-child", "root", "newSecondFamilyChild", "second-family", "father"),
      parentChildEdge("second-partner-child", "secondPartner", "newSecondFamilyChild", "second-family", "mother"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item, `${id} exists`);
    return item.x + item.width / 2;
  };
  const root = nodeById.get("root:0");
  const secondPartner = nodeById.get("secondPartner:0");
  const newChild = nodeById.get("newSecondFamilyChild:0");
  const primaryChildOne = nodeById.get("primaryChildOne:0");
  const primaryChildTwo = nodeById.get("primaryChildTwo:0");
  assert.ok(root);
  assert.ok(secondPartner);
  assert.ok(newChild);
  assert.ok(primaryChildOne);
  assert.ok(primaryChildTwo);

  const secondUnionCenter = (center("root:0") + center("secondPartner:0")) / 2;
  const primaryChildrenCenter = (center("primaryChildOne:0") + center("primaryChildTwo:0")) / 2;

  assert.equal(newChild.y, primaryChildOne.y);
  assert.equal(
    Math.abs(center("newSecondFamilyChild:0") - secondUnionCenter) <
      Math.abs(center("newSecondFamilyChild:0") - primaryChildrenCenter),
    true,
    "new child stays with the second partner union instead of the generic fallback row",
  );
  assert.equal(Math.abs(center("newSecondFamilyChild:0") - secondUnionCenter) <= 20, true);
  assertNoSameRowOverlaps(layout.nodes);
});

test("grid layout splits leaked technical family groups by actual visible parents", () => {
  const leakedParentChild = (
    id: string,
    parentId: string,
    childId: string,
    role: "father" | "mother",
  ) => ({
    ...parentChildEdge(id, parentId, childId, "leaked-family", role),
    parentSetId: null,
    familyGroupId: "leaked-family",
  });
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("uncle", "male"),
      node("unclePartner", "female"),
      node("cousin", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      { ...occurrence("father:0", "father", -1, ["root", "father"]), sideBranchesExpanded: true },
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
      occurrence("uncle:0", "uncle", -1, ["root", "father", "uncle"]),
      occurrence("unclePartner:0", "unclePartner", -1, ["root", "father", "uncle", "unclePartner"]),
      occurrence("cousin:0", "cousin", 0, ["root", "father", "uncle", "cousin"]),
    ],
    edges: [
      leakedParentChild("father-root", "father", "root", "father"),
      leakedParentChild("mother-root", "mother", "root", "mother"),
      partnerEdge("father-mother", "father", "mother", "root-family"),
      partnerEdge("uncle-partner", "uncle", "unclePartner", "uncle-family"),
      leakedParentChild("uncle-cousin", "uncle", "cousin", "father"),
      leakedParentChild("uncle-partner-cousin", "unclePartner", "cousin", "mother"),
    ],
  };
  const normalized = normalizeVisualFamilyGraph(graph);
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item, `${id} exists`);
    return item.x + item.width / 2;
  };
  const rootFamily = normalized.parentFamilyByChild.get("root:0");
  const cousinFamily = normalized.parentFamilyByChild.get("cousin:0");
  assert.ok(rootFamily);
  assert.ok(cousinFamily);
  assert.notEqual(rootFamily.key, cousinFamily.key);
  assert.deepEqual(rootFamily.parentOccurrenceIds, ["father:0", "mother:0"]);
  assert.deepEqual(cousinFamily.parentOccurrenceIds, ["uncle:0", "unclePartner:0"]);

  const cousinUnionCenter = (center("uncle:0") + center("unclePartner:0")) / 2;
  const rootUnionCenter = (center("father:0") + center("mother:0")) / 2;
  assert.equal(
    Math.abs(center("cousin:0") - cousinUnionCenter) <
      Math.abs(center("cousin:0") - rootUnionCenter),
    true,
    "cousin stays under uncle's family instead of a leaked root-family bus",
  );
  assertNoSameRowOverlaps(layout.nodes);
});

test("grid layout keeps a grandparent focus family block from mixing partners, children and siblings", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "grandmother",
    nodes: [
      node("grandmother", "female"),
      node("grandfather", "male"),
      node("extraPartner", "male"),
      node("father", "male"),
      node("aunt", "female"),
      node("fatherPartner", "female"),
      node("auntPartner", "male"),
      node("root", "male"),
      node("cousin", "male"),
      node("greatGrandfather", "male"),
      node("greatGrandmother", "female"),
      node("grandmotherSibling", "female"),
      node("siblingPartner", "male"),
      node("siblingChild", "female"),
    ],
    occurrences: [
      { ...occurrence("grandmother:0", "grandmother", 0, ["grandmother"]), sideBranchesExpanded: true },
      occurrence("grandfather:0", "grandfather", 0, ["grandmother", "grandfather"]),
      occurrence("extraPartner:0", "extraPartner", 0, ["grandmother", "extraPartner"]),
      occurrence("father:0", "father", 1, ["grandmother", "father"]),
      occurrence("aunt:0", "aunt", 1, ["grandmother", "aunt"]),
      occurrence("fatherPartner:0", "fatherPartner", 1, ["grandmother", "father", "fatherPartner"]),
      occurrence("auntPartner:0", "auntPartner", 1, ["grandmother", "aunt", "auntPartner"]),
      occurrence("root:0", "root", 2, ["grandmother", "father", "root"]),
      occurrence("cousin:0", "cousin", 2, ["grandmother", "aunt", "cousin"]),
      occurrence("greatGrandfather:0", "greatGrandfather", -1, ["grandmother", "greatGrandfather"]),
      occurrence("greatGrandmother:0", "greatGrandmother", -1, ["grandmother", "greatGrandmother"]),
      occurrence("grandmotherSibling:0", "grandmotherSibling", 0, ["grandmother", "grandmotherSibling"]),
      occurrence("siblingPartner:0", "siblingPartner", 0, ["grandmother", "grandmotherSibling", "siblingPartner"]),
      occurrence("siblingChild:0", "siblingChild", 1, ["grandmother", "grandmotherSibling", "siblingChild"]),
    ],
    edges: [
      parentChildEdge("greatGrandfather-grandmother", "greatGrandfather", "grandmother", "grandmother-parents", "father"),
      parentChildEdge("greatGrandmother-grandmother", "greatGrandmother", "grandmother", "grandmother-parents", "mother"),
      parentChildEdge("greatGrandfather-grandmotherSibling", "greatGrandfather", "grandmotherSibling", "grandmother-parents", "father"),
      parentChildEdge("greatGrandmother-grandmotherSibling", "greatGrandmother", "grandmotherSibling", "grandmother-parents", "mother"),
      partnerEdge("greatGrandfather-greatGrandmother", "greatGrandfather", "greatGrandmother", "grandmother-parents"),
      partnerEdge("grandmother-grandfather", "grandmother", "grandfather", "grandmother-family"),
      partnerEdge("grandmother-extraPartner", "grandmother", "extraPartner", "grandmother-extra"),
      parentChildEdge("grandmother-father", "grandmother", "father", "grandmother-family", "mother"),
      parentChildEdge("grandfather-father", "grandfather", "father", "grandmother-family", "father"),
      parentChildEdge("grandmother-aunt", "grandmother", "aunt", "grandmother-family", "mother"),
      parentChildEdge("grandfather-aunt", "grandfather", "aunt", "grandmother-family", "father"),
      partnerEdge("father-fatherPartner", "father", "fatherPartner", "father-family"),
      parentChildEdge("father-root", "father", "root", "father-family", "father"),
      parentChildEdge("fatherPartner-root", "fatherPartner", "root", "father-family", "mother"),
      partnerEdge("aunt-auntPartner", "aunt", "auntPartner", "aunt-family"),
      parentChildEdge("aunt-cousin", "aunt", "cousin", "aunt-family", "mother"),
      parentChildEdge("auntPartner-cousin", "auntPartner", "cousin", "aunt-family", "father"),
      partnerEdge("grandmotherSibling-siblingPartner", "grandmotherSibling", "siblingPartner", "sibling-family"),
      parentChildEdge("grandmotherSibling-siblingChild", "grandmotherSibling", "siblingChild", "sibling-family", "mother"),
      parentChildEdge("siblingPartner-siblingChild", "siblingPartner", "siblingChild", "sibling-family", "father"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const grandmother = nodeById.get("grandmother:0");
  const grandfather = nodeById.get("grandfather:0");
  const extraPartner = nodeById.get("extraPartner:0");
  const father = nodeById.get("father:0");
  const aunt = nodeById.get("aunt:0");
  const fatherPartner = nodeById.get("fatherPartner:0");
  const auntPartner = nodeById.get("auntPartner:0");
  const sibling = nodeById.get("grandmotherSibling:0");
  const siblingPartner = nodeById.get("siblingPartner:0");
  const siblingChild = nodeById.get("siblingChild:0");

  assert.ok(grandmother);
  assert.ok(grandfather);
  assert.ok(extraPartner);
  assert.ok(father);
  assert.ok(aunt);
  assert.ok(fatherPartner);
  assert.ok(auntPartner);
  assert.ok(sibling);
  assert.ok(siblingPartner);
  assert.ok(siblingChild);
  assert.equal(grandfather.x + grandfather.width <= grandmother.x, true, "male primary partner stays left of the focused grandmother");
  assert.equal(extraPartner.x + extraPartner.width <= grandmother.x, true, "non-direct partner is placed outside on the left");
  assert.equal(sibling.x >= grandmother.x + grandmother.width, true, "female focused person's sibling block is outside on the right");
  assert.equal(siblingPartner.x >= grandmother.x + grandmother.width, true, "sibling partner follows the female-side block");
  assert.equal(siblingChild.x >= grandmother.x + grandmother.width, true, "sibling descendants do not mix with focused person's children");
  assert.equal(father.y, aunt.y);
  assert.equal(fatherPartner.y, father.y);
  assert.equal(auntPartner.y, aunt.y);
  assertNoSameRowOverlaps(layout.nodes);
});

test("grid layout opens a female ancestor sibling branch to the right even inside the paternal tree side", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("paternalGrandfather", "male"),
      node("paternalGrandmother", "female"),
      node("paternalGrandmotherBrother", "male"),
      node("paternalGrandmotherSister", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("father:0", "father", -1, ["root", "father"]),
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, ["root", "father", "paternalGrandfather"]),
      { ...occurrence("paternalGrandmother:0", "paternalGrandmother", -2, ["root", "father", "paternalGrandmother"]), sideBranchesExpanded: true },
      occurrence("paternalGrandmotherBrother:0", "paternalGrandmotherBrother", -2, ["root", "father", "paternalGrandmother", "paternalGrandmotherBrother"]),
      occurrence("paternalGrandmotherSister:0", "paternalGrandmotherSister", -2, ["root", "father", "paternalGrandmother", "paternalGrandmotherSister"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "root-parents", "father"),
      parentChildEdge("mother-root", "mother", "root", "root-parents", "mother"),
      partnerEdge("father-mother", "father", "mother", "root-parents"),
      parentChildEdge("pgf-father", "paternalGrandfather", "father", "father-parents", "father"),
      parentChildEdge("pgm-father", "paternalGrandmother", "father", "father-parents", "mother"),
      partnerEdge("pgf-pgm", "paternalGrandfather", "paternalGrandmother", "father-parents"),
      parentChildEdge("pgf-brother", "paternalGrandfather", "paternalGrandmotherBrother", "father-parents", "father"),
      parentChildEdge("pgm-brother", "paternalGrandmother", "paternalGrandmotherBrother", "father-parents", "mother"),
      parentChildEdge("pgf-sister", "paternalGrandfather", "paternalGrandmotherSister", "father-parents", "father"),
      parentChildEdge("pgm-sister", "paternalGrandmother", "paternalGrandmotherSister", "father-parents", "mother"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const grandmother = nodeById.get("paternalGrandmother:0");
  const brother = nodeById.get("paternalGrandmotherBrother:0");
  const sister = nodeById.get("paternalGrandmotherSister:0");

  assert.ok(grandmother);
  assert.ok(brother);
  assert.ok(sister);
  assert.equal(
    brother.x + brother.width <= grandmother.x || brother.x >= grandmother.x + grandmother.width,
    true,
    "female ancestor brother branch stays outside her card",
  );
  assert.equal(
    sister.x + sister.width <= grandmother.x || sister.x >= grandmother.x + grandmother.width,
    true,
    "female ancestor sister branch stays outside her card",
  );
  assertNoSameRowOverlaps(layout.nodes);
});

test("grid layout anchors an expanded father-side branch without moving the direct backbone", () => {
  const directGraph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("paternalGrandfather", "male"),
      node("paternalGrandmother", "female"),
      node("maternalGrandfather", "male"),
      node("maternalGrandmother", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      { ...occurrence("father:0", "father", -1, ["root", "father"]), sideBranchesExpanded: true },
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, ["root", "father", "paternalGrandfather"]),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, ["root", "father", "paternalGrandmother"]),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -2, ["root", "mother", "maternalGrandfather"]),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, ["root", "mother", "maternalGrandmother"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "root-parents", "father"),
      parentChildEdge("mother-root", "mother", "root", "root-parents", "mother"),
      partnerEdge("father-mother", "father", "mother", "root-parents"),
      parentChildEdge("pgf-father", "paternalGrandfather", "father", "father-parents", "father"),
      parentChildEdge("pgm-father", "paternalGrandmother", "father", "father-parents", "mother"),
      partnerEdge("pgf-pgm", "paternalGrandfather", "paternalGrandmother", "father-parents"),
      parentChildEdge("mgf-mother", "maternalGrandfather", "mother", "mother-parents", "father"),
      parentChildEdge("mgm-mother", "maternalGrandmother", "mother", "mother-parents", "mother"),
      partnerEdge("mgf-mgm", "maternalGrandfather", "maternalGrandmother", "mother-parents"),
    ],
  };
  const expandedGraph: FamilyTreeGraphDto = {
    ...directGraph,
    nodes: [
      ...directGraph.nodes,
      node("uncle", "male"),
      node("zzPartner", "female"),
      node("zAunt", "female"),
      node("cousin", "male"),
    ],
    occurrences: [
      ...directGraph.occurrences.map((item) =>
        item.id === "father:0" ? { ...item, sideBranchesExpanded: true } : item
      ),
      occurrence("uncle:0", "uncle", -1, ["root", "father", "uncle"]),
      occurrence("zzPartner:0", "zzPartner", -1, ["root", "father", "uncle", "zzPartner"]),
      occurrence("zAunt:0", "zAunt", -1, ["root", "father", "zAunt"]),
      occurrence("cousin:0", "cousin", 0, ["root", "father", "uncle", "cousin"]),
    ],
    edges: [
      ...directGraph.edges,
      parentChildEdge("pgf-uncle", "paternalGrandfather", "uncle", "father-parents", "father"),
      parentChildEdge("pgm-uncle", "paternalGrandmother", "uncle", "father-parents", "mother"),
      parentChildEdge("pgf-zAunt", "paternalGrandfather", "zAunt", "father-parents", "father"),
      parentChildEdge("pgm-zAunt", "paternalGrandmother", "zAunt", "father-parents", "mother"),
      partnerEdge("uncle-zzPartner", "uncle", "zzPartner", "uncle-family"),
      parentChildEdge("uncle-cousin", "uncle", "cousin", "uncle-family", "father"),
      parentChildEdge("zzPartner-cousin", "zzPartner", "cousin", "uncle-family", "mother"),
    ],
  };
  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const direct = calculateTreeLayout(directGraph, options);
  const expanded = calculateTreeLayout(expandedGraph, options);
  const directById = new Map(direct.nodes.map((item) => [item.occurrence.id, item]));
  const expandedById = new Map(expanded.nodes.map((item) => [item.occurrence.id, item]));
  const root = expandedById.get("root:0");
  const mother = expandedById.get("mother:0");

  assert.ok(root);
  assert.ok(mother);
  for (const id of ["root:0", "father:0", "mother:0", "paternalGrandfather:0", "paternalGrandmother:0"]) {
    assert.equal(expandedById.get(id)?.x, directById.get(id)?.x, `${id} x stayed stable`);
    assert.equal(expandedById.get(id)?.y, directById.get(id)?.y, `${id} y stayed stable`);
  }
  for (const id of ["uncle:0", "zzPartner:0", "zAunt:0", "cousin:0"]) {
    const item = expandedById.get(id);
    assert.ok(item);
    assert.equal(item.x + item.width / 2 < root.x + root.width / 2, true, `${id} stayed on father side`);
    assert.equal(item.x + item.width < mother.x, true, `${id} stayed before mother branch`);
  }
  const uncle = expandedById.get("uncle:0");
  const partner = expandedById.get("zzPartner:0");
  const aunt = expandedById.get("zAunt:0");
  const cousin = expandedById.get("cousin:0");
  assert.ok(uncle);
  assert.ok(partner);
  assert.ok(aunt);
  assert.ok(cousin);
  const uncleCenter = uncle.x + uncle.width / 2;
  const partnerCenter = partner.x + partner.width / 2;
  const auntCenter = aunt.x + aunt.width / 2;
  const cousinCenter = cousin.x + cousin.width / 2;
  const uncleUnionCenter = (uncleCenter + partnerCenter) / 2;
  assert.equal(
    auntCenter < Math.min(uncleCenter, partnerCenter) || auntCenter > Math.max(uncleCenter, partnerCenter),
    true,
    "sibling card does not split the partner pair",
  );
  assert.equal(Math.abs(cousinCenter - uncleUnionCenter) < 0.001, true, "child is centered under the opened branch union");
  assert.equal(
    expanded.placeholders?.some((placeholder) =>
      placeholder.targetOccurrenceId === "zzPartner:0" &&
      (placeholder.action === "add_father" || placeholder.action === "add_mother")
    ),
    false,
    "side branch partner does not get direct-line parent cards",
  );
  assert.equal(
    expanded.placeholders?.some((placeholder) =>
      placeholder.targetOccurrenceId === "zzPartner:0" &&
      placeholder.action === "open_menu"
    ),
    true,
    "side branch partner keeps the round add menu",
  );
  assert.equal(expandedById.get("uncle:0")?.y, expandedById.get("father:0")?.y);
  assert.equal(expandedById.get("cousin:0")?.y, root.y);
});

test("grid layout keeps multiple expanded father-side branch blocks from overlapping", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("paternalGrandfather", "male"),
      node("paternalGrandmother", "female"),
      node("maternalGrandfather", "male"),
      node("maternalGrandmother", "female"),
      node("uncle", "male"),
      node("unclePartner", "female"),
      node("cousin", "male"),
      node("greatUncle", "male"),
      node("greatUnclePartner", "female"),
      node("firstCousinOnceRemoved", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      { ...occurrence("father:0", "father", -1, ["root", "father"]), sideBranchesExpanded: true },
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
      { ...occurrence("paternalGrandfather:0", "paternalGrandfather", -2, ["root", "father", "paternalGrandfather"]), sideBranchesExpanded: true },
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, ["root", "father", "paternalGrandmother"]),
      occurrence("maternalGrandfather:0", "maternalGrandfather", -2, ["root", "mother", "maternalGrandfather"]),
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, ["root", "mother", "maternalGrandmother"]),
      occurrence("uncle:0", "uncle", -1, ["root", "father", "uncle"]),
      occurrence("unclePartner:0", "unclePartner", -1, ["root", "father", "uncle", "unclePartner"]),
      occurrence("cousin:0", "cousin", 0, ["root", "father", "uncle", "cousin"]),
      occurrence("greatUncle:0", "greatUncle", -2, ["root", "father", "paternalGrandfather", "greatUncle"]),
      occurrence("greatUnclePartner:0", "greatUnclePartner", -2, ["root", "father", "paternalGrandfather", "greatUncle", "greatUnclePartner"]),
      occurrence("firstCousinOnceRemoved:0", "firstCousinOnceRemoved", -1, ["root", "father", "paternalGrandfather", "greatUncle", "firstCousinOnceRemoved"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "root-parents", "father"),
      parentChildEdge("mother-root", "mother", "root", "root-parents", "mother"),
      partnerEdge("father-mother", "father", "mother", "root-parents"),
      parentChildEdge("pgf-father", "paternalGrandfather", "father", "father-parents", "father"),
      parentChildEdge("pgm-father", "paternalGrandmother", "father", "father-parents", "mother"),
      partnerEdge("pgf-pgm", "paternalGrandfather", "paternalGrandmother", "father-parents"),
      parentChildEdge("mgf-mother", "maternalGrandfather", "mother", "mother-parents", "father"),
      parentChildEdge("mgm-mother", "maternalGrandmother", "mother", "mother-parents", "mother"),
      partnerEdge("mgf-mgm", "maternalGrandfather", "maternalGrandmother", "mother-parents"),
      parentChildEdge("pgf-uncle", "paternalGrandfather", "uncle", "father-parents", "father"),
      parentChildEdge("pgm-uncle", "paternalGrandmother", "uncle", "father-parents", "mother"),
      partnerEdge("uncle-partner", "uncle", "unclePartner", "uncle-family"),
      parentChildEdge("uncle-cousin", "uncle", "cousin", "uncle-family", "father"),
      parentChildEdge("unclePartner-cousin", "unclePartner", "cousin", "uncle-family", "mother"),
      partnerEdge("great-uncle-partner", "greatUncle", "greatUnclePartner", "great-uncle-family"),
      parentChildEdge("greatUncle-child", "greatUncle", "firstCousinOnceRemoved", "great-uncle-family", "father"),
      parentChildEdge("greatUnclePartner-child", "greatUnclePartner", "firstCousinOnceRemoved", "great-uncle-family", "mother"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  const mother = nodeById.get("mother:0");
  assert.ok(root);
  assert.ok(mother);

  for (const id of ["uncle:0", "unclePartner:0", "cousin:0", "greatUncle:0", "greatUnclePartner:0", "firstCousinOnceRemoved:0"]) {
    const item = nodeById.get(id);
    assert.ok(item);
    assert.equal(item.x + item.width / 2 < root.x + root.width / 2, true, `${id} stayed on father side`);
    assert.equal(item.x + item.width < mother.x, true, `${id} stayed before mother branch`);
  }
  const branchNodes = [
    "uncle:0",
    "unclePartner:0",
    "cousin:0",
    "greatUncle:0",
    "greatUnclePartner:0",
    "firstCousinOnceRemoved:0",
  ].map((id) => {
    const item = nodeById.get(id);
    assert.ok(item);
    return item;
  });
  for (let leftIndex = 0; leftIndex < branchNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < branchNodes.length; rightIndex += 1) {
      const left = branchNodes[leftIndex];
      const right = branchNodes[rightIndex];
      if (Math.abs(left.y - right.y) >= left.height) continue;
      assert.equal(
        left.x + left.width <= right.x || right.x + right.width <= left.x,
        true,
        `${left.occurrence.id} does not overlap ${right.occurrence.id}`,
      );
    }
  }
});

test("grid layout keeps multiple expanded mother-side branch blocks on the maternal side", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("paternalGrandfather", "male"),
      node("paternalGrandmother", "female"),
      node("maternalGrandfather", "male"),
      node("maternalGrandmother", "female"),
      node("aunt", "female"),
      node("auntPartner", "male"),
      node("maternalCousin", "female"),
      node("greatAunt", "female"),
      node("greatAuntPartner", "male"),
      node("maternalCousinOnceRemoved", "male"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      occurrence("father:0", "father", -1, ["root", "father"]),
      { ...occurrence("mother:0", "mother", -1, ["root", "mother"]), sideBranchesExpanded: true },
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, ["root", "father", "paternalGrandfather"]),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, ["root", "father", "paternalGrandmother"]),
      { ...occurrence("maternalGrandfather:0", "maternalGrandfather", -2, ["root", "mother", "maternalGrandfather"]), sideBranchesExpanded: true },
      occurrence("maternalGrandmother:0", "maternalGrandmother", -2, ["root", "mother", "maternalGrandmother"]),
      occurrence("aunt:0", "aunt", -1, ["root", "mother", "aunt"]),
      occurrence("auntPartner:0", "auntPartner", -1, ["root", "mother", "aunt", "auntPartner"]),
      occurrence("maternalCousin:0", "maternalCousin", 0, ["root", "mother", "aunt", "maternalCousin"]),
      occurrence("greatAunt:0", "greatAunt", -2, ["root", "mother", "maternalGrandfather", "greatAunt"]),
      occurrence("greatAuntPartner:0", "greatAuntPartner", -2, ["root", "mother", "maternalGrandfather", "greatAunt", "greatAuntPartner"]),
      occurrence("maternalCousinOnceRemoved:0", "maternalCousinOnceRemoved", -1, ["root", "mother", "maternalGrandfather", "greatAunt", "maternalCousinOnceRemoved"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "root-parents", "father"),
      parentChildEdge("mother-root", "mother", "root", "root-parents", "mother"),
      partnerEdge("father-mother", "father", "mother", "root-parents"),
      parentChildEdge("pgf-father", "paternalGrandfather", "father", "father-parents", "father"),
      parentChildEdge("pgm-father", "paternalGrandmother", "father", "father-parents", "mother"),
      partnerEdge("pgf-pgm", "paternalGrandfather", "paternalGrandmother", "father-parents"),
      parentChildEdge("mgf-mother", "maternalGrandfather", "mother", "mother-parents", "father"),
      parentChildEdge("mgm-mother", "maternalGrandmother", "mother", "mother-parents", "mother"),
      partnerEdge("mgf-mgm", "maternalGrandfather", "maternalGrandmother", "mother-parents"),
      parentChildEdge("mgf-aunt", "maternalGrandfather", "aunt", "mother-parents", "father"),
      parentChildEdge("mgm-aunt", "maternalGrandmother", "aunt", "mother-parents", "mother"),
      partnerEdge("aunt-partner", "aunt", "auntPartner", "aunt-family"),
      parentChildEdge("aunt-cousin", "aunt", "maternalCousin", "aunt-family", "mother"),
      parentChildEdge("auntPartner-cousin", "auntPartner", "maternalCousin", "aunt-family", "father"),
      partnerEdge("great-aunt-partner", "greatAunt", "greatAuntPartner", "great-aunt-family"),
      parentChildEdge("greatAunt-child", "greatAunt", "maternalCousinOnceRemoved", "great-aunt-family", "mother"),
      parentChildEdge("greatAuntPartner-child", "greatAuntPartner", "maternalCousinOnceRemoved", "great-aunt-family", "father"),
    ],
  };
  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const root = nodeById.get("root:0");
  const father = nodeById.get("father:0");
  assert.ok(root);
  assert.ok(father);

  const branchNodes = [
    "aunt:0",
    "auntPartner:0",
    "maternalCousin:0",
    "greatAunt:0",
    "greatAuntPartner:0",
    "maternalCousinOnceRemoved:0",
  ].map((id) => {
    const item = nodeById.get(id);
    assert.ok(item);
    assert.equal(item.x + item.width / 2 > root.x + root.width / 2, true, `${id} stayed on mother side`);
    assert.equal(item.x > father.x + father.width, true, `${id} stayed after father branch`);
    return item;
  });
  for (let leftIndex = 0; leftIndex < branchNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < branchNodes.length; rightIndex += 1) {
      const left = branchNodes[leftIndex];
      const right = branchNodes[rightIndex];
      if (Math.abs(left.y - right.y) >= left.height) continue;
      assert.equal(
        left.x + left.width <= right.x || right.x + right.width <= left.x,
        true,
        `${left.occurrence.id} does not overlap ${right.occurrence.id}`,
      );
    }
  }
});

test("grid layout keeps focused person's descendants grouped by their own family unions", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "grandmother",
    nodes: [
      node("grandmother", "female"),
      node("grandfather", "male"),
      node("daughter", "female"),
      node("son", "male"),
      node("secondDaughter", "female"),
      node("secondSon", "male"),
      node("daughterPartner", "male"),
      node("sonPartner", "female"),
      node("daughterChildOne", "male"),
      node("daughterChildTwo", "female"),
      node("daughterChildOnePartner", "female"),
      node("daughterGreatGrandchildOne", "male"),
      node("daughterGreatGrandchildTwo", "female"),
      node("daughterGreatGrandchildThree", "male"),
      node("sonChildOne", "male"),
      node("sonChildTwo", "female"),
    ],
    occurrences: [
      { ...occurrence("grandmother:0", "grandmother", 0, ["grandmother"]), sideBranchesExpanded: true },
      occurrence("grandfather:0", "grandfather", 0, ["grandmother", "grandfather"]),
      occurrence("daughter:0", "daughter", 1, ["grandmother", "daughter"]),
      occurrence("son:0", "son", 1, ["grandmother", "son"]),
      occurrence("secondDaughter:0", "secondDaughter", 1, ["grandmother", "secondDaughter"]),
      occurrence("secondSon:0", "secondSon", 1, ["grandmother", "secondSon"]),
      occurrence("daughterPartner:0", "daughterPartner", 1, ["grandmother", "daughter", "daughterPartner"]),
      occurrence("sonPartner:0", "sonPartner", 1, ["grandmother", "son", "sonPartner"]),
      occurrence("daughterChildOne:0", "daughterChildOne", 2, ["grandmother", "daughter", "daughterChildOne"]),
      occurrence("daughterChildTwo:0", "daughterChildTwo", 2, ["grandmother", "daughter", "daughterChildTwo"]),
      occurrence("daughterChildOnePartner:0", "daughterChildOnePartner", 2, ["grandmother", "daughter", "daughterChildOne", "daughterChildOnePartner"]),
      occurrence("daughterGreatGrandchildOne:0", "daughterGreatGrandchildOne", 3, ["grandmother", "daughter", "daughterChildOne", "daughterGreatGrandchildOne"]),
      occurrence("daughterGreatGrandchildTwo:0", "daughterGreatGrandchildTwo", 3, ["grandmother", "daughter", "daughterChildOne", "daughterGreatGrandchildTwo"]),
      occurrence("daughterGreatGrandchildThree:0", "daughterGreatGrandchildThree", 3, ["grandmother", "daughter", "daughterChildOne", "daughterGreatGrandchildThree"]),
      occurrence("sonChildOne:0", "sonChildOne", 2, ["grandmother", "son", "sonChildOne"]),
      occurrence("sonChildTwo:0", "sonChildTwo", 2, ["grandmother", "son", "sonChildTwo"]),
    ],
    edges: [
      partnerEdge("grandparents", "grandfather", "grandmother", "grandparents"),
      parentChildEdge("grandfather-daughter", "grandfather", "daughter", "grandparents", "father"),
      parentChildEdge("grandmother-daughter", "grandmother", "daughter", "grandparents", "mother"),
      parentChildEdge("grandfather-son", "grandfather", "son", "grandparents", "father"),
      parentChildEdge("grandmother-son", "grandmother", "son", "grandparents", "mother"),
      parentChildEdge("grandfather-second-daughter", "grandfather", "secondDaughter", "grandparents", "father"),
      parentChildEdge("grandmother-second-daughter", "grandmother", "secondDaughter", "grandparents", "mother"),
      parentChildEdge("grandfather-second-son", "grandfather", "secondSon", "grandparents", "father"),
      parentChildEdge("grandmother-second-son", "grandmother", "secondSon", "grandparents", "mother"),
      partnerEdge("daughter-family-partner", "daughter", "daughterPartner", "daughter-family"),
      parentChildEdge("daughter-child-one-mother", "daughter", "daughterChildOne", "daughter-family", "mother"),
      parentChildEdge("daughter-child-one-father", "daughterPartner", "daughterChildOne", "daughter-family", "father"),
      parentChildEdge("daughter-child-two-mother", "daughter", "daughterChildTwo", "daughter-family", "mother"),
      parentChildEdge("daughter-child-two-father", "daughterPartner", "daughterChildTwo", "daughter-family", "father"),
      partnerEdge("daughter-child-one-family-partner", "daughterChildOne", "daughterChildOnePartner", "daughter-child-one-family"),
      parentChildEdge("daughter-great-grandchild-one-father", "daughterChildOne", "daughterGreatGrandchildOne", "daughter-child-one-family", "father"),
      parentChildEdge("daughter-great-grandchild-one-mother", "daughterChildOnePartner", "daughterGreatGrandchildOne", "daughter-child-one-family", "mother"),
      parentChildEdge("daughter-great-grandchild-two-father", "daughterChildOne", "daughterGreatGrandchildTwo", "daughter-child-one-family", "father"),
      parentChildEdge("daughter-great-grandchild-two-mother", "daughterChildOnePartner", "daughterGreatGrandchildTwo", "daughter-child-one-family", "mother"),
      parentChildEdge("daughter-great-grandchild-three-father", "daughterChildOne", "daughterGreatGrandchildThree", "daughter-child-one-family", "father"),
      parentChildEdge("daughter-great-grandchild-three-mother", "daughterChildOnePartner", "daughterGreatGrandchildThree", "daughter-child-one-family", "mother"),
      partnerEdge("son-family-partner", "son", "sonPartner", "son-family"),
      parentChildEdge("son-child-one-father", "son", "sonChildOne", "son-family", "father"),
      parentChildEdge("son-child-one-mother", "sonPartner", "sonChildOne", "son-family", "mother"),
      parentChildEdge("son-child-two-father", "son", "sonChildTwo", "son-family", "father"),
      parentChildEdge("son-child-two-mother", "sonPartner", "sonChildTwo", "son-family", "mother"),
    ],
  };

  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  for (const id of [
    "daughter:0",
    "son:0",
    "secondDaughter:0",
    "secondSon:0",
    "daughterPartner:0",
    "sonPartner:0",
    "daughterChildOne:0",
    "daughterChildTwo:0",
    "daughterChildOnePartner:0",
    "daughterGreatGrandchildOne:0",
    "daughterGreatGrandchildTwo:0",
    "daughterGreatGrandchildThree:0",
    "sonChildOne:0",
    "sonChildTwo:0",
  ]) {
    assert.ok(nodeById.get(id), `${id} rendered as a person card`);
  }
  assertNoSameRowOverlaps(layout.nodes);

  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item, `${id} exists`);
    return item.x + item.width / 2;
  };
  const average = (ids: string[]) => ids.reduce((sum, id) => sum + center(id), 0) / ids.length;
  const daughterUnionCenter = (center("daughter:0") + center("daughterPartner:0")) / 2;
  const sonUnionCenter = (center("son:0") + center("sonPartner:0")) / 2;
  const daughterChildOneUnionCenter = (center("daughterChildOne:0") + center("daughterChildOnePartner:0")) / 2;
  const daughterChildrenCenter = average(["daughterChildOne:0", "daughterChildTwo:0"]);
  const sonChildrenCenter = average(["sonChildOne:0", "sonChildTwo:0"]);
  const daughterGrandchildrenCenter = average([
    "daughterGreatGrandchildOne:0",
    "daughterGreatGrandchildTwo:0",
    "daughterGreatGrandchildThree:0",
  ]);

  assert.equal(
    Math.abs(daughterChildrenCenter - daughterUnionCenter) < Math.abs(daughterChildrenCenter - sonUnionCenter),
    true,
    "daughter's children stay under daughter's union",
  );
  assert.equal(
    Math.abs(center("daughterChildOne:0") - center("daughterChildOnePartner:0")) <= 130,
    true,
    "child and partner stay adjacent inside the child family header",
  );
  assert.equal(
    Math.abs(daughterGrandchildrenCenter - daughterChildOneUnionCenter) <= 20,
    true,
    "next generation stays under the child and partner union",
  );
  assert.equal(
    Math.abs(sonChildrenCenter - sonUnionCenter) < Math.abs(sonChildrenCenter - daughterUnionCenter),
    true,
    "son's children stay under son's union",
  );
});

test("grid layout keeps three child families as compact columns under their parents", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "female"),
      node("rootPartner", "male"),
    ],
    occurrences: [
      { ...occurrence("root:0", "root", 0, ["root"]), sideBranchesExpanded: true },
      occurrence("rootPartner:0", "rootPartner", 0, ["root", "rootPartner"]),
    ],
    edges: [
      partnerEdge("root-partner", "rootPartner", "root", "root-family"),
    ],
  };

  const childFamilies = [
    { child: "childOne", childGender: "male", partner: "childOnePartner", partnerGender: "female" },
    { child: "childTwo", childGender: "female", partner: "childTwoPartner", partnerGender: "male" },
    { child: "childThree", childGender: "male", partner: "childThreePartner", partnerGender: "female" },
  ];

  for (const family of childFamilies) {
    graph.nodes.push(node(family.child, family.childGender));
    graph.nodes.push(node(family.partner, family.partnerGender));
    graph.occurrences.push(occurrence(`${family.child}:0`, family.child, 1, ["root", family.child]));
    graph.occurrences.push(occurrence(`${family.partner}:0`, family.partner, 1, ["root", family.child, family.partner]));
    graph.edges.push(parentChildEdge(`rootPartner-${family.child}`, "rootPartner", family.child, "root-family", "father"));
    graph.edges.push(parentChildEdge(`root-${family.child}`, "root", family.child, "root-family", "mother"));
    graph.edges.push(partnerEdge(`${family.child}-partner`, family.child, family.partner, `${family.child}-family`));

    for (let childIndex = 1; childIndex <= 2; childIndex += 1) {
      const grandchildId = `${family.child}Grandchild${childIndex}`;
      graph.nodes.push(node(grandchildId, childIndex === 1 ? "male" : "female"));
      graph.occurrences.push(occurrence(`${grandchildId}:0`, grandchildId, 2, ["root", family.child, grandchildId]));
      const childRole = family.childGender === "female" ? "mother" : "father";
      const partnerRole = childRole === "father" ? "mother" : "father";
      graph.edges.push(parentChildEdge(`${family.child}-${grandchildId}`, family.child, grandchildId, `${family.child}-family`, childRole));
      graph.edges.push(parentChildEdge(`${family.partner}-${grandchildId}`, family.partner, grandchildId, `${family.child}-family`, partnerRole));
    }
  }

  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  assertNoSameRowOverlaps(layout.nodes);

  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item, `${id} exists`);
    return item.x + item.width / 2;
  };
  const rowTop = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item, `${id} exists`);
    return item.y;
  };
  const average = (ids: string[]) => ids.reduce((sum, id) => sum + center(id), 0) / ids.length;
  const rootUnionCenter = (center("root:0") + center("rootPartner:0")) / 2;
  const childUnionCenters = childFamilies.map((family) =>
    (center(`${family.child}:0`) + center(`${family.partner}:0`)) / 2,
  );

  assert.equal(center("rootPartner:0") < center("root:0"), true, "male root partner stays left of female root");

  const childUnionAverage = childUnionCenters.reduce((sum, value) => sum + value, 0) / childUnionCenters.length;
  assert.equal(Math.abs(childUnionAverage - rootUnionCenter) <= 20, true, "three child family columns center under the root union");

  for (const family of childFamilies) {
    const childId = `${family.child}:0`;
    const partnerId = `${family.partner}:0`;
    const maleId = family.childGender === "male" ? childId : partnerId;
    const femaleId = family.childGender === "female" ? childId : partnerId;
    assert.equal(rowTop(childId), rowTop(partnerId), `${family.child} and partner stay on one row`);
    assert.equal(center(maleId) < center(femaleId), true, `${family.child} family keeps male partner left of female partner`);
    assert.equal(Math.abs(center(childId) - center(partnerId)) <= 130, true, `${family.child} and partner stay adjacent`);
    const unionCenter = (center(childId) + center(partnerId)) / 2;
    const grandchildrenCenter = average([
      `${family.child}Grandchild1:0`,
      `${family.child}Grandchild2:0`,
    ]);
    assert.equal(
      Math.abs(grandchildrenCenter - unionCenter) <= 20,
      true,
      `${family.child}'s children stay under that child family union`,
    );
  }
});

test("grid layout uses family blocks for expanded side-branch sibling families", () => {
  const graph: FamilyTreeGraphDto = {
    ...baseGraph,
    rootPersonId: "root",
    nodes: [
      node("root", "male"),
      node("father", "male"),
      node("mother", "female"),
      node("paternalGrandfather", "male"),
      node("paternalGrandmother", "female"),
    ],
    occurrences: [
      occurrence("root:0", "root", 0, ["root"]),
      { ...occurrence("father:0", "father", -1, ["root", "father"]), sideBranchesExpanded: true },
      occurrence("mother:0", "mother", -1, ["root", "mother"]),
      occurrence("paternalGrandfather:0", "paternalGrandfather", -2, ["root", "father", "paternalGrandfather"]),
      occurrence("paternalGrandmother:0", "paternalGrandmother", -2, ["root", "father", "paternalGrandmother"]),
    ],
    edges: [
      parentChildEdge("father-root", "father", "root", "root-family", "father"),
      parentChildEdge("mother-root", "mother", "root", "root-family", "mother"),
      partnerEdge("father-mother", "father", "mother", "root-family"),
      parentChildEdge("pgf-father", "paternalGrandfather", "father", "father-parents", "father"),
      parentChildEdge("pgm-father", "paternalGrandmother", "father", "father-parents", "mother"),
      partnerEdge("pgf-pgm", "paternalGrandfather", "paternalGrandmother", "father-parents"),
    ],
  };
  const siblingFamilies = [
    { sibling: "uncleOne", partner: "uncleOnePartner" },
    { sibling: "uncleTwo", partner: "uncleTwoPartner" },
  ];
  for (const family of siblingFamilies) {
    graph.nodes.push(node(family.sibling, "male"));
    graph.nodes.push(node(family.partner, "female"));
    graph.occurrences.push(occurrence(`${family.sibling}:0`, family.sibling, -1, ["root", "father", family.sibling]));
    graph.occurrences.push(occurrence(`${family.partner}:0`, family.partner, -1, ["root", "father", family.sibling, family.partner]));
    graph.edges.push(parentChildEdge(`pgf-${family.sibling}`, "paternalGrandfather", family.sibling, "father-parents", "father"));
    graph.edges.push(parentChildEdge(`pgm-${family.sibling}`, "paternalGrandmother", family.sibling, "father-parents", "mother"));
    graph.edges.push(partnerEdge(`${family.sibling}-partner`, family.sibling, family.partner, `${family.sibling}-family`));
    for (let index = 1; index <= 2; index += 1) {
      const childId = `${family.sibling}Child${index}`;
      graph.nodes.push(node(childId, index === 1 ? "male" : "female"));
      graph.occurrences.push(occurrence(`${childId}:0`, childId, 0, ["root", "father", family.sibling, childId]));
      graph.edges.push(parentChildEdge(`${family.sibling}-${childId}`, family.sibling, childId, `${family.sibling}-family`, "father"));
      graph.edges.push(parentChildEdge(`${family.partner}-${childId}`, family.partner, childId, `${family.sibling}-family`, "mother"));
    }
  }

  const layout = calculateTreeLayout(graph, {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  });
  assertNoSameRowOverlaps(layout.nodes);
  const nodeById = new Map(layout.nodes.map((item) => [item.occurrence.id, item]));
  const center = (id: string) => {
    const item = nodeById.get(id);
    assert.ok(item, `${id} exists`);
    return item.x + item.width / 2;
  };
  const average = (ids: string[]) => ids.reduce((sum, id) => sum + center(id), 0) / ids.length;

  for (const family of siblingFamilies) {
    const unionCenter = (center(`${family.sibling}:0`) + center(`${family.partner}:0`)) / 2;
    const childrenCenter = average([
      `${family.sibling}Child1:0`,
      `${family.sibling}Child2:0`,
    ]);
    assert.equal(Math.abs(childrenCenter - unionCenter) <= 20, true, `${family.sibling} child family stays in its side-branch column`);
    assert.equal(Math.abs(center(`${family.sibling}:0`) - center(`${family.partner}:0`)) <= 130, true, `${family.sibling} and partner are adjacent`);
  }
});

test("grid layout keeps the seven-generation direct backbone stable with large opened side families", () => {
  const directGraph = directAncestorGraph(7);
  const expandedGraph: FamilyTreeGraphDto = {
    ...directGraph,
    nodes: [...directGraph.nodes],
    occurrences: directGraph.occurrences.map((item) =>
      ["rootF:0", "rootM:0", "rootFF:0", "rootMM:0"].includes(item.id)
        ? { ...item, sideBranchesExpanded: true }
        : item,
    ),
    edges: [...directGraph.edges],
  };

  addExpandedSiblingFamily(expandedGraph, "rootF", "rootFUncle", "rootFUnclePartner", "rootFCousin", 4);
  addExpandedSiblingFamily(expandedGraph, "rootM", "rootMAunt", "rootMAuntPartner", "rootMCousin", 4);
  addExpandedSiblingFamily(expandedGraph, "rootFF", "rootFFGreatUncle", "rootFFGreatUnclePartner", "rootFFOnceRemoved", 3);
  addExpandedSiblingFamily(expandedGraph, "rootMM", "rootMMGreatAunt", "rootMMGreatAuntPartner", "rootMMOnceRemoved", 3);

  const options = {
    nodeWidth: 100,
    nodeHeight: 50,
    horizontalSpacing: 180,
    verticalSpacing: 100,
    padding: 20,
  };
  const direct = calculateTreeLayout(directGraph, options);
  const expanded = calculateTreeLayout(expandedGraph, options);
  const directById = new Map(direct.nodes.map((item) => [item.occurrence.id, item]));
  const expandedById = new Map(expanded.nodes.map((item) => [item.occurrence.id, item]));

  for (const occurrenceItem of directGraph.occurrences) {
    const directNode = directById.get(occurrenceItem.id);
    const expandedNode = expandedById.get(occurrenceItem.id);
    assert.ok(directNode, `${occurrenceItem.id} exists in direct layout`);
    assert.ok(expandedNode, `${occurrenceItem.id} exists in expanded layout`);
    assert.equal(expandedNode.x, directNode.x, `${occurrenceItem.id} x stayed stable`);
    assert.equal(expandedNode.y, directNode.y, `${occurrenceItem.id} y stayed stable`);
  }

  const root = expandedById.get("root:0");
  const father = expandedById.get("rootF:0");
  const mother = expandedById.get("rootM:0");
  assert.ok(root);
  assert.ok(father);
  assert.ok(mother);
  const rootCenter = root.x + root.width / 2;

  for (const id of [
    "rootFUncle:0",
    "rootFUnclePartner:0",
    "rootFCousin1:0",
    "rootFFGreatUncle:0",
    "rootFFGreatUnclePartner:0",
    "rootFFOnceRemoved1:0",
  ]) {
    const item = expandedById.get(id);
    assert.ok(item);
    assert.equal(item.x + item.width / 2 < rootCenter, true, `${id} stayed on paternal side`);
    assert.equal(item.x + item.width < mother.x, true, `${id} stayed before maternal branch`);
  }

  for (const id of [
    "rootMAunt:0",
    "rootMAuntPartner:0",
    "rootMCousin1:0",
    "rootMMGreatAunt:0",
    "rootMMGreatAuntPartner:0",
    "rootMMOnceRemoved1:0",
  ]) {
    const item = expandedById.get(id);
    assert.ok(item);
    assert.equal(item.x + item.width / 2 > rootCenter, true, `${id} stayed on maternal side`);
    assert.equal(item.x > father.x + father.width, true, `${id} stayed after paternal branch`);
  }
});
