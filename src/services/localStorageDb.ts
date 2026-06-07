import type { AppDatabase } from "../types";
import { createEmptyDatabase, normalizeDatabase } from "../utils/database";

export const LOCAL_DB_KEY = "tracker-rodu-local-db";
const LEGACY_LOCAL_DB_KEY = "rodovyi-navigator-local-db";

export function saveLocalCopy(db: AppDatabase): void {
  localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
}

export function loadLocalCopy(): AppDatabase {
  const raw =
    localStorage.getItem(LOCAL_DB_KEY) ??
    localStorage.getItem(LEGACY_LOCAL_DB_KEY);
  if (!raw) return createEmptyDatabase();
  try {
    const db = normalizeDatabase(JSON.parse(raw));
    saveLocalCopy(db);
    localStorage.removeItem(LEGACY_LOCAL_DB_KEY);
    return db;
  } catch {
    return createEmptyDatabase();
  }
}
