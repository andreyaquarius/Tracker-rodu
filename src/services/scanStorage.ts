import type { ScanAttachment } from "../types";
import { createId } from "../utils/id";
import { nowIso } from "../utils/dateHelpers";
import {
  deleteFileFromGoogleDrive,
  downloadFileFromGoogleDrive,
  googleDriveViewUrl,
  uploadFileToGoogleDrive,
} from "./googleDriveStorage";

export const MAX_ATTACHMENT_SIZE_MB = 25;
export type AttachmentPolicy = "all" | "finding" | "archive-request";
const MAX_FILE_SIZE = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;

let activeProject: { projectId: string; projectName: string } | null = null;

export function setProjectAttachmentTarget(
  projectId: string | null,
  projectName = "",
): void {
  activeProject = projectId
    ? { projectId, projectName: projectName.trim() || "Трекер Роду" }
    : null;
}

export async function saveScan(
  file: File,
  policy: AttachmentPolicy = "all",
): Promise<ScanAttachment> {
  const supported =
    policy === "finding"
      ? isSupportedFindingAttachment(file)
      : policy === "archive-request"
        ? isSupportedArchiveRequestAttachment(file)
        : isSupportedAttachment(file);
  if (!supported) {
    throw new Error(`Формат файлу «${file.name}» не підтримується.`);
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`Файл «${file.name}» перевищує дозволені ${MAX_ATTACHMENT_SIZE_MB} МБ.`);
  }
  if (!activeProject) {
    throw new Error("Спочатку виберіть проєкт.");
  }

  const id = createId();
  const uploaded = await uploadFileToGoogleDrive(activeProject, file, id);
  return {
    id,
    name: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    createdAt: nowIso(),
    storage: "google-drive",
    storagePath: uploaded.id,
    webViewLink: uploaded.webViewLink,
  };
}

export async function getScanBlob(scan: ScanAttachment): Promise<Blob> {
  if (!scan.storagePath) {
    throw new Error("У файлу відсутній ідентифікатор Google Drive.");
  }
  return downloadFileFromGoogleDrive(scan.storagePath);
}

export async function openScan(scan: ScanAttachment): Promise<void> {
  if (!scan.storagePath) {
    throw new Error("У файлу відсутній ідентифікатор Google Drive.");
  }
  const opened = window.open(
    scan.webViewLink || googleDriveViewUrl(scan.storagePath),
    "_blank",
  );
  if (!opened) {
    throw new Error("Браузер заблокував відкриття файлу. Дозвольте спливні вікна.");
  }
  opened.opener = null;
}

export async function downloadScan(scan: ScanAttachment): Promise<void> {
  const blob = await getScanBlob(scan);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = scan.name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function deleteScanFile(scan: ScanAttachment): Promise<void> {
  if (!scan.storagePath) return;
  const storage = String(scan.storage ?? "");

  // Legacy attachments may still point to the former Supabase Storage.
  // Their physical object can no longer be managed by the Google Drive provider,
  // but the attachment reference must still be removable from the record.
  if (storage !== "google-drive") return;

  try {
    await deleteFileFromGoogleDrive(scan.storagePath);
  } catch (error) {
    if (isMissingStoredFileError(error)) return;
    throw error;
  }
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
