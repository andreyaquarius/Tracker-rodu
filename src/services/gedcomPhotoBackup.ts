import type { Person, ScanAttachment } from "../types";
import type { ExternalLinkExpiry } from "../utils/externalLinkExpiry.ts";
import { externalLinkExpiry } from "../utils/externalLinkExpiry.ts";
import type { GoogleDriveProjectTarget } from "./googleDriveStorage.ts";

export interface GedcomPhotoBackupCandidate {
  personId: string;
  personName: string;
  photo: ScanAttachment;
  sourceReference: string;
  requestedPrimary: boolean;
  /** Existing matched people may intentionally receive a newly imported source. */
  allowAppend: boolean;
  /** Selected by the user for a local GEDCOM path; never persisted as raw bytes. */
  localFile?: File;
  expiry: ExternalLinkExpiry;
  deduplicationKey: string;
}

export interface GedcomPhotoBackupPlan {
  candidates: GedcomPhotoBackupCandidate[];
  localCandidates: GedcomPhotoBackupCandidate[];
  totalPhotoCount: number;
  personCount: number;
  alreadyStoredCount: number;
  missingLocalCount: number;
  unsupportedHttpCount: number;
  unknownExpiryCount: number;
  knownExpiryCount: number;
  expiredCount: number;
  earliestExpiryAt: string;
}

export interface GedcomPhotoBackupReplacement {
  source: ScanAttachment;
  stored: ScanAttachment;
  requestedPrimary: boolean;
  allowAppend: boolean;
}

export interface GedcomPhotoBackupPersistenceResult {
  appliedSourceReferences: string[];
  person?: Person;
}

export type GedcomPhotoBackupPersistenceHandler = (input: {
  personId: string;
  replacements: GedcomPhotoBackupReplacement[];
}) => Promise<GedcomPhotoBackupPersistenceResult>;

export type GedcomPhotoBackupFailureCode =
  | "expired"
  | "cors"
  | "size"
  | "download"
  | "upload"
  | "persist";

export interface GedcomPhotoBackupFailure {
  candidate: GedcomPhotoBackupCandidate;
  code: GedcomPhotoBackupFailureCode;
  message: string;
}

export interface GedcomPhotoBackupProgress {
  processed: number;
  total: number;
  uploaded: number;
  copied: number;
  failed: number;
  personName: string;
  photoName: string;
}

export interface GedcomPhotoBackupResult {
  requested: number;
  copied: number;
  uploaded: number;
  failures: GedcomPhotoBackupFailure[];
  updatedPersons: Person[];
}

interface GedcomPhotoBackupDependencies {
  loadPhoto?: (candidate: GedcomPhotoBackupCandidate) => Promise<Blob>;
  storePhoto?: (
    candidate: GedcomPhotoBackupCandidate,
    blob: Blob,
    target: GoogleDriveProjectTarget,
  ) => Promise<ScanAttachment>;
}

