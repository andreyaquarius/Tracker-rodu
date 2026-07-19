import type { Person } from "../types";
import { createId } from "./id.ts";

export type PersonCreatableRelatedPage =
  | "findings"
  | "tasks"
  | "hypotheses"
  | "archiveRequests";

export function findingDraftForPerson(person: Person): Record<string, unknown> {
  const name = relatedPersonDisplayName(person);
  return {
    researchId: person.researchId,
    personIds: [person.id],
    personsText: name,
    participants: [{
      id: createId(),
      role: "Згадана особа",
      name,
      notes: "Додано з картки особи",
    }],
    place: relatedPersonPlace(person),
  };
}

export function taskDraftForPerson(person: Person): Record<string, unknown> {
  return {
    researchId: person.researchId,
    personIds: [person.id],
    personName: relatedPersonDisplayName(person),
    place: relatedPersonPlace(person),
  };
}

export function hypothesisDraftForPerson(person: Person): Record<string, unknown> {
  return {
    researchId: person.researchId,
    personIds: [person.id],
    relatedPeople: relatedPersonDisplayName(person),
  };
}

export function archiveRequestDraftForPerson(person: Person): Record<string, unknown> {
  return {
    researchId: person.researchId,
    personIds: [person.id],
    subject: `Запит щодо ${relatedPersonDisplayName(person)}`,
  };
}

export function relatedRecordDraftForPerson(
  page: PersonCreatableRelatedPage,
  person: Person,
): Record<string, unknown> {
  switch (page) {
    case "findings": return findingDraftForPerson(person);
    case "tasks": return taskDraftForPerson(person);
    case "hypotheses": return hypothesisDraftForPerson(person);
    case "archiveRequests": return archiveRequestDraftForPerson(person);
  }
}

function relatedPersonDisplayName(person: Person): string {
  return person.fullName.trim()
    || [person.surname, person.givenName, person.patronymic]
      .map((value) => value.trim())
      .filter(Boolean)
      .join(" ")
    || "Особа без імені";
}

function relatedPersonPlace(person: Person): string {
  return person.birthPlace.trim()
    || person.residencePlaces.split(/[,;\n]/u)[0]?.trim()
    || "";
}
