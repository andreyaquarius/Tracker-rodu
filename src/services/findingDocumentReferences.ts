import type { DocumentSourceFingerprint } from "./document-sources/contracts.ts";
import { normalizeExternalDocumentUrl } from "../utils/documentSourceUrlSecurity.ts";

export type FindingDocumentReferenceSnapshotProvider = "google_drive" | "external";
export type FindingDocumentReferenceSnapshotMimeType =
  | "image/png"
  | "image/jpeg"
  | "application/pdf";

/**
 * Page-space selection from the external PDF specification. Page indexes are
 * one-based in the application domain; coordinates are independent of the
 * current viewer zoom and canvas size.
 */
export interface NormalizedPageSelection {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  sourcePageWidthPt?: number;
  sourcePageHeightPt?: number;
}

export interface NormalizedPageSelectionInput {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  sourcePageWidthPt?: number;
  sourcePageHeightPt?: number;
}

export type FindingDocumentSnapshotReference =
  | {
      provider: "google_drive";
      fileId: string;
      url?: string;
      mimeType?: FindingDocumentReferenceSnapshotMimeType;
    }
  | {
      provider: "external";
      url: string;
      fileId?: string;
      mimeType?: FindingDocumentReferenceSnapshotMimeType;
    };

export interface FindingDocumentReference {
  id: string;
  projectId: string;
  findingId: string;
  documentId: string;
  documentSourceId: string;
  pageIndex: number;
  pageLabel?: string;
  selection?: NormalizedPageSelection;
  /** Immutable version information captured at finding creation time. */
  sourceFingerprint: DocumentSourceFingerprint;
  snapshot?: FindingDocumentSnapshotReference;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFindingDocumentReferenceInput {
  findingId: string;
  documentId: string;
  documentSourceId: string;
  pageIndex: number;
  pageLabel?: string;
  selection?: NormalizedPageSelectionInput;
  sourceFingerprint: DocumentSourceFingerprint;
  snapshot?: FindingDocumentSnapshotReference;
}

export interface UpdateFindingDocumentReferenceInput {
  id: string;
  /**
   * A page change is atomic with its crop. Omitting `selection` clears a crop
   * that belonged to the previous page. A crop cannot be patched without its
   * one-based page index.
   */
  pageIndex?: number;
  pageLabel?: string | null;
  selection?: NormalizedPageSelectionInput | null;
  snapshot?: FindingDocumentSnapshotReference | null;
}

export type SaveFindingDocumentReferenceInput =
  | CreateFindingDocumentReferenceInput
  | UpdateFindingDocumentReferenceInput;

export interface FindingDocumentReferenceFilters {
  findingId?: string;
  documentId?: string;
  documentSourceId?: string;
}

export type FindingDocumentReferenceValidationCode =
  | "MISSING_IDENTIFIER"
  | "INVALID_PAGE_INDEX"
  | "INVALID_SELECTION"
  | "INVALID_FINGERPRINT"
  | "INVALID_SNAPSHOT";

export class FindingDocumentReferenceValidationError extends Error {
  readonly code: FindingDocumentReferenceValidationCode;

