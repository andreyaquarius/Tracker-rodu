import type {
  AssociationRelationship,
  EvidenceStatus,
  FamilyTree,
  FamilyTreeEdgeDto,
  FamilyTreeEdgeStyleDto,
  FamilyTreeGraphDto,
  FamilyTreeGraphIssue,
  FamilyTreeGraphIssueCode,
  FamilyTreeGraphMode,
  FamilyTreeGraphQuery,
  FamilyTreeGroupDto,
  FamilyTreeIssueDto,
  FamilyTreeNodeDto,
  FamilyTreeOccurrenceDto,
  FamilyTreePersonName,
  FamilyTreePersonTimelineEvent,
  ParentChildRelationship,
  ParentChildRelationshipType,
  ParentSet,
  PartnerRelationship,
} from "../types/familyTree";
import type { EntityId } from "../types";
import type {
  FamilyTreeGraphRepositoryData,
  FamilyTreePersonProfile,
  TreeLayoutPosition,
} from "./familyTreeGraphRepository";
import { validateFamilyGraph } from "../utils/familyTreeGraph.ts";

type OccurrenceSeed = Omit<FamilyTreeOccurrenceDto, "duplicateIndex" | "isRepeated" | "layout"> & {
  occurrenceKey: string;
};

type RelationshipKind = FamilyTreeEdgeDto["kind"];
type GenealogicalDateValue = {
  raw: string;
  sortValue: number;
  year: number;
};
type PersonLifeFacts = {
  birth: GenealogicalDateValue | null;
  death: GenealogicalDateValue | null;
};

const DEFAULT_DEPTH = 5;
const NON_BIOLOGICAL_PARENT_TYPES = new Set<ParentChildRelationshipType>([
  "adoptive",
  "foster",
  "step",
  "guardian",
  "social_parent",
  "legal_parent",
]);
const BIOLOGICAL_PARENT_TYPES = new Set<ParentChildRelationshipType>([
  "biological",
  "birth_parent",
  "genetic_father",
  "genetic_mother",
]);

export async function getFamilyTreeGraph(query: FamilyTreeGraphQuery): Promise<FamilyTreeGraphDto> {
  const { readFamilyTreeGraphData } = await import("./familyTreeGraphRepository.ts");
  const data = await readFamilyTreeGraphData(query);
  return buildFamilyTreeGraphDto(query, data);
}

export function buildFamilyTreeGraphDto(
  query: FamilyTreeGraphQuery,
  data: FamilyTreeGraphRepositoryData,
): FamilyTreeGraphDto {
  const treeId = data.tree?.id ?? query.treeId ?? "";
  const baseIssues: FamilyTreeIssueDto[] = [];
  if (!data.tree) {
    baseIssues.push(issue("missingTree", "critical", "Family tree was not found."));
    return emptyGraphDto(query, treeId, null, null, baseIssues);
  }

  const rootPersonId = resolveRootPersonId(query, data);
  if (!rootPersonId) {
    baseIssues.push(issue("missingRootPerson", "warning", "Для дерева ще не вибрано центральну особу."));
    return emptyGraphDto(query, treeId, data.tree, null, baseIssues);
  }

  const maxDepth = query.unlimitedDepth ? Number.POSITIVE_INFINITY : Math.max(0, query.maxDepth ?? DEFAULT_DEPTH);
  const maxDepthUp = query.unlimitedDepth ? maxDepth : Math.max(0, query.maxDepthUp ?? maxDepth);
  const maxDepthDown = query.unlimitedDepth ? maxDepth : Math.max(0, query.maxDepthDown ?? maxDepth);
  const visibleParentChildRelationships = normalizeParentChildRelationships(
    data.parentChildRelationships
      .filter((relationship) => relationshipIsVisible(relationship.evidenceStatus, query)),
  );
  const visiblePartnerRelationships = data.partnerRelationships
    .filter((relationship) => relationshipIsVisible(relationship.evidenceStatus, query));
  const visibleAssociationRelationships = data.associationRelationships
    .filter((relationship) => relationshipIsVisible(relationship.evidenceStatus, query));

  const occurrences = annotateHiddenRelativeCounts(
    finalizeOccurrences(
      createOccurrenceSeeds({
        mode: query.mode,
        rootPersonId,
        maxDepth,
        maxDepthUp,
        maxDepthDown,
        parentChildRelationships: visibleParentChildRelationships,
        partnerRelationships: visiblePartnerRelationships,
      }),
      data.layoutPositions,
    ),
    query.mode,
    visibleParentChildRelationships,
  );
  const occurrencePersonIds = new Set(occurrences.map((occurrence) => occurrence.personId));
  const occurrenceByPerson = firstOccurrenceByPerson(occurrences);
  const nodes = buildNodes(query, data, occurrencePersonIds, occurrences);
  const availablePersons = buildNodes(
    query,
    data,
    new Set(data.personProfiles.map((profile) => profile.id)),
    occurrences,
  ).sort((left, right) => left.displayName.localeCompare(right.displayName, "uk"));
  const edges = buildEdges({
    query,
    occurrences,
    occurrenceByPerson,
    parentChildRelationships: visibleParentChildRelationships,
    partnerRelationships: visiblePartnerRelationships,
    associationRelationships: query.includeAssociations ? visibleAssociationRelationships : [],
  });
  const groups = buildGroups(data, occurrencePersonIds);
  const issues = [
    ...baseIssues,
    ...validationIssues(data),
    ...personWithoutNameIssues(data, occurrencePersonIds),
    ...personDateConflictIssues(data, occurrencePersonIds, visibleParentChildRelationships, visiblePartnerRelationships),
    ...potentialDuplicatePersonIssues(data, occurrencePersonIds),
    ...biologicalParentConflictIssues(visibleParentChildRelationships, occurrencePersonIds),
    ...missingPreferredParentSetIssues(data.parentSets, occurrencePersonIds),
    ...repeatedAncestorIssues(query.mode, occurrences),
    ...persistedIssues(data),
  ];

  return {
    projectId: query.projectId,
    treeId,
    mode: query.mode,
    rootPersonId,
    tree: data.tree,
    availablePersons,
    nodes,
    occurrences,
    edges,
    groups,
    issues,
    stats: {
      persons: nodes.length,
      occurrences: occurrences.length,
      edges: edges.length,
      groups: groups.length,
      issues: issues.length,
      repeatedPersons: countRepeatedPersons(occurrences),
      hiddenDisprovenEdges: countHiddenDisprovenEdges(data, query),
    },
  };
}

