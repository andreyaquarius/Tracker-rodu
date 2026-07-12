import type {
  FamilyGraphData,
  FamilyTreeLayoutOptions,
  LayoutNode,
  LayoutWarning,
  OccurrenceId,
  ParentChildRelation,
  ParentRelationshipKind,
  PersonId,
  TreeContinuation,
  TreeUnion,
  UnionId,
} from "../types.ts";
import {
  buildGraphIndex,
  compareCodePoints,
  comparePeople,
  comparePeopleByBirth,
  compareRelations,
  parentRoleOrder,
  type GraphIndex,
} from "./graphIndex.ts";
import {
  continuationOccurrenceId,
  extendPath,
  personOccurrenceId,
  placeholderOccurrenceId,
  rootPath,
  unionOccurrenceId,
} from "./occurrenceIds.ts";

export interface SceneNode extends LayoutNode {
  focusDistance: number;
  sex?: "male" | "female" | "other" | "unknown" | undefined;
  sourceOccurrenceId?: OccurrenceId;
  direction?: TreeContinuation["direction"];
}

export interface SceneUnion {
  occurrenceId: OccurrenceId;
  unionId: UnionId;
  kind: TreeUnion["kind"];
  familyGroupId?: string;
  status?: TreeUnion["status"];
  generation: number;
  memberOccurrenceIds: OccurrenceId[];
  childOccurrenceIds: OccurrenceId[];
  relationByChildOccurrenceId: Map<OccurrenceId, ParentChildRelation[]>;
  orderKey: string;
}

export interface OccurrenceScene {
  nodes: SceneNode[];
  unions: SceneUnion[];
  warnings: LayoutWarning[];
  primaryOccurrenceByPersonId: ReadonlyMap<PersonId, OccurrenceId>;
  focusOccurrenceId?: OccurrenceId;
}

type Trend = "root" | "up" | "down" | "side" | "partner";

interface QueueItem {
  occurrenceId: OccurrenceId;
  personId: PersonId;
  generation: number;
  path: string;
  pathPeople: readonly PersonId[];
  orderKey: string;
  trend: Trend;
  collateralCost: number;
  focusDistance: number;
}

interface NormalizedOptions {
  focusPersonId: PersonId;
  ancestorDepth: number;
  descendantDepth: number;
  collateralDepth: number;
  maxVisibleNodes: number;
  showAllParentSets: boolean;
  showUnknownParentPlaceholders: boolean;
  activeParentSetByChild: Readonly<Record<PersonId, UnionId>>;
  collapsedPersonIds: ReadonlySet<PersonId>;
  cardWidth: number;
  cardHeight: number;
}

interface SceneBuilderState {
  graph: FamilyGraphData;
  index: GraphIndex;
  options: NormalizedOptions;
  nodes: SceneNode[];
  nodesById: Map<OccurrenceId, SceneNode>;
  unionsByKey: Map<string, SceneUnion>;
  warnings: LayoutWarning[];
  warningKeys: Set<string>;
  primaryByPerson: Map<PersonId, OccurrenceId>;
  contextOccurrence: Map<string, OccurrenceId>;
  queue: QueueItem[];
  queued: Set<OccurrenceId>;
  processed: Set<OccurrenceId>;
  visiblePersonCards: number;
  budgetReached: boolean;
}

const PARENT_KIND_PRIORITY: Readonly<Record<ParentRelationshipKind, number>> = {
  biological: 0,
  genetic_father: 1,
  genetic_mother: 1,
  gestational_parent: 1,
  birth_parent: 1,
  presumed: 2,
  adoptive: 3,
  legal_parent: 4,
  social_parent: 5,
  foster: 6,
  guardian: 7,
  step: 8,
  donor: 9,
  surrogate: 10,
  unknown: 11,
  other: 12,
};

function numberKey(value: number): string {
  return String(value).padStart(6, "0");
}

