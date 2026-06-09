import type { AppDatabase, ScanAttachment } from "../types";
import { getAccessToken } from "./googleAuth";
import { getSupabaseClient, isSupabaseConfigured } from "./supabaseAuth";
import { storageService } from "./storage/storageService";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";

const DB_NAME = "tracker-rodu-files";
const STORE_NAME = "scans";
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const PROJECT_BUCKET = "project-attachments";

interface LocalScan {
  id: string;
  blob: Blob;
}

let activeProjectId: string | null = null;

export function setProjectAttachmentTarget(projectId: string | null): void {
  activeProjectId = projectId;
}

export async function saveScan(file: File): Promise<ScanAttachment> {
  if (!isSupportedAttachment(file)) {
    throw new Error(`Формат файлу «${file.name}» не підтримується.`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`Файл «${file.name}» перевищує дозволені 2 ГБ.`);
  }

  const id = createId();
  const mimeType = file.type || "application/octet-stream";

  if (activeProjectId && isSupabaseConfigured) {
    const storagePath = await uploadProjectAttachment(activeProjectId, file, id);
    return {
      id,
      name: file.name,
      mimeType,
      size: file.size,
      createdAt: nowIso(),
      storage: "supabase",
      storagePath,
    };
  }

  const token = getAccessToken();
  if (token) {
    const driveFileId = await storageService.uploadAttachment(token, file, id);
    return {
      id,
      name: file.name,
      mimeType,
      size: file.size,
      createdAt: nowIso(),
      storage: "drive",
      driveFileId,
    };
  }

  await saveLocalBlob(id, file);
  return {
    id,
    name: file.name,
    mimeType,
    size: file.size,
    createdAt: nowIso(),
    storage: "local",
  };
}

export interface AttachmentMigrationResult {
  db: AppDatabase;
  migrated: ScanAttachment[];
  unavailable: string[];
}

export async function migrateLocalAttachmentsToDrive(
  db: AppDatabase,
): Promise<AttachmentMigrationResult> {
  const token = getAccessToken();
  if (!token) throw new Error("Підключіть Google Drive для перенесення вкладень.");
  const migrated: ScanAttachment[] = [];
  const unavailable: string[] = [];

  const migrateList = async (scans: ScanAttachment[] = []) =>
    mapScans(scans, async (scan) => {
      if (scan.storage === "drive") return scan;
      const blob = await readSourceBlob(scan, token);
      if (!blob) {
        unavailable.push(scan.name);
        return scan;
      }
      const file = new File([blob], scan.name, {
        type: scan.mimeType || blob.type || "application/octet-stream",
      });
      const driveFileId = await storageService.uploadAttachment(token, file, scan.id);
      migrated.push(scan);
      return {
        ...scan,
        mimeType: file.type || scan.mimeType,
        size: file.size,
        storage: "drive" as const,
        driveFileId,
        storagePath: undefined,
      };
    });

  return migrateAttachmentsInDatabase(db, migrateList, migrated, unavailable);
}

export async function migrateProjectAttachmentsToSupabase(
  projectId: string,
  db: AppDatabase,
): Promise<AttachmentMigrationResult> {
  if (!isSupabaseConfigured) {
    throw new Error("У локальних налаштуваннях не вказано адресу або ключ Supabase.");
  }

  const token = getAccessToken();
  const migrated: ScanAttachment[] = [];
  const unavailable: string[] = [];

  const migrateList = async (scans: ScanAttachment[] = []) =>
    mapScans(scans, async (scan) => {
      if (scan.storage === "supabase" && scan.storagePath) return scan;
      const blob = await readSourceBlob(scan, token);
      if (!blob) {
        unavailable.push(scan.name);
        return scan;
      }
      const file = new File([blob], scan.name, {
        type: scan.mimeType || blob.type || "application/octet-stream",
      });
      const storagePath = await uploadProjectAttachment(projectId, file, scan.id);
      migrated.push(scan);
      return {
        ...scan,
        mimeType: file.type || scan.mimeType,
        size: file.size,
        storage: "supabase" as const,
        driveFileId: undefined,
        storagePath,
      };
    });

  return migrateAttachmentsInDatabase(db, migrateList, migrated, unavailable);
}

export async function deleteMigratedLocalFiles(scans: ScanAttachment[]): Promise<void> {
  const localScans = scans.filter((scan) => scan.storage === "local");
  await Promise.allSettled(localScans.map((scan) => deleteLocalBlob(scan.id)));
}

