import JSZip from "jszip";

/**
 * Browser-side preparation for the event-centric Zagulyaky XLSX import.
 *
 * The full workbook never has to be parsed by an Edge Function: this module
 * validates the operator-selected file locally, produces the exact private
 * ledger rows expected by the import RPCs, and divides them into deterministic
 * bounded chunks.  It deliberately retains every original spreadsheet column
 * under `workbook_row_private`; only the normalized projection is sent to the
 * corresponding private ledger columns.
 */

const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_UNCOMPRESSED_BYTES = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 1_500;
const MAX_TOTAL_CELLS = 1_000_000;
const MAX_TOTAL_TEXT_CHARS = 25_000_000;
const MAX_CELL_TEXT_CHARS = 32_767;
const HEADER_ROW_NUMBER = 6;
export const ZAGULYAKY_TABULAR_CHUNK_ROW_LIMIT = 250;

type JsonObject = Record<string, unknown>;
export type ZagulyakyTabularWorkbookRow = Record<string, string>;
export type ZagulyakyTabularServiceRow = Record<string, unknown>;

export type ZagulyakyTabularWorkbookChunk = {
  sourcePosts: ZagulyakyTabularServiceRow[];
  events: ZagulyakyTabularServiceRow[];
  participants: ZagulyakyTabularServiceRow[];
  eventSources: ZagulyakyTabularServiceRow[];
  cards: ZagulyakyTabularServiceRow[];
  qc: ZagulyakyTabularServiceRow[];
};

export type ZagulyakyTabularParsedWorkbook = {
  importBatchToken: string;
  sourcePosts: ZagulyakyTabularWorkbookRow[];
  events: ZagulyakyTabularWorkbookRow[];
  participants: ZagulyakyTabularWorkbookRow[];
  eventSources: ZagulyakyTabularWorkbookRow[];
  cards: ZagulyakyTabularWorkbookRow[];
  qc: ZagulyakyTabularWorkbookRow[];
  noCardEventCount: number;
};

export type ZagulyakyTabularWorkbookPlan = {
  sourceChecksum: string;
  parsed: ZagulyakyTabularParsedWorkbook;
  normalized: ZagulyakyTabularNormalizedWorkbook;
  chunks: ZagulyakyTabularWorkbookChunk[];
  summary: ZagulyakyTabularWorkbookSummary;
};

export type ZagulyakyTabularNormalizedWorkbook = {
  sourcePosts: ZagulyakyTabularServiceRow[];
  events: ZagulyakyTabularServiceRow[];
  participants: ZagulyakyTabularServiceRow[];
  eventSources: ZagulyakyTabularServiceRow[];
  cards: ZagulyakyTabularServiceRow[];
  qc: ZagulyakyTabularServiceRow[];
};

export type ZagulyakyTabularWorkbookSummary = {
  importContractVersion: 1;
  sourcePostCount: number;
  eventCount: number;
  participantCount: number;
  eventSourceCount: number;
  cardCount: number;
  qcCount: number;
  noCardEventCount: number;
  readyCardCount: number;
  needsReviewCardCount: number;
  possibleLivingCardCount: number;
  privateSourceUrlCount: number;
  unreviewedEventSourceCount: number;
};

export class ZagulyakyTabularWorkbookProblem extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ZagulyakyTabularWorkbookProblem";
    this.code = code;
  }
}

type PayloadKey = "source_posts" | "events" | "participants" | "event_sources" | "cards" | "qc";

type SheetContract = {
  name: string;
  payloadKey: PayloadKey;
  headers: readonly string[];
  maxRows: number;
  key: string;
};

const SOURCE_HEADERS = [
  "import_batch_id",
  "post_key",
  "source_platform",
  "facebook_post_url_private",
  "source_collection_url_private",
  "source_author_label_private",
  "source_date_text",
  "source_published_at",
  "source_date_precision",
  "post_original_text",
  "post_text_complete",
  "source_content_sha256",
  "source_file_name",
  "source_row_number",
  "source_status",
  "source_notes_private",
] as const;

const EVENT_HEADERS = [
  "import_batch_id",
  "event_key",
  "post_key",
  "event_no_in_post",
  "event_group_key",
  "event_type",
  "event_type_original",
  "event_date_text",
  "event_year_from",
  "event_year_to",
  "event_month",
  "event_day",
  "date_precision",
  "calendar_style",
  "event_place_original",
  "event_place_normalized",
  "church_or_parish_original",
  "record_number",
  "document_language",
  "record_types",
  "event_original_text",
  "event_summary",
  "event_confidence",
  "event_status",
  "event_notes",
] as const;

const PARTICIPANT_HEADERS = [
  "import_batch_id",
  "participant_key",
  "person_card_key",
  "event_key",
  "post_key",
  "participant_sort_order",
  "structural_role",
  "event_role_code",
  "event_role_custom",
  "original_full_name",
  "normalized_uk_full_name",
  "surname",
  "given_name",
  "patronymic",
  "maiden_name",
  "sex",
  "age_text",
  "age_years",
  "origin_text",
  "residence_text",
  "social_estate_text",
  "occupation_or_rank_text",
  "marital_status_text",
  "relation_original",
  "participant_original_text",
  "person_evidence_excerpt",
  "field_confidence",
  "possible_living_person",
  "participant_status",
  "potential_duplicate_key",
  "participant_notes",
  "private_search_text",
] as const;

const EVENT_SOURCE_HEADERS = [
  "import_batch_id",
  "event_source_key",
  "event_key",
  "is_primary",
  "source_type",
  "source_title",
  "archive_name",
  "fond",
  "inventory",
  "file_number",
  "page_from",
  "page_to",
  "citation",
  "source_url_public_candidate",
  "source_platform",
  "external_id",
  "access_date",
  "permission_status",
  "source_notes",
] as const;

const CARD_HEADERS = [
  "import_batch_id",
  "card_key",
  "event_key",
  "post_key",
  "kind",
  "primary_participant_key",
  "title",
  "card_original_text",
  "normalized_text",
  "summary",
  "classification_reason",
  "verification_status",
  "privacy_review_state",
  "publication_status",
  "card_status",
  "copy_event_participants",
  "duplicate_review_status",
  "card_notes",
] as const;

const QC_HEADERS = [
  "import_batch_id",
  "post_key",
  "event_key",
  "participant_key",
  "severity",
  "qc_code",
  "field_name",
  "original_excerpt",
  "note",
  "review_status",
] as const;

export const ZAGULYAKY_TABULAR_SHEET_CONTRACTS: readonly SheetContract[] = [
  { name: "01_SourcePosts", payloadKey: "source_posts", headers: SOURCE_HEADERS, maxRows: 5_000, key: "post_key" },
  { name: "02_Events", payloadKey: "events", headers: EVENT_HEADERS, maxRows: 50_000, key: "event_key" },
  { name: "03_Participants", payloadKey: "participants", headers: PARTICIPANT_HEADERS, maxRows: 100_000, key: "participant_key" },
  { name: "04_EventSources", payloadKey: "event_sources", headers: EVENT_SOURCE_HEADERS, maxRows: 100_000, key: "event_source_key" },
  { name: "05_Cards", payloadKey: "cards", headers: CARD_HEADERS, maxRows: 100_000, key: "card_key" },
  { name: "06_QC", payloadKey: "qc", headers: QC_HEADERS, maxRows: 200_000, key: "qc_code" },
];

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_PATTERN = /^-?[0-9]{1,10}$/;
const XML_TAG_NAME = "(?:[A-Za-z_][A-Za-z0-9_.-]*:)?";

