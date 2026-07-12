import type { ScanAttachment } from "../types";
import { createId } from "../utils/id";
import { sanitizeWebUrl } from "../utils/safeUrl";
import { nowIso } from "../utils/dateHelpers";
import {
  getCachedDocumentBlob,
  putCachedDocumentBlob,
} from "./documentBlobCache";
import {
  deleteFileFromGoogleDrive,
  downloadFileFromGoogleDrive,
  getGoogleDriveFileMetadata,
  googleDriveViewUrl,
  listGoogleDriveFolderFiles,
  uploadFileToGoogleDrive,
  type GoogleDriveFileMetadata,
  type GoogleDriveUploadProgress,
} from "./googleDriveStorage";

export const MAX_ATTACHMENT_SIZE_MB = 25;
export type AttachmentPolicy = "all" | "finding" | "archive-request" | "document" | "person-photo";
const MAX_FILE_SIZE = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;
const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const imageExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "tif", "tiff"]);

export type DriveAttachRange = {
  start?: number;
  end?: number;
};

export type ScanUploadProgress = GoogleDriveUploadProgress & {
  fileName: string;
};

export type SaveScanOptions = {
  driveFolderPath?: string[];
  onUploadProgress?: (progress: ScanUploadProgress) => void;
};

export type ScanPreviewKind = "image" | "pdf" | "web";

export type ScanPreviewSource = {
  kind: ScanPreviewKind;
  url: string;
  revokeOnClose: boolean;
};

export type DriveAttachmentPreview = {
  kind: "file" | "folder";
  source: "google-drive" | "external-url";
  name: string;
  totalFiles: number;
  attachableFiles: Array<{
    name: string;
    size: number;
    mimeType: string;
  }>;
};

let activeProject: { projectId: string; projectName: string } | null = null;
let activeProjectCanUpload = true;

export function setProjectAttachmentTarget(
  projectId: string | null,
  projectName = "",
  canUpload = true,
): void {
  activeProjectCanUpload = canUpload;
  activeProject = projectId
    ? { projectId, projectName: projectName.trim() || "Трекер Роду" }
    : null;
}

export async function saveScan(
  file: File,
  policy: AttachmentPolicy = "all",
  options: SaveScanOptions = {},
): Promise<ScanAttachment> {
  const supported =
    policy === "person-photo"
      ? isSupportedPersonPhoto(file)
      : policy === "finding"
      ? isSupportedFindingAttachment(file)
      : policy === "archive-request"
        ? isSupportedArchiveRequestAttachment(file)
        : isSupportedAttachment(file);
  if (!supported) {
    throw new Error(`Формат файлу «${file.name}» не підтримується.`);
  }
  if (policy !== "document" && file.size > MAX_FILE_SIZE) {
    throw new Error(`Файл «${file.name}» перевищує дозволені ${MAX_ATTACHMENT_SIZE_MB} МБ.`);
  }
  if (!activeProject) {
    throw new Error("Спочатку виберіть проєкт.");
  }

  if (!activeProjectCanUpload) {
    throw new Error("У цьому проєкті можна редагувати й видаляти наявні файли, але додавання нових файлів заблоковане поточним тарифом.");
  }

  const id = createId();
  const uploaded = await uploadFileToGoogleDrive(activeProject, file, id, {
    folderPath: options.driveFolderPath,
    onProgress: options.onUploadProgress
      ? (progress) => options.onUploadProgress?.({ ...progress, fileName: file.name })
      : undefined,
  });
  const attachment: ScanAttachment = {
    id,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    createdAt: nowIso(),
    storage: "google-drive",
    storagePath: uploaded.id,
    webViewLink: uploaded.webViewLink,
    driveMd5Checksum: uploaded.md5Checksum,
    driveModifiedTime: uploaded.modifiedTime,
    driveRevisionId: uploaded.headRevisionId,
  };
  void cacheScanBlob(attachment, file).catch(() => undefined);
  return attachment;
}

