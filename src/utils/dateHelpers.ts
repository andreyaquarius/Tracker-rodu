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

  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const localMatch = value.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  const dashedLocalMatch = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  const match = isoMatch ?? localMatch ?? dashedLocalMatch;

  if (!match) {
    return {
      value: "",
      error: "Введіть дату у форматі дд.мм.рррр, дд/мм/рррр або рррр-мм-дд.",
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
  const normalized = normalizeFlexibleDateInput(input);
  if (normalized.error || !normalized.value) return input;
  const [year, month, day] = normalized.value.split("-");
  return `${day}.${month}.${year}`;
}

export function formatDateTime(value?: string | null): string {
  if (!value) return "Ще не синхронізовано";
  return new Intl.DateTimeFormat("uk-UA", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
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