const EVENT_TYPES = new Set([
  "birth", "baptism", "birth_and_baptism", "marriage", "death", "burial", "divorce",
  "military_service", "residence_record", "court_record", "property_record", "other", "unspecified",
]);
const DATE_PRECISIONS = new Set(["day", "month", "year", "range", "approximate", "before", "after", "unknown"]);
const CALENDAR_STYLES = new Set(["old_style", "new_style", "unknown"]);
const CONFIDENCES = new Set(["high", "medium", "low"]);
const SOURCE_STATUSES = new Set(["ready", "no_zagulyaka", "needs_ocr", "needs_refetch", "needs_review", "quarantined"]);
const EVENT_STATUSES = new Set(["ready", "needs_review", "quarantined", "skip"]);
const PARTICIPANT_STATUSES = new Set(["ready", "needs_review", "skip", "quarantined"]);
const STRUCTURAL_ROLES = new Set(["subject", "spouse", "parent", "child", "witness", "godparent", "official", "relative", "mentioned", "other"]);
const EVENT_ROLES = new Set([
  "subject", "newborn", "baptized", "groom", "bride", "groom_father", "groom_mother",
  "bride_father", "bride_mother", "deceased", "resident", "household_head", "household_member",
  "military_person", "migrant", "godparent", "godchild", "father", "mother", "parent", "child",
  "spouse", "witness", "pledger", "officiant", "registrar", "midwife", "informant", "owner",
  "commander", "official", "priest", "relative", "mentioned_person", "unspecified", "other",
]);
const SEXES = new Set(["male", "female", "unknown"]);
const SOURCE_TYPES = new Set([
  "archive", "archive_record", "library", "website", "online_reference", "online_document", "book", "database", "other",
]);
const PERMISSION_STATUSES = new Set(["not_reviewed", "unknown", "link_only", "permission_granted", "public_domain", "restricted"]);
const CARD_KINDS = new Set(["person", "document"]);
const VERIFICATION_STATUSES = new Set(["unverified", "plausible", "corroborated", "verified", "disputed"]);
const PRIVACY_REVIEW_STATES = new Set(["not_reviewed", "possible_living", "cleared_for_review", "blocked"]);
const CARD_STATUSES = new Set(["ready", "needs_review", "quarantined", "skip"]);
const DUPLICATE_REVIEW_STATUSES = new Set(["not_reviewed", "not_checked", "possible_duplicate", "not_duplicate"]);
const QC_SEVERITIES = new Set(["info", "warning", "error", "blocker"]);
const REVIEW_STATUSES = new Set(["open", "reviewed", "resolved", "ignored"]);

type XmlCell = { value: string; column: number };
type XmlWorksheet = { rowCount: number; columnCount: number; rows: Map<number, Map<number, XmlCell>> };

function problem(code: string): never {
  throw new ZagulyakyTabularWorkbookProblem(code);
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) problem("IMPORT_REQUEST_ABORTED");
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function lower(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function optionalText(row: ZagulyakyTabularWorkbookRow, key: string): string {
  return row[key]?.trim() ?? "";
}

function requiredText(row: ZagulyakyTabularWorkbookRow, key: string): string {
  const value = optionalText(row, key);
  if (!value) problem("WORKBOOK_REQUIRED_FIELD_MISSING");
  return value;
}

function positiveInteger(value: string, maximum: number): number {
  if (!INTEGER_PATTERN.test(value)) problem("WORKBOOK_INTEGER_INVALID");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) problem("WORKBOOK_INTEGER_INVALID");
  return number;
}

function integerForCanonicalization(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!INTEGER_PATTERN.test(normalized)) problem("WORKBOOK_INTEGER_INVALID");
  const number = Number(normalized);
  if (!Number.isSafeInteger(number)) problem("WORKBOOK_INTEGER_INVALID");
  return number;
}

function valueIsIn(row: ZagulyakyTabularWorkbookRow, key: string, values: Set<string>, required = false): void {
  const value = optionalText(row, key);
  if (!value) {
    if (required) problem("WORKBOOK_ENUM_INVALID");
    return;
  }
  if (!values.has(lower(value))) problem("WORKBOOK_ENUM_INVALID");
}

function assertHttpUrl(row: ZagulyakyTabularWorkbookRow, key: string): void {
  const value = optionalText(row, key);
  if (!value) return;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || value.length > 4_000) {
      problem("WORKBOOK_URL_INVALID");
    }
  } catch (error) {
    if (error instanceof ZagulyakyTabularWorkbookProblem) throw error;
    problem("WORKBOOK_URL_INVALID");
  }
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/gu, (_whole, entity: string) => {
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return "\"";
      case "apos": return "'";
      default: {
        const codePoint = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) problem("INVALID_XLSX_FILE");
        return String.fromCodePoint(codePoint);
      }
    }
  });
}

function xmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of value.matchAll(matcher)) {
    const key = match[1];
    if (!key || Object.hasOwn(attributes, key)) problem("INVALID_XLSX_FILE");
    attributes[key] = decodeXmlText(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function xmlTagText(xml: string, name: string): string {
  const matcher = new RegExp(`<${XML_TAG_NAME}${name}\\b[^>]*>([\\s\\S]*?)<\\/${XML_TAG_NAME}${name}>`, "gu");
  const values: string[] = [];
  for (const match of xml.matchAll(matcher)) values.push(decodeXmlText(match[1] ?? ""));
  return values.join("");
}

function columnIndexFromReference(reference: string): number {
  const match = /^([A-Z]{1,3})[1-9][0-9]*$/u.exec(reference.toUpperCase());
  if (!match) problem("WORKBOOK_CELL_REFERENCE_INVALID");
  let result = 0;
  for (const letter of match[1]!) result = result * 26 + letter.charCodeAt(0) - 64;
  if (result < 1 || result > 16_384) problem("WORKBOOK_CELL_REFERENCE_INVALID");
  return result - 1;
}

function rowNumberFromReference(reference: string): number {
  const match = /^[A-Z]{1,3}([1-9][0-9]*)$/u.exec(reference.toUpperCase());
  if (!match) problem("WORKBOOK_CELL_REFERENCE_INVALID");
  const row = Number(match[1]);
  if (!Number.isSafeInteger(row) || row > 1_048_576) problem("WORKBOOK_CELL_REFERENCE_INVALID");
  return row;
}

function parseRangeReference(reference: string): { startRow: number; endRow: number; startColumn: number; endColumn: number } {
  const [startText, endText = startText] = reference.split(":", 2);
  if (!startText || !endText) problem("WORKBOOK_SHEET_RANGE_INVALID");
  const startRow = rowNumberFromReference(startText);
  const endRow = rowNumberFromReference(endText);
  const startColumn = columnIndexFromReference(startText);
  const endColumn = columnIndexFromReference(endText);
  if (endRow < startRow || endColumn < startColumn) problem("WORKBOOK_SHEET_RANGE_INVALID");
  return { startRow, endRow, startColumn, endColumn };
}

function extractRichText(xml: string): string {
  const matcher = new RegExp(`<${XML_TAG_NAME}t\\b[^>]*>([\\s\\S]*?)<\\/${XML_TAG_NAME}t>`, "gu");
  const values: string[] = [];
  for (const match of xml.matchAll(matcher)) values.push(decodeXmlText(match[1] ?? ""));
  return values.join("");
}

function parseSharedStrings(xml: string): string[] {
  const matcher = new RegExp(`<${XML_TAG_NAME}si\\b[^>]*>([\\s\\S]*?)<\\/${XML_TAG_NAME}si>`, "gu");
  const values: string[] = [];
  for (const match of xml.matchAll(matcher)) values.push(extractRichText(match[1] ?? ""));
  return values;
}

function parseCellValue(body: string, attributes: Record<string, string>, sharedStrings: readonly string[]): string {
  if (new RegExp(`<${XML_TAG_NAME}f\\b`, "u").test(body)) problem("WORKBOOK_FORMULAS_NOT_ALLOWED");
  const type = attributes.t ?? "n";
  if (type === "inlineStr") return extractRichText(body);
  const value = xmlTagText(body, "v");
  if (type === "s") {
    if (!/^[0-9]+$/u.test(value)) problem("WORKBOOK_CELL_TYPE_INVALID");
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) problem("WORKBOOK_CELL_TYPE_INVALID");
    return sharedStrings[index]!;
  }
  if (type === "b") {
    if (value === "1") return "true";
    if (value === "0") return "false";
    problem("WORKBOOK_CELL_TYPE_INVALID");
  }
  if (type === "e") problem("WORKBOOK_CELL_TYPE_INVALID");
  if (type !== "n" && type !== "str" && type !== "d") problem("WORKBOOK_CELL_TYPE_INVALID");
  return value;
}

function parseWorksheet(xml: string, sharedStrings: readonly string[]): XmlWorksheet {
  const dimensionMatch = new RegExp(`<${XML_TAG_NAME}dimension\\b([^>]*)\\/?\\s*>`, "u").exec(xml);
  const dimension = dimensionMatch ? xmlAttributes(dimensionMatch[1] ?? "").ref : undefined;
  const declaredRange = dimension ? parseRangeReference(dimension) : null;
  const rows = new Map<number, Map<number, XmlCell>>();
  const rowMatcher = new RegExp(`<${XML_TAG_NAME}row\\b([^>]*)>([\\s\\S]*?)<\\/${XML_TAG_NAME}row>`, "gu");
  for (const rowMatch of xml.matchAll(rowMatcher)) {
    const rowAttributes = xmlAttributes(rowMatch[1] ?? "");
    const rowNumberText = rowAttributes.r;
    if (!rowNumberText || !/^[1-9][0-9]*$/u.test(rowNumberText)) problem("WORKBOOK_CELL_REFERENCE_INVALID");
    const rowNumber = Number(rowNumberText);
    if (
      !Number.isSafeInteger(rowNumber)
      || rowNumber > 1_048_576
      || (declaredRange !== null && (rowNumber < declaredRange.startRow || rowNumber > declaredRange.endRow))
      || rows.has(rowNumber)
    ) problem("WORKBOOK_CELL_REFERENCE_INVALID");
    const cells = new Map<number, XmlCell>();
    const cellMatcher = new RegExp(`<${XML_TAG_NAME}c\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${XML_TAG_NAME}c>)`, "gu");
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(cellMatcher)) {
      const cellAttributes = xmlAttributes(cellMatch[1] ?? "");
      const reference = cellAttributes.r;
      if (!reference || rowNumberFromReference(reference) !== rowNumber) problem("WORKBOOK_CELL_REFERENCE_INVALID");
      const column = columnIndexFromReference(reference);
      if (
        (declaredRange !== null && (column < declaredRange.startColumn || column > declaredRange.endColumn))
        || cells.has(column)
      ) problem("WORKBOOK_CELL_REFERENCE_INVALID");
      cells.set(column, { column, value: parseCellValue(cellMatch[2] ?? "", cellAttributes, sharedStrings) });
    }
    rows.set(rowNumber, cells);
  }
  const populatedCells = [...rows.entries()].flatMap(([rowNumber, cells]) => [...cells.keys()].map((column) => ({ rowNumber, column })));
  if (populatedCells.length === 0) problem("WORKBOOK_SHEET_RANGE_MISSING");
  const derivedRange = {
    startRow: Math.min(...populatedCells.map(({ rowNumber }) => rowNumber)),
    endRow: Math.max(...populatedCells.map(({ rowNumber }) => rowNumber)),
    startColumn: Math.min(...populatedCells.map(({ column }) => column)),
    endColumn: Math.max(...populatedCells.map(({ column }) => column)),
  };
  const range = declaredRange ?? derivedRange;
  return {
    rowCount: range.endRow - range.startRow + 1,
    columnCount: range.endColumn - range.startColumn + 1,
    rows,
  };
}

function readWorksheet(contract: SheetContract, worksheet: XmlWorksheet): ZagulyakyTabularWorkbookRow[] {
  if (
    worksheet.rowCount < HEADER_ROW_NUMBER + 1
    || worksheet.rowCount > contract.maxRows + HEADER_ROW_NUMBER + 50
    || worksheet.columnCount > contract.headers.length + 10
  ) {
    problem("WORKBOOK_SHEET_DIMENSIONS_INVALID");
  }
  const headerCells = worksheet.rows.get(HEADER_ROW_NUMBER);
  if (!headerCells) problem("WORKBOOK_HEADER_ROW_MISSING");
  const expected = [...contract.headers];
  if (
    worksheet.columnCount < expected.length
    || expected.some((header, index) => (headerCells.get(index)?.value ?? "").trim() !== header)
    || Array.from({ length: Math.max(0, worksheet.columnCount - expected.length) }, (_, index) => expected.length + index)
      .some((index) => Boolean((headerCells.get(index)?.value ?? "").trim()))
  ) {
    problem("WORKBOOK_HEADERS_INVALID");
  }

  let totalTextLength = 0;
  const result: ZagulyakyTabularWorkbookRow[] = [];
  const finalRowNumber = Math.max(...worksheet.rows.keys(), HEADER_ROW_NUMBER);
  for (let rowNumber = HEADER_ROW_NUMBER + 1; rowNumber <= finalRowNumber; rowNumber += 1) {
    const cells = worksheet.rows.get(rowNumber);
    const rowValues = Array.from({ length: worksheet.columnCount }, (_, column) => cells?.get(column)?.value ?? "");
    if (rowValues.every((value) => value.trim() === "")) continue;
    if (result.length >= contract.maxRows) problem("WORKBOOK_ROW_LIMIT_EXCEEDED");
    if (rowValues.slice(expected.length).some((value) => value.trim() !== "")) problem("WORKBOOK_EXTRA_CELL_DATA");
    const row: ZagulyakyTabularWorkbookRow = {};
    for (let column = 0; column < expected.length; column += 1) {
      const value = rowValues[column] ?? "";
      if (value.includes("\u0000") || value.length > MAX_CELL_TEXT_CHARS) problem("WORKBOOK_CELL_TEXT_INVALID");
      totalTextLength += value.length;
      row[expected[column]!] = value;
    }
    result.push(row);
  }
  if (totalTextLength > MAX_TOTAL_TEXT_CHARS) problem("WORKBOOK_TEXT_LIMIT_EXCEEDED");
  return result;
}

