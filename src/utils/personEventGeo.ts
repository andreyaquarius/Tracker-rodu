import type { PersonEvent, PersonEventType } from "../types/index.ts";
import type { HistoricalPlaceTemporalContext } from "../types/historicalPlaces.ts";
import { normalizeFlexibleDateInput } from "./dateHelpers.ts";
import { personEventLabel } from "./geo.ts";
import { createId } from "./id.ts";

/** Updates exactly one event, which is essential when a person has repeated events of one type. */
export function updatePersonEventById(
  events: readonly PersonEvent[],
  eventId: string,
  patch: Partial<PersonEvent>,
): PersonEvent[] {
  return events.map((event) => (
    event.id === eventId ? { ...event, ...patch } : event
  ));
}

/**
 * A manually edited display place can no longer prove a previously confirmed
 * catalogue identity. Clear only the canonical selection while preserving the
 * exact source wording, which is independent evidence.
 */
export function changePersonEventDisplayPlace(
  events: readonly PersonEvent[],
  eventId: string,
  placeName: string,
): PersonEvent[] {
  const normalizedPlaceName = placeName || null;
  return events.map((event) => {
    if (event.id !== eventId || (event.placeName ?? null) === normalizedPlaceName) return event;
    return {
      ...event,
      placeName: normalizedPlaceName,
      placeId: null,
      placeResolutionStatus: "unresolved",
      placeCanonicalName: null,
    };
  });
}

export function createPersonMapEvent(
  personId: string,
  type: PersonEventType = "other",
): PersonEvent {
  return {
    id: createId(),
    personId,
    type,
    title: personEventLabel(type),
    date: null,
    placeName: null,
    geo: null,
    notes: null,
  };
}

/**
 * The historical-place resolver accepts a real calendar date. A year, range
 * or approximate genealogical expression must stay date-less rather than be
 * silently converted to January 1.
 */
export function exactPersonEventDateForPlaceLookup(
  value?: string | null,
): string | null {
  return personEventTemporalContextForPlaceLookup(value)?.exactDate ?? null;
}

/**
 * Converts a genealogical date expression into a lossless lookup interval.
 * Years, ranges and approximate years are represented as periods and never as
 * a fabricated January 1 exact date.
 */
export function personEventTemporalContextForPlaceLookup(
  value?: string | null,
): HistoricalPlaceTemporalContext | null {
  const originalText = value?.trim() ?? "";
  if (!originalText) return null;

  const normalized = normalizeFlexibleDateInput(originalText);
  if (!normalized.error && /^\d{4}-\d{2}-\d{2}$/.test(normalized.value)) {
    return {
      exactDate: normalized.value,
      originalText,
      precision: "day",
    };
  }
  if (!normalized.error && /^\d{4}$/.test(normalized.value)) {
    return yearTemporalContext(normalized.value, originalText, "year");
  }

  const yearMonth = /^(\d{4})-(\d{1,2})$/.exec(originalText);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (year >= 1 && year <= 9999 && month >= 1 && month <= 12) {
      const paddedMonth = String(month).padStart(2, "0");
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return {
        periodFrom: `${yearMonth[1]}-${paddedMonth}-01`,
        periodTo: `${yearMonth[1]}-${paddedMonth}-${String(lastDay).padStart(2, "0")}`,
        originalText,
        precision: "month",
      };
    }
  }

  const range = /^(\d{4})\s*(?:-|–|—|\.\.|\.\.\.)\s*(\d{4})$/.exec(originalText)
    ?? /^(?:between|між)\s+(\d{4})\s+(?:and|і|та)\s+(\d{4})$/iu.exec(originalText);
  if (range) {
    const firstYear = Number(range[1]);
    const secondYear = Number(range[2]);
    if (validLookupYear(firstYear) && validLookupYear(secondYear)) {
      const fromYear = String(Math.min(firstYear, secondYear)).padStart(4, "0");
      const toYear = String(Math.max(firstYear, secondYear)).padStart(4, "0");
      return {
        periodFrom: `${fromYear}-01-01`,
        periodTo: `${toYear}-12-31`,
        originalText,
        precision: "range",
      };
    }
  }

  const circa = /(?:^|\s)(?:бл\.?|близько|прибл\.?|приблизно|circa|ca\.?|c\.?|~)\s*(\d{4})(?:\s|$)/iu.exec(originalText)
    ?? /^(\d{4})\s*[?~]$/u.exec(originalText);
  if (circa?.[1] && validLookupYear(Number(circa[1]))) {
    return yearTemporalContext(circa[1], originalText, "circa");
  }

  const before = /^(?:до|before)\s+(\d{4})$/iu.exec(originalText);
  if (before?.[1] && validLookupYear(Number(before[1]))) {
    return {
      periodFrom: "0001-01-01",
      periodTo: `${before[1]}-12-31`,
      originalText,
      precision: "before",
    };
  }

  const after = /^(?:після|after)\s+(\d{4})$/iu.exec(originalText);
  if (after?.[1] && validLookupYear(Number(after[1]))) {
    return {
      periodFrom: `${after[1]}-01-01`,
      periodTo: "9999-12-31",
      originalText,
      precision: "after",
    };
  }

  return { originalText, precision: "unknown" };
}

function yearTemporalContext(
  year: string,
  originalText: string,
  precision: "year" | "circa",
): HistoricalPlaceTemporalContext {
  return {
    periodFrom: `${year}-01-01`,
    periodTo: `${year}-12-31`,
    originalText,
    precision,
  };
}

function validLookupYear(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 9999;
}
