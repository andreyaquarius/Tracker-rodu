import { buildCircularAncestorChartModel } from "../circular/circularAncestorChartLayout.ts";
import type {
  FamilyGraphData,
  ParentChildRelation,
  ParentRelationshipKind,
  PersonId,
  TreePerson,
} from "../types.ts";

export const MIN_FAN_CHART_GENERATIONS = 1;
export const MAX_ANCESTOR_FAN_GENERATIONS = 16;
export const MAX_DESCENDANT_FAN_GENERATIONS = 10;
export const FAN_CHART_FOCUS_RADIUS = 72;
export const FAN_CHART_RING_WIDTH = 76;
/** Prevents a converging or very broad descendant graph from exhausting the UI. */
export const MAX_FAN_CHART_OCCURRENCES = 1600;

export type FanChartDirection = "ancestors" | "descendants";
export type FanChartBranch =
  | "focus"
  | "paternal"
  | "maternal"
  | "descendant";

export interface FanChartOccurrence {
  occurrenceId: string;
  personId: PersonId;
  generation: number;
  /** Zero-based visual position inside the generation, including sparse ancestor slots. */
  index: number;
  branch: FanChartBranch;
  /** Degrees in SVG polar space: ancestors occupy -180..0, descendants 0..180. */
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
  person: TreePerson;
  /** True for every occurrence when one canonical person appears more than once. */
  duplicate: boolean;
  /** Stable path identity. Unlike personId it remains unique under pedigree collapse. */
  pathKey: string;
  parentOccurrenceId?: string;
  relationId?: string;
  /** Ahnentafel number. Defined only for an ancestor occurrence. */
  slot?: number;
  /** Number of leaf paths represented by this sector. */
  subtreeWeight: number;
}

export interface FanChartModel {
  direction: FanChartDirection;
  occurrences: readonly FanChartOccurrence[];
  warnings: readonly string[];
  /** Normalized number of rings requested by the user. */
  maxGeneration: number;
}

interface DescendantDraft {
  occurrenceId: string;
  pathKey: string;
  person: TreePerson;
  generation: number;
  parentOccurrenceId?: string;
  relationId?: string;
  children: DescendantDraft[];
  pathPersonIds: ReadonlySet<PersonId>;
  subtreeWeight: number;
  startAngle: number;
  endAngle: number;
}

