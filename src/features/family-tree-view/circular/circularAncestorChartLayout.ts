import type {
  FamilyGraphData,
  ParentChildRelation,
  ParentRelationshipKind,
  PersonId,
  TreePerson,
  TreeUnion,
} from "../types.ts";

export const MIN_CIRCULAR_ANCESTOR_GENERATIONS = 1;
export const MAX_CIRCULAR_ANCESTOR_GENERATIONS = 16;
export const CIRCULAR_ANCESTOR_FOCUS_RADIUS = 72;
export const CIRCULAR_ANCESTOR_RING_WIDTH = 58;
/** Keeps pedigree-collapse DAGs from expanding into an exponential SVG. */
export const MAX_CIRCULAR_ANCESTOR_OCCURRENCES = 2400;

export interface CircularAncestorOccurrence {
  occurrenceId: string;
  personId: string;
  /** One-based Ahnentafel number: focus=1, father=2n, mother=2n+1. */
  slot: number;
  generation: number;
  /** Zero-based position inside this generation ring. */
  index: number;
  branch: "focus" | "paternal" | "maternal";
  /** Angles are expressed in degrees and start at twelve o'clock (-90deg). */
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
  person: TreePerson;
  /** True for every occurrence when the same canonical person occupies >1 slot. */
  duplicate: boolean;
}

export interface CircularAncestorChartModel {
  occurrences: readonly CircularAncestorOccurrence[];
  warnings: readonly string[];
  /** Normalized number of ancestor rings requested by the user. */
  maxGeneration: number;
}

interface ParentGroup {
  key: string;
  union?: TreeUnion;
  relations: ParentChildRelation[];
}

interface ParentCandidate {
  person: TreePerson;
  relation: ParentChildRelation;
}