function preflightXlsxZip(bytes: Uint8Array): void {
  if (bytes.byteLength < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) problem("INVALID_XLSX_FILE");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => {
    if (offset < 0 || offset + 2 > bytes.byteLength) problem("INVALID_XLSX_FILE");
    return view.getUint16(offset, true);
  };
  const u32 = (offset: number) => {
    if (offset < 0 || offset + 4 > bytes.byteLength) problem("INVALID_XLSX_FILE");
    return view.getUint32(offset, true);
  };
  let eocdOffset = -1;
  const scanStart = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= scanStart; offset -= 1) {
    if (u32(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) problem("INVALID_XLSX_FILE");

  const entryCount = u16(eocdOffset + 10);
  const centralDirectorySize = u32(eocdOffset + 12);
  const centralDirectoryOffset = u32(eocdOffset + 16);
  if (
    entryCount < 1
    || entryCount > MAX_ZIP_ENTRIES
    || centralDirectoryOffset + centralDirectorySize > bytes.byteLength
    || entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    problem("UNSAFE_XLSX_PACKAGE");
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(cursor) !== 0x02014b50) problem("INVALID_XLSX_FILE");
    const flags = u16(cursor + 8);
    const compressedSize = u32(cursor + 20);
    const uncompressedSize = u32(cursor + 24);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const localOffset = u32(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      (flags & 0x0001) !== 0
      || compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
      || nextCursor > centralDirectoryOffset + centralDirectorySize
    ) {
      problem("UNSAFE_XLSX_PACKAGE");
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).replace(/\\/gu, "/");
    const lowerName = name.toLowerCase();
    if (!name || name.startsWith("/") || name.includes("../") || lowerName.endsWith("vbaproject.bin")) {
      problem("UNSAFE_XLSX_PACKAGE");
    }
    totalUncompressed += uncompressedSize;
    totalCompressed += compressedSize;
    if (
      totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES
      || totalUncompressed > Math.max(1_000_000, totalCompressed * 250)
    ) {
      problem("UNSAFE_XLSX_PACKAGE");
    }
    cursor = nextCursor;
  }
  if (cursor !== centralDirectoryOffset + centralDirectorySize) problem("INVALID_XLSX_FILE");
}

function resolveZipPath(basePath: string, target: string): string {
  const normalized = target.replace(/\\/gu, "/");
  const root = normalized.startsWith("/") ? [] : basePath.split("/").slice(0, -1);
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (root.length === 0) problem("INVALID_XLSX_FILE");
      root.pop();
      continue;
    }
    root.push(segment);
  }
  const path = root.join("/");
  if (!path.startsWith("xl/")) problem("INVALID_XLSX_FILE");
  return path;
}

type WorkbookSheetPath = { name: string; path: string };

function workbookSheetPaths(workbookXml: string, relationshipsXml: string): WorkbookSheetPath[] {
  const relationshipById = new Map<string, string>();
  const relationshipMatcher = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?Relationship\b([^>]*)\/?\s*>/gu;
  for (const relationshipMatch of relationshipsXml.matchAll(relationshipMatcher)) {
    const attributes = xmlAttributes(relationshipMatch[1] ?? "");
    const id = attributes.Id;
    const target = attributes.Target;
    const type = attributes.Type ?? "";
    if (!id || !target) problem("INVALID_XLSX_FILE");
    if (type.endsWith("/worksheet")) relationshipById.set(id, resolveZipPath("xl/workbook.xml", target));
  }
  const sheets: WorkbookSheetPath[] = [];
  const seen = new Set<string>();
  const sheetMatcher = /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?sheet\b([^>]*)\/?\s*>/gu;
  for (const sheetMatch of workbookXml.matchAll(sheetMatcher)) {
    const attributes = xmlAttributes(sheetMatch[1] ?? "");
    const name = attributes.name;
    const relationshipId = attributes["r:id"];
    if (!name || !relationshipId || seen.has(name)) problem("INVALID_XLSX_FILE");
    const path = relationshipById.get(relationshipId);
    if (!path) problem("INVALID_XLSX_FILE");
    seen.add(name);
    sheets.push({ name, path });
  }
  if (sheets.length === 0 || sheets.length > 20) problem("WORKBOOK_SHEET_LIMIT_EXCEEDED");
  return sheets;
}

async function zipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) problem("INVALID_XLSX_FILE");
  try {
    return await entry.async("string");
  } catch {
    problem("INVALID_XLSX_FILE");
  }
}

function assertNoFormulas(zip: JSZip): void {
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !/^xl\/worksheets\/[^/]+\.xml$/iu.test(path)) continue;
    // JSZip's internal compressed data is not enough for content inspection,
    // so this synchronous guard intentionally runs again in readXlsxRows.
    if (path.toLocaleLowerCase("en-US").endsWith("vbaproject.bin")) problem("UNSAFE_XLSX_PACKAGE");
  }
}

async function readXlsxRows(bytes: Uint8Array, signal?: AbortSignal): Promise<Partial<Record<PayloadKey, ZagulyakyTabularWorkbookRow[]>>> {
  ensureNotAborted(signal);
  preflightXlsxZip(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
  } catch {
    problem("INVALID_XLSX_FILE");
  }
  ensureNotAborted(signal);
  assertNoFormulas(zip);
  const [workbookXml, relationshipsXml, sharedStringsXml] = await Promise.all([
    zipText(zip, "xl/workbook.xml"),
    zipText(zip, "xl/_rels/workbook.xml.rels"),
    zip.file("xl/sharedStrings.xml") ? zipText(zip, "xl/sharedStrings.xml") : Promise.resolve(""),
  ]);
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const sheets = workbookSheetPaths(workbookXml, relationshipsXml);
  const sheetsByName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  for (const contract of ZAGULYAKY_TABULAR_SHEET_CONTRACTS) {
    if (!sheetsByName.has(contract.name)) problem("WORKBOOK_REQUIRED_SHEET_MISSING");
  }

  // Reject formulas in every workbook sheet, not merely data sheets.  The
  // template's explanatory sheets are part of the workbook attack surface.
  for (const sheet of sheets) {
    ensureNotAborted(signal);
    const xml = await zipText(zip, sheet.path);
    if (new RegExp(`<${XML_TAG_NAME}f\\b`, "u").test(xml)) problem("WORKBOOK_FORMULAS_NOT_ALLOWED");
  }

  let totalCells = 0;
  const parsed: Partial<Record<PayloadKey, ZagulyakyTabularWorkbookRow[]>> = {};
  for (const contract of ZAGULYAKY_TABULAR_SHEET_CONTRACTS) {
    ensureNotAborted(signal);
    const sheet = sheetsByName.get(contract.name);
    if (!sheet) problem("WORKBOOK_REQUIRED_SHEET_MISSING");
    const rows = readWorksheet(contract, parseWorksheet(await zipText(zip, sheet.path), sharedStrings));
    totalCells += rows.length * contract.headers.length;
    if (totalCells > MAX_TOTAL_CELLS) problem("WORKBOOK_CELL_LIMIT_EXCEEDED");
    parsed[contract.payloadKey] = rows;
  }
  return parsed;
}

function assertUniqueKeys(rows: ZagulyakyTabularWorkbookRow[], key: string): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = requiredText(row, key);
    if (!KEY_PATTERN.test(value) || seen.has(value)) problem("WORKBOOK_KEY_INVALID");
    seen.add(value);
  }
}

