function databaseErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const record = error as Record<string, unknown>;
  return [record.code, record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

export function isDatabaseStatementTimeout(error: unknown): boolean {
  const text = databaseErrorText(error).toLocaleLowerCase();
  return text.includes("57014") ||
    text.includes("statement timeout") ||
    text.includes("timeout manager");
}

export function databaseStatementTimeoutMessage(error: unknown): string | null {
  if (!isDatabaseStatementTimeout(error)) return null;
  return "Сервер не встиг завершити запит. Спробуйте ще раз; якщо помилка повториться, оновіть сторінку.";
}