function normalizeOptions(options: FamilyTreeLayoutOptions): NormalizedOptions {
  const finiteInteger = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : fallback;
  const finitePositive = (value: number | undefined, fallback: number): number =>
    Number.isFinite(value) ? Math.max(1, value!) : fallback;

  return {
    focusPersonId: options.focusPersonId,
    ancestorDepth: finiteInteger(options.ancestorDepth, 7),
    descendantDepth: finiteInteger(options.descendantDepth, 0),
    collateralDepth: finiteInteger(options.collateralDepth, 0),
    maxVisibleNodes: finiteInteger(options.maxVisibleNodes, 400) || 1,
    showAllParentSets: options.showAllParentSets ?? false,
    showUnknownParentPlaceholders:
      options.showUnknownParentPlaceholders ?? true,
    activeParentSetByChild: options.activeParentSetByChild ?? {},
    collapsedPersonIds: new Set(options.collapsedPersonIds ?? []),
    cardWidth: finitePositive(options.cardWidth, 156),
    cardHeight: finitePositive(options.cardHeight, 166),
  };
}

function addWarning(
  state: SceneBuilderState,
  key: string,
  warning: LayoutWarning,
): void {
  if (state.warningKeys.has(key)) return;
  state.warningKeys.add(key);
  state.warnings.push(warning);
}

function canUseGeneration(state: SceneBuilderState, generation: number): boolean {
  return (
    generation <= state.options.ancestorDepth &&
    generation >= -state.options.descendantDepth
  );
}

function getUnionMembers(
  state: SceneBuilderState,
  union: TreeUnion,
): readonly PersonId[] {
  const explicit = [...new Set(union.memberIds)].filter(id =>
    state.index.personsById.has(id),
  );
  if (explicit.length > 0) return explicit;
  const relations = state.index.relationsByUnionId.get(union.id) ?? [];
  return [...new Set(relations.map(relation => relation.parentId))].sort(
    compareCodePoints,
  );
}

function allRelationGroupsForChild(
  state: SceneBuilderState,
  childId: PersonId,
): Array<{ union: TreeUnion; relations: ParentChildRelation[] }> {
  const relations = state.index.relationsByChildId.get(childId) ?? [];
  const grouped = new Map<string, ParentChildRelation[]>();
  for (const relation of relations) {
    const key = relation.unionId ?? `derived:${relation.id}`;
    const values = grouped.get(key);
    if (values) values.push(relation);
    else grouped.set(key, [relation]);
  }

  const result: Array<{ union: TreeUnion; relations: ParentChildRelation[] }> = [];
  for (const [unionId, groupedRelations] of grouped) {
    groupedRelations.sort(compareRelations);
    const indexed = state.index.unionsById.get(unionId);
    const union: TreeUnion = indexed ?? {
        id: unionId,
        kind: "parent-set",
        memberIds: groupedRelations.map(relation => relation.parentId),
        expectedParentSlots: 2,
        ...(groupedRelations[0]?.displayOrder
          ? { displayOrder: groupedRelations[0].displayOrder }
          : {}),
      };
    result.push({ union, relations: groupedRelations });
  }

  result.sort((a, b) => {
    const preferredA = a.relations.some(relation => relation.isPreferred) ? 0 : 1;
    const preferredB = b.relations.some(relation => relation.isPreferred) ? 0 : 1;
    const priorityA = Math.min(
      ...a.relations.map(relation => PARENT_KIND_PRIORITY[relation.kind]),
    );
    const priorityB = Math.min(
      ...b.relations.map(relation => PARENT_KIND_PRIORITY[relation.kind]),
    );
    return (
      preferredA - preferredB ||
      priorityA - priorityB ||
      compareCodePoints(a.union.displayOrder ?? "\uffff", b.union.displayOrder ?? "\uffff") ||
      compareCodePoints(a.union.id, b.union.id)
    );
  });

  return result;
}

function findExistingOccurrence(
  state: SceneBuilderState,
  personId: PersonId,
  generation: number,
): OccurrenceId | undefined {
  const candidates = state.nodes
    .filter(
      node =>
        node.personId === personId &&
        node.generation === generation &&
        (node.kind === "person" || node.kind === "reference"),
    )
    .sort((a, b) => compareCodePoints(a.occurrenceId, b.occurrenceId));
  return candidates[0]?.occurrenceId;
}