function assertRowValues(workbook: Omit<ZagulyakyTabularParsedWorkbook, "importBatchToken" | "noCardEventCount">): void {
  for (const row of workbook.sourcePosts) {
    requiredText(row, "source_platform");
    valueIsIn(row, "source_status", SOURCE_STATUSES, true);
    const hash = optionalText(row, "source_content_sha256").toLowerCase();
    if (hash && !SHA256_PATTERN.test(hash)) problem("WORKBOOK_HASH_INVALID");
    const rowNumber = optionalText(row, "source_row_number");
    if (rowNumber) positiveInteger(rowNumber, 5_000_000);
    assertHttpUrl(row, "facebook_post_url_private");
    assertHttpUrl(row, "source_collection_url_private");
  }
  for (const row of workbook.events) {
    positiveInteger(requiredText(row, "event_no_in_post"), 1_000_000);
    valueIsIn(row, "event_type", EVENT_TYPES, true);
    valueIsIn(row, "date_precision", DATE_PRECISIONS, true);
    valueIsIn(row, "calendar_style", CALENDAR_STYLES);
    valueIsIn(row, "event_confidence", CONFIDENCES, true);
    valueIsIn(row, "event_status", EVENT_STATUSES, true);
    for (const key of ["event_year_from", "event_year_to"]) {
      const value = optionalText(row, key);
      if (value) positiveInteger(value, 2_200);
    }
    for (const key of ["event_month", "event_day"]) {
      const value = optionalText(row, key);
      if (value) positiveInteger(value, key === "event_month" ? 12 : 31);
    }
    const from = optionalText(row, "event_year_from");
    const to = optionalText(row, "event_year_to");
    if (from && to && positiveInteger(to, 2_200) < positiveInteger(from, 2_200)) {
      problem("WORKBOOK_EVENT_DATE_INVALID");
    }
  }
  for (const row of workbook.participants) {
    requiredText(row, "person_card_key");
    positiveInteger(requiredText(row, "participant_sort_order"), 1_000_000);
    valueIsIn(row, "structural_role", STRUCTURAL_ROLES, true);
    valueIsIn(row, "event_role_code", EVENT_ROLES, true);
    valueIsIn(row, "sex", SEXES);
    valueIsIn(row, "field_confidence", CONFIDENCES, true);
    valueIsIn(row, "participant_status", PARTICIPANT_STATUSES, true);
    const living = lower(requiredText(row, "possible_living_person"));
    if (living !== "yes" && living !== "no" && living !== "unknown") problem("WORKBOOK_ENUM_INVALID");
    // Source material can have an implausible or OCR-corrupted numeric age.
    // It remains in `workbook_row_private`, but `canonicalAgeYears` keeps it
    // out of the SQL column constrained to 0..140.
    integerForCanonicalization(optionalText(row, "age_years"));
    const eventRole = lower(requiredText(row, "event_role_code"));
    if (eventRole !== "other" && Boolean(optionalText(row, "event_role_custom"))) {
      problem("WORKBOOK_EVENT_ROLE_INVALID");
    }
  }
  for (const row of workbook.eventSources) {
    valueIsIn(row, "is_primary", new Set(["yes", "no"]), true);
    valueIsIn(row, "source_type", SOURCE_TYPES, true);
    valueIsIn(row, "permission_status", PERMISSION_STATUSES, true);
    assertHttpUrl(row, "source_url_public_candidate");
  }
  for (const row of workbook.cards) {
    valueIsIn(row, "kind", CARD_KINDS, true);
    requiredText(row, "primary_participant_key");
    requiredText(row, "title");
    valueIsIn(row, "verification_status", VERIFICATION_STATUSES, true);
    valueIsIn(row, "privacy_review_state", PRIVACY_REVIEW_STATES, true);
    if (lower(requiredText(row, "publication_status")) !== "draft") problem("WORKBOOK_PUBLICATION_STATUS_INVALID");
    valueIsIn(row, "card_status", CARD_STATUSES, true);
    valueIsIn(row, "copy_event_participants", new Set(["yes", "no"]), true);
    valueIsIn(row, "duplicate_review_status", DUPLICATE_REVIEW_STATUSES, true);
  }
  for (const row of workbook.qc) {
    valueIsIn(row, "severity", QC_SEVERITIES, true);
    if (!/^[A-Z0-9_]{3,100}$/u.test(requiredText(row, "qc_code"))) problem("WORKBOOK_QC_CODE_INVALID");
    valueIsIn(row, "review_status", REVIEW_STATUSES, true);
  }
}

function validateGraph(workbook: Omit<ZagulyakyTabularParsedWorkbook, "importBatchToken" | "noCardEventCount">): number {
  assertUniqueKeys(workbook.sourcePosts, "post_key");
  assertUniqueKeys(workbook.events, "event_key");
  assertUniqueKeys(workbook.participants, "participant_key");
  assertUniqueKeys(workbook.eventSources, "event_source_key");
  assertUniqueKeys(workbook.cards, "card_key");

  const postsByKey = new Map(workbook.sourcePosts.map((row) => [requiredText(row, "post_key"), row]));
  const eventsByKey = new Map(workbook.events.map((row) => [requiredText(row, "event_key"), row]));
  const participantsByKey = new Map(workbook.participants.map((row) => [requiredText(row, "participant_key"), row]));
  const cardsByKey = new Map(workbook.cards.map((row) => [requiredText(row, "card_key"), row]));

  for (const row of workbook.events) {
    if (!postsByKey.has(requiredText(row, "post_key"))) problem("WORKBOOK_EVENT_POST_REFERENCE_INVALID");
  }
  for (const row of workbook.participants) {
    const event = eventsByKey.get(requiredText(row, "event_key"));
    if (!event || !postsByKey.has(requiredText(row, "post_key")) || event.post_key !== row.post_key) {
      problem("WORKBOOK_PARTICIPANT_REFERENCE_INVALID");
    }
    if (!cardsByKey.has(requiredText(row, "person_card_key"))) problem("WORKBOOK_PARTICIPANT_CARD_REFERENCE_INVALID");
  }
  const primarySourceCount = new Map<string, number>();
  for (const row of workbook.eventSources) {
    const event = eventsByKey.get(requiredText(row, "event_key"));
    if (!event) problem("WORKBOOK_EVENT_SOURCE_REFERENCE_INVALID");
    if (lower(row.is_primary) === "yes") {
      const eventKey = requiredText(row, "event_key");
      const next = (primarySourceCount.get(eventKey) ?? 0) + 1;
      if (next > 1) problem("WORKBOOK_MULTIPLE_PRIMARY_SOURCES");
      primarySourceCount.set(eventKey, next);
    }
  }
  const cardsByEvent = new Map<string, number>();
  for (const row of workbook.cards) {
    const event = eventsByKey.get(requiredText(row, "event_key"));
    const participant = participantsByKey.get(requiredText(row, "primary_participant_key"));
    if (!event || !participant || event.post_key !== row.post_key || participant.event_key !== row.event_key) {
      problem("WORKBOOK_CARD_REFERENCE_INVALID");
    }
    if (participant.person_card_key !== row.card_key) problem("WORKBOOK_CARD_PARTICIPANT_REFERENCE_INVALID");
    cardsByEvent.set(row.event_key, (cardsByEvent.get(row.event_key) ?? 0) + 1);
  }
  for (const row of workbook.qc) {
    const postKey = optionalText(row, "post_key");
    const eventKey = optionalText(row, "event_key");
    const participantKey = optionalText(row, "participant_key");
    const event = eventKey ? eventsByKey.get(eventKey) : undefined;
    const participant = participantKey ? participantsByKey.get(participantKey) : undefined;
    if (postKey && !postsByKey.has(postKey)) problem("WORKBOOK_QC_REFERENCE_INVALID");
    if (eventKey && !event) problem("WORKBOOK_QC_REFERENCE_INVALID");
    if (participantKey && !participant) problem("WORKBOOK_QC_REFERENCE_INVALID");
    if (postKey && event && event.post_key !== postKey) problem("WORKBOOK_QC_REFERENCE_INVALID");
    if (postKey && participant && participant.post_key !== postKey) problem("WORKBOOK_QC_REFERENCE_INVALID");
    if (event && participant && participant.event_key !== eventKey) problem("WORKBOOK_QC_REFERENCE_INVALID");
    if (!postKey && !event && !participant) problem("WORKBOOK_QC_REFERENCE_INVALID");
  }
  return workbook.events.filter((row) => !cardsByEvent.has(row.event_key)).length;
}

