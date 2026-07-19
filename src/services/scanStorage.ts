import type { ScanAttachment } from "../types/index.ts";
import { createId } from "../utils/id.ts";
import { sanitizeWebUrl } from "../utils/safeUrl.ts";
import { nowIso } from "../utils/dateHelpers.ts";
import { externalLinkExpiry } from "../utils/externalLinkExpiry.ts";
import {
  getCachedDocumentBlob,
  putCachedDocumentBlob,
} from "./documentBlobCache.ts";
import {
  deleteFileFromGoogleDrive,
  downloadFileFromGoogleDrive,
  getGoogleDriveFileMetadata,
  googleDriveViewUrl,
  listGoogleDriveFolderFiles,
  uploadFileToGoogleDrive,
  type GoogleDriveFileMetadata,
  type GoogleDrivePickerFile,
  type GoogleDriveUploadProgress,
} from "./googleDriveStorage.ts";
import {
  fetchGedcomPhotoViaProxy,
  isGedcomPhotoProxyUrl,
} from "./gedcomPhotoProxy.ts";

export const MAX_ATTACHMENT_SIZE_MB = 25;
export type AttachmentPolicy = "all" | "finding" | "archive-request" | "document" | "person-photo";
const MAX_FILE_SIZE = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;
const MAX_EXTERNAL_DOCUMENT_SIZE = 100 * 1024 * 1024;
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
  deduplicationKey?: string;
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
  if (!activeProject) {
    throw new Error("Спочатку виберіть проєкт.");
  }
  if (!activeProjectCanUpload) {
    throw new Error("У цьому проєкті можна редагувати й видаляти наявні файли, але додавання нових файлів заблоковане поточним тарифом.");
  }
  return saveScanToProject(activeProject, file, policy, options);
}

