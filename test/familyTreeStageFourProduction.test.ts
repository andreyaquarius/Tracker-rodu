import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { layoutDescendantForest } from "../src/features/family-tree-view/layout/layoutDescendantForest.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  TreePerson,
  TreeUnion,
} from "../src/features/family-tree-view/types.ts";

const productionPage = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const renderLimits = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/renderLimits.ts",
    import.meta.url,
  ),
  "utf8",
);

interface QueuedDescendant {
  id: string;
  generation: number;
  sex: TreePerson["sex"];
}

function realisticDescendantGraph(personCount: number): {
  graph: FamilyGraphData;
  generationByPersonId: ReadonlyMap<string, number>;
} {
  const persons: TreePerson[] = [];
  const unions: TreeUnion[] = [];
  const parentChildRelations: ParentChildRelation[] = [];
  const generationByPersonId = new Map<string, number>();
  const queue: QueuedDescendant[] = [];
  let nextPerson = 0;

  const addPerson = (
    generation: number,
    sex: TreePerson["sex"],
    role: "lineage" | "partner",
  ): QueuedDescendant => {
    const index = nextPerson;
    nextPerson += 1;
    const id = `person-${String(index).padStart(4, "0")}`;
    const value: QueuedDescendant = { id, generation, sex };
    generationByPersonId.set(id, generation);
    persons.push({
      id,
      displayName: `${role === "lineage" ? "Нащадок" : "Партнер"} ${index}`,
      sex,
      birth: { sort: String(1740 + generation * 27 + (index % 19)) },
    });
    return value;
  };

  const root = addPerson(0, "male", "lineage");
  queue.push(root);
  let queueIndex = 0;

  while (persons.length < personCount && queueIndex < queue.length) {
    const parent = queue[queueIndex]!;
    const familyCount = queueIndex > 0 && queueIndex % 11 === 0 ? 2 : 1;
    queueIndex += 1;

    for (let familyIndex = 0; familyIndex < familyCount; familyIndex += 1) {
      if (persons.length >= personCount) break;
      const partnerSex = parent.sex === "male" ? "female" : "male";
      const partner = addPerson(parent.generation, partnerSex, "partner");
      const unionId = `family:${parent.id}:${familyIndex}`;
      unions.push({
        id: unionId,
        kind: "partnership",
        memberIds: [parent.id, partner.id],
        familyGroupId: unionId,
        displayOrder: String(familyIndex).padStart(2, "0"),
      });

      const desiredChildren = familyIndex === 0 ? 3 : 2;
      for (
        let childIndex = 0;
        childIndex < desiredChildren && persons.length < personCount;
        childIndex += 1
      ) {
        const childSex = (nextPerson + childIndex) % 2 === 0 ? "female" : "male";
        const child = addPerson(parent.generation + 1, childSex, "lineage");
        queue.push(child);
        const parentIsFather = parent.sex === "male";
        parentChildRelations.push(
          {
            id: `${unionId}:${child.id}:${parent.id}`,
            parentId: parent.id,
            childId: child.id,
            unionId,
            kind: "biological",
            role: parentIsFather ? "father" : "mother",
          },
          {
            id: `${unionId}:${child.id}:${partner.id}`,
            parentId: partner.id,
            childId: child.id,
            unionId,
            kind: "biological",
            role: parentIsFather ? "mother" : "father",
          },
        );
      }
    }
  }

  assert.equal(persons.length, personCount, "fixture must reach its exact size");
  return {
    graph: { persons, unions, parentChildRelations },
    generationByPersonId,
  };
}