export async function attachGoogleDriveFile(
  fileReference: string,
  policy: AttachmentPolicy = "all",
): Promise<ScanAttachment> {
  const attached = await attachGoogleDriveReference(fileReference, policy);
  if (!attached[0]) {
    throw new Error("Не знайдено файлів для прикріплення.");
  }
  return attached[0];
}

export async function inspectAttachmentReference(
  fileReference: string,
  policy: AttachmentPolicy = "all",
): Promise<DriveAttachmentPreview> {
  if (isGoogleDriveReference(fileReference)) {
    return inspectGoogleDriveAttachment(fileReference, policy);
  }
  return inspectExternalUrlAttachment(fileReference, policy);
}

export async function attachAttachmentReference(
  fileReference: string,
  policy: AttachmentPolicy = "all",
  range: DriveAttachRange = {},
): Promise<ScanAttachment[]> {
  if (isGoogleDriveReference(fileReference)) {
    return attachGoogleDriveReference(fileReference, policy, range);
  }
  return [externalUrlToAttachment(fileReference, policy)];
}

export async function inspectGoogleDriveAttachment(
  fileReference: string,
  policy: AttachmentPolicy = "all",
): Promise<DriveAttachmentPreview> {
  const fileId = googleDriveFileId(fileReference);
  if (!fileId) {
    throw new Error("Вставте коректне посилання Google Drive або ідентифікатор файлу.");
  }

  const file = await getGoogleDriveFileMetadata(fileId);
  if (file.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    const files = supportedDriveFiles(await listGoogleDriveFolderFiles(file.id), policy);
    if (!files.length) {
      throw new Error("У цій папці не знайдено підтримуваних файлів.");
    }
    return {
      kind: "folder",
      source: "google-drive",
      name: file.name,
      totalFiles: files.length,
      attachableFiles: files.map((item) => ({
        name: item.name,
        size: item.size,
        mimeType: item.mimeType,
      })),
    };
  }
  ensureAttachableDriveFile(file, policy);
  return {
    kind: "file",
    source: "google-drive",
    name: file.name,
    totalFiles: 1,
    attachableFiles: [{
      name: file.name,
      size: file.size,
      mimeType: file.mimeType,
    }],
  };
}

export async function attachGoogleDriveReference(
  fileReference: string,
  policy: AttachmentPolicy = "all",
  range: DriveAttachRange = {},
): Promise<ScanAttachment[]> {
  const fileId = googleDriveFileId(fileReference);
  if (!fileId) {
    throw new Error("Вставте коректне посилання Google Drive або ідентифікатор файлу.");
  }

  const file = await getGoogleDriveFileMetadata(fileId);
  if (file.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    const files = supportedDriveFiles(await listGoogleDriveFolderFiles(file.id), policy);
    const selected = rangeDriveFiles(files, range);
    if (!selected.length) {
      throw new Error("У вибраному діапазоні немає підтримуваних файлів.");
    }
    return selected.map((item) => driveFileToAttachment(item));
  }

  ensureAttachableDriveFile(file, policy);
  return [driveFileToAttachment(file)];
}

function ensureAttachableDriveFile(file: GoogleDriveFileMetadata, policy: AttachmentPolicy): void {
  if (file.mimeType.startsWith("application/vnd.google-apps.")) {
    throw new Error("Файли Google Документів, Таблиць або Презентацій потрібно спершу завантажити як PDF чи зображення.");
  }
  if (!isSupportedAttachmentMetadata(file.name, file.mimeType, policy)) {
    throw new Error(`Формат файлу «${file.name}» не підтримується.`);
  }
  if (policy !== "document" && file.size > MAX_FILE_SIZE) {
    throw new Error(`Файл «${file.name}» перевищує дозволені ${MAX_ATTACHMENT_SIZE_MB} МБ.`);
  }
}

function driveFileToAttachment(file: GoogleDriveFileMetadata): ScanAttachment {
  return {
    id: createId(),
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: nowIso(),
    storage: "google-drive",
    storagePath: file.id,
    webViewLink: file.webViewLink,
    driveMd5Checksum: file.md5Checksum,
    driveModifiedTime: file.modifiedTime,
    driveRevisionId: file.headRevisionId,
    deleteOnRemove: false,
  };
}

