import type { EntityId } from "../types";
import type {
  FamilyTreeGraphIssue,
  GedcomPreservedRecord,
} from "../types/familyTree";
import {
  buildGedcomArchiveBatchPayload,
  buildGedcomArchiveXrefRows,
  chunkGedcomArchiveRows,
  GEDCOM_ARCHIVE_ROW_BATCH_SIZE,
  personIdMapFromGedcomArchiveRows,
  restoreGedcomArchiveRecords,
  type GedcomArchiveInput,
  type GedcomArchiveStoredXrefRow,
} from "../utils/gedcomArchive.ts";
import { getSupabaseClient } from "./supabaseAuth.ts";

export type SaveGedcomArchiveInput = GedcomArchiveInput;

export interface ReadLatestGedcomArchiveInput {
  projectId: EntityId;
  treeId: EntityId;
}

export interface GedcomArchiveSnapshot {
  batchId: EntityId;
  projectId: EntityId;
  treeId: EntityId;
  fileName: string;
  gedcomVersion: string;
  status: "completed";
  importedPeople: number;
  importedFamilies: number;
  warnings: FamilyTreeGraphIssue[];
  records: GedcomPreservedRecord[];
  personIdByXref: Record<string, EntityId>;
  createdAt: string;
}

type GedcomImportBatchRow = {
  id: EntityId;
  project_id: EntityId;
  tree_id: EntityId | null;
  file_name: string;
  gedcom_version: string;
  status: string;
  imported_people: number;
  imported_families: number;
  warnings: unknown;
  raw_metadata: unknown;
  created_at: string;
};

const GEDCOM_IMPORT_BATCH_SELECT =
  "id, project_id, tree_id, file_name, gedcom_version, status, imported_people, imported_families, warnings, raw_metadata, created_at";
const GEDCOM_XREF_MAP_SELECT =
  "gedcom_xref, gedcom_record_type, internal_table, internal_id, raw_record";

/** Persist a lossless GEDCOM snapshot after the Tracker entities were created. */
export async function saveGedcomArchive(
  input: SaveGedcomArchiveInput,
): Promise<GedcomArchiveSnapshot> {
  const client = getSupabaseClient();
  const batchPayload = buildGedcomArchiveBatchPayload(input);
  let batch: GedcomImportBatchRow | null = null;

  try {
    const batchResult = await client
      .from("gedcom_import_batches")
      .insert(batchPayload)
      .select(GEDCOM_IMPORT_BATCH_SELECT)
      .single();
    if (batchResult.error) throw batchResult.error;
    batch = batchResult.data as GedcomImportBatchRow;

    const xrefRows = buildGedcomArchiveXrefRows({
      ...input,
      batchId: batch.id,
    });
    for (const chunk of chunkGedcomArchiveRows(xrefRows)) {
      const result = await client.from("gedcom_xref_maps").insert(chunk);
      if (result.error) throw result.error;
    }

    const completedResult = await client
      .from("gedcom_import_batches")
      .update({ status: "completed" })
      .eq("project_id", input.projectId)
      .eq("id", batch.id);
    if (completedResult.error) throw completedResult.error;

    return snapshotFromRows(
      { ...batch, status: "completed" },
      xrefRows,
    );
  } catch (error) {
    if (batch) {
      await markGedcomArchiveBatchFailed(
        batch.id,
        input.projectId,
        batchPayload.warnings,
        error,
      );
    }
    throw error;
  }
}

/** Read the most recently completed lossless archive for one project tree. */
export async function readLatestGedcomArchive(
  input: ReadLatestGedcomArchiveInput,
): Promise<GedcomArchiveSnapshot | null> {
  const client = getSupabaseClient();
  const batchResult = await client
    .from("gedcom_import_batches")
    .select(GEDCOM_IMPORT_BATCH_SELECT)
    .eq("project_id", input.projectId)
    .eq("tree_id", input.treeId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (batchResult.error) throw batchResult.error;
  if (!batchResult.data) return null;

  const batch = batchResult.data as GedcomImportBatchRow;
  const xrefRows = await readAllGedcomXrefRows(batch.id, input.projectId);
  return snapshotFromRows(batch, xrefRows);
}

export const readLatestCompletedGedcomArchive = readLatestGedcomArchive;

/** Short API requested by the importer while keeping tree-shakeable named functions. */
export const gedcomArchiveService = {
  save: saveGedcomArchive,
  readLatest: readLatestGedcomArchive,
};

async function readAllGedcomXrefRows(
  batchId: EntityId,
  projectId: EntityId,
): Promise<GedcomArchiveStoredXrefRow[]> {
  const client = getSupabaseClient();
  const rows: GedcomArchiveStoredXrefRow[] = [];

  for (let offset = 0; ; offset += GEDCOM_ARCHIVE_ROW_BATCH_SIZE) {
    const result = await client
      .from("gedcom_xref_maps")
      .select(GEDCOM_XREF_MAP_SELECT)
      .eq("project_id", projectId)
      .eq("import_batch_id", batchId)
      .order("created_at", { ascending: true })
      .range(offset, offset + GEDCOM_ARCHIVE_ROW_BATCH_SIZE - 1);
    if (result.error) throw result.error;

    const page = (result.data ?? []) as GedcomArchiveStoredXrefRow[];
    rows.push(...page);
    if (page.length < GEDCOM_ARCHIVE_ROW_BATCH_SIZE) break;
  }

  return rows;
}

function snapshotFromRows(
  batch: GedcomImportBatchRow,
  xrefRows: readonly GedcomArchiveStoredXrefRow[],
): GedcomArchiveSnapshot {
  if (!batch.tree_id) {
    throw new Error("GEDCOM archive batch is not attached to a family tree.");
  }
  return {
    batchId: batch.id,
    projectId: batch.project_id,
    treeId: batch.tree_id,
    fileName: batch.file_name,
    gedcomVersion: batch.gedcom_version,
    status: "completed",
    importedPeople: batch.imported_people,
    importedFamilies: batch.imported_families,
    warnings: readWarnings(batch.warnings),
    records: restoreGedcomArchiveRecords(batch.raw_metadata, xrefRows),
    personIdByXref: personIdMapFromGedcomArchiveRows(xrefRows),
    createdAt: batch.created_at,
  };
}

async function markGedcomArchiveBatchFailed(
  batchId: EntityId,
  projectId: EntityId,
  existingWarnings: readonly FamilyTreeGraphIssue[],
  error: unknown,
): Promise<void> {
  try {
    await getSupabaseClient()
      .from("gedcom_import_batches")
      .update({
        status: "failed",
        warnings: [
          ...existingWarnings,
          {
            severity: "critical",
            code: "gedcomArchivePersistenceFailed",
            message: errorMessage(error),
          },
        ],
      })
      .eq("project_id", projectId)
      .eq("id", batchId);
  } catch {
    // Preserve the original persistence error even when the best-effort status update fails.
  }
}

function readWarnings(value: unknown): FamilyTreeGraphIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const item = candidate as Record<string, unknown>;
    const severity = item.severity;
    if (
      severity !== "info"
      && severity !== "warning"
      && severity !== "critical"
      && severity !== "needs_review"
    ) return [];
    if (typeof item.code !== "string" || typeof item.message !== "string") return [];
    return [{
      severity,
      code: item.code,
      message: item.message,
      personIds: stringArray(item.personIds),
      relationshipIds: stringArray(item.relationshipIds),
    }];
  });
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "").trim();
    if (message) return message;
  }
  return "Не вдалося зберегти повний архів GEDCOM.";
}
