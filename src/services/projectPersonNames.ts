import type {
  PersonName,
  PersonNameDatePrecision,
  PersonNameEvidenceStatus,
  PersonNameType,
} from "../types";
import {
  mapProjectPersonNameSuggestions,
  PERSON_NAME_SUGGESTION_DEFAULT_LIMIT,
  PERSON_NAME_SUGGESTION_MIN_QUERY_LENGTH,
  projectPersonNameSuggestionLimit,
  type ProjectPersonNameSuggestion,
} from "../utils/projectPersonNameSuggestions.ts";
import { runAuthenticatedSupabaseRequest } from "../utils/authenticatedSupabaseRequest.ts";
import { getSupabaseClient } from "./supabaseAuth";

export {
  PERSON_NAME_SUGGESTION_DEFAULT_LIMIT,
  PERSON_NAME_SUGGESTION_MAX_LIMIT,
  PERSON_NAME_SUGGESTION_MIN_QUERY_LENGTH,
  projectPersonNameSuggestionMatchLabel,
  projectPersonNameSuggestionQuery,
} from "../utils/projectPersonNameSuggestions.ts";
export type {
  ProjectPersonNameSuggestion,
  ProjectPersonNameSuggestionMatchType,
} from "../utils/projectPersonNameSuggestions.ts";

export interface ProjectPersonNameDraft {
  nameType: PersonNameType;
  languageCode: string;
  scriptCode: string;
  surname: string;
  maidenSurname: string;
  givenName: string;
  patronymic: string;
  prefix: string;
  suffix: string;
  nickname: string;
  /** Compatibility display value. Kept separate so editing normalization is lossless. */
  fullName: string;
  fullNormalized: string;
  originalText: string;
  orthography: string;
  validFrom: string;
  validTo: string;
  datePrecision: PersonNameDatePrecision;
  isPreferred: boolean;
  isSearchable: boolean;
  evidenceStatus: PersonNameEvidenceStatus;
  confidence: number;
  sourceDocumentId: string | null;
  sourceFindingId: string | null;
  sourceType: string;
  sourceId: string | null;
  citationId: string | null;
  documentFragmentId: string | null;
  notes: string;
  metadata?: Record<string, unknown>;
}

