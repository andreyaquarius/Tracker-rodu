import type { Person } from "../types";
import { formatDateForDisplay } from "./dateHelpers.ts";

export interface GedcomPersonSearchEntry {
  person: Person;
  label: string;
  normalizedName: string;
  normalizedSearchText: string;
  sourceIndex: number;
}

const DEFAULT_RESULT_LIMIT = 20;

/** Precomputes normalized text once so large GEDCOM previews remain responsive. */
export function buildGedcomPersonSearchIndex(people: Person[]): GedcomPersonSearchEntry[] {
  return people.map((person, sourceIndex) => {
    const displayName = gedcomPersonDisplayName(person);
    const nameParts = [
      displayName,
      person.fullName,
      person.surname,
      person.maidenSurname,
      person.givenName,
      person.patronymic,
    ];
    const dateParts = [
      person.birthDate,
      formatDateForDisplay(person.birthDate),
      person.birthYearFrom,
      person.birthYearTo,
      person.deathDate,
      formatDateForDisplay(person.deathDate),
      person.deathYearFrom,
      person.deathYearTo,
    ];

    return {
      person,
      label: gedcomPersonSearchLabel(person),
      normalizedName: normalizeGedcomPersonSearchText(nameParts.join(" ")),
      normalizedSearchText: normalizeGedcomPersonSearchText([...nameParts, ...dateParts].join(" ")),
      sourceIndex,
    };
  });
}

export function searchGedcomPeople(
  index: GedcomPersonSearchEntry[],
  query: string,
  limit = DEFAULT_RESULT_LIMIT,
): GedcomPersonSearchEntry[] {
  const normalizedQuery = normalizeGedcomPersonSearchText(query);
  if (!normalizedQuery || limit <= 0) return [];

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const matches: Array<{ entry: GedcomPersonSearchEntry; score: number }> = [];
  for (const entry of index) {
    if (!tokens.every((token) => entry.normalizedSearchText.includes(token))) continue;

    let score = 3;
    if (entry.normalizedName === normalizedQuery) score = 0;
    else if (entry.normalizedName.startsWith(normalizedQuery)) score = 1;
    else if (entry.normalizedName.includes(normalizedQuery)) score = 2;
    matches.push({ entry, score });
  }

  matches.sort((first, second) => (
    first.score - second.score
    || first.entry.sourceIndex - second.entry.sourceIndex
  ));
  return matches.slice(0, limit).map(({ entry }) => entry);
}

export function normalizeGedcomPersonSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[\u2018\u2019\u02bc`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function gedcomPersonSearchLabel(person: Person): string {
  const lifeFacts = [
    personLifeDateLabel("нар.", person.birthDate, person.birthYearFrom, person.birthYearTo),
    personLifeDateLabel("пом.", person.deathDate, person.deathYearFrom, person.deathYearTo),
  ].filter(Boolean);
  return `${gedcomPersonDisplayName(person)}${lifeFacts.length ? ` (${lifeFacts.join(", ")})` : ""}`;
}

export function gedcomPersonDisplayName(person: Person): string {
  return person.fullName
    || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")
    || "Особа без імені";
}

function personLifeDateLabel(prefix: string, exact: string, from: string, to: string): string {
  const exactDate = exact.trim();
  const dateText = exactDate ? formatDateForDisplay(exactDate) : yearRangeText(from, to);
  return dateText ? `${prefix} ${dateText}` : "";
}

function yearRangeText(from: string, to: string): string {
  const normalizedFrom = from.trim();
  const normalizedTo = to.trim();
  if (normalizedFrom && normalizedTo && normalizedFrom !== normalizedTo) {
    return `${normalizedFrom}\u2013${normalizedTo}`;
  }
  return normalizedFrom || normalizedTo;
}