export async function parseZagulyakyTabularEventWorkbook(
  input: Blob | ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<ZagulyakyTabularParsedWorkbook> {
  ensureNotAborted(signal);
  let bytes: Uint8Array;
  if (isBlob(input)) {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    bytes = new Uint8Array(input);
  } else {
    problem("INVALID_XLSX_FILE");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKBOOK_BYTES) problem("REQUEST_TOO_LARGE");
  const sourcePostsAndLayers = await readXlsxRows(bytes, signal);
  ensureNotAborted(signal);
  const sourcePosts = sourcePostsAndLayers.source_posts ?? [];
  if (sourcePosts.length < 1) problem("WORKBOOK_SOURCE_POSTS_REQUIRED");
  const partial = {
    sourcePosts,
    events: sourcePostsAndLayers.events ?? [],
    participants: sourcePostsAndLayers.participants ?? [],
    eventSources: sourcePostsAndLayers.event_sources ?? [],
    cards: sourcePostsAndLayers.cards ?? [],
    qc: sourcePostsAndLayers.qc ?? [],
  };
  assertRowValues(partial);
  const tokens = new Set(
    [
      ...partial.sourcePosts,
      ...partial.events,
      ...partial.participants,
      ...partial.eventSources,
      ...partial.cards,
      ...partial.qc,
    ].map((row) => requiredText(row, "import_batch_id")),
  );
  if (tokens.size !== 1) problem("WORKBOOK_BATCH_TOKEN_INVALID");
  const noCardEventCount = validateGraph(partial);
  return { importBatchToken: [...tokens][0]!, ...partial, noCardEventCount };
}

function serviceText(row: ZagulyakyTabularServiceRow, key: string): string {
  const value = row[key];
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  problem("WORKBOOK_SERVICE_ROW_INVALID");
}

function indexServiceRows(rows: ZagulyakyTabularServiceRow[], key: string): Map<string, ZagulyakyTabularServiceRow[]> {
  const result = new Map<string, ZagulyakyTabularServiceRow[]>();
  for (const row of rows) {
    const value = serviceText(row, key);
    if (!value) problem("WORKBOOK_SERVICE_ROW_INVALID");
    const bucket = result.get(value) ?? [];
    bucket.push(row);
    result.set(value, bucket);
  }
  return result;
}

function resolveQcPostKey(
  row: ZagulyakyTabularServiceRow,
  eventsByKey: Map<string, ZagulyakyTabularServiceRow>,
  participantsByKey: Map<string, ZagulyakyTabularServiceRow>,
): string {
  const direct = serviceText(row, "post_key");
  if (direct) return direct;
  const event = eventsByKey.get(serviceText(row, "event_key"));
  if (event) return serviceText(event, "post_key");
  const participant = participantsByKey.get(serviceText(row, "participant_key"));
  if (participant) return serviceText(participant, "post_key");
  problem("WORKBOOK_QC_REFERENCE_INVALID");
}

function booleanFromWorkbook(value: string, fallback: boolean): boolean {
  const normalized = lower(value);
  if (normalized === "yes" || normalized === "true" || normalized === "1" || normalized === "так") return true;
  if (normalized === "no" || normalized === "false" || normalized === "0" || normalized === "ні") return false;
  return fallback;
}

function boundedOneBasedSequence(counter: Map<string, number>, groupKey: string): number {
  const sequence = (counter.get(groupKey) ?? 0) + 1;
  if (sequence > 1_000_000) problem("WORKBOOK_SEQUENCE_INVALID");
  counter.set(groupKey, sequence);
  return sequence;
}

function suppliedOrDerivedSequence(value: string, fallback: number): number {
  const normalized = value.trim();
  if (!normalized) return fallback;
  if (!INTEGER_PATTERN.test(normalized)) problem("WORKBOOK_SEQUENCE_INVALID");
  const sequence = Number(normalized);
  return Number.isSafeInteger(sequence) && sequence >= 1 && sequence <= 1_000_000
    ? sequence
    : fallback;
}

function canonicalDatePrecision(value: string): string {
  return lower(value) === "day" ? "exact" : lower(value);
}

function excelSerialToDate(value: string): Date | null {
  const normalized = value.trim();
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/u.test(normalized)) return null;
  const serial = Number(normalized);
  // Excel's 1900 date system is intentionally mirrored (including its leap
  // year compatibility offset).  Bounded values prevent absurd dates from
  // turning into a seemingly valid timestamp.
  if (!Number.isFinite(serial) || serial < 1 || serial > 100_000) return null;
  const milliseconds = Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000);
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}