interface PersonNameRow {
  id: string;
  project_id: string;
  person_id: string;
  name_type: string;
  language_code: string;
  script_code: string;
  surname: string;
  given_name: string;
  patronymic: string;
  full_name: string;
  original_text: string;
  is_primary: boolean;
  is_preferred: boolean;
  evidence_status: string;
  confidence: number;
  source_document_id: string | null;
  source_finding_id: string | null;
  maiden_surname?: string;
  prefix?: string;
  suffix?: string;
  nickname?: string;
  full_normalized?: string;
  orthography?: string;
  valid_from?: string;
  valid_to?: string;
  date_precision?: string;
  is_searchable?: boolean;
  source_type?: string;
  source_id?: string | null;
  citation_id?: string | null;
  document_fragment_id?: string | null;
  created_by?: string | null;
  lock_version?: number;
  notes: string;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

const PERSON_NAME_SELECT = [
  "id",
  "project_id",
  "person_id",
  "name_type",
  "language_code",
  "script_code",
  "surname",
  "given_name",
  "patronymic",
  "full_name",
  "original_text",
  "is_primary",
  "is_preferred",
  "evidence_status",
  "confidence",
  "source_document_id",
  "source_finding_id",
  "notes",
  "metadata",
  "created_at",
  "updated_at",
].join(", ");

const PERSON_NAME_V2_SELECT = [
  PERSON_NAME_SELECT,
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
  "created_by",
  "lock_version",
].join(", ");

const PERSON_NAME_V2_METADATA_KEY = "tracker_person_name_v2";
const PERSON_NAME_BACKUP_PAGE_SIZE = 500;
const CURRENT_STORAGE_TYPES = new Set([
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
]);

const DATE_PRECISIONS = new Set<PersonNameDatePrecision>([
  "exact",
  "day",
  "month",
  "year",
  "range",
  "circa",
  "before",
  "after",
  "between",
  "unknown",
]);

export interface ProjectPersonNameNormalizationPreview {
  normalized: string;
  simplified: string;
  transliteration: string;
  tokens: {
    original: string[];
    normalized: string[];
    simplified: string[];
    transliteration: string[];
  };
}

export class PersonNamesSchemaUnavailableError extends Error {
  constructor(message = "Варіанти імен ще недоступні: застосуйте міграцію person_names.") {
    super(message);
    this.name = "PersonNamesSchemaUnavailableError";
  }
}

export class PersonNamePrimaryMigrationRequiredError extends Error {
  constructor() {
    super("Не вдалося змінити основне ім’я: серверна міграція set_project_person_name_primary_v1 ще не застосована.");
    this.name = "PersonNamePrimaryMigrationRequiredError";
  }
}

export class PersonNamesRestoreMigrationRequiredError extends Error {
  constructor() {
    super("Не вдалося відновити історичні імена: серверна міграція резервних копій ще не застосована.");
    this.name = "PersonNamesRestoreMigrationRequiredError";
  }
}

/** Missing legacy schemas return an empty list so existing person screens remain usable. */
export async function listProjectPersonNames(
  projectId: string,
  personId: string,
): Promise<PersonName[]> {
  const v2Result = await personNamesQuery(projectId, personId, PERSON_NAME_V2_SELECT);
  if (!v2Result.error) {
    return ((v2Result.data ?? []) as unknown as PersonNameRow[]).map(personNameFromRow);
  }
  if (!isMissingPersonNamesV2ColumnsError(v2Result.error)) {
    if (isMissingPersonNamesSchemaError(v2Result.error)) return [];
    throw v2Result.error;
  }
  const legacyResult = await personNamesQuery(projectId, personId, PERSON_NAME_SELECT);
  if (legacyResult.error) {
    if (isMissingPersonNamesSchemaError(legacyResult.error)) return [];
    throw legacyResult.error;
  }
  return ((legacyResult.data ?? []) as unknown as PersonNameRow[]).map(personNameFromRow);
}

/**
 * Reads a complete, project-scoped snapshot for backup. Person detail screens
 * deliberately load names lazily, so `AppDatabase` alone is not authoritative.
 */
export async function listAllProjectPersonNames(
  projectId: string,
): Promise<PersonName[]> {
  const v2Result = await listAllProjectPersonNameRows(projectId, PERSON_NAME_V2_SELECT);
  if (!v2Result.error) return v2Result.rows.map(personNameFromRow);
  if (!isMissingPersonNamesV2ColumnsError(v2Result.error)) {
    if (isMissingPersonNamesSchemaError(v2Result.error)) {
      throw new PersonNamesSchemaUnavailableError(
        "Резервну копію не створено: таблиця історичних імен недоступна.",
      );
    }
    throw v2Result.error;
  }
  const legacyResult = await listAllProjectPersonNameRows(projectId, PERSON_NAME_SELECT);
  if (legacyResult.error) {
    if (isMissingPersonNamesSchemaError(legacyResult.error)) {
      throw new PersonNamesSchemaUnavailableError(
        "Резервну копію не створено: таблиця історичних імен недоступна.",
      );
    }
    throw legacyResult.error;
  }
  return legacyResult.rows.map(personNameFromRow);
}

export function validateProjectPersonNamesForRestore(input: {
  names: readonly PersonName[];
  personIds: ReadonlySet<string>;
  documentIds: ReadonlySet<string>;
  findingIds: ReadonlySet<string>;
}): void {
  const seenIds = new Set<string>();
  const primaryCounts = new Map<string, number>();
  for (const name of input.names) {
    if (seenIds.has(name.id)) {
      throw new Error("Резервна копія містить дубльований ідентифікатор варіанта імені.");
    }
    seenIds.add(name.id);
    if (!input.personIds.has(name.personId)) {
      throw new Error("Резервна копія містить варіант імені для відсутньої особи.");
    }
    if (name.sourceDocumentId && !input.documentIds.has(name.sourceDocumentId)) {
      throw new Error("Резервна копія містить варіант імені з відсутнім документом-джерелом.");
    }
    if (name.sourceFindingId && !input.findingIds.has(name.sourceFindingId)) {
      throw new Error("Резервна копія містить варіант імені з відсутньою знахідкою-джерелом.");
    }
    if (name.sourceType === "document" && name.sourceId && !input.documentIds.has(name.sourceId)) {
      throw new Error("Резервна копія містить варіант імені з відсутнім іншим документом-джерелом.");
    }
    if (name.sourceType === "finding" && name.sourceId && !input.findingIds.has(name.sourceId)) {
      throw new Error("Резервна копія містить варіант імені з відсутньою іншою знахідкою-джерелом.");
    }
    if (name.isPrimary) {
      const nextPrimaryCount = (primaryCounts.get(name.personId) ?? 0) + 1;
      if (nextPrimaryCount > 1) {
        throw new Error("Резервна копія містить кілька основних імен однієї особи.");
      }
      primaryCounts.set(name.personId, nextPrimaryCount);
    }
  }
  for (const personId of input.personIds) {
    if (primaryCounts.get(personId) !== 1) {
      throw new Error("Повна резервна копія має містити рівно одне основне ім’я кожної особи.");
    }
  }
}

/** Fails before project clearing when the atomic restore contract is absent. */
export async function preflightProjectPersonNamesRestore(projectId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("preflight_project_person_names_restore_v1", {
    p_project_id: projectId,
  });
  if (error) {
    if (isMissingRestorePersonNamesRpcError(error)) {
      throw new PersonNamesRestoreMigrationRequiredError();
    }
    throw error;
  }
}

/** Restores the complete collection atomically, including projection rows. */
export async function restoreProjectPersonNames(input: {
  projectId: string;
  names: readonly PersonName[];
}): Promise<void> {
  const { error } = await getSupabaseClient().rpc("restore_project_person_names_v1", {
    p_project_id: input.projectId,
    p_names: input.names.map(personNameRestoreRow),
  });
  if (error) {
    if (isMissingRestorePersonNamesRpcError(error)) {
      throw new PersonNamesRestoreMigrationRequiredError();
    }
    throw error;
  }
}

export async function createProjectPersonName(input: {
  projectId: string;
  personId: string;
  draft: ProjectPersonNameDraft;
}): Promise<PersonName> {
  const client = getSupabaseClient();
  const v2Result = await client
    .from("person_names")
    .insert({
      project_id: input.projectId,
      person_id: input.personId,
      ...personNamePayload(input.draft, true),
      is_primary: false,
    })
    .select(PERSON_NAME_V2_SELECT)
    .single();
  if (!v2Result.error) return personNameFromRow(v2Result.data as unknown as PersonNameRow);
  if (!isMissingPersonNamesV2ColumnsError(v2Result.error)) throwFriendlySchemaError(v2Result.error);
  const legacyResult = await client
    .from("person_names")
    .insert({
      project_id: input.projectId,
      person_id: input.personId,
      ...personNamePayload(input.draft, false),
      is_primary: false,
    })
    .select(PERSON_NAME_SELECT)
    .single();
  if (legacyResult.error) throwFriendlySchemaError(legacyResult.error);
  return personNameFromRow(legacyResult.data as unknown as PersonNameRow);
}

export async function updateProjectPersonName(input: {
  projectId: string;
  personId: string;
  nameId: string;
  draft: ProjectPersonNameDraft;
}): Promise<PersonName> {
  const client = getSupabaseClient();
  const v2Result = await client
    .from("person_names")
    .update(personNamePayload(input.draft, true))
    .eq("project_id", input.projectId)
    .eq("person_id", input.personId)
    .eq("id", input.nameId)
    .select(PERSON_NAME_V2_SELECT)
    .single();
  if (!v2Result.error) return personNameFromRow(v2Result.data as unknown as PersonNameRow);
  if (!isMissingPersonNamesV2ColumnsError(v2Result.error)) throwFriendlySchemaError(v2Result.error);
  const legacyResult = await client
    .from("person_names")
    .update(personNamePayload(input.draft, false))
    .eq("project_id", input.projectId)
    .eq("person_id", input.personId)
    .eq("id", input.nameId)
    .select(PERSON_NAME_SELECT)
    .single();
  if (legacyResult.error) throwFriendlySchemaError(legacyResult.error);
  return personNameFromRow(legacyResult.data as unknown as PersonNameRow);
}

export async function deleteProjectPersonName(input: {
  projectId: string;
  personId: string;
  nameId: string;
}): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("person_names")
    .delete()
    .eq("project_id", input.projectId)
    .eq("person_id", input.personId)
    .eq("id", input.nameId)
    .eq("is_primary", false);
  if (error) throwFriendlySchemaError(error);
}