const RELATION_KIND_PRIORITY: Readonly<Record<ParentRelationshipKind, number>> = {
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

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function optional(value: string | undefined): string {
  return value ?? "\uffff";
}

function relationPriority(relation: ParentChildRelation): number {
  return RELATION_KIND_PRIORITY[relation.kind] ?? Number.MAX_SAFE_INTEGER;
}

function compareRelations(
  left: ParentChildRelation,
  right: ParentChildRelation,
): number {
  return (
    Number(right.isPreferred === true) - Number(left.isPreferred === true) ||
    relationPriority(left) - relationPriority(right) ||
    compareCodePoints(optional(left.displayOrder), optional(right.displayOrder)) ||
    compareCodePoints(left.id, right.id) ||
    compareCodePoints(left.childId, right.childId)
  );
}

function compareDescendantCandidates(
  left: { relation: ParentChildRelation; person: TreePerson },
  right: { relation: ParentChildRelation; person: TreePerson },
): number {
  return (
    compareCodePoints(optional(left.relation.displayOrder), optional(right.relation.displayOrder)) ||
    compareCodePoints(optional(left.person.displayOrder), optional(right.person.displayOrder)) ||
    compareCodePoints(optional(left.person.birth?.sort), optional(right.person.birth?.sort)) ||
    compareCodePoints(left.person.displayName, right.person.displayName) ||
    compareCodePoints(left.person.id, right.person.id) ||
    compareRelations(left.relation, right.relation)
  );
}

export function normalizeFanChartGenerations(
  direction: FanChartDirection,
  value: number,
): number {
  const integer = Number.isFinite(value)
    ? Math.floor(value)
    : MIN_FAN_CHART_GENERATIONS;
  const maximum = direction === "ancestors"
    ? MAX_ANCESTOR_FAN_GENERATIONS
    : MAX_DESCENDANT_FAN_GENERATIONS;
  return Math.min(maximum, Math.max(MIN_FAN_CHART_GENERATIONS, integer));
}

/** Keeps a gap visible without consuming narrow sectors in distant rings. */
export function fanChartSectorGapDegrees(
  startAngle: number,
  endAngle: number,
): number {
  const sweep = Math.abs(endAngle - startAngle);
  if (!Number.isFinite(sweep) || sweep <= 0) return 0;
  return Math.min(0.7, sweep * 0.055);
}

function ringGeometry(generation: number): Pick<
  FanChartOccurrence,
  "innerRadius" | "outerRadius"
> {
  if (generation === 0) {
    return { innerRadius: 0, outerRadius: FAN_CHART_FOCUS_RADIUS };
  }
  return {
    innerRadius:
      FAN_CHART_FOCUS_RADIUS + (generation - 1) * FAN_CHART_RING_WIDTH,
    outerRadius:
      FAN_CHART_FOCUS_RADIUS + generation * FAN_CHART_RING_WIDTH,
  };
}

/**
 * Remaps the established sparse Ahnentafel traversal onto the upper half-plane.
 * The first half of every generation (father's line) stays on the left and the
 * second half (mother's line) stays on the right.
 */
export function buildAncestorFanChartModel(
  graph: FamilyGraphData,
  focusPersonId: string,
  generations: number,
): FanChartModel {
  const maxGeneration = normalizeFanChartGenerations("ancestors", generations);
  const circular = buildCircularAncestorChartModel(
    graph,
    focusPersonId,
    maxGeneration,
  );

  return {
    direction: "ancestors",
    maxGeneration,
    warnings: circular.warnings,
    occurrences: circular.occurrences.map(occurrence => {
      if (occurrence.generation === 0) {
        return {
          occurrenceId: "fan-ancestor:1",
          personId: occurrence.personId,
          generation: 0,
          index: 0,
          branch: "focus",
          startAngle: -180,
          endAngle: 180,
          ...ringGeometry(0),
          person: occurrence.person,
          duplicate: occurrence.duplicate,
          pathKey: "ahnentafel:1",
          slot: 1,
          subtreeWeight: 1,
        } satisfies FanChartOccurrence;
      }

      const sectorCount = 2 ** occurrence.generation;
      const sweep = 180 / sectorCount;
      return {
        occurrenceId: `fan-ancestor:${occurrence.slot}`,
        personId: occurrence.personId,
        generation: occurrence.generation,
        index: occurrence.index,
        branch: occurrence.branch,
        // polarPoint mirrors X. Counting back from zero keeps the paternal
        // Ahnentafel half physically on the left and the maternal half right.
        startAngle: -(occurrence.index + 1) * sweep,
        endAngle: occurrence.index === 0 ? 0 : -occurrence.index * sweep,
        ...ringGeometry(occurrence.generation),
        person: occurrence.person,
        duplicate: occurrence.duplicate,
        pathKey: `ahnentafel:${occurrence.slot}`,
        parentOccurrenceId: `fan-ancestor:${Math.floor(occurrence.slot / 2)}`,
        slot: occurrence.slot,
        subtreeWeight: 1,
      } satisfies FanChartOccurrence;
    }),
  };
}

function selectedChildRelations(
  parentId: PersonId,
  relationsByParentId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>,
  personsById: ReadonlyMap<PersonId, TreePerson>,
): {
  candidates: Array<{ relation: ParentChildRelation; person: TreePerson }>;
  missing: ParentChildRelation[];
} {
  const selectedByChildId = new Map<PersonId, ParentChildRelation>();
  for (const relation of relationsByParentId.get(parentId) ?? []) {
    const selected = selectedByChildId.get(relation.childId);
    if (!selected || compareRelations(relation, selected) < 0) {
      selectedByChildId.set(relation.childId, relation);
    }
  }

  const candidates: Array<{ relation: ParentChildRelation; person: TreePerson }> = [];
  const missing: ParentChildRelation[] = [];
  for (const relation of selectedByChildId.values()) {
    const person = personsById.get(relation.childId);
    if (person) candidates.push({ relation, person });
    else missing.push(relation);
  }
  candidates.sort(compareDescendantCandidates);
  missing.sort(compareRelations);
  return { candidates, missing };
}

function calculateSubtreeWeight(node: DescendantDraft): number {
  if (node.children.length === 0) {
    node.subtreeWeight = 1;
    return 1;
  }
  node.subtreeWeight = node.children.reduce(
    (total, child) => total + calculateSubtreeWeight(child),
    0,
  );
  return node.subtreeWeight;
}

function allocateDescendantAngles(
  node: DescendantDraft,
  startAngle: number,
  endAngle: number,
): void {
  node.startAngle = startAngle;
  node.endAngle = endAngle;
  if (node.children.length === 0) return;

  const totalWeight = node.children.reduce(
    (total, child) => total + child.subtreeWeight,
    0,
  );
  let cursor = startAngle;
  node.children.forEach((child, index) => {
    const childEnd = index === node.children.length - 1
      ? endAngle
      : cursor + (endAngle - startAngle) * (child.subtreeWeight / totalWeight);
    allocateDescendantAngles(child, cursor, childEnd);
    cursor = childEnd;
  });
}

/**
 * Builds a path-aware descendant tree from canonical parent-child relations.
 * The same person may occupy several paths; only a cycle on the current path is
 * cut. Every child's angular span is proportional to its number of leaf paths.
 */
export function buildDescendantFanChartModel(
  graph: FamilyGraphData,
  focusPersonId: string,
  generations: number,
): FanChartModel {
  const maxGeneration = normalizeFanChartGenerations("descendants", generations);
  const personsById = new Map(graph.persons.map(person => [person.id, person]));
  const focus = personsById.get(focusPersonId);
  if (!focus) {
    return {
      direction: "descendants",
      occurrences: [],
      warnings: [`Центральну особу ${focusPersonId} не знайдено у завантаженій частині дерева.`],
      maxGeneration,
    };
  }

  const relationsByParentId = new Map<PersonId, ParentChildRelation[]>();
  for (const relation of graph.parentChildRelations) {
    const values = relationsByParentId.get(relation.parentId);
    if (values) values.push(relation);
    else relationsByParentId.set(relation.parentId, [relation]);
  }
  for (const relations of relationsByParentId.values()) {
    relations.sort(compareRelations);
  }

  const warnings: string[] = [];
  const warningKeys = new Set<string>();
  const addWarning = (key: string, message: string): void => {
    if (warningKeys.has(key)) return;
    warningKeys.add(key);
    warnings.push(message);
  };

  const root: DescendantDraft = {
    occurrenceId: "fan-descendant:1",
    pathKey: `descendant:${focus.id}`,
    person: focus,
    generation: 0,
    children: [],
    pathPersonIds: new Set([focus.id]),
    subtreeWeight: 1,
    startAngle: 0,
    endAngle: 180,
  };
  const drafts: DescendantDraft[] = [root];
  const queue: DescendantDraft[] = [root];
  let nextOrdinal = 2;
  let occurrenceLimitReached = false;

  for (let offset = 0; offset < queue.length; offset += 1) {
    const item = queue[offset]!;
    if (item.generation >= maxGeneration || occurrenceLimitReached) continue;

    const { candidates, missing } = selectedChildRelations(
      item.person.id,
      relationsByParentId,
      personsById,
    );
    for (const relation of missing) {
      addWarning(
        `missing:${item.occurrenceId}:${relation.childId}`,
        `Для особи ${item.person.id} не вдалося завантажити дані нащадка ${relation.childId}.`,
      );
    }

    for (const { relation, person } of candidates) {
      if (item.pathPersonIds.has(person.id)) {
        addWarning(
          `cycle:${item.occurrenceId}:${person.id}`,
          `Зупинено циклічний зв’язок: особа ${person.id} уже є в цій лінії нащадків.`,
        );
        continue;
      }
      if (drafts.length >= MAX_FAN_CHART_OCCURRENCES) {
        addWarning(
          "occurrence-limit",
          `Діаграму обмежено ${MAX_FAN_CHART_OCCURRENCES} позиціями, щоб зберегти швидку роботу для великих родів.`,
        );
        occurrenceLimitReached = true;
        break;
      }

      const occurrenceId = `fan-descendant:${nextOrdinal}`;
      nextOrdinal += 1;
      const child: DescendantDraft = {
        occurrenceId,
        pathKey: `${item.pathKey}/${person.id}@${relation.id}`,
        person,
        generation: item.generation + 1,
        parentOccurrenceId: item.occurrenceId,
        relationId: relation.id,
        children: [],
        pathPersonIds: new Set([...item.pathPersonIds, person.id]),
        subtreeWeight: 1,
        startAngle: 0,
        endAngle: 0,
      };
      item.children.push(child);
      drafts.push(child);
      queue.push(child);
    }
  }

  calculateSubtreeWeight(root);
  allocateDescendantAngles(root, 0, 180);

  const countByPersonId = new Map<PersonId, number>();
  for (const draft of drafts) {
    countByPersonId.set(
      draft.person.id,
      (countByPersonId.get(draft.person.id) ?? 0) + 1,
    );
  }
  const indexByOccurrenceId = new Map<string, number>();
  for (let generation = 0; generation <= maxGeneration; generation += 1) {
    drafts
      .filter(draft => draft.generation === generation)
      .sort((left, right) =>
        left.startAngle - right.startAngle ||
        left.endAngle - right.endAngle ||
        compareCodePoints(left.pathKey, right.pathKey),
      )
      .forEach((draft, index) => indexByOccurrenceId.set(draft.occurrenceId, index));
  }

  return {
    direction: "descendants",
    maxGeneration,
    warnings,
    occurrences: drafts.map(draft => ({
      occurrenceId: draft.occurrenceId,
      personId: draft.person.id,
      generation: draft.generation,
      index: indexByOccurrenceId.get(draft.occurrenceId) ?? 0,
      branch: draft.generation === 0 ? "focus" : "descendant",
      startAngle: draft.generation === 0 ? -180 : draft.startAngle,
      endAngle: draft.generation === 0 ? 180 : draft.endAngle,
      ...ringGeometry(draft.generation),
      person: draft.person,
      duplicate: (countByPersonId.get(draft.person.id) ?? 0) > 1,
      pathKey: draft.pathKey,
      parentOccurrenceId: draft.parentOccurrenceId,
      relationId: draft.relationId,
      subtreeWeight: draft.subtreeWeight,
    })),
  };
}

export function buildFanChartModel(
  graph: FamilyGraphData,
  focusPersonId: string,
  generations: number,
  direction: FanChartDirection,
): FanChartModel {
  return direction === "ancestors"
    ? buildAncestorFanChartModel(graph, focusPersonId, generations)
    : buildDescendantFanChartModel(graph, focusPersonId, generations);
}
