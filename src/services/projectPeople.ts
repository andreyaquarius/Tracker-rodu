import type {
  CustomFieldValues,
  Person,
  PersonRelation,
  ScanAttachment,
} from "../types";
import { getSupabaseClient } from "./supabaseAuth";
import {
  PERSON_EVENTS_META_KEY,
  normalizePersonEvents,
  stripInternalGeoFields,
  syncPersonEventsFromFields,
} from "../utils/geo";
import { normalizePersonStatus } from "../utils/personStatus.ts";
import { normalizePersonGender } from "../utils/personGender.ts";
import { normalizePersonRelation } from "../utils/personRelation.ts";
import {
  discardOptionalProjectCache,
  saveOptionalProjectCache,
} from "../utils/projectCache.ts";
import {
  selectRowsInParallel,
  type PagedRangeRequest,
} from "../utils/pagedRows.ts";
import {
  chunkPersonImportRows,
  chunkRelationImportRows,
  runAdaptiveImportBatch,
  runImportBatches,
  withImportPhase,
  type ImportPhaseProgressOptions,
} from "../utils/importBatches.ts";
import {
  PERSON_SCANS_METADATA_KEY,
  personPhotoMetadataForStorage,
  personPhotoStateFromMetadata,
} from "../utils/personPhotos.ts";
import { ProjectRecordConflictError } from "./projectConflicts.ts";
import {
  applyPersonPhotoBackups,
  type GedcomPhotoBackupPersistenceResult,
  type GedcomPhotoBackupReplacement,
} from "./gedcomPhotoBackup.ts";
import type { GedcomImportDatasetMarker } from "../utils/gedcomImportGroups.ts";

type PersonRow = {
  id: string;
  project_id: string;
  research_id: string | null;
  status: string;
  gender: string;
  surname: string;
  given_name: string;
  patronymic: string;
  full_name: string;
  name_variants: string;
  surname_variants: string;
  birth_date: string;
  birth_year_from: string;
  birth_year_to: string;
  birth_place: string;
  marriage_date: string;
  marriage_place: string;
  death_date: string;
  death_year_from: string;
  death_year_to: string;
  death_place: string;
  residence_places: string;
  social_status: string;
  religion: string;
  occupation: string;
  is_living: boolean;
  privacy_status: string;
  notes: string;
  custom_fields: unknown;
  created_at: string;
  updated_at: string;
};

type RelationRow = {
  id: string;
  project_id: string;
  person_id: string;
  related_person_id: string;
  relation_type: string;
  status: string;
  evidence_text: string;
  notes: string;
  import_source_key?: string;
  gedcom_metadata?: unknown;
  created_at: string;
  updated_at: string;
};

type PersonScanGroups = {
  birthScans: ScanAttachment[];
  marriageScans: ScanAttachment[];
  deathScans: ScanAttachment[];
  mentionScans: ScanAttachment[];
  photos: ScanAttachment[];
};

const PERSON_SELECT =
  "id, project_id, research_id, status, gender, surname, given_name, patronymic, full_name, name_variants, surname_variants, birth_date, birth_year_from, birth_year_to, birth_place, marriage_date, marriage_place, death_date, death_year_from, death_year_to, death_place, residence_places, social_status, religion, occupation, is_living, privacy_status, notes, custom_fields, created_at, updated_at";
const RELATION_SELECT =
  "id, project_id, person_id, related_person_id, relation_type, status, evidence_text, notes, import_source_key, gedcom_metadata, created_at, updated_at";
const LEGACY_RELATION_SELECT =
  "id, project_id, person_id, related_person_id, relation_type, status, evidence_text, notes, created_at, updated_at";