/**
 * Primary switching is intentionally server-only. A client-side two-step
 * update can leave a person without a primary name or race the unique index.
 */
export async function setPrimaryProjectPersonName(input: {
  projectId: string;
  personId: string;
  nameId: string;
}): Promise<PersonName[]> {
  const { error } = await getSupabaseClient().rpc("set_project_person_name_primary_v1", {
    p_project_id: input.projectId,
    p_person_id: input.personId,
    p_name_id: input.nameId,
  });
  if (error) {
    if (isMissingSetPrimaryRpcError(error)) {
      throw new PersonNamePrimaryMigrationRequiredError();
    }
    throw error;
  }
  return listProjectPersonNames(input.projectId, input.personId);
}

/**
 * Produces a suggestion only. The returned value is never persisted until the
 * user explicitly applies it in the editor and saves the name.
 */
export async function previewProjectPersonNameNormalization(input: {
  projectId: string;
  value: string;
}): Promise<ProjectPersonNameNormalizationPreview> {
  const { data, error } = await getSupabaseClient().rpc(
    "preview_project_person_name_normalization_v1",
    {
      p_project_id: input.projectId,
      p_value: input.value,
    },
  );
  if (error) {
    if (isMissingPersonNameNormalizationPreviewRpcError(error)) {
      throw new PersonNamesSchemaUnavailableError(
        "Попередній перегляд нормалізації стане доступним після застосування міграції історичних імен.",
      );
    }
    throw error;
  }
  const value = objectRecord(data);
  const tokens = objectRecord(value.tokens);
  return {
    normalized: stringValue(value.normalized),
    simplified: stringValue(value.simplified),
    transliteration: stringValue(value.transliteration),
    tokens: {
      original: stringArray(tokens.original),
      normalized: stringArray(tokens.normalized),
      simplified: stringArray(tokens.simplified),
      transliteration: stringArray(tokens.transliteration),
    },
  };
}

