export function nowIso(): string {
  return new Date().toISOString();
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
