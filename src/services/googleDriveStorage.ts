const GOOGLE_DRIVE_SCOPE = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

type StoredToken = {
  accessToken: string;
  expiresAt: number;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleDrivePrompt = "" | "consent" | "select_account";

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: GoogleDrivePrompt }) => void;
};

type GoogleAccounts = {
  oauth2: {
    initTokenClient: (options: {
      client_id: string;
      scope: string;
      callback: (response: GoogleTokenResponse) => void;
      error_callback?: (error: { type?: string }) => void;
    }) => GoogleTokenClient;
    revoke?: (accessToken: string, callback?: () => void) => void;
  };
};

type GoogleWindow = Window & {
  google?: {
    accounts: GoogleAccounts;
  };
};

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  webViewLink?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  headRevisionId?: string;
  trashed?: boolean;
};

let googleScriptPromise: Promise<void> | null = null;
let tokenRequestPromise: Promise<string> | null = null;
let activeToken: StoredToken | null = null;
const folderPromises = new Map<string, Promise<string>>();
const deduplicatedUploadPromises = new Map<string, Promise<GoogleDriveUploadedFile>>();
const GOOGLE_DRIVE_CONNECTION_KEY = "tracker-rodu-google-drive-connected";

export interface GoogleDriveProjectTarget {
  projectId: string;
  projectName: string;
}

export interface GoogleDriveUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export interface GoogleDriveUploadOptions {
  folderPath?: string[];
  /** Stable, non-secret key used to resume an interrupted logical upload. */
  deduplicationKey?: string;
  onProgress?: (progress: GoogleDriveUploadProgress) => void;
}

export interface GoogleDriveUploadedFile {
  id: string;
  webViewLink: string;
  md5Checksum?: string;
  modifiedTime?: string;
  headRevisionId?: string;
}

export interface GoogleDriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  md5Checksum?: string;
  modifiedTime?: string;
  headRevisionId?: string;
}

export function prepareGoogleDriveAuthorization(): Promise<void> {
  return loadGoogleIdentityServices();
}

export function isGoogleDriveAuthorized(): boolean {
  return Boolean(activeToken && activeToken.expiresAt > Date.now() + 60_000);
}

export function hasGoogleDriveConnectionHint(): boolean {
  return safeStorageGet(GOOGLE_DRIVE_CONNECTION_KEY) === "1";
}

export async function authorizeGoogleDrive(): Promise<void> {
  await getGoogleDriveAccessToken(false, "consent");
}

export async function reconnectGoogleDrive(): Promise<void> {
  activeToken = null;
  tokenRequestPromise = null;
  await getGoogleDriveAccessToken(true, "select_account");
}

export async function uploadFileToGoogleDrive(
  target: GoogleDriveProjectTarget,
  file: File,
  attachmentId: string,
  options: GoogleDriveUploadOptions = {},
): Promise<GoogleDriveUploadedFile> {
  const deduplicationKey = safeDriveAppProperty(options.deduplicationKey ?? "");
  if (!deduplicationKey) {
    return uploadNewFileToGoogleDrive(target, file, attachmentId, options, "");
  }

  const promiseKey = `${target.projectId}:${deduplicationKey}`;
  const active = deduplicatedUploadPromises.get(promiseKey);
  if (active) return active;
  const upload = uploadNewFileToGoogleDrive(
    target,
    file,
    attachmentId,
    options,
    deduplicationKey,
  ).finally(() => {
    deduplicatedUploadPromises.delete(promiseKey);
  });
  deduplicatedUploadPromises.set(promiseKey, upload);
  return upload;
}

