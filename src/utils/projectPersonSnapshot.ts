import type { Person, PersonRelation } from "../types/index.ts";

export function mergeProjectPersonSnapshot(
  currentPersons: readonly Person[],
  currentRelations: readonly PersonRelation[],
  person: Person,
  authoritativeRelations: readonly PersonRelation[],
): { persons: Person[]; relations: PersonRelation[] } {
  const existingIndex = currentPersons.findIndex((item) => item.id === person.id);
  const persons = existingIndex >= 0
    ? currentPersons.map((item, index) => (index === existingIndex ? person : item))
    : [person, ...currentPersons];
  const relations = [
    ...currentRelations.filter(
      (relation) => relation.personId !== person.id && relation.relatedPersonId !== person.id,
    ),
    ...new Map(authoritativeRelations.map((relation) => [relation.id, relation])).values(),
  ];
  return { persons, relations };
}