function addPersonOccurrence(
  state: SceneBuilderState,
  input: Omit<QueueItem, "occurrenceId"> & {
    contextKey: string;
    expandable: boolean;
    referenceReason?: SceneNode["referenceReason"];
  },
): OccurrenceId | undefined {
  const existingContext = state.contextOccurrence.get(input.contextKey);
  if (existingContext) return existingContext;

  const person = state.index.personsById.get(input.personId);
  if (!person) {
    addWarning(state, `missing:${input.personId}`, {
      code: "MISSING_PERSON",
      message: `У графі відсутня особа ${input.personId}.`,
      personIds: [input.personId],
    });
    return undefined;
  }

  if (state.visiblePersonCards >= state.options.maxVisibleNodes) {
    state.budgetReached = true;
    return undefined;
  }

  const primaryId = state.primaryByPerson.get(input.personId);
  const isReference = primaryId !== undefined;
  const occurrenceId = personOccurrenceId(
    input.personId,
    input.path,
    isReference,
  );
  const node: SceneNode = {
    occurrenceId,
    personId: input.personId,
    kind: isReference ? "reference" : "person",
    generation: input.generation,
    x: 0,
    y: 0,
    width: state.options.cardWidth,
    height: state.options.cardHeight,
    orderKey: input.orderKey,
    focusDistance: input.focusDistance,
    ...(primaryId ? { referenceToOccurrenceId: primaryId } : {}),
    ...(isReference
      ? {
          referenceReason:
            input.referenceReason ?? "already-visible",
        }
      : {}),
    ...(person.sex ? { sex: person.sex } : {}),
  };

  state.nodes.push(node);
  state.nodesById.set(occurrenceId, node);
  state.contextOccurrence.set(input.contextKey, occurrenceId);
  state.visiblePersonCards += 1;

  if (!isReference) {
    state.primaryByPerson.set(input.personId, occurrenceId);
  } else {
    const primary = state.nodesById.get(primaryId);
    if (primary && primary.generation !== input.generation) {
      addWarning(
        state,
        `generation:${input.personId}:${primary.generation}:${input.generation}`,
        {
          code: "GENERATION_CONFLICT",
          message:
            "Одна особа входить у видиму схему на різній відстані від фокусної особи; створено довідкову картку.",
          personIds: [input.personId],
        },
      );
    }
  }

  if (!isReference && input.expandable && !state.queued.has(occurrenceId)) {
    state.queued.add(occurrenceId);
    state.queue.push({
      occurrenceId,
      personId: input.personId,
      generation: input.generation,
      path: input.path,
      pathPeople: input.pathPeople,
      orderKey: input.orderKey,
      trend: input.trend,
      collateralCost: input.collateralCost,
      focusDistance: input.focusDistance,
    });
  }
  return occurrenceId;
}

function ensureUnion(
  state: SceneBuilderState,
  union: TreeUnion,
  parentGeneration: number,
  orderKey: string,
): SceneUnion {
  const key = `${union.id}@${parentGeneration}`;
  const existing = state.unionsByKey.get(key);
  if (existing) return existing;
  const created: SceneUnion = {
    occurrenceId: unionOccurrenceId(union.id, parentGeneration),
    unionId: union.id,
    kind: union.kind,
    ...(union.familyGroupId ? { familyGroupId: union.familyGroupId } : {}),
    status: union.status,
    generation: parentGeneration - 0.5,
    memberOccurrenceIds: [],
    childOccurrenceIds: [],
    relationByChildOccurrenceId: new Map(),
    orderKey,
  };
  state.unionsByKey.set(key, created);
  return created;
}

function uniquePush(values: OccurrenceId[], value: OccurrenceId | undefined): void {
  if (value && !values.includes(value)) values.push(value);
}

