import type {
  AppDatabase,
  AppEntity,
  CollectionKey,
  CustomFieldDefinition,
  CustomFieldValue,
  Finding,
  FindingParticipant,
  Person,
} from "../types";
import type { FieldConfig } from "../pages/entityConfigs";
import { createId } from "./id";
import { nowIso } from "./dateHelpers";
import { participantSummary, sortFindingParticipants } from "./findingParticipants";
import { standardLabels } from "./excelExport";
import {
  normalizeTaskReminderFields,
  normalizeTaskReminderTimestamp,
  taskReminderValidationError,
} from "./taskReminders";
import { PERSON_STATUSES } from "./personStatus.ts";
import { parseFindingParticipantTableCell } from "./findingParticipantTableCell";
import { checkImportFileSize, TABLE_IMPORT_LIMITS, unzipBoundedXlsx } from "./boundedXlsx.ts";

export interface ImportTableRow {
  sourceRowNumber: number;
  values: Record<string, string>;
}

export interface ImportParseResult {
  sheetName: string;
  headers: string[];
  rows: ImportTableRow[];
}

export interface ImportBuildResult {
  records: AppEntity[];
  warnings: string[];
  addedCount: number;
  updatedCount: number;
  unchangedCount: number;
}

const ignoredLabels = new Set(["створено", "оновлено"]);
const supportedImportCollections = new Set<CollectionKey>([
  "archiveRequests",
  "tasks",
  "findings",
  "hypotheses",
  "persons",
]);

export function canImportCollection(collection: CollectionKey): boolean {
  return supportedImportCollections.has(collection);
}

export function supportedImportAccept(): string {
  return ".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export async function parseImportTableFile(file: File, signal?: AbortSignal): Promise<ImportParseResult> {
  checkImportFileSize(file.size);
  signal?.throwIfAborted();
  const lowerName = file.name.toLocaleLowerCase("uk");
  if (lowerName.endsWith(".csv")) {
    const text = await file.text();
    signal?.throwIfAborted();
    return parseCsvTable(text, file.name);
  }
  if (lowerName.endsWith(".xlsx")) {
    return parseXlsxTable(new Uint8Array(await file.arrayBuffer()), signal);
  }
  throw new Error("Підтримуються лише файли .xlsx або .csv, створені з таблиць Трекера Роду.");
}

export function buildImportedRecords({
  db,
  collection,
  fields,
  rows,
  customFieldDefinitions = [],
}: {
  db: AppDatabase;
  collection: CollectionKey;
  fields: FieldConfig[];
  rows: ImportTableRow[];
  customFieldDefinitions?: CustomFieldDefinition[];
}): ImportBuildResult {
  const warnings: string[] = [];
  const usableFields = importFields(collection, fields);
  const fieldByLabel = new Map<string, FieldConfig>();
  for (const field of usableFields) {
    fieldByLabel.set(normalizeLabel(field.label), field);
    const standardLabel = standardLabels[collection]?.[field.key];
    if (standardLabel) fieldByLabel.set(normalizeLabel(standardLabel), field);
  }

  const customByLabel = new Map<string, CustomFieldDefinition>();
  for (const definition of customFieldDefinitions.filter((field) => field.module === collection)) {
    customByLabel.set(normalizeLabel(definition.label), definition);
  }

  const candidates = rows
    .map((row) => ({
      row,
      record: buildRecordFromRow({
      db,
      collection,
      fields: usableFields,
      fieldByLabel,
      customByLabel,
      row,
      warnings,
      }),
    }))
    .filter((candidate): candidate is { row: ImportTableRow; record: AppEntity } =>
      Boolean(candidate.record)
    );

  return reconcileImportedRecords({
    db,
    collection,
    fields: usableFields,
    customFieldDefinitions,
    candidates,
    warnings,
  });
}