function isSupportedAttachment(file: File): boolean {
  const supportedTypes = new Set([
    "application/pdf",
    "image/vnd.djvu",
    "application/vnd.ms-xpsdocument",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/rtf",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/csv",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.presentation",
    "text/plain",
    "text/markdown",
    "application/xml",
    "text/xml",
    "text/html",
    "application/epub+zip",
  ]);
  const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  return (
    file.type.startsWith("image/") ||
    file.type.startsWith("audio/") ||
    supportedTypes.has(file.type) ||
    [
      "pdf",
      "djvu",
      "djv",
      "xps",
      "doc",
      "docx",
      "rtf",
      "odt",
      "xls",
      "xlsx",
      "ods",
      "csv",
      "ppt",
      "pptx",
      "odp",
      "txt",
      "md",
      "xml",
      "html",
      "htm",
      "epub",
      "mp3",
      "wav",
      "m4a",
      "aac",
      "ogg",
      "opus",
      "flac",
      "wma",
      "webm",
    ].includes(extension)
  );
}

export async function getScanBlob(scan: ScanAttachment): Promise<Blob> {
  if (scan.storage === "supabase") {
    if (!scan.storagePath) {
      throw new Error("У файлу відсутній шлях у сховищі проєкту.");
    }
    const { data, error } = await getSupabaseClient()
      .storage
      .from(PROJECT_BUCKET)
      .download(scan.storagePath);
    if (error || !data) {
      throw error ?? new Error("Не вдалося завантажити файл зі сховища проєкту.");
    }
    return data;
  }

  if (scan.storage === "drive") {
    const token = getAccessToken();
    if (!token) {
      throw new Error("Підключіть Google Drive, щоб відкрити цей файл.");
    }
    if (!scan.driveFileId) {
      throw new Error("У файлу відсутній ідентифікатор Google Drive.");
    }
    return storageService.downloadAttachment(token, scan.driveFileId);
  }

  const local = await readLocalBlob(scan.id);
  if (!local) throw new Error("Локальне вкладення не знайдено в цьому браузері.");
  return local;
}

export async function openScan(scan: ScanAttachment): Promise<void> {
  const opened = window.open("about:blank", "_blank");
  if (!opened) {
    throw new Error("Браузер заблокував відкриття файлу. Дозвольте спливні вікна.");
  }
  try {
    const blob = await getScanBlob(scan);
    const url = URL.createObjectURL(blob);
    opened.location.href = url;
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    opened.close();
    throw error;
  }
}

