import type { FamilyGraphData, ParentRole } from "../types.ts";

export type FamilyTreeDetachKind = "parent_child" | "partner";

export interface FamilyTreeDetachCandidate {
  key: string;
  kind: FamilyTreeDetachKind;
  relationshipId: string;
  relatedPersonId: string;
  personLabel: string;
  relationLabel: string;
}

export interface FamilyTreeDetachableRelationshipDescriptor {
  kind: FamilyTreeDetachKind;
  direction: "parent" | "child" | "partner";
  relationshipId: string;
  relatedPersonId: string;
  parentRoleLabel?: ParentRole;
}

const PARTNERSHIP_UNION_PREFIX = "partnership:";

/**
 * Returns only direct, persisted relationships of the selected person.
 * Removing one of these rows never removes either canonical person.
 */
export function familyTreeDetachCandidates(
  graph: FamilyGraphData,
  personId: string,
): FamilyTreeDetachCandidate[] {
  if (!personId) return [];
  const names = new Map(graph.persons.map((person) => [person.id, person.displayName]));
  const result: FamilyTreeDetachCandidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: Omit<FamilyTreeDetachCandidate, "key">) => {
    const key = [candidate.kind, candidate.relationshipId, candidate.relatedPersonId].join(":");
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ ...candidate, key });
  };

  for (const relation of graph.parentChildRelations) {
    if (relation.childId === personId) {
      add({
        kind: "parent_child",
        relationshipId: relation.id,
        relatedPersonId: relation.parentId,
        personLabel: names.get(relation.parentId) ?? "Особа без імені",
        relationLabel: parentRoleLabel(relation.role),
      });
    } else if (relation.parentId === personId) {
      add({
        kind: "parent_child",
        relationshipId: relation.id,
        relatedPersonId: relation.childId,
        personLabel: names.get(relation.childId) ?? "Особа без імені",
        relationLabel: "Дитина",
      });
    }
  }

  for (const union of graph.unions) {
    if (union.kind !== "partnership" || !union.memberIds.includes(personId)) continue;
    const relationshipId = partnershipRelationshipId(union.id);
    if (!relationshipId) continue;
    for (const relatedPersonId of union.memberIds) {
      if (relatedPersonId === personId) continue;
      add({
        kind: "partner",
        relationshipId,
        relatedPersonId,
        personLabel: names.get(relatedPersonId) ?? "Особа без імені",
        relationLabel: "Партнер / партнерка",
      });
    }
  }

  return result.sort((left, right) => (
    detachKindOrder(left.kind) - detachKindOrder(right.kind) ||
    left.relationLabel.localeCompare(right.relationLabel, "uk") ||
    left.personLabel.localeCompare(right.personLabel, "uk")
  ));
}

/** Builds labels for complete relationship rows read directly from the tree. */
export function familyTreeDetachCandidatesFromRelationships(
  relationships: readonly FamilyTreeDetachableRelationshipDescriptor[],
  personLabelById: ReadonlyMap<string, string>,
): FamilyTreeDetachCandidate[] {
  const candidates = relationships.map((relationship) => ({
    key: [
      relationship.kind,
      relationship.relationshipId,
      relationship.relatedPersonId,
    ].join(":"),
    kind: relationship.kind,
    relationshipId: relationship.relationshipId,
    relatedPersonId: relationship.relatedPersonId,
    personLabel: personLabelById.get(relationship.relatedPersonId) ?? "Особа без імені",
    relationLabel: relationship.direction === "partner"
      ? "Партнер / партнерка"
      : relationship.direction === "child"
        ? "Дитина"
        : parentRoleLabel(relationship.parentRoleLabel),
  }));
  return [...new Map(candidates.map((candidate) => [candidate.key, candidate])).values()]
    .sort((left, right) => (
      detachKindOrder(left.kind) - detachKindOrder(right.kind) ||
      left.relationLabel.localeCompare(right.relationLabel, "uk") ||
      left.personLabel.localeCompare(right.personLabel, "uk")
    ));
}

function partnershipRelationshipId(unionId: string): string {
  return unionId.startsWith(PARTNERSHIP_UNION_PREFIX)
    ? unionId.slice(PARTNERSHIP_UNION_PREFIX.length)
    : unionId;
}

function parentRoleLabel(role: ParentRole | undefined): string {
  if (role === "father" || role === "stepfather" || role === "adoptive_father") return "Батько";
  if (role === "mother" || role === "stepmother" || role === "adoptive_mother") return "Мати";
  if (role === "guardian") return "Опікун / опікунка";
  return "Один з батьків";
}

function detachKindOrder(kind: FamilyTreeDetachKind): number {
  return kind === "parent_child" ? 0 : 1;
}