function addContinuation(
  state: SceneBuilderState,
  source: SceneNode,
  continuation: TreeContinuation,
  generation: number,
  orderKey: string,
): void {
  const sameDirection = state.nodes.find(
    node =>
      node.kind === "continuation" &&
      node.sourceOccurrenceId === source.occurrenceId &&
      node.direction === continuation.direction,
  );
  if (sameDirection) {
    const currentToken = sameDirection.continuation?.token ?? "";
    if (currentToken.endsWith(":collapsed")) return;
    const currentIsLocal = currentToken.startsWith("local:");
    const nextIsLocal = continuation.token.startsWith("local:");
    // Server cursors carry the authoritative page and hidden count. They
    // replace a layout-only marker instead of creating a second plus button.
    if (currentIsLocal && !nextIsLocal) {
      sameDirection.continuation = continuation;
      sameDirection.orderKey = orderKey;
    }
    return;
  }
  const occurrenceId = continuationOccurrenceId(
    source.occurrenceId,
    continuation.id,
  );
  if (state.nodesById.has(occurrenceId)) return;
  const node: SceneNode = {
    occurrenceId,
    kind: "continuation",
    generation,
    x: 0,
    y: 0,
    width: 28,
    height: 28,
    orderKey,
    continuation,
    focusDistance: source.focusDistance + 1,
    sourceOccurrenceId: source.occurrenceId,
    direction: continuation.direction,
  };
  state.nodes.push(node);
  state.nodesById.set(occurrenceId, node);
}

function localContinuation(
  state: SceneBuilderState,
  source: SceneNode,
  direction: TreeContinuation["direction"],
  generation: number,
  hiddenCount: number | undefined,
  suffix: string,
): void {
  const continuation: TreeContinuation = {
    id: `local:${source.occurrenceId}:${direction}:${suffix}`,
    personId: source.personId!,
    direction,
    token: `local:${direction}:${source.personId}:${suffix}`,
    ...(hiddenCount === undefined ? {} : { hiddenCount }),
  };
  addContinuation(
    state,
    source,
    continuation,
    generation,
    `${source.orderKey}|Z:${direction}:${suffix}`,
  );
}

function nextTrend(
  current: QueueItem,
  direction: "parent" | "child",
): { trend: Trend; collateralCost: number } {
  if (direction === "parent") {
    if (current.trend === "root" || current.trend === "up") {
      return { trend: "up", collateralCost: current.collateralCost };
    }
    if (current.trend === "side") {
      return { trend: "side", collateralCost: current.collateralCost };
    }
    return { trend: "side", collateralCost: current.collateralCost + 1 };
  }
  if (current.trend === "root" || current.trend === "down") {
    return { trend: "down", collateralCost: current.collateralCost };
  }
  if (current.trend === "side") {
    return { trend: "side", collateralCost: current.collateralCost };
  }
  return { trend: "side", collateralCost: current.collateralCost + 1 };
}