function inspectExternalUrlAttachment(
  fileReference: string,
  policy: AttachmentPolicy,
): DriveAttachmentPreview {
  const url = externalDocumentUrl(fileReference);
  const metadata = externalUrlMetadata(url);
  ensureExternalUrlMatchesPolicy(metadata, policy);
  return {
    kind: "file",
    source: "external-url",
    name: metadata.name,
    totalFiles: 1,
    attachableFiles: [{
      name: metadata.name,
      size: 0,
      mimeType: metadata.mimeType,
    }],
  };
}

function externalUrlToAttachment(
  fileReference: string,
  policy: AttachmentPolicy,
): ScanAttachment {
  const url = externalDocumentUrl(fileReference);
  const metadata = externalUrlMetadata(url);
  ensureExternalUrlMatchesPolicy(metadata, policy);
  return {
    id: createId(),
    name: metadata.name,
    mimeType: metadata.mimeType,
    size: 0,
    createdAt: nowIso(),
    storage: "external-url",
    storagePath: url.href,
    webViewLink: url.href,
    deleteOnRemove: false,
  };
}

function supportedDriveFiles(
  files: GoogleDriveFileMetadata[],
  policy: AttachmentPolicy,
): GoogleDriveFileMetadata[] {
  return files.filter((file) => {
    if (file.mimeType.startsWith("application/vnd.google-apps.")) return false;
    if (!isSupportedAttachmentMetadata(file.name, file.mimeType, policy)) return false;
    if (policy !== "document" && file.size > MAX_FILE_SIZE) return false;
    return true;
  });
}

function rangeDriveFiles(
  files: GoogleDriveFileMetadata[],
  range: DriveAttachRange,
): GoogleDriveFileMetadata[] {
  const start = Math.max(1, Math.floor(range.start ?? 1));
  const end = Math.min(files.length, Math.floor(range.end ?? files.length));
  if (end < start) {
    throw new Error("Кінцева сторінка діапазону не може бути меншою за початкову.");
  }
  return files.slice(start - 1, end);
}

export async function getScanBlob(scan: ScanAttachment): Promise<Blob> {
  assertScanAvailable(scan);
  if (scan.storage === "external-url") {
    const target = sanitizeWebUrl(scan.webViewLink || scan.storagePath);
    if (!target) throw new Error("Зовнішнє посилання має некоректний або небезпечний формат.");
    const kind = previewKindFromMetadata(scan.name, scan.mimeType);
    if (kind === "web") {
      return new Blob([externalPreviewHtml(target, scan.name)], { type: "text/html" });
    }

    const cached = await getCachedDocumentBlob(scanBlobCacheKey(scan));
    if (cached) return cached;

    const blob = await fetchExternalDocumentBlob(target, kind);
    await cacheScanBlob(scan, blob).catch(() => undefined);
    return blob;
  }
  if (!scan.storagePath) {
    throw new Error("У файлу відсутній ідентифікатор хмарного сховища.");
  }

  const cached = await getCachedDocumentBlob(scanBlobCacheKey(scan));
  if (cached) return cached;

  const blob = await downloadFileFromGoogleDrive(scan.storagePath);
  await cacheScanBlob(scan, blob).catch(() => undefined);
  return blob;
}