export function buildGedcomPhotoBackupPlan(
  importedPeople: readonly Person[],
  personIdRemap: Readonly<Record<string, string>> = {},
  canonicalPeople: readonly Person[] = [],
  nowMs = Date.now(),
): GedcomPhotoBackupPlan {
  const canonicalById = new Map(canonicalPeople.map((person) => [person.id, person]));
  const candidates: GedcomPhotoBackupCandidate[] = [];
  const localCandidates: GedcomPhotoBackupCandidate[] = [];
  const seen = new Set<string>();
  const peopleWithPhotos = new Set<string>();
  let alreadyStoredCount = 0;
  let missingLocalCount = 0;
  let unsupportedHttpCount = 0;
  let unknownExpiryCount = 0;
  let knownExpiryCount = 0;
  let expiredCount = 0;
  let earliestExpiryMs = Number.POSITIVE_INFINITY;

  for (const importedPerson of importedPeople) {
    const personId = personIdRemap[importedPerson.id] || importedPerson.id;
    const canonical = canonicalById.get(personId);
    const canonicalSources = new Set(
      (canonical?.photos ?? []).map(photoSourceIdentity).filter(Boolean),
    );
    const durableSources = new Set(
      (canonical?.photos ?? [])
        .filter((photo) => photo.storage === "google-drive")
        .map(photoSourceIdentity)
        .filter(Boolean),
    );
    for (const photo of importedPerson.photos ?? []) {
      if (photo.sourceKind !== "gedcom") continue;
      peopleWithPhotos.add(personId);
      const sourceReference = photo.sourceReference?.trim() || photo.storagePath.trim();
      const identity = photoSourceIdentity(photo);
      const candidateIdentity = `${personId}:${identity}`;
      if (seen.has(candidateIdentity)) continue;
      seen.add(candidateIdentity);
      if (photo.storage === "google-drive" || durableSources.has(identity)) {
        alreadyStoredCount += 1;
        continue;
      }
      if (photo.availability === "missing-local" || !/^https?:\/\//i.test(sourceReference)) {
        missingLocalCount += 1;
        localCandidates.push({
          personId,
          personName: personDisplayName(importedPerson),
          photo,
          sourceReference,
          requestedPrimary: importedPerson.primaryPhotoId === photo.id,
          allowAppend: !canonicalSources.has(identity),
          expiry: { kind: "unknown" },
          deduplicationKey: gedcomPhotoDeduplicationKey(personId, photo, sourceReference),
        });
        continue;
      }
      if (!/^https:\/\//i.test(sourceReference)) {
        unsupportedHttpCount += 1;
        continue;
      }
      const expiry = externalLinkExpiry(sourceReference, nowMs);
      if (expiry.kind === "known") {
        knownExpiryCount += 1;
        if (expiry.expired) expiredCount += 1;
        earliestExpiryMs = Math.min(earliestExpiryMs, Date.parse(expiry.expiresAt));
      } else {
        unknownExpiryCount += 1;
      }
      candidates.push({
        personId,
        personName: personDisplayName(importedPerson),
        photo,
        sourceReference,
        requestedPrimary: importedPerson.primaryPhotoId === photo.id,
        allowAppend: !canonicalSources.has(identity),
        expiry,
        deduplicationKey: gedcomPhotoDeduplicationKey(personId, photo, sourceReference),
      });
    }
  }

  return {
    candidates,
    localCandidates,
    totalPhotoCount:
      candidates.length + alreadyStoredCount + missingLocalCount + unsupportedHttpCount,
    personCount: peopleWithPhotos.size,
    alreadyStoredCount,
    missingLocalCount,
    unsupportedHttpCount,
    unknownExpiryCount,
    knownExpiryCount,
    expiredCount,
    earliestExpiryAt: Number.isFinite(earliestExpiryMs)
      ? new Date(earliestExpiryMs).toISOString()
      : "",
  };
}

export async function backupGedcomPhotosToGoogleDrive(
  plan: GedcomPhotoBackupPlan,
  options: {
    target: GoogleDriveProjectTarget;
    persist: GedcomPhotoBackupPersistenceHandler;
    onProgress?: (progress: GedcomPhotoBackupProgress) => void;
    concurrency?: number;
  },
  dependencies: GedcomPhotoBackupDependencies = {},
): Promise<GedcomPhotoBackupResult> {
  const loadPhoto = dependencies.loadPhoto ?? (async (candidate) => {
    if (candidate.localFile) return candidate.localFile;
    const { getScanBlob } = await import("./scanStorage.ts");
    return getScanBlob(candidate.photo);
  });
  const storePhoto = dependencies.storePhoto ?? defaultStorePhoto;
  const groups = groupCandidatesByPerson(plan.candidates);
  const failures: GedcomPhotoBackupFailure[] = [];
  const updatedPersons: Person[] = [];
  const uploadByKey = new Map<string, Promise<ScanAttachment>>();
  let processed = 0;
  let uploaded = 0;
  let copied = 0;

  const report = (candidate: GedcomPhotoBackupCandidate) => {
    options.onProgress?.({
      processed,
      total: plan.candidates.length,
      uploaded,
      copied,
      failed: failures.length,
      personName: candidate.personName,
      photoName: candidate.photo.name,
    });
  };

  const processGroup = async (group: GedcomPhotoBackupCandidate[]) => {
    const replacements: Array<{
      candidate: GedcomPhotoBackupCandidate;
      replacement: GedcomPhotoBackupReplacement;
    }> = [];
    for (const candidate of group) {
      let blob: Blob;
      try {
        blob = await loadPhoto(candidate);
      } catch (error) {
        failures.push({
          candidate,
          code: photoFailureCode(error, candidate, "download"),
          message: errorMessage(error),
        });
        processed += 1;
        report(candidate);
        continue;
      }
      try {
        let upload = uploadByKey.get(candidate.deduplicationKey);
        if (!upload) {
          upload = storePhoto(candidate, blob, options.target);
          uploadByKey.set(candidate.deduplicationKey, upload);
        }
        const stored = await upload;
        uploaded += 1;
        replacements.push({
          candidate,
          replacement: {
            source: candidate.photo,
            stored: uploadedPhotoReplacement(candidate.photo, stored),
            requestedPrimary: candidate.requestedPrimary,
            allowAppend: candidate.allowAppend,
          },
        });
      } catch (error) {
        failures.push({
          candidate,
          code: photoFailureCode(error, candidate, "upload"),
          message: errorMessage(error),
        });
      } finally {
        processed += 1;
        report(candidate);
      }
    }

    if (!replacements.length) return;
    try {
      const persisted = await options.persist({
        personId: group[0]!.personId,
        replacements: replacements.map((item) => item.replacement),
      });
      const applied = new Set(persisted.appliedSourceReferences.map(normalizedPhotoSource));
      for (const item of replacements) {
        if (applied.has(normalizedPhotoSource(item.candidate.sourceReference))) {
          copied += 1;
        } else {
          failures.push({
            candidate: item.candidate,
            code: "persist",
            message: "Фото не було прив’язане: його запис змінився або був видалений під час копіювання.",
          });
        }
      }
      if (persisted.person) updatedPersons.push(persisted.person);
      report(group[group.length - 1]!);
    } catch (error) {
      for (const item of replacements) {
        failures.push({
          candidate: item.candidate,
          code: "persist",
          message: errorMessage(error),
        });
      }
      report(group[group.length - 1]!);
    }
  };

  await runWorkerPool(
    groups,
    Math.max(1, Math.min(3, Math.floor(options.concurrency ?? 2))),
    processGroup,
  );

  return {
    requested: plan.candidates.length,
    copied,
    uploaded,
    failures,
    updatedPersons,
  };
}

