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
import { participantSummary } from "./findingParticipants";
import { standardLabels } from "./excelExport";

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

export async function parseImportTableFile(file: File): Promise<ImportParseResult> {
  const lowerName = file.name.toLocaleLowerCase("uk");
  if (lowerName.endsWith(".csv")) {
    return parseCsvTable(await file.text(), file.name);
  }
  if (lowerName.endsWith(".xlsx")) {
    return parseXlsxTable(new Uint8Array(await file.arrayBuffer()));
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
  if (["gender", "status"].includes(key)) return "select";
  if (["residencePlaces", "notes"].includes(key)) return "textarea";
  return "text";
}

function personFieldOptions(key: string): string[] | undefined {
  if (key === "gender") return ["невідомо", "чоловік", "жінка"];
  if (key === "status") return ["доведена", "частково доведена", "гіпотетична", "сумнівна", "спростована"];
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
    const value = rawValue.trim();
    if (!value || ignoredLabels.has(normalizeLabel(label))) continue;
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
    const participants = participantInputs
      .map(parseParticipantCell)
      .filter((participant): participant is FindingParticipant => Boolean(participant));
    if (participants.length) record.participants = participants;
    record.people = participantSummary(record.participants as FindingParticipant[]);
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
  if (field.type === "select") {
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
    return value
      .split(/\n+/)
      .map(parseParticipantCell)
      .filter((participant): participant is FindingParticipant => Boolean(participant));
  }
  return value;
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

function parseParticipantCell(value: string | undefined): FindingParticipant | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parts = text.split(/\n|:/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) {
    return { id: createId(), role: "основна особа", name: parts[0], notes: "" };
  }
  return {
    id: createId(),
    role: parts[0] || "основна особа",
    name: parts[1] || parts[0],
    notes: parts.slice(2).join("; "),
  };
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
      cells[columnIndex]?.trim() ?? "",
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

  for (let index = 0; index < text.length; index += 1) {
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
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
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

async function parseXlsxTable(bytes: Uint8Array): Promise<ImportParseResult> {
  const files = await unzipXlsx(bytes);
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
        values: Object.fromEntries(headers.map((header, columnIndex) => [header, cells[columnIndex]?.trim() ?? ""])),
      }))
      .filter((row) => !isEmptyValues(row.values)),
  };
}

function xmlDocument(text: string): Document {
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
  return Array.from(document.getElementsByTagName("row")).map((row) => {
    const cells: string[] = [];
    for (const cell of Array.from(row.getElementsByTagName("c"))) {
      const reference = cell.getAttribute("r") ?? "";
      const columnIndex = columnIndexFromReference(reference);
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

async function unzipXlsx(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  const entries = view.getUint16(eocdOffset + 10, true);
  const files = new Map<string, Uint8Array>();
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Excel-файл має пошкоджену ZIP-структуру.");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decodeBytes(bytes.slice(offset + 46, offset + 46 + nameLength));
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    files.set(name, await decompressZipEntry(compressed, method));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function decompressZipEntry(bytes: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error("Excel-файл використовує непідтримуваний метод стиснення.");
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Браузер не підтримує розпакування Excel-файлів. Збережіть таблицю як CSV і імпортуйте CSV.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Файл не схожий на коректний .xlsx.");
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
