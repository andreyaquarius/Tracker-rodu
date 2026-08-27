import type {
  AppSettings,
  Person,
  PersonName,
  PersonNameDisplayMode,
} from "../types";

export const DEFAULT_PERSON_NAME_DISPLAY_MODE: PersonNameDisplayMode = "current";
export const DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE = "uk";

const DISPLAY_MODES = new Set<PersonNameDisplayMode>([
  "current",
  "primary",
  "interface_language",
  "valid_at_date",
  "original",
  "primary_with_variants",
]);

export interface PersonNameDisplayOptions {
  mode?: PersonNameDisplayMode | string | null;
  interfaceLanguage?: string | null;
  referenceDate?: string | null;
}

export interface ResolvedPersonNameDisplay {
  mode: PersonNameDisplayMode;
  /** Main label intended for headings. */
  label: string;
  /** Main label plus variants, suitable for a compact fact row. */
  inlineLabel: string;
  variantLabels: string[];
  selectedNameId: string | null;
  usedLegacyFallback: boolean;
}

export function normalizePersonNameDisplayMode(value: unknown): PersonNameDisplayMode {
  return typeof value === "string" && DISPLAY_MODES.has(value as PersonNameDisplayMode)
    ? value as PersonNameDisplayMode
    : DEFAULT_PERSON_NAME_DISPLAY_MODE;
}

export function personNameDisplayOptionsFromSettings(
  settings: Pick<
    AppSettings,
    "personNameDisplayMode" | "personNameDisplayLanguage" | "personNameDisplayDate"
  >,
): PersonNameDisplayOptions {
  return {
    mode: normalizePersonNameDisplayMode(settings.personNameDisplayMode),
    interfaceLanguage: cleanLanguage(settings.personNameDisplayLanguage)
      || DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE,
    referenceDate: typeof settings.personNameDisplayDate === "string"
      ? settings.personNameDisplayDate
      : "",
  };
}

/**
 * Resolves an additive display projection. It never modifies `Person`,
 * `PersonName`, or the exact `originalText` captured from a source.
 */
export function resolvePersonNameDisplay(
  person: Person,
  names: readonly PersonName[],
  options: PersonNameDisplayOptions = {},
): ResolvedPersonNameDisplay {
  const mode = normalizePersonNameDisplayMode(options.mode);
  const legacyLabel = legacyPersonLabel(person);
  if (mode === "current") return legacyResult(mode, legacyLabel);

  const ranked = [...names].sort(comparePersonNamesForDisplay);
  let selected: PersonName | undefined;
  let explicitLabel = "";

  if (mode === "interface_language") {
    const expectedLanguage = cleanLanguage(options.interfaceLanguage)
      || DEFAULT_PERSON_NAME_DISPLAY_LANGUAGE;
    selected = ranked.find((name) => languageMatches(name.languageCode, expectedLanguage));
  } else if (mode === "valid_at_date") {
    const point = parseTemporalPoint(options.referenceDate);
    if (point !== null) {
      selected = ranked.find((name) => nameCoversPoint(name, point));
    }
  } else if (mode === "original") {
    selected = ranked
      .filter((name) => hasText(name.originalText) && !isManagedPersonProjection(name))
      .sort(compareOriginalSourceNames)[0];
    if (selected) explicitLabel = selected.originalText;
    // A generated compatibility projection repeats the current Person fields;
    // it is not documentary evidence and must never be presented as an
    // "original from the source". Keep the legacy card label when no genuine
    // source spelling is available.
    if (!selected) return legacyResult(mode, legacyLabel);
  } else {
    selected = ranked.find((name) => name.isPrimary)
      ?? ranked.find((name) => name.isPreferred);
  }

  if (!selected) {
    selected = ranked.find((name) => name.isPrimary)
      ?? ranked.find((name) => name.isPreferred);
  }

  const selectedLabel = explicitLabel || (selected ? displayPersonNameValue(selected) : "");
  const label = hasText(selectedLabel) ? selectedLabel : legacyLabel;
  const usedLegacyFallback = !hasText(selectedLabel);
  const variantLabels = mode === "primary_with_variants"
    ? collectVariantLabels(ranked, selected?.id ?? null, label)
    : [];

  return {
    mode,
    label,
    inlineLabel: variantLabels.length
      ? `${label} · Варіанти: ${variantLabels.join("; ")}`
      : label,
    variantLabels,
    selectedNameId: usedLegacyFallback ? null : selected?.id ?? null,
    usedLegacyFallback,
  };
}

export function displayPersonNameValue(name: PersonName): string {
  const stored = collapseWhitespace(name.fullNormalized || name.fullName);
  if (stored) return stored;
  const structured = [
    name.prefix,
    name.surname || name.maidenSurname,
    name.givenName,
    name.patronymic,
    name.suffix,
  ].map(collapseWhitespace).filter(Boolean).join(" ");
  if (structured) return structured;
  if (hasText(name.nickname)) return collapseWhitespace(name.nickname);
  // Return the source string as captured; do not normalize or rewrite it.
  return hasText(name.originalText) ? name.originalText : "";
}