interface TraversalItem {
  person: TreePerson;
  slot: number;
  generation: number;
  pathPersonIds: ReadonlySet<PersonId>;
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

const FATHER_ROLES = new Set([
  "father",
  "adoptive_father",
  "stepfather",
]);

const MOTHER_ROLES = new Set([
  "mother",
  "adoptive_mother",
  "stepmother",
  "surrogate",
]);

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function optional(value: string | undefined): string {
  return value ?? "\uffff";
}

function normalizeGenerations(value: number): number {
  const integer = Number.isFinite(value)
    ? Math.floor(value)
    : MIN_CIRCULAR_ANCESTOR_GENERATIONS;
  return Math.min(
    MAX_CIRCULAR_ANCESTOR_GENERATIONS,
    Math.max(MIN_CIRCULAR_ANCESTOR_GENERATIONS, integer),
  );
}

function relationPriority(relation: ParentChildRelation): number {
  return PARENT_KIND_PRIORITY[relation.kind] ?? Number.MAX_SAFE_INTEGER;
}

function compareParentRelations(
  left: ParentChildRelation,
  right: ParentChildRelation,
): number {
  return (
    Number(right.isPreferred === true) - Number(left.isPreferred === true) ||
    relationPriority(left) - relationPriority(right) ||
    compareCodePoints(optional(left.displayOrder), optional(right.displayOrder)) ||
    compareCodePoints(left.id, right.id) ||
    compareCodePoints(left.parentId, right.parentId)
  );
}

function parentGroupsForChild(
  childId: PersonId,
  relationsByChildId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>,
  unionsById: ReadonlyMap<string, TreeUnion>,
): ParentGroup[] {
  const grouped = new Map<string, ParentChildRelation[]>();
  for (const relation of relationsByChildId.get(childId) ?? []) {
    // Relations without a persisted parent set still describe one parent set
    // for this child. Keeping them together preserves the binary pair.
    const key = relation.unionId ?? `derived:child:${childId}`;
    const values = grouped.get(key);
    if (values) values.push(relation);
    else grouped.set(key, [relation]);
  }

  return [...grouped.entries()]
    .map(([key, relations]) => ({
      key,
      union: unionsById.get(key),
      relations: [...relations].sort(compareParentRelations),
    }))
    .sort(compareParentGroups);
}

function groupKindPriority(group: ParentGroup): number {
  return Math.min(
    ...group.relations.map(relationPriority),
    Number.MAX_SAFE_INTEGER,
  );
}

function groupDisplayOrder(group: ParentGroup): string {
  if (group.union?.displayOrder) return group.union.displayOrder;
  return group.relations
    .map(relation => optional(relation.displayOrder))
    .sort(compareCodePoints)[0] ?? "\uffff";
}

function compareParentGroups(left: ParentGroup, right: ParentGroup): number {
  return (
    Number(right.union?.isDefaultForPedigree === true) -
      Number(left.union?.isDefaultForPedigree === true) ||
    Number(right.relations.some(relation => relation.isPreferred === true)) -
      Number(left.relations.some(relation => relation.isPreferred === true)) ||
    Number(right.union?.isPreferredForDisplay === true) -
      Number(left.union?.isPreferredForDisplay === true) ||
    groupKindPriority(left) - groupKindPriority(right) ||
    compareCodePoints(groupDisplayOrder(left), groupDisplayOrder(right)) ||
    compareCodePoints(left.key, right.key)
  );
}

function candidateSide(candidate: ParentCandidate): "father" | "mother" | undefined {
  const role = candidate.relation.role;
  if (role && FATHER_ROLES.has(role)) return "father";
  if (role && MOTHER_ROLES.has(role)) return "mother";
  if (candidate.relation.kind === "genetic_father") return "father";
  if (
    candidate.relation.kind === "genetic_mother" ||
    candidate.relation.kind === "gestational_parent" ||
    candidate.relation.kind === "birth_parent" ||
    candidate.relation.kind === "surrogate"
  ) {
    return "mother";
  }
  if (candidate.person.sex === "male") return "father";
  if (candidate.person.sex === "female") return "mother";
  return undefined;
}

function parentCandidates(
  group: ParentGroup,
  personsById: ReadonlyMap<PersonId, TreePerson>,
): ParentCandidate[] {
  const byPersonId = new Map<PersonId, ParentCandidate>();
  for (const relation of group.relations) {
    const person = personsById.get(relation.parentId);
    if (!person) continue;
    const candidate = { person, relation };
    const current = byPersonId.get(relation.parentId);
    if (!current || compareParentRelations(relation, current.relation) < 0) {
      byPersonId.set(relation.parentId, candidate);
    }
  }
  return [...byPersonId.values()].sort((left, right) =>
    compareParentRelations(left.relation, right.relation) ||
    compareCodePoints(left.person.id, right.person.id),
  );
}

function selectedParents(
  childId: PersonId,
  personsById: ReadonlyMap<PersonId, TreePerson>,
  relationsByChildId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>,
  unionsById: ReadonlyMap<string, TreeUnion>,
): { father?: ParentCandidate; mother?: ParentCandidate; missingParentIds: string[] } {
  const group = parentGroupsForChild(
    childId,
    relationsByChildId,
    unionsById,
  )[0];
  if (!group) return { missingParentIds: [] };

  const missingParentIds = [...new Set(
    group.relations
      .map(relation => relation.parentId)
      .filter(parentId => !personsById.has(parentId)),
  )].sort(compareCodePoints);
  const candidates = parentCandidates(group, personsById);
  let father = candidates.find(candidate => candidateSide(candidate) === "father");
  let mother = candidates.find(
    candidate =>
      candidate.person.id !== father?.person.id &&
      candidateSide(candidate) === "mother",
  );

  const remaining = () => candidates.filter(
    candidate =>
      candidate.person.id !== father?.person.id &&
      candidate.person.id !== mother?.person.id,
  );

  // A lone explicitly female/maternal parent must retain the maternal slot;
  // otherwise sparse trees would collapse into the paternal half.
  if (!father) {
    father = remaining().find(candidate => candidateSide(candidate) !== "mother");
  }
  if (!mother) {
    mother = remaining().find(candidate => candidateSide(candidate) !== "father");
  }
  // More-than-binary legacy sets remain deterministic while the chart keeps
  // its father/mother Ahnentafel contract.
  if (!father) father = remaining()[0];
  if (!mother) mother = remaining()[0];

  return { father, mother, missingParentIds };
}

function occurrenceGeometry(slot: number, generation: number): Pick<
  CircularAncestorOccurrence,
  | "index"
  | "branch"
  | "startAngle"
  | "endAngle"
  | "innerRadius"
  | "outerRadius"
> {
  if (generation === 0) {
    return {
      index: 0,
      branch: "focus",
      startAngle: -90,
      endAngle: 270,
      innerRadius: 0,
      outerRadius: CIRCULAR_ANCESTOR_FOCUS_RADIUS,
    };
  }

  const generationStartSlot = 2 ** generation;
  const index = slot - generationStartSlot;
  const sectorCount = generationStartSlot;
  const sweep = 360 / sectorCount;
  return {
    index,
    branch: index < sectorCount / 2 ? "paternal" : "maternal",
    startAngle: -90 + index * sweep,
    endAngle: -90 + (index + 1) * sweep,
    innerRadius:
      CIRCULAR_ANCESTOR_FOCUS_RADIUS +
      (generation - 1) * CIRCULAR_ANCESTOR_RING_WIDTH,
    outerRadius:
      CIRCULAR_ANCESTOR_FOCUS_RADIUS +
      generation * CIRCULAR_ANCESTOR_RING_WIDTH,
  };
}

function createOccurrence(
  item: TraversalItem,
): Omit<CircularAncestorOccurrence, "duplicate"> {
  return {
    occurrenceId: `circular-ancestor:${item.slot}`,
    personId: item.person.id,
    slot: item.slot,
    generation: item.generation,
    ...occurrenceGeometry(item.slot, item.generation),
    person: item.person,
  };
}

/**
 * Builds a sparse full-circle direct-ancestor model. Empty Ahnentafel slots are
 * deliberately not materialized, so a 16-generation request remains bounded
 * by the number of known people rather than the theoretical 131,071 slots.
 */
export function buildCircularAncestorChartModel(
  graph: FamilyGraphData,
  focusPersonId: string,
  generations: number,
): CircularAncestorChartModel {
  const maxGeneration = normalizeGenerations(generations);
  const personsById = new Map(graph.persons.map(person => [person.id, person]));
  const unionsById = new Map(graph.unions.map(union => [union.id, union]));
  const relationsByChildId = new Map<PersonId, ParentChildRelation[]>();
  for (const relation of graph.parentChildRelations) {
    const values = relationsByChildId.get(relation.childId);
    if (values) values.push(relation);
    else relationsByChildId.set(relation.childId, [relation]);
  }
  for (const relations of relationsByChildId.values()) {
    relations.sort(compareParentRelations);
  }

  const focus = personsById.get(focusPersonId);
  if (!focus) {
    return {
      occurrences: [],
      warnings: [`Центральну особу ${focusPersonId} не знайдено у завантаженій частині дерева.`],
      maxGeneration,
    };
  }

  const warnings: string[] = [];
  const warningKeys = new Set<string>();
  const addWarning = (key: string, message: string): void => {
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(message);
  };
  const rawOccurrences: Array<Omit<CircularAncestorOccurrence, "duplicate">> = [];
  const queue: TraversalItem[] = [{
    person: focus,
    slot: 1,
    generation: 0,
    pathPersonIds: new Set([focus.id]),
  }];

  for (let offset = 0; offset < queue.length; offset += 1) {
    const item = queue[offset]!;
    rawOccurrences.push(createOccurrence(item));
    if (item.generation >= maxGeneration) continue;

    const parents = selectedParents(
      item.person.id,
      personsById,
      relationsByChildId,
      unionsById,
    );
    for (const missingParentId of parents.missingParentIds) {
      addWarning(
        `missing:${item.slot}:${missingParentId}`,
        `Для особи ${item.person.id} не вдалося завантажити дані предка ${missingParentId}.`,
      );
    }

    const nextGeneration = item.generation + 1;
    const enqueue = (
      candidate: ParentCandidate | undefined,
      slot: number,
    ): void => {
      if (!candidate) return;
      if (item.pathPersonIds.has(candidate.person.id)) {
        addWarning(
          `cycle:${item.slot}:${candidate.person.id}`,
          `Зупинено циклічний зв’язок у позиції ${slot}: особа ${candidate.person.id} уже є в цій лінії.`,
        );
        return;
      }
      if (queue.length >= MAX_CIRCULAR_ANCESTOR_OCCURRENCES) {
        addWarning(
          "occurrence-limit",
          `Діаграму обмежено ${MAX_CIRCULAR_ANCESTOR_OCCURRENCES} позиціями, щоб зберегти швидку роботу при багаторазовому повторенні предків.`,
        );
        return;
      }
      queue.push({
        person: candidate.person,
        slot,
        generation: nextGeneration,
        pathPersonIds: new Set([
          ...item.pathPersonIds,
          candidate.person.id,
        ]),
      });
    };

    enqueue(parents.father, item.slot * 2);
    enqueue(parents.mother, item.slot * 2 + 1);
  }

  rawOccurrences.sort((left, right) => left.slot - right.slot);
  const occurrenceCountByPersonId = new Map<PersonId, number>();
  for (const occurrence of rawOccurrences) {
    occurrenceCountByPersonId.set(
      occurrence.personId,
      (occurrenceCountByPersonId.get(occurrence.personId) ?? 0) + 1,
    );
  }

  return {
    occurrences: rawOccurrences.map(occurrence => ({
      ...occurrence,
      duplicate: (occurrenceCountByPersonId.get(occurrence.personId) ?? 0) > 1,
    })),
    warnings,
    maxGeneration,
  };
}