export function resolveFamilyTreeEdgeStyle(input: {
  kind: RelationshipKind;
  relationshipType: string;
  evidenceStatus: EvidenceStatus;
  isBloodline?: boolean;
  includeDisproven?: boolean;
  problemsMode?: boolean;
}): FamilyTreeEdgeStyleDto {
  if (input.evidenceStatus === "disproven") {
    return {
      lineStyle: "dotted",
      visibility: input.includeDisproven || input.problemsMode ? "faded" : "hidden",
      marker: "disproven",
    };
  }

  if (input.evidenceStatus === "disputed" || input.evidenceStatus === "unknown") {
    return {
      lineStyle: "dotted",
      visibility: "visible",
      marker: "warning",
    };
  }

  if (input.kind === "parent_child") {
    if (NON_BIOLOGICAL_PARENT_TYPES.has(input.relationshipType as ParentChildRelationshipType)) {
      return { lineStyle: "dashed", visibility: "visible" };
    }
    if (BIOLOGICAL_PARENT_TYPES.has(input.relationshipType as ParentChildRelationshipType) || input.isBloodline) {
      return { lineStyle: "solid", visibility: "visible" };
    }
    return { lineStyle: "dotted", visibility: "visible", marker: "warning" };
  }

  if (input.kind === "partner") {
    return {
      lineStyle: input.relationshipType === "marriage" ? "solid" : "dashed",
      visibility: "visible",
    };
  }

  return {
    lineStyle: "dotted",
    visibility: "visible",
  };
}

