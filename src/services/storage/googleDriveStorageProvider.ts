import {
  createAppDataBackup,
  createDatabaseFileInAppDataFolder,
  createVisibleBackup,
  deleteAppDataBackup,
  downloadBackupDatabase,
  downloadDatabaseFile,
  ensureDatabaseFileName,
  findDatabaseFileInAppDataFolder,
  listAppDataBackups,
  updateDatabaseFile,
} from "../googleDrive";
import type { StorageProvider } from "./storageProvider";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export const googleDriveStorageProvider: StorageProvider = {
  findDatabase: findDatabaseFileInAppDataFolder,
  createDatabase: createDatabaseFileInAppDataFolder,
  downloadDatabase: downloadDatabaseFile,
  updateDatabase: updateDatabaseFile,
  ensureDatabaseName: ensureDatabaseFileName,
  createVisibleBackup,
  createBackup: createAppDataBackup,
  listBackups: listAppDataBackups,
  downloadBackup: downloadBackupDatabase,
  deleteBackup: deleteAppDataBackup,

  async uploadAttachment(token, file, attachmentId) {
    const metadata = {
      name: `scan-${attachmentId}-${safeFileName(file.name)}`,
      parents: ["appDataFolder"],
      mimeType: file.type || "application/octet-stream",
      appProperties: { trackerRoduType: "scan", attachmentId },
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
    if (!sessionUrl) {
      throw new Error("Google Drive не повернув адресу сесії завантаження.");
    }

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
    throw new Error(
      `Google Drive не підтвердив завершення завантаження «${file.name}».`,
    );
  },

  async downloadAttachment(token, fileId) {
    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error("Не вдалося завантажити вкладення з Google Drive.");
    }
    return response.blob();
  },

  async deleteAttachment(token, fileId) {
    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error("Не вдалося видалити вкладення з Google Drive.");
    }
  },
};

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
