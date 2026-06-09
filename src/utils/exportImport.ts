import type { AppDatabase } from "../types";
import { backupTimestamp } from "./dateHelpers";

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