async function uploadNewFileToGoogleDrive(
  target: GoogleDriveProjectTarget,
  file: File,
  attachmentId: string,
  options: GoogleDriveUploadOptions,
  deduplicationKey: string,
): Promise<GoogleDriveUploadedFile> {
  const projectFolderId = await ensureProjectFolder(target);
  const folderId = options.folderPath?.length
    ? await ensureNestedFolderPath(target, projectFolderId, options.folderPath)
    : projectFolderId;
  if (deduplicationKey) {
    const existing = await findFileByDeduplicationKey(target, deduplicationKey);
    if (existing) return existing;
  }
  const metadata = {
    name: file.name,
    parents: [folderId],
    appProperties: {
      trackerRoduProjectId: target.projectId,
      trackerRoduAttachmentId: attachmentId,
      ...(deduplicationKey ? { trackerRoduDeduplicationKey: deduplicationKey } : {}),
    },
  };
  const boundary = `tracker-rodu-${attachmentId}`;
  const body = new Blob([
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    JSON.stringify(metadata),
    "\r\n",
    `--${boundary}\r\n`,
    `Content-Type: ${file.type || "application/octet-stream"}\r\n\r\n`,
    file,
    "\r\n",
    `--${boundary}--`,
  ]);
  const response = await driveUploadFetch(
    `${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink,md5Checksum,modifiedTime,headRevisionId,size`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    options.onProgress,
  );
  const uploaded = await response.json() as DriveFile;
  if (!uploaded.id) {
    throw new Error("Хмарне сховище не повернуло ідентифікатор завантаженого файла.");
  }
  return {
    id: uploaded.id,
    webViewLink: uploaded.webViewLink || googleDriveViewUrl(uploaded.id),
    md5Checksum: uploaded.md5Checksum,
    modifiedTime: uploaded.modifiedTime,
    headRevisionId: uploaded.headRevisionId,
  };
}

async function findFileByDeduplicationKey(
  target: GoogleDriveProjectTarget,
  deduplicationKey: string,
): Promise<GoogleDriveUploadedFile | null> {
  const escapedProjectId = escapeDriveQueryValue(target.projectId);
  const escapedKey = escapeDriveQueryValue(deduplicationKey);
  const query = [
    "trashed=false",
    `appProperties has { key='trackerRoduProjectId' and value='${escapedProjectId}' }`,
    `appProperties has { key='trackerRoduDeduplicationKey' and value='${escapedKey}' }`,
  ].join(" and ");
  const response = await driveFetch(
    `${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(query)}&spaces=drive&fields=files(id,webViewLink,md5Checksum,modifiedTime,headRevisionId)&pageSize=2`,
  );
  const result = await response.json() as { files?: DriveFile[] };
  const existing = result.files?.[0];
  if (!existing?.id) return null;
  return {
    id: existing.id,
    webViewLink: existing.webViewLink || googleDriveViewUrl(existing.id),
    md5Checksum: existing.md5Checksum,
    modifiedTime: existing.modifiedTime,
    headRevisionId: existing.headRevisionId,
  };
}

export async function downloadFileFromGoogleDrive(fileId: string): Promise<Blob> {
  let response: Response;
  try {
    response = await driveFetch(
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/file not found/i.test(message) || /not found/i.test(message) || message.includes("(404)")) {
      throw new Error(
        "Файл Google Drive не знайдено або він недоступний для підключеного Google-акаунта. Підключіть той Google-акаунт, у якому збережено файл, і спробуйте ще раз.",
      );
    }
    throw error;
  }
  return response.blob();
}

export async function getGoogleDriveFileMetadata(fileId: string): Promise<GoogleDriveFileMetadata> {
  const response = await driveFetch(
    `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,webViewLink,md5Checksum,modifiedTime,headRevisionId,trashed`,
  );
  const file = await response.json() as DriveFile & { trashed?: boolean };
  if (!file.id || file.trashed) {
    throw new Error("Файл Google Drive не знайдено або він у кошику.");
  }
  if (!file.name) {
    throw new Error("Google Drive не повернув назву файлу.");
  }
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType || "application/octet-stream",
    size: Number(file.size ?? 0),
    webViewLink: file.webViewLink || googleDriveViewUrl(file.id),
    md5Checksum: file.md5Checksum,
    modifiedTime: file.modifiedTime,
    headRevisionId: file.headRevisionId,
  };
}