  constructor(code: FindingDocumentReferenceValidationCode, message: string) {
    super(message);
    this.name = "FindingDocumentReferenceValidationError";
    this.code = code;
  }
}

type FindingDocumentReferenceRow = {
  id: string;
  project_id: string;
  finding_id: string;
  document_id: string;
  document_source_id: string;
  page_index: number;
  page_label: string | null;
  selection: unknown;
  source_fingerprint: unknown;
  snapshot_provider: FindingDocumentReferenceSnapshotProvider | null;
  snapshot_file_id: string | null;
  snapshot_url: string | null;
  snapshot_mime_type: string | null;
  created_at: string;
  updated_at: string;
};

type FindingDocumentReferenceInsertRow = Omit<
  FindingDocumentReferenceRow,
  "id" | "created_at" | "updated_at"
>;

type FindingDocumentReferenceUpdateRow = Partial<Pick<
  FindingDocumentReferenceRow,
  | "page_index"
  | "page_label"
  | "selection"
  | "snapshot_provider"
  | "snapshot_file_id"
  | "snapshot_url"
  | "snapshot_mime_type"
>>;

/** Data boundary kept injectable so query scoping and normalization are testable. */
export interface FindingDocumentReferenceStore {
  list(
    projectId: string,
    filters: FindingDocumentReferenceFilters,
  ): Promise<readonly FindingDocumentReferenceRow[]>;
  get(projectId: string, id: string): Promise<FindingDocumentReferenceRow | null>;
  insert(row: FindingDocumentReferenceInsertRow): Promise<FindingDocumentReferenceRow>;
  update(
    projectId: string,
    id: string,
    patch: FindingDocumentReferenceUpdateRow,
  ): Promise<FindingDocumentReferenceRow>;
  remove(projectId: string, id: string): Promise<void>;
}

export interface FindingDocumentReferenceService {
  list(
    projectId: string,
    filters?: FindingDocumentReferenceFilters,
  ): Promise<FindingDocumentReference[]>;
  get(projectId: string, id: string): Promise<FindingDocumentReference | null>;
  create(
    projectId: string,
    input: CreateFindingDocumentReferenceInput,
  ): Promise<FindingDocumentReference>;
  update(
    projectId: string,
    input: UpdateFindingDocumentReferenceInput,
  ): Promise<FindingDocumentReference>;
  save(
    projectId: string,
    input: SaveFindingDocumentReferenceInput,
  ): Promise<FindingDocumentReference>;
  remove(projectId: string, id: string): Promise<void>;
}

const FINDING_DOCUMENT_REFERENCE_SELECT = [
  "id",
  "project_id",
  "finding_id",
  "document_id",
  "document_source_id",
  "page_index",
  "page_label",
  "selection",
  "source_fingerprint",
  "snapshot_provider",
  "snapshot_file_id",
  "snapshot_url",
  "snapshot_mime_type",
  "created_at",
  "updated_at",
].join(", ");

const FINGERPRINT_STRING_KEYS = [
  "sha1",
  "md5",
  "etag",
  "revisionId",
  "modifiedTime",
  "lastModified",
] as const;
const ALLOWED_ROTATIONS = new Set([0, 90, 180, 270]);
const ALLOWED_SNAPSHOT_MIME_TYPES = new Set<FindingDocumentReferenceSnapshotMimeType>([
  "image/png",
  "image/jpeg",
  "application/pdf",
]);
const MAX_PAGE_LABEL_LENGTH = 256;
const MAX_FINGERPRINT_VALUE_LENGTH = 1_024;
const MAX_SNAPSHOT_REFERENCE_LENGTH = 2_048;
const NORMALIZED_PRECISION = 8;

export function createFindingDocumentReferenceService(
  store: FindingDocumentReferenceStore,
): FindingDocumentReferenceService {
  const service: FindingDocumentReferenceService = {
    async list(projectId, filters = {}) {
      const scopedProjectId = requiredIdentifier(projectId);
      const normalizedFilters = normalizeFilters(filters);
      const rows = await store.list(scopedProjectId, normalizedFilters);
      return rows.map(findingDocumentReferenceFromRow);
    },

    async get(projectId, id) {
      const row = await store.get(requiredIdentifier(projectId), requiredIdentifier(id));
      return row ? findingDocumentReferenceFromRow(row) : null;
    },

    async create(projectId, input) {
      const row = createInputToRow(requiredIdentifier(projectId), input);
      return findingDocumentReferenceFromRow(await store.insert(row));
    },

    async update(projectId, input) {
      const scopedProjectId = requiredIdentifier(projectId);
      const id = requiredIdentifier(input.id);
      const patch = updateInputToRow(input);
      return findingDocumentReferenceFromRow(await store.update(scopedProjectId, id, patch));
    },

    async save(projectId, input) {
      return "id" in input
        ? service.update(projectId, input)
        : service.create(projectId, input);
    },

    async remove(projectId, id) {
      await store.remove(requiredIdentifier(projectId), requiredIdentifier(id));
    },
  };
  return service;
}

const defaultService = createFindingDocumentReferenceService(createSupabaseStore());

export function listFindingDocumentReferences(
  projectId: string,
  filters: FindingDocumentReferenceFilters = {},
): Promise<FindingDocumentReference[]> {
  return defaultService.list(projectId, filters);
}

export function getFindingDocumentReference(
  projectId: string,
  id: string,
): Promise<FindingDocumentReference | null> {
  return defaultService.get(projectId, id);
}

export function createFindingDocumentReference(
  projectId: string,
  input: CreateFindingDocumentReferenceInput,
): Promise<FindingDocumentReference> {
  return defaultService.create(projectId, input);
}

export function updateFindingDocumentReference(
  projectId: string,
  input: UpdateFindingDocumentReferenceInput,
): Promise<FindingDocumentReference> {
  return defaultService.update(projectId, input);
}

export function saveFindingDocumentReference(
  projectId: string,
  input: SaveFindingDocumentReferenceInput,
): Promise<FindingDocumentReference> {
  return defaultService.save(projectId, input);
}

export function deleteFindingDocumentReference(
  projectId: string,
  id: string,
): Promise<void> {
  return defaultService.remove(projectId, id);
}

export function normalizeFindingPageSelection(
  selection: NormalizedPageSelectionInput,
  expectedPageIndex = selection.pageIndex,
): NormalizedPageSelection {
  const pageIndex = normalizedPageIndex(selection.pageIndex);
  if (pageIndex !== normalizedPageIndex(expectedPageIndex)) {
    throw validationError("INVALID_SELECTION", "Сторінка виділення не збігається зі сторінкою знахідки.");
  }
  if (!ALLOWED_ROTATIONS.has(selection.rotation)) {
    throw validationError("INVALID_SELECTION", "Поворот виділення має бути 0, 90, 180 або 270 градусів.");
  }

  const x = normalizedUnit(selection.x, "x");
  const y = normalizedUnit(selection.y, "y");
  const width = normalizedPositiveUnit(selection.width, "width");
  const height = normalizedPositiveUnit(selection.height, "height");
  if (x + width > 1 + Number.EPSILON || y + height > 1 + Number.EPSILON) {
    throw validationError("INVALID_SELECTION", "Виділення виходить за межі сторінки.");
  }

  return {
    pageIndex,
    x: roundedNormalized(x),
    y: roundedNormalized(y),
    width: roundedNormalized(width),
    height: roundedNormalized(height),
    rotation: selection.rotation as NormalizedPageSelection["rotation"],
    ...(selection.sourcePageWidthPt !== undefined
      ? { sourcePageWidthPt: normalizedPageDimension(selection.sourcePageWidthPt, "sourcePageWidthPt") }
      : {}),
    ...(selection.sourcePageHeightPt !== undefined
      ? { sourcePageHeightPt: normalizedPageDimension(selection.sourcePageHeightPt, "sourcePageHeightPt") }
      : {}),
  };
}

function createInputToRow(
  projectId: string,
  input: CreateFindingDocumentReferenceInput,
): FindingDocumentReferenceInsertRow {
  const pageIndex = normalizedPageIndex(input.pageIndex);
  const snapshot = normalizeSnapshot(input.snapshot);
  return {
    project_id: projectId,
    finding_id: requiredIdentifier(input.findingId),
    document_id: requiredIdentifier(input.documentId),
    document_source_id: requiredIdentifier(input.documentSourceId),
    page_index: pageIndex,
    page_label: normalizeOptionalText(input.pageLabel, MAX_PAGE_LABEL_LENGTH),
    selection: input.selection
      ? normalizeFindingPageSelection(input.selection, pageIndex)
      : null,
    source_fingerprint: normalizeSourceFingerprint(input.sourceFingerprint),
    ...snapshotToColumns(snapshot),
  };
}

function updateInputToRow(
  input: UpdateFindingDocumentReferenceInput,
): FindingDocumentReferenceUpdateRow {
  const patch: FindingDocumentReferenceUpdateRow = {};
  if (input.pageIndex !== undefined) {
    const pageIndex = normalizedPageIndex(input.pageIndex);
    patch.page_index = pageIndex;
    patch.selection = input.selection
      ? normalizeFindingPageSelection(input.selection, pageIndex)
      : null;
  } else if ("selection" in input) {
    throw validationError(
      "INVALID_SELECTION",
      "Для зміни або очищення виділення потрібно передати номер сторінки.",
    );
  }
  if ("pageLabel" in input) {
    patch.page_label = normalizeOptionalText(input.pageLabel, MAX_PAGE_LABEL_LENGTH);
  }
  if ("snapshot" in input) {
    Object.assign(patch, snapshotToColumns(normalizeSnapshot(input.snapshot)));
  }
  return patch;
}

function findingDocumentReferenceFromRow(row: FindingDocumentReferenceRow): FindingDocumentReference {
  const projectId = requiredIdentifier(row.project_id);
  const pageIndex = normalizedPageIndex(row.page_index);
  const selection = row.selection === null || row.selection === undefined
    ? undefined
    : normalizeFindingPageSelection(selectionInputFromUnknown(row.selection), pageIndex);
  const snapshot = snapshotFromRow(row);
  return {
    id: requiredIdentifier(row.id),
    projectId,
    findingId: requiredIdentifier(row.finding_id),
    documentId: requiredIdentifier(row.document_id),
    documentSourceId: requiredIdentifier(row.document_source_id),
    pageIndex,
    ...(row.page_label ? { pageLabel: row.page_label } : {}),
    ...(selection ? { selection } : {}),
    sourceFingerprint: normalizeSourceFingerprint(row.source_fingerprint),
    ...(snapshot ? { snapshot } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectionInputFromUnknown(value: unknown): NormalizedPageSelectionInput {
  if (!isRecord(value)) {
    throw validationError("INVALID_SELECTION", "Збережене виділення має некоректний формат.");
  }
  return {
    pageIndex: numberField(value.pageIndex),
    x: numberField(value.x),
    y: numberField(value.y),
    width: numberField(value.width),
    height: numberField(value.height),
    rotation: numberField(value.rotation),
    ...(value.sourcePageWidthPt !== undefined
      ? { sourcePageWidthPt: numberField(value.sourcePageWidthPt) }
      : {}),
    ...(value.sourcePageHeightPt !== undefined
      ? { sourcePageHeightPt: numberField(value.sourcePageHeightPt) }
      : {}),
  };
}

function normalizeSourceFingerprint(value: unknown): DocumentSourceFingerprint {
  if (!isRecord(value)) {
    throw validationError("INVALID_FINGERPRINT", "Fingerprint джерела має некоректний формат.");
  }
  const fingerprint: DocumentSourceFingerprint = {};
  for (const key of FINGERPRINT_STRING_KEYS) {
    const current = value[key];
    if (current === undefined || current === null || current === "") continue;
    if (typeof current !== "string" || current.length > MAX_FINGERPRINT_VALUE_LENGTH) {
      throw validationError("INVALID_FINGERPRINT", `Некоректне поле fingerprint: ${key}.`);
    }
    fingerprint[key] = current;
  }
  if (value.contentLength !== undefined && value.contentLength !== null) {
    if (!Number.isSafeInteger(value.contentLength) || Number(value.contentLength) < 0) {
      throw validationError("INVALID_FINGERPRINT", "Некоректний розмір у fingerprint джерела.");
    }
    fingerprint.contentLength = Number(value.contentLength);
  }
  return fingerprint;
}

function normalizeSnapshot(
  value: FindingDocumentSnapshotReference | null | undefined,
): FindingDocumentSnapshotReference | undefined {
  if (value === null || value === undefined) return undefined;
  const mimeType = value.mimeType;
  if (mimeType !== undefined && !ALLOWED_SNAPSHOT_MIME_TYPES.has(mimeType)) {
    throw validationError("INVALID_SNAPSHOT", "Непідтримуваний MIME-тип snapshot.");
  }
  if (value.provider === "google_drive") {
    const fileId = requiredSnapshotText(value.fileId, "Google Drive fileId");
    const url = value.url ? stableSnapshotUrl(value.url) : undefined;
    return {
      provider: "google_drive",
      fileId,
      ...(url ? { url } : {}),
      ...(mimeType ? { mimeType } : {}),
    };
  }
  if (value.provider === "external") {
    const url = stableSnapshotUrl(value.url);
    const fileId = value.fileId ? requiredSnapshotText(value.fileId, "snapshot fileId") : undefined;
    return {
      provider: "external",
      url,
      ...(fileId ? { fileId } : {}),
      ...(mimeType ? { mimeType } : {}),
    };
  }
  throw validationError("INVALID_SNAPSHOT", "Невідомий провайдер snapshot.");
}

function snapshotToColumns(
  snapshot: FindingDocumentSnapshotReference | undefined,
): Pick<
  FindingDocumentReferenceRow,
  "snapshot_provider" | "snapshot_file_id" | "snapshot_url" | "snapshot_mime_type"
> {
  return {
    snapshot_provider: snapshot?.provider ?? null,
    snapshot_file_id: snapshot?.fileId ?? null,
    snapshot_url: snapshot?.url ?? null,
    snapshot_mime_type: snapshot?.mimeType ?? null,
  };
}

function snapshotFromRow(
  row: FindingDocumentReferenceRow,
): FindingDocumentSnapshotReference | undefined {
  if (!row.snapshot_provider) return undefined;
  const mimeType = row.snapshot_mime_type as FindingDocumentReferenceSnapshotMimeType | null;
  if (mimeType && !ALLOWED_SNAPSHOT_MIME_TYPES.has(mimeType)) {
    throw validationError("INVALID_SNAPSHOT", "Збережений snapshot має непідтримуваний MIME-тип.");
  }
  if (row.snapshot_provider === "google_drive") {
    return normalizeSnapshot({
      provider: "google_drive",
      fileId: row.snapshot_file_id ?? "",
      ...(row.snapshot_url ? { url: row.snapshot_url } : {}),
      ...(mimeType ? { mimeType } : {}),
    });
  }
  return normalizeSnapshot({
    provider: "external",
    url: row.snapshot_url ?? "",
    ...(row.snapshot_file_id ? { fileId: row.snapshot_file_id } : {}),
    ...(mimeType ? { mimeType } : {}),
  });
}

function stableSnapshotUrl(value: string): string {
  try {
    const normalized = normalizeExternalDocumentUrl(value);
    if (normalized.removedSensitiveParameters.length) {
      throw validationError(
        "INVALID_SNAPSHOT",
        "Короткочасне або підписане snapshot-посилання не можна зберігати.",
      );
    }
    return normalized.url;
  } catch (error) {
    if (error instanceof FindingDocumentReferenceValidationError) throw error;
    throw validationError("INVALID_SNAPSHOT", "Snapshot-посилання має бути стабільним HTTPS URL.");
  }
}

function normalizeFilters(filters: FindingDocumentReferenceFilters): FindingDocumentReferenceFilters {
  return {
    ...(filters.findingId ? { findingId: requiredIdentifier(filters.findingId) } : {}),
    ...(filters.documentId ? { documentId: requiredIdentifier(filters.documentId) } : {}),
    ...(filters.documentSourceId
      ? { documentSourceId: requiredIdentifier(filters.documentSourceId) }
      : {}),
  };
}

function requiredIdentifier(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw validationError("MISSING_IDENTIFIER", "Обов’язковий ідентифікатор не передано.");
  }
  return normalized;
}

function normalizedPageIndex(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError("INVALID_PAGE_INDEX", "Номер сторінки має бути цілим числом від 1.");
  }
  return value;
}

function normalizedUnit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw validationError("INVALID_SELECTION", `${field} має бути в межах від 0 до 1.`);
  }
  return value;
}