function addParentGroups(state: SceneBuilderState, current: QueueItem): void {
  const currentNode = state.nodesById.get(current.occurrenceId)!;
  const allGroups = allRelationGroupsForChild(state, current.personId);
  if (allGroups.length === 0) return;

  if (current.generation >= state.options.ancestorDepth) {
    localContinuation(
      state,
      currentNode,
      "parents",
      current.generation + 1,
      allGroups.reduce((sum, group) => sum + group.relations.length, 0),
      "depth",
    );
    return;
  }

  const selectedParentSet =
    state.options.activeParentSetByChild[current.personId];
  const selectedMatch = selectedParentSet
    ? allGroups.filter(group => group.union.id === selectedParentSet).slice(0, 1)
    : [];
  const selectedGroups = selectedParentSet
    ? selectedMatch.length > 0
      ? selectedMatch
      : allGroups.slice(0, 1)
    : state.options.showAllParentSets
      ? allGroups
      : allGroups.slice(0, 1);
  if (!state.options.showAllParentSets && allGroups.length > selectedGroups.length) {
    localContinuation(
      state,
      currentNode,
      "parents",
      current.generation + 1,
      allGroups.length - selectedGroups.length,
      "other-parent-sets",
    );
  }

  // Multiple semantic parent sets for the same child can contain the same
  // canonical parent. They share one card; a reference is reserved for the
  // same ancestor reached through a different child/ancestral branch.
  const parentOccurrenceById = new Map<PersonId, OccurrenceId>();
  selectedGroups.forEach((group, groupIndex) => {
    const parentGeneration = current.generation + 1;
    const union = ensureUnion(
      state,
      group.union,
      parentGeneration,
      `${current.orderKey}|A:${numberKey(groupIndex)}`,
    );
    uniquePush(union.childOccurrenceIds, current.occurrenceId);
    union.relationByChildOccurrenceId.set(
      current.occurrenceId,
      group.relations,
    );

    const sortedRelations = [...group.relations].sort((a, b) => {
      const order =
        parentRoleOrder(
          state.index.personsById.get(a.parentId),
          a,
        ) -
        parentRoleOrder(state.index.personsById.get(b.parentId), b);
      return order || compareRelations(a, b);
    });

    sortedRelations.forEach((relation, parentIndex) => {
      const existingMember = union.memberOccurrenceIds.find(occurrenceId =>
        state.nodesById.get(occurrenceId)?.personId === relation.parentId,
      );
      const reusableOccurrence =
        parentOccurrenceById.get(relation.parentId) ?? existingMember;
      if (reusableOccurrence) {
        parentOccurrenceById.set(relation.parentId, reusableOccurrence);
        uniquePush(union.memberOccurrenceIds, reusableOccurrence);
        return;
      }
      const expandedBranchOccurrence = relation.ownerBranchKey
        ? findExistingOccurrence(state, relation.parentId, parentGeneration)
        : undefined;
      if (expandedBranchOccurrence) {
        parentOccurrenceById.set(relation.parentId, expandedBranchOccurrence);
        uniquePush(union.memberOccurrenceIds, expandedBranchOccurrence);
        return;
      }
      const path = extendPath(
        current.path,
        "parent",
        relation.id,
        relation.parentId,
      );
      const inTrail = current.pathPeople.includes(relation.parentId);
      const occurrenceId = addPersonOccurrence(state, {
        personId: relation.parentId,
        generation: parentGeneration,
        path,
        pathPeople: [...current.pathPeople, relation.parentId],
        orderKey: `${current.orderKey}|A:${numberKey(groupIndex)}:${numberKey(parentIndex)}`,
        trend: "up",
        collateralCost: current.collateralCost,
        focusDistance: current.focusDistance + 1,
        contextKey: `${relation.parentId}@${parentGeneration}@${group.union.id}`,
        expandable: !inTrail,
        referenceReason: inTrail ? "cycle" : "pedigree-collapse",
      });
      if (!occurrenceId && state.budgetReached) {
        localContinuation(
          state,
          currentNode,
          "parents",
          parentGeneration,
          sortedRelations.length - parentIndex,
          `${group.union.id}:budget`,
        );
      }
      if (occurrenceId) {
        parentOccurrenceById.set(relation.parentId, occurrenceId);
      }
      uniquePush(union.memberOccurrenceIds, occurrenceId);
    });

    if (state.options.showUnknownParentPlaceholders) {
      const missing = Math.max(
        0,
        (group.union.expectedParentSlots ?? 0) - union.memberOccurrenceIds.length,
      );
      const hasFather = sortedRelations.some(
        relation =>
          relation.role === "father" ||
          state.index.personsById.get(relation.parentId)?.sex === "male",
      );
      const hasMother = sortedRelations.some(
        relation =>
          relation.role === "mother" ||
          state.index.personsById.get(relation.parentId)?.sex === "female",
      );
      const placeholderLabels = [
        ...(hasFather ? [] : ["Додати батька"]),
        ...(hasMother ? [] : ["Додати матір"]),
      ];
      for (let slot = 0; slot < missing; slot += 1) {
        const occurrenceId = placeholderOccurrenceId(union.occurrenceId, slot);
        if (state.nodesById.has(occurrenceId)) continue;
        const placeholder: SceneNode = {
          occurrenceId,
          kind: "placeholder",
          generation: parentGeneration,
          x: 0,
          y: 0,
          width: Math.min(28, state.options.cardWidth),
          height: Math.min(28, state.options.cardHeight),
          orderKey: `${union.orderKey}|U:${numberKey(slot)}`,
          placeholderLabel:
            placeholderLabels[slot] ?? "Додати одного з батьків",
          actionPersonId: current.personId,
          focusDistance: current.focusDistance + 1,
        };
        state.nodes.push(placeholder);
        state.nodesById.set(occurrenceId, placeholder);
        uniquePush(union.memberOccurrenceIds, occurrenceId);
      }
    }

    if (current.collateralCost < state.options.collateralDepth) {
      const siblingIds = (state.index.childrenByUnionId.get(group.union.id) ?? [])
        .filter(childId => childId !== current.personId)
        .sort((a, b) => {
          const personA = state.index.personsById.get(a);
          const personB = state.index.personsById.get(b);
          if (personA && personB) return comparePeopleByBirth(personA, personB);
          return compareCodePoints(a, b);
        });
      siblingIds.forEach((siblingId, siblingIndex) => {
        const siblingRelations = (
          state.index.relationsByUnionId.get(group.union.id) ?? []
        )
          .filter(item => item.childId === siblingId)
          .sort(compareRelations);
        const existing = findExistingOccurrence(
          state,
          siblingId,
          current.generation,
        );
        if (existing) {
          uniquePush(union.childOccurrenceIds, existing);
          union.relationByChildOccurrenceId.set(existing, siblingRelations);
          return;
        }
        const relation = siblingRelations[0];
        const path = extendPath(
          current.path,
          "sibling",
          relation?.id ?? group.union.id,
          siblingId,
        );
        const occurrenceId = addPersonOccurrence(state, {
          personId: siblingId,
          generation: current.generation,
          path,
          pathPeople: [...current.pathPeople, siblingId],
          orderKey: `${current.orderKey}|S:${numberKey(siblingIndex)}`,
          trend: "side",
          collateralCost: current.collateralCost + 1,
          focusDistance: current.focusDistance + 2,
          contextKey: `${siblingId}@${current.generation}@${group.union.id}:sibling`,
          expandable: true,
        });
        if (!occurrenceId && state.budgetReached) {
          localContinuation(
            state,
            currentNode,
            "siblings",
            current.generation,
            siblingIds.length - siblingIndex,
            `${group.union.id}:budget`,
          );
        }
        uniquePush(union.childOccurrenceIds, occurrenceId);
        if (occurrenceId) {
          union.relationByChildOccurrenceId.set(occurrenceId, siblingRelations);
        }
      });
    }
  });
}

