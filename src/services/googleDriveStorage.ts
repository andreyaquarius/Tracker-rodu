const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const GOOGLE_PICKER_SCRIPT = "https://apis.google.com/js/api.js";

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
      include_granted_scopes?: boolean;
      callback: (response: GoogleTokenResponse) => void;
      error_callback?: (error: { type?: string }) => void;
    }) => GoogleTokenClient;
    revoke?: (accessToken: string, callback?: () => void) => void;
  };
};

type GooglePickerDocument = Record<string, unknown> & {
  id?: string;
  name?: string;
  mimeType?: string;
  url?: string;
  sizeBytes?: number | string;
  resourceKey?: string;
};

type GooglePickerResponse = Record<string, unknown> & {
  action?: string;
  docs?: GooglePickerDocument[];
};

type GooglePickerDocsView = {
  setIncludeFolders: (includeFolders: boolean) => GooglePickerDocsView;
  setSelectFolderEnabled: (enabled: boolean) => GooglePickerDocsView;
  setMode: (mode: string) => GooglePickerDocsView;
};

type GooglePicker = {
  setVisible: (visible: boolean) => void;
};

type GooglePickerBuilder = {
  addView: (view: GooglePickerDocsView) => GooglePickerBuilder;
  enableFeature: (feature: string) => GooglePickerBuilder;
  setAppId: (appId: string) => GooglePickerBuilder;
  setCallback: (callback: (response: GooglePickerResponse) => void) => GooglePickerBuilder;
  setDeveloperKey: (apiKey: string) => GooglePickerBuilder;
  setLocale: (locale: string) => GooglePickerBuilder;
  setMaxItems: (maxItems: number) => GooglePickerBuilder;
  setOAuthToken: (accessToken: string) => GooglePickerBuilder;
  setOrigin: (origin: string) => GooglePickerBuilder;
  setTitle: (title: string) => GooglePickerBuilder;
  build: () => GooglePicker;
};

type GooglePickerApi = {
  Action: { PICKED: string; CANCEL: string; ERROR: string };
  DocsView: new (viewId: string) => GooglePickerDocsView;
  DocsViewMode: { LIST: string };
  Document: {
    ID: string;
    NAME: string;
    MIME_TYPE: string;
    URL: string;
    SIZE_BYTES?: string;
    RESOURCE_KEY?: string;
  };
  Feature: { MULTISELECT_ENABLED: string };
  PickerBuilder: new () => GooglePickerBuilder;
  Response: { ACTION: string; DOCUMENTS: string };
  ViewId: { DOCS: string };
};

type GoogleApiLoader = {
  load: (
    api: string,
    options: {
      callback: () => void;
      onerror: () => void;
      timeout: number;
      ontimeout: () => void;
    },
  ) => void;
};

type GoogleWindow = Window & {
  google?: {
    accounts?: GoogleAccounts;
    picker?: GooglePickerApi;
  };
  gapi?: GoogleApiLoader;
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
  resourceKey?: string;
  trashed?: boolean;
};

let googleScriptPromise: Promise<void> | null = null;
let googlePickerScriptPromise: Promise<void> | null = null;
let googlePickerApiPromise: Promise<void> | null = null;
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
  resourceKey?: string;
}

export interface GoogleDrivePickerFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  webViewLink: string;
  resourceKey?: string;
}

export interface GoogleDrivePickerOptions {
  multiselect?: boolean;
  maxItems?: number;
  title?: string;
}

export function prepareGoogleDriveAuthorization(): Promise<void> {
  return loadGoogleIdentityServices();
}

export function prepareGoogleDrivePicker(): Promise<void> {
  return loadGooglePickerApi();
}

