export function nowIso(): string {
  return new Date().toISOString();
}

export type FlexibleDateInputResult = {
  value: string;
  error?: string;
};

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeFlexibleDateInput(input: string): FlexibleDateInputResult {
  const value = input.trim();
  if (!value) return { value: "" };

  const yearOnlyMatch = value.match(/^(\d{4})$/);
  if (yearOnlyMatch) {
    const year = Number(yearOnlyMatch[1]);
    if (year >= 1 && year <= 9999) return { value: yearOnlyMatch[1] };
    return { value: "", error: "Рік має бути в межах 0001–9999." };
  }

  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const localMatch = value.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  const dashedLocalMatch = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  const match = isoMatch ?? localMatch ?? dashedLocalMatch;

  if (!match) {
    return {
      value: "",
      error: "Введіть рік або дату у форматі дд.мм.рррр, дд/мм/рррр чи рррр-мм-дд.",
    };
  }

  const year = isoMatch ? Number(match[1]) : Number(match[3]);
  const month = isoMatch ? Number(match[2]) : Number(match[2]);
  const day = isoMatch ? Number(match[3]) : Number(match[1]);

  if (!validCalendarDate(year, month, day)) {
    return { value: "", error: "Такої календарної дати не існує." };
  }

  return { value: toIsoDate(year, month, day) };
}

export function formatFlexibleDateForDisplay(input: string): string {
  return formatDateForDisplay(input);
}

const DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat("uk-UA", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const DISPLAY_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("uk-UA", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * Formats a date for the UI without losing genealogical precision.
 *
 * Full dates use dd.mm.yyyy, year-only and year-month values stay partial, and
 * unrecognised/approximate historical text is returned unchanged. Timestamps
 * are treated as instants and rendered in the user's local time zone.
 */
export function formatDateForDisplay(input?: string | Date | null): string {
  if (input === null || input === undefined || input === "") return "";
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? "" : DISPLAY_DATE_FORMATTER.format(input);
  }

  const value = input.trim();
  if (!value) return "";

  const normalized = normalizeFlexibleDateInput(value);
  if (!normalized.error && normalized.value) {
    if (/^\d{4}$/.test(normalized.value)) return normalized.value;
    const [year, month, day] = normalized.value.split("-");
    return `${day}.${month}.${year}`;
  }

  const yearMonth = value.match(/^(\d{4})-(\d{1,2})$/);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    if (year >= 1 && year <= 9999 && month >= 1 && month <= 12) {
      return `${String(month).padStart(2, "0")}.${yearMonth[1]}`;
    }
  }

  if (hasExplicitTime(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return DISPLAY_DATE_FORMATTER.format(date);
  }

  return value;
}

/** Formats an ISO timestamp as dd.mm.yyyy, HH:mm, preserving non-timestamp partial dates. */
export function formatDateTimeForDisplay(input?: string | Date | null): string {
  if (input === null || input === undefined || input === "") return "";
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? "" : DISPLAY_DATE_TIME_FORMATTER.format(input);
  }

  const value = input.trim();
  if (!value) return "";
  if (!hasExplicitTime(value)) return formatDateForDisplay(value);

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : DISPLAY_DATE_TIME_FORMATTER.format(date);
}

function hasExplicitTime(value: string): boolean {
  return /(?:T|\s)\d{1,2}:\d{2}/.test(value);
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "Ще не синхронізовано";
  return formatDateTimeForDisplay(value);
}

export function backupTimestamp(): string {
  const date = new Date();
  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}-${get("minute")}`;
}

export function compactBackupTimestamp(): string {
  return backupTimestamp().replace(" ", "-");
}

export function isSameLocalDay(first?: string | null, second = new Date()): boolean {
  if (!first) return false;
  const date = new Date(first);
  return (
    date.getFullYear() === second.getFullYear() &&
    date.getMonth() === second.getMonth() &&
    date.getDate() === second.getDate()
  );
}