const SCANS_KEY = PERSON_SCANS_METADATA_KEY;
const MAIDEN_SURNAME_KEY = "__trackerRoduMaidenSurname";
const SELECT_BATCH_SIZE = 1000;
// Persons and relations are fetched together. One range at a time per table
// keeps the aggregate at two database statements instead of six competing
// offset scans, while still allowing both independent tables to load together.
const SELECT_CONCURRENCY_PER_TABLE = 1;
// Person upserts fan out into synchronous projection triggers. A single
// in-flight request avoids making three trigger-heavy statements compete for
// the same project, while adaptive splitting handles unusually expensive rows.
const PERSON_IMPORT_CONCURRENCY = 1;
// person_relations synchronously project into the canonical family graph via
// database triggers. Keep those batches ordered per browser; the database also
// serializes them per project to protect concurrent tabs and users.
const RELATION_IMPORT_CONCURRENCY = 1;
const PEOPLE_CACHE_MAX_CHARS = 3_500_000;
const PEOPLE_CACHE_MAX_RECORDS = 8_000;
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asScans(value: unknown): ScanAttachment[] {
  return Array.isArray(value) ? (value as ScanAttachment[]) : [];
}

function splitCustomFields(value: unknown): {
  customFields: CustomFieldValues;
  scans: PersonScanGroups;
  eventsRaw: unknown;
  maidenSurname: string;
  primaryPhotoId: string;
} {
  const record = asRecord(value);
  const scanRecord = asRecord(record[SCANS_KEY]);
  const photoState = personPhotoStateFromMetadata(scanRecord);
  const eventsRaw = record[PERSON_EVENTS_META_KEY];
  const maidenSurname = typeof record[MAIDEN_SURNAME_KEY] === "string" ? record[MAIDEN_SURNAME_KEY] : "";
  const customFields = { ...record };
  delete customFields[SCANS_KEY];
  delete customFields[PERSON_EVENTS_META_KEY];
  delete customFields[MAIDEN_SURNAME_KEY];
  return {
    customFields: stripInternalGeoFields(customFields as CustomFieldValues),
    scans: {
      birthScans: asScans(scanRecord.birthScans),
      marriageScans: asScans(scanRecord.marriageScans),
      deathScans: asScans(scanRecord.deathScans),
      mentionScans: asScans(scanRecord.mentionScans),
      photos: photoState.photos,
    },
    eventsRaw,
    maidenSurname,
    primaryPhotoId: photoState.primaryPhotoId,
  };
}

export function isMissingPersonRelationProvenanceColumnsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
  const description = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const mentionsProvenanceColumn = description.includes("import_source_key")
    || description.includes("gedcom_metadata");
  if (!mentionsProvenanceColumn) return false;
  return code === "42703"
    || code === "PGRST204"
    || description.includes("does not exist")
    || description.includes("schema cache");
}