function reconcileImportedRecords({
  db,
  collection,
  fields,
  customFieldDefinitions,
  candidates,
  warnings,
}: {
  db: AppDatabase;
  collection: CollectionKey;
  fields: FieldConfig[];
  customFieldDefinitions: CustomFieldDefinition[];
  candidates: Array<{ row: ImportTableRow; record: AppEntity }>;
  warnings: string[];
}): ImportBuildResult {
  const existing = db[collection] as AppEntity[];
  const records: AppEntity[] = [];
  const claimedIds = new Set<string>();
  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const { row, record } of candidates) {
    const sourceId = sourceRecordId(row);
    const known = [...existing, ...records.filter((item) =>
      !existing.some((current) => current.id === item.id)
    )];
    const metadataMatches = findMetadataMatches(row, known);
    const match = (sourceId ? known.find((item) => item.id === sourceId) : undefined)
      ?? (metadataMatches.length === 1 ? metadataMatches[0] : undefined)
      ?? findNaturalMatch(
        collection,
        record,
        metadataMatches.length > 1 ? metadataMatches : known,
      );

    if (!match) {
      records.push(record);
      addedCount += 1;
      continue;
    }
    if (claimedIds.has(match.id)) {
      warnings.push(`Рядок ${row.sourceRowNumber} пропущено: цей запис уже був у поточному файлі.`);
      unchangedCount += 1;
      continue;
    }
    claimedIds.add(match.id);

    const merged = mergeImportedRecord(
      collection,
      match,
      record,
      fields,
      customFieldDefinitions,
    );
    if (sameImportedValues(collection, match, merged, fields, customFieldDefinitions)) {
      unchangedCount += 1;
      continue;
    }
    records.push(merged);
    updatedCount += 1;
  }

  return {
    records: applySourceOrder(records, existing),
    warnings,
    addedCount,
    updatedCount,
    unchangedCount,
  };
}

function applySourceOrder(records: AppEntity[], existing: AppEntity[]): AppEntity[] {
  const importedAt = Date.now();
  const existingById = new Map(existing.map((record) => [record.id, record]));
  return records.map((record, index) => {
    const timestamp = new Date(importedAt - index * 10).toISOString();
    const previous = existingById.get(record.id);
    return {
      ...record,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      __baseUpdatedAt: previous?.updatedAt,
    } as unknown as AppEntity;
  });
}

function sourceRecordId(row: ImportTableRow): string {
  const entry = Object.entries(row.values).find(([label]) => normalizeLabel(label) === "id запису");
  return entry?.[1]?.trim() ?? "";
}

function findMetadataMatches(row: ImportTableRow, records: AppEntity[]): AppEntity[] {
  const values = new Map(
    Object.entries(row.values).map(([label, value]) => [normalizeLabel(label), value.trim()]),
  );
  const createdAt = values.get("створено") ?? "";
  const updatedAt = values.get("оновлено") ?? "";
  if (!createdAt && !updatedAt) return [];

  return records.filter((record) => {
    const createdMatches = !createdAt || exportedDateTime(record.createdAt) === createdAt;
    const updatedMatches = !updatedAt || exportedDateTime(record.updatedAt) === updatedAt;
    return createdMatches && updatedMatches;
  });
}

function exportedDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.trim()
    : new Intl.DateTimeFormat("uk-UA", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(date);
}