/**
 * Looks for possible duplicate people inside one project. Results are hints
 * only: this API never updates, links, selects, or merges any record.
 */
export async function searchProjectPersonNameSuggestions(input: {
  projectId: string;
  query: string;
  excludePersonId?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ProjectPersonNameSuggestion[]> {
  const query = input.query.trim();
  if (query.length < PERSON_NAME_SUGGESTION_MIN_QUERY_LENGTH) return [];

  const limit = projectPersonNameSuggestionLimit(
    input.limit ?? PERSON_NAME_SUGGESTION_DEFAULT_LIMIT,
  );
  // Ask for one spare person because the current card is excluded client-side.
  const rpcLimit = Math.min(50, limit + (input.excludePersonId ? 1 : 0));
  const client = getSupabaseClient();
  const { data, error } = await runAuthenticatedSupabaseRequest(client, async () => {
    let request = client.rpc("search_project_person_names_v1", {
      p_project_id: input.projectId,
      p_query: query,
      p_limit: rpcLimit,
    });
    if (input.signal) request = request.abortSignal(input.signal);
    const result = await request;
    return { data: result.data, error: result.error };
  });
  if (error) {
    // Keep existing person editing usable before the additive migration lands.
    if (isMissingHistoricalPersonNameSearchRpcError(error)) return [];
    throw error;
  }
  return mapProjectPersonNameSuggestions(data, {
    excludePersonId: input.excludePersonId,
    limit,
  });
}

export function emptyProjectPersonNameDraft(): ProjectPersonNameDraft {
  return {
    nameType: "document",
    languageCode: "uk",
    // Kept in the storage contract for imported/legacy data, but manual entry
    // no longer asks users to classify the writing system separately.
    scriptCode: "",
    surname: "",
    maidenSurname: "",
    givenName: "",
    patronymic: "",
    prefix: "",
    suffix: "",
    nickname: "",
    fullName: "",
    fullNormalized: "",
    originalText: "",
    orthography: "",
    validFrom: "",
    validTo: "",
    datePrecision: "unknown",
    isPreferred: false,
    isSearchable: true,
    evidenceStatus: "unknown",
    confidence: 50,
    sourceDocumentId: null,
    sourceFindingId: null,
    sourceType: "",
    sourceId: null,
    citationId: null,
    documentFragmentId: null,
    notes: "",
    metadata: {},
  };
}

export function projectPersonNameDraft(name: PersonName): ProjectPersonNameDraft {
  return {
    nameType: name.nameType,
    languageCode: name.languageCode,
    scriptCode: name.scriptCode,
    surname: name.surname,
    maidenSurname: name.maidenSurname,
    givenName: name.givenName,
    patronymic: name.patronymic,
    prefix: name.prefix,
    suffix: name.suffix,
    nickname: name.nickname,
    fullName: name.fullName,
    fullNormalized: name.fullNormalized,
    originalText: name.originalText,
    orthography: name.orthography,
    validFrom: name.validFrom,
    validTo: name.validTo,
    datePrecision: name.datePrecision,
    isPreferred: name.isPreferred,
    isSearchable: name.isSearchable,
    evidenceStatus: name.evidenceStatus,
    confidence: name.confidence,
    sourceDocumentId: name.sourceDocumentId,
    sourceFindingId: name.sourceFindingId,
    sourceType: name.sourceType,
    sourceId: name.sourceId,
    citationId: name.citationId,
    documentFragmentId: name.documentFragmentId,
    notes: name.notes,
    metadata: name.metadata,
  };
}

function personNamePayload(draft: ProjectPersonNameDraft, useV2Columns: boolean): Record<string, unknown> {
  const metadata = { ...(draft.metadata ?? {}) };
  metadata[PERSON_NAME_V2_METADATA_KEY] = {
    nameType: draft.nameType,
    maidenSurname: draft.maidenSurname,
    prefix: draft.prefix,
    suffix: draft.suffix,
    nickname: draft.nickname,
    fullNormalized: draft.fullNormalized,
    orthography: draft.orthography,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    datePrecision: draft.datePrecision,
    isSearchable: draft.isSearchable,
    sourceType: draft.sourceType,
    sourceId: draft.sourceId,
    citationId: draft.citationId,
    documentFragmentId: draft.documentFragmentId,
  };
  const payload: Record<string, unknown> = {
    name_type: useV2Columns ? draft.nameType : storageNameType(draft.nameType),
    language_code: draft.languageCode,
    script_code: draft.scriptCode,
    surname: draft.surname,
    given_name: draft.givenName,
    patronymic: draft.patronymic,
    full_name: draft.fullName,
    // Deliberately preserve the exact string supplied by the user.
    original_text: draft.originalText,
    is_preferred: draft.isPreferred,
    evidence_status: draft.evidenceStatus,
    confidence: Math.max(0, Math.min(100, Math.round(draft.confidence))),
    source_document_id: draft.sourceDocumentId || null,
    source_finding_id: draft.sourceFindingId || null,
    notes: draft.notes,
    metadata,
  };
  if (useV2Columns) {
    Object.assign(payload, {
      maiden_surname: draft.maidenSurname,
      prefix: draft.prefix,
      suffix: draft.suffix,
      nickname: draft.nickname,
      full_normalized: draft.fullNormalized,
      orthography: draft.orthography,
      valid_from: draft.validFrom,
      valid_to: draft.validTo,
      date_precision: draft.datePrecision,
      is_searchable: draft.isSearchable,
      source_type: draft.sourceType,
      source_id: draft.sourceId,
      citation_id: draft.citationId,
      document_fragment_id: draft.documentFragmentId,
    });
  }
  return payload;
}

function personNameRestoreRow(name: PersonName): Record<string, unknown> {
  return {
    id: name.id,
    person_id: name.personId,
    name_type: name.nameType,
    language_code: name.languageCode,
    script_code: name.scriptCode,
    surname: name.surname,
    maiden_surname: name.maidenSurname,
    given_name: name.givenName,
    patronymic: name.patronymic,
    prefix: name.prefix,
    suffix: name.suffix,
    nickname: name.nickname,
    full_name: name.fullName,
    full_normalized: name.fullNormalized,
    original_text: name.originalText,
    orthography: name.orthography,
    valid_from: name.validFrom || null,
    valid_to: name.validTo || null,
    date_precision: name.datePrecision,
    is_primary: name.isPrimary,
    is_preferred: name.isPreferred,
    is_searchable: name.isSearchable,
    evidence_status: name.evidenceStatus,
    confidence: name.confidence,
    source_document_id: name.sourceDocumentId,
    source_finding_id: name.sourceFindingId,
    source_type: name.sourceType,
    source_id: name.sourceId,
    citation_id: name.citationId,
    document_fragment_id: name.documentFragmentId,
    notes: name.notes,
    metadata: name.metadata,
    created_by: name.createdBy,
    created_at: name.createdAt,
    updated_at: name.updatedAt,
    lock_version: Math.max(1, name.lockVersion),
  };
}

function personNameFromRow(row: PersonNameRow): PersonName {
  const metadata = objectRecord(row.metadata);
  const extra = objectRecord(metadata[PERSON_NAME_V2_METADATA_KEY]);
  return {
    id: row.id,
    projectId: row.project_id,
    personId: row.person_id,
    nameType: personNameType(extra.nameType, row.name_type),
    languageCode: row.language_code ?? "",
    scriptCode: row.script_code ?? "",
    surname: row.surname ?? "",
    maidenSurname: row.maiden_surname || stringValue(extra.maidenSurname),
    givenName: row.given_name ?? "",
    patronymic: row.patronymic ?? "",
    prefix: row.prefix || stringValue(extra.prefix),
    suffix: row.suffix || stringValue(extra.suffix),
    nickname: row.nickname || stringValue(extra.nickname),
    // `full_name` is a compatibility value of its own. An intentionally empty
    // value must survive backup/restore instead of being replaced by the
    // normalized display form.
    fullName: row.full_name ?? "",
    // An explicitly empty V2 value is meaningful and must survive a complete
    // backup/restore round-trip. Only legacy rows (where the column was not
    // selected at all) fall back to the metadata compatibility envelope.
    fullNormalized: typeof row.full_normalized === "string"
      ? row.full_normalized
      : stringValue(extra.fullNormalized) || row.full_name || "",
    originalText: row.original_text ?? "",
    orthography: row.orthography || stringValue(extra.orthography),
    validFrom: row.valid_from ?? stringValue(extra.validFrom),
    validTo: row.valid_to ?? stringValue(extra.validTo),
    datePrecision: datePrecision(
      row.date_precision && row.date_precision !== "unknown"
        ? row.date_precision
        : extra.datePrecision ?? row.date_precision,
    ),
    isPrimary: Boolean(row.is_primary),
    isPreferred: Boolean(row.is_preferred),
    isSearchable: row.is_searchable === false
      ? false
      : typeof extra.isSearchable === "boolean"
        ? extra.isSearchable
        : typeof row.is_searchable === "boolean"
          ? row.is_searchable
          : true,
    evidenceStatus: evidenceStatus(row.evidence_status),
    confidence: Number.isFinite(row.confidence) ? row.confidence : 50,
    sourceDocumentId: row.source_document_id || null,
    sourceFindingId: row.source_finding_id || null,
    sourceType: row.source_type && row.source_type !== "manual"
      ? row.source_type
      : stringValue(extra.sourceType) || row.source_type || "manual",
    sourceId: row.source_id || nullableString(extra.sourceId),
    citationId: row.citation_id || nullableString(extra.citationId),
    documentFragmentId: row.document_fragment_id || nullableString(extra.documentFragmentId),
    notes: row.notes ?? "",
    metadata,
    createdBy: row.created_by || null,
    lockVersion: Number.isFinite(row.lock_version) ? row.lock_version! : 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storageNameType(value: PersonNameType): string {
  if (CURRENT_STORAGE_TYPES.has(value)) return value;
  if (value === "document" || value === "source_error") return "original";
  if (value === "maiden" || value === "previous") return "surname_variant";
  if (value === "nickname") return "alias";
  return "other";
}

function personNameType(value: unknown, fallback: string): PersonNameType {
  if (isPersonNameTypeSlug(value)) return value as PersonNameType;
  return isPersonNameTypeSlug(fallback) ? fallback as PersonNameType : "other";
}

function isPersonNameTypeSlug(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

function datePrecision(value: unknown): PersonNameDatePrecision {
  return typeof value === "string" && DATE_PRECISIONS.has(value as PersonNameDatePrecision)
    ? value as PersonNameDatePrecision
    : "unknown";
}

function evidenceStatus(value: string): PersonNameEvidenceStatus {
  return value === "proven"
    || value === "likely"
    || value === "disputed"
    || value === "disproven"
    || value === "unknown"
    ? value
    : "unknown";
}

function personNamesQuery(projectId: string, personId: string, columns: string) {
  return getSupabaseClient()
    .from("person_names")
    .select(columns)
    .eq("project_id", projectId)
    .eq("person_id", personId)
    .order("is_primary", { ascending: false })
    .order("is_preferred", { ascending: false })
    .order("updated_at", { ascending: false });
}

async function listAllProjectPersonNameRows(
  projectId: string,
  columns: string,
): Promise<{ rows: PersonNameRow[]; error: unknown | null }> {
  const rows: PersonNameRow[] = [];
  for (let from = 0; ; from += PERSON_NAME_BACKUP_PAGE_SIZE) {
    const { data, error } = await getSupabaseClient()
      .from("person_names")
      .select(columns)
      .eq("project_id", projectId)
      .order("person_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PERSON_NAME_BACKUP_PAGE_SIZE - 1);
    if (error) return { rows: [], error };
    const batch = (data ?? []) as unknown as PersonNameRow[];
    rows.push(...batch);
    if (batch.length < PERSON_NAME_BACKUP_PAGE_SIZE) break;
  }
  return { rows, error: null };
}

function isMissingPersonNamesV2ColumnsError(error: unknown): boolean {
  const { code, text } = errorDetails(error);
  const v2Columns = [
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
    "created_by",
    "lock_version",
  ];
  return (code === "42703" || code === "PGRST204" || text.includes("schema cache"))
    && v2Columns.some((column) => text.includes(column));
}

function isMissingPersonNamesSchemaError(error: unknown): boolean {
  const { code, text } = errorDetails(error);
  return code === "42P01"
    || code === "PGRST205"
    || (text.includes("person_names") && (
      text.includes("does not exist")
      || text.includes("schema cache")
    ));
}

function isMissingSetPrimaryRpcError(error: unknown): boolean {
  const { code, text } = errorDetails(error);
  return code === "PGRST202"
    || code === "42883"
    || (text.includes("set_project_person_name_primary_v1") && text.includes("schema cache"));
}

function isMissingRestorePersonNamesRpcError(error: unknown): boolean {
  const { code, text } = errorDetails(error);
  return code === "PGRST202"
    || code === "42883"
    || ((text.includes("restore_project_person_names_v1")
      || text.includes("preflight_project_person_names_restore_v1"))
      && text.includes("schema cache"));
}

function isMissingPersonNameNormalizationPreviewRpcError(error: unknown): boolean {
  const { code, text } = errorDetails(error);
  return code === "PGRST202"
    || code === "42883"
    || (text.includes("preview_project_person_name_normalization_v1") && text.includes("schema cache"));
}

function isMissingHistoricalPersonNameSearchRpcError(error: unknown): boolean {
  const { code, text } = errorDetails(error);
  return code === "PGRST202"
    || code === "42883"
    || (text.includes("search_project_person_names_v1") && (
      text.includes("does not exist") || text.includes("schema cache")
    ));
}

function throwFriendlySchemaError(error: unknown): never {
  if (isMissingPersonNamesSchemaError(error)) throw new PersonNamesSchemaUnavailableError();
  throw error;
}

function errorDetails(error: unknown): { code: string; text: string } {
  if (!error || typeof error !== "object") return { code: "", text: String(error ?? "") };
  const record = error as Record<string, unknown>;
  return {
    code: typeof record.code === "string" ? record.code.toUpperCase() : "",
    text: [record.message, record.details, record.hint]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .toLowerCase(),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