function emptyGraphDto(
  query: FamilyTreeGraphQuery,
  treeId: EntityId,
  tree: FamilyTree | null,
  rootPersonId: EntityId | null,
  issues: FamilyTreeIssueDto[],
): FamilyTreeGraphDto {
  return {
    projectId: query.projectId,
    treeId,
    mode: query.mode,
    rootPersonId,
    tree,
    availablePersons: [],
    nodes: [],
    occurrences: [],
    edges: [],
    groups: [],
    issues,
    stats: {
      persons: 0,
      occurrences: 0,
      edges: 0,
      groups: 0,
      issues: issues.length,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };
}

function resolveRootPersonId(query: FamilyTreeGraphQuery, data: FamilyTreeGraphRepositoryData): EntityId | null {
  const knownPersonIds = new Set([
    ...data.personProfiles.map((profile) => profile.id),
    ...data.treePersons.map((person) => person.personId),
  ]);
  if (query.rootPersonId && knownPersonIds.has(query.rootPersonId)) return query.rootPersonId;
  const rootMember = stableRootTreeMember(data, knownPersonIds);
  if (!query.rootPersonId && rootMember) return rootMember.personId;
  if (data.tree?.rootPersonId && knownPersonIds.has(data.tree.rootPersonId)) return data.tree.rootPersonId;
  if (rootMember) return rootMember.personId;
  return null;
}

function stableRootTreeMember(
  data: FamilyTreeGraphRepositoryData,
  knownPersonIds: Set<EntityId>,
): FamilyTreeGraphRepositoryData["treePersons"][number] | null {
  const rootMembers = data.treePersons
    .filter((person) => person.memberRole === "root" && knownPersonIds.has(person.personId))
    .sort((left, right) =>
      left.displayOrder - right.displayOrder ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.personId.localeCompare(right.personId),
    );
  return rootMembers[0] ?? null;
}

function relationshipIsVisible(status: EvidenceStatus, query: FamilyTreeGraphQuery): boolean {
  return status !== "disproven" || query.includeDisproven === true || query.problemsMode === true;
}

function normalizeParentChildRelationships(
  relationships: ParentChildRelationship[],
): ParentChildRelationship[] {
  const byPair = new Map<string, ParentChildRelationship>();
  for (const relationship of relationships) {
    const key = [relationship.parentId, relationship.childId].join(">");
    const current = byPair.get(key);
    if (!current || parentChildDisplayPriority(relationship) > parentChildDisplayPriority(current)) {
      byPair.set(key, relationship);
    }
  }
  return Array.from(byPair.values());
}

function parentChildDisplayPriority(relationship: ParentChildRelationship): number {
  let score = 0;
  if (relationship.isPrimaryForDisplay) score += 1000;
  if (relationship.isBloodline) score += 500;
  score += parentChildRelationshipTypePriority(relationship.relationshipType);
  score += evidenceStatusPriority(relationship.evidenceStatus);
  score += relationship.confidence;
  if (relationship.parentRoleLabel !== "parent" && relationship.parentRoleLabel !== "custom") score += 25;
  return score;
}

function parentChildRelationshipTypePriority(type: ParentChildRelationshipType): number {
  switch (type) {
    case "biological":
    case "birth_parent":
    case "genetic_father":
    case "genetic_mother":
      return 300;
    case "adoptive":
    case "legal_parent":
      return 220;
    case "foster":
    case "guardian":
    case "social_parent":
      return 180;
    case "step":
      return 160;
    case "presumed":
    case "unknown":
      return 80;
    case "other":
      return 40;
    default:
      return 100;
  }
}

function evidenceStatusPriority(status: EvidenceStatus): number {
  switch (status) {
    case "proven":
      return 80;
    case "likely":
      return 60;
    case "unknown":
      return 30;
    case "disputed":
      return 10;
    case "disproven":
      return 0;
    default:
      return 0;
  }
}

function createOccurrenceSeeds(input: {
  mode: FamilyTreeGraphMode;
  rootPersonId: EntityId;
  maxDepth: number;
  maxDepthUp: number;
  maxDepthDown: number;
  parentChildRelationships: ParentChildRelationship[];
  partnerRelationships: PartnerRelationship[];
}): OccurrenceSeed[] {
  switch (input.mode) {
    case "ancestors":
      return ancestorOccurrenceSeeds(input.rootPersonId, input.maxDepthUp, input.parentChildRelationships);
    case "descendants":
      return descendantOccurrenceSeeds(
        input.rootPersonId,
        input.maxDepthDown,
        input.parentChildRelationships,
        input.partnerRelationships,
      );
    case "family":
    default:
      return familyOccurrenceSeeds(
        input.rootPersonId,
        input.maxDepthUp,
        input.maxDepthDown,
        input.parentChildRelationships,
        input.partnerRelationships,
      );
  }
}

function familyOccurrenceSeeds(
  rootPersonId: EntityId,
  maxDepthUp: number,
  maxDepthDown: number,
  parentChildRelationships: ParentChildRelationship[],
  partnerRelationships: PartnerRelationship[],
): OccurrenceSeed[] {
  const directAncestorSeeds = ancestorOccurrenceSeeds(rootPersonId, maxDepthUp, parentChildRelationships)
    .map((seed) => ({
      ...seed,
      id: `occ:family:${seed.occurrenceKey}`,
      mode: "family" as FamilyTreeGraphMode,
    }));
  const directAncestorPersonIds = new Set(directAncestorSeeds.map((seed) => seed.personId));
  const connectedSeeds = connectedFamilyOccurrenceSeeds(
    rootPersonId,
    maxDepthUp,
    maxDepthDown,
    parentChildRelationships,
    partnerRelationships,
  );
  return uniqueOccurrenceSeeds([
    ...directAncestorSeeds,
    ...connectedSeeds.filter((seed) =>
      !(seed.generation <= 0 && directAncestorPersonIds.has(seed.personId)),
    ),
  ]).sort((left, right) => {
    if (left.generation !== right.generation) return left.generation - right.generation;
    return left.occurrenceKey.localeCompare(right.occurrenceKey, "uk");
  });
}

function connectedFamilyOccurrenceSeeds(
  rootPersonId: EntityId,
  maxDepthUp: number,
  maxDepthDown: number,
  parentChildRelationships: ParentChildRelationship[],
  partnerRelationships: PartnerRelationship[],
): OccurrenceSeed[] {
  const byChild = groupBy(parentChildRelationships, (relationship) => relationship.childId);
  const byParent = groupBy(parentChildRelationships, (relationship) => relationship.parentId);
  const generationByPerson = new Map<EntityId, number>([[rootPersonId, 0]]);
  const pathByPerson = new Map<EntityId, EntityId[]>([[rootPersonId, [rootPersonId]]]);
  const queue: EntityId[] = [rootPersonId];

  const enqueue = (personId: EntityId, generation: number, path: EntityId[]) => {
    if (generation < 0 ? -generation > maxDepthUp : generation > maxDepthDown) return;
    const currentGeneration = generationByPerson.get(personId);
    const currentPath = pathByPerson.get(personId);
    const isCloser = currentGeneration === undefined || Math.abs(generation) < Math.abs(currentGeneration);
    const isShorterSameGeneration = currentGeneration === generation && (!currentPath || path.length < currentPath.length);
    if (!isCloser && !isShorterSameGeneration) return;
    generationByPerson.set(personId, generation);
    pathByPerson.set(personId, path);
    queue.push(personId);
  };

  while (queue.length) {
    const personId = queue.shift();
    if (!personId) continue;
    const generation = generationByPerson.get(personId) ?? 0;
    const path = pathByPerson.get(personId) ?? [rootPersonId, personId];

    for (const relationship of byChild.get(personId) ?? []) {
      if (path.includes(relationship.parentId)) continue;
      enqueue(relationship.parentId, generation - 1, [...path, relationship.parentId]);
    }

    for (const relationship of byParent.get(personId) ?? []) {
      if (path.includes(relationship.childId)) continue;
      enqueue(relationship.childId, generation + 1, [...path, relationship.childId]);
    }
  }

  for (const relationship of partnerRelationships) {
    const aGeneration = generationByPerson.get(relationship.personAId);
    const bGeneration = generationByPerson.get(relationship.personBId);
    if (aGeneration !== undefined && bGeneration === undefined) {
      generationByPerson.set(relationship.personBId, aGeneration);
      pathByPerson.set(relationship.personBId, [...(pathByPerson.get(relationship.personAId) ?? [rootPersonId]), relationship.personBId]);
    } else if (bGeneration !== undefined && aGeneration === undefined) {
      generationByPerson.set(relationship.personAId, bGeneration);
      pathByPerson.set(relationship.personAId, [...(pathByPerson.get(relationship.personBId) ?? [rootPersonId]), relationship.personAId]);
    }
  }

  return Array.from(generationByPerson.entries())
    .sort(([leftPersonId, leftGeneration], [rightPersonId, rightGeneration]) => {
      if (leftGeneration !== rightGeneration) return leftGeneration - rightGeneration;
      const leftPath = pathByPerson.get(leftPersonId)?.join(">") ?? leftPersonId;
      const rightPath = pathByPerson.get(rightPersonId)?.join(">") ?? rightPersonId;
      return leftPath.localeCompare(rightPath, "uk");
    })
    .map(([personId, generation]) => occurrenceSeed(
      "family",
      pathByPerson.get(personId) ?? [rootPersonId, personId],
      personId,
      generation,
    ));
}

function uniqueOccurrenceSeeds(seeds: OccurrenceSeed[]): OccurrenceSeed[] {
  const result = new Map<string, OccurrenceSeed>();
  for (const seed of seeds) {
    const key = [seed.mode, seed.occurrenceKey, seed.personId].join("|");
    if (!result.has(key)) result.set(key, seed);
  }
  return Array.from(result.values());
}

function descendantOccurrenceSeeds(
  rootPersonId: EntityId,
  maxDepth: number,
  parentChildRelationships: ParentChildRelationship[],
  partnerRelationships: PartnerRelationship[],
): OccurrenceSeed[] {
  const seeds: OccurrenceSeed[] = [];
  const generationByPerson = new Map<EntityId, number>();
  const pathByPerson = new Map<EntityId, EntityId[]>();
  const queue: Array<{ personId: EntityId; path: EntityId[]; depth: number }> = [
    { personId: rootPersonId, path: [rootPersonId], depth: 0 },
  ];
  const visited = new Set<EntityId>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current.personId)) continue;
    visited.add(current.personId);
    generationByPerson.set(current.personId, current.depth);
    pathByPerson.set(current.personId, current.path);
    seeds.push(occurrenceSeed("descendants", current.path, current.personId, current.depth));
    if (current.depth >= maxDepth) continue;
    for (const relationship of parentChildRelationships.filter((item) => item.parentId === current.personId)) {
      if (current.path.includes(relationship.childId)) continue;
      queue.push({
        personId: relationship.childId,
        path: [...current.path, relationship.childId],
        depth: current.depth + 1,
      });
    }
  }

  for (const relationship of partnerRelationships) {
    if (visited.has(relationship.personAId) && !visited.has(relationship.personBId)) {
      const generation = generationByPerson.get(relationship.personAId) ?? 0;
      const path = pathByPerson.get(relationship.personAId) ?? [rootPersonId, relationship.personAId];
      seeds.push(occurrenceSeed("descendants", [...path, relationship.personBId], relationship.personBId, generation));
      visited.add(relationship.personBId);
    } else if (visited.has(relationship.personBId) && !visited.has(relationship.personAId)) {
      const generation = generationByPerson.get(relationship.personBId) ?? 0;
      const path = pathByPerson.get(relationship.personBId) ?? [rootPersonId, relationship.personBId];
      seeds.push(occurrenceSeed("descendants", [...path, relationship.personAId], relationship.personAId, generation));
      visited.add(relationship.personAId);
    }
  }

  return seeds;
}