test("production all-descendants uses progressive pages and separates scene from mount budgets", () => {
  assert.match(
    productionPage,
    /import \{ useProgressiveDescendantGraph \} from/,
  );
  assert.match(
    productionPage,
    /const progressiveDescendants = useProgressiveDescendantGraph\(\{[\s\S]*?pageSize:\s*200,/,
  );
  assert.match(
    productionPage,
    /const logicalSceneNodeBudget = perspective\.kind === "all-descendants"[\s\S]*?displayedGraph\.persons\.length[\s\S]*?displayedGraph\.parentChildRelations\.length \* 2[\s\S]*?displayedGraph\.unions\.length \* 2/,
  );
  assert.match(
    productionPage,
    /maxVisibleNodes:\s*logicalSceneNodeBudget/,
  );
  assert.match(
    productionPage,
    /<FamilyTreeViewport[\s\S]*?maxRenderedNodes=\{MAX_RENDERED_FAMILY_TREE_NODES\}/,
  );
  assert.match(renderLimits, /MAX_RENDERED_FAMILY_TREE_NODES\s*=\s*600/);

  const neighborhoodStart = productionPage.indexOf(
    "const specialNeighborhood = useFamilyTreeNeighborhood",
  );
  const progressiveStart = productionPage.indexOf(
    "const progressiveDescendants = useProgressiveDescendantGraph",
    neighborhoodStart,
  );
  assert.ok(neighborhoodStart >= 0 && progressiveStart > neighborhoodStart);
  const legacySpecialRequest = productionPage.slice(
    neighborhoodStart,
    progressiveStart,
  );
  assert.match(
    legacySpecialRequest,
    /enabled:\s*perspective\.kind === "family-corridor"/,
  );
  assert.doesNotMatch(legacySpecialRequest, /all-descendants/);
  assert.doesNotMatch(
    productionPage,
    /maxNodes:\s*perspective\.kind === "all-descendants"[\s\S]{0,120}?MAX_RENDERED_FAMILY_TREE_NODES/,
  );
});

test("a realistic 2480-person descendant graph remains complete and finite", () => {
  const { graph, generationByPersonId } = realisticDescendantGraph(2_480);
  const maxGeneration = Math.max(...generationByPersonId.values());
  const multiPartnerPeople = new Map<string, number>();
  for (const union of graph.unions) {
    const ownerId = union.memberIds[0]!;
    multiPartnerPeople.set(ownerId, (multiPartnerPeople.get(ownerId) ?? 0) + 1);
  }

  assert.equal(maxGeneration >= 5, true);
  assert.equal(
    [...multiPartnerPeople.values()].some(familyCount => familyCount > 1),
    true,
  );
  assert.equal(graph.parentChildRelations.length > graph.persons.length, true);

  const logicalSceneNodeBudget =
    graph.persons.length +
    graph.parentChildRelations.length * 2 +
    graph.unions.length * 2 +
    32;
  const startedAt = performance.now();
  const result = layoutDescendantForest({
    graph,
    options: {
      focusPersonId: graph.persons[0]!.id,
      layoutMode: "descendant-forest",
      ancestorDepth: 0,
      descendantDepth: 100,
      collateralDepth: 0,
      maxVisibleNodes: logicalSceneNodeBudget,
      showAllParentSets: false,
      showUnknownParentPlaceholders: false,
    },
  });
  const duration = performance.now() - startedAt;

  const representedPersonIds = new Set(
    result.nodes
      .filter(node => node.kind === "person" || node.kind === "reference")
      .map(node => node.personId)
      .filter((personId): personId is string => Boolean(personId)),
  );
  assert.equal(representedPersonIds.size, graph.persons.length);
  for (const person of graph.persons) {
    assert.equal(
      representedPersonIds.has(person.id),
      true,
      `layout omitted canonical person ${person.id}`,
    );
  }
  for (const node of result.nodes) {
    assert.equal(
      [node.x, node.y, node.width, node.height].every(Number.isFinite),
      true,
    );
  }
  for (const edge of result.edges) {
    assert.equal(
      edge.points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)),
      true,
    );
  }
  assert.equal(
    [result.bounds.left, result.bounds.top, result.bounds.right, result.bounds.bottom]
      .every(Number.isFinite),
    true,
  );
  assert.equal(Number.isFinite(duration), true);
  assert.ok(
    duration < 30_000,
    `2480-person safety budget exceeded: ${duration.toFixed(1)}ms`,
  );
});
