import type {
  FamilyGraphData,
  ParentChildRelation,
  PersonId,
  TreePerson,
  TreeUnion,
  UnionId,
} from "../types.ts";

export interface GraphIndex {
  personsById: ReadonlyMap<PersonId, TreePerson>;
  unionsById: ReadonlyMap<UnionId, TreeUnion>;
  unionsByMemberId: ReadonlyMap<PersonId, readonly TreeUnion[]>;
  relationsByParentId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>;
  relationsByChildId: ReadonlyMap<PersonId, readonly ParentChildRelation[]>;
  relationsByUnionId: ReadonlyMap<UnionId, readonly ParentChildRelation[]>;
  childrenByUnionId: ReadonlyMap<UnionId, readonly PersonId[]>;
  invalidCycleRelationIds: ReadonlySet<string>;
}

interface CachedGraphIndex {
  persons: FamilyGraphData["persons"];
  unions: FamilyGraphData["unions"];
  parentChildRelations: FamilyGraphData["parentChildRelations"];
  index: GraphIndex;
}

// Layout reflows (camera-preserving expansion, resize and appearance changes)
// commonly reuse the same immutable graph collections. Indexing all 10k+
// canonical records for every reflow dominated the layout budget even though
// only up to 400 cards are mounted. A WeakMap gives those repeated reflows the
// existing index without retaining a graph after its owning view releases it.
const graphIndexCache = new WeakMap<FamilyGraphData, CachedGraphIndex>();

export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function optional(value: string | undefined): string {
  return value ?? "\uffff";
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function normalizedBirthOrderKey(
  value: string | undefined,
): { key: string; precision: number } | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const iso = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(trimmed);
  const local = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(trimmed);
  const year = Number(iso?.[1] ?? local?.[3]);
  const monthText = iso?.[2] ?? local?.[2];
  const dayText = iso?.[3] ?? local?.[1];
  const month = monthText === undefined ? undefined : Number(monthText);
  const day = dayText === undefined ? undefined : Number(dayText);

  if (!Number.isInteger(year) || year < 1 || year > 9999) return undefined;
  if (month !== undefined && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return undefined;
  }
  if (day !== undefined) {
    if (month === undefined || !Number.isInteger(day) || day < 1) return undefined;
    if (day > daysInMonth(year, month)) return undefined;
  }

  return {
    key: [
      String(year).padStart(4, "0"),
      String(month ?? 0).padStart(2, "0"),
      String(day ?? 0).padStart(2, "0"),
    ].join("-"),
    precision: day === undefined ? (month === undefined ? 1 : 2) : 3,
  };
}

function personBirthOrder(
  person: TreePerson,
): { key: string; precision: number } | undefined {
  const sort = normalizedBirthOrderKey(person.birth?.sort);
  const display = normalizedBirthOrderKey(person.birth?.display);
  if (!sort) return display;
  if (!display || display.precision <= sort.precision) return sort;

  const sortParts = sort.key.split("-");
  const displayParts = display.key.split("-");
  const displayRefinesSort = sortParts
    .slice(0, sort.precision)
    .every((part, index) => part === displayParts[index]);
  return displayRefinesSort ? display : sort;
}

/**
 * Chronological child order for a family row. A known year is sufficient;
 * absent or invalid dates are deliberately placed after every known year.
 */
export function comparePeopleByBirth(a: TreePerson, b: TreePerson): number {
  const birthA = personBirthOrder(a);
  const birthB = personBirthOrder(b);
  const birthOrder =
    birthA && birthB
      ? compareCodePoints(birthA.key, birthB.key)
      : birthA
        ? -1
        : birthB
          ? 1
          : 0;
  return (
    birthOrder ||
    compareCodePoints(optional(a.displayOrder), optional(b.displayOrder)) ||
    compareCodePoints(a.id, b.id)
  );
}

export function comparePeople(a: TreePerson, b: TreePerson): number {
  return (
    compareCodePoints(optional(a.displayOrder), optional(b.displayOrder)) ||
    compareCodePoints(optional(a.birth?.sort), optional(b.birth?.sort)) ||
    compareCodePoints(a.id, b.id)
  );
}

