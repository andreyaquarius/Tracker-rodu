export const GEDCOM_PHOTO_PROXY_HOSTNAME = "sites-cf.mhcache.com";
export const GEDCOM_PHOTO_CONTENT_TYPE_HEADER = "X-Gedcom-Photo-Content-Type";

type ProxyErrorPayload = {
  error?: unknown;
  code?: unknown;
  message?: unknown;
};

export function isGedcomPhotoProxyUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  return url.protocol === "https:"
    && url.hostname.toLocaleLowerCase("en-US") === GEDCOM_PHOTO_PROXY_HOSTNAME
    && (url.port === "" || url.port === "443")
    && !url.username
    && !url.password;
}

export function normalizeGedcomPhotoMime(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return /^image\/[a-z0-9][a-z0-9.+-]{0,79}$/u.test(normalized)
    ? normalized
    : "";
}

export async function gedcomPhotoProxyErrorMessage(error: unknown): Promise<string> {
  const fallback = "Не вдалося отримати фотографію із зовнішнього джерела.";
  if (error && typeof error === "object" && "context" in error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const payload = await readProxyErrorPayload(context);
      const code = stringValue(payload?.error ?? payload?.code);
      const message = stringValue(payload?.message);
      const mapped = proxyCodeMessage(code, context.status);
      if (mapped) return mapped;
      if (message) return message;
      if (context.statusText.trim()) return context.statusText.trim();
    }
  }

  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

export async function fetchGedcomPhotoViaProxy(sourceUrl: string): Promise<Blob> {
  if (!isGedcomPhotoProxyUrl(sourceUrl)) {
    throw new Error("Джерело GEDCOM-фотографії не дозволене.");
  }

  // Keep the auth client lazy so pure URL/MIME helpers stay usable in
  // non-browser validation and import tooling.
  const { getSupabaseClient } = await import("./supabaseAuth.ts");
  const { data, error, response } = await getSupabaseClient().functions.invoke<Blob>(
    "fetch-gedcom-photo",
    { body: { url: sourceUrl } },
  );
  if (error) {
    throw new Error(await gedcomPhotoProxyErrorMessage(error));
  }
  if (!(data instanceof Blob)) {
    throw new Error("Сервер повернув фотографію в некоректному форматі.");
  }

  const originalMime = normalizeGedcomPhotoMime(
    response?.headers.get(GEDCOM_PHOTO_CONTENT_TYPE_HEADER),
  );
  if (!originalMime) {
    throw new Error("Сервер не повернув безпечний тип GEDCOM-фотографії.");
  }

  return new Blob([data], { type: originalMime });
}

async function readProxyErrorPayload(response: Response): Promise<ProxyErrorPayload | null> {
  try {
    const payload = await response.clone().json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload as ProxyErrorPayload;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function proxyCodeMessage(code: string, status: number): string {
  switch (code) {
    case "PHOTO_SOURCE_EXPIRED":
      return "Посилання MyHeritage на фотографію вже недоступне. Створіть у MyHeritage новий експорт GEDCOM із фото та одразу імпортуйте щойно завантажений файл; повторний імпорт цього самого GEDCOM не оновить посилання.";
    case "PHOTO_SOURCE_TIMEOUT":
      return "Зовнішнє джерело фотографії не відповіло вчасно. Спробуйте ще раз.";
    case "PHOTO_TOO_LARGE":
      return "Фотографія перевищує дозволені 25 МБ.";
    case "PHOTO_TYPE_INVALID":
      return "Зовнішнє джерело повернуло не зображення.";
    case "AUTH_REQUIRED":
    case "AUTH_INVALID":
      return "Увійдіть в акаунт, щоб зберегти GEDCOM-фотографії у Google Drive.";
    case "ORIGIN_NOT_ALLOWED":
      return "Сервер не дозволив запит із цієї адреси сайту.";
    case "NOT_FOUND":
      return "Серверна функція завантаження GEDCOM-фото ще не розгорнута.";
    default:
      return status === 404
        ? "Серверна функція завантаження GEDCOM-фото ще не розгорнута."
        : "";
  }
}