export async function listGoogleDriveFolderFiles(folderId: string): Promise<GoogleDriveFileMetadata[]> {
  const files: GoogleDriveFileMetadata[] = [];
  let pageToken = "";
  const escapedFolderId = escapeDriveQueryValue(folderId);

  do {
    const query = `'${escapedFolderId}' in parents and trashed=false`;
    const params = new URLSearchParams({
      q: query,
      spaces: "drive",
      fields: "nextPageToken,files(id,name,mimeType,size,webViewLink,md5Checksum,modifiedTime,headRevisionId,trashed)",
      pageSize: "1000",
      orderBy: "name_natural",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await driveFetch(`${GOOGLE_DRIVE_API}/files?${params.toString()}`);
    const result = await response.json() as { nextPageToken?: string; files?: DriveFile[] };
    for (const file of result.files ?? []) {
      if (!file.id || !file.name || file.trashed) continue;
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType || "application/octet-stream",
        size: Number(file.size ?? 0),
        webViewLink: file.webViewLink || googleDriveViewUrl(file.id),
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
        headRevisionId: file.headRevisionId,
      });
    }
    pageToken = result.nextPageToken ?? "";
  } while (pageToken);

  return files.sort((first, second) => first.name.localeCompare(second.name, "uk", {
    numeric: true,
    sensitivity: "base",
  }));
}

export async function deleteFileFromGoogleDrive(fileId: string): Promise<void> {
  await driveFetch(
    `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}`,
    { method: "DELETE" },
  );
}

export function googleDriveViewUrl(fileId: string): string {
  return `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`;
}

export function clearGoogleDriveSession(): void {
  if (activeToken) {
    (window as GoogleWindow).google?.accounts.oauth2.revoke?.(activeToken.accessToken);
  }
  activeToken = null;
  tokenRequestPromise = null;
  safeStorageRemove(GOOGLE_DRIVE_CONNECTION_KEY);
}

async function ensureProjectFolder(target: GoogleDriveProjectTarget): Promise<string> {
  const cacheKey = `project:${target.projectId}`;
  const existingPromise = folderPromises.get(cacheKey);
  if (existingPromise) return existingPromise;

  const folderPromise = findOrCreateProjectFolder(target)
    .finally(() => {
      folderPromises.delete(cacheKey);
    });
  folderPromises.set(cacheKey, folderPromise);
  return folderPromise;
}

async function ensureNestedFolderPath(
  target: GoogleDriveProjectTarget,
  rootFolderId: string,
  folderPath: string[],
): Promise<string> {
  let parentId = rootFolderId;
  let pathKey = "";
  for (const rawSegment of folderPath) {
    const segment = safeDriveFolderName(rawSegment);
    if (!segment) continue;
    pathKey = pathKey ? `${pathKey}/${segment}` : segment;
    parentId = await ensureChildFolder(target, parentId, segment, pathKey);
  }
  return parentId;
}

async function ensureChildFolder(
  target: GoogleDriveProjectTarget,
  parentId: string,
  folderName: string,
  pathKey: string,
): Promise<string> {
  const cacheKey = `folder:${target.projectId}:${parentId}:${pathKey}`;
  const existingPromise = folderPromises.get(cacheKey);
  if (existingPromise) return existingPromise;

  const folderPromise = findOrCreateChildFolder(target, parentId, folderName)
    .finally(() => {
      folderPromises.delete(cacheKey);
    });
  folderPromises.set(cacheKey, folderPromise);
  return folderPromise;
}

