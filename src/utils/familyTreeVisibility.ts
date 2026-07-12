import type {
  FamilyTreeEdgeDto,
  FamilyTreeGraphDto,
  FamilyTreeGraphMode,
} from "../types/familyTree";

export type FamilyTreeVisibilityOptions = {
  expandedPersonIds?: Iterable<string>;
};

export function graphForDisplayMode(
  graph: FamilyTreeGraphDto,
  mode: FamilyTreeGraphMode,
  options: FamilyTreeVisibilityOptions = {},
): FamilyTreeGraphDto {
  if (!graph.rootPersonId) return { ...graph, mode };
  const expandedPersonIds = new Set(options.expandedPersonIds ?? []);
  const includedPersonIds = visiblePersonIdsForMode(graph, mode, { expandedPersonIds });
  return graphWithPeople(graph, includedPersonIds, mode, expandedPersonIds);
}

export function visiblePersonIdsForMode(
  graph: FamilyTreeGraphDto,
  mode: FamilyTreeGraphMode,
  options: FamilyTreeVisibilityOptions = {},
): Set<string> {
  const rootPersonId = graph.rootPersonId;
  if (!rootPersonId) return new Set(graph.nodes.map((node) => node.personId));

  const parentChildEdges = graph.edges.filter((edge) => edge.kind === "parent_child");
  if (mode === "ancestors" || mode === "direct-line") {
    return directAncestorPersonIds(rootPersonId, parentChildEdges);
  }
  if (mode === "descendants") {
    return withPartners(descendantPersonIds(rootPersonId, parentChildEdges), graph.edges);
  }
  if (mode === "compact") {
    return compactFamilyPersonIds(rootPersonId, graph.edges);
  }
  return focusedFamilyPersonIds(rootPersonId, graph.edges, new Set(options.expandedPersonIds ?? []));
}

function focusedFamilyPersonIds(
  rootPersonId: string,
  edges: FamilyTreeEdgeDto[],
  expandedPersonIds: Set<string>,
): Set<string> {
  const parentChildEdges = edges.filter((edge) => edge.kind === "parent_child");
  const directAncestorIds = directAncestorPersonIds(rootPersonId, parentChildEdges);
  const included = new Set(directAncestorIds);
  if (expandedPersonIds.has(rootPersonId)) {
    for (const personId of focusedRootFamilyBlockPersonIds(rootPersonId, parentChildEdges, edges)) {
      included.add(personId);
    }
  }
  for (const personId of expandedPersonIds) {
    if (personId === rootPersonId || !included.has(personId)) continue;
    const branchPersonIds = directAncestorIds.has(personId) &&
      shouldUseAncestorCorridorExpansion(rootPersonId, personId, parentChildEdges)
      ? expandedAncestorCorridorPersonIds(rootPersonId, personId, parentChildEdges)
      : withPartners(sideBranchPersonIds(personId, parentChildEdges), edges);
    for (const branchPersonId of branchPersonIds) {
      included.add(branchPersonId);
    }
  }
  return included;
}

function focusedRootFamilyBlockPersonIds(
  rootPersonId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
  edges: FamilyTreeEdgeDto[],
): Set<string> {
  const included = descendantPersonIds(rootPersonId, parentChildEdges);
  for (const personId of focusSiblingDescendantBranchPersonIds(rootPersonId, parentChildEdges)) {
    included.add(personId);
  }
  for (const parentId of parentPersonIds(rootPersonId, parentChildEdges)) {
    for (const personId of focusSiblingDescendantBranchPersonIds(parentId, parentChildEdges)) {
      included.add(personId);
    }
  }
  return withPartners(included, edges);
}

function compactFamilyPersonIds(rootPersonId: string, edges: FamilyTreeEdgeDto[]): Set<string> {
  const parentChildEdges = edges.filter((edge) => edge.kind === "parent_child");
  const included = new Set<string>([rootPersonId]);
  for (const edge of parentChildEdges) {
    if (edge.toPersonId === rootPersonId) included.add(edge.fromPersonId);
    if (edge.fromPersonId === rootPersonId) included.add(edge.toPersonId);
  }
  for (const siblingId of siblingPersonIds(rootPersonId, parentChildEdges)) {
    included.add(siblingId);
  }
  return withPartners(included, edges);
}

function directAncestorPersonIds(
  rootPersonId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): Set<string> {
  const included = new Set<string>([rootPersonId]);
  const queue = [rootPersonId];
  while (queue.length) {
    const childId = queue.shift();
    if (!childId) continue;
    for (const edge of parentChildEdges) {
      if (edge.toPersonId !== childId || included.has(edge.fromPersonId)) continue;
      included.add(edge.fromPersonId);
      queue.push(edge.fromPersonId);
    }
  }
  return included;
}

