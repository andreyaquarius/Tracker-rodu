import type { AppDatabase } from "../types";
import { backupTimestamp } from "./dateHelpers";
import { normalizeDatabase } from "./database";

export function downloadDatabase(
  db: AppDatabase,
  fileName = `Трекер Роду backup ${backupTimestamp()}.json`,
): void {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readDatabaseBackup(file: File): Promise<AppDatabase> {
  if (!file.name.toLocaleLowerCase("uk").endsWith(".json")) {
    throw new Error("Виберіть резервну копію у форматі JSON.");
  }
  if (file.size > 100 * 1024 * 1024) {
    throw new Error("Розмір файла резервної копії не може перевищувати 100 МБ.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error("Не вдалося прочитати JSON. Перевірте, чи файл не пошкоджений.");
  }
  return normalizeDatabase(parsed);
}
