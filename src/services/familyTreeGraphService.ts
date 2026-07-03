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
    baseIssues.push(issue("missingRootPerson", "warning", "Family tree has no root person."));
    return emptyGraphDto(query, treeId, data.tree, null, baseIssues);
  }

  const maxDepth = Math.max(0, query.maxDepth ?? DEFAULT_DEPTH);
  const visibleParentChildRelationships = data.parentChildRelationships
    .filter((relationship) => relationshipIsVisible(relationship.evidenceStatus, query));
  const visiblePartnerRelationships = data.partnerRelationships
    .filter((relationship) => relationshipIsVisible(relationship.evidenceStatus, query));
  const visibleAssociationRelationships = data.associationRelationships
    .filter((relationship) => relationshipIsVisible(relationship.evidenceStatus, query));

  const occurrences = finalizeOccurrences(
    createOccurrenceSeeds({
      mode: query.mode,
      rootPersonId,
      maxDepth,
      parentChildRelationships: visibleParentChildRelationships,
      partnerRelationships: visiblePartnerRelationships,
    }),
    data.layoutPositions,
  );
  const occurrencePersonIds = new Set(occurrences.map((occurrence) => occurrence.personId));
  const occurrenceByPerson = firstOccurrenceByPerson(occurrences);
  const nodes = buildNodes(query, data, occurrencePersonIds, occurrences);
  const edges = buildEdges({
    query,
    occurrences,
    occurrenceByPerson,
    parentChildRelationships: data.parentChildRelationships,
    partnerRelationships: data.partnerRelationships,
    associationRelationships: query.includeAssociations ? data.associationRelationships : [],
  });
  const groups = buildGroups(data, occurrencePersonIds);
  const issues = [
    ...baseIssues,
    ...validationIssues(data),
    ...missingPreferredParentSetIssues(data.parentSets, occurrencePersonIds),
    ...repeatedAncestorIssues(query.mode, occurrences),
    ...privateLivingPersonIssues(query, nodes),
    ...persistedIssues(data),
  ];

  return {
    projectId: query.projectId,
    treeId,
    mode: query.mode,
    rootPersonId,
    tree: data.tree,
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
  if (query.rootPersonId) return query.rootPersonId;
  if (data.tree?.rootPersonId) return data.tree.rootPersonId;
  const rootMember = data.treePersons.find((person) => person.memberRole === "root");
  if (rootMember) return rootMember.personId;
  return data.personProfiles[0]?.id ?? data.treePersons[0]?.personId ?? null;
}

function relationshipIsVisible(status: EvidenceStatus, query: FamilyTreeGraphQuery): boolean {
  return status !== "disproven" || query.includeDisproven === true || query.problemsMode === true;
}

function createOccurrenceSeeds(input: {
  mode: FamilyTreeGraphMode;
  rootPersonId: EntityId;
  maxDepth: number;
  parentChildRelationships: ParentChildRelationship[];
  partnerRelationships: PartnerRelationship[];
}): OccurrenceSeed[] {
  switch (input.mode) {
    case "ancestors":
      return ancestorOccurrenceSeeds(input.rootPersonId, input.maxDepth, input.parentChildRelationships);
    case "descendants":
      return descendantOccurrenceSeeds(
        input.rootPersonId,
        input.maxDepth,
        input.parentChildRelationships,
        input.partnerRelationships,
      );
    case "family":
    default:
      return familyOccurrenceSeeds(input.rootPersonId, input.parentChildRelationships, input.partnerRelationships);
  }
}

function familyOccurrenceSeeds(
  rootPersonId: EntityId,
  parentChildRelationships: ParentChildRelationship[],
  partnerRelationships: PartnerRelationship[],
): OccurrenceSeed[] {
  const personIds = new Set<EntityId>([rootPersonId]);
  const rootParentSets = new Set<EntityId>();
  for (const relationship of parentChildRelationships) {
    if (relationship.childId === rootPersonId) personIds.add(relationship.parentId);
    if (relationship.parentId === rootPersonId) {
      personIds.add(relationship.childId);
      rootParentSets.add(relationship.parentSetId);
    }
  }
  for (const relationship of parentChildRelationships) {
    if (rootParentSets.has(relationship.parentSetId)) personIds.add(relationship.parentId);
  }
  for (const relationship of partnerRelationships) {
    if (relationship.personAId === rootPersonId) personIds.add(relationship.personBId);
    if (relationship.personBId === rootPersonId) personIds.add(relationship.personAId);
  }
  return Array.from(personIds).map((personId) => occurrenceSeed("family", [personId], personId, generationForFamily(rootPersonId, personId, parentChildRelationships)));
}