function personFromRow(row: PersonRow): Person {
  const { customFields, scans, eventsRaw, maidenSurname, primaryPhotoId } = splitCustomFields(row.custom_fields);
  const person = {
    id: row.id,
    researchId: row.research_id ?? "",
    status: normalizePersonStatus(row.status),
    gender: normalizePersonGender(row.gender),
    surname: row.surname,
    maidenSurname,
    givenName: row.given_name,
    patronymic: row.patronymic,
    fullName: row.full_name,
    nameVariants: row.name_variants,
    surnameVariants: row.surname_variants,
    birthDate: row.birth_date,
    birthYearFrom: row.birth_year_from,
    birthYearTo: row.birth_year_to,
    birthPlace: row.birth_place,
    marriageDate: row.marriage_date,
    marriagePlace: row.marriage_place,
    deathDate: row.death_date,
    deathYearFrom: row.death_year_from,
    deathYearTo: row.death_year_to,
    deathPlace: row.death_place,
    residencePlaces: row.residence_places,
    socialStatus: row.social_status,
    religion: row.religion,
    occupation: row.occupation,
    isLiving: row.is_living ?? false,
    privacyStatus: normalizePersonPrivacyStatus(row.privacy_status),
    notes: row.notes,
    ...scans,
    primaryPhotoId: scans.photos.some((photo) => photo.id === primaryPhotoId)
      ? primaryPhotoId
      : scans.photos[0]?.id ?? "",
    customFields,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return {
    ...person,
    events: normalizePersonEvents(eventsRaw, person),
  };
}

function personToRow(projectId: string, person: Person, researchIds: Set<string>) {
  const composedFullName = [person.surname, person.givenName, person.patronymic]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ");
  return {
    id: person.id,
    project_id: projectId,
    research_id: researchIds.has(person.researchId) ? person.researchId : null,
    status: normalizePersonStatus(person.status),
    gender: normalizePersonGender(person.gender),
    surname: person.surname,
    given_name: person.givenName,
    patronymic: person.patronymic,
    full_name: composedFullName || person.fullName.trim(),
    name_variants: person.nameVariants,
    surname_variants: person.surnameVariants,
    birth_date: person.birthDate,
    birth_year_from: person.birthYearFrom,
    birth_year_to: person.birthYearTo,
    birth_place: person.birthPlace,
    marriage_date: person.marriageDate,
    marriage_place: person.marriagePlace,
    death_date: person.deathDate,
    death_year_from: person.deathYearFrom,
    death_year_to: person.deathYearTo,
    death_place: person.deathPlace,
    residence_places: person.residencePlaces,
    social_status: person.socialStatus,
    religion: person.religion,
    occupation: person.occupation,
    is_living: person.isLiving ?? false,
    privacy_status: normalizePersonPrivacyStatus(person.privacyStatus),
    notes: person.notes,
    custom_fields: {
      ...stripInternalGeoFields(person.customFields ?? {}),
      [MAIDEN_SURNAME_KEY]: person.maidenSurname?.trim() ?? "",
      [SCANS_KEY]: {
        birthScans: person.birthScans ?? [],
        marriageScans: person.marriageScans ?? [],
        deathScans: person.deathScans ?? [],
        mentionScans: person.mentionScans ?? [],
        ...personPhotoMetadataForStorage(person),
      },
      [PERSON_EVENTS_META_KEY]: syncPersonEventsFromFields(person),
    },
    created_at: person.createdAt,
    updated_at: person.updatedAt,
  };
}

function normalizePersonPrivacyStatus(value: unknown): Person["privacyStatus"] {
  return value === "project" || value === "public" || value === "confidential" ? value : "private";
}

function relationFromRow(row: RelationRow): PersonRelation {
  const metadata = asRecord(row.gedcom_metadata);
  const familyXref = typeof metadata.familyXref === "string" ? metadata.familyXref : "";
  const importSourceKey = typeof metadata.importSourceKey === "string"
    ? metadata.importSourceKey
    : row.import_source_key ?? "";
  return normalizePersonRelation({
    id: row.id,
    personId: row.person_id,
    relatedPersonId: row.related_person_id,
    relationType: row.relation_type as PersonRelation["relationType"],
    status: row.status as PersonRelation["status"],
    evidenceText: row.evidence_text,
    notes: row.notes,
    gedcomMetadata: familyXref || importSourceKey
      ? {
          familyXref,
          importSourceKey,
          importFileName: typeof metadata.importFileName === "string" ? metadata.importFileName : undefined,
          startDate: typeof metadata.startDate === "string" ? metadata.startDate : undefined,
          startPlace: typeof metadata.startPlace === "string" ? metadata.startPlace : undefined,
          endDate: typeof metadata.endDate === "string" ? metadata.endDate : undefined,
          endPlace: typeof metadata.endPlace === "string" ? metadata.endPlace : undefined,
          eventType: typeof metadata.eventType === "string" ? metadata.eventType : undefined,
          pedigree: typeof metadata.pedigree === "string" || metadata.pedigree === null
            ? metadata.pedigree
            : undefined,
          rawNotes: typeof metadata.rawNotes === "string" ? metadata.rawNotes : undefined,
        }
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function relationToRow(projectId: string, relation: PersonRelation) {
  const normalized = normalizePersonRelation(relation);
  return {
    id: normalized.id,
    project_id: projectId,
    person_id: normalized.personId,
    related_person_id: normalized.relatedPersonId,
    relation_type: normalized.relationType,
    status: normalized.status,
    evidence_text: normalized.evidenceText,
    notes: normalized.notes,
    import_source_key: normalized.gedcomMetadata?.importSourceKey?.trim() ?? "",
    gedcom_metadata: normalized.gedcomMetadata ?? {},
    created_at: normalized.createdAt,
    updated_at: normalized.updatedAt,
  };
}

function relationToLegacyRow(row: ReturnType<typeof relationToRow>) {
  return {
    id: row.id,
    project_id: row.project_id,
    person_id: row.person_id,
    related_person_id: row.related_person_id,
    relation_type: row.relation_type,
    status: row.status,
    evidence_text: row.evidence_text,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listProjectRelationRows(projectId: string): Promise<RelationRow[]> {
  const client = getSupabaseClient();
  const selectRows = (columns: string) => selectRowsInParallel<RelationRow>(
    () => client
      .from("person_relations")
      .select(columns)
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true }) as unknown as PagedRangeRequest<RelationRow>,
    SELECT_BATCH_SIZE,
    SELECT_CONCURRENCY_PER_TABLE,
  );

  try {
    return await selectRows(RELATION_SELECT);
  } catch (error) {
    if (!isMissingPersonRelationProvenanceColumnsError(error)) throw error;
    return selectRows(LEGACY_RELATION_SELECT);
  }
}

async function listProjectRelationRowsBetween(
  projectId: string,
  leftPersonId: string,
  rightPersonId: string,
): Promise<RelationRow[]> {
  const client = getSupabaseClient();
  const personIds = [leftPersonId, rightPersonId];
  const selectRows = (columns: string) => selectRowsInParallel<RelationRow>(
    () => client
      .from("person_relations")
      .select(columns)
      .eq("project_id", projectId)
      .in("person_id", personIds)
      .in("related_person_id", personIds)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true }) as unknown as PagedRangeRequest<RelationRow>,
    SELECT_BATCH_SIZE,
    SELECT_CONCURRENCY_PER_TABLE,
  );

  try {
    return await selectRows(RELATION_SELECT);
  } catch (error) {
    if (!isMissingPersonRelationProvenanceColumnsError(error)) throw error;
    return selectRows(LEGACY_RELATION_SELECT);
  }
}

export async function listProjectPeople(projectId: string): Promise<{
  persons: Person[];
  relations: PersonRelation[];
}> {
  const client = getSupabaseClient();
  const [personRows, relationRows] = await Promise.all([
    selectRowsInParallel<PersonRow>(
      () => client
        .from("persons")
        .select(PERSON_SELECT)
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true }),
      SELECT_BATCH_SIZE,
      SELECT_CONCURRENCY_PER_TABLE,
    ),
    listProjectRelationRows(projectId),
  ]);
  return {
    persons: personRows.map(personFromRow),
    relations: relationRows.map(relationFromRow),
  };
}