function canonicalDate(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  const excelDate = excelSerialToDate(normalized);
  if (excelDate) return excelDate.toISOString().slice(0, 10);
  const match = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/u.exec(normalized);
  if (!match) return normalized;
  const [, day, month, year] = match;
  return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

function canonicalTimestamp(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  const excelDate = excelSerialToDate(normalized);
  return excelDate ? excelDate.toISOString() : normalized;
}

function canonicalSourceType(value: string): string {
  switch (lower(value)) {
    case "archive_record":
      return "archive";
    case "online_reference":
    case "online_document":
      return "website";
    default:
      return lower(value);
  }
}

function canonicalDuplicateReviewStatus(value: string): string {
  return lower(value) === "not_reviewed" ? "not_checked" : lower(value);
}

/**
 * The database constrains this projection to integer years from 0 through
 * 140.  The original entered string is still included in the private source
 * envelope by `privateServiceRow`, including values such as `151` or `-2`.
 */
export function canonicalAgeYears(value: string): string {
  const integer = integerForCanonicalization(value);
  return integer !== null && integer >= 0 && integer <= 140 ? String(integer) : "";
}

function labelledText(parts: Array<[string, string]>): string {
  return parts
    .filter(([, value]) => Boolean(value.trim()))
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("; ");
}

function privateServiceRow(original: ZagulyakyTabularWorkbookRow, fields: ZagulyakyTabularServiceRow): ZagulyakyTabularServiceRow {
  // Clone, do not reuse, the operator-supplied row.  Subsequent UI or relay
  // work cannot mutate it and lose a source column prior to private storage.
  return { ...fields, workbook_row_private: { ...original } };
}

export function normalizeZagulyakyTabularEventWorkbook(
  workbook: ZagulyakyTabularParsedWorkbook,
): ZagulyakyTabularNormalizedWorkbook {
  const eventsByKey = new Map(workbook.events.map((row) => [requiredText(row, "event_key"), row]));
  const participantsByKey = new Map(workbook.participants.map((row) => [requiredText(row, "participant_key"), row]));
  const participantSequence = new Map<string, number>();
  const sourceSequence = new Map<string, number>();
  const cardSequence = new Map<string, number>();
  const eventSequence = new Map<string, number>();

  const sourcePosts = workbook.sourcePosts.map((row) => privateServiceRow(row, {
    post_key: requiredText(row, "post_key"),
    source_platform: optionalText(row, "source_platform"),
    facebook_post_url_private: optionalText(row, "facebook_post_url_private"),
    source_collection_url_private: optionalText(row, "source_collection_url_private"),
    source_author_label_private: optionalText(row, "source_author_label_private"),
    source_date_text: row.source_date_text ?? "",
    source_date_precision: optionalText(row, "source_date_precision"),
    source_published_at: canonicalTimestamp(row.source_published_at ?? ""),
    source_collected_at: "",
    source_file_name_original: optionalText(row, "source_file_name"),
    source_row_number: optionalText(row, "source_row_number"),
    post_text_complete: booleanFromWorkbook(row.post_text_complete ?? "", true),
    content_sha256: optionalText(row, "source_content_sha256").toLowerCase(),
    source_title_original: "",
    post_original_text: row.post_original_text ?? "",
    source_language: "",
    privacy_scope: "private_source",
    source_status: optionalText(row, "source_status"),
    source_notes: row.source_notes_private ?? "",
  }));

  const events = workbook.events.map((row) => {
    const eventKey = requiredText(row, "event_key");
    const postKey = requiredText(row, "post_key");
    const eventYearFrom = optionalText(row, "event_year_from");
    const eventYearTo = optionalText(row, "event_year_to");
    const fallbackSequence = boundedOneBasedSequence(eventSequence, postKey);
    return privateServiceRow(row, {
      event_key: eventKey,
      event_group_key: optionalText(row, "event_group_key"),
      post_key: postKey,
      event_sequence: suppliedOrDerivedSequence(row.event_no_in_post ?? "", fallbackSequence),
      event_type_code: optionalText(row, "event_type"),
      event_type_original: row.event_type_original ?? "",
      event_date_original: row.event_date_text ?? "",
      event_year: eventYearFrom && (!eventYearTo || eventYearFrom === eventYearTo) ? eventYearFrom : "",
      event_year_from: eventYearFrom,
      event_year_to: eventYearTo,
      event_month: optionalText(row, "event_month"),
      event_day: optionalText(row, "event_day"),
      date_precision: canonicalDatePrecision(row.date_precision ?? ""),
      calendar_style: optionalText(row, "calendar_style"),
      event_place_original: row.event_place_original ?? "",
      event_place_normalized: row.event_place_normalized ?? "",
      church_or_parish_original: row.church_or_parish_original ?? "",
      record_number_original: row.record_number ?? "",
      archive_repository_original: "",
      archive_reference_original: "",
      page_or_folio_original: "",
      document_title_original: "",
      document_language: optionalText(row, "document_language"),
      record_types: optionalText(row, "record_types") ? [row.record_types] : [],
      document_url_private: "",
      event_original_text: row.event_original_text ?? "",
      event_summary: row.event_summary ?? "",
      event_status: optionalText(row, "event_status"),
      event_notes: row.event_notes ?? "",
      event_confidence: optionalText(row, "event_confidence"),
      review_status: "private_staging",
      uncertainty_notes: "",
    });
  });

  const participants = workbook.participants.map((row) => {
    const eventKey = requiredText(row, "event_key");
    const roleCode = optionalText(row, "event_role_code");
    const living = booleanFromWorkbook(row.possible_living_person ?? "", false);
    return privateServiceRow(row, {
      participant_key: requiredText(row, "participant_key"),
      person_card_key: requiredText(row, "person_card_key"),
      event_key: eventKey,
      post_key: requiredText(row, "post_key"),
      participant_sequence: suppliedOrDerivedSequence(
        row.participant_sort_order ?? "",
        boundedOneBasedSequence(participantSequence, eventKey),
      ),
      full_name_original: row.original_full_name ?? "",
      surname_original: row.surname ?? "",
      given_name_original: row.given_name ?? "",
      patronymic_original: row.patronymic ?? "",
      name_normalized: row.normalized_uk_full_name ?? "",
      maiden_name_original: row.maiden_name ?? "",
      structural_role_code: optionalText(row, "structural_role"),
      event_role_code: roleCode,
      role_code: roleCode,
      role_original: lower(roleCode) === "other" ? (row.event_role_custom ?? "") : (row.event_role_custom || roleCode),
      event_role_custom: row.event_role_custom ?? "",
      sex: optionalText(row, "sex"),
      origin_original: row.origin_text ?? "",
      residence_original: row.residence_text ?? "",
      social_estate_text: row.social_estate_text ?? "",
      occupation_or_rank_text: row.occupation_or_rank_text ?? "",
      marital_status_text: row.marital_status_text ?? "",
      age_original: row.age_text ?? "",
      age_years: canonicalAgeYears(row.age_years ?? ""),
      relation_original: row.relation_original ?? "",
      participant_original_text: row.participant_original_text ?? "",
      evidence_excerpt: row.person_evidence_excerpt ?? "",
      field_confidence: optionalText(row, "field_confidence"),
      privacy_review_required: living,
      possible_living_person: living,
      participant_status: optionalText(row, "participant_status"),
      duplicate_key: row.potential_duplicate_key ?? "",
      participant_notes: row.participant_notes ?? "",
      review_status: "private_staging",
      uncertainty_notes: "",
      private_search_text: row.private_search_text ?? "",
    });
  });

  const eventSources = workbook.eventSources.map((row) => {
    const eventKey = requiredText(row, "event_key");
    const event = eventsByKey.get(eventKey);
    if (!event) problem("WORKBOOK_EVENT_SOURCE_REFERENCE_INVALID");
    const pageRange = labelledText([["від", row.page_from ?? ""], ["до", row.page_to ?? ""]]);
    return privateServiceRow(row, {
      event_source_key: requiredText(row, "event_source_key"),
      event_key: eventKey,
      post_key: requiredText(event, "post_key"),
      event_source_sequence: boundedOneBasedSequence(sourceSequence, eventKey),
      document_type: canonicalSourceType(row.source_type ?? ""),
      document_title_original: row.source_title ?? "",
      archive_repository_original: row.archive_name ?? "",
      archive_reference_original: labelledText([
        ["Фонд", row.fond ?? ""],
        ["Опис", row.inventory ?? ""],
        ["Справа", row.file_number ?? ""],
      ]),
      page_or_folio_original: pageRange,
      record_number_original: "",
      document_url_private: optionalText(row, "source_url_public_candidate"),
      source_original_text: row.citation ?? "",
      permission_status: optionalText(row, "permission_status"),
      confidence: "",
      is_primary: booleanFromWorkbook(row.is_primary ?? "", false),
      source_platform: optionalText(row, "source_platform"),
      external_id: row.external_id ?? "",
      access_date: canonicalDate(row.access_date ?? ""),
      review_status: "private_staging",
      uncertainty_notes: row.source_notes ?? "",
      private_search_text: "",
    });
  });

  const cards = workbook.cards.map((row) => {
    const eventKey = requiredText(row, "event_key");
    const primary = participantsByKey.get(requiredText(row, "primary_participant_key"));
    const possibleLiving = lower(row.privacy_review_state ?? "") === "possible_living"
      || booleanFromWorkbook(primary?.possible_living_person ?? "", false);
    return privateServiceRow(row, {
      card_key: requiredText(row, "card_key"),
      post_key: requiredText(row, "post_key"),
      event_key: eventKey,
      card_sequence: boundedOneBasedSequence(cardSequence, eventKey),
      card_kind: optionalText(row, "kind"),
      primary_participant_key: requiredText(row, "primary_participant_key"),
      card_title_original: row.title ?? "",
      card_summary: row.summary ?? "",
      card_original_text: row.card_original_text ?? "",
      card_normalized_text: row.normalized_text ?? "",
      classification_reason: row.classification_reason ?? "",
      possible_living_person: possibleLiving,
      verification_status: optionalText(row, "verification_status"),
      privacy_status: optionalText(row, "privacy_review_state"),
      publication_status: optionalText(row, "publication_status"),
      card_status: optionalText(row, "card_status"),
      copy_event_participants: booleanFromWorkbook(row.copy_event_participants ?? "", true),
      duplicate_key: canonicalDuplicateReviewStatus(row.duplicate_review_status ?? ""),
      card_notes: row.card_notes ?? "",
      review_status: "private_staging",
      uncertainty_notes: "",
    });
  });

  const qc = workbook.qc.map((row) => privateServiceRow(row, {
    post_key: optionalText(row, "post_key"),
    event_key: optionalText(row, "event_key"),
    participant_key: optionalText(row, "participant_key"),
    severity: lower(row.severity ?? "") === "blocker" ? "error" : optionalText(row, "severity"),
    qc_code: optionalText(row, "qc_code"),
    field_name: row.field_name ?? "",
    source_excerpt: row.original_excerpt ?? "",
    note: row.note ?? "",
    review_status: optionalText(row, "review_status"),
  }));

  return { sourcePosts, events, participants, eventSources, cards, qc };
}

export function buildZagulyakyTabularEventChunks(
  normalized: ZagulyakyTabularNormalizedWorkbook,
): ZagulyakyTabularWorkbookChunk[] {
  const eventsByPost = indexServiceRows(normalized.events, "post_key");
  const participantsByPost = indexServiceRows(normalized.participants, "post_key");
  const cardsByPost = indexServiceRows(normalized.cards, "post_key");
  const eventsByKey = new Map(normalized.events.map((row) => [serviceText(row, "event_key"), row]));
  const participantsByKey = new Map(normalized.participants.map((row) => [serviceText(row, "participant_key"), row]));
  const sourcesByPost = new Map<string, ZagulyakyTabularServiceRow[]>();
  for (const row of normalized.eventSources) {
    const event = eventsByKey.get(serviceText(row, "event_key"));
    if (!event) problem("WORKBOOK_EVENT_SOURCE_REFERENCE_INVALID");
    const postKey = serviceText(event, "post_key");
    const bucket = sourcesByPost.get(postKey) ?? [];
    bucket.push(row);
    sourcesByPost.set(postKey, bucket);
  }
  const qcByPost = new Map<string, ZagulyakyTabularServiceRow[]>();
  for (const row of normalized.qc) {
    const postKey = resolveQcPostKey(row, eventsByKey, participantsByKey);
    const bucket = qcByPost.get(postKey) ?? [];
    bucket.push(row);
    qcByPost.set(postKey, bucket);
  }

  const chunks: ZagulyakyTabularWorkbookChunk[] = [];
  let current: ZagulyakyTabularWorkbookChunk = {
    sourcePosts: [], events: [], participants: [], eventSources: [], cards: [], qc: [],
  };
  let currentCount = 0;
  const flush = () => {
    if (currentCount > 0) chunks.push(current);
    current = { sourcePosts: [], events: [], participants: [], eventSources: [], cards: [], qc: [] };
    currentCount = 0;
  };
  const append = (bucket: keyof ZagulyakyTabularWorkbookChunk, row: ZagulyakyTabularServiceRow) => {
    // Splitting a dense post remains valid: records are emitted in dependency
    // order, so every later chunk references a row written by an earlier one.
    if (currentCount === ZAGULYAKY_TABULAR_CHUNK_ROW_LIMIT) flush();
    current[bucket].push(row);
    currentCount += 1;
  };

  for (const sourcePost of normalized.sourcePosts) {
    const postKey = serviceText(sourcePost, "post_key");
    append("sourcePosts", sourcePost);
    for (const row of eventsByPost.get(postKey) ?? []) append("events", row);
    for (const row of participantsByPost.get(postKey) ?? []) append("participants", row);
    for (const row of sourcesByPost.get(postKey) ?? []) append("eventSources", row);
    for (const row of cardsByPost.get(postKey) ?? []) append("cards", row);
    for (const row of qcByPost.get(postKey) ?? []) append("qc", row);
  }
  flush();
  return chunks;
}

export function summarizeZagulyakyTabularEventWorkbook(
  workbook: ZagulyakyTabularParsedWorkbook,
): ZagulyakyTabularWorkbookSummary {
  const count = (rows: ZagulyakyTabularWorkbookRow[], key: string, value: string) => rows.filter((row) => lower(row[key] ?? "") === value).length;
  return {
    importContractVersion: 1,
    sourcePostCount: workbook.sourcePosts.length,
    eventCount: workbook.events.length,
    participantCount: workbook.participants.length,
    eventSourceCount: workbook.eventSources.length,
    cardCount: workbook.cards.length,
    qcCount: workbook.qc.length,
    noCardEventCount: workbook.noCardEventCount,
    readyCardCount: count(workbook.cards, "card_status", "ready"),
    needsReviewCardCount: count(workbook.cards, "card_status", "needs_review"),
    possibleLivingCardCount: count(workbook.cards, "privacy_review_state", "possible_living"),
    privateSourceUrlCount: workbook.sourcePosts.filter((row) => Boolean(optionalText(row, "facebook_post_url_private"))).length,
    unreviewedEventSourceCount: count(workbook.eventSources, "permission_status", "not_reviewed"),
  };
}

function hexadecimal(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256ZagulyakyTabularBytes(bytes: Uint8Array): Promise<string> {
  return hexadecimal(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Stable JSON form shared with the relay checksum algorithm.  It has no
 * hidden omissions: undefined, non-finite numbers, non-plain objects and
 * circular structures are rejected instead of silently changing a checksum.
 */
export function canonicalZagulyakyTabularJson(value: unknown): string {
  const stack = new Set<object>();
  const visit = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") return JSON.stringify(candidate);
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) problem("WORKBOOK_CANONICAL_JSON_INVALID");
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      if (stack.has(candidate)) problem("WORKBOOK_CANONICAL_JSON_INVALID");
      stack.add(candidate);
      const result = `[${candidate.map(visit).join(",")}]`;
      stack.delete(candidate);
      return result;
    }
    if (!candidate || typeof candidate !== "object") problem("WORKBOOK_CANONICAL_JSON_INVALID");
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) problem("WORKBOOK_CANONICAL_JSON_INVALID");
    if (stack.has(candidate)) problem("WORKBOOK_CANONICAL_JSON_INVALID");
    stack.add(candidate);
    const object = candidate as Record<string, unknown>;
    const result = `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${visit(object[key])}`).join(",")}}`;
    stack.delete(candidate);
    return result;
  };
  return visit(value);
}

export async function sha256ZagulyakyTabularCanonicalJson(value: unknown): Promise<string> {
  return sha256ZagulyakyTabularBytes(new TextEncoder().encode(canonicalZagulyakyTabularJson(value)));
}

export async function planZagulyakyTabularEventWorkbook(
  input: Blob | ArrayBuffer | Uint8Array,
  signal?: AbortSignal,
): Promise<ZagulyakyTabularWorkbookPlan> {
  ensureNotAborted(signal);
  let bytes: Uint8Array;
  if (isBlob(input)) {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (input instanceof Uint8Array) {
    bytes = new Uint8Array(input);
  } else {
    problem("INVALID_XLSX_FILE");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKBOOK_BYTES) problem("REQUEST_TOO_LARGE");
  const [sourceChecksum, parsed] = await Promise.all([
    sha256ZagulyakyTabularBytes(bytes),
    parseZagulyakyTabularEventWorkbook(bytes, signal),
  ]);
  ensureNotAborted(signal);
  const normalized = normalizeZagulyakyTabularEventWorkbook(parsed);
  const chunks = buildZagulyakyTabularEventChunks(normalized);
  return { sourceChecksum, parsed, normalized, chunks, summary: summarizeZagulyakyTabularEventWorkbook(parsed) };
}
