import type { DocumentRecord, Finding } from "../../../src/types/index.ts";
import type { GedcomPreservedRecord } from "../../../src/types/familyTree.ts";
import { restoreGedcomArchiveRecords } from "../../../src/utils/gedcomArchive.ts";
import { exportFamilyTreeProjectionToGedcom } from "../../../src/utils/gedcom.ts";
import {
  buildGedcomExportProjection,
  type GedcomExportAssociationRow,
  type GedcomExportEventRow,
  type GedcomExportNameRow,
  type GedcomExportParentChildRow,
  type GedcomExportParentSetRow,
  type GedcomExportPartnerRow,
  type GedcomExportPersonRow,
} from "./gedcomExportSnapshot.ts";

export const GEDCOM_EXPORT_BUCKET = "gedcom-exports";
export const GEDCOM_EXPORT_FILE_NAME = "family-tree.ged";
export const GEDCOM_EXPORT_SIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
export const GEDCOM_EXPORT_PAGE_SIZE = 1_000;

export type GedcomExportJob = {
  jobId: string;
  projectId: string;
  treeId: string;
  treeTitle: string;
  requestedBy: string;
  requesterEmail: string;
  status: string;
  attempts: number;
  storagePath: string;
};

export type GedcomExportCompletedFile = {
  jobId: string;
  storagePath: string;
  fileName: string;
  fileSize: number;
  personCount: number;
  familyCount: number;
  warningCount: number;
  downloadUrl: string;
  expiresAt: string;
};

export type GedcomExportUploader = (input: {
  bucket: string;
  path: string;
  bytes: Uint8Array;
  contentType: string;
}) => Promise<void>;

// Kept deliberately structural so this pure processor can run both in Deno
// Edge Functions and in the Node large-export runner.
export type SupabaseServiceClient = {
  from(table: string): any;
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: any }>;
  storage: {
    from(bucket: string): {
      upload(path: string, body: unknown, options?: Record<string, unknown>): PromiseLike<{ data: unknown; error: any }>;
      createSignedUrl(path: string, expiresIn: number, options?: Record<string, unknown>): PromiseLike<{
        data: { signedUrl?: string } | null;
        error: any;
      }>;
      remove(paths: string[]): PromiseLike<{ data: unknown; error: any }>;
    };
  };
};

type FamilyTreeRow = {
  id: string;
  root_person_id: string | null;
  title: string;
};