export async function getProjectPerson(
  projectId: string,
  personId: string,
): Promise<Person | null> {
  const { data, error } = await getSupabaseClient()
    .from("persons")
    .select(PERSON_SELECT)
    .eq("project_id", projectId)
    .eq("id", personId)
    .maybeSingle();
  if (error) throw error;
  return data ? personFromRow(data as PersonRow) : null;
}

export async function getProjectPersonRelation(
  projectId: string,
  relationId: string,
): Promise<PersonRelation | null> {
  const client = getSupabaseClient();
  const loadRelation = async (columns: string): Promise<RelationRow | null> => {
    const { data, error } = await client
      .from("person_relations")
      .select(columns)
      .eq("project_id", projectId)
      .eq("id", relationId)
      .maybeSingle();
    if (error) throw error;
    return data ? data as unknown as RelationRow : null;
  };

  try {
    const row = await loadRelation(RELATION_SELECT);
    return row ? relationFromRow(row) : null;
  } catch (error) {
    if (!isMissingPersonRelationProvenanceColumnsError(error)) throw error;
    const row = await loadRelation(LEGACY_RELATION_SELECT);
    return row ? relationFromRow(row) : null;
  }
}

/**
 * Reads the authoritative compatibility relations for one unordered person
 * pair. Family-tree mutations use this after changing canonical graph edges so
 * the Persons module and its local cache cannot retain an orphaned assertion.
 */