/**
 * Never issue network requests for links whose explicit deadline has elapsed.
 * A user-selected local original remains copyable even when its old source URL
 * is expired.
 */
export function copyableGedcomPhotoBackupPlan(
  plan: GedcomPhotoBackupPlan,
): GedcomPhotoBackupPlan {
  const candidates = plan.candidates.filter((candidate) => (
    Boolean(candidate.localFile)
    || candidate.expiry.kind === "unknown"
    || !candidate.expiry.expired
  ));
  return candidates.length === plan.candidates.length
    ? plan
    : { ...plan, candidates };
}

export function attachLocalGedcomPhotoFiles(
  plan: GedcomPhotoBackupPlan,
  selectedFiles: readonly File[],
): {
  plan: GedcomPhotoBackupPlan;
  matchedCount: number;
  unmatchedCount: number;
} {
  const matchableCandidates = uniquePhotoCandidates([
    ...plan.candidates,
    ...plan.localCandidates,
  ]);
  if (!matchableCandidates.length || !selectedFiles.length) {
    return {
      plan,
      matchedCount: 0,
      unmatchedCount: matchableCandidates.length,
    };
  }
  const files = selectedFiles.map((file) => ({
    file,
    name: normalizeLocalPath(file.name),
    relativePath: normalizeLocalPath(file.webkitRelativePath || file.name),
  }));
  const matchedByKey = new Map<string, GedcomPhotoBackupCandidate>();
  for (const candidate of matchableCandidates) {
    const sourcePath = normalizeLocalPath(candidate.sourceReference);
    const sourceName = sourcePath.split("/").pop() ?? sourcePath;
    const photoName = normalizeLocalPath(candidate.photo.name).split("/").pop() ?? "";
    const externalId = candidate.photo.sourceExternalId?.trim().toLocaleLowerCase("en-US") ?? "";
    const exact = files.filter((item) => (
      sourcePath === item.relativePath
      || sourcePath.endsWith(`/${item.relativePath}`)
      || item.relativePath.endsWith(`/${sourcePath}`)
    ));
    const byName = exact.length ? [] : files.filter((item) => (
      item.name === sourceName || Boolean(photoName && item.name === photoName)
    ));
    const byExternalId = exact.length || byName.length || !externalId
      ? []
      : files.filter((item) => fileStem(item.name) === externalId || fileStem(item.name).includes(externalId));
    const resolved = uniqueFile(exact) ?? uniqueFile(byName) ?? uniqueFile(byExternalId);
    if (!resolved) continue;
    matchedByKey.set(photoCandidateKey(candidate), { ...candidate, localFile: resolved.file });
  }
  const remoteCandidates = plan.candidates.map((candidate) => (
    matchedByKey.get(photoCandidateKey(candidate)) ?? candidate
  ));
  const matchedLocalCandidates = plan.localCandidates
    .map((candidate) => matchedByKey.get(photoCandidateKey(candidate)))
    .filter((candidate): candidate is GedcomPhotoBackupCandidate => Boolean(candidate));
  return {
    plan: {
      ...plan,
      candidates: uniquePhotoCandidates([...remoteCandidates, ...matchedLocalCandidates]),
      missingLocalCount: Math.max(0, plan.localCandidates.length - matchedLocalCandidates.length),
    },
    matchedCount: matchedByKey.size,
    unmatchedCount: Math.max(0, matchableCandidates.length - matchedByKey.size),
  };
}

