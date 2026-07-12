import type { ScanAttachment } from "../types";
import type { GedcomImportMediaDraft } from "../types/familyTree";

export interface PersonPhotoState {
  photos: ScanAttachment[];
  primaryPhotoId: string;
}

/** Internal person custom-fields bucket shared by persistence and graph adapters. */
export const PERSON_SCANS_METADATA_KEY = "__trackerRoduPersonScans";

const gedcomImageFormats = new Set([
  "bmp", "gif", "jpeg", "jpg", "png", "svg", "svg+xml", "tif", "tiff", "webp",
]);

export function personPhotoStateFromMetadata(value: unknown): PersonPhotoState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { photos: [], primaryPhotoId: "" };
  }
  const record = value as Record<string, unknown>;
  return normalizePersonPhotoState(
    Array.isArray(record.photos) ? record.photos as ScanAttachment[] : [],
    typeof record.primaryPhotoId === "string" ? record.primaryPhotoId : "",
  );
}

export function personPhotoMetadataForStorage(input: {
  photos?: readonly ScanAttachment[];
  primaryPhotoId?: string;
}): PersonPhotoState {
  return normalizePersonPhotoState(input.photos, input.primaryPhotoId);
}

export function normalizePersonPhotoState(
  photos: readonly ScanAttachment[] | undefined,
  primaryPhotoId: string | undefined,
): PersonPhotoState {
  const normalized = Array.isArray(photos) ? [...photos] : [];
  const selected = normalized.some((photo) => photo.id === primaryPhotoId)
    ? primaryPhotoId ?? ""
    : normalized[0]?.id ?? "";
  return { photos: normalized, primaryPhotoId: selected };
}

export function personPhotosFromGedcomMedia(
  media: readonly GedcomImportMediaDraft[],
  timestamp: string,
  idFactory: () => string,
): PersonPhotoState {
  const sourceItems = media.filter(isGedcomPersonPhotoMedia);
  const photos = sourceItems.map((item) => gedcomMediaPhoto(item, timestamp, idFactory));
  const primaryIndex = sourceItems.findIndex((item) => item.isPrimary || item.isPersonalPhoto);
  return {
    photos,
    primaryPhotoId: photos[primaryIndex >= 0 ? primaryIndex : 0]?.id ?? "",
  };
}

export function isGedcomPersonPhotoMedia(media: GedcomImportMediaDraft): boolean {
  const reference = media.file.trim();
  if (!reference || /^(?:data|blob):/i.test(reference)) return false;
  if (media.isPrimary || media.isPersonalPhoto) return true;
  return Boolean(normalizedImageFormat(media.format, reference));
}

export function isPhotoReferenceAvailable(photo: ScanAttachment | undefined): boolean {
  return Boolean(photo && photo.availability !== "missing-local");
}

export function primaryPersonPhoto(
  photos: readonly ScanAttachment[] | undefined,
  primaryPhotoId: string | undefined,
): ScanAttachment | undefined {
  const state = normalizePersonPhotoState(photos, primaryPhotoId);
  return state.photos.find((photo) => photo.id === state.primaryPhotoId);
}

export function primaryPersonPhotoFromCustomFields(
  customFields: unknown,
): ScanAttachment | undefined {
  if (!customFields || typeof customFields !== "object" || Array.isArray(customFields)) {
    return undefined;
  }
  const metadata = (customFields as Record<string, unknown>)[PERSON_SCANS_METADATA_KEY];
  const state = personPhotoStateFromMetadata(metadata);
  return primaryPersonPhoto(state.photos, state.primaryPhotoId);
}

function gedcomMediaPhoto(
  media: GedcomImportMediaDraft,
  timestamp: string,
  idFactory: () => string,
): ScanAttachment {
  const sourceReference = media.file.trim();
  const remote = /^https?:\/\//i.test(sourceReference);
  const format = normalizedImageFormat(media.format, sourceReference);
  return {
    id: idFactory(),
    name: media.title.trim() || fileNameFromReference(sourceReference),
    mimeType: format ? `image/${format}` : "image/*",
    size: finiteNonNegativeNumber(media.fileSize),
    createdAt: timestamp,
    storage: "external-url",
    storagePath: sourceReference,
    ...(remote ? { webViewLink: sourceReference } : {}),
    deleteOnRemove: false,
    availability: remote ? "available" : "missing-local",
    sourceKind: "gedcom",
    sourceReference,
    ...(remote
      ? {}
      : {
          statusMessage:
            "Локальний файл із GEDCOM недоступний у браузері. Виберіть цей файл вручну, щоб завантажити копію у Google Drive.",
        }),
  };
}

function normalizedImageFormat(formatValue: string, reference: string): string {
  const raw = formatValue.trim().toLowerCase().replace(/^image\//, "").replace(/^\./, "");
  const extension = reference.split(/[\\/?#]/).filter(Boolean).at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
  const format = raw || extension;
  if (format === "jpg") return "jpeg";
  return gedcomImageFormats.has(format) ? format : "";
}

function fileNameFromReference(reference: string): string {
  const encoded = reference.split(/[\\/?#]/).filter(Boolean).at(-1) ?? "gedcom-photo";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function finiteNonNegativeNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