export async function listProjectPersonRelationsBetween(
  projectId: string,
  leftPersonId: string,
  rightPersonId: string,
): Promise<PersonRelation[]> {
  if (!leftPersonId || !rightPersonId || leftPersonId === rightPersonId) return [];
  const rows = await listProjectRelationRowsBetween(
    projectId,
    leftPersonId,
    rightPersonId,
  );
  return rows
    .filter((row) => isPersonRelationForPair(
      row.person_id,
      row.related_person_id,
      leftPersonId,
      rightPersonId,
    ))
    .map(relationFromRow);
}

function isPersonRelationForPair(
  personId: string,
  relatedPersonId: string,
  leftPersonId: string,
  rightPersonId: string,
): boolean {
  return (
    personId === leftPersonId && relatedPersonId === rightPersonId
  ) || (
    personId === rightPersonId && relatedPersonId === leftPersonId
  );
}

export async function importProjectPeople(
  projectId: string,
  persons: Person[],
  relations: PersonRelation[],
  researchIds: Set<string>,
  options: ImportPhaseProgressOptions = {},
): Promise<void> {
  const client = getSupabaseClient();
  const personRows = persons.map((person) => personToRow(projectId, person, researchIds));
  await runImportBatches(chunkPersonImportRows(personRows), async (batch) => {
    await runAdaptiveImportBatch(batch, async (items) => {
      const { error } = await client
        .from("persons")
        .upsert(items, { onConflict: "id" });
      if (error) throw error;
    });
  }, {
    concurrency: PERSON_IMPORT_CONCURRENCY,
    beforeBatch: options.beforeBatch,
    onProgress: withImportPhase("persons", options.onProgress),
  });
  const relationRows = relations.map((relation) => relationToRow(projectId, relation));
  let useLegacyRelationSchema = false;
  await runImportBatches(chunkRelationImportRows(relationRows), async (batch) => {
    await runAdaptiveImportBatch(batch, async (items) => {
      let { error } = await client
        .from("person_relations")
        .upsert(
          useLegacyRelationSchema ? items.map(relationToLegacyRow) : items,
          { onConflict: "id" },
        );
      if (error && !useLegacyRelationSchema && isMissingPersonRelationProvenanceColumnsError(error)) {
        useLegacyRelationSchema = true;
        ({ error } = await client
          .from("person_relations")
          .upsert(items.map(relationToLegacyRow), { onConflict: "id" }));
      }
      if (error) throw error;
    });
  }, {
    concurrency: RELATION_IMPORT_CONCURRENCY,
    beforeBatch: options.beforeBatch,
    onProgress: withImportPhase("relations", options.onProgress),
  });
}

export async function saveProjectPerson(
  projectId: string,
  person: Person,
  researchIds: Set<string>,
  expectedUpdatedAt?: string,
): Promise<Person> {
  const client = getSupabaseClient();
  const row = personToRow(projectId, person, researchIds);
  const result = expectedUpdatedAt
    ? await client
        .from("persons")
        .update(row)
        .eq("project_id", projectId)
        .eq("id", person.id)
        .eq("updated_at", expectedUpdatedAt)
        .select(PERSON_SELECT)
        .maybeSingle()
    : await client
        .from("persons")
        .insert(row)
        .select(PERSON_SELECT)
        .single();
  const { data, error } = result;
  if (error) throw error;
  if (!data) throw new ProjectRecordConflictError();
  return personFromRow(data as PersonRow);
}