export function compareUnions(a: TreeUnion, b: TreeUnion): number {
  return (
    compareCodePoints(optional(a.displayOrder), optional(b.displayOrder)) ||
    compareCodePoints(optional(a.startDate?.sort), optional(b.startDate?.sort)) ||
    compareCodePoints(a.id, b.id)
  );
}

const ROLE_ORDER: Readonly<Record<string, number>> = {
  father: 0,
  adoptive_father: 1,
  stepfather: 2,
  parent: 3,
  donor: 4,
  unknown: 5,
  custom: 6,
  guardian: 7,
  surrogate: 8,
  stepmother: 9,
  adoptive_mother: 10,
  mother: 11,
};

export function compareRelations(
  a: ParentChildRelation,
  b: ParentChildRelation,
): number {
  return (
    compareCodePoints(optional(a.displayOrder), optional(b.displayOrder)) ||
    (ROLE_ORDER[a.role ?? "unknown"] ?? 99) -
      (ROLE_ORDER[b.role ?? "unknown"] ?? 99) ||
    compareCodePoints(a.id, b.id)
  );
}

function pushMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

function sortMapValues<K, V>(
  input: Map<K, V[]>,
  compare: (a: V, b: V) => number,
): ReadonlyMap<K, readonly V[]> {
  for (const values of input.values()) values.sort(compare);
  return input;
}

/**
 * Finds deterministic DFS back-edges without recursion. The database must
 * still reject cycles on write; this is the renderer's final safety net for
 * legacy/imported data.
 */
function findCycleRelations(
  personIds: readonly PersonId[],
  relations: readonly ParentChildRelation[],
): ReadonlySet<string> {
  const outgoing = new Map<PersonId, ParentChildRelation[]>();
  for (const relation of [...relations].sort(compareRelations)) {
    pushMap(outgoing, relation.parentId, relation);
  }

  type Color = 0 | 1 | 2;
  const color = new Map<PersonId, Color>();
  const cut = new Set<string>();

  interface Frame {
    personId: PersonId;
    edgeIndex: number;
    edges: readonly ParentChildRelation[];
  }

  for (const rootId of [...personIds].sort(compareCodePoints)) {
    if ((color.get(rootId) ?? 0) !== 0) continue;

    color.set(rootId, 1);
    const stack: Frame[] = [
      { personId: rootId, edgeIndex: 0, edges: outgoing.get(rootId) ?? [] },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.edgeIndex >= frame.edges.length) {
        color.set(frame.personId, 2);
        stack.pop();
        continue;
      }

      const edge = frame.edges[frame.edgeIndex]!;
      frame.edgeIndex += 1;
      if (edge.parentId === edge.childId) {
        cut.add(edge.id);
        continue;
      }

      const childColor = color.get(edge.childId) ?? 0;
      if (childColor === 1) {
        cut.add(edge.id);
        continue;
      }
      if (childColor === 2) continue;

      color.set(edge.childId, 1);
      stack.push({
        personId: edge.childId,
        edgeIndex: 0,
        edges: outgoing.get(edge.childId) ?? [],
      });
    }
  }

  return cut;
}