type FindingRow = {
  id: string;
  research_id: string | null;
  document_id: string | null;
  finding_type: string;
  event_date: string;
  people: string;
  persons_text: string;
  place: string;
  archive: string;
  fund: string;
  description: string;
  file_reference: string;
  page: string;
  source_url: string;
  summary: string;
  transcription: string;
  conclusion: string;
  reliability: string;
  needs_review: boolean;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type DocumentRow = {
  id: string;
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

type GedcomBatchRow = {
  id: string;
  raw_metadata: unknown;
};

type GedcomXrefRow = {
  id: string;
  created_at: string;
  gedcom_xref: string;
  gedcom_record_type: string;
  internal_table: string;
  internal_id: string | null;
  raw_record: unknown;
};

type FindingParticipantRow = {
  id: string;
  finding_id: string;
  person_id: string | null;
  name: string;
  role: string;
  notes: string;
};

const PERSON_SELECT = [
  "id", "project_id", "research_id", "gender", "status", "surname", "given_name", "patronymic",
  "full_name", "name_variants", "surname_variants", "birth_date", "birth_year_from", "birth_year_to",
  "birth_place", "marriage_date", "marriage_place", "death_date", "death_year_from", "death_year_to",
  "death_place", "residence_places", "social_status", "religion", "occupation", "notes", "custom_fields",
  "is_living", "privacy_status",
].join(", ");
const NAME_SELECT = "id, project_id, person_id, name_type, language_code, script_code, surname, given_name, patronymic, full_name, original_text, is_primary, is_preferred, evidence_status, confidence, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const EVENT_SELECT = "id, project_id, person_id, event_type, title, event_date, date_from, date_to, date_text, place_name, geo, event_role, evidence_status, confidence, source_document_id, source_finding_id, notes, metadata, created_at, updated_at";
const PARTNER_SELECT = "id, family_group_id, person_a_id, person_b_id, relationship_type, start_date, start_place, end_date, end_place, evidence_status, confidence, source_document_id, source_finding_id, notes, metadata";
const PARENT_CHILD_SELECT = "id, parent_id, child_id, parent_set_id, family_group_id, relationship_type, parent_role_label, start_date, end_date, evidence_status, confidence, is_bloodline, source_document_id, source_finding_id, notes, metadata";
const ASSOCIATION_SELECT = "id, person_a_id, person_b_id, association_type, evidence_status, confidence, source_document_id, source_finding_id, notes, metadata";
const FINDING_SELECT = "id, research_id, document_id, finding_type, event_date, people, persons_text, place, archive, fund, description, file_reference, page, source_url, summary, transcription, conclusion, reliability, needs_review, notes, custom_fields, created_at, updated_at";
const DOCUMENT_SELECT = "id, research_id, title, document_type, archive, fund, file_reference, year_from, year_to, place, url, pages_count, last_page, review_status, description, notes, custom_fields, created_at, updated_at";

export async function standardGedcomStorageUpload(
  client: SupabaseServiceClient,
  input: Parameters<GedcomExportUploader>[0],
): Promise<void> {
  const { error } = await client.storage.from(input.bucket).upload(
    input.path,
    input.bytes,
    {
      contentType: input.contentType,
      cacheControl: "3600",
      upsert: true,
    },
  );
  if (error) throw error;
}

export async function processClaimedGedcomExport(
  client: SupabaseServiceClient,
  job: GedcomExportJob,
  uploader: GedcomExportUploader,
): Promise<GedcomExportCompletedFile> {
  await touch(client, job.jobId, job.attempts, "loading", 5);
  const snapshot = await loadGedcomExportSnapshot(client, job);
  await touch(client, job.jobId, job.attempts, "serializing", 55);

  const projection = buildGedcomExportProjection(snapshot);
  const result = exportFamilyTreeProjectionToGedcom(projection, {
    sourceName: "Трекер Роду",
    createdAt: new Date(),
    rootPersonId: snapshot.rootPersonId ?? undefined,
    preservedRecords: snapshot.preservedRecords,
    documents: snapshot.documents,
    findings: snapshot.findings,
  });
  const bytes = new TextEncoder().encode(result.text);
  // Project deletion removes objects strictly below `${projectId}/...`.
  // Keep the requester segment as an additional ownership boundary while
  // preserving that cleanup invariant.
  const storagePath = job.storagePath
    || `${job.projectId}/${job.requestedBy}/${job.jobId}/attempt-${job.attempts}/${GEDCOM_EXPORT_FILE_NAME}`;

  let uploaded = false;
  let downloadUrl = "";
  let expiresAt = "";
  const familyCount = Object.keys(result.familyXrefs).length;
  try {
    await assertExportStillWritable(client, job);
    await touch(client, job.jobId, job.attempts, "uploading", 75);
    await uploader({
      bucket: GEDCOM_EXPORT_BUCKET,
      path: storagePath,
      bytes,
      contentType: "text/plain; charset=utf-8",
    });
    uploaded = true;

    // Close the deletion race after the potentially long upload and before a
    // durable ready-state points at the object.
    await assertExportStillWritable(client, job);
    await touch(client, job.jobId, job.attempts, "signing", 90);
    const { data: signed, error: signedError } = await client.storage
      .from(GEDCOM_EXPORT_BUCKET)
      .createSignedUrl(storagePath, GEDCOM_EXPORT_SIGNED_URL_SECONDS, {
        download: GEDCOM_EXPORT_FILE_NAME,
      });
    if (signedError) throw signedError;
    downloadUrl = signed?.signedUrl?.trim() ?? "";
    if (!downloadUrl) throw new Error("GEDCOM_EXPORT_SIGNED_URL_MISSING");
    expiresAt = new Date(Date.now() + GEDCOM_EXPORT_SIGNED_URL_SECONDS * 1_000).toISOString();

    const { error: completeError } = await client.rpc("complete_gedcom_export", {
      target_job_id: job.jobId,
      target_attempt: job.attempts,
      target_storage_path: storagePath,
      target_file_name: GEDCOM_EXPORT_FILE_NAME,
      target_file_size: bytes.byteLength,
      target_person_count: projection.nodes.length,
      target_family_count: familyCount,
      target_warning_count: result.warnings.length,
      target_download_url: downloadUrl,
      target_expires_at: expiresAt,
    });
    if (completeError) throw completeError;
  } catch (error) {
    if (uploaded && !(await exportIsCompleted(client, job.jobId))) {
      await removeOrphanedExport(client, storagePath);
    }
    throw error;
  }

  return {
    jobId: job.jobId,
    storagePath,
    fileName: GEDCOM_EXPORT_FILE_NAME,
    fileSize: bytes.byteLength,
    personCount: projection.nodes.length,
    familyCount,
    warningCount: result.warnings.length,
    downloadUrl,
    expiresAt,
  };
}

async function assertExportStillWritable(
  client: SupabaseServiceClient,
  job: GedcomExportJob,
): Promise<void> {
  const projectResult = await client.from("projects")
    .select("id, deletion_pending")
    .eq("id", job.projectId)
    .maybeSingle();
  if (projectResult.error) throw projectResult.error;
  if (!projectResult.data || projectResult.data.deletion_pending === true) {
    throw new Error("GEDCOM_EXPORT_PROJECT_DELETION_PENDING");
  }
  const { data, error } = await client.rpc("get_gedcom_export_status", {
    target_job_id: job.jobId,
  });
  if (error) throw error;
  const value = Array.isArray(data) ? data[0] : data;
  const status = value && typeof value === "object"
    ? String((value as Record<string, unknown>).status ?? "")
    : "";
  const attempt = value && typeof value === "object"
    ? Number((value as Record<string, unknown>).attempts)
    : 0;
  if ((status !== "running" && status !== "processing") || attempt !== job.attempts) {
    throw new Error(`GEDCOM_EXPORT_LEASE_LOST:${status || "missing"}:${attempt || 0}`);
  }
}

async function exportIsCompleted(client: SupabaseServiceClient, jobId: string): Promise<boolean> {
  try {
    const { data, error } = await client.rpc("get_gedcom_export_status", {
      target_job_id: jobId,
    });
    if (error) return false;
    const value = Array.isArray(data) ? data[0] : data;
    return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).status === "completed");
  } catch {
    return false;
  }
}

