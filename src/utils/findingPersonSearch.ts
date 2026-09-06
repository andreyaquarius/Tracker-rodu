import type { Person } from "../types/index.ts";
import { formatDateForDisplay } from "./dateHelpers.ts";
import {
  projectPersonNameSuggestionMatchLabel,
  type ProjectPersonNameSuggestion,
} from "./projectPersonNameSuggestions.ts";

export interface FindingPersonSearchEntry {
  person: Person;
  label: string;
  details: string;
  names: Array<{ value: string; normalized: string; variant: boolean }>;
  nameTokens: string[];
  searchText: string;
}

export interface FindingPersonMatch {
  entry: FindingPersonSearchEntry;
  score: number;
  reason: string;
  matchedName?: string;
}

/** Search keys only: never write these transformations back into source text. */
export function normalizeFindingPersonSearch(value: string): string {
  return value.normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[\u0300\u0301]/gu, "")
    .replace(/['’‘ʼ`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function buildFindingPersonSearchIndex(
  persons: readonly Person[],
): FindingPersonSearchEntry[] {
  return persons.map((person) => {
    const structuredName = [person.surname, person.givenName, person.patronymic]
      .filter(Boolean).join(" ");
    const label = person.fullName || structuredName || "Особа без імені";
    const variants = [person.nameVariants, person.surnameVariants]
      .flatMap((value) => value.split(/[;,\n|]/u)).filter((value) => value.trim());
    if (person.maidenSurname) {
      variants.push([person.maidenSurname, person.givenName, person.patronymic]
        .filter(Boolean).join(" "));
    }
    const names = [
      ...[person.fullName, structuredName].map((value) => ({ value, variant: false })),
      ...variants.map((value) => ({ value, variant: true })),
    ].filter(({ value }) => value.trim())
      .map((name) => ({ ...name, normalized: normalizeFindingPersonSearch(name.value) }));
    const nameText = names.map((name) => name.normalized).join(" ");
    const birth = lifeDate(person.birthDate, person.birthYearFrom, person.birthYearTo);
    const death = lifeDate(person.deathDate, person.deathYearFrom, person.deathYearTo);
    const place = person.birthPlace || person.residencePlaces || person.deathPlace;
    const details = [birth && `нар. ${birth}`, death && `пом. ${death}`, place]
      .filter(Boolean).join(" · ");
    return {
      person,
      label,
      details,
      names,
      nameTokens: [...new Set(nameText.split(" ").filter(Boolean))],
      searchText: normalizeFindingPersonSearch([
        nameText, birth, death, person.birthDate, person.deathDate,
        person.birthPlace, person.deathPlace, person.residencePlaces,
      ].join(" ")),
    };
  });
}

export function findPeopleForFinding(
  index: readonly FindingPersonSearchEntry[],
  query: string,
): FindingPersonMatch[] {
  const normalized = normalizeFindingPersonSearch(query);
  const tokens = normalized.split(" ").filter(Boolean);
  return index.flatMap((entry): FindingPersonMatch[] => {
    const nameMatch = matchName(entry, normalized, false);
    if (!tokens.length || tokens.every((token) => entry.searchText.includes(token))) {
      return [{ entry, score: nameMatch?.score ?? 100, reason: nameMatch?.reason ?? "Результат пошуку",
        ...(nameMatch?.matchedName ? { matchedName: nameMatch.matchedName } : {}) }];
    }
    return nameMatch && nameMatch.score >= 600 ? [nameMatch] : [];
  }).sort(compareMatches);
}

export function suggestPeopleForFinding(
  index: readonly FindingPersonSearchEntry[],
  sourceNames: readonly string[],
): FindingPersonMatch[] {
  const queries = [...new Set(sourceNames.map(normalizeFindingPersonSearch))]
    .filter((query) => query.length >= 2);
  if (!queries.length) return [];
  return index.flatMap((entry): FindingPersonMatch[] => {
    const matches = queries.flatMap((query) => {
      const match = matchName(entry, query, true);
      return match ? [match] : [];
    }).sort(compareMatches);
    return matches.length ? [matches[0]!] : [];
  }).sort(compareMatches);
}

/** Remote hints may enrich only people already present in the allowed scope. */
export function mergeFindingPersonMatches(
  local: readonly FindingPersonMatch[],
  historical: readonly ProjectPersonNameSuggestion[],
  index: readonly FindingPersonSearchEntry[],
): FindingPersonMatch[] {
  const allowed = new Map(index.map((entry) => [entry.person.id, entry]));
  const byPerson = new Map(local.filter((match) => allowed.has(match.entry.person.id))
    .map((match) => [match.entry.person.id, match]));
  const scores = { exact: 1000, normalized: 950, variant: 850, fuzzy: 600 };
  for (const hint of historical) {
    const entry = allowed.get(hint.personId);
    if (!entry) continue;
    const score = scores[hint.matchType] ?? 600;
    const current = byPerson.get(hint.personId);
    if (current && current.score >= score) continue;
    byPerson.set(hint.personId, {
      entry,
      score,
      reason: `${projectPersonNameSuggestionMatchLabel(hint.matchType)} історичного імені`,
      matchedName: hint.matchedName,
    });
  }
  return [...byPerson.values()].sort(compareMatches);
}

function matchName(
  entry: FindingPersonSearchEntry,
  query: string,
  allowPartial: boolean,
): FindingPersonMatch | null {
  const tokens = [...new Set(query.split(" ").filter(Boolean))];
  if (!tokens.length) return null;
  for (const name of entry.names) {
    if (name.normalized === query) {
      return { entry, score: name.variant ? 900 : 1000,
        reason: name.variant ? "Збіг варіанта написання" : "Збіг повного імені",
        ...(name.variant ? { matchedName: name.value } : {}) };
    }
  }
  const exactCount = tokens.filter((token) => entry.nameTokens.includes(token)).length;
  if (exactCount === tokens.length) {
    return { entry, score: 800 + Math.min(tokens.length, 10), reason: "Збіг слів імені" };
  }
  const fuzzyCount = tokens.filter((token) => entry.nameTokens.some((nameToken) => (
    nameToken === token || oneLetterDifference(token, nameToken)
  ))).length;
  if (fuzzyCount === tokens.length) {
    return { entry, score: 600 + exactCount, reason: "Схоже написання імені" };
  }
  if (allowPartial && exactCount >= 2 && exactCount / tokens.length >= 0.6) {
    return { entry, score: 400 + exactCount, reason: "Збіг частини імені — перевірте решту" };
  }
  return null;
}

/** One typo or adjacent transposition in a long name; never fuzzy-match years. */
function oneLetterDifference(left: string, right: string): boolean {
  if (Math.min(left.length, right.length) < 5 || /\d/u.test(left + right)) return false;
  if (Math.abs(left.length - right.length) > 1) return false;
  let index = 0;
  while (index < Math.min(left.length, right.length) && left[index] === right[index]) index += 1;
  if (left.length === right.length) {
    return left.slice(index + 1) === right.slice(index + 1)
      || (left[index] === right[index + 1] && left[index + 1] === right[index]
        && left.slice(index + 2) === right.slice(index + 2));
  }
  return left.length > right.length
    ? left.slice(index + 1) === right.slice(index)
    : left.slice(index) === right.slice(index + 1);
}

function compareMatches(left: FindingPersonMatch, right: FindingPersonMatch): number {
  return right.score - left.score
    || left.entry.label.localeCompare(right.entry.label, "uk")
    || left.entry.details.localeCompare(right.entry.details, "uk")
    || left.entry.person.id.localeCompare(right.entry.person.id);
}

function lifeDate(exact: string, from: string, to: string): string {
  if (exact) return formatDateForDisplay(exact);
  return from && to && from !== to ? `${from}–${to}` : from || to;
}