function legacyResult(
  mode: PersonNameDisplayMode,
  label: string,
): ResolvedPersonNameDisplay {
  return {
    mode,
    label,
    inlineLabel: label,
    variantLabels: [],
    selectedNameId: null,
    usedLegacyFallback: true,
  };
}

function legacyPersonLabel(person: Person): string {
  const stored = collapseWhitespace(person.fullName);
  if (stored) return stored;
  const structured = [person.surname || person.maidenSurname, person.givenName, person.patronymic]
    .map(collapseWhitespace)
    .filter(Boolean)
    .join(" ");
  return structured || "Особа без імені";
}

function collectVariantLabels(
  names: readonly PersonName[],
  selectedId: string | null,
  selectedLabel: string,
): string[] {
  const seen = new Set([normalizedKey(selectedLabel)]);
  const variants: string[] = [];
  for (const name of names) {
    if (name.id === selectedId) continue;
    const value = displayPersonNameValue(name);
    const key = normalizedKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    variants.push(value);
  }
  return variants;
}

function comparePersonNamesForDisplay(left: PersonName, right: PersonName): number {
  return Number(right.isPrimary) - Number(left.isPrimary)
    || Number(right.isPreferred) - Number(left.isPreferred)
    || evidenceRank(right.evidenceStatus) - evidenceRank(left.evidenceStatus)
    || right.confidence - left.confidence
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function compareOriginalSourceNames(left: PersonName, right: PersonName): number {
  return originalSourceRank(right) - originalSourceRank(left)
    || comparePersonNamesForDisplay(left, right);
}

function originalSourceRank(name: PersonName): number {
  const sourceLinked = Boolean(
    name.sourceDocumentId
      || name.sourceFindingId
      || name.sourceId
      || name.citationId
      || name.documentFragmentId
      || hasText(name.sourceType),
  );
  const documentaryType = name.nameType === "document"
    || name.nameType === "original"
    || name.nameType === "source_error";
  return Number(sourceLinked) * 2 + Number(documentaryType);
}

function isManagedPersonProjection(name: PersonName): boolean {
  const source = name.metadata?.source;
  return typeof source === "string" && source.startsWith("persons_projection");
}

function evidenceRank(value: PersonName["evidenceStatus"]): number {
  if (value === "proven") return 4;
  if (value === "likely") return 3;
  if (value === "unknown") return 2;
  if (value === "disputed") return 1;
  return 0;
}

function languageMatches(actual: string, expected: string): boolean {
  const actualLanguage = cleanLanguage(actual);
  const expectedLanguage = cleanLanguage(expected);
  if (!actualLanguage || !expectedLanguage) return false;
  return actualLanguage === expectedLanguage
    || actualLanguage.split("-")[0] === expectedLanguage.split("-")[0];
}

function nameCoversPoint(name: PersonName, point: number): boolean {
  if (!hasText(name.validFrom) && !hasText(name.validTo)) return false;
  const from = parseTemporalBoundary(name.validFrom, "from");
  const to = parseTemporalBoundary(name.validTo, "to");
  if (from !== null && point < from) return false;
  if (to !== null && point > to) return false;
  return from !== null || to !== null;
}

function parseTemporalPoint(value: string | null | undefined): number | null {
  if (!hasText(value)) return null;
  const parts = dateParts(value);
  if (!parts) return null;
  return parts.year * 10_000 + (parts.month ?? 1) * 100 + (parts.day ?? 1);
}

function parseTemporalBoundary(
  value: string,
  edge: "from" | "to",
): number | null {
  if (!hasText(value)) return null;
  const parts = dateParts(value);
  if (!parts) return null;
  const month = parts.month ?? (edge === "from" ? 1 : 12);
  const day = parts.day ?? (edge === "from" ? 1 : daysInMonth(parts.year, month));
  return parts.year * 10_000 + month * 100 + day;
}

function dateParts(value: string): { year: number; month?: number; day?: number } | null {
  const match = value.match(/(?:^|\D)(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/u);
  if (!match) return null;
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : undefined;
  const day = match[3] ? Number(match[3]) : undefined;
  if (!Number.isInteger(year)) return null;
  if (month !== undefined && (month < 1 || month > 12)) return null;
  if (day !== undefined && (day < 1 || day > 31)) return null;
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function cleanLanguage(value: unknown): string {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("uk-UA") : "";
}

function normalizedKey(value: string): string {
  return collapseWhitespace(value).toLocaleLowerCase("uk-UA");
}

function collapseWhitespace(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