async function fetchExternalDocumentBlob(target: string, kind: ScanPreviewKind): Promise<Blob> {
  if (new URL(target).protocol !== "https:") {
    throw new Error("Для внутрішнього перегляду зовнішніх PDF і зображень підтримуються лише HTTPS-посилання.");
  }

  let response: Response;
  try {
    response = await fetch(target, {
      credentials: "omit",
      mode: "cors",
      headers: {
        Accept: kind === "pdf"
          ? "application/pdf,*/*"
          : kind === "image"
            ? "image/*,*/*"
            : "*/*",
      },
    });
  } catch {
    throw new Error(
      "Браузер не дозволив прочитати файл із цього сайту (CORS) або посилання вже недійсне. Відкрийте джерело в новій вкладці, завантажте зображення вручну й додайте його кнопкою «Додати файли».",
    );
  }

  if (response.status === 401 || response.status === 403) {
    const expiryMessage = externalLinkExpiryMessage(target);
    if (expiryMessage) throw new Error(expiryMessage);
    throw new Error("Файл потребує авторизації на зовнішньому сайті або доступ до нього заборонено.");
  }
  if (response.status === 404) {
    const expiryMessage = externalLinkExpiryMessage(target);
    if (expiryMessage) throw new Error(expiryMessage);
  }
  if (!response.ok) {
    throw new Error(`Не вдалося завантажити зовнішній файл (${response.status}).`);
  }

  const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  const blob = await response.blob();
  const blobType = blob.type.toLocaleLowerCase();

  if (kind === "pdf" && !contentType.includes("pdf") && !blobType.includes("pdf")) {
    throw new Error("Джерело не повернуло PDF-файл для внутрішнього перегляду.");
  }
  if (kind === "image" && !contentType.startsWith("image/") && !blobType.startsWith("image/")) {
    throw new Error("Джерело не повернуло зображення для внутрішнього перегляду.");
  }

  return blob;
}

function externalLinkExpiryMessage(target: string): string {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "";
  }
  const rawExpiry = ["e", "exp", "expires", "expiry", "expiration"]
    .map((key) => url.searchParams.get(key))
    .find((value): value is string => Boolean(value));
  if (!rawExpiry) return "";
  const numeric = Number(rawExpiry);
  const expiryMs = Number.isFinite(numeric)
    ? numeric * (numeric < 10_000_000_000 ? 1000 : 1)
    : Date.parse(rawExpiry);
  if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
    return "Строк дії зовнішнього посилання на фото закінчився. Відкрийте джерело, завантажте фото вручну та додайте його у Google Drive кнопкою «Додати файли».";
  }
  return "Зовнішній сайт відхилив тимчасове посилання на фото. Воно могло стати недійсним раніше зазначеного строку; завантажте фото вручну й додайте його у Google Drive.";
}

async function cacheScanBlob(scan: ScanAttachment, blob: Blob): Promise<void> {
  await putCachedDocumentBlob(scanBlobCacheKey(scan), blob, blob.type || scan.mimeType);
}

function scanBlobCacheKey(scan: ScanAttachment): string {
  if (scan.storage === "google-drive") {
    const version = scan.driveRevisionId
      || scan.driveMd5Checksum
      || scan.driveModifiedTime
      || String(scan.size || scan.createdAt || "unknown");
    return `gdrive:${scan.storagePath}:${version}`;
  }

  const source = scan.webViewLink || scan.storagePath;
  const version = scan.driveModifiedTime || String(scan.size || scan.createdAt || "unknown");
  return `external:${stableHash(source)}:${version}`;
}

export async function getScanPreviewSource(scan: ScanAttachment): Promise<ScanPreviewSource> {
  assertScanAvailable(scan);
  if (scan.storage === "external-url") {
    const target = sanitizeWebUrl(scan.webViewLink || scan.storagePath);
    if (!target) throw new Error("Зовнішнє посилання має некоректний або небезпечний формат.");
    return {
      kind: previewKindFromMetadata(scan.name, scan.mimeType),
      url: target,
      revokeOnClose: false,
    };
  }

  const blob = await getScanBlob(scan);
  return {
    kind: previewKindFromMetadata(scan.name, blob.type || scan.mimeType),
    url: URL.createObjectURL(blob),
    revokeOnClose: true,
  };
}