async function defaultStorePhoto(
  candidate: GedcomPhotoBackupCandidate,
  blob: Blob,
  target: GoogleDriveProjectTarget,
): Promise<ScanAttachment> {
  const { saveScanToProject } = await import("./scanStorage.ts");
  const file = new File([blob], candidate.photo.name || "gedcom-photo", {
    type: blob.type || candidate.photo.mimeType || "image/*",
  });
  return saveScanToProject(target, file, "person-photo", {
    driveFolderPath: gedcomPersonPhotoDriveFolderPath(candidate),
    deduplicationKey: candidate.deduplicationKey,
  });
}

/**
 * Keeps every person's GEDCOM photos in a distinct, readable Drive folder.
 * The stable suffix prevents two people with the same name from sharing one
 * folder without exposing the full internal UUID in the user's Drive.
 */
export function gedcomPersonPhotoDriveFolderPath(
  person: Pick<GedcomPhotoBackupCandidate, "personId" | "personName">,
): string[] {
  const readableName = person.personName.trim().replace(/\s+/g, " ").slice(0, 108)
    || "Особа без імені";
  const stableSuffix = [
    stableHash(person.personId, 2166136261),
    stableHash(person.personId, 3335557771),
  ].join("-");
  return ["Особи", `${readableName} — ${stableSuffix}`, "Фото"];
}

export function applyPersonPhotoBackups(
  person: Person,
  replacements: readonly GedcomPhotoBackupReplacement[],
): GedcomPhotoBackupPersistenceResult & { person: Person } {
  if (!replacements.length) return { person, appliedSourceReferences: [] };
  const photos = [...(person.photos ?? [])];
  const appliedSourceReferences: string[] = [];
  let primaryPhotoId = person.primaryPhotoId ?? "";
  let changed = false;

  for (const replacement of replacements) {
    const sourceReference = replacement.source.sourceReference
      || replacement.source.storagePath;
    const sourceIdentity = normalizedPhotoSource(sourceReference);
    const sourceExternalIdentity = normalizedPhotoExternalId(
      replacement.source.sourceExternalId,
    );
    const existingIndex = photos.findIndex((photo) => {
      const currentSourceIdentity = normalizedPhotoSource(
        photo.sourceReference || photo.storagePath,
      );
      const currentExternalIdentity = normalizedPhotoExternalId(photo.sourceExternalId);
      return (Boolean(sourceExternalIdentity) && currentExternalIdentity === sourceExternalIdentity)
        || currentSourceIdentity === sourceIdentity
        || (!currentSourceIdentity && photo.id === replacement.source.id);
    });
    if (existingIndex >= 0) {
      const existing = photos[existingIndex]!;
      if (existing.storage === "google-drive") {
        appliedSourceReferences.push(sourceReference);
        continue;
      }
      photos[existingIndex] = {
        ...replacement.stored,
        id: existing.id,
        sourceReference: redactExternalPhotoSource(existing.sourceReference || sourceReference),
        sourceExternalId: existing.sourceExternalId || replacement.source.sourceExternalId,
        ...(existing.avatarCrop ? { avatarCrop: existing.avatarCrop } : {}),
      };
      if (replacement.requestedPrimary && !primaryPhotoId) primaryPhotoId = existing.id;
    } else if (replacement.allowAppend) {
      photos.push(replacement.stored);
      if (replacement.requestedPrimary && !primaryPhotoId) primaryPhotoId = replacement.stored.id;
    } else {
      continue;
    }
    appliedSourceReferences.push(sourceReference);
    changed = true;
  }

  if (!changed) return { person, appliedSourceReferences };
  if (!photos.some((photo) => photo.id === primaryPhotoId)) {
    primaryPhotoId = photos[0]?.id ?? "";
  }
  return {
    person: {
      ...person,
      photos,
      primaryPhotoId,
      updatedAt: new Date().toISOString(),
    },
    appliedSourceReferences,
  };
}

