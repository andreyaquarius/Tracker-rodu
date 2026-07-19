import type {
  CustomFieldValues,
  DocumentRecord,
  ScanAttachment,
  YearMatrixRecord,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import { saveOptionalProjectCache } from "../utils/projectCache";
import {
  chunkImportRows,
  runImportBatches,
  withImportPhase,
  type ImportPhaseProgressOptions,
} from "../utils/importBatches.ts";

type DocumentRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  title: string;
  document_type: string;
  archive: string;
  fund: string;
  file_reference: string;
  year_from: string;
  year_to: string;
  place: string;
  url: string;
  pages_count: string;
  last_page: string;
  review_status: string;
  description: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type YearMatrixRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  document_id: string | null;
  year_text: string;
  place: string;
  document_type: string;
  status: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

const IMPORT_CONCURRENCY = 3;

const DOCUMENT_SELECT =
  "id, project_id, research_id, title, document_type, archive, fund, file_reference, year_from, year_to, place, url, pages_count, last_page, review_status, description, notes, custom_fields, created_at, updated_at";
const YEAR_MATRIX_SELECT =
  "id, project_id, research_id, document_id, year_text, place, document_type, status, notes, custom_fields, created_at, updated_at";
const SCANS_KEY = "__trackerRoduDocumentScans";
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function splitCustomFields(value: unknown): {
  customFields: CustomFieldValues;
  scans: ScanAttachment[];
} {
  const record = asRecord(value);
  const scans = Array.isArray(record[SCANS_KEY])
    ? (record[SCANS_KEY] as ScanAttachment[])
    : [];
  const customFields = { ...record };
  delete customFields[SCANS_KEY];
  return { customFields: customFields as CustomFieldValues, scans };
}

function documentFromRow(row: DocumentRow): DocumentRecord {
  const { customFields, scans } = splitCustomFields(row.custom_fields);
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    title: row.title,
    documentType: row.document_type,
    archive: row.archive,
    fund: row.fund,
    file: row.file_reference,
    yearFrom: row.year_from,
    yearTo: row.year_to,
    place: row.place,
    url: row.url,
    pagesCount: row.pages_count,
    lastPage: row.last_page,
    reviewStatus: row.review_status,
    description: row.description,
    notes: row.notes,
    scans,
    customFields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function documentToRow(
  projectId: string,
  document: DocumentRecord,
  researchIds: Set<string>,
) {
  return {
    id: document.id,
    project_id: projectId,
    research_id: researchIds.has(document.researchId) ? document.researchId : null,
    title: document.title,
    document_type: document.documentType,
    archive: document.archive,
    fund: document.fund,
    file_reference: document.file,
    year_from: document.yearFrom,
    year_to: document.yearTo,
    place: document.place,
    url: document.url,
    pages_count: document.pagesCount,
    last_page: document.lastPage,
    review_status: document.reviewStatus,
    description: document.description,
    notes: document.notes,
    custom_fields: {
      ...(document.customFields ?? {}),
      [SCANS_KEY]: document.scans ?? [],
    },
    created_at: document.createdAt,
    updated_at: document.updatedAt,
  };
}

function matrixFromRow(row: YearMatrixRow): YearMatrixRecord {
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    documentId: row.document_id ?? "",
    year: row.year_text,
    place: row.place,
    documentType: row.document_type,
    status: row.status,
    notes: row.notes,
    customFields: asRecord(row.custom_fields) as CustomFieldValues,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function matrixToRow(
  projectId: string,
  record: YearMatrixRecord,
  researchIds: Set<string>,
  documentIds: Set<string>,
) {
  return {
    id: record.id,
    project_id: projectId,
    research_id: researchIds.has(record.researchId) ? record.researchId : null,
    document_id: documentIds.has(record.documentId) ? record.documentId : null,
    year_text: record.year,
    place: record.place,
    document_type: record.documentType,
    status: record.status,
    notes: record.notes,
    custom_fields: record.customFields ?? {},
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export async function listProjectDocuments(projectId: string): Promise<{
  documents: DocumentRecord[];
  yearMatrix: YearMatrixRecord[];
}> {
  const client = getSupabaseClient();
  const [documentsResult, matrixResult] = await Promise.all([
    client
      .from("documents")
      .select(DOCUMENT_SELECT)
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false }),
    client
      .from("year_matrix")
      .select(YEAR_MATRIX_SELECT)
      .eq("project_id", projectId)
      .order("year_text", { ascending: true }),
  ]);
  if (documentsResult.error) throw documentsResult.error;
  if (matrixResult.error) throw matrixResult.error;
  return {
    documents: (documentsResult.data as DocumentRow[]).map(documentFromRow),
    yearMatrix: (matrixResult.data as YearMatrixRow[]).map(matrixFromRow),
  };
}

export async function getProjectDocument(
  projectId: string,
  documentId: string,
): Promise<DocumentRecord | null> {
  const { data, error } = await getSupabaseClient()
    .from("documents")
    .select(DOCUMENT_SELECT)
    .eq("project_id", projectId)
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  return data ? documentFromRow(data as DocumentRow) : null;
}

export async function listProjectDocumentsByIds(
  projectId: string,
  documentIds: readonly string[],
): Promise<DocumentRecord[]> {
  const uniqueIds = [...new Set(documentIds.filter(Boolean))];
  if (!uniqueIds.length) return [];
  const { data, error } = await getSupabaseClient()
    .from("documents")
    .select(DOCUMENT_SELECT)
    .eq("project_id", projectId)
    .in("id", uniqueIds)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data as DocumentRow[]).map(documentFromRow);
}

export async function getProjectYearMatrixRecord(
  projectId: string,
  recordId: string,
): Promise<YearMatrixRecord | null> {
  const { data, error } = await getSupabaseClient()
    .from("year_matrix")
    .select(YEAR_MATRIX_SELECT)
    .eq("project_id", projectId)
    .eq("id", recordId)
    .maybeSingle();
  if (error) throw error;
  return data ? matrixFromRow(data as YearMatrixRow) : null;
}

export async function importProjectDocuments(
  projectId: string,
  documents: DocumentRecord[],
  yearMatrix: YearMatrixRecord[],
  researchIds: Set<string>,
  options: ImportPhaseProgressOptions = {},
): Promise<void> {
  const client = getSupabaseClient();
  const documentIds = new Set(documents.map((document) => document.id));
  const documentRows = documents.map((document) => documentToRow(projectId, document, researchIds));
  await runImportBatches(chunkImportRows(documentRows), async (batch) => {
    const { error } = await client
      .from("documents")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }, {
    concurrency: IMPORT_CONCURRENCY,
    beforeBatch: options.beforeBatch,
    onProgress: withImportPhase("documents", options.onProgress),
  });
  const yearMatrixRows = yearMatrix.map((record) =>
    matrixToRow(projectId, record, researchIds, documentIds),
  );
  await runImportBatches(chunkImportRows(yearMatrixRows), async (batch) => {
    const { error } = await client
      .from("year_matrix")
      .upsert(batch, { onConflict: "id" });
    if (error) throw error;
  }, {
    concurrency: IMPORT_CONCURRENCY,
    beforeBatch: options.beforeBatch,
    onProgress: withImportPhase("year-matrix", options.onProgress),
  });
}

export async function saveProjectDocument(
  projectId: string,
  document: DocumentRecord,
  researchIds: Set<string>,
): Promise<DocumentRecord> {
  const { data, error } = await getSupabaseClient()
    .from("documents")
    .upsert(documentToRow(projectId, document, researchIds), { onConflict: "id" })
    .select(DOCUMENT_SELECT)
    .single();
  if (error) throw error;
  return documentFromRow(data as DocumentRow);
}

export async function deleteProjectDocument(
  projectId: string,
  documentId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("documents")
    .delete()
    .eq("project_id", projectId)
    .eq("id", documentId);
  if (error) throw error;
}

export async function saveProjectYearMatrixRecord(
  projectId: string,
  record: YearMatrixRecord,
  researchIds: Set<string>,
  documentIds: Set<string>,
): Promise<YearMatrixRecord> {
  const { data, error } = await getSupabaseClient()
    .from("year_matrix")
    .upsert(matrixToRow(projectId, record, researchIds, documentIds), {
      onConflict: "id",
    })
    .select(YEAR_MATRIX_SELECT)
    .single();
  if (error) throw error;
  return matrixFromRow(data as YearMatrixRow);
}

export async function saveProjectYearMatrixRecords(
  projectId: string,
  records: YearMatrixRecord[],
  researchIds: Set<string>,
  documentIds: Set<string>,
): Promise<YearMatrixRecord[]> {
  if (!records.length) return [];
  const { data, error } = await getSupabaseClient()
    .from("year_matrix")
    .upsert(
      records.map((record) =>
        matrixToRow(projectId, record, researchIds, documentIds),
      ),
      { onConflict: "id" },
    )
    .select(YEAR_MATRIX_SELECT);
  if (error) throw error;
  return (data as YearMatrixRow[]).map(matrixFromRow);
}

export async function deleteProjectYearMatrixRecord(
  projectId: string,
  recordId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("year_matrix")
    .delete()
    .eq("project_id", projectId)
    .eq("id", recordId);
  if (error) throw error;
}

const CACHE_PREFIX = "tracker-rodu-project-documents:";
const DOCUMENTS_CACHE_MAX_CHARS = 750_000;

export function loadProjectDocumentsCache(projectId: string): {
  documents: DocumentRecord[];
  yearMatrix: YearMatrixRecord[];
} {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return { documents: [], yearMatrix: [] };
    const parsed = JSON.parse(stored) as {
      documents?: unknown;
      yearMatrix?: unknown;
    };
    return {
      documents: Array.isArray(parsed.documents)
        ? (parsed.documents as DocumentRecord[])
        : [],
      yearMatrix: Array.isArray(parsed.yearMatrix)
        ? (parsed.yearMatrix as YearMatrixRecord[])
        : [],
    };
  } catch {
    return { documents: [], yearMatrix: [] };
  }
}

export function saveProjectDocumentsCache(
  projectId: string,
  documents: DocumentRecord[],
  yearMatrix: YearMatrixRecord[],
): void {
  saveOptionalProjectCache(
    `${CACHE_PREFIX}${projectId}`,
    { documents, yearMatrix },
    DOCUMENTS_CACHE_MAX_CHARS,
  );
}

export function clearProjectDocumentsCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