export async function openScan(scan: ScanAttachment): Promise<void> {
  assertScanAvailable(scan);
  if (scan.storage === "external-url") {
    const target = sanitizeWebUrl(scan.webViewLink || scan.storagePath);
    if (!target) throw new Error("Зовнішнє посилання має некоректний або небезпечний формат.");
    openExternalWindow(target);
    return;
  }
  if (!scan.storagePath) {
    throw new Error("У файлу відсутній ідентифікатор хмарного сховища.");
  }
  // scan.webViewLink can originate from an imported backup, so it must be
  // scheme-checked before window.open() to avoid "javascript:" execution or an
  // open redirect. Fall back to the canonical Drive view URL we build ourselves.
  const target = sanitizeWebUrl(scan.webViewLink) ?? googleDriveViewUrl(scan.storagePath);
  openExternalWindow(target);
}

export async function downloadScan(scan: ScanAttachment): Promise<void> {
  if (scan.storage === "external-url") {
    await openScan(scan);
    return;
  }
  const blob = await getScanBlob(scan);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = scan.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function deleteScanFile(
  scan: ScanAttachment,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!scan.storagePath) return;
  if (scan.deleteOnRemove === false && !options.force) return;
  const storage = String(scan.storage ?? "");

  // Legacy attachments may still point to the former storage provider.
  // Their physical object can no longer be managed by the current provider,
  // but the attachment reference must still be removable from the record.
  if (storage !== "google-drive") return;

  try {
    await deleteFileFromGoogleDrive(scan.storagePath);
  } catch (error) {
    if (isMissingStoredFileError(error)) return;
    throw error;
  }
}

function isGoogleDriveReference(value: string): boolean {
  const input = value.trim();
  if (!input) return false;
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return true;
  try {
    const url = new URL(input);
    const host = url.hostname.toLocaleLowerCase();
    return host === "drive.google.com" || host === "docs.google.com";
  } catch {
    return false;
  }
}

function externalDocumentUrl(fileReference: string): URL {
  const safeUrl = sanitizeWebUrl(fileReference);
  if (!safeUrl) {
    throw new Error("Вставте коректне посилання на документ або сторінку джерела.");
  }
  return new URL(safeUrl);
}

function externalUrlMetadata(url: URL): { name: string; mimeType: string } {
  const extension = urlExtension(url);
  const title = externalUrlTitle(url);
  return {
    name: title,
    mimeType: mimeTypeFromExtension(extension) || "text/html",
  };
}

function externalUrlTitle(url: URL): string {
  const wikiTitle = decodeURIComponent(url.pathname.match(/\/wiki\/(.+)$/)?.[1] ?? "")
    .replace(/_/g, " ")
    .trim();
  if (wikiTitle) return wikiTitle;

  const lastSegment = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "").trim();
  if (lastSegment) return lastSegment;
  return url.hostname.replace(/^www\./, "");
}

function previewKindFromMetadata(name: string, mimeType: string): ScanPreviewKind {
  const normalizedMime = mimeType.toLocaleLowerCase();
  const extension = name.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (normalizedMime === "application/pdf" || extension === "pdf") return "pdf";
  if (normalizedMime.startsWith("image/") || imageExtensions.has(extension)) return "image";
  return "web";
}

function mimeTypeFromExtension(extension: string): string {
  if (!extension) return "";
  if (extension === "pdf") return "application/pdf";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "bmp") return "image/bmp";
  if (extension === "tif" || extension === "tiff") return "image/tiff";
  if (extension === "html" || extension === "htm") return "text/html";
  return "";
}

function urlExtension(url: URL): string {
  const pathExtension = url.pathname.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (pathExtension && pathExtension.length <= 5 && /^[a-z0-9]+$/.test(pathExtension)) return pathExtension;
  return "";
}

function openExternalWindow(target: string): void {
  const opened = window.open(target, "_blank");
  if (!opened) {
    throw new Error("Браузер заблокував відкриття джерела. Дозвольте спливні вікна для цього сайту.");
  }
  opened.opener = null;
}