function generationForFamily(
  rootPersonId: EntityId,
  personId: EntityId,
  parentChildRelationships: ParentChildRelationship[],
): number {
  if (personId === rootPersonId) return 0;
  if (parentChildRelationships.some((relationship) => relationship.childId === rootPersonId && relationship.parentId === personId)) {
    return -1;
  }
  if (parentChildRelationships.some((relationship) => relationship.parentId === rootPersonId && relationship.childId === personId)) {
    return 1;
  }
  return 0;
}

function descendantOccurrenceSeeds(
  rootPersonId: EntityId,
  maxDepth: number,
  parentChildRelationships: ParentChildRelationship[],
  partnerRelationships: PartnerRelationship[],
): OccurrenceSeed[] {
  const seeds: OccurrenceSeed[] = [];
  const queue: Array<{ personId: EntityId; path: EntityId[]; depth: number }> = [
    { personId: rootPersonId, path: [rootPersonId], depth: 0 },
  ];
  const visited = new Set<EntityId>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || visited.has(current.personId)) continue;
    visited.add(current.personId);
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
      seeds.push(occurrenceSeed("descendants", [rootPersonId, relationship.personBId], relationship.personBId, 0));
      visited.add(relationship.personBId);
    } else if (visited.has(relationship.personBId) && !visited.has(relationship.personAId)) {
      seeds.push(occurrenceSeed("descendants", [rootPersonId, relationship.personAId], relationship.personAId, 0));
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
    const names = namesByPerson.get(personId) ?? [];
    const primaryName = selectPrimaryName(names);
    const isLiving = profile?.isLiving ?? false;
    const privacyStatus = profile?.privacyStatus ?? "private";
    const redacted = isPrivateLivingPerson(isLiving, privacyStatus) && query.includePrivateLiving !== true;
    return {
      personId,
      displayName: redacted ? "Private living person" : displayNameFor(profile, primaryName, personId),
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
  mode: FamilyTreeGraphMode,
  relationship: ParentChildRelationship,
  occurrences: FamilyTreeOccurrenceDto[],
  occurrenceByPerson: Map<EntityId, FamilyTreeOccurrenceDto>,
): Array<{ from: FamilyTreeOccurrenceDto; to: FamilyTreeOccurrenceDto } | null> {
  if (mode !== "ancestors") {
    const from = occurrenceByPerson.get(relationship.parentId);
    const to = occurrenceByPerson.get(relationship.childId);
    return from && to ? [{ from, to }] : [];
  }

  const byPath = new Map(occurrences.map((occurrence) => [occurrence.path.join(">"), occurrence]));
  const pairs: Array<{ from: FamilyTreeOccurrenceDto; to: FamilyTreeOccurrenceDto }> = [];
  for (const parentOccurrence of occurrences.filter((occurrence) => occurrence.personId === relationship.parentId)) {
    const childPath = parentOccurrence.path.slice(0, -1);
    if (childPath.at(-1) !== relationship.childId) continue;
    const childOccurrence = byPath.get(childPath.join(">"));
    if (childOccurrence) pairs.push({ from: parentOccurrence, to: childOccurrence });
  }
  return pairs;
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
    evidenceStatus: relationship.evidenceStatus,
    confidence: relationship.confidence,
    isBloodline: relationship.isBloodline,
    parentSetId: relationship.parentSetId,
    familyGroupId: relationship.familyGroupId,
    sourceDocumentId: relationship.sourceDocumentId,
    sourceFindingId: relationship.sourceFindingId,
    style,
    metadata: relationship.metadata,
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
    metadata: relationship.metadata,
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
      "Child has several parent sets, but none is preferred for display.",
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

function privateLivingPersonIssues(
  query: FamilyTreeGraphQuery,
  nodes: FamilyTreeNodeDto[],
): FamilyTreeIssueDto[] {
  if (query.includePrivateLiving !== true) return [];
  return nodes
    .filter((node) => isPrivateLivingPerson(node.isLiving, node.privacyStatus) && !node.redacted)
    .map((node) => issue(
      "privateLivingPersonVisible",
      "warning",
      "Private living person is visible in this graph response.",
      { personIds: [node.personId], occurrenceIds: node.occurrenceIds },
    ));
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

function selectPrimaryName(names: FamilyTreePersonName[]): FamilyTreePersonName | null {
  return names.find((name) => name.isPrimary) ?? names.find((name) => name.isPreferred) ?? names[0] ?? null;
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