async function removeOrphanedExport(client: SupabaseServiceClient, storagePath: string): Promise<void> {
  try {
    const { error } = await client.storage.from(GEDCOM_EXPORT_BUCKET).remove([storagePath]);
    if (error) console.error("Could not remove orphaned GEDCOM export", error);
  } catch (error) {
    console.error("Could not remove orphaned GEDCOM export", error);
  }
}

export async function failGedcomExport(
  client: SupabaseServiceClient,
  jobId: string,
  attempt: number,
  error: unknown,
): Promise<void> {
  const message = exportErrorMessage(error).slice(0, 2_000);
  const result = await client.rpc("fail_gedcom_export", {
    target_job_id: jobId,
    target_attempt: attempt,
    target_error: message,
  });
  if (result.error) {
    console.error("Could not persist GEDCOM export failure", result.error);
  }
}

export function parseClaimedGedcomExport(value: unknown): GedcomExportJob | null {
  const unwrapped = Array.isArray(value) ? value[0] : value;
  if (!unwrapped || typeof unwrapped !== "object") return null;
  const row = unwrapped as Record<string, unknown>;
  const job: GedcomExportJob = {
    jobId: valueText(row.jobId ?? row.job_id),
    projectId: valueText(row.projectId ?? row.project_id),
    treeId: valueText(row.treeId ?? row.tree_id),
    treeTitle: valueText(row.treeTitle ?? row.tree_title),
    requestedBy: valueText(row.requestedBy ?? row.requested_by),
    requesterEmail: valueText(row.requesterEmail ?? row.requester_email),
    status: valueText(row.status),
    attempts: Number(row.attempts) || 0,
    storagePath: valueText(row.storagePath ?? row.storage_path),
  };
  return job.jobId && job.projectId && job.treeId && job.requestedBy ? job : null;
}