function externalPreviewHtml(target: string, title: string): string {
  const safeTitle = escapeHtml(title || "Зовнішнє джерело");
  const safeTarget = escapeHtml(target);
  return `<!doctype html>
<html lang="uk">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      html,
      body {
        width: 100%;
        height: 100%;
        margin: 0;
        background: #102f29;
      }

      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: #fff;
      }

      .source-fallback {
        position: absolute;
        right: 16px;
        bottom: 16px;
        z-index: 2;
        border-radius: 8px;
        background: #fff;
        color: #0c332d;
        padding: 10px 14px;
        font: 600 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-decoration: none;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
      }
    </style>
  </head>
  <body>
    <iframe title="${safeTitle}" src="${safeTarget}" sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-scripts" referrerpolicy="no-referrer-when-downgrade"></iframe>
    <a class="source-fallback" href="${safeTarget}" target="_blank" rel="noopener noreferrer">Відкрити джерело</a>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function googleDriveFileId(value: string): string {
  const input = value.trim();
  if (!input) return "";
  const directId = input.match(/^[a-zA-Z0-9_-]{20,}$/)?.[0];
  if (directId) return directId;
  try {
    const url = new URL(input);
    const queryId = url.searchParams.get("id");
    if (queryId) return queryId;
    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileMatch?.[1]) return fileMatch[1];
    const folderMatch = url.pathname.match(/\/folders\/([^/]+)/);
    if (folderMatch?.[1]) return folderMatch[1];
    const documentMatch = url.pathname.match(/\/(?:document|spreadsheets|presentation)\/d\/([^/]+)/);
    if (documentMatch?.[1]) return documentMatch[1];
  } catch {
    // Not a URL; fall through to a permissive extraction attempt.
  }
  return input.match(/[a-zA-Z0-9_-]{20,}/)?.[0] ?? "";
}

function isSupportedAttachmentMetadata(
  name: string,
  mimeType: string,
  policy: AttachmentPolicy,
): boolean {
  const fileLike = { name, type: mimeType } as File;
  return policy === "person-photo"
    ? isSupportedPersonPhoto(fileLike)
    : policy === "finding"
    ? isSupportedFindingAttachment(fileLike)
    : policy === "archive-request"
      ? isSupportedArchiveRequestAttachment(fileLike)
      : isSupportedAttachment(fileLike);
}

function ensureExternalUrlMatchesPolicy(
  metadata: { name: string; mimeType: string },
  policy: AttachmentPolicy,
): void {
  if (policy === "person-photo" && !isSupportedPersonPhoto({
    name: metadata.name,
    type: metadata.mimeType,
  })) {
    throw new Error("Посилання на фото має вести на зображення JPG, PNG, WebP, GIF, BMP, SVG або TIFF.");
  }
}

function assertScanAvailable(scan: ScanAttachment): void {
  if (scan.availability !== "missing-local") return;
  throw new Error(
    scan.statusMessage
      || "Локальний файл із GEDCOM недоступний. Виберіть його вручну та завантажте у Google Drive.",
  );
}

function isMissingStoredFileError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
  return [
    "file not found",
    "object not found",
    "not_found",
    "not found",
    "404",
  ].some((part) => message.toLocaleLowerCase().includes(part));
}

function isSupportedFindingAttachment(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  const textTypes = new Set([
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/rtf",
    "application/rtf",
    "application/json",
    "application/xml",
    "text/xml",
    "text/html",
  ]);
  return (
    file.type.startsWith("image/") ||
    file.type === "application/pdf" ||
    textTypes.has(file.type) ||
    [
      "jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif",
      "pdf", "txt", "md", "rtf", "csv", "json", "xml", "html", "htm",
    ].includes(extension)
  );
}

function isSupportedArchiveRequestAttachment(file: File): boolean {
  const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  return (
    [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ].includes(file.type) ||
    ["pdf", "doc", "docx"].includes(extension)
  );
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
      "pdf", "djvu", "djv", "xps", "doc", "docx", "rtf", "odt",
      "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "txt",
      "md", "xml", "html", "htm", "epub", "mp3", "wav", "m4a",
      "aac", "ogg", "opus", "flac", "wma", "webm",
    ].includes(extension)
  );
}

function isSupportedPersonPhoto(file: Pick<File, "name" | "type">): boolean {
  const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  return file.type.startsWith("image/") || imageExtensions.has(extension);
}