function addUnionFamilies(state: SceneBuilderState, current: QueueItem): void {
  const currentNode = state.nodesById.get(current.occurrenceId)!;
  const unions = state.index.unionsByMemberId.get(current.personId) ?? [];

  unions.forEach((domainUnion, unionIndex) => {
    const members = getUnionMembers(state, domainUnion);
    const union = ensureUnion(
      state,
      domainUnion,
      current.generation,
      `${current.orderKey}|P:${numberKey(unionIndex)}`,
    );
    uniquePush(union.memberOccurrenceIds, current.occurrenceId);

    const sortedMembers = [...members].sort((a, b) => {
      const personA = state.index.personsById.get(a);
      const personB = state.index.personsById.get(b);
      if (personA && personB) return comparePeople(personA, personB);
      return compareCodePoints(a, b);
    });
    sortedMembers.forEach((memberId, memberIndex) => {
      if (memberId === current.personId) return;
      const existingMember = union.memberOccurrenceIds.find(occurrenceId =>
        state.nodesById.get(occurrenceId)?.personId === memberId,
      );
      if (existingMember) return;
      const existing = findExistingOccurrence(
        state,
        memberId,
        current.generation,
      );
      if (existing) {
        uniquePush(union.memberOccurrenceIds, existing);
        return;
      }
      const path = extendPath(
        current.path,
        "partner",
        domainUnion.id,
        memberId,
      );
      const occurrenceId = addPersonOccurrence(state, {
        personId: memberId,
        generation: current.generation,
        path,
        pathPeople: [...current.pathPeople, memberId],
        orderKey: `${current.orderKey}|P:${numberKey(unionIndex)}:${numberKey(memberIndex)}`,
        trend: "partner",
        collateralCost: current.collateralCost,
        focusDistance: current.focusDistance + 1,
        contextKey: `${memberId}@${current.generation}@${domainUnion.id}:partner`,
        expandable: false,
      });
      if (!occurrenceId && state.budgetReached) {
        localContinuation(
          state,
          currentNode,
          "partners",
          current.generation,
          sortedMembers.length - memberIndex,
          `${domainUnion.id}:budget`,
        );
      }
      uniquePush(union.memberOccurrenceIds, occurrenceId);
    });

    const childIds = state.index.childrenByUnionId.get(domainUnion.id) ?? [];
    if (childIds.length === 0) return;
    const childGeneration = current.generation - 1;
    if (!canUseGeneration(state, childGeneration)) {
      localContinuation(
        state,
        currentNode,
        "children",
        childGeneration,
        childIds.length,
        domainUnion.id,
      );
      return;
    }

    childIds.forEach((childId, childIndex) => {
      const existing = findExistingOccurrence(state, childId, childGeneration);
      if (existing) {
        uniquePush(union.childOccurrenceIds, existing);
        union.relationByChildOccurrenceId.set(
          existing,
          (state.index.relationsByUnionId.get(domainUnion.id) ?? []).filter(
            relation => relation.childId === childId,
          ),
        );
        return;
      }

      const transition = nextTrend(current, "child");
      if (transition.collateralCost > state.options.collateralDepth) {
        localContinuation(
          state,
          currentNode,
          "children",
          childGeneration,
          childIds.length - childIndex,
          `${domainUnion.id}:collateral`,
        );
        return;
      }

      const relations = (state.index.relationsByUnionId.get(domainUnion.id) ?? [])
        .filter(relation => relation.childId === childId)
        .sort(compareRelations);
      const path = extendPath(
        current.path,
        "child",
        relations[0]?.id ?? domainUnion.id,
        childId,
      );
      const inTrail = current.pathPeople.includes(childId);
      const occurrenceId = addPersonOccurrence(state, {
        personId: childId,
        generation: childGeneration,
        path,
        pathPeople: [...current.pathPeople, childId],
        orderKey: `${current.orderKey}|D:${numberKey(unionIndex)}:${numberKey(childIndex)}`,
        trend: transition.trend,
        collateralCost: transition.collateralCost,
        focusDistance: current.focusDistance + 1,
        contextKey: `${childId}@${childGeneration}@${domainUnion.id}:child`,
        expandable: !inTrail,
        referenceReason: inTrail ? "cycle" : "pedigree-collapse",
      });
      if (!occurrenceId && state.budgetReached) {
        localContinuation(
          state,
          currentNode,
          "children",
          childGeneration,
          childIds.length - childIndex,
          `${domainUnion.id}:budget`,
        );
      }
      uniquePush(union.childOccurrenceIds, occurrenceId);
      if (occurrenceId) {
        union.relationByChildOccurrenceId.set(occurrenceId, relations);
      }
    });
  });
}