async function findOrCreateProjectFolder(target: GoogleDriveProjectTarget): Promise<string> {
  const escapedProjectId = escapeDriveQueryValue(target.projectId);
  const query = [
    `mimeType='${GOOGLE_FOLDER_MIME_TYPE}'`,
    "trashed=false",
    `appProperties has { key='trackerRoduProjectId' and value='${escapedProjectId}' }`,
    "appProperties has { key='trackerRoduType' and value='project-folder' }",
  ].join(" and ");
  const response = await driveFetch(
    `${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(query)}&spaces=drive&fields=files(id,name)&pageSize=10`,
  );
  const result = await response.json() as { files?: DriveFile[] };
  const existing = result.files?.[0];
  if (existing?.id) {
    if (existing.name !== target.projectName) {
      await driveFetch(`${GOOGLE_DRIVE_API}/files/${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: target.projectName }),
      });
    }
    return existing.id;
  }

  const createResponse = await driveFetch(
    `${GOOGLE_DRIVE_API}/files?fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: target.projectName,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        appProperties: {
          trackerRoduProjectId: target.projectId,
          trackerRoduType: "project-folder",
        },
      }),
    },
  );
  const created = await createResponse.json() as DriveFile;
  if (!created.id) {
    throw new Error("Не вдалося створити папку проєкту в хмарному сховищі.");
  }
  return created.id;
}

