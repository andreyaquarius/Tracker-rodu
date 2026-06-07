import type { AppDatabase, BackupType, DriveBackupFile } from "../types";
import { backupTimestamp, compactBackupTimestamp } from "../utils/dateHelpers";
import { normalizeDatabase } from "../utils/database";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const DATABASE_FILE_NAME = "tracker-rodu-db.json";
const LEGACY_DATABASE_FILE_NAME = "rodovyi-navigator-db.json";

interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
}

function multipartBody(metadata: object, content: string): { body: string; contentType: string } {
  const boundary = `tracker_rodu_${crypto.randomUUID?.() ?? Date.now()}`;
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify(metadata),
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { body, contentType: `multipart/related; boundary=${boundary}` };
}

async function driveFetch<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Google Drive: ${response.status} ${detail || response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function findDatabaseFileInAppDataFolder(token: string): Promise<DriveFile | null> {
  const query = encodeURIComponent(
    `(name = '${DATABASE_FILE_NAME}' or name = '${LEGACY_DATABASE_FILE_NAME}') and trashed = false`,
  );
  const url = `${API}/files?spaces=appDataFolder&q=${query}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc`;
  const result = await driveFetch<{ files: DriveFile[] }>(token, url);
  const current = result.files.find((file) => file.name === DATABASE_FILE_NAME);
  if (current) return current;
  const legacy = result.files.find((file) => file.name === LEGACY_DATABASE_FILE_NAME);
  if (!legacy) return null;
  return driveFetch<DriveFile>(
    token,
    `${API}/files/${encodeURIComponent(legacy.id)}?fields=id,name,modifiedTime`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: DATABASE_FILE_NAME }),
    },
  );
}

export async function createDatabaseFileInAppDataFolder(
  token: string,
  db: AppDatabase,
): Promise<DriveFile> {
  const metadata = { name: DATABASE_FILE_NAME, parents: ["appDataFolder"], mimeType: "application/json" };
  const upload = multipartBody(metadata, JSON.stringify(db, null, 2));
  return driveFetch<DriveFile>(token, `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,modifiedTime`, {
    method: "POST",
    headers: { "Content-Type": upload.contentType },
    body: upload.body,
  });
}

export async function downloadDatabaseFile(token: string, fileId: string): Promise<AppDatabase> {
  const response = await fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Не вдалося завантажити базу з Google Drive.");
  return normalizeDatabase(await response.json());
}

export async function updateDatabaseFile(
  token: string,
  fileId: string,
  db: AppDatabase,
): Promise<DriveFile> {
  return driveFetch<DriveFile>(
    token,
    `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name,modifiedTime`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(db, null, 2),
    },
  );
}

export async function ensureDatabaseFileName(token: string, fileId: string): Promise<void> {
  await driveFetch<DriveFile>(
    token,
    `${API}/files/${encodeURIComponent(fileId)}?fields=id,name`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: DATABASE_FILE_NAME }),
    },
  );
}

export async function createVisibleBackup(token: string, db: AppDatabase): Promise<DriveFile> {
  const metadata = {
    name: `Трекер Роду backup ${backupTimestamp()}.json`,
    mimeType: "application/json",
  };
  const upload = multipartBody(metadata, JSON.stringify(db, null, 2));
  return driveFetch<DriveFile>(token, `${UPLOAD_API}/files?uploadType=multipart&fields=id,name`, {
    method: "POST",
    headers: { "Content-Type": upload.contentType },
    body: upload.body,
  });
}

export async function createAppDataBackup(
  token: string,
  db: AppDatabase,
  type: BackupType,
): Promise<DriveBackupFile> {
  const metadata = {
    name: backupFileName(type),
    parents: ["appDataFolder"],
    mimeType: "application/json",
  };
  const upload = multipartBody(metadata, JSON.stringify(db, null, 2));
  const file = await driveFetch<DriveFile>(
    token,
    `${UPLOAD_API}/files?uploadType=multipart&fields=id,name,createdTime,modifiedTime,size`,
    {
      method: "POST",
      headers: { "Content-Type": upload.contentType },
      body: upload.body,
    },
  );
  const backup = toBackupFile(file);
  if (type === "automatic") await pruneAutomaticBackups(token, 7);
  return backup;
}

export async function listAppDataBackups(token: string): Promise<DriveBackupFile[]> {
  const query = encodeURIComponent(
    `name contains 'tracker-rodu-' and name contains '-backup-' and trashed = false`,
  );
  const url =
    `${API}/files?spaces=appDataFolder&q=${query}` +
    "&fields=files(id,name,createdTime,modifiedTime,size)&orderBy=createdTime desc&pageSize=100";
  const result = await driveFetch<{ files: DriveFile[] }>(token, url);
  return result.files
    .filter((file) => backupTypeFromName(file.name) !== null)
    .map(toBackupFile);
}

export async function downloadBackupDatabase(
  token: string,
  fileId: string,
): Promise<AppDatabase> {
  return downloadDatabaseFile(token, fileId);
}

export async function deleteAppDataBackup(token: string, fileId: string): Promise<void> {
  await driveFetch<void>(token, `${API}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
  });
}

async function pruneAutomaticBackups(token: string, keep: number): Promise<void> {
  const automatic = (await listAppDataBackups(token))
    .filter((file) => file.type === "automatic")
    .sort((a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
  await Promise.all(
    automatic.slice(keep).map((file) => deleteAppDataBackup(token, file.id)),
  );
}

function backupFileName(type: BackupType): string {
  const typeName = type === "automatic" ? "auto" : type;
  return `tracker-rodu-${typeName}-backup-${compactBackupTimestamp()}.json`;
}

function backupTypeFromName(name: string): BackupType | null {
  if (
    name.startsWith("tracker-rodu-auto-backup-") ||
    name.startsWith("tracker-rodu-automatic-backup-")
  ) {
    return "automatic";
  }
  if (name.startsWith("tracker-rodu-manual-backup-")) return "manual";
  if (name.startsWith("tracker-rodu-pre-import-backup-")) return "pre-import";
  if (name.startsWith("tracker-rodu-pre-clear-backup-")) return "pre-clear";
  return null;
}

function toBackupFile(file: DriveFile): DriveBackupFile {
  const type = backupTypeFromName(file.name);
  if (!type) throw new Error("Невідомий тип резервної копії.");
  return {
    id: file.id,
    name: file.name,
    createdTime: file.createdTime ?? file.modifiedTime ?? new Date().toISOString(),
    modifiedTime: file.modifiedTime ?? file.createdTime ?? new Date().toISOString(),
    size: Number(file.size ?? 0),
    type,
  };
}