function descendantPersonIds(
  rootPersonId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): Set<string> {
  const included = new Set<string>([rootPersonId]);
  const queue = [rootPersonId];
  while (queue.length) {
    const parentId = queue.shift();
    if (!parentId) continue;
    for (const edge of parentChildEdges) {
      if (edge.fromPersonId !== parentId || included.has(edge.toPersonId)) continue;
      included.add(edge.toPersonId);
      queue.push(edge.toPersonId);
    }
  }
  return included;
}

function parentPersonIds(personId: string, parentChildEdges: FamilyTreeEdgeDto[]): Set<string> {
  return new Set(parentChildEdges
    .filter((edge) => edge.toPersonId === personId)
    .map((edge) => edge.fromPersonId));
}

function childPersonIds(personId: string, parentChildEdges: FamilyTreeEdgeDto[]): Set<string> {
  return new Set(parentChildEdges
    .filter((edge) => edge.fromPersonId === personId)
    .map((edge) => edge.toPersonId));
}

function descendantPaths(
  fromPersonId: string,
  toPersonId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): string[][] {
  const paths: string[][] = [];
  const queue: string[][] = [[fromPersonId]];
  const maxPaths = 32;
  while (queue.length) {
    const path = queue.shift();
    if (!path) continue;
    const currentPersonId = path[path.length - 1];
    if (currentPersonId === toPersonId) {
      paths.push(path);
      if (paths.length >= maxPaths) break;
      continue;
    }
    for (const childId of childPersonIds(currentPersonId, parentChildEdges)) {
      if (path.includes(childId)) continue;
      queue.push([...path, childId]);
    }
  }
  return paths;
}

function expandedAncestorCorridorPersonIds(
  rootPersonId: string,
  expandedPersonId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): Set<string> {
  const pathsToRoot = descendantPaths(expandedPersonId, rootPersonId, parentChildEdges);
  if (!pathsToRoot.length) return new Set([expandedPersonId]);

  const included = new Set<string>();
  for (const pathToRoot of pathsToRoot) {
    pathToRoot.forEach((personId) => included.add(personId));
    for (let index = 0; index < pathToRoot.length - 1; index += 1) {
      const corridorPersonId = pathToRoot[index];
      for (const childId of childPersonIds(corridorPersonId, parentChildEdges)) {
        included.add(childId);
        for (const parentId of parentPersonIds(childId, parentChildEdges)) {
          included.add(parentId);
        }
      }
    }
  }
  return included;
}

function shouldUseAncestorCorridorExpansion(
  rootPersonId: string,
  expandedPersonId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): boolean {
  const pathsToRoot = descendantPaths(expandedPersonId, rootPersonId, parentChildEdges);
  return pathsToRoot.length > 1 || pathsToRoot.some((pathToRoot) => pathToRoot.length >= 4);
}

function siblingPersonIds(rootPersonId: string, parentChildEdges: FamilyTreeEdgeDto[]): Set<string> {
  const parentIds = new Set(parentChildEdges
    .filter((edge) => edge.toPersonId === rootPersonId)
    .map((edge) => edge.fromPersonId));
  const siblings = new Set<string>();
  if (!parentIds.size) return siblings;
  for (const edge of parentChildEdges) {
    if (edge.toPersonId === rootPersonId) continue;
    if (parentIds.has(edge.fromPersonId)) siblings.add(edge.toPersonId);
  }
  return siblings;
}

function sideBranchPersonIds(personId: string, parentChildEdges: FamilyTreeEdgeDto[]): Set<string> {
  const included = new Set<string>();
  for (const siblingId of siblingPersonIds(personId, parentChildEdges)) {
    if (siblingId === personId) continue;
    included.add(siblingId);
    for (const edge of parentChildEdges) {
      if (edge.fromPersonId !== siblingId) continue;
      included.add(edge.toPersonId);
      for (const parentEdge of parentChildEdges) {
        if (parentEdge.toPersonId === edge.toPersonId) included.add(parentEdge.fromPersonId);
      }
    }
  }
  return included;
}

function immediateChildFamilyPersonIds(
  personId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): Set<string> {
  const included = new Set<string>();
  for (const childId of childPersonIds(personId, parentChildEdges)) {
    included.add(childId);
    for (const parentId of parentPersonIds(childId, parentChildEdges)) {
      if (parentId !== personId) included.add(parentId);
    }
  }
  return included;
}

function focusSiblingDescendantBranchPersonIds(
  personId: string,
  parentChildEdges: FamilyTreeEdgeDto[],
): Set<string> {
  const included = new Set<string>();
  for (const siblingId of siblingPersonIds(personId, parentChildEdges)) {
    if (siblingId === personId) continue;
    for (const descendantId of descendantPersonIds(siblingId, parentChildEdges)) {
      included.add(descendantId);
    }
  }
  return included;
}

function withPartners(personIds: Set<string>, edges: FamilyTreeEdgeDto[]): Set<string> {
  const included = new Set(personIds);
  for (const edge of edges) {
    if (edge.kind !== "partner") continue;
    if (included.has(edge.fromPersonId)) included.add(edge.toPersonId);
    if (included.has(edge.toPersonId)) included.add(edge.fromPersonId);
  }
  return included;
}