function findNaturalMatch(
  collection: CollectionKey,
  candidate: AppEntity,
  records: AppEntity[],
): AppEntity | undefined {
  const key = naturalRecordKey(collection, candidate);
  if (!key) return undefined;
  const matches = records.filter((record) => naturalRecordKey(collection, record) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

function naturalRecordKey(collection: CollectionKey, entity: AppEntity): string {
  const record = entity as unknown as Record<string, unknown>;
  const keys: Partial<Record<CollectionKey, string[]>> = {
    persons: ["researchId", "fullName", "surname", "givenName", "patronymic", "birthDate", "birthYearFrom", "birthYearTo", "birthPlace"],
    tasks: ["researchId", "title", "personName", "place", "yearFrom", "yearTo", "documentType", "documentId"],
    hypotheses: ["researchId", "title"],
    archiveRequests: ["researchId", "archive", "archiveDetails", "requestDate", "subject"],
  };
  if (collection === "findings") return findingSourceKey(record);
  const identityKeys = keys[collection];
  if (!identityKeys) return "";
  const values = identityKeys.map((key) => comparableValue(record[key]));
  return values.some(Boolean) ? values.join("|") : "";
}

function findingSourceKey(record: Record<string, unknown>): string {
  const documentId = comparableValue(record.documentId);
  const archive = comparableValue(record.archive);
  const fund = comparableValue(record.fund);
  const file = comparableValue(record.file);
  const page = comparableValue(record.page);
  const researchId = comparableValue(record.researchId);
  const hasSourcePosition = Boolean(page || file);
  const sourceParts = [documentId, archive, fund, file, page].filter(Boolean);
  if (!hasSourcePosition || sourceParts.length < 2) return "";
  return [researchId, documentId, archive, fund, file, page].join("|");
}

function mergeImportedRecord(
  collection: CollectionKey,
  existing: AppEntity,
  imported: AppEntity,
  fields: FieldConfig[],
  customFieldDefinitions: CustomFieldDefinition[],
): AppEntity {
  const current = existing as unknown as Record<string, unknown>;
  const incoming = imported as unknown as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const key of comparableFieldKeys(collection, fields)) merged[key] = incoming[key];

  const currentCustom = (current.customFields ?? {}) as Record<string, CustomFieldValue>;
  const incomingCustom = (incoming.customFields ?? {}) as Record<string, CustomFieldValue>;
  const importableCustomIds = new Set(
    customFieldDefinitions
      .filter((field) => field.module === collection && field.type !== "attachments")
      .map((field) => field.id),
  );
  merged.customFields = {
    ...currentCustom,
    ...Object.fromEntries(
      Object.entries(incomingCustom).filter(([id]) => importableCustomIds.has(id)),
    ),
  };
  merged.id = existing.id;
  merged.createdAt = existing.createdAt;
  merged.updatedAt = nowIso();
  merged.__baseUpdatedAt = existing.updatedAt;
  return merged as unknown as AppEntity;
}

function sameImportedValues(
  collection: CollectionKey,
  existing: AppEntity,
  imported: AppEntity,
  fields: FieldConfig[],
  customFieldDefinitions: CustomFieldDefinition[],
): boolean {
  const current = existing as unknown as Record<string, unknown>;
  const incoming = imported as unknown as Record<string, unknown>;
  const keys = comparableFieldKeys(collection, fields);
  if (keys.some((key) => comparableValue(current[key]) !== comparableValue(incoming[key]))) {
    return false;
  }
  const customIds = customFieldDefinitions
    .filter((field) => field.module === collection && field.type !== "attachments")
    .map((field) => field.id);
  const currentCustom = (current.customFields ?? {}) as Record<string, unknown>;
  const incomingCustom = (incoming.customFields ?? {}) as Record<string, unknown>;
  return customIds.every((id) =>
    comparableValue(currentCustom[id]) === comparableValue(incomingCustom[id])
  );
}

function comparableFieldKeys(collection: CollectionKey, fields: FieldConfig[]): string[] {
  const keys = fields.filter((field) => field.type !== "scans").map((field) => field.key);
  if (collection === "findings") keys.push("people");
  return Array.from(new Set(keys));
}

function comparableValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return normalizeLabel(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(normalizedComparableValue));
  if (typeof value === "object") return JSON.stringify(normalizedComparableValue(value));
  return String(value);
}

function normalizedComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedComparableValue);
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? normalizeLabel(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["id", "createdAt", "updatedAt", "__baseUpdatedAt"].includes(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizedComparableValue(entry)]),
  );
}

function importFields(collection: CollectionKey, fields: FieldConfig[]): FieldConfig[] {
  if (collection === "tasks") {
    return [
      ...fields,
      {
        key: "reminderSentAt",
        label: standardLabels.tasks.reminderSentAt,
        type: "datetime-local",
      },
    ];
  }
  if (collection !== "persons") return fields;
  return Object.entries(standardLabels.persons).map(([key, label]) => ({
    key,
    label,
    type: personFieldType(key),
    options: personFieldOptions(key),
  }));
}

function personFieldType(key: string): FieldConfig["type"] {
  if (key === "researchId") return "research";
  if (["birthDate", "marriageDate", "deathDate"].includes(key)) return "date";
  if (["birthYearFrom", "birthYearTo", "deathYearFrom", "deathYearTo"].includes(key)) return "number";
  if (key === "isLiving") return "checkbox";
  if (["gender", "status", "privacyStatus"].includes(key)) return "select";
  if (["residencePlaces", "notes"].includes(key)) return "textarea";
  return "text";
}