/**
 * Patches only the photo gallery against the latest server row. This keeps a
 * long Drive copy operation from overwriting profile fields edited meanwhile.
 */
export async function saveProjectPersonPhotoBackups(
  projectId: string,
  personId: string,
  replacements: readonly GedcomPhotoBackupReplacement[],
): Promise<GedcomPhotoBackupPersistenceResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await getProjectPerson(projectId, personId);
    if (!current) {
      throw new Error("Особу для прив’язування фотографій не знайдено.");
    }
    const applied = applyPersonPhotoBackups(current, replacements);
    if (applied.person === current) return applied;
    try {
      const saved = await saveProjectPerson(
        projectId,
        applied.person,
        new Set(current.researchId ? [current.researchId] : []),
        current.updatedAt,
      );
      return { ...applied, person: saved };
    } catch (error) {
      if (error instanceof ProjectRecordConflictError && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Не вдалося оновити фотографії через паралельне редагування особи.");
}

export async function deleteProjectPerson(projectId: string, personId: string): Promise<void> {
  await deleteProjectPersons(projectId, [personId]);
}

export interface ProjectPersonDeletionResult {
  deletedPersons: number;
  deletedRelations: number;
  deletedFindings: number;
}

export async function deleteProjectPersons(
  projectId: string,
  personIds: readonly string[],
): Promise<ProjectPersonDeletionResult> {
  const uniqueIds = [...new Set(personIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return { deletedPersons: 0, deletedRelations: 0, deletedFindings: 0 };
  const { data, error } = await getSupabaseClient().rpc("delete_project_persons", {
    target_project_id: projectId,
    target_person_ids: uniqueIds,
  });
  if (error) throw projectPersonDeletionError(error);
  const result = parseProjectPersonDeletionResult(data);
  if (result.deletedPersons !== uniqueIds.length) {
    throw new Error("Не всі вибрані особи були видалені. Оновіть сторінку та повторіть спробу.");
  }
  return result;
}

export async function deleteProjectGedcomPersons(
  projectId: string,
  sourceKey: string,
): Promise<ProjectPersonDeletionResult> {
  const normalizedSourceKey = sourceKey.trim();
  if (!normalizedSourceKey) throw new Error("Не вказано GEDCOM-імпорт для видалення.");
  const { data, error } = await getSupabaseClient().rpc("delete_project_gedcom_persons", {
    target_project_id: projectId,
    target_source_key: normalizedSourceKey,
  });
  if (error) throw projectPersonDeletionError(error);
  return parseProjectPersonDeletionResult(data);
}

export async function listProjectGedcomImportDatasets(
  projectId: string,
): Promise<GedcomImportDatasetMarker[]> {
  const { data, error } = await getSupabaseClient().rpc("list_project_gedcom_import_datasets", {
    target_project_id: projectId,
  });
  if (error) throw error;
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const sourceKey = typeof record.sourceKey === "string" ? record.sourceKey.trim() : "";
    if (!sourceKey) return [];
    return [{
      sourceKey,
      importedAt: typeof record.importedAt === "string" ? record.importedAt : "",
    }];
  });
}

function projectPersonDeletionError(error: unknown): Error {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  if (message.includes("PERSON_IS_TREE_ROOT")) {
    return new Error(
      "Ця особа є кореневою в одному з родових дерев. Спочатку виберіть для цього дерева іншу кореневу особу або видаліть саме дерево.",
    );
  }
  if (message.includes("PROJECT_GEDCOM_OPERATION_ACTIVE")) {
    return new Error("Зачекайте завершення поточного GEDCOM-імпорту або відкату та повторіть дію.");
  }
  if (message.includes("PERSON_DELETE_TARGET_MISMATCH")) {
    return new Error("Список осіб змінився. Оновіть сторінку, перевірте вибір і повторіть видалення.");
  }
  return error instanceof Error ? error : new Error(message || "Не вдалося видалити особу.");
}

function parseProjectPersonDeletionResult(value: unknown): ProjectPersonDeletionResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const deletedPersons = Number(record.deletedPersons ?? 0);
  const deletedRelations = Number(record.deletedRelations ?? 0);
  const deletedFindings = Number(record.deletedFindings ?? 0);
  return {
    deletedPersons: Number.isFinite(deletedPersons) && deletedPersons >= 0 ? deletedPersons : 0,
    deletedRelations: Number.isFinite(deletedRelations) && deletedRelations >= 0 ? deletedRelations : 0,
    deletedFindings: Number.isFinite(deletedFindings) && deletedFindings >= 0 ? deletedFindings : 0,
  };
}