async function loadGedcomExportSnapshot(client: SupabaseServiceClient, job: GedcomExportJob) {
  const treeResult = await client.from("family_trees")
    .select("id, root_person_id, title")
    .eq("project_id", job.projectId)
    .eq("id", job.treeId)
    .single();
  if (treeResult.error) throw treeResult.error;
  const tree = treeResult.data as FamilyTreeRow;

  const [people, partners, parentChildren, associations, parentSets] = await Promise.all([
    readPaged<GedcomExportPersonRow>(() => client.from("persons")
      .select(PERSON_SELECT)
      .eq("project_id", job.projectId)
      .order("id", { ascending: true })),
    readPaged<GedcomExportPartnerRow>(() => client.from("partner_relationships")
      .select(PARTNER_SELECT)
      .eq("project_id", job.projectId)
      .eq("tree_id", job.treeId)
      .order("id", { ascending: true })),
    readPaged<GedcomExportParentChildRow>(() => client.from("parent_child_relationships")
      .select(PARENT_CHILD_SELECT)
      .eq("project_id", job.projectId)
      .eq("tree_id", job.treeId)
      .order("id", { ascending: true })),
    readPaged<GedcomExportAssociationRow>(() => client.from("association_relationships")
      .select(ASSOCIATION_SELECT)
      .eq("project_id", job.projectId)
      .eq("tree_id", job.treeId)
      .order("id", { ascending: true })),
    readPaged<GedcomExportParentSetRow>(() => client.from("parent_sets")
      .select("id, set_type")
      .eq("project_id", job.projectId)
      .eq("tree_id", job.treeId)
      .order("id", { ascending: true })),
  ]);

  const [names, events, preservedRecords, relevant] = await Promise.all([
    readPaged<GedcomExportNameRow>(() => client.from("person_names")
      .select(NAME_SELECT)
      .eq("project_id", job.projectId)
      .order("id", { ascending: true })),
    readPaged<GedcomExportEventRow>(() => client.from("person_timeline_events")
      .select(EVENT_SELECT)
      .eq("project_id", job.projectId)
      .order("id", { ascending: true })),
    readPreservedRecords(client, job.projectId, job.treeId),
    readProjectFindingsAndDocuments(client, job.projectId),
  ]);

  people.sort((left, right) => left.id.localeCompare(right.id));
  return {
    projectId: job.projectId,
    treeId: job.treeId,
    rootPersonId: tree.root_person_id,
    people,
    names,
    events,
    partnerRelationships: partners,
    parentChildRelationships: parentChildren,
    associationRelationships: associations,
    parentSets,
    preservedRecords,
    documents: relevant.documents,
    findings: relevant.findings,
  };
}

async function readProjectFindingsAndDocuments(
  client: SupabaseServiceClient,
  projectId: string,
): Promise<{ findings: Finding[]; documents: DocumentRecord[] }> {
  const [findingRows, participantRows, documentRows] = await Promise.all([
    readPaged<FindingRow>(() => client.from("findings")
      .select(FINDING_SELECT)
      .eq("project_id", projectId)
      .order("id", { ascending: true })),
    readPaged<FindingParticipantRow>(() => client.from("finding_participants")
      .select("id, finding_id, person_id, name, role, notes")
      .eq("project_id", projectId)
      .order("id", { ascending: true })),
    readPaged<DocumentRow>(() => client.from("documents")
      .select(DOCUMENT_SELECT)
      .eq("project_id", projectId)
      .order("id", { ascending: true })),
  ]);
  const participantsByFinding = groupRows(participantRows, (row) => row.finding_id);
  return {
    findings: findingRows.map((row) => mapFinding(row, participantsByFinding.get(row.id) ?? [])),
    documents: documentRows.map(mapDocument),
  };
}

