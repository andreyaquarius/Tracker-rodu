import type { PersonEvent, PersonEventType } from "../../types";
import { formatDateForDisplay } from "../../utils/dateHelpers.ts";
import { PERSON_EVENT_TYPES, personEventLabel } from "../../utils/geo.ts";

const canonicalEventTypes = new Set<string>(PERSON_EVENT_TYPES);

const eventTypeAliases: Readonly<Record<string, PersonEventType>> = {
  "military service": "military",
  "military_service": "military",
  "revision list": "revision_list",
  "confession list": "confession_list",
  "household register": "household_register",
};

const gedcomDateTokens: Readonly<Record<string, string>> = {
  FROM: "від",
  TO: "до",
  BET: "між",
  AND: "і",
  ABT: "бл.",
  EST: "орієнт.",
  CAL: "обчисл.",
  BEF: "до",
  AFT: "після",
  JAN: "січ.",
  FEB: "лют.",
  MAR: "бер.",
  APR: "квіт.",
  MAY: "трав.",
  JUN: "черв.",
  JUL: "лип.",
  AUG: "серп.",
  SEP: "вер.",
  OCT: "жовт.",
  NOV: "лист.",
  DEC: "груд.",
};

/** Localizes known persisted event codes without mutating imported source data. */
export function personEventTypeDisplayLabel(rawType?: string | null): string {
  const value = rawType?.trim() ?? "";
  if (!value) return "";
  const normalized = normalizeEventText(value);
  const aliased = eventTypeAliases[normalized];
  if (aliased) return personEventLabel(aliased);
  const canonical = normalized.replaceAll(" ", "_");
  if (canonicalEventTypes.has(canonical)) {
    return personEventLabel(canonical as PersonEventType);
  }
  return value;
}

/** Uses the canonical Ukrainian title while preserving meaningful custom titles as a subtitle. */
export function personTimelineEventDisplayTitle(
  event: Pick<PersonEvent, "type" | "title">,
): string {
  const customTitle = event.title?.trim() ?? "";
  if (event.type === "other" && customTitle) return customTitle;
  return personEventLabel(event.type);
}

export function personTimelineEventDisplaySubtitle(
  event: Pick<PersonEvent, "type" | "title">,
): string {
  const customTitle = event.title?.trim() ?? "";
  if (!customTitle || event.type === "other") return "";
  const canonicalTitle = personEventLabel(event.type);
  const normalizedTitle = normalizeEventText(customTitle);
  const titleType = eventTypeAliases[normalizedTitle]
    ?? (canonicalEventTypes.has(normalizedTitle.replaceAll(" ", "_"))
      ? normalizedTitle.replaceAll(" ", "_") as PersonEventType
      : null);
  if (
    normalizeEventText(canonicalTitle) === normalizedTitle
    || titleType === event.type
  ) return "";
  return customTitle;
}

/** Formats ISO and GEDCOM-style dates for display while keeping their original precision. */
export function personTimelineDateDisplay(value?: string | null): string {
  const source = value?.trim() ?? "";
  if (!source) return "";
  const formatted = formatDateForDisplay(source);
  if (formatted !== source) return formatted;
  return Object.entries(gedcomDateTokens)
    .reduce(
      (current, [token, replacement]) => current.replace(
        new RegExp(`\\b${token}\\b`, "giu"),
        replacement,
      ),
      source,
    )
    .replace(/\s+/gu, " ")
    .trim();
}

/** Returns a machine-readable value only when HTML's time element supports it. */
export function personTimelineDateTimeValue(value?: string | null): string | undefined {
  const normalized = value?.trim() ?? "";
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u.exec(normalized);
  if (!match) return undefined;
  const year = Number(match[1]);
  if (year < 1) return undefined;
  if (!match[2]) return normalized;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  if (!match[3]) return normalized;
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]
    ? normalized
    : undefined;
}

function normalizeEventText(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("uk-UA")
    .replace(/[-_]+/gu, " ")
    .replace(/\s+/gu, " ");
}
