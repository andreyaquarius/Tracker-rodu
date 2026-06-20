const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
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

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
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
};

let googleScriptPromise: Promise<void> | null = null;
let tokenRequestPromise: Promise<string> | null = null;
let activeToken: StoredToken | null = null;
const folderPromises = new Map<string, Promise<string>>();

export interface GoogleDriveProjectTarget {
  projectId: string;
  projectName: string;
}

export interface GoogleDriveUploadedFile {
  id: string;
  webViewLink: string;
}

export function prepareGoogleDriveAuthorization(): Promise<void> {
  return loadGoogleIdentityServices();
}

export function isGoogleDriveAuthorized(): boolean {
  return Boolean(activeToken && activeToken.expiresAt > Date.now() + 60_000);
}

export async function authorizeGoogleDrive(): Promise<void> {
  await getGoogleDriveAccessToken();
}

export async function uploadFileToGoogleDrive(
  target: GoogleDriveProjectTarget,
  file: File,
  attachmentId: string,
): Promise<GoogleDriveUploadedFile> {
  const folderId = await ensureProjectFolder(target);
  const metadata = {
    name: file.name,
    parents: [folderId],
    appProperties: {
      trackerRoduProjectId: target.projectId,
      trackerRoduAttachmentId: attachmentId,
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
  const response = await driveFetch(
    `${GOOGLE_DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink`,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  const uploaded = await response.json() as DriveFile;
  if (!uploaded.id) {
    throw new Error("Хмарне сховище не повернуло ідентифікатор завантаженого файла.");
  }
  return {
    id: uploaded.id,
    webViewLink: uploaded.webViewLink || googleDriveViewUrl(uploaded.id),
  };
}

export async function downloadFileFromGoogleDrive(fileId: string): Promise<Blob> {
  const response = await driveFetch(
    `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`,
  );
  return response.blob();
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
}

async function ensureProjectFolder(target: GoogleDriveProjectTarget): Promise<string> {
  const existingPromise = folderPromises.get(target.projectId);
  if (existingPromise) return existingPromise;

  const folderPromise = findOrCreateProjectFolder(target)
    .finally(() => {
      folderPromises.delete(target.projectId);
    });
  folderPromises.set(target.projectId, folderPromise);
  return folderPromise;
}

async function findOrCreateProjectFolder(target: GoogleDriveProjectTarget): Promise<string> {
  const escapedProjectId = target.projectId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = [
    `mimeType='${GOOGLE_FOLDER_MIME_TYPE}'`,
    "trashed=false",
    `appProperties has { key='trackerRoduProjectId' and value='${escapedProjectId}' }`,
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

function fetchWithToken(url: string, init: RequestInit, accessToken: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(url, { ...init, headers });
}

async function getGoogleDriveAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    if (activeToken && activeToken.expiresAt > Date.now() + 60_000) {
      return activeToken.accessToken;
    }
  }
  if (tokenRequestPromise) return tokenRequestPromise;
  tokenRequestPromise = requestGoogleDriveAccessToken()
    .finally(() => {
      tokenRequestPromise = null;
    });
  return tokenRequestPromise;
}

async function requestGoogleDriveAccessToken(): Promise<string> {
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
    client.requestAccessToken();
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
