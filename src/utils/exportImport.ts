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

export async function readDatabaseFile(file: File): Promise<AppDatabase> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Файл не є валідним JSON.");
  }
  validateImportDatabase(parsed);
  return normalizeDatabase(parsed);
}

export interface ImportPreview {
  updatedAt: string;
  researches: number;
  documents: number;
  yearMatrix: number;
  tasks: number;
  findings: number;
  hypotheses: number;
  archiveRequests: number;
  customSections: number;
  customSectionRecords: number;
}

export function createImportPreview(db: AppDatabase): ImportPreview {
  return {
    updatedAt: db.updatedAt,
    researches: db.researches.length,
    documents: db.documents.length,
    yearMatrix: db.yearMatrix.length,
    tasks: db.tasks.length,
    findings: db.findings.length,
    hypotheses: db.hypotheses.length,
    archiveRequests: db.archiveRequests.length,
    customSections: db.customSections.length,
    customSectionRecords: db.customSectionRecords.length,
  };
}

function validateImportDatabase(value: unknown): asserts value is Partial<AppDatabase> {
  if (!value || typeof value !== "object") {
    throw new Error("JSON не містить об’єкта бази даних.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.appName !== "Трекер Роду") {
    throw new Error("appName має дорівнювати «Трекер Роду».");
  }
  if (typeof candidate.version !== "number") {
    throw new Error("У JSON відсутнє поле version.");
  }
  if (typeof candidate.updatedAt !== "string" || !candidate.updatedAt) {
    throw new Error("У JSON відсутнє поле updatedAt.");
  }
  const arrays = ["researches", "documents", "yearMatrix", "tasks", "findings", "hypotheses"];
  for (const key of arrays) {
    if (!Array.isArray(candidate[key])) {
      throw new Error(`Поле ${key} має бути масивом.`);
    }
  }
}