export async function saveProjectPersonRelation(
  projectId: string,
  relation: PersonRelation,
): Promise<PersonRelation> {
  const client = getSupabaseClient();
  const row = relationToRow(projectId, relation);
  const { data, error } = await client
    .from("person_relations")
    .upsert(row, { onConflict: "id" })
    .select(RELATION_SELECT)
    .single();
  if (!error) return relationFromRow(data as RelationRow);
  if (!isMissingPersonRelationProvenanceColumnsError(error)) throw error;

  const { data: legacyData, error: legacyError } = await client
    .from("person_relations")
    .upsert(relationToLegacyRow(row), { onConflict: "id" })
    .select(LEGACY_RELATION_SELECT)
    .single();
  if (legacyError) throw legacyError;
  return relationFromRow(legacyData as RelationRow);
}

export async function deleteProjectPersonRelation(
  projectId: string,
  relationId: string,
): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("person_relations")
    .delete()
    .eq("project_id", projectId)
    .eq("id", relationId);
  if (error) throw error;
}

const CACHE_PREFIX = "tracker-rodu-project-people:";

export function loadProjectPeopleCache(projectId: string): {
  persons: Person[];
  relations: PersonRelation[];
} {
  try {
    const stored = localStorage.getItem(`${CACHE_PREFIX}${projectId}`);
    if (!stored) return { persons: [], relations: [] };
    const parsed = JSON.parse(stored) as { persons?: unknown; relations?: unknown };
    return {
      persons: Array.isArray(parsed.persons)
        ? (parsed.persons as Person[]).map((person) => ({
            ...person,
            status: normalizePersonStatus(person.status),
            gender: normalizePersonGender(person.gender),
          }))
        : [],
      relations: Array.isArray(parsed.relations)
        ? (parsed.relations as PersonRelation[]).map(normalizePersonRelation)
        : [],
    };
  } catch {
    return { persons: [], relations: [] };
  }
}

export function saveProjectPeopleCache(
  projectId: string,
  persons: Person[],
  relations: PersonRelation[],
): void {
  const key = `${CACHE_PREFIX}${projectId}`;
  if (persons.length + relations.length > PEOPLE_CACHE_MAX_RECORDS) {
    discardOptionalProjectCache(key);
    return;
  }
  const normalizedPersons = persons.map((person) => ({
    ...person,
    status: normalizePersonStatus(person.status),
    gender: normalizePersonGender(person.gender),
  }));
  const normalizedRelations = relations.map(normalizePersonRelation);
  saveOptionalProjectCache(
    key,
    { persons: normalizedPersons, relations: normalizedRelations },
    PEOPLE_CACHE_MAX_CHARS,
  );
}

export function clearProjectPeopleCache(projectId: string): void {
  localStorage.removeItem(`${CACHE_PREFIX}${projectId}`);
}