export async function downloadScan(scan: ScanAttachment): Promise<void> {
  const blob = await getScanBlob(scan);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = scan.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function deleteScanFile(scan: ScanAttachment): Promise<void> {
  if (scan.storage === "supabase") {
    if (!scan.storagePath) return;
    const { error } = await getSupabaseClient()
      .storage
      .from(PROJECT_BUCKET)
      .remove([scan.storagePath]);
    if (error) throw error;
    return;
  }

  if (scan.storage === "drive") {
    const token = getAccessToken();
    if (!token) throw new Error("Підключіть Google Drive, щоб видалити цей файл.");
    if (!scan.driveFileId) return;
    await storageService.deleteAttachment(token, scan.driveFileId);
    return;
  }

  await deleteLocalBlob(scan.id);
}

async function uploadProjectAttachment(
  projectId: string,
  file: Blob,
  attachmentId: string,
): Promise<string> {
  const fileName = file instanceof File ? file.name : `scan-${attachmentId}`;
  const path = `${projectId}/${attachmentId}/${safeFileName(fileName)}`;
  const { error } = await getSupabaseClient()
    .storage
    .from(PROJECT_BUCKET)
    .upload(path, file, {
      upsert: true,
      contentType: file.type || "application/octet-stream",
    });
  if (error) {
    throw new Error(`Не вдалося завантажити файл «${fileName}» у сховище проєкту.`);
  }
  return path;
}

async function readSourceBlob(
  scan: ScanAttachment,
  token: string | null,
): Promise<Blob | null> {
  if (scan.storage === "supabase") {
    if (!scan.storagePath) return null;
    try {
      return await getScanBlob(scan);
    } catch {
      return null;
    }
  }

  if (scan.storage === "drive") {
    if (!token || !scan.driveFileId) return null;
    try {
      return await storageService.downloadAttachment(token, scan.driveFileId);
    } catch {
      return null;
    }
  }

  return readLocalBlob(scan.id);
}

async function migrateAttachmentsInDatabase(
  db: AppDatabase,
  migrateList: (scans?: ScanAttachment[]) => Promise<ScanAttachment[]>,
  migrated: ScanAttachment[],
  unavailable: string[],
): Promise<AttachmentMigrationResult> {
  const customAttachmentFieldIds = db.settings.customFields
    .filter((field) => field.type === "attachments")
    .reduce<Record<string, string[]>>((groups, field) => {
      (groups[field.module] ??= []).push(field.id);
      return groups;
    }, {});

  const migrateCustomFields = async <T extends { customFields?: Record<string, unknown> }>(
    module: string,
    item: T,
  ): Promise<T> => {
    const source = item.customFields ?? {};
    const values = { ...source };
    let changed = false;
    for (const fieldId of customAttachmentFieldIds[module] ?? []) {
      const current = values[fieldId];
      const next = await migrateList(
        Array.isArray(current) ? current as ScanAttachment[] : [],
      );
      if (next !== current) {
        values[fieldId] = next;
        changed = true;
      }
    }
    return changed ? { ...item, customFields: values } : item;
  };

  const documents = await mapItems(db.documents, async (item) => {
    const customFields = await migrateCustomFields("documents", item);
    const scans = await migrateList(item.scans);
    return customFields !== item || scans !== item.scans
      ? { ...customFields, scans }
      : item;
  });

  const findings = await mapItems(db.findings, async (item) => {
    const customFields = await migrateCustomFields("findings", item);
    const scans = await migrateList(item.scans);
    return customFields !== item || scans !== item.scans
      ? { ...customFields, scans }
      : item;
  });

  const persons = await mapItems(db.persons, async (item) => {
    const customFields = await migrateCustomFields("persons", item);
    const birthScans = await migrateList(item.birthScans);
    const marriageScans = await migrateList(item.marriageScans);
    const deathScans = await migrateList(item.deathScans);
    const mentionScans = await migrateList(item.mentionScans);
    return customFields !== item ||
      birthScans !== item.birthScans ||
      marriageScans !== item.marriageScans ||
      deathScans !== item.deathScans ||
      mentionScans !== item.mentionScans
      ? {
          ...customFields,
          birthScans,
          marriageScans,
          deathScans,
          mentionScans,
        }
      : item;
  });

  const archiveRequests = await mapItems(db.archiveRequests, async (item) => {
    const customFields = await migrateCustomFields("archiveRequests", item);
    const requestScans = await migrateList(item.requestScans);
    const responseScans = await migrateList(item.responseScans);
    return customFields !== item ||
      requestScans !== item.requestScans ||
      responseScans !== item.responseScans
      ? { ...customFields, requestScans, responseScans }
      : item;
  });

  const researches = await mapItems(db.researches, (item) =>
    migrateCustomFields("researches", item),
  );
  const yearMatrix = await mapItems(db.yearMatrix, (item) =>
    migrateCustomFields("yearMatrix", item),
  );
  const tasks = await mapItems(db.tasks, (item) =>
    migrateCustomFields("tasks", item),
  );
  const hypotheses = await mapItems(db.hypotheses, (item) =>
    migrateCustomFields("hypotheses", item),
  );

  const attachmentFields = new Map(
    db.customSections.map((section) => [
      section.id,
      section.fields.filter((field) => field.type === "attachments").map((field) => field.id),
    ]),
  );

  const customSectionRecords = await mapItems(db.customSectionRecords, async (item) => {
    const values = { ...item.values };
    let changed = false;
    for (const fieldId of attachmentFields.get(item.sectionId) ?? []) {
      const current = values[fieldId];
      const next = await migrateList(
        Array.isArray(current) ? current as ScanAttachment[] : [],
      );
      if (next !== current) {
        values[fieldId] = next;
        changed = true;
      }
    }
    return changed ? { ...item, values } : item;
  });

  const changed =
    researches !== db.researches ||
    documents !== db.documents ||
    yearMatrix !== db.yearMatrix ||
    tasks !== db.tasks ||
    findings !== db.findings ||
    hypotheses !== db.hypotheses ||
    persons !== db.persons ||
    archiveRequests !== db.archiveRequests ||
    customSectionRecords !== db.customSectionRecords;

  return {
    db: changed
      ? {
          ...db,
          researches,
          documents,
          yearMatrix,
          tasks,
          findings,
          hypotheses,
          persons,
          archiveRequests,
          customSectionRecords,
          updatedAt: migrated.length ? nowIso() : db.updatedAt,
        }
      : db,
    migrated,
    unavailable: [...new Set(unavailable)],
  };
}

async function mapScans(
  scans: ScanAttachment[],
  mapper: (scan: ScanAttachment) => Promise<ScanAttachment>,
): Promise<ScanAttachment[]> {
  return mapItems(scans, mapper);
}

async function mapItems<T>(
  items: T[],
  mapper: (item: T) => Promise<T>,
): Promise<T[]> {
  let changed = false;
  const next = await Promise.all(items.map(async (item) => {
    const mapped = await mapper(item);
    if (mapped !== item) changed = true;
    return mapped;
  }));
  return changed ? next : items;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не вдалося відкрити локальне сховище сканів."));
  });
}

async function saveLocalBlob(id: string, blob: Blob): Promise<void> {
  const db = await openDatabase();
  await transactionResult(db, "readwrite", (store) => store.put({ id, blob } satisfies LocalScan));
}

async function readLocalBlob(id: string): Promise<Blob | null> {
  const db = await openDatabase();
  const result = await transactionResult<LocalScan | undefined>(
    db,
    "readonly",
    (store) => store.get(id),
  );
  return result?.blob ?? null;
}

async function deleteLocalBlob(id: string): Promise<void> {
  const db = await openDatabase();
  await transactionResult(db, "readwrite", (store) => store.delete(id));
}

function transactionResult<T = unknown>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Помилка локального сховища сканів."));
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("Помилка локального сховища сканів."));
    };
  });
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_");
}
