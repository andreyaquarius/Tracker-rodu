import type { GoogleUser } from "../types";

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(config: {
            client_id: string;
            scope: string;
            include_granted_scopes?: boolean;
            callback: (response: TokenResponse) => void;
            error_callback?: (error: GoogleOAuthError) => void;
          }): { requestAccessToken(config?: { prompt?: string; scope?: string }): void };
          hasGrantedAllScopes(
            response: TokenResponse,
            firstScope: string,
            ...restScopes: string[]
          ): boolean;
          revoke(token: string, callback?: () => void): void;
        };
      };
    };
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GoogleOAuthError {
  type?: "popup_failed_to_open" | "popup_closed" | "unknown";
  message?: string;
}

interface StoredGoogleSession {
  accessToken: string;
  tokenExpiresAt: number;
  user: GoogleUser | null;
  driveFileId: string | null;
  lastSyncedAt: string | null;
}

const GIS_URL = "https://accounts.google.com/gsi/client";
const GOOGLE_SESSION_KEY = "tracker-rodu-google-session";
const LEGACY_GOOGLE_SESSION_KEY = "rodovyi-navigator-google-session";
const APP_DATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const BASE_SCOPES = [
  "openid",
  "profile",
  "email",
  APP_DATA_SCOPE,
].join(" ");

const restoredSession = readStoredSession();
let accessToken = restoredSession?.accessToken ?? "";
let tokenExpiresAt = restoredSession?.tokenExpiresAt ?? 0;

function readStoredSession(): StoredGoogleSession | null {
  try {
    const raw =
      sessionStorage.getItem(GOOGLE_SESSION_KEY) ??
      sessionStorage.getItem(LEGACY_GOOGLE_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as StoredGoogleSession;
    if (!session.accessToken || Date.now() >= session.tokenExpiresAt) {
      sessionStorage.removeItem(GOOGLE_SESSION_KEY);
      sessionStorage.removeItem(LEGACY_GOOGLE_SESSION_KEY);
      return null;
    }
    if (!sessionStorage.getItem(GOOGLE_SESSION_KEY)) {
      sessionStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify(session));
      sessionStorage.removeItem(LEGACY_GOOGLE_SESSION_KEY);
    }
    return session;
  } catch {
    sessionStorage.removeItem(GOOGLE_SESSION_KEY);
    sessionStorage.removeItem(LEGACY_GOOGLE_SESSION_KEY);
    return null;
  }
}

function writeStoredSession(updates: Partial<StoredGoogleSession>): void {
  const current = readStoredSession();
  const session: StoredGoogleSession = {
    accessToken,
    tokenExpiresAt,
    user: current?.user ?? null,
    driveFileId: current?.driveFileId ?? null,
    lastSyncedAt: current?.lastSyncedAt ?? null,
    ...updates,
  };
  sessionStorage.setItem(GOOGLE_SESSION_KEY, JSON.stringify(session));
}

export async function prepareGoogleSignIn(): Promise<void> {
  if (window.google) return;
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_URL}"]`);
  if (existing) {
    await new Promise<void>((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Не вдалося завантажити Google Identity Services.")), { once: true });
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не вдалося завантажити Google Identity Services."));
    document.head.appendChild(script);
  });
}

function requestToken(scope: string, prompt = ""): Promise<string> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("У файлі .env не вказано VITE_GOOGLE_CLIENT_ID.");
  return prepareGoogleSignIn().then(
    () =>
      new Promise<string>((resolve, reject) => {
        const client = window.google!.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope,
          include_granted_scopes: false,
          callback: (response) => {
            if (!response.access_token) {
              reject(new Error(response.error_description || "Google не надав токен доступу."));
              return;
            }
            if (!window.google!.accounts.oauth2.hasGrantedAllScopes(response, APP_DATA_SCOPE)) {
              reject(
                new Error(
                  "Google не надав доступ до папки даних застосунку. Додайте scope drive.appdata у Google Auth Platform → Data Access і підключіть Google Drive повторно.",
                ),
              );
              return;
            }
            accessToken = response.access_token;
            tokenExpiresAt = Date.now() + Math.max(0, (response.expires_in ?? 3600) - 60) * 1000;
            writeStoredSession({ accessToken, tokenExpiresAt });
            resolve(accessToken);
          },
          error_callback: (error) => {
            if (error.type === "popup_failed_to_open") {
              reject(
                new Error(
                  "Браузер заблокував вікно входу Google. Дозвольте спливні вікна для цього сайту та повторіть вхід.",
                ),
              );
              return;
            }
            if (error.type === "popup_closed") {
              reject(new Error("Вікно входу Google було закрито до завершення авторизації."));
              return;
            }
            reject(new Error(error.message || "Не вдалося відкрити вікно входу Google."));
          },
        });
        client.requestAccessToken({ prompt });
      }),
  );
}

export function signInWithGoogle(): Promise<string> {
  return requestToken(BASE_SCOPES, "consent select_account");
}

export function requestDriveFilePermission(): Promise<string> {
  return requestToken(`${BASE_SCOPES} https://www.googleapis.com/auth/drive.file`, "consent");
}

export function getAccessToken(): string | null {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;
  accessToken = "";
  tokenExpiresAt = 0;
  sessionStorage.removeItem(GOOGLE_SESSION_KEY);
  sessionStorage.removeItem(LEGACY_GOOGLE_SESSION_KEY);
  return null;
}

export function getGoogleSession(): Omit<StoredGoogleSession, "accessToken" | "tokenExpiresAt"> | null {
  const session = readStoredSession();
  if (!session) return null;
  return {
    user: session.user,
    driveFileId: session.driveFileId,
    lastSyncedAt: session.lastSyncedAt,
  };
}

export function saveGoogleSessionDetails(
  updates: Partial<Pick<StoredGoogleSession, "user" | "driveFileId" | "lastSyncedAt">>,
): void {
  if (!getAccessToken()) return;
  writeStoredSession(updates);
}

export async function fetchGoogleUser(token: string): Promise<GoogleUser> {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error("Не вдалося отримати профіль Google.");
  const data = (await response.json()) as { name?: string; email?: string; picture?: string };
  return { name: data.name || "Користувач Google", email: data.email || "", picture: data.picture };
}

export function signOutFromGoogle(): void {
  if (accessToken && window.google) window.google.accounts.oauth2.revoke(accessToken);
  accessToken = "";
  tokenExpiresAt = 0;
  sessionStorage.removeItem(GOOGLE_SESSION_KEY);
  sessionStorage.removeItem(LEGACY_GOOGLE_SESSION_KEY);
}
