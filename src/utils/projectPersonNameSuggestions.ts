export const PERSON_NAME_SUGGESTION_MIN_QUERY_LENGTH = 2;
export const PERSON_NAME_SUGGESTION_DEFAULT_LIMIT = 6;
export const PERSON_NAME_SUGGESTION_MAX_LIMIT = 10;

export type ProjectPersonNameSuggestionMatchType =
  | "exact"
  | "normalized"
  | "variant"
  | "fuzzy";

export interface ProjectPersonNameSuggestion {
  personId: string;
  personNameId: string;
  /** Current title of the existing person card. */
  displayName: string;
  /** Historical spelling that matched the user's input. */
  matchedName: string;
  matchType: ProjectPersonNameSuggestionMatchType;
  score: number;
}

export interface PersonNameSuggestionDraftValues {
  originalText: string;
  fullNormalized: string;
  fullName: string;
}

/**
 * Uses the most source-faithful populated field first. This is deliberately a
 * read-only lookup value: it is never copied into a person or name record.
 */
export function projectPersonNameSuggestionQuery(
  draft: PersonNameSuggestionDraftValues,
): string {
  return [draft.originalText, draft.fullNormalized, draft.fullName]
    .map((value) => value.trim())
    .find((value) => value.length >= PERSON_NAME_SUGGESTION_MIN_QUERY_LENGTH) ?? "";
}

export function projectPersonNameSuggestionLimit(value: number): number {
  if (!Number.isFinite(value)) return PERSON_NAME_SUGGESTION_DEFAULT_LIMIT;
  return Math.min(PERSON_NAME_SUGGESTION_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

export function mapProjectPersonNameSuggestions(
  value: unknown,
  options: { excludePersonId?: string; limit?: number } = {},
): ProjectPersonNameSuggestion[] {
  if (!Array.isArray(value)) return [];
  const limit = projectPersonNameSuggestionLimit(
    options.limit ?? PERSON_NAME_SUGGESTION_DEFAULT_LIMIT,
  );
  const seenPeople = new Set<string>();
  const suggestions: ProjectPersonNameSuggestion[] = [];

  for (const candidate of value) {
    const row = asRecord(candidate);
    const personId = stringValue(row.personId);
    const personNameId = stringValue(row.personNameId);
    if (
      !personId
      || !personNameId
      || personId === options.excludePersonId
      || seenPeople.has(personId)
    ) continue;

    const displayName = stringValue(row.displayName).trim();
    const matchedName = stringValue(row.matchedName).trim();
    if (!displayName && !matchedName) continue;

    seenPeople.add(personId);
    suggestions.push({
      personId,
      personNameId,
      displayName: displayName || matchedName || "Особа без імені",
      matchedName: matchedName || displayName,
      matchType: personNameSuggestionMatchType(row.matchType),
      score: finiteNumber(row.score),
    });
    if (suggestions.length >= limit) break;
  }

  return suggestions;
}

export function projectPersonNameSuggestionMatchLabel(
  value: ProjectPersonNameSuggestionMatchType,
): string {
  switch (value) {
    case "exact": return "Точний збіг";
    case "normalized": return "Нормалізований збіг";
    case "variant": return "Варіант написання";
    case "fuzzy": return "Схоже написання";
  }
}

function personNameSuggestionMatchType(value: unknown): ProjectPersonNameSuggestionMatchType {
  return value === "exact"
    || value === "normalized"
    || value === "variant"
    || value === "fuzzy"
    ? value
    : "fuzzy";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function finiteNumber(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}
