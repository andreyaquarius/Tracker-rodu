import type { AppDatabase } from "../types";
import { normalizeDatabase } from "./database";

export const PROJECT_EXCEL_BACKUP_SHEET_NAME = "Дані для відновлення";
export const PROJECT_EXCEL_BACKUP_MAGIC = "tracker-rodu-project-backup";
export const PROJECT_EXCEL_BACKUP_VERSION = "1";

const BACKUP_CHUNK_SIZE = 25000;
const BACKUP_CHUNK_PREFIX = "b64:";

export interface ProjectExcelBackupRecord {
  key: string;
  value: string;
}

export function projectBackupRecords(db: AppDatabase): ProjectExcelBackupRecord[] {
  const encoded = utf8ToBase64(JSON.stringify(db));
  const chunks = chunkString(encoded, BACKUP_CHUNK_SIZE);

  return [
    { key: "format", value: PROJECT_EXCEL_BACKUP_MAGIC },
    { key: "version", value: PROJECT_EXCEL_BACKUP_VERSION },
    { key: "encoding", value: "base64-json-utf8" },
    { key: "chunkCount", value: String(chunks.length) },
    { key: "createdAt", value: new Date().toISOString() },
    ...chunks.map((chunk, index) => ({
      key: backupChunkKey(index),
      value: `${BACKUP_CHUNK_PREFIX}${chunk}`,
    })),
  ];
}

export function hasProjectBackupMarker(rows: string[][]): boolean {
  return rows.some((row) =>
    (row[0] ?? "").trim() === "format"
    && (row[1] ?? "").trim() === PROJECT_EXCEL_BACKUP_MAGIC
  );
}

export function readDatabaseFromProjectBackupRows(rows: string[][]): AppDatabase {
  const entries = new Map<string, string>();
  for (const row of rows) {
    const key = (row[0] ?? "").trim();
    if (!key || key === "Ключ") continue;
    entries.set(key, row[1] ?? "");
  }

  if (entries.get("format") !== PROJECT_EXCEL_BACKUP_MAGIC) {
    throw new Error("Excel-файл не містить службових даних резервної копії.");
  }
  if (entries.get("version") !== PROJECT_EXCEL_BACKUP_VERSION) {
    throw new Error("Ця версія Excel-копії не підтримується.");
  }
  if (entries.get("encoding") !== "base64-json-utf8") {
    throw new Error("Excel-копія має невідомий формат кодування.");
  }

  const chunkCount = Number(entries.get("chunkCount"));
  if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
    throw new Error("Excel-копія пошкоджена: не знайдено кількість частин.");
  }

  const chunks: string[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const value = entries.get(backupChunkKey(index));
    if (!value?.startsWith(BACKUP_CHUNK_PREFIX)) {
      throw new Error("Excel-копія пошкоджена: бракує частини даних.");
    }
    chunks.push(value.slice(BACKUP_CHUNK_PREFIX.length));
  }

  try {
    return normalizeDatabase(JSON.parse(base64ToUtf8(chunks.join(""))) as unknown);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("Не вдалося прочитати дані з Excel-копії.");
  }
}

function backupChunkKey(index: number): string {
  return `chunk:${String(index + 1).padStart(5, "0")}`;
}

function chunkString(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks.length ? chunks : [""];
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToUtf8(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}
