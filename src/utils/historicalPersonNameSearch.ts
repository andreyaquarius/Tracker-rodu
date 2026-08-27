import type { ProjectSearchResult } from "./projectSearchResults.ts";

export function mapHistoricalPersonNameSearchResults(value: unknown): ProjectSearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const row = asRecord(candidate);
    const personId = stringValue(row.personId);
    if (!personId) return [];
    const name = asRecord(row.name);
    const currentDisplayName = stringValue(row.displayName);
    const matchedName = stringValue(row.matchedName)
      || stringValue(name.fullNormalized)
      || stringValue(name.fullName)
      || stringValue(name.fullOriginal);
    const title = currentDisplayName || matchedName || "Особа без імені";
    const matchType = historicalNameMatchLabel(stringValue(row.matchType));
    return [{
      id: `person-name:${personId}`,
      entityId: personId,
      module: "persons",
      page: "persons" as const,
      moduleLabel: "Особи",
      title,
      description: matchedName && matchedName !== title
        ? `${matchType}: ${matchedName}`
        : matchType,
    }];
  });
}

function historicalNameMatchLabel(value: string): string {
  switch (value) {
    case "exact": return "Точний збіг історичного імені";
    case "normalized": return "Збіг нормалізованого імені";
    case "variant": return "Збіг за варіантом імені";
    case "fuzzy": return "Схоже історичне написання";
    default: return "Збіг за історичним ім’ям";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