function ancestorOccurrenceSeeds(
  rootPersonId: EntityId,
  maxDepth: number,
  parentChildRelationships: ParentChildRelationship[],
): OccurrenceSeed[] {
  const seeds: OccurrenceSeed[] = [];
  const queue: Array<{ personId: EntityId; path: EntityId[]; depth: number }> = [
    { personId: rootPersonId, path: [rootPersonId], depth: 0 },
  ];
  while (queue.length) {
    const current = queue.shift();
    if (!current) continue;
    seeds.push(occurrenceSeed("ancestors", current.path, current.personId, -current.depth));
    if (current.depth >= maxDepth) continue;
    for (const relationship of parentChildRelationships.filter((item) => item.childId === current.personId)) {
      if (current.path.includes(relationship.parentId)) continue;
      queue.push({
        personId: relationship.parentId,
        path: [...current.path, relationship.parentId],
        depth: current.depth + 1,
      });
    }
  }
  return seeds;
}

function occurrenceSeed(
  mode: FamilyTreeGraphMode,
  path: EntityId[],
  personId: EntityId,
  generation: number,
): OccurrenceSeed {
  const occurrenceKey = path.join(">");
  return {
    id: `occ:${mode}:${occurrenceKey}`,
    occurrenceKey,
    personId,
    mode,
    path,
    generation,
    depth: Math.abs(generation),
    parentSetId: null,
    familyGroupId: null,
  };
}

function finalizeOccurrences(
  seeds: OccurrenceSeed[],
  positions: TreeLayoutPosition[],
): FamilyTreeOccurrenceDto[] {
  const counts = new Map<EntityId, number>();
  seeds.forEach((seed) => counts.set(seed.personId, (counts.get(seed.personId) ?? 0) + 1));
  const seen = new Map<EntityId, number>();
  const positionByKey = new Map(
    positions.map((position) => [
      [position.viewKey, position.personId, position.occurrenceKey].join("|"),
      position,
    ]),
  );
  return seeds.map((seed) => {
    const duplicateIndex = seen.get(seed.personId) ?? 0;
    seen.set(seed.personId, duplicateIndex + 1);
    const position = positionByKey.get([seed.mode, seed.personId, seed.occurrenceKey].join("|"));
    return {
      id: seed.id,
      personId: seed.personId,
      mode: seed.mode,
      path: seed.path,
      generation: seed.generation,
      depth: seed.depth,
      duplicateIndex,
      isRepeated: (counts.get(seed.personId) ?? 0) > 1,
      familyGroupId: seed.familyGroupId,
      parentSetId: seed.parentSetId,
      layout: position ? {
        x: position.x,
        y: position.y,
        isCollapsed: position.isCollapsed,
      } : undefined,
    };
  });
}

function annotateHiddenRelativeCounts(
  occurrences: FamilyTreeOccurrenceDto[],
  mode: FamilyTreeGraphMode,
  parentChildRelationships: ParentChildRelationship[],
): FamilyTreeOccurrenceDto[] {
  if (!occurrences.length) return occurrences;
  const visiblePersonIds = new Set(occurrences.map((occurrence) => occurrence.personId));
  const parentsByChild = groupBy(parentChildRelationships, (relationship) => relationship.childId);
  const childrenByParent = groupBy(parentChildRelationships, (relationship) => relationship.parentId);
  const showHiddenParents = mode === "ancestors" || mode === "family";
  const showHiddenChildren = mode === "descendants" || mode === "family";

  return occurrences.map((occurrence) => {
    const hiddenParentsCount = showHiddenParents
      ? unique((parentsByChild.get(occurrence.personId) ?? [])
        .map((relationship) => relationship.parentId)
        .filter((personId) => !visiblePersonIds.has(personId))).length
      : 0;
    const hiddenChildrenCount = showHiddenChildren
      ? unique((childrenByParent.get(occurrence.personId) ?? [])
        .map((relationship) => relationship.childId)
        .filter((personId) => !visiblePersonIds.has(personId))).length
      : 0;
    if (!hiddenParentsCount && !hiddenChildrenCount) return occurrence;
    return {
      ...occurrence,
      hiddenParentsCount: hiddenParentsCount || undefined,
      hiddenChildrenCount: hiddenChildrenCount || undefined,
    };
  });
}

function firstOccurrenceByPerson(occurrences: FamilyTreeOccurrenceDto[]): Map<EntityId, FamilyTreeOccurrenceDto> {
  const result = new Map<EntityId, FamilyTreeOccurrenceDto>();
  for (const occurrence of occurrences) {
    if (!result.has(occurrence.personId)) result.set(occurrence.personId, occurrence);
  }
  return result;
}

function buildNodes(
  query: FamilyTreeGraphQuery,
  data: FamilyTreeGraphRepositoryData,
  personIds: Set<EntityId>,
  occurrences: FamilyTreeOccurrenceDto[],
): FamilyTreeNodeDto[] {
  const namesByPerson = groupBy(data.personNames, (name) => name.personId);
  const eventsByPerson = groupBy(data.personTimelineEvents, (event) => event.personId);
  const profileByPerson = new Map(data.personProfiles.map((profile) => [profile.id, profile]));
  const treePersonByPerson = new Map(data.treePersons.map((person) => [person.personId, person]));
  const occurrenceIdsByPerson = groupBy(occurrences, (occurrence) => occurrence.personId);

  return Array.from(personIds).map((personId) => {
    const profile = profileByPerson.get(personId);
    const names = withProfileDerivedNames(namesByPerson.get(personId) ?? [], profile);
    const primaryName = selectPrimaryName(names);
    const isLiving = profile?.isLiving ?? false;
    const privacyStatus = profile?.privacyStatus ?? "private";
    const redacted = isPrivateLivingPerson(isLiving, privacyStatus) && query.includePrivateLiving !== true;
    return {
      personId,
      displayName: redacted ? "Приватна жива особа" : displayNameFor(profile, primaryName, personId),
      primaryName,
      names: redacted ? [] : names,
      events: redacted ? [] : eventsByPerson.get(personId) ?? [],
      gender: profile?.gender ?? "",
      status: profile?.status ?? "",
      isLiving,
      privacyStatus,
      redacted,
      memberRole: treePersonByPerson.get(personId)?.memberRole,
      occurrenceIds: (occurrenceIdsByPerson.get(personId) ?? []).map((occurrence) => occurrence.id),
      metadata: redacted || !profile
        ? {}
        : {
            personProfile: profile,
          },
    };
  });
}