function addExternalContinuations(state: SceneBuilderState): void {
  for (const continuation of [...(state.graph.continuations ?? [])].sort((a, b) =>
    compareCodePoints(a.id, b.id),
  )) {
    const sourceId = state.primaryByPerson.get(continuation.personId);
    if (!sourceId) continue;
    const source = state.nodesById.get(sourceId)!;
    const generation =
      continuation.direction === "parents"
        ? source.generation + 1
        : continuation.direction === "children"
          ? source.generation - 1
          : source.generation;
    addContinuation(
      state,
      source,
      continuation,
      generation,
      `${source.orderKey}|Z:${continuation.direction}:${continuation.id}`,
    );
  }
}

export function buildOccurrenceScene(
  graph: FamilyGraphData,
  layoutOptions: FamilyTreeLayoutOptions,
): OccurrenceScene {
  const options = normalizeOptions(layoutOptions);
  const index = buildGraphIndex(graph);
  const state: SceneBuilderState = {
    graph,
    index,
    options,
    nodes: [],
    nodesById: new Map(),
    unionsByKey: new Map(),
    warnings: [],
    warningKeys: new Set(),
    primaryByPerson: new Map(),
    contextOccurrence: new Map(),
    queue: [],
    queued: new Set(),
    processed: new Set(),
    visiblePersonCards: 0,
    budgetReached: false,
  };

  if (index.invalidCycleRelationIds.size > 0) {
    state.warnings.push({
      code: "CYCLE_DETECTED",
      message:
        "У даних виявлено цикл батько/мати → дитина. Проблемні дуги виключено лише з візуального розрахунку.",
      relationIds: [...index.invalidCycleRelationIds].sort(compareCodePoints),
    });
  }

  if (!index.personsById.has(options.focusPersonId)) {
    return {
      nodes: [],
      unions: [],
      warnings: [
        ...state.warnings,
        {
          code: "MISSING_FOCUS",
          message: `Фокусну особу ${options.focusPersonId} не знайдено.`,
          personIds: [options.focusPersonId],
        },
      ],
      primaryOccurrenceByPersonId: state.primaryByPerson,
    };
  }

  const path = rootPath(options.focusPersonId);
  const focusOccurrenceId = addPersonOccurrence(state, {
    personId: options.focusPersonId,
    generation: 0,
    path,
    pathPeople: [options.focusPersonId],
    orderKey: "M",
    trend: "root",
    collateralCost: 0,
    focusDistance: 0,
    contextKey: `${options.focusPersonId}@0@root`,
    expandable: true,
  });

  while (state.queue.length > 0) {
    state.queue.sort((a, b) =>
      a.focusDistance - b.focusDistance ||
      compareCodePoints(a.orderKey, b.orderKey) ||
      compareCodePoints(a.occurrenceId, b.occurrenceId),
    );
    const current = state.queue.shift()!;
    if (state.processed.has(current.occurrenceId)) continue;
    state.processed.add(current.occurrenceId);
    const node = state.nodesById.get(current.occurrenceId);
    if (!node || node.kind !== "person") continue;

    if (state.options.collapsedPersonIds.has(current.personId)) {
      const parentCount = index.relationsByChildId.get(current.personId)?.length ?? 0;
      const childCount = index.relationsByParentId.get(current.personId)?.length ?? 0;
      const partnerCount = index.unionsByMemberId.get(current.personId)?.length ?? 0;
      if (parentCount > 0) {
        localContinuation(
          state,
          node,
          "parents",
          current.generation + 1,
          parentCount,
          "collapsed",
        );
      }
      if (childCount > 0) {
        localContinuation(
          state,
          node,
          "children",
          current.generation - 1,
          childCount,
          "collapsed",
        );
      }
      if (partnerCount > 0) {
        localContinuation(
          state,
          node,
          "partners",
          current.generation,
          partnerCount,
          "collapsed",
        );
      }
      continue;
    }

    // Parent expansion is intentionally processed before partners so that a
    // direct ancestor becomes the primary occurrence in pedigree collapse.
    addParentGroups(state, current);
    addUnionFamilies(state, current);
  }

  addExternalContinuations(state);

  if (state.budgetReached) {
    state.warnings.push({
      code: "VISIBLE_BUDGET_REACHED",
      message:
        "Досягнуто бюджет одночасно видимих карток. Дані не обрізано: продовжуйте через розкриття гілки або зміну фокусу.",
    });
  }

  state.nodes.sort(
    (a, b) =>
      b.generation - a.generation ||
      compareCodePoints(a.orderKey, b.orderKey) ||
      compareCodePoints(a.occurrenceId, b.occurrenceId),
  );
  const unions = [...state.unionsByKey.values()];
  unions.sort(
    (a, b) =>
      b.generation - a.generation ||
      compareCodePoints(a.orderKey, b.orderKey) ||
      compareCodePoints(a.occurrenceId, b.occurrenceId),
  );

  return {
    nodes: state.nodes,
    unions,
    warnings: state.warnings,
    primaryOccurrenceByPersonId: state.primaryByPerson,
    ...(focusOccurrenceId ? { focusOccurrenceId } : {}),
  };
}