export async function pickGoogleDriveFiles(
  options: GoogleDrivePickerOptions = {},
): Promise<GoogleDrivePickerFile[]> {
  const apiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY?.trim() ?? "";
  const appId = import.meta.env.VITE_GOOGLE_DRIVE_APP_ID?.trim() ?? "";
  const missingConfiguration = [
    !apiKey ? "VITE_GOOGLE_PICKER_API_KEY" : "",
    !appId ? "VITE_GOOGLE_DRIVE_APP_ID" : "",
  ].filter(Boolean);
  if (missingConfiguration.length) {
    throw new Error(
      `Для вибору файлів із Google Drive не налаштовано ${missingConfiguration.join(" та ")}.`,
    );
  }

  const [accessToken] = await Promise.all([
    getGoogleDriveAccessToken(false, "consent"),
    loadGooglePickerApi(),
  ]);
  const pickerApi = (window as GoogleWindow).google?.picker;
  if (!pickerApi) {
    throw new Error("Не вдалося завантажити вікно вибору файлів Google Drive.");
  }

  const docsView = new pickerApi.DocsView(pickerApi.ViewId.DOCS)
    .setIncludeFolders(false)
    .setSelectFolderEnabled(false)
    .setMode(pickerApi.DocsViewMode.LIST);

  return new Promise<GoogleDrivePickerFile[]>((resolve, reject) => {
    let settled = false;
    const finish = (files: GoogleDrivePickerFile[]) => {
      if (settled) return;
      settled = true;
      resolve(files);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    try {
      let builder = new pickerApi.PickerBuilder()
        .addView(docsView)
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setAppId(appId)
        .setOrigin(window.location.origin)
        .setLocale("uk")
        .setTitle(options.title?.trim() || "Оберіть документи з Google Drive")
        .setCallback((response) => {
          const action = String(
            response[pickerApi.Response.ACTION]
            ?? response.action
            ?? "",
          );
          if (action === pickerApi.Action.CANCEL) {
            finish([]);
            return;
          }
          if (action === pickerApi.Action.ERROR) {
            fail(new Error("Google Drive повідомив про помилку під час вибору файлів."));
            return;
          }
          if (action !== pickerApi.Action.PICKED) return;

          const rawDocuments = response[pickerApi.Response.DOCUMENTS] ?? response.docs;
          const documents = Array.isArray(rawDocuments)
            ? rawDocuments as GooglePickerDocument[]
            : [];
          const files = documents.flatMap((document) => {
            const id = pickerStringField(document, pickerApi.Document.ID, "id");
            if (!id) return [];
            const resourceKeyField = pickerApi.Document.RESOURCE_KEY;
            const resourceKey = resourceKeyField
              ? pickerStringField(document, resourceKeyField, "resourceKey")
              : pickerStringField(document, "resourceKey");
            return [{
              id,
              name: pickerStringField(document, pickerApi.Document.NAME, "name") || "Файл Google Drive",
              mimeType: pickerStringField(document, pickerApi.Document.MIME_TYPE, "mimeType") || "application/octet-stream",
              size: pickerNumberField(document, pickerApi.Document.SIZE_BYTES, "sizeBytes"),
              webViewLink: pickerStringField(document, pickerApi.Document.URL, "url")
                || googleDriveViewUrl(id, resourceKey),
              resourceKey: resourceKey || undefined,
            }];
          });
          finish(files);
        });
      if (options.multiselect !== false) {
        builder = builder.enableFeature(pickerApi.Feature.MULTISELECT_ENABLED);
      }
      const maxItems = Math.floor(options.maxItems ?? 0);
      if (maxItems > 0) builder = builder.setMaxItems(maxItems);
      builder.build().setVisible(true);
    } catch (error) {
      fail(error instanceof Error
        ? error
        : new Error("Не вдалося відкрити вікно вибору Google Drive."));
    }
  });
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
  folderPromises.clear();
  deduplicatedUploadPromises.clear();
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

export async function downloadFileFromGoogleDrive(
  fileId: string,
  resourceKey?: string,
): Promise<Blob> {
  let response: Response;
  try {
    response = await driveFetch(
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
      { headers: googleDriveResourceKeyHeaders(fileId, resourceKey) },
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

export async function getGoogleDriveFileMetadata(
  fileId: string,
  resourceKey?: string,
): Promise<GoogleDriveFileMetadata> {
  const response = await driveFetch(
    `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,webViewLink,md5Checksum,modifiedTime,headRevisionId,resourceKey,trashed`,
    { headers: googleDriveResourceKeyHeaders(fileId, resourceKey) },
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
    webViewLink: file.webViewLink || googleDriveViewUrl(file.id, file.resourceKey || resourceKey),
    md5Checksum: file.md5Checksum,
    modifiedTime: file.modifiedTime,
    headRevisionId: file.headRevisionId,
    resourceKey: file.resourceKey || resourceKey,
  };
}

export async function listGoogleDriveFolderFiles(
  folderId: string,
  resourceKey?: string,
): Promise<GoogleDriveFileMetadata[]> {
  const files: GoogleDriveFileMetadata[] = [];
  let pageToken = "";
  const escapedFolderId = escapeDriveQueryValue(folderId);

  do {
    const query = `'${escapedFolderId}' in parents and trashed=false`;
    const params = new URLSearchParams({
      q: query,
      spaces: "drive",
      includeItemsFromAllDrives: "true",
      supportsAllDrives: "true",
      fields: "nextPageToken,files(id,name,mimeType,size,webViewLink,md5Checksum,modifiedTime,headRevisionId,resourceKey,trashed)",
      pageSize: "1000",
      orderBy: "name_natural",
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await driveFetch(
      `${GOOGLE_DRIVE_API}/files?${params.toString()}`,
      { headers: googleDriveResourceKeyHeaders(folderId, resourceKey) },
    );
    const result = await response.json() as { nextPageToken?: string; files?: DriveFile[] };
    for (const file of result.files ?? []) {
      if (!file.id || !file.name || file.trashed) continue;
      files.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType || "application/octet-stream",
        size: Number(file.size ?? 0),
        webViewLink: file.webViewLink || googleDriveViewUrl(file.id, file.resourceKey),
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime,
        headRevisionId: file.headRevisionId,
        resourceKey: file.resourceKey,
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

export function googleDriveViewUrl(fileId: string, resourceKey?: string): string {
  const params = new URLSearchParams({ id: fileId });
  if (isSafeGoogleDriveIdentifier(resourceKey)) params.set("resourcekey", resourceKey);
  return `https://drive.google.com/open?${params.toString()}`;
}

export function clearGoogleDriveSession(): void {
  if (activeToken) {
    (window as GoogleWindow).google?.accounts?.oauth2.revoke?.(activeToken.accessToken);
  }
  activeToken = null;
  tokenRequestPromise = null;
  folderPromises.clear();
  deduplicatedUploadPromises.clear();
  safeStorageRemove(GOOGLE_DRIVE_CONNECTION_KEY);
}

async function ensureProjectFolder(target: GoogleDriveProjectTarget): Promise<string> {
  const cacheKey = `project:${target.projectId}`;
  const existingPromise = folderPromises.get(cacheKey);
  if (existingPromise) return existingPromise;

  const folderPromise = findOrCreateProjectFolder(target);
  folderPromises.set(cacheKey, folderPromise);
  void folderPromise.catch(() => {
    if (folderPromises.get(cacheKey) === folderPromise) folderPromises.delete(cacheKey);
  });
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

  const folderPromise = findOrCreateChildFolder(target, parentId, folderName);
  folderPromises.set(cacheKey, folderPromise);
  void folderPromise.catch(() => {
    if (folderPromises.get(cacheKey) === folderPromise) folderPromises.delete(cacheKey);
  });
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

function isSafeGoogleDriveIdentifier(value: string | undefined): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]+$/.test(value));
}

function googleDriveResourceKeyHeaders(
  fileId: string,
  resourceKey?: string,
): HeadersInit | undefined {
  if (!isSafeGoogleDriveIdentifier(fileId) || !isSafeGoogleDriveIdentifier(resourceKey)) {
    return undefined;
  }
  return {
    "X-Goog-Drive-Resource-Keys": `${fileId}/${resourceKey}`,
  };
}

function pickerStringField(
  document: GooglePickerDocument,
  ...keys: Array<string | undefined>
): string {
  for (const key of keys) {
    if (!key) continue;
    const value = document[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function pickerNumberField(
  document: GooglePickerDocument,
  ...keys: Array<string | undefined>
): number {
  for (const key of keys) {
    if (!key) continue;
    const value = Number(document[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  let token = await getGoogleDriveAccessToken();
  let response = await retryGoogleDriveRequest(() => fetchWithToken(url, init, token));
  if (response.status === 401) {
    activeToken = null;
    token = await getGoogleDriveAccessToken(true);
    response = await retryGoogleDriveRequest(() => fetchWithToken(url, init, token));
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
  let response = await retryGoogleDriveRequest(
    () => xhrFetchWithToken(url, init, token, onProgress),
  );
  if (response.status === 401) {
    activeToken = null;
    token = await getGoogleDriveAccessToken(true);
    response = await retryGoogleDriveRequest(
      () => xhrFetchWithToken(url, init, token, onProgress),
    );
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

async function retryGoogleDriveRequest(
  request: () => Promise<Response>,
  maxAttempts = 4,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await request();
      if (!isRetryableGoogleDriveStatus(response.status) || attempt === maxAttempts - 1) {
        return response;
      }
      const delayMs = googleDriveRetryDelay(response, attempt);
      await response.body?.cancel("retry").catch(() => undefined);
      await waitForRetry(delayMs);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts - 1) throw error;
      await waitForRetry(500 * (2 ** attempt));
    }
  }
  throw lastError ?? new Error("Не вдалося виконати запит до Google Drive.");
}

function isRetryableGoogleDriveStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function googleDriveRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")?.trim() ?? "";
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.max(250, seconds * 1000));
  }
  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.min(30_000, Math.max(250, retryAt - Date.now()));
  }
  return Math.min(30_000, 500 * (2 ** attempt));
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
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
  if (!(window as GoogleWindow).google?.accounts?.oauth2) {
    await loadGoogleIdentityServices();
  }
  const google = (window as GoogleWindow).google;
  if (!google?.accounts?.oauth2) {
    throw new Error("Не вдалося завантажити сервіс авторизації Google.");
  }
  const oauth2 = google.accounts.oauth2;

  return new Promise<string>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error("Підключення хмарного сховища не було завершено."));
    }, 90_000);
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_DRIVE_SCOPE,
      include_granted_scopes: false,
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
  if ((window as GoogleWindow).google?.accounts?.oauth2) return Promise.resolve();
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

function loadGooglePickerApi(): Promise<void> {
  if ((window as GoogleWindow).google?.picker) return Promise.resolve();
  if (googlePickerApiPromise) return googlePickerApiPromise;
  googlePickerApiPromise = loadGooglePickerScript()
    .then(() => new Promise<void>((resolve, reject) => {
      const googleWindow = window as GoogleWindow;
      if (googleWindow.google?.picker) {
        resolve();
        return;
      }
      if (!googleWindow.gapi?.load) {
        reject(new Error("Не вдалося завантажити Google Picker API."));
        return;
      }
      googleWindow.gapi.load("picker", {
        callback: () => {
          if (googleWindow.google?.picker) {
            resolve();
          } else {
            reject(new Error("Google Picker API завантажився некоректно."));
          }
        },
        onerror: () => reject(new Error("Не вдалося завантажити Google Picker API.")),
        timeout: 20_000,
        ontimeout: () => reject(new Error("Перевищено час очікування Google Picker API.")),
      });
    }))
    .catch((error) => {
      googlePickerApiPromise = null;
      throw error;
    });
  return googlePickerApiPromise;
}

function loadGooglePickerScript(): Promise<void> {
  if ((window as GoogleWindow).gapi?.load) return Promise.resolve();
  if (googlePickerScriptPromise) return googlePickerScriptPromise;
  googlePickerScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_PICKER_SCRIPT}"]`,
    );
    const handleLoad = () => {
      if ((window as GoogleWindow).gapi?.load) {
        resolve();
      } else {
        document.querySelector<HTMLScriptElement>(
          `script[src="${GOOGLE_PICKER_SCRIPT}"]`,
        )?.remove();
        reject(new Error("Не вдалося ініціалізувати Google Picker API."));
      }
    };
    const handleError = () => {
      existing?.remove();
      reject(new Error("Не вдалося завантажити Google Picker API."));
    };
    if (existing) {
      existing.addEventListener("load", handleLoad, { once: true });
      existing.addEventListener("error", handleError, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = GOOGLE_PICKER_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onload = handleLoad;
    script.onerror = () => {
      script.remove();
      reject(new Error("Не вдалося завантажити Google Picker API."));
    };
    document.head.appendChild(script);
  }).catch((error) => {
    googlePickerScriptPromise = null;
    throw error;
  });
  return googlePickerScriptPromise;
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
