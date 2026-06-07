import type { ScanAttachment } from "../types";
import { getAccessToken } from "./googleAuth";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";

const DB_NAME = "tracker-rodu-files";
const STORE_NAME = "scans";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

interface LocalScan {
  id: string;
  blob: Blob;
}

export async function saveScan(file: File): Promise<ScanAttachment> {
  if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
    throw new Error(`Файл «${file.name}» не є зображенням або PDF.`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`Файл «${file.name}» перевищує дозволені 2 ГБ.`);
  }

  const id = createId();
  const token = getAccessToken();
  if (token) {
    const driveFileId = await uploadToDrive(token, file, id);
    return {
      id,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
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
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    createdAt: nowIso(),
    storage: "local",
  };
}

export async function getScanBlob(scan: ScanAttachment): Promise<Blob> {
  if (scan.storage === "drive") {
    const token = getAccessToken();
    if (!token) {
      throw new Error("Підключіть Google Drive, щоб відкрити цей скан.");
    }
    if (!scan.driveFileId) throw new Error("У скану відсутній ідентифікатор Google Drive.");
    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(scan.driveFileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw new Error("Не вдалося завантажити скан із Google Drive.");
    return response.blob();
  }

  const local = await readLocalBlob(scan.id);
  if (!local) throw new Error("Локальний файл скану не знайдено в цьому браузері.");
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
  if (scan.storage === "drive") {
    const token = getAccessToken();
    if (!token) throw new Error("Підключіть Google Drive, щоб видалити цей скан.");
    if (!scan.driveFileId) return;
    const response = await fetch(`${DRIVE_API}/files/${encodeURIComponent(scan.driveFileId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok && response.status !== 404) {
      throw new Error("Не вдалося видалити скан із Google Drive.");
    }
    return;
  }
  await deleteLocalBlob(scan.id);
}

async function uploadToDrive(token: string, file: File, id: string): Promise<string> {
  const metadata = {
    name: `scan-${id}-${safeFileName(file.name)}`,
    parents: ["appDataFolder"],
    mimeType: file.type || "application/octet-stream",
    appProperties: { trackerRoduType: "scan", attachmentId: id },
  };
  const sessionResponse = await fetch(
    `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.type || "application/octet-stream",
        "X-Upload-Content-Length": String(file.size),
      },
      body: JSON.stringify(metadata),
    },
  );
  if (!sessionResponse.ok) {
    throw new Error(`Не вдалося розпочати завантаження «${file.name}» у Google Drive.`);
  }
  const sessionUrl = sessionResponse.headers.get("Location");
  if (!sessionUrl) throw new Error("Google Drive не повернув адресу сесії завантаження.");

  let offset = 0;
  while (offset < file.size) {
    const endExclusive = Math.min(offset + UPLOAD_CHUNK_SIZE, file.size);
    const response = await uploadChunk(
      sessionUrl,
      file.slice(offset, endExclusive),
      offset,
      endExclusive,
      file.size,
      file.type || "application/octet-stream",
    );
    if (response.status === 200 || response.status === 201) {
      const result = await response.json() as { id: string };
      return result.id;
    }
    if (response.status !== 308) {
      throw new Error(`Завантаження «${file.name}» перервано Google Drive.`);
    }
    offset = uploadedBytes(response.headers.get("Range")) ?? endExclusive;
  }
  throw new Error(`Google Drive не підтвердив завершення завантаження «${file.name}».`);
}

async function uploadChunk(
  sessionUrl: string,
  chunk: Blob,
  start: number,
  endExclusive: number,
  total: number,
  mimeType: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(sessionUrl, {
        method: "PUT",
        headers: {
          "Content-Type": mimeType,
          "Content-Range": `bytes ${start}-${endExclusive - 1}/${total}`,
        },
        body: chunk,
      });
      if (response.status < 500) return response;
      lastError = new Error(`Google Drive тимчасово недоступний: ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await wait(750 * (attempt + 1));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Не вдалося передати частину файлу в Google Drive.");
}

function uploadedBytes(range: string | null): number | null {
  if (!range) return null;
  const match = range.match(/bytes=0-(\d+)/);
  return match ? Number(match[1]) + 1 : null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_");
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