export function buildGraphIndex(graph: FamilyGraphData): GraphIndex {
  const cached = graphIndexCache.get(graph);
  if (
    cached?.persons === graph.persons &&
    cached.unions === graph.unions &&
    cached.parentChildRelations === graph.parentChildRelations
  ) {
    return cached.index;
  }

  const personsById = new Map<PersonId, TreePerson>();
  for (const person of [...graph.persons].sort(comparePeople)) {
    personsById.set(person.id, person);
  }

  const normalizedRelations = graph.parentChildRelations.map(relation =>
    relation.unionId
      ? relation
      : {
          ...relation,
          unionId: `derived:child:${relation.childId}`,
        },
  );

  const suppliedUnions = new Map(graph.unions.map(union => [union.id, union]));
  const relationMembersByUnionId = new Map<UnionId, Set<PersonId>>();
  for (const relation of normalizedRelations) {
    if (!relation.unionId) continue;
    const values =
      relationMembersByUnionId.get(relation.unionId) ?? new Set<PersonId>();
    values.add(relation.parentId);
    relationMembersByUnionId.set(relation.unionId, values);
  }
  // Progressive and legacy payloads can contain the union row before (or
  // without) its materialized memberIds while the relation rows already carry
  // the authoritative parent ids. Indexing only the supplied array makes such
  // a parent look childless and stops descendant traversal at that card.
  // Reconcile both sources without mutating the transport graph.
  const normalizedSuppliedUnions = graph.unions.map(union => {
    const relationMembers = relationMembersByUnionId.get(union.id);
    if (!relationMembers?.size) return union;
    const suppliedMemberIds = [...new Set(union.memberIds)];
    const suppliedMemberSet = new Set(suppliedMemberIds);
    const missingMemberIds = [...relationMembers]
      .filter(memberId => !suppliedMemberSet.has(memberId))
      .sort(compareCodePoints);
    return missingMemberIds.length === 0
      ? union
      : { ...union, memberIds: [...suppliedMemberIds, ...missingMemberIds] };
  });
  const allUnions: TreeUnion[] = [
    ...normalizedSuppliedUnions,
    ...[...relationMembersByUnionId.entries()]
      .filter(([id]) => !suppliedUnions.has(id))
      .map(([id, memberIds]) => ({
      id,
      kind: "parent-set" as const,
      memberIds: [...memberIds].sort(compareCodePoints),
      expectedParentSlots: memberIds.size < 2 ? 2 : memberIds.size,
      })),
  ];

  const unionsById = new Map<UnionId, TreeUnion>();
  const unionsByMemberId = new Map<PersonId, TreeUnion[]>();
  for (const union of allUnions.sort(compareUnions)) {
    unionsById.set(union.id, union);
    for (const memberId of [...new Set(union.memberIds)].sort(compareCodePoints)) {
      pushMap(unionsByMemberId, memberId, union);
    }
  }

  const invalidCycleRelationIds = findCycleRelations(
    [...personsById.keys()],
    normalizedRelations,
  );
  const relationsByParentId = new Map<PersonId, ParentChildRelation[]>();
  const relationsByChildId = new Map<PersonId, ParentChildRelation[]>();
  const relationsByUnionId = new Map<UnionId, ParentChildRelation[]>();

  for (const relation of [...normalizedRelations].sort(compareRelations)) {
    if (invalidCycleRelationIds.has(relation.id)) continue;
    pushMap(relationsByParentId, relation.parentId, relation);
    pushMap(relationsByChildId, relation.childId, relation);
    if (relation.unionId) pushMap(relationsByUnionId, relation.unionId, relation);
  }

  const childrenByUnionId = new Map<UnionId, PersonId[]>();
  for (const [unionId, relations] of relationsByUnionId) {
    const unique = [...new Set(relations.map(relation => relation.childId))];
    unique.sort((a, b) => {
      const personA = personsById.get(a);
      const personB = personsById.get(b);
      if (personA && personB) return comparePeopleByBirth(personA, personB);
      return compareCodePoints(a, b);
    });
    childrenByUnionId.set(unionId, unique);
  }

  const index: GraphIndex = {
    personsById,
    unionsById,
    unionsByMemberId: sortMapValues(unionsByMemberId, compareUnions),
    relationsByParentId: sortMapValues(relationsByParentId, compareRelations),
    relationsByChildId: sortMapValues(relationsByChildId, compareRelations),
    relationsByUnionId: sortMapValues(relationsByUnionId, compareRelations),
    childrenByUnionId,
    invalidCycleRelationIds,
  };
  graphIndexCache.set(graph, {
    persons: graph.persons,
    unions: graph.unions,
    parentChildRelations: graph.parentChildRelations,
    index,
  });
  return index;
}

export function parentRoleOrder(
  person: TreePerson | undefined,
  relation: ParentChildRelation | undefined,
): number {
  if (relation?.role === "father") return 0;
  if (person?.sex === "male") return 1;
  if (relation?.role === "mother") return 5;
  if (person?.sex === "female") return 4;
  return ROLE_ORDER[relation?.role ?? "unknown"] ?? 3;
}