function normalizedPositiveUnit(value: number, field: string): number {
  const normalized = normalizedUnit(value, field);
  if (normalized <= 0) {
    throw validationError("INVALID_SELECTION", `${field} має бути більше нуля.`);
  }
  return normalized;
}

function normalizedPageDimension(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw validationError("INVALID_SELECTION", `${field} має некоректне значення.`);
  }
  return value;
}

function roundedNormalized(value: number): number {
  return Number(value.toFixed(NORMALIZED_PRECISION));
}

function normalizeOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function requiredSnapshotText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > MAX_SNAPSHOT_REFERENCE_LENGTH) {
    throw validationError("INVALID_SNAPSHOT", `${label} має некоректне значення.`);
  }
  return normalized;
}

function numberField(value: unknown): number {
  return typeof value === "number" ? value : Number.NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validationError(
  code: FindingDocumentReferenceValidationCode,
  message: string,
): FindingDocumentReferenceValidationError {
  return new FindingDocumentReferenceValidationError(code, message);
}

function createSupabaseStore(): FindingDocumentReferenceStore {
  return {
    async list(projectId, filters) {
      const { getSupabaseClient } = await import("./supabaseAuth.ts");
      let query = getSupabaseClient()
        .from("finding_document_references")
        .select(FINDING_DOCUMENT_REFERENCE_SELECT)
        .eq("project_id", projectId)
        .order("created_at", { ascending: true });
      if (filters.findingId) query = query.eq("finding_id", filters.findingId);
      if (filters.documentId) query = query.eq("document_id", filters.documentId);
      if (filters.documentSourceId) {
        query = query.eq("document_source_id", filters.documentSourceId);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as FindingDocumentReferenceRow[];
    },

    async get(projectId, id) {
      const { getSupabaseClient } = await import("./supabaseAuth.ts");
      const { data, error } = await getSupabaseClient()
        .from("finding_document_references")
        .select(FINDING_DOCUMENT_REFERENCE_SELECT)
        .eq("project_id", projectId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as FindingDocumentReferenceRow | null;
    },

    async insert(row) {
      const { getSupabaseClient } = await import("./supabaseAuth.ts");
      const { data, error } = await getSupabaseClient()
        .from("finding_document_references")
        .upsert(row, {
          onConflict: "project_id,finding_id,document_source_id,page_index",
        })
        .select(FINDING_DOCUMENT_REFERENCE_SELECT)
        .single();
      if (error) throw error;
      return data as unknown as FindingDocumentReferenceRow;
    },

    async update(projectId, id, patch) {
      const { getSupabaseClient } = await import("./supabaseAuth.ts");
      const { data, error } = await getSupabaseClient()
        .from("finding_document_references")
        .update(patch)
        .eq("project_id", projectId)
        .eq("id", id)
        .select(FINDING_DOCUMENT_REFERENCE_SELECT)
        .single();
      if (error) throw error;
      return data as unknown as FindingDocumentReferenceRow;
    },

    async remove(projectId, id) {
      const { getSupabaseClient } = await import("./supabaseAuth.ts");
      const { error } = await getSupabaseClient()
        .from("finding_document_references")
        .delete()
        .eq("project_id", projectId)
        .eq("id", id);
      if (error) throw error;
    },
  };
}