export async function saveScanToProject(
  target: { projectId: string; projectName: string },
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
  const id = createId();
  const uploaded = await uploadFileToGoogleDrive(target, file, id, {
    folderPath: options.driveFolderPath,
    deduplicationKey: options.deduplicationKey,
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
  const reference = googleDriveReference(fileReference);
  if (!reference) {
    throw new Error("Вставте коректне посилання Google Drive або ідентифікатор файлу.");
  }

  const file = await getGoogleDriveFileMetadata(reference.id, reference.resourceKey);
  if (file.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    const files = supportedDriveFiles(
      await listGoogleDriveFolderFiles(file.id, file.resourceKey || reference.resourceKey),
      policy,
    );
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
  const reference = googleDriveReference(fileReference);
  if (!reference) {
    throw new Error("Вставте коректне посилання Google Drive або ідентифікатор файлу.");
  }

  const file = await getGoogleDriveFileMetadata(reference.id, reference.resourceKey);
  if (file.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
    const files = supportedDriveFiles(
      await listGoogleDriveFolderFiles(file.id, file.resourceKey || reference.resourceKey),
      policy,
    );
    const selected = rangeDriveFiles(files, range);
    if (!selected.length) {
      throw new Error("У вибраному діапазоні немає підтримуваних файлів.");
    }
    return selected.map((item) => driveFileToAttachment(item));
  }

  ensureAttachableDriveFile(file, policy);
  return [driveFileToAttachment(file)];
}

export async function attachPickedGoogleDriveFiles(
  selectedFiles: GoogleDrivePickerFile[],
  policy: AttachmentPolicy = "all",
): Promise<ScanAttachment[]> {
  const attached: ScanAttachment[] = [];
  for (const selectedFile of selectedFiles) {
    const metadata = await getGoogleDriveFileMetadata(
      selectedFile.id,
      selectedFile.resourceKey,
    );
    const file: GoogleDriveFileMetadata = {
      ...metadata,
      name: metadata.name || selectedFile.name,
      mimeType: metadata.mimeType || selectedFile.mimeType,
      size: metadata.size || selectedFile.size,
      webViewLink: metadata.webViewLink || selectedFile.webViewLink,
      resourceKey: metadata.resourceKey || selectedFile.resourceKey,
    };
    ensureAttachableDriveFile(file, policy);
    attached.push(driveFileToAttachment(file));
  }
  return attached;
}

function ensureAttachableDriveFile(file: GoogleDriveFileMetadata, policy: AttachmentPolicy): void {
  if (isGoogleWorkspaceDriveFile(file.mimeType)) {
    if (policy === "document") return;
    throw new Error("Файли Google Документів, Таблиць або Презентацій можна прикріплювати в модулі «Документи».");
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
    driveResourceKey: file.resourceKey,
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
    if (isGoogleWorkspaceDriveFile(file.mimeType)) return policy === "document";
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
  if (isGoogleWorkspaceDriveFile(scan.mimeType)) {
    throw new Error("Google Документ відкривається та редагується безпосередньо у Google Drive.");
  }
  if (scan.storage === "external-url") {
    const target = sanitizeWebUrl(scan.webViewLink || scan.storagePath);
    if (!target) throw new Error("Зовнішнє посилання має некоректний або небезпечний формат.");
    const kind = previewKindFromMetadata(scan.name, scan.mimeType);
    if (kind === "web") {
      return new Blob([externalPreviewHtml(target, scan.name)], { type: "text/html" });
    }

    const cacheIdentity = scanBlobCacheIdentity(scan);
    const cached = await getCachedDocumentBlob(scanBlobCacheKey(scan), cacheIdentity);
    if (cached) return cached;

    const blob = await fetchExternalDocumentBlob(target, kind);
    await cacheScanBlob(scan, blob).catch(() => undefined);
    return blob;
  }
  if (!scan.storagePath) {
    throw new Error("У файлу відсутній ідентифікатор хмарного сховища.");
  }

  const cacheIdentity = scanBlobCacheIdentity(scan);
  const cached = await getCachedDocumentBlob(scanBlobCacheKey(scan), cacheIdentity);
  if (cached) return cached;

  const blob = await downloadFileFromGoogleDrive(scan.storagePath, scan.driveResourceKey);
  await cacheScanBlob(scan, blob).catch(() => undefined);
  return blob;
}

async function fetchExternalDocumentBlob(target: string, kind: ScanPreviewKind): Promise<Blob> {
  if (new URL(target).protocol !== "https:") {
    throw new Error("Для внутрішнього перегляду зовнішніх PDF і зображень підтримуються лише HTTPS-посилання.");
  }

  if (kind === "image" && isGedcomPhotoProxyUrl(target)) {
    return fetchGedcomPhotoViaProxy(target);
  }

  let response: Response;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 30_000);
  try {
    response = await fetch(target, {
      credentials: "omit",
      mode: "cors",
      signal: controller.signal,
      headers: {
        Accept: kind === "pdf"
          ? "application/pdf,*/*"
          : kind === "image"
            ? "image/*,*/*"
            : "*/*",
      },
    });
  } catch (error) {
    window.clearTimeout(timeoutId);
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Зовнішній сайт не відповів за 30 секунд. Спробуйте ще раз або додайте фото вручну.");
    }
    throw new Error(
      "Браузер не дозволив прочитати файл із цього сайту (CORS) або посилання вже недійсне. Відкрийте джерело в новій вкладці, завантажте зображення вручну й додайте його кнопкою «Додати файли».",
    );
  }

  try {
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
    const maxBytes = kind === "image" ? MAX_FILE_SIZE : MAX_EXTERNAL_DOCUMENT_SIZE;
    const blob = await readBoundedResponseBlob(response, maxBytes);
    const blobType = blob.type.toLocaleLowerCase();

    if (kind === "pdf" && !contentType.includes("pdf") && !blobType.includes("pdf")) {
      throw new Error("Джерело не повернуло PDF-файл для внутрішнього перегляду.");
    }
    if (kind === "image" && !contentType.startsWith("image/") && !blobType.startsWith("image/")) {
      throw new Error("Джерело не повернуло зображення для внутрішнього перегляду.");
    }

    return blob;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Зовнішній сайт не передав файл за 30 секунд. Спробуйте ще раз або додайте фото вручну.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function readBoundedResponseBlob(response: Response, maxBytes: number): Promise<Blob> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new Error(`Зовнішній файл перевищує дозволені ${Math.round(maxBytes / 1024 / 1024)} МБ.`);
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      throw new Error(`Зовнішній файл перевищує дозволені ${Math.round(maxBytes / 1024 / 1024)} МБ.`);
    }
    return blob;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("size-limit").catch(() => undefined);
        throw new Error(`Зовнішній файл перевищує дозволені ${Math.round(maxBytes / 1024 / 1024)} МБ.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, {
    type: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
  });
}

function externalLinkExpiryMessage(target: string): string {
  const expiry = externalLinkExpiry(target);
  if (expiry.kind === "unknown") return "";
  if (expiry.expired) {
    return "Строк дії зовнішнього посилання на фото закінчився. Відкрийте джерело, завантажте фото вручну та додайте його у Google Drive кнопкою «Додати файли».";
  }
  return "Зовнішній сайт відхилив тимчасове посилання на фото. Воно могло стати недійсним раніше зазначеного строку; завантажте фото вручну й додайте його у Google Drive.";
}

async function cacheScanBlob(scan: ScanAttachment, blob: Blob): Promise<void> {
  await putCachedDocumentBlob(
    scanBlobCacheKey(scan),
    blob,
    blob.type || scan.mimeType,
    scanBlobCacheIdentity(scan),
  );
}

export function scanBlobCacheKey(scan: ScanAttachment): string {
  const identity = scanBlobCacheIdentity(scan);
  if (scan.storage === "google-drive") return identity;
  return `external:v2:${stableHash(identity, 2166136261)}:${stableHash(identity, 3335557771)}:${stableHash(identity, 2654435761)}:${stableHash(identity, 2246822519)}`;
}

function scanBlobCacheIdentity(scan: ScanAttachment): string {
  if (scan.storage === "google-drive") {
    const version = scan.driveRevisionId
      || scan.driveMd5Checksum
      || scan.driveModifiedTime
      || String(scan.size || scan.createdAt || "unknown");
    return `gdrive:${scan.storagePath}:${version}`;
  }
  const source = scan.webViewLink || scan.storagePath;
  const version = scan.driveModifiedTime || String(scan.size || scan.createdAt || "unknown");
  return `external:${source}:${version}`;
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
  const target = sanitizeWebUrl(scan.webViewLink)
    ?? googleDriveViewUrl(scan.storagePath, scan.driveResourceKey);
  openExternalWindow(target);
}

export async function downloadScan(scan: ScanAttachment): Promise<void> {
  if (scan.storage === "external-url" || isGoogleWorkspaceDriveFile(scan.mimeType)) {
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
  _options: { force?: boolean } = {},
): Promise<void> {
  if (!scan.storagePath) return;
  // A file explicitly selected through Google Picker belongs to the user.
  // Removing its link from Tracker Rodu must never delete the Drive original.
  if (scan.deleteOnRemove === false) return;
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

function stableHash(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function googleDriveReference(value: string): { id: string; resourceKey?: string } | null {
  const input = value.trim();
  if (!input) return null;
  const directId = input.match(/^[a-zA-Z0-9_-]{20,}$/)?.[0];
  if (directId) return { id: directId };
  try {
    const url = new URL(input);
    const resourceKey = url.searchParams.get("resourcekey")
      || url.searchParams.get("resourceKey")
      || undefined;
    const queryId = url.searchParams.get("id");
    if (queryId) return { id: queryId, resourceKey };
    const fileMatch = url.pathname.match(/\/file\/d\/([^/]+)/);
    if (fileMatch?.[1]) return { id: fileMatch[1], resourceKey };
    const folderMatch = url.pathname.match(/\/folders\/([^/]+)/);
    if (folderMatch?.[1]) return { id: folderMatch[1], resourceKey };
    const documentMatch = url.pathname.match(/\/(?:document|spreadsheets|presentation)\/d\/([^/]+)/);
    if (documentMatch?.[1]) return { id: documentMatch[1], resourceKey };
  } catch {
    // Not a URL; fall through to a permissive extraction attempt.
  }
  const extractedId = input.match(/[a-zA-Z0-9_-]{20,}/)?.[0];
  return extractedId ? { id: extractedId } : null;
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

export function isGoogleWorkspaceDriveFile(mimeType: string | undefined): boolean {
  return Boolean(
    mimeType
    && mimeType !== GOOGLE_FOLDER_MIME_TYPE
    && mimeType.startsWith("application/vnd.google-apps."),
  );
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