function personFieldOptions(key: string): string[] | undefined {
  if (key === "gender") return ["невідомо", "чоловік", "жінка"];
  if (key === "status") return [...PERSON_STATUSES];
  if (key === "privacyStatus") return ["private", "project", "public", "confidential"];
  return undefined;
}

function buildRecordFromRow({
  db,
  collection,
  fields,
  fieldByLabel,
  customByLabel,
  row,
  warnings,
}: {
  db: AppDatabase;
  collection: CollectionKey;
  fields: FieldConfig[];
  fieldByLabel: Map<string, FieldConfig>;
  customByLabel: Map<string, CustomFieldDefinition>;
  row: ImportTableRow;
  warnings: string[];
}): AppEntity | null {
  const timestamp = nowIso();
  const record: Record<string, unknown> = {
    id: createId(),
    createdAt: timestamp,
    updatedAt: timestamp,
    customFields: {},
  };
  for (const field of fields) record[field.key] = defaultValue(field, collection);

  const participantInputs: string[] = [];
  let hasMeaningfulValue = false;

  for (const [label, rawValue] of Object.entries(row.values)) {
    const value = rawValue;
    if (!value.trim() || ignoredLabels.has(normalizeLabel(label))) continue;
    const participantIndex = participantColumnIndex(label);
    if (collection === "findings" && participantIndex !== null) {
      participantInputs[participantIndex] = value;
      hasMeaningfulValue = true;
      continue;
    }
    const field = fieldByLabel.get(normalizeLabel(label));
    if (field) {
      if (field.type === "scans") {
        warnings.push(`Рядок ${row.sourceRowNumber}: файли з колонки «${label}» не імпортуються автоматично.`);
        continue;
      }
      record[field.key] = coerceFieldValue(db, field, value, row.sourceRowNumber, warnings);
      hasMeaningfulValue = true;
      continue;
    }
    const customDefinition = customByLabel.get(normalizeLabel(label));
    if (customDefinition) {
      (record.customFields as Record<string, CustomFieldValue>)[customDefinition.id] = coerceCustomValue(customDefinition, value);
      hasMeaningfulValue = true;
    }
  }

  if (collection === "findings") {
    const validPersonIds = new Set(db.persons.map((person) => person.id));
    const participants = participantInputs
      .map((value) => parseParticipantCell(
        value,
        validPersonIds,
        (personId) => warnings.push(
          `Рядок ${row.sourceRowNumber}: картку особи «${personId}» для учасника не знайдено в цьому проєкті; текст імпортовано без прив’язки.`,
        ),
      ))
      .filter((participant): participant is FindingParticipant => Boolean(participant));
    const findingType = String(record.findingType ?? "");
    if (participants.length) record.participants = sortFindingParticipants(participants, findingType);
    record.people = participantSummary(record.participants as FindingParticipant[], findingType);
  }

  if (collection === "persons" && !String(record.fullName ?? "").trim()) {
    const name = [record.surname, record.givenName, record.patronymic]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .join(" ");
    if (name) record.fullName = name;
  }
  if (collection === "persons") {
    record.birthScans = [];
    record.marriageScans = [];
    record.deathScans = [];
    record.mentionScans = [];
    record.photos = [];
    record.primaryPhotoId = "";
  }
  if (collection === "tasks") {
    const reminderError = taskReminderValidationError(record);
    if (reminderError) {
      warnings.push(`Рядок ${row.sourceRowNumber} пропущено: ${reminderError}`);
      return null;
    }
    Object.assign(record, normalizeTaskReminderFields(record));
  }

  const missingRequired = fields
    .filter((field) => field.required)
    .filter((field) => isEmptyRequiredValue(record[field.key]));
  if (missingRequired.length) {
    warnings.push(
      `Рядок ${row.sourceRowNumber} пропущено: не заповнено ${missingRequired.map((field) => `«${field.label}»`).join(", ")}.`,
    );
    return null;
  }

  return hasMeaningfulValue ? record as unknown as AppEntity : null;
}

function isEmptyRequiredValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return value === null || value === undefined || String(value).trim() === "";
}