function uploadedPhotoReplacement(
  source: ScanAttachment,
  uploaded: ScanAttachment,
): ScanAttachment {
  return {
    ...uploaded,
    id: source.id,
    deleteOnRemove: false,
    availability: "available",
    sourceKind: "gedcom",
    sourceReference: redactExternalPhotoSource(source.sourceReference || source.storagePath),
    sourceExternalId: source.sourceExternalId,
    sourceExpiresAt: source.sourceExpiresAt,
    sourceDurability: source.sourceDurability,
    ...(source.avatarCrop ? { avatarCrop: source.avatarCrop } : {}),
  };
}

function groupCandidatesByPerson(
  candidates: readonly GedcomPhotoBackupCandidate[],
): GedcomPhotoBackupCandidate[][] {
  const groups = new Map<string, GedcomPhotoBackupCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.personId) ?? [];
    group.push(candidate);
    groups.set(candidate.personId, group);
  }
  return [...groups.values()];
}

async function runWorkerPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const run = async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      if (item !== undefined) await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

function photoFailureCode(
  error: unknown,
  candidate: GedcomPhotoBackupCandidate,
  stage: "download" | "upload",
): GedcomPhotoBackupFailureCode {
  const message = errorMessage(error).toLocaleLowerCase("uk-UA");
  if (
    stage === "download"
    && candidate.expiry.kind === "known"
    && candidate.expiry.expired
  ) return "expired";
  if (message.includes("cors") || message.includes("браузер не дозволив")) return "cors";
  if (message.includes("розмір") || message.includes("перевищує дозволені")) return "size";
  return stage;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Невідома помилка копіювання фото.";
}

function photoSourceIdentity(photo: ScanAttachment): string {
  const externalIdentity = normalizedPhotoExternalId(photo.sourceExternalId);
  if (externalIdentity) return `external:${externalIdentity}`;
  return normalizedPhotoSource(photo.sourceReference || photo.storagePath);
}

function normalizedPhotoExternalId(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

export function normalizedPhotoSource(value: string): string {
  const trimmed = redactExternalPhotoSource(value);
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.searchParams.sort();
    return url.href;
  } catch {
    return trimmed;
  }
}

const sensitivePhotoQueryKeys = new Set([
  "access_token",
  "auth",
  "authorization",
  "e",
  "exp",
  "expiration",
  "expire",
  "expires",
  "expiry",
  "googleaccessid",
  "key-pair-id",
  "policy",
  "se",
  "sig",
  "signature",
  "token",
]);

export function redactExternalPhotoSource(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    for (const key of [...url.searchParams.keys()]) {
      const normalizedKey = key.toLocaleLowerCase("en-US");
      if (
        sensitivePhotoQueryKeys.has(normalizedKey)
        || normalizedKey.startsWith("x-amz-")
        || normalizedKey.startsWith("x-goog-")
      ) {
        url.searchParams.delete(key);
      }
    }
    url.hash = "";
    return url.href;
  } catch {
    return trimmed;
  }
}

function gedcomPhotoDeduplicationKey(
  personId: string,
  photo: ScanAttachment,
  sourceReference: string,
): string {
  const externalIdentity = normalizedPhotoExternalId(photo.sourceExternalId);
  const identity = externalIdentity
    ? `external:${externalIdentity}`
    : normalizedPhotoSource(sourceReference);
  const scopedIdentity = `${personId}:${identity}`;
  return `gedcom-photo-${stableHash(scopedIdentity, 2166136261)}-${stableHash(scopedIdentity, 3335557771)}`;
}

function stableHash(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function personDisplayName(person: Person): string {
  return person.fullName.trim()
    || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")
    || "Особа без імені";
}

function normalizeLocalPath(value: string): string {
  return value
    .trim()
    .replace(/^file:\/+/i, "")
    .replace(/\\+/g, "/")
    .replace(/^\/+/, "")
    .toLocaleLowerCase("en-US");
}

function fileStem(value: string): string {
  const lastDot = value.lastIndexOf(".");
  return (lastDot > 0 ? value.slice(0, lastDot) : value).toLocaleLowerCase("en-US");
}

function uniqueFile<T extends { file: File }>(matches: T[]): T | null {
  return matches.length === 1 ? matches[0]! : null;
}

function photoCandidateKey(candidate: GedcomPhotoBackupCandidate): string {
  return `${candidate.personId}:${candidate.deduplicationKey}`;
}

function uniquePhotoCandidates(
  candidates: readonly GedcomPhotoBackupCandidate[],
): GedcomPhotoBackupCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = photoCandidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
