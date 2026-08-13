import type { Person, PersonGender, PersonStatus } from "../types";
import {
  formatFlexibleDateForDisplay,
  normalizeFlexibleDateInput,
  nowIso,
} from "./dateHelpers.ts";
import { normalizePersonEvents } from "./geo.ts";

export type QuickPersonEditDateField =
  | "birthDate"
  | "marriageDate"
  | "deathDate";

export interface QuickPersonEditDraft {
  surname: string;
  maidenSurname: string;
  givenName: string;
  patronymic: string;
  gender: PersonGender;
  status: PersonStatus;
  isLiving: boolean;
  birthDate: string;
  birthPlace: string;
  marriageDate: string;
  marriagePlace: string;
  deathDate: string;
  deathPlace: string;
}

export type QuickPersonEditDateErrors = Partial<
  Record<QuickPersonEditDateField, string>
>;

export type QuickPersonEditBuildResult =
  | { person: Person; errors: QuickPersonEditDateErrors }
  | { person: null; errors: QuickPersonEditDateErrors };

export function quickPersonEditDraft(person: Person): QuickPersonEditDraft {
  return {
    surname: person.surname ?? "",
    maidenSurname: person.maidenSurname ?? "",
    givenName: person.givenName ?? "",
    patronymic: person.patronymic ?? "",
    gender: person.gender,
    status: person.status,
    isLiving: person.isLiving ?? false,
    birthDate: formatFlexibleDateForDisplay(person.birthDate),
    birthPlace: person.birthPlace ?? "",
    marriageDate: formatFlexibleDateForDisplay(person.marriageDate),
    marriagePlace: person.marriagePlace ?? "",
    deathDate: formatFlexibleDateForDisplay(person.deathDate),
    deathPlace: person.deathPlace ?? "",
  };
}

export function buildQuickPersonEdit(
  person: Person,
  draft: QuickPersonEditDraft,
  updatedAt = nowIso(),
): QuickPersonEditBuildResult {
  const dateFields: QuickPersonEditDateField[] = draft.isLiving
    ? ["birthDate", "marriageDate"]
    : ["birthDate", "marriageDate", "deathDate"];
  const normalizedDates: Record<QuickPersonEditDateField, string> = {
    birthDate: "",
    marriageDate: "",
    deathDate: "",
  };
  const errors: QuickPersonEditDateErrors = {};

  for (const field of dateFields) {
    const normalized = normalizeFlexibleDateInput(draft[field]);
    if (normalized.error) errors[field] = normalized.error;
    else normalizedDates[field] = normalized.value;
  }
  if (Object.keys(errors).length) return { person: null, errors };

  const surname = draft.surname.trim();
  const givenName = draft.givenName.trim();
  const patronymic = draft.patronymic.trim();
  const composedFullName = [surname, givenName, patronymic]
    .filter(Boolean)
    .join(" ");
  const patchedPerson: Person = {
    ...person,
    surname,
    maidenSurname: draft.gender === "жінка"
      ? draft.maidenSurname.trim()
      : "",
    givenName,
    patronymic,
    fullName: composedFullName || (person.fullName ?? "").trim(),
    gender: draft.gender,
    status: draft.status,
    isLiving: draft.isLiving,
    birthDate: normalizedDates.birthDate,
    birthPlace: draft.birthPlace.trim(),
    marriageDate: normalizedDates.marriageDate,
    marriagePlace: draft.marriagePlace.trim(),
    deathDate: draft.isLiving ? "" : normalizedDates.deathDate,
    deathYearFrom: draft.isLiving ? "" : person.deathYearFrom,
    deathYearTo: draft.isLiving ? "" : person.deathYearTo,
    deathPlace: draft.isLiving ? "" : draft.deathPlace.trim(),
    updatedAt,
  };

  return {
    person: {
      ...patchedPerson,
      // Rebuild only the canonical birth/marriage/death projections. Extra
      // events, map coordinates, addresses and every non-quick field survive.
      events: normalizePersonEvents(
        draft.isLiving
          ? (person.events ?? []).filter((event) => event.type !== "death")
          : (person.events ?? []),
        patchedPerson,
      ),
    },
    errors: {},
  };
}