function defaultValue(field: FieldConfig, collection: CollectionKey): unknown {
  if (field.type === "checkbox") return false;
  if (field.type === "documents" || field.type === "findings" || field.type === "persons") return [];
  if (field.type === "participants") return [];
  if (field.type === "scans") return [];
  if (field.type === "select") {
    if (collection === "persons" && field.key === "gender") return "невідомо";
    if (collection === "persons" && field.key === "status") return "гіпотетична";
    return field.options?.[0] ?? "";
  }
  return "";
}

function coerceFieldValue(
  db: AppDatabase,
  field: FieldConfig,
  value: string,
  rowNumber: number,
  warnings: string[],
): unknown {
  if (field.type === "checkbox") return booleanValue(value);
  if (field.type === "number") return value.replace(/\s+/g, "");
  if (field.type === "date") return normalizeDateValue(value);
  if (field.type === "datetime-local") return normalizeTaskReminderTimestamp(value);
  if (field.type === "select") {
    if (field.key === "privacyStatus") return normalizePersonPrivacyImportValue(value, rowNumber, warnings);
    if (!field.options?.length || field.options.includes(value)) return value;
    warnings.push(`Рядок ${rowNumber}: значення «${value}» не входить до списку для поля «${field.label}».`);
    return "";
  }
  if (field.type === "research") return resolveSingle(value, db.researches, (item) => item.title);
  if (field.type === "document") return resolveSingle(value, db.documents, documentLabel);
  if (field.type === "persons") return resolveMany(value, db.persons, personName);
  if (field.type === "documents") return resolveMany(value, db.documents, documentLabel);
  if (field.type === "findings") return resolveMany(value, db.findings, findingLabel);
  if (field.type === "participants") {
    const validPersonIds = new Set(db.persons.map((person) => person.id));
    return value
      .split(/\n+/)
      .map((entry) => parseParticipantCell(
        entry,
        validPersonIds,
        (personId) => warnings.push(
          `Рядок ${rowNumber}: картку особи «${personId}» для учасника не знайдено в цьому проєкті; прив’язку пропущено.`,
        ),
      ))
      .filter((participant): participant is FindingParticipant => Boolean(participant));
  }
  return value;
}

function normalizePersonPrivacyImportValue(value: string, rowNumber: number, warnings: string[]): string {
  const normalized = normalizeLabel(value);
  const mapping: Record<string, string> = {
    private: "private",
    приватна: "private",
    приватний: "private",
    project: "project",
    "у межах проєкту": "project",
    "в межах проєкту": "project",
    проєкт: "project",
    проект: "project",
    public: "public",
    публічна: "public",
    публічний: "public",
    confidential: "confidential",
    конфіденційна: "confidential",
    конфіденційний: "confidential",
  };
  const mapped = mapping[normalized];
  if (mapped) return mapped;
  warnings.push(`Рядок ${rowNumber}: значення «${value}» не входить до списку для поля «Приватність у дереві».`);
  return "private";
}

function coerceCustomValue(definition: CustomFieldDefinition, value: string): CustomFieldValue {
  if (definition.type === "boolean") return booleanValue(value);
  if (definition.type === "multiselect") return splitList(value);
  if (definition.type === "attachments") return [];
  if (definition.type === "date") return normalizeDateValue(value);
  return value;
}

function resolveSingle<T extends { id: string }>(
  value: string,
  records: T[],
  label: (record: T) => string,
): string {
  const normalized = normalizeComparable(value);
  return records.find((record) =>
    record.id === value || normalizeComparable(label(record)) === normalized
  )?.id ?? "";
}

function resolveMany<T extends { id: string }>(
  value: string,
  records: T[],
  label: (record: T) => string,
): string[] {
  return splitList(value)
    .map((item) => resolveSingle(item, records, label))
    .filter(Boolean);
}

function parseParticipantCell(
  value: string | undefined,
  validPersonIds?: ReadonlySet<string>,
  onRejectedPersonId?: (personId: string) => void,
): FindingParticipant | null {
  const parsed = parseFindingParticipantTableCell(value, createId(), validPersonIds);
  if (parsed.rejectedPersonId) onRejectedPersonId?.(parsed.rejectedPersonId);
  return parsed.participant;
}