async function readPreservedRecords(
  client: SupabaseServiceClient,
  projectId: string,
  treeId: string,
): Promise<GedcomPreservedRecord[]> {
  const batchResult = await client.from("gedcom_import_batches")
    .select("id, raw_metadata")
    .eq("project_id", projectId)
    .eq("tree_id", treeId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (batchResult.error) throw batchResult.error;
  const batch = batchResult.data as GedcomBatchRow | null;
  if (!batch) return [];
  const xrefs = await readPaged<GedcomXrefRow>(() => client.from("gedcom_xref_maps")
    .select("id, created_at, gedcom_xref, gedcom_record_type, internal_table, internal_id, raw_record")
    .eq("project_id", projectId)
    .eq("import_batch_id", batch.id)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true }));
  return restoreGedcomArchiveRecords(batch.raw_metadata, xrefs);
}

async function readPaged<T>(makeQuery: () => any): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += GEDCOM_EXPORT_PAGE_SIZE) {
    const query = makeQuery();
    const { data, error } = await query.range(from, from + GEDCOM_EXPORT_PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as T[];
    rows.push(...page);
    if (page.length < GEDCOM_EXPORT_PAGE_SIZE) return rows;
  }
}

async function touch(
  client: SupabaseServiceClient,
  jobId: string,
  attempt: number,
  phase: string,
  progressPercent: number,
): Promise<void> {
  const { error } = await client.rpc("touch_gedcom_export", {
    target_job_id: jobId,
    target_attempt: attempt,
    target_phase: phase,
    target_progress_percent: progressPercent,
  });
  if (error) throw error;
}

function mapDocument(row: DocumentRow): DocumentRecord {
  const stored = plainRecord(row.custom_fields);
  const scans = Array.isArray(stored.__trackerRoduDocumentScans) ? stored.__trackerRoduDocumentScans : [];
  const customFields = { ...stored };
  delete customFields.__trackerRoduDocumentScans;
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
  } as DocumentRecord;
}

function mapFinding(row: FindingRow, participantRows: FindingParticipantRow[]): Finding {
  const stored = plainRecord(row.custom_fields);
  const meta = plainRecord(stored.__trackerRoduFindingMeta);
  const customFields = { ...stored };
  delete customFields.__trackerRoduFindingMeta;
  const personIds = Array.isArray(meta.personIds)
    ? meta.personIds.filter((value): value is string => typeof value === "string")
    : [];
  return {
    id: row.id,
    researchId: row.research_id ?? "",
    documentId: row.document_id ?? "",
    findingType: row.finding_type,
    eventDate: row.event_date,
    people: row.people,
    personsText: row.persons_text,
    personIds,
    participants: participantRows.map((participant) => ({
      id: participant.id,
      name: participant.name,
      role: participant.role,
      notes: participant.notes,
    })),
    place: row.place,
    archive: row.archive,
    fund: row.fund,
    description: row.description,
    file: row.file_reference,
    page: row.page,
    sourceUrl: row.source_url ?? "",
    summary: row.summary,
    transcription: row.transcription,
    conclusion: row.conclusion,
    reliability: row.reliability,
    needsReview: row.needs_review,
    notes: row.notes,
    scans: Array.isArray(meta.scans) ? meta.scans : [],
    customFields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } as Finding;
}

function groupRows<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const row of rows) {
    const rowKey = key(row);
    const existing = grouped.get(rowKey);
    if (existing) existing.push(row);
    else grouped.set(rowKey, [row]);
  }
  return grouped;
}

function plainRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function valueText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function exportErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return "GEDCOM_EXPORT_FAILED";
}