function buildEdges(input: {
  query: FamilyTreeGraphQuery;
  occurrences: FamilyTreeOccurrenceDto[];
  occurrenceByPerson: Map<EntityId, FamilyTreeOccurrenceDto>;
  parentChildRelationships: ParentChildRelationship[];
  partnerRelationships: PartnerRelationship[];
  associationRelationships: AssociationRelationship[];
}): FamilyTreeEdgeDto[] {
  const occurrencePersonIds = new Set(input.occurrences.map((occurrence) => occurrence.personId));
  const edges: FamilyTreeEdgeDto[] = [];
  for (const relationship of input.parentChildRelationships) {
    const style = resolveFamilyTreeEdgeStyle({
      kind: "parent_child",
      relationshipType: relationship.relationshipType,
      evidenceStatus: relationship.evidenceStatus,
      isBloodline: relationship.isBloodline,
      includeDisproven: input.query.includeDisproven,
      problemsMode: input.query.problemsMode,
    });
    if (style.visibility === "hidden") continue;
    for (const pair of parentChildOccurrencePairs(input.query.mode, relationship, input.occurrences, input.occurrenceByPerson)) {
      if (!pair) continue;
      edges.push(edgeFromParentChild(relationship, pair.from.id, pair.to.id, style));
    }
  }

  for (const relationship of input.partnerRelationships) {
    if (!occurrencePersonIds.has(relationship.personAId) || !occurrencePersonIds.has(relationship.personBId)) continue;
    const style = resolveFamilyTreeEdgeStyle({
      kind: "partner",
      relationshipType: relationship.relationshipType,
      evidenceStatus: relationship.evidenceStatus,
      includeDisproven: input.query.includeDisproven,
      problemsMode: input.query.problemsMode,
    });
    if (style.visibility === "hidden") continue;
    const from = input.occurrenceByPerson.get(relationship.personAId);
    const to = input.occurrenceByPerson.get(relationship.personBId);
    edges.push(edgeFromPartner(relationship, from?.id, to?.id, style));
  }

  for (const relationship of input.associationRelationships) {
    if (!occurrencePersonIds.has(relationship.personAId) || !occurrencePersonIds.has(relationship.personBId)) continue;
    const style = resolveFamilyTreeEdgeStyle({
      kind: "association",
      relationshipType: relationship.associationType,
      evidenceStatus: relationship.evidenceStatus,
      includeDisproven: input.query.includeDisproven,
      problemsMode: input.query.problemsMode,
    });
    if (style.visibility === "hidden") continue;
    const from = input.occurrenceByPerson.get(relationship.personAId);
    const to = input.occurrenceByPerson.get(relationship.personBId);
    edges.push(edgeFromAssociation(relationship, from?.id, to?.id, style));
  }

  return edges;
}

function parentChildOccurrencePairs(
  _mode: FamilyTreeGraphMode,
  relationship: ParentChildRelationship,
  occurrences: FamilyTreeOccurrenceDto[],
  occurrenceByPerson: Map<EntityId, FamilyTreeOccurrenceDto>,
): Array<{ from: FamilyTreeOccurrenceDto; to: FamilyTreeOccurrenceDto } | null> {
  const pairs: Array<{ from: FamilyTreeOccurrenceDto; to: FamilyTreeOccurrenceDto }> = [];
  const parentOccurrences = occurrences.filter((occurrence) => occurrence.personId === relationship.parentId);
  const childOccurrences = occurrences.filter((occurrence) => occurrence.personId === relationship.childId);
  for (const parentOccurrence of parentOccurrences) {
    for (const childOccurrence of childOccurrences) {
      if (!areAdjacentParentChildOccurrences(parentOccurrence, childOccurrence, relationship)) continue;
      pairs.push({ from: parentOccurrence, to: childOccurrence });
    }
  }
  if (pairs.length) return pairs;

  const from = occurrenceByPerson.get(relationship.parentId);
  const to = occurrenceByPerson.get(relationship.childId);
  return from && to ? [{ from, to }] : [];
}

function areAdjacentParentChildOccurrences(
  parentOccurrence: FamilyTreeOccurrenceDto,
  childOccurrence: FamilyTreeOccurrenceDto,
  relationship: ParentChildRelationship,
): boolean {
  return pathEquals(childOccurrence.path, [...parentOccurrence.path, relationship.childId]) ||
    pathEquals(parentOccurrence.path, [...childOccurrence.path, relationship.parentId]);
}

