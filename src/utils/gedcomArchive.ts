import type { EntityId } from "../types/index.ts";
import type {
  FamilyTreeGraphIssue,
  GedcomPreservedLine,
  GedcomPreservedRecord,
} from "../types/familyTree.ts";

export const GEDCOM_ARCHIVE_SCHEMA_VERSION = 1;
export const GEDCOM_ARCHIVE_ROW_BATCH_SIZE = 400;
export const GEDCOM_ARCHIVE_BATCH_INTERNAL_TABLE = "gedcom_import_batches";
export const GEDCOM_ARCHIVE_PERSON_INTERNAL_TABLE = "persons";

export interface GedcomArchiveInput {
  projectId: EntityId;
  treeId: EntityId;
  fileName: string;
  gedcomVersion: string;
  records: readonly GedcomPreservedRecord[];
  personIdByXref: Readonly<Record<string, EntityId>>;
  warnings?: readonly FamilyTreeGraphIssue[];
}

export interface GedcomArchiveBatchInsertPayload {
  project_id: EntityId;
  tree_id: EntityId;
  file_name: string;
  gedcom_version: string;
  status: "importing";
  imported_people: number;
  imported_families: number;
  warnings: FamilyTreeGraphIssue[];
  raw_metadata: GedcomArchiveRawMetadata;
}

export interface GedcomArchiveRawMetadata {
  archive_schema: "tracker-rodu-gedcom";
  archive_schema_version: typeof GEDCOM_ARCHIVE_SCHEMA_VERSION;
  record_count: number;
  pointed_record_count: number;
  unpointed_records: GedcomPreservedRecord[];
  /** Invalid GEDCOM can repeat an XREF. The database key cannot, so keep extras here. */
  duplicate_pointed_records: GedcomPreservedRecord[];
}

export interface GedcomArchiveXrefInsertRow {
  project_id: EntityId;
  tree_id: EntityId;
  import_batch_id: EntityId;
  gedcom_xref: string;
  gedcom_record_type: string;
  internal_table: typeof GEDCOM_ARCHIVE_PERSON_INTERNAL_TABLE
    | typeof GEDCOM_ARCHIVE_BATCH_INTERNAL_TABLE;
  internal_id: EntityId;
  raw_record: GedcomPreservedRecord;
}

export interface GedcomArchiveStoredXrefRow {
  gedcom_xref: string;
  gedcom_record_type: string;
  internal_table: string;
  internal_id: EntityId;
  raw_record: unknown;
}

export interface GedcomArchiveStoragePayload {
  batch: GedcomArchiveBatchInsertPayload;
  xrefRows: GedcomArchiveXrefInsertRow[];
}

export interface GedcomArchiveRecordPartition {
  pointedRecords: GedcomPreservedRecord[];
  unpointedRecords: GedcomPreservedRecord[];
  duplicatePointedRecords: GedcomPreservedRecord[];
}

/**
 * Builds all database payloads after the import batch UUID has been allocated.
 * The helper is deliberately independent from Supabase so it can be verified
 * with a deterministic unit test.
 */
export function buildGedcomArchiveStoragePayload(
  input: GedcomArchiveInput & { batchId: EntityId },
): GedcomArchiveStoragePayload {
  return {
    batch: buildGedcomArchiveBatchPayload(input),
    xrefRows: buildGedcomArchiveXrefRows(input),
  };
}

export function buildGedcomArchiveBatchPayload(
  input: GedcomArchiveInput,
): GedcomArchiveBatchInsertPayload {
  const partition = partitionGedcomPreservedRecords(input.records);
  const duplicateWarning = partition.duplicatePointedRecords.length
    ? [{
        severity: "warning" as const,
        code: "duplicateGedcomXrefArchived",
        message: `${partition.duplicatePointedRecords.length} повторних GEDCOM XREF збережено в метаданих архіву.`,
      }]
    : [];

  return {
    project_id: input.projectId,
    tree_id: input.treeId,
    file_name: input.fileName,
    gedcom_version: input.gedcomVersion,
    status: "importing",
    imported_people: countRecords(input.records, "INDI"),
    imported_families: countRecords(input.records, "FAM"),
    warnings: [...(input.warnings ?? []), ...duplicateWarning],
    raw_metadata: {
      archive_schema: "tracker-rodu-gedcom",
      archive_schema_version: GEDCOM_ARCHIVE_SCHEMA_VERSION,
      record_count: input.records.length,
      pointed_record_count: partition.pointedRecords.length,
      unpointed_records: partition.unpointedRecords,
      duplicate_pointed_records: partition.duplicatePointedRecords,
    },
  };
}