function participantColumnIndex(label: string): number | null {
  const match = normalizeLabel(label).match(/^учасник\s+(\d+)$/);
  return match ? Number(match[1]) - 1 : null;
}

function booleanValue(value: string): boolean {
  return ["так", "true", "1", "yes", "y", "+"].includes(value.trim().toLocaleLowerCase("uk"));
}

function normalizeDateValue(value: string): string {
  const trimmed = value.trim();
  if (/^\d{5}(?:\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  const dotted = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (dotted) {
    const year = dotted[3].length === 2 ? `20${dotted[3]}` : dotted[3];
    return `${year}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
  }
  const iso = trimmed.match(/^\d{4}-\d{2}-\d{2}$/);
  return iso ? trimmed : trimmed;
}

function splitList(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function documentLabel(document: { title: string; documentType?: string; yearFrom?: string; yearTo?: string; place?: string }): string {
  const details = [
    document.documentType,
    [document.yearFrom, document.yearTo].filter(Boolean).join("–"),
    document.place,
  ].filter(Boolean).join(" · ");
  return details ? `${document.title} — ${details}` : document.title;
}

function personName(person: Person): string {
  return person.fullName
    || [person.surname, person.givenName, person.patronymic].filter(Boolean).join(" ")
    || person.id;
}

function findingLabel(finding: Finding): string {
  return finding.summary || finding.personsText || finding.findingType || finding.id;
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk");
}

function normalizeComparable(value: string): string {
  return normalizeLabel(value).replace(/\s+—\s+.*$/, "");
}

function parseCsvTable(text: string, fileName: string): ImportParseResult {
  const delimiter = preferredDelimiter(text, fileName);
  const table = splitDelimitedRows(text, delimiter)
    .filter((cells) => cells.some((cell) => cell.trim()));
  if (table.length < 2) throw new Error("У файлі немає рядків для імпорту.");
  const headers = table[0].map((header, index) =>
    (index === 0 ? header.replace(/^\uFEFF/, "") : header).trim()
  );
  const rows = table.slice(1).map((cells, index) => ({
    sourceRowNumber: index + 2,
    values: Object.fromEntries(headers.map((header, columnIndex) => [
      header,
      cells[columnIndex] ?? "",
    ])),
  }));
  return {
    sheetName: fileName.replace(/\.[^.]+$/, ""),
    headers,
    rows: rows.filter((row) => !isEmptyValues(row.values)),
  };
}

function splitDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let cellCount = 0;
  const started = Date.now();
  const checkCell = () => {
    if (++cellCount > TABLE_IMPORT_LIMITS.cells || row.length > TABLE_IMPORT_LIMITS.columns || rows.length > TABLE_IMPORT_LIMITS.rows) {
      throw new Error("Таблиця завелика. Розділіть її на частини (до 100 000 рядків, 512 колонок, 1 000 000 комірок).");
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    if (index % 65536 === 0 && Date.now() - started > TABLE_IMPORT_LIMITS.milliseconds) throw new Error("Перевищено час імпорту таблиці.");
    const character = text[index];
    if (character === "\"") {
      if (quoted && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(cell);
      checkCell();
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      checkCell();
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  checkCell();
  rows.push(row);
  return rows;
}

function preferredDelimiter(text: string, fileName: string): string {
  if (fileName.toLocaleLowerCase("uk").endsWith(".tsv")) return "\t";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  return [";", ",", "\t"]
    .map((delimiter) => ({ delimiter, count: splitDelimitedLine(firstLine, delimiter).length }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ",";
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
}

async function parseXlsxTable(bytes: Uint8Array, signal?: AbortSignal): Promise<ImportParseResult> {
  const files = await unzipBoundedXlsx(bytes, signal);
  signal?.throwIfAborted();
  const workbook = xmlDocument(textFile(files, "xl/workbook.xml"));
  const rels = workbookRelationships(textFile(files, "xl/_rels/workbook.xml.rels"));
  const sheet = Array.from(workbook.getElementsByTagName("sheet"))[0];
  if (!sheet) throw new Error("У Excel-файлі не знайдено аркушів.");
  const sheetName = sheet.getAttribute("name") ?? "Аркуш 1";
  const relationshipId = sheet.getAttribute("r:id") ?? "";
  const target = rels.get(relationshipId) ?? "worksheets/sheet1.xml";
  const sheetPath = `xl/${target.replace(/^\/?xl\//, "")}`;
  const sharedStrings = files.has("xl/sharedStrings.xml")
    ? sharedStringValues(textFile(files, "xl/sharedStrings.xml"))
    : [];
  const rows = worksheetRows(textFile(files, sheetPath), sharedStrings);
  if (rows.length < 2) throw new Error("В Excel-файлі немає рядків для імпорту.");
  const headers = rows[0].map((header) => header.trim());
  return {
    sheetName,
    headers,
    rows: rows.slice(1)
      .map((cells, index) => ({
        sourceRowNumber: index + 2,
        values: Object.fromEntries(headers.map((header, columnIndex) => [header, cells[columnIndex] ?? ""])),
      }))
      .filter((row) => !isEmptyValues(row.values)),
  };
}

function xmlDocument(text: string): Document {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("XML із DTD/ENTITY не підтримується для табличного імпорту.");
  const parser = new DOMParser();
  const document = parser.parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length) {
    throw new Error("Не вдалося прочитати XML всередині Excel-файлу.");
  }
  return document;
}

function workbookRelationships(text: string): Map<string, string> {
  const document = xmlDocument(text);
  return new Map(Array.from(document.getElementsByTagName("Relationship")).map((relationship) => [
    relationship.getAttribute("Id") ?? "",
    relationship.getAttribute("Target") ?? "",
  ]));
}

function sharedStringValues(text: string): string[] {
  const document = xmlDocument(text);
  return Array.from(document.getElementsByTagName("si")).map((item) =>
    Array.from(item.getElementsByTagName("t")).map((node) => node.textContent ?? "").join("")
  );
}

function worksheetRows(text: string, sharedStrings: string[]): string[][] {
  const document = xmlDocument(text);
  if (document.getElementsByTagName("row").length > TABLE_IMPORT_LIMITS.rows || document.getElementsByTagName("c").length > TABLE_IMPORT_LIMITS.cells) {
    throw new Error("Забагато рядків або комірок. Розділіть таблицю на частини.");
  }
  const started = Date.now();
  return Array.from(document.getElementsByTagName("row")).map((row) => {
    if (row.parentElement?.localName !== "sheetData" || row.parentElement.parentElement?.localName !== "worksheet") throw new Error("Некоректна вкладеність рядків Excel.");
    if (Date.now() - started > TABLE_IMPORT_LIMITS.milliseconds) throw new Error("Перевищено час імпорту таблиці.");
    const cells: string[] = [];
    for (const cell of Array.from(row.children)) {
      if (cell.localName !== "c") continue;
      if (cell.getElementsByTagName("c").length || cell.getElementsByTagName("row").length) throw new Error("Некоректна вкладеність комірок Excel.");
      const reference = cell.getAttribute("r") ?? "";
      const columnIndex = columnIndexFromReference(reference);
      if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= TABLE_IMPORT_LIMITS.columns) throw new Error("Забагато колонок у таблиці (максимум 512).");
      cells[columnIndex] = cellText(cell, sharedStrings);
    }
    return cells;
  });
}

function cellText(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute("t") ?? "";
  if (type === "inlineStr") {
    return Array.from(cell.getElementsByTagName("t")).map((node) => node.textContent ?? "").join("");
  }
  const value = cell.getElementsByTagName("v")[0]?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "Так" : "Ні";
  return value;
}

function columnIndexFromReference(reference: string): number {
  const letters = reference.match(/[A-Z]+/i)?.[0]?.toUpperCase() ?? "A";
  return letters.split("").reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function textFile(files: Map<string, Uint8Array>, path: string): string {
  const file = files.get(path);
  if (!file) throw new Error(`В Excel-файлі не знайдено ${path}.`);
  return decodeBytes(file);
}

function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function isEmptyValues(values: Record<string, string>): boolean {
  return Object.entries(values)
    .filter(([label]) => !ignoredLabels.has(normalizeLabel(label)))
    .every(([, value]) => !value.trim());
}