async function findOrCreateChildFolder(
  target: GoogleDriveProjectTarget,
  parentId: string,
  folderName: string,
): Promise<string> {
  const escapedProjectId = escapeDriveQueryValue(target.projectId);
  const escapedParentId = escapeDriveQueryValue(parentId);
  const escapedFolderName = escapeDriveQueryValue(folderName);
  const query = [
    `mimeType='${GOOGLE_FOLDER_MIME_TYPE}'`,
    "trashed=false",
    `name='${escapedFolderName}'`,
    `'${escapedParentId}' in parents`,
    `appProperties has { key='trackerRoduProjectId' and value='${escapedProjectId}' }`,
  ].join(" and ");
  const response = await driveFetch(
    `${GOOGLE_DRIVE_API}/files?q=${encodeURIComponent(query)}&spaces=drive&fields=files(id,name)&pageSize=10`,
  );
  const result = await response.json() as { files?: DriveFile[] };
  const existing = result.files?.[0];
  if (existing?.id) return existing.id;

  const createResponse = await driveFetch(
    `${GOOGLE_DRIVE_API}/files?fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: folderName,
        mimeType: GOOGLE_FOLDER_MIME_TYPE,
        parents: [parentId],
        appProperties: {
          trackerRoduProjectId: target.projectId,
          trackerRoduType: "document-folder",
        },
      }),
    },
  );
  const created = await createResponse.json() as DriveFile;
  if (!created.id) {
    throw new Error("Не вдалося створити папку документа в хмарному сховищі.");
  }
  return created.id;
}

function safeDriveFolderName(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

function safeDriveAppProperty(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 120);
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getGoogleDriveAccessToken();
  let response = await fetchWithToken(url, init, token);
  if (response.status === 401) {
    activeToken = null;
    token = await getGoogleDriveAccessToken(true);
    response = await fetchWithToken(url, init, token);
  }
  if (!response.ok) {
    const message = await googleApiError(response);
    if (response.status === 403) {
      throw new Error(
        `${message} Перевірте налаштування хмарного сховища.`,
      );
    }
    throw new Error(message);
  }
  return response;
}

async function driveUploadFetch(
  url: string,
  init: RequestInit,
  onProgress?: (progress: GoogleDriveUploadProgress) => void,
): Promise<Response> {
  if (!onProgress || typeof XMLHttpRequest === "undefined" || !(init.body instanceof Blob)) {
    return driveFetch(url, init);
  }

  let token = await getGoogleDriveAccessToken();
  let response = await xhrFetchWithToken(url, init, token, onProgress);
  if (response.status === 401) {
    activeToken = null;
    token = await getGoogleDriveAccessToken(true);
    response = await xhrFetchWithToken(url, init, token, onProgress);
  }
  if (!response.ok) {
    const message = await googleApiError(response);
    if (response.status === 403) {
      throw new Error(
        `${message} Перевірте налаштування хмарного сховища.`,
      );
    }
    throw new Error(message);
  }
  return response;
}

function fetchWithToken(url: string, init: RequestInit, accessToken: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}

function xhrFetchWithToken(
  url: string,
  init: RequestInit,
  accessToken: string,
  onProgress: (progress: GoogleDriveUploadProgress) => void,
): Promise<Response> {
  const body = init.body;
  if (!(body instanceof Blob)) {
    return fetchWithToken(url, init, accessToken);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method ?? "GET", url);
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : body.size;
      const percent = total > 0 ? Math.round((event.loaded / total) * 100) : 0;
      onProgress({
        loaded: event.loaded,
        total,
        percent: Math.max(0, Math.min(100, percent)),
      });
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress({ loaded: body.size, total: body.size, percent: 100 });
      }
      resolve(new Response(xhr.responseText, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: parseXhrHeaders(xhr.getAllResponseHeaders()),
      }));
    };
    xhr.onerror = () => reject(new Error("Не вдалося завантажити файл у хмарне сховище."));
    xhr.onabort = () => reject(new Error("Завантаження файлу скасовано."));
    xhr.send(body);
  });
}

function parseXhrHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  rawHeaders
    .trim()
    .split(/[\r\n]+/)
    .filter(Boolean)
    .forEach((line) => {
      const index = line.indexOf(":");
      if (index <= 0) return;
      headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
    });
  return headers;
}

async function getGoogleDriveAccessToken(forceRefresh = false, prompt: GoogleDrivePrompt = "consent"): Promise<string> {
  if (!forceRefresh) {
    if (activeToken && activeToken.expiresAt > Date.now() + 60_000) {
      return activeToken.accessToken;
    }
  }
  if (tokenRequestPromise) return tokenRequestPromise;
  tokenRequestPromise = requestGoogleDriveAccessToken(prompt)
    .finally(() => {
      tokenRequestPromise = null;
    });
  return tokenRequestPromise;
}

async function requestGoogleDriveAccessToken(prompt: GoogleDrivePrompt): Promise<string> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() ?? "";
  if (!clientId) {
    throw new Error("У налаштуваннях застосунку не вказано VITE_GOOGLE_CLIENT_ID.");
  }
  if (!(window as GoogleWindow).google?.accounts.oauth2) {
    await loadGoogleIdentityServices();
  }
  const google = (window as GoogleWindow).google;
  if (!google) {
    throw new Error("Не вдалося завантажити сервіс авторизації Google.");
  }

  return new Promise<string>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Підключення хмарного сховища не було завершено."));
    }, 90_000);
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      callback: (response) => {
        window.clearTimeout(timeoutId);
        if (response.error || !response.access_token) {
          reject(new Error(
            response.error_description
              || "Хмарне сховище не надало доступ до файлів застосунку.",
          ));
          return;
        }
        activeToken = {
          accessToken: response.access_token,
          expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000,
        };
        safeStorageSet(GOOGLE_DRIVE_CONNECTION_KEY, "1");
        resolve(activeToken.accessToken);
      },
      error_callback: (error) => {
        window.clearTimeout(timeoutId);
        const message = error.type === "popup_failed_to_open"
          ? "Браузер заблокував вікно підключення сховища. Дозвольте спливні вікна для цього сайту й спробуйте ще раз."
          : error.type === "popup_closed"
            ? "Вікно підключення сховища було закрито до завершення."
            : "Не вдалося відкрити вікно підключення сховища.";
        reject(new Error(message));
      },
    });
    client.requestAccessToken({
      prompt: prompt || (!hasGoogleDriveConnectionHint() ? "consent" : ""),
    });
  });
}

function loadGoogleIdentityServices(): Promise<void> {
  if ((window as GoogleWindow).google?.accounts.oauth2) return Promise.resolve();
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Не вдалося завантажити Google Identity Services.")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не вдалося завантажити Google Identity Services."));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
}

async function googleApiError(response: Response): Promise<string> {
  try {
    const body = await response.json() as {
      error?: {
        message?: string;
      };
    };
    return body.error?.message || `Помилка хмарного сховища (${response.status}).`;
  } catch {
    return `Помилка хмарного сховища (${response.status}).`;
  }
}

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable in private mode.
  }
}

function safeStorageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage may be unavailable in private mode.
  }
}