export function buildGedcomArchiveXrefRows(
  input: Pick<GedcomArchiveInput, "projectId" | "treeId" | "records" | "personIdByXref"> & {
    batchId: EntityId;
  },
): GedcomArchiveXrefInsertRow[] {
  const { pointedRecords } = partitionGedcomPreservedRecords(input.records);

  return pointedRecords.map((record) => {
    const pointer = record.pointer!;
    const personId = record.tag.toUpperCase() === "INDI"
      ? findPersonIdByXref(input.personIdByXref, pointer)
      : undefined;
    const internalTable = personId
      ? GEDCOM_ARCHIVE_PERSON_INTERNAL_TABLE
      : GEDCOM_ARCHIVE_BATCH_INTERNAL_TABLE;

    return {
      project_id: input.projectId,
      tree_id: input.treeId,
      import_batch_id: input.batchId,
      gedcom_xref: pointer,
      gedcom_record_type: record.tag.toUpperCase(),
      internal_table: internalTable,
      internal_id: personId ?? input.batchId,
      raw_record: record,
    };
  });
}

export function partitionGedcomPreservedRecords(
  records: readonly GedcomPreservedRecord[],
): GedcomArchiveRecordPartition {
  const pointedRecords: GedcomPreservedRecord[] = [];
  const unpointedRecords: GedcomPreservedRecord[] = [];
  const duplicatePointedRecords: GedcomPreservedRecord[] = [];
  const seenPointers = new Set<string>();

  for (const record of records) {
    const pointer = record.pointer?.trim();
    if (!pointer) {
      unpointedRecords.push(record);
      continue;
    }
    if (seenPointers.has(pointer)) {
      duplicatePointedRecords.push(record);
      continue;
    }
    seenPointers.add(pointer);
    pointedRecords.push(record);
  }

  return { pointedRecords, unpointedRecords, duplicatePointedRecords };
}

export function restoreGedcomArchiveRecords(
  rawMetadata: unknown,
  xrefRows: readonly GedcomArchiveStoredXrefRow[],
): GedcomPreservedRecord[] {
  const metadata = asObject(rawMetadata);
  const records = [
    ...readRecordArray(metadata.unpointed_records),
    ...xrefRows.flatMap((row) => {
      const record = readRecord(row.raw_record);
      if (!record) return [];
      return [{
        ...record,
        internalId: row.internal_id,
        internalTable: row.internal_table,
      }];
    }),
    ...readRecordArray(metadata.duplicate_pointed_records),
  ];

  return records.sort(comparePreservedRecords);
}

export function personIdMapFromGedcomArchiveRows(
  rows: readonly GedcomArchiveStoredXrefRow[],
): Record<string, EntityId> {
  return Object.fromEntries(rows
    .filter((row) => row.internal_table === GEDCOM_ARCHIVE_PERSON_INTERNAL_TABLE)
    .map((row) => [row.gedcom_xref, row.internal_id]));
}

/** Produces insert chunks that can never exceed the agreed PostgREST payload size. */
export function chunkGedcomArchiveRows<T>(
  rows: readonly T[],
  size = GEDCOM_ARCHIVE_ROW_BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(size) || size < 1 || size > GEDCOM_ARCHIVE_ROW_BATCH_SIZE) {
    throw new RangeError(`GEDCOM archive row batch size must be between 1 and ${GEDCOM_ARCHIVE_ROW_BATCH_SIZE}.`);
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    chunks.push(rows.slice(offset, offset + size));
  }
  return chunks;
}

function countRecords(records: readonly GedcomPreservedRecord[], tag: string): number {
  return records.filter((record) => record.tag.toUpperCase() === tag).length;
}

function findPersonIdByXref(
  personIdByXref: Readonly<Record<string, EntityId>>,
  pointer: string,
): EntityId | undefined {
  const normalized = pointer.trim();
  const withoutAt = normalized.replace(/^@|@$/g, "");
  return personIdByXref[normalized]
    ?? personIdByXref[withoutAt]
    ?? personIdByXref[`@${withoutAt}@`];
}

function comparePreservedRecords(a: GedcomPreservedRecord, b: GedcomPreservedRecord): number {
  if (a.order !== b.order) return a.order - b.order;
  return (a.lines[0]?.level ?? 0) - (b.lines[0]?.level ?? 0);
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readRecordArray(value: unknown): GedcomPreservedRecord[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const record = readRecord(candidate);
        return record ? [record] : [];
      })
    : [];
}

function readRecord(value: unknown): GedcomPreservedRecord | null {
  const record = asObject(value);
  if (!Number.isFinite(record.order) || typeof record.tag !== "string" || !Array.isArray(record.lines)) {
    return null;
  }
  const lines = record.lines.flatMap((candidate) => {
    const line = readLine(candidate);
    return line ? [line] : [];
  });
  if (lines.length !== record.lines.length) return null;

  return {
    order: Number(record.order),
    pointer: typeof record.pointer === "string" ? record.pointer : null,
    tag: record.tag,
    value: typeof record.value === "string" ? record.value : "",
    lines,
  };
}

function readLine(value: unknown): GedcomPreservedLine | null {
  const line = asObject(value);
  if (!Number.isFinite(line.level) || typeof line.tag !== "string") return null;
  return {
    level: Number(line.level),
    pointer: typeof line.pointer === "string" ? line.pointer : null,
    tag: line.tag,
    value: typeof line.value === "string" ? line.value : "",
  };
}
