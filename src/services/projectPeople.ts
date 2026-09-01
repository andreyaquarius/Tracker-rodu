import type {
  CustomFieldValues,
  Person,
  PersonNameType,
  PersonRelation,
  ScanAttachment,
} from "../types";
import type { GedcomImportNameDraft } from "../types/familyTree.ts";
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
import {
  GEDCOM_STRUCTURED_NAMES_CUSTOM_FIELD,
  parseGedcomStructuredNamesPayload,
  stableGedcomPersonNameImportId,
} from "../utils/gedcomAppImport.ts";
import {
  GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD,
  GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD,
  GEDCOM_XREF_CUSTOM_FIELD,
} from "../utils/gedcomMetadata.ts";
import { isDatabaseStatementTimeout } from "../utils/databaseErrors.ts";

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

export interface ProjectPeopleImportOptions extends ImportPhaseProgressOptions {
  /**
   * Full project backups restore their authoritative `personNames` collection
   * separately. Replaying transient GEDCOM metadata in that case would create
   * a second copy of the same source spellings.
   */
  importStructuredPersonNames?: boolean;
}

type GedcomPersonNameImportRow = {
  id: string;
  project_id: string;
  person_id: string;
  name_type: PersonNameType;
  language_code: string;
  script_code: string;
  surname: string;
  given_name: string;
  patronymic: string;
  full_name: string;
  original_text: string;
  is_primary: false;
  is_preferred: false;
  evidence_status: "unknown";
  confidence: 50;
  source_document_id: null;
  source_finding_id: null;
  notes: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  maiden_surname: string;
  prefix: string;
  suffix: string;
  nickname: string;
  full_normalized: string;
  orthography: string;
  valid_from: null;
  valid_to: null;
  date_precision: "unknown";
  is_searchable: true;
  source_type: "gedcom";
  source_id: null;
  citation_id: null;
  document_fragment_id: null;
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
const PERSON_NAME_V2_METADATA_KEY = "tracker_person_name_v2";
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
  delete customFields[GEDCOM_STRUCTURED_NAMES_CUSTOM_FIELD];
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
  const persistedCustomFields = {
    ...stripInternalGeoFields(person.customFields ?? {}),
  };
  delete persistedCustomFields[GEDCOM_STRUCTURED_NAMES_CUSTOM_FIELD];
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
      ...persistedCustomFields,
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

/**
 * Builds non-primary source rows only. The persons projection trigger owns the
 * single canonical primary row, including for GEDCOM's primary NAME value.
 */
export function buildGedcomPersonNameImportRows(
  projectId: string,
  persons: readonly Person[],
  idFactory?: () => string,
): GedcomPersonNameImportRow[] {
  return persons.flatMap((person) => {
    const names = parseGedcomStructuredNamesPayload(
      person.customFields?.[GEDCOM_STRUCTURED_NAMES_CUSTOM_FIELD],
    );
    const gedcomXref = customFieldString(person, GEDCOM_XREF_CUSTOM_FIELD);
    const importSourceKey = customFieldString(person, GEDCOM_IMPORT_SOURCE_KEY_CUSTOM_FIELD);
    const importFileName = customFieldString(person, GEDCOM_IMPORT_FILE_NAME_CUSTOM_FIELD);
    return names.map((name, index) => {
      const nameType = personNameTypeFromGedcom(name.nameType);
      const maidenSurname = name.nameType === "maiden" ? name.surname : "";
      const nickname = name.nickname ?? "";
      const fullName = name.fullName
        || [name.surname, name.givenName, name.patronymic].filter(Boolean).join(" ");
      return {
        id: idFactory?.() ?? stableGedcomPersonNameImportId({
          projectId,
          personId: person.id,
          importSourceKey,
          gedcomXref,
          nameIndex: index,
          name,
        }),
        project_id: projectId,
        person_id: person.id,
        name_type: nameType,
        language_code: name.languageCode ?? "",
        script_code: name.scriptCode ?? "",
        surname: name.surname,
        given_name: name.givenName,
        patronymic: name.patronymic,
        full_name: fullName,
        // Keep the exact spelling from the GEDCOM line. Never normalize it.
        original_text: name.originalText,
        is_primary: false,
        is_preferred: false,
        evidence_status: "unknown",
        confidence: 50,
        source_document_id: null,
        source_finding_id: null,
        notes: "",
        metadata: {
          source: "gedcom_import",
          originalNameType: name.nameType,
          gedcomXref,
          gedcomNameIndex: index,
          importSourceKey,
          importFileName,
          [PERSON_NAME_V2_METADATA_KEY]: {
            nameType,
            maidenSurname,
            prefix: "",
            suffix: "",
            nickname,
            fullNormalized: fullName,
            orthography: name.orthography ?? "",
            validFrom: "",
            validTo: "",
            datePrecision: "unknown",
            isSearchable: true,
            sourceType: "gedcom",
            sourceId: null,
            citationId: null,
            documentFragmentId: null,
          },
        },
        created_at: person.createdAt,
        updated_at: person.updatedAt,
        maiden_surname: maidenSurname,
        prefix: "",
        suffix: "",
        nickname,
        full_normalized: fullName,
        orthography: name.orthography ?? "",
        valid_from: null,
        valid_to: null,
        date_precision: "unknown",
        is_searchable: true,
        source_type: "gedcom",
        source_id: null,
        citation_id: null,
        document_fragment_id: null,
      };
    });
  });
}

function personNameTypeFromGedcom(value: GedcomImportNameDraft["nameType"]): PersonNameType {
  return value === "primary" ? "document" : value;
}

function legacyPersonNameStorageType(value: PersonNameType): string {
  if ([
    "primary",
    "birth",
    "married",
    "alias",
    "original",
    "transliteration",
    "religious",
    "patronymic_variant",
    "surname_variant",
    "other",
  ].includes(value)) return value;
  if (value === "document" || value === "source_error") return "original";
  if (value === "maiden" || value === "previous") return "surname_variant";
  if (value === "nickname") return "alias";
  return "other";
}

function legacyGedcomPersonNameRow(row: GedcomPersonNameImportRow): Record<string, unknown> {
  const legacy = { ...row } as Record<string, unknown>;
  for (const column of [
    "maiden_surname",
    "prefix",
    "suffix",
    "nickname",
    "full_normalized",
    "orthography",
    "valid_from",
    "valid_to",
    "date_precision",
    "is_searchable",
    "source_type",
    "source_id",
    "citation_id",
    "document_fragment_id",
  ]) {
    delete legacy[column];
  }
  legacy.name_type = legacyPersonNameStorageType(row.name_type);
  return legacy;
}

function customFieldString(person: Person, key: string): string {
  const value = person.customFields?.[key];
  return typeof value === "string" ? value : "";
}

export function isMissingHistoricalPersonNameColumnsError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code.toUpperCase() : "";
  const description = [record.message, record.details, record.hint]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  const historicalColumns = [
    "maiden_surname",
    "prefix",
    "suffix",
    "nickname",
    "full_normalized",
    "orthography",
    "valid_from",
    "valid_to",
    "date_precision",
    "is_searchable",
    "source_type",
    "source_id",
    "citation_id",
    "document_fragment_id",
  ];
  return (code === "42703" || code === "PGRST204" || description.includes("schema cache"))
    && historicalColumns.some((column) => description.includes(column));
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

async function listProjectRelationRowsForPerson(
  projectId: string,
  personId: string,
): Promise<RelationRow[]> {
  const client = getSupabaseClient();
  const selectRows = async (columns: string): Promise<RelationRow[]> => {
    const [outgoing, incoming] = await Promise.all([
      selectRowsInParallel<RelationRow>(
        () => client
          .from("person_relations")
          .select(columns)
          .eq("project_id", projectId)
          .eq("person_id", personId)
          .order("updated_at", { ascending: false })
          .order("id", { ascending: true }) as unknown as PagedRangeRequest<RelationRow>,
        SELECT_BATCH_SIZE,
        SELECT_CONCURRENCY_PER_TABLE,
      ),
      selectRowsInParallel<RelationRow>(
        () => client
          .from("person_relations")
          .select(columns)
          .eq("project_id", projectId)
          .eq("related_person_id", personId)
          .order("updated_at", { ascending: false })
          .order("id", { ascending: true }) as unknown as PagedRangeRequest<RelationRow>,
        SELECT_BATCH_SIZE,
        SELECT_CONCURRENCY_PER_TABLE,
      ),
    ]);
    return [...new Map(
      [...outgoing, ...incoming].map((row) => [row.id, row]),
    ).values()];
  };

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

/**
 * Reads the complete compatibility-relation snapshot for one person. This is
 * intentionally narrower than listProjectPeople so a newly created tree card
 * can become available in the Persons module without reloading a large tree.
 */
export async function listProjectPersonRelationsForPerson(
  projectId: string,
  personId: string,
): Promise<PersonRelation[]> {
  const normalizedPersonId = personId.trim();
  if (!normalizedPersonId) return [];
  return (await listProjectRelationRowsForPerson(projectId, normalizedPersonId))
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
  options: ProjectPeopleImportOptions = {},
): Promise<void> {
  const client = getSupabaseClient();
  const personRows = persons.map((person) => personToRow(projectId, person, researchIds));
  const personNameRows = options.importStructuredPersonNames === false
    ? []
    : buildGedcomPersonNameImportRows(projectId, persons);
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
  // Person upserts run first so their projection trigger creates the one
  // canonical primary row before any GEDCOM spellings are added.
  let useLegacyPersonNameSchema = false;
  await runImportBatches(chunkPersonImportRows(personNameRows), async (batch) => {
    await runAdaptiveImportBatch(batch, async (items) => {
      let { error } = await client
        .from("person_names")
        .upsert(
          useLegacyPersonNameSchema ? items.map(legacyGedcomPersonNameRow) : items,
          { onConflict: "id", ignoreDuplicates: true },
        );
      if (error && !useLegacyPersonNameSchema && isMissingHistoricalPersonNameColumnsError(error)) {
        useLegacyPersonNameSchema = true;
        ({ error } = await client
          .from("person_names")
          .upsert(items.map(legacyGedcomPersonNameRow), {
            onConflict: "id",
            ignoreDuplicates: true,
          }));
      }
      if (error) throw error;
    });
  }, {
    concurrency: PERSON_IMPORT_CONCURRENCY,
    beforeBatch: options.beforeBatch,
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

export type ProjectGedcomDeletionStatus = "pending" | "running" | "failed" | "completed";
export type ProjectGedcomDeletionPhase =
  | "relations"
  | "findings"
  | "trees"
  | "archives"
  | "persons"
  | "finalize"
  | "completed";

export interface ProjectGedcomDeletionProgress extends ProjectPersonDeletionResult {
  jobId: string;
  projectId: string;
  sourceKey: string;
  status: ProjectGedcomDeletionStatus;
  phase: ProjectGedcomDeletionPhase;
  totalPersons: number;
  processedPersons: number;
  remainingPersons: number;
  lastError: string;
  lastErrorCode: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
  done: boolean;
  retryable: boolean;
}

export interface ProjectGedcomDeletionOptions {
  batchSize?: number;
  maxContinuationCalls?: number;
  maxRunTimeMs?: number;
  maxTransientRetries?: number;
  retryDelayMs?: number;
  onProgress?: (progress: ProjectGedcomDeletionProgress) => void;
}

type ProjectGedcomDeletionRpc = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

type ProjectGedcomDeletionProgressListener = (
  progress: ProjectGedcomDeletionProgress,
) => void;

const PROJECT_GEDCOM_DELETION_BATCH_SIZE = 50;
const PROJECT_GEDCOM_DELETION_MAX_CONTINUATIONS = 500;
const PROJECT_GEDCOM_DELETION_MAX_RUN_TIME_MS = 4 * 60_000;
const PROJECT_GEDCOM_DELETION_MAX_TRANSIENT_RETRIES = 3;
const PROJECT_GEDCOM_DELETION_RETRY_DELAY_MS = 250;
const projectGedcomDeletionInFlight = new Map<string, Promise<ProjectPersonDeletionResult>>();
const projectGedcomDeletionProgressListeners = new Set<ProjectGedcomDeletionProgressListener>();

export function subscribeProjectGedcomDeletionProgress(
  listener: ProjectGedcomDeletionProgressListener,
): () => void {
  projectGedcomDeletionProgressListeners.add(listener);
  return () => projectGedcomDeletionProgressListeners.delete(listener);
}

export interface ProjectPersonRootRequirement {
  treeId: string;
  treeTitle: string;
  rootPersonId: string;
  remainingMemberCount: number;
  requiresReplacement: boolean;
}

export interface ProjectPersonRootReplacement {
  treeId: string;
  personId: string;
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

export async function listProjectPersonRootRequirements(
  projectId: string,
  personIds: readonly string[],
): Promise<ProjectPersonRootRequirement[]> {
  const uniqueIds = [...new Set(personIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const { data, error } = await getSupabaseClient().rpc(
    "list_project_person_root_requirements",
    {
      target_project_id: projectId,
      target_person_ids: uniqueIds,
    },
  );
  if (error) throw projectPersonDeletionError(error);
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const treeId = typeof record.treeId === "string" ? record.treeId.trim() : "";
    const rootPersonId = typeof record.rootPersonId === "string"
      ? record.rootPersonId.trim()
      : "";
    if (!treeId || !rootPersonId) return [];
    const remainingMemberCount = Number(record.remainingMemberCount ?? 0);
    return [{
      treeId,
      treeTitle: typeof record.treeTitle === "string" ? record.treeTitle.trim() : "",
      rootPersonId,
      remainingMemberCount: Number.isFinite(remainingMemberCount) && remainingMemberCount > 0
        ? Math.floor(remainingMemberCount)
        : 0,
      requiresReplacement: record.requiresReplacement === true,
    }];
  });
}

export async function replaceTreeRootsAndDeleteProjectPersons(
  projectId: string,
  personIds: readonly string[],
  replacements: readonly ProjectPersonRootReplacement[],
): Promise<ProjectPersonDeletionResult> {
  const uniqueIds = [...new Set(personIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) return { deletedPersons: 0, deletedRelations: 0, deletedFindings: 0 };
  const rootReplacements = Object.fromEntries(
    replacements
      .map((replacement) => [replacement.treeId.trim(), replacement.personId.trim()] as const)
      .filter(([treeId, personId]) => treeId && personId),
  );
  const { data, error } = await getSupabaseClient().rpc(
    "replace_tree_roots_and_delete_project_persons",
    {
      target_project_id: projectId,
      target_person_ids: uniqueIds,
      root_replacements: rootReplacements,
    },
  );
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
  options: ProjectGedcomDeletionOptions = {},
): Promise<ProjectPersonDeletionResult> {
  const normalizedSourceKey = sourceKey.trim();
  if (!normalizedSourceKey) throw new Error("Не вказано GEDCOM-імпорт для видалення.");
  const client = getSupabaseClient();
  return runProjectGedcomDeletionRpc(
    (functionName, args) => client.rpc(functionName, args),
    projectId,
    normalizedSourceKey,
    options,
  );
}

/**
 * Drives the resumable server-side GEDCOM deletion one bounded batch at a
 * time. The module-level promise fence is synchronous, so two components in
 * the same browser cannot start duplicate continuation loops for one dataset.
 * Server-side idempotency and advisory locks provide the cross-tab fence.
 */
export function runProjectGedcomDeletionRpc(
  rpc: ProjectGedcomDeletionRpc,
  projectId: string,
  sourceKey: string,
  options: ProjectGedcomDeletionOptions = {},
): Promise<ProjectPersonDeletionResult> {
  const normalizedProjectId = projectId.trim();
  const normalizedSourceKey = sourceKey.trim();
  if (!normalizedProjectId) return Promise.reject(new Error("Не вказано проєкт для видалення GEDCOM."));
  if (!normalizedSourceKey) return Promise.reject(new Error("Не вказано GEDCOM-імпорт для видалення."));
  const operationKey = `${normalizedProjectId}\u001f${normalizedSourceKey}`;
  const active = projectGedcomDeletionInFlight.get(operationKey);
  if (active) return active;

  let operation: Promise<ProjectPersonDeletionResult>;
  operation = executeProjectGedcomDeletion(
    rpc,
    normalizedProjectId,
    normalizedSourceKey,
    options,
  ).finally(() => {
    if (projectGedcomDeletionInFlight.get(operationKey) === operation) {
      projectGedcomDeletionInFlight.delete(operationKey);
    }
  });
  projectGedcomDeletionInFlight.set(operationKey, operation);
  return operation;
}

async function executeProjectGedcomDeletion(
  rpc: ProjectGedcomDeletionRpc,
  projectId: string,
  sourceKey: string,
  options: ProjectGedcomDeletionOptions,
): Promise<ProjectPersonDeletionResult> {
  const requestedBatchSize = boundedInteger(options.batchSize, 1, 100, PROJECT_GEDCOM_DELETION_BATCH_SIZE);
  const maxContinuationCalls = boundedInteger(
    options.maxContinuationCalls,
    1,
    PROJECT_GEDCOM_DELETION_MAX_CONTINUATIONS,
    PROJECT_GEDCOM_DELETION_MAX_CONTINUATIONS,
  );
  const maxTransientRetries = boundedInteger(
    options.maxTransientRetries,
    0,
    10,
    PROJECT_GEDCOM_DELETION_MAX_TRANSIENT_RETRIES,
  );
  const retryDelayMs = boundedInteger(
    options.retryDelayMs,
    0,
    5_000,
    PROJECT_GEDCOM_DELETION_RETRY_DELAY_MS,
  );
  const maxRunTimeMs = boundedInteger(
    options.maxRunTimeMs,
    1_000,
    30 * 60_000,
    PROJECT_GEDCOM_DELETION_MAX_RUN_TIME_MS,
  );
  const startedAt = Date.now();
  let currentBatchSize = requestedBatchSize;
  let successfulBatchesAtCurrentSize = 0;

  let progress = await startProjectGedcomDeletion(
    rpc,
    projectId,
    sourceKey,
    maxTransientRetries,
    retryDelayMs,
  );
  assertProjectGedcomDeletionScope(progress, projectId, sourceKey);
  reportProjectGedcomDeletionProgress(progress, options.onProgress);

  let transientFailures = 0;
  let retryableFailures = 0;
  for (let continuation = 0; continuation < maxContinuationCalls; continuation += 1) {
    if (progress.done || progress.status === "completed") {
      return projectGedcomDeletionResult(progress);
    }
    if (progress.status === "failed") {
      if (!progress.retryable) throw projectGedcomDeletionFailure(progress);
      if (isTransientProjectGedcomDeletionProgress(progress)) {
        currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
        successfulBatchesAtCurrentSize = 0;
      }
      retryableFailures += 1;
      if (retryableFailures > maxTransientRetries) {
        throw projectGedcomDeletionFailure(progress, true);
      }
    } else {
      retryableFailures = 0;
    }

    if (Date.now() - startedAt >= maxRunTimeMs) {
      throw new Error(
        "Видалення GEDCOM ще триває. Прогрес збережено — натисніть видалення набору ще раз, щоб безпечно продовжити.",
      );
    }

    try {
      progress = await callProjectGedcomDeletionRpc(
        rpc,
        "continue_project_gedcom_deletion",
        {
          target_job_id: progress.jobId,
          batch_size: currentBatchSize,
        },
      );
      assertProjectGedcomDeletionScope(progress, projectId, sourceKey);
      transientFailures = 0;
      successfulBatchesAtCurrentSize += 1;
      if (successfulBatchesAtCurrentSize >= 3 && currentBatchSize < requestedBatchSize) {
        currentBatchSize = Math.min(requestedBatchSize, currentBatchSize + 5);
        successfulBatchesAtCurrentSize = 0;
      }
      reportProjectGedcomDeletionProgress(progress, options.onProgress);
    } catch (error) {
      if (!isTransientProjectGedcomDeletionError(error)) {
        throw projectPersonDeletionError(error);
      }
      transientFailures += 1;
      currentBatchSize = Math.max(1, Math.floor(currentBatchSize / 2));
      successfulBatchesAtCurrentSize = 0;
      const reconciled = await readProjectGedcomDeletionAfterFailure(
        rpc,
        progress.jobId,
        projectId,
        sourceKey,
      );
      if (reconciled) {
        progress = reconciled;
        reportProjectGedcomDeletionProgress(progress, options.onProgress);
        if (progress.done || progress.status === "completed") {
          return projectGedcomDeletionResult(progress);
        }
      }
      if (transientFailures > maxTransientRetries) {
        throw new Error(
          "Сервер не встиг продовжити видалення GEDCOM. Прогрес збережено — повторіть дію, і видалення продовжиться з безпечного місця.",
          { cause: error },
        );
      }
      await waitForProjectGedcomDeletionRetry(retryDelayMs * (2 ** (transientFailures - 1)));
    }
    await waitForProjectGedcomDeletionRetry(0);
  }

  throw new Error(
    "Видалення GEDCOM потребує надто багато кроків. Прогрес збережено — повторіть дію, щоб продовжити.",
  );
}

async function startProjectGedcomDeletion(
  rpc: ProjectGedcomDeletionRpc,
  projectId: string,
  sourceKey: string,
  maxTransientRetries: number,
  retryDelayMs: number,
): Promise<ProjectGedcomDeletionProgress> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxTransientRetries; attempt += 1) {
    try {
      return await callProjectGedcomDeletionRpc(
        rpc,
        "start_project_gedcom_deletion",
        {
          target_project_id: projectId,
          target_source_key: sourceKey,
        },
      );
    } catch (error) {
      lastError = error;
      if (!isTransientProjectGedcomDeletionError(error) || attempt >= maxTransientRetries) {
        throw projectPersonDeletionError(error);
      }
      await waitForProjectGedcomDeletionRetry(retryDelayMs * (2 ** attempt));
    }
  }
  throw projectPersonDeletionError(lastError);
}

async function readProjectGedcomDeletionAfterFailure(
  rpc: ProjectGedcomDeletionRpc,
  jobId: string,
  projectId: string,
  sourceKey: string,
): Promise<ProjectGedcomDeletionProgress | null> {
  try {
    const progress = await callProjectGedcomDeletionRpc(
      rpc,
      "get_project_gedcom_deletion",
      { target_job_id: jobId },
    );
    assertProjectGedcomDeletionScope(progress, projectId, sourceKey);
    return progress;
  } catch {
    return null;
  }
}

async function callProjectGedcomDeletionRpc(
  rpc: ProjectGedcomDeletionRpc,
  functionName: string,
  args: Record<string, unknown>,
): Promise<ProjectGedcomDeletionProgress> {
  const { data, error } = await rpc(functionName, args);
  if (error) throw error;
  return parseProjectGedcomDeletionProgress(data);
}

export function parseProjectGedcomDeletionProgress(
  value: unknown,
): ProjectGedcomDeletionProgress {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const status = deletionText(record, "status") as ProjectGedcomDeletionStatus;
  const phase = deletionText(record, "phase") as ProjectGedcomDeletionPhase;
  const progress: ProjectGedcomDeletionProgress = {
    jobId: deletionText(record, "jobId", "job_id"),
    projectId: deletionText(record, "projectId", "project_id"),
    sourceKey: deletionText(record, "sourceKey", "source_key"),
    status,
    phase,
    totalPersons: deletionCount(record, "totalPersons", "total_persons"),
    processedPersons: deletionCount(record, "processedPersons", "processed_persons"),
    remainingPersons: deletionCount(record, "remainingPersons", "remaining_persons"),
    deletedPersons: deletionCount(record, "deletedPersons", "deleted_persons"),
    deletedRelations: deletionCount(record, "deletedRelations", "deleted_relations"),
    deletedFindings: deletionCount(record, "deletedFindings", "deleted_findings"),
    lastError: deletionText(record, "lastError", "last_error"),
    lastErrorCode: deletionText(record, "lastErrorCode", "last_error_code"),
    createdAt: deletionText(record, "createdAt", "created_at"),
    updatedAt: deletionText(record, "updatedAt", "updated_at"),
    completedAt: deletionText(record, "completedAt", "completed_at"),
    done: deletionBoolean(record, "done"),
    retryable: deletionBoolean(record, "retryable"),
  };
  if (
    !progress.jobId
    || !progress.projectId
    || !progress.sourceKey
    || !["pending", "running", "failed", "completed"].includes(status)
    || !["relations", "findings", "trees", "archives", "persons", "finalize", "completed"].includes(phase)
  ) {
    throw new Error("Сервер повернув некоректний стан видалення GEDCOM.");
  }
  return progress;
}

function assertProjectGedcomDeletionScope(
  progress: ProjectGedcomDeletionProgress,
  projectId: string,
  sourceKey: string,
): void {
  if (progress.projectId !== projectId || progress.sourceKey !== sourceKey) {
    throw new Error("Сервер повернув стан іншого GEDCOM-набору. Оновіть сторінку та повторіть дію.");
  }
}

function projectGedcomDeletionResult(
  progress: ProjectGedcomDeletionProgress,
): ProjectPersonDeletionResult {
  return {
    deletedPersons: progress.deletedPersons,
    deletedRelations: progress.deletedRelations,
    deletedFindings: progress.deletedFindings,
  };
}

function projectGedcomDeletionFailure(
  progress: ProjectGedcomDeletionProgress,
  retriesExhausted = false,
): Error {
  const detail = progress.lastError.trim();
  if (retriesExhausted) {
    return new Error(
      detail
        ? `Не вдалося продовжити видалення GEDCOM: ${detail}. Прогрес збережено; повторіть дію пізніше.`
        : "Не вдалося продовжити видалення GEDCOM. Прогрес збережено; повторіть дію пізніше.",
    );
  }
  return new Error(detail || "Не вдалося завершити видалення GEDCOM.");
}

function isTransientProjectGedcomDeletionProgress(
  progress: ProjectGedcomDeletionProgress,
): boolean {
  const code = progress.lastErrorCode.trim().toLocaleUpperCase();
  if (code === "57014") return true;
  return /timeout|timed out|statement timeout/i.test(progress.lastError);
}

function reportProjectGedcomDeletionProgress(
  progress: ProjectGedcomDeletionProgress,
  listener?: ProjectGedcomDeletionProgressListener,
): void {
  try {
    listener?.(progress);
  } catch {
    // Progress rendering must never interrupt a durable deletion operation.
  }
  for (const subscribed of projectGedcomDeletionProgressListeners) {
    try {
      subscribed(progress);
    } catch {
      // Keep other UI subscribers and the server loop alive.
    }
  }
}

function isTransientProjectGedcomDeletionError(error: unknown): boolean {
  if (isDatabaseStatementTimeout(error)) return true;
  const record = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const code = String(record.code ?? "").trim().toLocaleUpperCase();
  if (["57014", "40001", "40P01", "55P03"].includes(code)) return true;
  const status = Number(record.status ?? record.statusCode);
  if (Number.isFinite(status) && status >= 500 && status <= 599) return true;
  const text = [
    error instanceof Error ? error.message : error,
    record.code,
    record.message,
    record.details,
    record.hint,
  ].filter((part) => typeof part === "string").join(" ").toLocaleLowerCase();
  return text.includes("failed to fetch")
    || text.includes("fetch failed")
    || text.includes("network request failed")
    || text.includes("connection reset")
    || text.includes("bad gateway")
    || text.includes("gateway timeout")
    || text.includes("service unavailable");
}

function deletionText(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey = camelKey,
): string {
  const value = record[camelKey] ?? record[snakeKey];
  return typeof value === "string" ? value.trim() : "";
}

function deletionCount(
  record: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): number {
  const value = Number(record[camelKey] ?? record[snakeKey] ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function deletionBoolean(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function waitForProjectGedcomDeletionRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
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
  if (message.includes("ROOT_REPLACEMENT_REQUIRED")) {
    return new Error("Для кожного дерева потрібно вибрати нову кореневу особу.");
  }
  if (
    message.includes("ROOT_REPLACEMENT_INVALID") ||
    message.includes("ROOT_REPLACEMENT_IS_BEING_DELETED") ||
    message.includes("ROOT_REPLACEMENT_NOT_IN_PROJECT")
  ) {
    return new Error("Обрана коренева особа більше недоступна. Оновіть список і виберіть іншу особу.");
  }
  if (message.includes("PROJECT_GEDCOM_OPERATION_ACTIVE")) {
    return new Error("Зачекайте завершення поточного GEDCOM-імпорту або відкату та повторіть дію.");
  }
  if (message.includes("PROJECT_GEDCOM_DELETION_ACTIVE")) {
    return new Error("У цьому проєкті вже видаляється інший GEDCOM-набір. Дочекайтеся завершення та повторіть дію.");
  }
  if (message.includes("PROJECT_GEDCOM_DELETION_BUSY")) {
    return new Error("Видалення GEDCOM уже обробляється в іншій вкладці. Зачекайте кілька секунд і повторіть дію.");
  }
  if (message.includes("GEDCOM_DATASET_NOT_FOUND")) {
    return new Error("GEDCOM-набір уже видалено або список застарів. Оновіть сторінку.");
  }
  if (message.includes("GEDCOM_DELETION_JOB_NOT_FOUND")) {
    return new Error("Стан видалення GEDCOM більше недоступний. Оновіть сторінку та повторіть дію.");
  }
  if (message.includes("GEDCOM_DELETION_SOURCE_CHANGED")) {
    return new Error("Склад GEDCOM-набору змінився під час видалення. Оновіть сторінку та повторіть дію.");
  }
  if (isDatabaseStatementTimeout(error)) {
    return new Error(
      "Сервер не встиг завершити крок видалення. Прогрес збережено — повторіть дію, щоб безпечно продовжити.",
    );
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
