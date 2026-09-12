export const GOOGLE_DRIVE_SHORTCUT_MIME_TYPE = "application/vnd.google-apps.shortcut";
const DRIVE_FILES_API = "https://www.googleapis.com/drive/v3/files";

export type DriveReferenceFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  resourceKey?: string;
  trashed?: boolean;
  parents?: string[];
  shortcutDetails?: { targetId?: string; targetMimeType?: string; targetResourceKey?: string };
};

/** Resolve Picker-selected shortcuts to the original, including its own resource key. */
export async function resolveGoogleDriveShortcut(
  readFile: (id: string, resourceKey?: string) => Promise<DriveReferenceFile>,
  fileId: string,
  resourceKey?: string,
): Promise<{ file: DriveReferenceFile; resourceKey?: string }> {
  const visited = new Set<string>();
  let id = fileId;
  let key = resourceKey;
  for (let depth = 0; depth < 5; depth += 1) {
    if (visited.has(id)) break;
    visited.add(id);
    const file = await readFile(id, key);
    if (!file.id || file.trashed) {
      throw new Error("Файл Google Drive не знайдено або він у кошику.");
    }
    if (file.mimeType !== GOOGLE_DRIVE_SHORTCUT_MIME_TYPE) {
      if (!file.name) throw new Error("Google Drive не повернув назву файлу.");
      return { file, resourceKey: file.resourceKey || key };
    }
    if (!file.shortcutDetails?.targetId) break;
    id = file.shortcutDetails.targetId;
    // The shortcut's key does not grant access to its target.
    key = file.shortcutDetails.targetResourceKey;
  }
  throw new Error("Ярлик Google Drive не містить доступного оригіналу. Оберіть сам файл.");
}

type ShortcutRequest = (url: string, init?: RequestInit, maxAttempts?: number) => Promise<Response>;
export type DriveShortcutResult = { folderId: string; shortcutId?: string };
export type DriveShortcutOptions = {
  projectId: string;
  folderId: string;
  file: { id: string; name: string; resourceKey?: string; parents?: string[] };
};

/** In-flight deduplication; completed operations re-check Drive, not a stale local cache. */
export function createGoogleDriveShortcutStore(
  request: ShortcutRequest,
  withLock: (key: string, action: () => Promise<DriveShortcutResult>) => Promise<DriveShortcutResult> = (_, action) => action(),
) {
  const pending = new Map<string, Promise<DriveShortcutResult>>();
  const escapeQuery = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  async function findShortcut(options: DriveShortcutOptions): Promise<string | undefined> {
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q: `'${escapeQuery(options.folderId)}' in parents and trashed=false and mimeType='${GOOGLE_DRIVE_SHORTCUT_MIME_TYPE}'`,
        spaces: "drive",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        fields: "nextPageToken,files(id,trashed,shortcutDetails(targetId))",
        pageSize: "1000",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await request(`${DRIVE_FILES_API}?${params}`);
      const result = await response.json() as { files?: DriveReferenceFile[]; nextPageToken?: string };
      const existing = result.files?.find((file) => (
        file.id && !file.trashed && file.shortcutDetails?.targetId === options.file.id
      ));
      if (existing) return existing.id;
      pageToken = result.nextPageToken || "";
    } while (pageToken);
    return undefined;
  }

  async function findOrCreate(options: DriveShortcutOptions): Promise<DriveShortcutResult> {
    const { file, folderId, projectId } = options;
    const existing = await findShortcut(options);
    if (existing) return { folderId, shortcutId: existing };
    const headers = new Headers({ "Content-Type": "application/json" });
    if (file.resourceKey && /^[a-zA-Z0-9_-]+$/.test(file.id) && /^[a-zA-Z0-9_-]+$/.test(file.resourceKey)) {
      headers.set("X-Goog-Drive-Resource-Keys", `${file.id}/${file.resourceKey}`);
    }
    try {
      // Metadata only. Never upload bytes, copy/move the target, or alter its permissions.
      // Do not replay POST after an ambiguous failure: shortcuts cannot use generated IDs.
      const response = await request(`${DRIVE_FILES_API}?supportsAllDrives=true&fields=id`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: file.name,
          mimeType: GOOGLE_DRIVE_SHORTCUT_MIME_TYPE,
          parents: [folderId],
          shortcutDetails: { targetId: file.id },
          appProperties: { trackerRoduProjectId: projectId, trackerRoduType: "file-shortcut" },
        }),
      }, 1);
      const created = await response.json() as { id?: string };
      if (!created.id) throw new Error("Google Drive не повернув ідентифікатор ярлика.");
      return { folderId, shortcutId: created.id };
    } catch (error) {
      // The server may have committed the shortcut before the response was lost.
      const recovered = await findShortcut(options).catch(() => undefined);
      if (recovered) return { folderId, shortcutId: recovered };
      throw error;
    }
  }

  return {
    ensure(options: DriveShortcutOptions): Promise<DriveShortcutResult> {
      if (options.file.parents?.includes(options.folderId)) return Promise.resolve({ folderId: options.folderId });
      const key = JSON.stringify([options.folderId, options.file.id]);
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = withLock(key, () => findOrCreate(options));
      pending.set(key, operation);
      void operation.finally(() => {
        if (pending.get(key) === operation) pending.delete(key);
      }).catch(() => undefined);
      return operation;
    },
  };
}