function graphWithPeople(
  graph: FamilyTreeGraphDto,
  includedPersonIds: Set<string>,
  mode: FamilyTreeGraphMode,
  expandedPersonIds: Set<string> = new Set(),
): FamilyTreeGraphDto {
  const hiddenSideBranchCounts = hiddenSideBranchCountsByPerson(graph, includedPersonIds, expandedPersonIds);
  const occurrences = graph.occurrences
    .filter((occurrence) => includedPersonIds.has(occurrence.personId))
    .map((occurrence) => ({
      ...occurrence,
      hiddenSideBranchesCount: hiddenSideBranchCounts.get(occurrence.personId) ?? 0,
      sideBranchesExpanded: expandedPersonIds.has(occurrence.personId),
    }));
  const occurrenceIds = new Set(occurrences.map((occurrence) => occurrence.id));
  const nodes = graph.nodes
    .filter((node) => includedPersonIds.has(node.personId))
    .map((node) => ({
      ...node,
      occurrenceIds: node.occurrenceIds.filter((occurrenceId) => occurrenceIds.has(occurrenceId)),
    }));
  const edges = graph.edges.filter((edge) =>
    includedPersonIds.has(edge.fromPersonId) &&
    includedPersonIds.has(edge.toPersonId) &&
    (!edge.fromOccurrenceId || occurrenceIds.has(edge.fromOccurrenceId)) &&
    (!edge.toOccurrenceId || occurrenceIds.has(edge.toOccurrenceId))
  );
  const groups = graph.groups.filter((group) =>
    group.memberIds.some((personId) => includedPersonIds.has(personId)) ||
    group.parentIds.some((personId) => includedPersonIds.has(personId)) ||
    group.childIds.some((personId) => includedPersonIds.has(personId)) ||
    group.partnerIds.some((personId) => includedPersonIds.has(personId)),
  );
  return {
    ...graph,
    mode,
    nodes,
    occurrences,
    edges,
    groups,
    stats: {
      ...graph.stats,
      persons: nodes.length,
      occurrences: occurrences.length,
      edges: edges.length,
      groups: groups.length,
    },
  };
}

function hiddenSideBranchCountsByPerson(
  graph: FamilyTreeGraphDto,
  includedPersonIds: Set<string>,
  expandedPersonIds: Set<string>,
): Map<string, number> {
  const parentChildEdges = graph.edges.filter((edge) => edge.kind === "parent_child");
  const directAncestorIds = graph.rootPersonId
    ? directAncestorPersonIds(graph.rootPersonId, parentChildEdges)
    : new Set<string>();
  const ignoredExpandedLineIds = expandedLinePersonIds(
    expandedPersonIds,
    parentChildEdges,
    graph.edges,
    graph.rootPersonId ?? null,
  );
  const result = new Map<string, number>();
  for (const personId of includedPersonIds) {
    if (expandedPersonIds.has(personId)) continue;
    const branchIds = graph.rootPersonId &&
      personId !== graph.rootPersonId &&
      directAncestorIds.has(personId) &&
      shouldUseAncestorCorridorExpansion(graph.rootPersonId, personId, parentChildEdges)
      ? expandedAncestorCorridorPersonIds(graph.rootPersonId, personId, parentChildEdges)
      : withPartners(sideBranchPersonIds(personId, parentChildEdges), graph.edges);
    if (!directAncestorIds.has(personId)) {
      for (const hiddenFamilyId of immediateChildFamilyPersonIds(personId, parentChildEdges)) {
        branchIds.add(hiddenFamilyId);
      }
    }
    const hiddenIds = [...branchIds]
      .filter((branchPersonId) =>
        !includedPersonIds.has(branchPersonId) &&
        !ignoredExpandedLineIds.has(branchPersonId)
      );
    if (hiddenIds.length) result.set(personId, hiddenIds.length);
  }
  return result;
}

function expandedLinePersonIds(
  expandedPersonIds: Set<string>,
  parentChildEdges: FamilyTreeEdgeDto[],
  edges: FamilyTreeEdgeDto[],
  rootPersonId: string | null = null,
): Set<string> {
  const ignored = new Set<string>();
  for (const personId of expandedPersonIds) {
    for (const ancestorId of directAncestorPersonIds(personId, parentChildEdges)) {
      ignored.add(ancestorId);
    }
    if (rootPersonId && shouldUseAncestorCorridorExpansion(rootPersonId, personId, parentChildEdges)) {
      for (const corridorId of expandedAncestorCorridorPersonIds(rootPersonId, personId, parentChildEdges)) {
        ignored.add(corridorId);
      }
    } else {
      for (const descendantId of descendantPersonIds(personId, parentChildEdges)) {
        ignored.add(descendantId);
      }
    }
  }
  return withPartners(ignored, edges);
}
