export interface TaskReminderFields {
  reminderAt: string;
  reminderInApp: boolean;
  reminderEmail: boolean;
  reminderSentAt: string;
}

export function normalizeTaskReminderTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export function normalizeTaskReminderFields(value: unknown): TaskReminderFields {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const reminderAt = normalizeTaskReminderTimestamp(record.reminderAt);
  const reminderInApp = Boolean(reminderAt && record.reminderInApp === true);
  const reminderEmail = Boolean(reminderAt && record.reminderEmail === true);
  const enabled = reminderInApp || reminderEmail;
  return {
    reminderAt: enabled ? reminderAt : "",
    reminderInApp,
    reminderEmail,
    reminderSentAt: enabled
      ? normalizeTaskReminderTimestamp(record.reminderSentAt)
      : "",
  };
}

export function taskReminderDateTimeLocalValue(value: unknown): string {
  const normalized = normalizeTaskReminderTimestamp(value);
  if (!normalized) return "";
  const date = new Date(normalized);
  const pad = (part: number) => String(part).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

export function taskReminderValidationError(value: unknown): string {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const reminderAtValue = typeof record.reminderAt === "string"
    ? record.reminderAt.trim()
    : "";
  const hasChannel = record.reminderInApp === true || record.reminderEmail === true;

  if (reminderAtValue && !normalizeTaskReminderTimestamp(reminderAtValue)) {
    return "Вкажіть коректні дату і час нагадування.";
  }
  if (hasChannel && !reminderAtValue) {
    return "Вкажіть дату і час нагадування.";
  }
  if (reminderAtValue && !hasChannel) {
    return "Оберіть хоча б один спосіб нагадування.";
  }
  return "";
}