function pathEquals(left: EntityId[], right: EntityId[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function edgeFromParentChild(
  relationship: ParentChildRelationship,
  fromOccurrenceId: string | undefined,
  toOccurrenceId: string | undefined,
  style: FamilyTreeEdgeStyleDto,
): FamilyTreeEdgeDto {
  return {
    id: ["parent_child", relationship.id, fromOccurrenceId, toOccurrenceId].filter(Boolean).join(":"),
    kind: "parent_child",
    relationshipId: relationship.id,
    fromPersonId: relationship.parentId,
    toPersonId: relationship.childId,
    fromOccurrenceId,
    toOccurrenceId,
    relationshipType: relationship.relationshipType,
    parentRoleLabel: relationship.parentRoleLabel,
    evidenceStatus: relationship.evidenceStatus,
    confidence: relationship.confidence,
    isBloodline: relationship.isBloodline,
    parentSetId: relationship.parentSetId,
    familyGroupId: relationship.familyGroupId,
    sourceDocumentId: relationship.sourceDocumentId,
    sourceFindingId: relationship.sourceFindingId,
    style,
    metadata: {
      ...relationship.metadata,
      notes: relationship.notes,
      privacyStatus: relationship.privacyStatus,
      sourceDocumentId: relationship.sourceDocumentId,
      sourceFindingId: relationship.sourceFindingId,
    },
  };
}

function edgeFromPartner(
  relationship: PartnerRelationship,
  fromOccurrenceId: string | undefined,
  toOccurrenceId: string | undefined,
  style: FamilyTreeEdgeStyleDto,
): FamilyTreeEdgeDto {
  return {
    id: ["partner", relationship.id, fromOccurrenceId, toOccurrenceId].filter(Boolean).join(":"),
    kind: "partner",
    relationshipId: relationship.id,
    fromPersonId: relationship.personAId,
    toPersonId: relationship.personBId,
    fromOccurrenceId,
    toOccurrenceId,
    relationshipType: relationship.relationshipType,
    evidenceStatus: relationship.evidenceStatus,
    confidence: relationship.confidence,
    familyGroupId: relationship.familyGroupId,
    sourceDocumentId: relationship.sourceDocumentId,
    sourceFindingId: relationship.sourceFindingId,
    style,
    metadata: {
      ...relationship.metadata,
      status: relationship.status,
      startDate: relationship.startDate,
      startPlace: relationship.startPlace,
      endDate: relationship.endDate,
      endPlace: relationship.endPlace,
      notes: relationship.notes,
      privacyStatus: relationship.privacyStatus,
      sourceDocumentId: relationship.sourceDocumentId,
      sourceFindingId: relationship.sourceFindingId,
    },
  };
}

function edgeFromAssociation(
  relationship: AssociationRelationship,
  fromOccurrenceId: string | undefined,
  toOccurrenceId: string | undefined,
  style: FamilyTreeEdgeStyleDto,
): FamilyTreeEdgeDto {
  return {
    id: ["association", relationship.id, fromOccurrenceId, toOccurrenceId].filter(Boolean).join(":"),
    kind: "association",
    relationshipId: relationship.id,
    fromPersonId: relationship.personAId,
    toPersonId: relationship.personBId,
    fromOccurrenceId,
    toOccurrenceId,
    relationshipType: relationship.associationType,
    evidenceStatus: relationship.evidenceStatus,
    confidence: relationship.confidence,
    sourceDocumentId: relationship.sourceDocumentId,
    sourceFindingId: relationship.sourceFindingId,
    style,
    metadata: relationship.metadata,
  };
}

function buildGroups(
  data: FamilyTreeGraphRepositoryData,
  includedPersonIds: Set<EntityId>,
): FamilyTreeGroupDto[] {
  const membersByGroup = groupBy(data.groupMembers, (member) => member.familyGroupId);
  const parentSetsByFamilyGroup = groupBy(data.parentSets, (set) => set.familyGroupId ?? "");
  const parentChildByParentSet = groupBy(data.parentChildRelationships, (relationship) => relationship.parentSetId);
  const groups: FamilyTreeGroupDto[] = [];

  for (const group of data.groups) {
    const members = membersByGroup.get(group.id) ?? [];
    const partnerIds = [group.primaryPartner1Id, group.primaryPartner2Id]
      .filter((id): id is EntityId => Boolean(id));
    const memberIds = unique([...members.map((member) => member.personId), ...partnerIds]);
    if (!memberIds.some((personId) => includedPersonIds.has(personId))) continue;
    const parentSets = parentSetsByFamilyGroup.get(group.id) ?? [];
    groups.push({
      id: group.id,
      treeId: group.treeId,
      groupType: group.groupType,
      label: group.displayLabel,
      primaryPartnerIds: partnerIds,
      partnerIds,
      parentIds: members.filter((member) => member.memberRole === "parent").map((member) => member.personId),
      childIds: members.filter((member) => member.memberRole === "child").map((member) => member.personId),
      memberIds,
      parentSetIds: parentSets.map((set) => set.id),
      metadata: group.metadata,
    });
  }

  for (const parentSet of data.parentSets) {
    const relationships = parentChildByParentSet.get(parentSet.id) ?? [];
    const parentIds = unique(relationships.map((relationship) => relationship.parentId));
    const memberIds = unique([...parentIds, parentSet.childId]);
    if (!memberIds.some((personId) => includedPersonIds.has(personId))) continue;
    groups.push({
      id: parentSet.id,
      treeId: parentSet.treeId,
      groupType: parentSet.setType,
      label: parentSet.notes || parentSet.setType,
      primaryPartnerIds: [],
      partnerIds: [],
      parentIds,
      childIds: [parentSet.childId],
      memberIds,
      parentSetIds: [parentSet.id],
      metadata: parentSet.metadata,
    });
  }

  return groups;
}

function validationIssues(data: FamilyTreeGraphRepositoryData): FamilyTreeIssueDto[] {
  return validateFamilyGraph({
    parentChildRelationships: data.parentChildRelationships,
    partnerRelationships: data.partnerRelationships,
    associationRelationships: data.associationRelationships,
  }).map(mapGraphIssue);
}

function mapGraphIssue(issueValue: FamilyTreeGraphIssue): FamilyTreeIssueDto {
  let code: FamilyTreeGraphIssueCode = issueValue.code;
  if (
    issueValue.code === "parent_child_self_relation" ||
    issueValue.code === "partner_self_relation" ||
    issueValue.code === "association_self_relation"
  ) {
    code = "selfRelationship";
  } else if (issueValue.code === "duplicate_parent_child_relationship") {
    code = "duplicateParentChild";
  } else if (issueValue.code === "bloodline_cycle") {
    code = "biologicalCycle";
  }
  return issue(code, issueValue.severity, issueValue.message, {
    personIds: issueValue.personIds,
    relationshipIds: issueValue.relationshipIds,
  });
}

function personWithoutNameIssues(
  data: FamilyTreeGraphRepositoryData,
  includedPersonIds: Set<EntityId>,
): FamilyTreeIssueDto[] {
  const namesByPerson = groupBy(data.personNames, (name) => name.personId);
  return data.personProfiles
    .filter((profile) => includedPersonIds.has(profile.id))
    .filter((profile) => {
      const profileName = [profile.surname, profile.givenName, profile.patronymic, profile.fullName]
        .map((part) => part.trim())
        .filter(Boolean)
        .join("");
      const nameRecords = namesByPerson.get(profile.id) ?? [];
      const hasNameRecord = nameRecords.some((name) =>
        [name.fullName, name.originalText, name.surname, name.givenName, name.patronymic]
          .map((part) => part.trim())
          .some(Boolean),
      );
      return !profileName && !hasNameRecord;
    })
    .map((profile) => issue(
      "personWithoutName",
      "needs_review",
      "Person has no name fields or name records.",
      { personIds: [profile.id] },
    ));
}

function personDateConflictIssues(
  data: FamilyTreeGraphRepositoryData,
  includedPersonIds: Set<EntityId>,
  parentChildRelationships: ParentChildRelationship[],
  partnerRelationships: PartnerRelationship[],
): FamilyTreeIssueDto[] {
  const issues: FamilyTreeIssueDto[] = [];
  const eventsByPerson = groupBy(data.personTimelineEvents, (event) => event.personId);
  const lifeFactsByPerson = new Map<EntityId, PersonLifeFacts>();
  for (const personId of includedPersonIds) {
    lifeFactsByPerson.set(personId, lifeFactsForPerson(eventsByPerson.get(personId) ?? []));
  }

  for (const [personId, facts] of lifeFactsByPerson) {
    if (facts.birth?.sortValue != null && facts.death?.sortValue != null && facts.death.sortValue < facts.birth.sortValue) {
      issues.push(issue(
        "dateConflict",
        "needs_review",
        "Death date is earlier than birth date.",
        {
          personIds: [personId],
          metadata: {
            kind: "deathBeforeBirth",
            birthDate: facts.birth.raw,
            deathDate: facts.death.raw,
          },
        },
      ));
    }
  }

  for (const relationship of parentChildRelationships) {
    if (!includedPersonIds.has(relationship.parentId) || !includedPersonIds.has(relationship.childId)) continue;
    if (relationship.evidenceStatus === "disproven") continue;
    const parentBirth = lifeFactsByPerson.get(relationship.parentId)?.birth;
    const childBirth = lifeFactsByPerson.get(relationship.childId)?.birth;
    if (parentBirth?.year == null || childBirth?.year == null) continue;
    if (childBirth.year < parentBirth.year) {
      issues.push(issue(
        "parentAgeConflict",
        "needs_review",
        "Child appears to be older than parent.",
        {
          personIds: [relationship.childId, relationship.parentId],
          relationshipIds: [relationship.id],
          metadata: {
            kind: "childOlderThanParent",
            parentBirthYear: parentBirth.year,
            childBirthYear: childBirth.year,
          },
        },
      ));
    }
  }

  for (const relationship of partnerRelationships) {
    if (!includedPersonIds.has(relationship.personAId) || !includedPersonIds.has(relationship.personBId)) continue;
    if (relationship.evidenceStatus === "disproven") continue;
    const start = parseGenealogicalDate(relationship.startDate);
    if (!start) continue;
    const partnerBirths = [
      lifeFactsByPerson.get(relationship.personAId)?.birth,
      lifeFactsByPerson.get(relationship.personBId)?.birth,
    ];
    if (partnerBirths.some((birth) => birth?.sortValue != null && start.sortValue < birth.sortValue)) {
      issues.push(issue(
        "dateConflict",
        "needs_review",
        "Partner relationship date is earlier than a partner birth date.",
        {
          personIds: [relationship.personAId, relationship.personBId],
          relationshipIds: [relationship.id],
          metadata: {
            kind: "relationshipBeforeBirth",
            relationshipDate: relationship.startDate,
          },
        },
      ));
    }
  }

  return issues;
}

function potentialDuplicatePersonIssues(
  data: FamilyTreeGraphRepositoryData,
  includedPersonIds: Set<EntityId>,
): FamilyTreeIssueDto[] {
  const eventsByPerson = groupBy(data.personTimelineEvents, (event) => event.personId);
  const namesByPerson = groupBy(data.personNames, (name) => name.personId);
  const groups = new Map<string, EntityId[]>();

  for (const profile of data.personProfiles) {
    if (!includedPersonIds.has(profile.id)) continue;
    const normalizedName = normalizePersonNameForDuplicate(profile, namesByPerson.get(profile.id) ?? []);
    if (normalizedName.length < 5) continue;
    const facts = lifeFactsForPerson(eventsByPerson.get(profile.id) ?? []);
    const birthKey = facts.birth?.year != null ? String(facts.birth.year) : "unknown";
    const key = `${normalizedName}|${birthKey}`;
    groups.set(key, [...(groups.get(key) ?? []), profile.id]);
  }

  const issues: FamilyTreeIssueDto[] = [];
  for (const [key, personIds] of groups) {
    if (personIds.length < 2) continue;
    const [nameKey, birthYear] = key.split("|");
    issues.push(issue(
      "potentialDuplicatePerson",
      "needs_review",
      "Several people have the same name and matching or missing birth year.",
      {
        personIds,
        metadata: {
          normalizedName: nameKey,
          birthYear,
        },
      },
    ));
  }
  return issues;
}

function biologicalParentConflictIssues(
  relationships: ParentChildRelationship[],
  includedPersonIds: Set<EntityId>,
): FamilyTreeIssueDto[] {
  const issues: FamilyTreeIssueDto[] = [];
  const relationshipsByChild = groupBy(
    relationships.filter((relationship) =>
      includedPersonIds.has(relationship.childId) &&
      relationship.evidenceStatus !== "disproven" &&
      isBiologicalParentRelationship(relationship),
    ),
    (relationship) => relationship.childId,
  );

  for (const [childId, childRelationships] of relationshipsByChild) {
    const fathers = childRelationships.filter((relationship) => parentRoleSide(relationship) === "father");
    const mothers = childRelationships.filter((relationship) => parentRoleSide(relationship) === "mother");
    if (fathers.length > 1) {
      issues.push(issue(
        "multipleBiologicalFathers",
        "needs_review",
        "Child has more than one biological father relationship.",
        {
          personIds: unique([childId, ...fathers.map((relationship) => relationship.parentId)]),
          relationshipIds: fathers.map((relationship) => relationship.id),
        },
      ));
    }
    if (mothers.length > 1) {
      issues.push(issue(
        "multipleBiologicalMothers",
        "needs_review",
        "Child has more than one biological mother relationship.",
        {
          personIds: unique([childId, ...mothers.map((relationship) => relationship.parentId)]),
          relationshipIds: mothers.map((relationship) => relationship.id),
        },
      ));
    }
  }

  return issues;
}

function isBiologicalParentRelationship(relationship: ParentChildRelationship): boolean {
  return relationship.isBloodline ||
    relationship.relationshipType === "biological" ||
    relationship.relationshipType === "birth_parent" ||
    relationship.relationshipType === "genetic_father" ||
    relationship.relationshipType === "genetic_mother";
}

function parentRoleSide(relationship: ParentChildRelationship): "father" | "mother" | "parent" {
  if (relationship.relationshipType === "genetic_father") return "father";
  if (relationship.relationshipType === "genetic_mother") return "mother";
  if (["father", "stepfather", "adoptive_father"].includes(relationship.parentRoleLabel)) return "father";
  if (["mother", "stepmother", "adoptive_mother"].includes(relationship.parentRoleLabel)) return "mother";
  return "parent";
}

function missingPreferredParentSetIssues(
  parentSets: ParentSet[],
  includedPersonIds: Set<EntityId>,
): FamilyTreeIssueDto[] {
  const issues: FamilyTreeIssueDto[] = [];
  for (const [childId, sets] of groupBy(parentSets, (set) => set.childId)) {
    if (!includedPersonIds.has(childId) || sets.length < 2) continue;
    if (sets.some((set) => set.isPreferredForDisplay || set.isDefaultForPedigree)) continue;
    issues.push(issue(
      "missingPreferredParentSet",
      "needs_review",
      "Для дитини вказано кілька варіантів батьківства, але не позначено, яких батьків показувати основними.",
      { personIds: [childId], relationshipIds: sets.map((set) => set.id) },
    ));
  }
  return issues;
}

function repeatedAncestorIssues(
  mode: FamilyTreeGraphMode,
  occurrences: FamilyTreeOccurrenceDto[],
): FamilyTreeIssueDto[] {
  if (mode !== "ancestors") return [];
  const byPerson = groupBy(occurrences, (occurrence) => occurrence.personId);
  const issues: FamilyTreeIssueDto[] = [];
  for (const [personId, personOccurrences] of byPerson) {
    if (personOccurrences.length < 2) continue;
    issues.push(issue(
      "repeatedAncestor",
      "info",
      "The same ancestor appears in more than one branch.",
      {
        personIds: [personId],
        occurrenceIds: personOccurrences.map((occurrence) => occurrence.id),
      },
    ));
  }
  return issues;
}

function persistedIssues(data: FamilyTreeGraphRepositoryData): FamilyTreeIssueDto[] {
  return data.researchIssues.map((record) => issue(
    record.issueType,
    record.severity,
    record.title || record.description || record.issueType,
    {
      personIds: record.personId ? [record.personId] : [],
      relationshipIds: record.relationshipId ? [record.relationshipId] : [],
      metadata: {
        source: "family_tree_research_issues",
        status: record.status,
        relationshipTable: record.relationshipTable,
        description: record.description,
        ...record.metadata,
      },
    },
  ));
}

function countHiddenDisprovenEdges(
  data: FamilyTreeGraphRepositoryData,
  query: FamilyTreeGraphQuery,
): number {
  if (query.includeDisproven || query.problemsMode) return 0;
  return [
    ...data.parentChildRelationships,
    ...data.partnerRelationships,
    ...data.associationRelationships,
  ].filter((relationship) => relationship.evidenceStatus === "disproven").length;
}

function countRepeatedPersons(occurrences: FamilyTreeOccurrenceDto[]): number {
  return Array.from(groupBy(occurrences, (occurrence) => occurrence.personId).values())
    .filter((personOccurrences) => personOccurrences.length > 1)
    .length;
}

function lifeFactsForPerson(events: FamilyTreePersonTimelineEvent[]): PersonLifeFacts {
  return {
    birth: firstDateValue(events, ["birth", "baptism", "christening"]),
    death: firstDateValue(events, ["death", "burial", "cremation"]),
  };
}

function firstDateValue(
  events: FamilyTreePersonTimelineEvent[],
  eventTypes: string[],
): GenealogicalDateValue | null {
  for (const event of events) {
    if (!eventTypes.includes(event.eventType)) continue;
    const parsed = parseGenealogicalDate(event.eventDate || event.dateFrom || event.dateText);
    if (parsed) return parsed;
  }
  return null;
}

function parseGenealogicalDate(value: string): GenealogicalDateValue | null {
  const raw = value.trim();
  if (!raw) return null;
  const iso = raw.match(/\b(1[0-9]{3}|20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\b/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return { raw, year, sortValue: year * 10000 + month * 100 + day };
  }

  const dotted = raw.match(/\b(0?[1-9]|[12][0-9]|3[01])[./](0?[1-9]|1[0-2])[./](1[0-9]{3}|20[0-9]{2})\b/);
  if (dotted) {
    const day = Number(dotted[1]);
    const month = Number(dotted[2]);
    const year = Number(dotted[3]);
    return { raw, year, sortValue: year * 10000 + month * 100 + day };
  }

  const yearOnly = raw.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  if (!yearOnly) return null;
  const year = Number(yearOnly[1]);
  return { raw, year, sortValue: year * 10000 };
}

function normalizePersonNameForDuplicate(
  profile: FamilyTreePersonProfile,
  names: FamilyTreePersonName[],
): string {
  const nameRecord = names.find((name) => name.isPrimary || name.isPreferred) ?? names[0] ?? null;
  const source = nameRecord?.fullName || nameRecord?.originalText || profile.fullName ||
    [profile.surname, profile.givenName, profile.patronymic].filter(Boolean).join(" ");
  return source
    .toLocaleLowerCase("uk")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function selectPrimaryName(names: FamilyTreePersonName[]): FamilyTreePersonName | null {
  return names.find((name) => name.isPrimary) ?? names.find((name) => name.isPreferred) ?? names[0] ?? null;
}

function withProfileDerivedNames(
  names: FamilyTreePersonName[],
  profile: FamilyTreePersonProfile | undefined,
): FamilyTreePersonName[] {
  const maidenSurname = profile?.maidenSurname?.trim() ?? "";
  if (!profile || !maidenSurname || maidenSurname === profile.surname.trim()) return names;
  if (names.some((name) => name.nameType === "birth" && name.surname.trim() === maidenSurname)) return names;
  const fullName = [maidenSurname, profile.givenName, profile.patronymic]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return [
    ...names,
    {
      id: `profile-maiden-name:${profile.id}`,
      projectId: profile.projectId,
      personId: profile.id,
      nameType: "birth",
      languageCode: "uk",
      scriptCode: "Cyrl",
      surname: maidenSurname,
      givenName: profile.givenName,
      patronymic: profile.patronymic,
      fullName,
      originalText: fullName || maidenSurname,
      isPrimary: false,
      isPreferred: false,
      evidenceStatus: "unknown",
      confidence: 0,
      sourceDocumentId: null,
      sourceFindingId: null,
      notes: "",
      metadata: { source: "persons.custom_fields.maidenSurname" },
      createdAt: "",
      updatedAt: "",
    },
  ];
}

function displayNameFor(
  profile: FamilyTreePersonProfile | undefined,
  primaryName: FamilyTreePersonName | null,
  fallbackId: EntityId,
): string {
  const fromName = primaryName?.fullName || primaryName?.originalText;
  if (fromName) return fromName;
  const fromProfile = [profile?.surname, profile?.givenName, profile?.patronymic]
    .map((part) => part?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
  return fromProfile || profile?.fullName || fallbackId;
}

function isPrivateLivingPerson(isLiving: boolean, privacyStatus: string): boolean {
  return isLiving && (privacyStatus === "private" || privacyStatus === "confidential");
}

function issue(
  code: FamilyTreeGraphIssueCode,
  severity: FamilyTreeIssueDto["severity"],
  message: string,
  options: {
    personIds?: EntityId[];
    relationshipIds?: EntityId[];
    occurrenceIds?: string[];
    metadata?: Record<string, unknown>;
  } = {},
): FamilyTreeIssueDto {
  return {
    code,
    severity,
    message,
    personIds: options.personIds ?? [],
    relationshipIds: options.relationshipIds ?? [],
    occurrenceIds: options.occurrenceIds ?? [],
    metadata: options.metadata ?? {},
  };
}

function groupBy<T, K>(items: T[], getKey: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const values = grouped.get(key) ?? [];
    values.push(item);
    grouped.set(key, values);
  }
  return grouped;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
