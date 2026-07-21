import type { PersonRelation } from "../types/index.ts";

export function reconcileProjectPersonRelationsForPair(
  current: readonly PersonRelation[],
  authoritative: readonly PersonRelation[],
  leftPersonId: string,
  rightPersonId: string,
  deletedRelationIds: readonly string[] = [],
): PersonRelation[] {
  const deletedIds = new Set(deletedRelationIds);
  const next = current.filter((relation) => (
    !deletedIds.has(relation.id)
    && !isPersonRelationForPair(
      relation.personId,
      relation.relatedPersonId,
      leftPersonId,
      rightPersonId,
    )
  ));
  const existingIds = new Set(next.map((relation) => relation.id));
  for (const relation of authoritative) {
    if (
      existingIds.has(relation.id)
      || !isPersonRelationForPair(
        relation.personId,
        relation.relatedPersonId,
        leftPersonId,
        rightPersonId,
      )
    ) {
      continue;
    }
    next.push(relation);
    existingIds.add(relation.id);
  }
  return next;
}

export function isPersonRelationForPair(
  personId: string,
  relatedPersonId: string,
  leftPersonId: string,
  rightPersonId: string,
): boolean {
  return (
    personId === leftPersonId && relatedPersonId === rightPersonId
  ) || (
    personId === rightPersonId && relatedPersonId === leftPersonId
  );
}
