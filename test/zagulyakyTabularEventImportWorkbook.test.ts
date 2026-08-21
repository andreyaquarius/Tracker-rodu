import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import {
  ZAGULYAKY_TABULAR_CHUNK_ROW_LIMIT,
  ZAGULYAKY_TABULAR_SHEET_CONTRACTS,
  ZagulyakyTabularWorkbookProblem,
  buildZagulyakyTabularEventChunks,
  canonicalAgeYears,
  canonicalZagulyakyTabularJson,
  planZagulyakyTabularEventWorkbook,
  sha256ZagulyakyTabularCanonicalJson,
  type ZagulyakyTabularNormalizedWorkbook,
  type ZagulyakyTabularWorkbookRow,
} from "../src/services/zagulyakyTabularEventImportWorkbook.ts";

const BATCH = "ZAGULYAKY-TEST-01";

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function columnLetter(column: number): string {
  let value = column + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function xmlCell(column: number, row: number, value: string): string {
  return `<c r="${columnLetter(column)}${row}" t="str"><v>${escapeXml(value)}</v></c>`;
}

function newRow(headers: readonly string[], values: Record<string, string>): ZagulyakyTabularWorkbookRow {
  return Object.fromEntries(headers.map((header) => [header, values[header] ?? ""]));
}

function xmlSheet(headers: readonly string[], dataRows: ZagulyakyTabularWorkbookRow[], formula = false): string {
  const title = `<row r="1">${xmlCell(0, 1, "private test workbook")}</row>`;
  const header = `<row r="6">${headers.map((value, index) => xmlCell(index, 6, value)).join("")}</row>`;
  const rows = dataRows.map((row, index) => {
    const rowNumber = index + 7;
    return `<row r="${rowNumber}">${headers.map((key, column) => xmlCell(column, rowNumber, row[key] ?? "")).join("")}</row>`;
  });
  // Even an empty required layer needs a seventh physical row for the same
  // row-six contract that real exported workbooks use.
  const blankRow = dataRows.length === 0 ? `<row r="7"><c r="A7" /></row>` : "";
  const optionalFormula = formula ? `<row r="2"><c r="A2"><f>1+1</f><v>2</v></c></row>` : "";
  return `<?xml version="1.0" encoding="utf-8"?><worksheet><sheetData>${title}${optionalFormula}${header}${rows}${blankRow}</sheetData></worksheet>`;
}

type WorkbookRows = Record<string, ZagulyakyTabularWorkbookRow[]>;

function validRows(): WorkbookRows {
  const bySheet = Object.fromEntries(
    ZAGULYAKY_TABULAR_SHEET_CONTRACTS.map((contract) => [contract.name, [] as ZagulyakyTabularWorkbookRow[]]),
  ) as WorkbookRows;
  const contracts = new Map(ZAGULYAKY_TABULAR_SHEET_CONTRACTS.map((contract) => [contract.name, contract]));
  const row = (sheetName: string, values: Record<string, string>) => newRow(contracts.get(sheetName)!.headers, values);

  bySheet["01_SourcePosts"].push(row("01_SourcePosts", {
    import_batch_id: BATCH,
    post_key: "POST-1",
    source_platform: "facebook",
    facebook_post_url_private: "https://private.invalid/post-1",
    source_status: "ready",
    post_original_text: "Private source text remains in the private envelope.",
    post_text_complete: "yes",
  }));
  bySheet["02_Events"].push(row("02_Events", {
    import_batch_id: BATCH,
    event_key: "EVENT-1",
    post_key: "POST-1",
    event_no_in_post: "1",
    event_type: "birth",
    event_year_from: "1901",
    event_year_to: "1901",
    date_precision: "year",
    event_confidence: "low",
    event_status: "ready",
  }));
  bySheet["03_Participants"].push(row("03_Participants", {
    import_batch_id: BATCH,
    participant_key: "PERSON-1",
    person_card_key: "CARD-1",
    event_key: "EVENT-1",
    post_key: "POST-1",
    participant_sort_order: "1",
    structural_role: "subject",
    event_role_code: "subject",
    original_full_name: "Test Person",
    age_years: "141",
    field_confidence: "low",
    possible_living_person: "no",
    participant_status: "ready",
  }));
  bySheet["04_EventSources"].push(row("04_EventSources", {
    import_batch_id: BATCH,
    event_source_key: "SOURCE-1",
    event_key: "EVENT-1",
    is_primary: "yes",
    source_type: "archive_record",
    permission_status: "not_reviewed",
  }));
  bySheet["05_Cards"].push(row("05_Cards", {
    import_batch_id: BATCH,
    card_key: "CARD-1",
    event_key: "EVENT-1",
    post_key: "POST-1",
    kind: "person",
    primary_participant_key: "PERSON-1",
    title: "Test Person",
    verification_status: "unverified",
    privacy_review_state: "not_reviewed",
    publication_status: "draft",
    card_status: "ready",
    copy_event_participants: "yes",
    duplicate_review_status: "not_reviewed",
  }));
  bySheet["06_QC"].push(row("06_QC", {
    import_batch_id: BATCH,
    post_key: "POST-1",
    event_key: "EVENT-1",
    participant_key: "PERSON-1",
    severity: "info",
    qc_code: "CHECK_001",
    review_status: "open",
  }));
  return bySheet;
}

async function createWorkbook(rows = validRows(), options: { formula?: boolean } = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const sheets = ZAGULYAKY_TABULAR_SHEET_CONTRACTS.map((contract, index) => ({
    ...contract,
    relationshipId: `rId${index + 1}`,
    path: `xl/worksheets/sheet${index + 1}.xml`,
  }));
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns:r="urn:r"><sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${sheet.relationshipId}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships>${sheets.map((sheet) => `<Relationship Id="${sheet.relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/${sheet.path}"/>`).join("")}</Relationships>`);
  for (const sheet of sheets) {
    zip.file(sheet.path, xmlSheet(sheet.headers, rows[sheet.name] ?? [], Boolean(options.formula && sheet.name === "01_SourcePosts")));
  }
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

function chunkRowCount(chunk: ReturnType<typeof buildZagulyakyTabularEventChunks>[number]): number {
  return Object.values(chunk).reduce((count, rows) => count + rows.length, 0);
}

test("browser planner reads row-six XLSX layers and retains raw envelopes while canonicalizing unsafe ages", async () => {
  const plan = await planZagulyakyTabularEventWorkbook(await createWorkbook());

  assert.deepEqual(plan.summary, {
    importContractVersion: 1,
    sourcePostCount: 1,
    eventCount: 1,
    participantCount: 1,
    eventSourceCount: 1,
    cardCount: 1,
    qcCount: 1,
    noCardEventCount: 0,
    readyCardCount: 1,
    needsReviewCardCount: 0,
    possibleLivingCardCount: 0,
    privateSourceUrlCount: 1,
    unreviewedEventSourceCount: 1,
  });
  assert.equal(plan.parsed.participants[0]?.age_years, "141");
  assert.equal(plan.normalized.participants[0]?.age_years, "");
  assert.equal(
    (plan.normalized.participants[0]?.workbook_row_private as Record<string, string>).age_years,
    "141",
  );
  assert.equal(plan.chunks.length, 1);
  assert.equal(chunkRowCount(plan.chunks[0]!), 6);
  assert.ok(plan.sourceChecksum.match(/^[0-9a-f]{64}$/u));
  assert.equal(canonicalAgeYears("140"), "140");
  assert.equal(canonicalAgeYears("141"), "");
  assert.equal(canonicalAgeYears("-1"), "");
});

test("browser planner applies graph safety checks before any relay request", async () => {
  const rows = validRows();
  rows["02_Events"][0]!.post_key = "MISSING-POST";
  const workbook = await createWorkbook(rows);
  await assert.rejects(
    () => planZagulyakyTabularEventWorkbook(workbook),
    (error: unknown) => error instanceof ZagulyakyTabularWorkbookProblem && error.code === "WORKBOOK_EVENT_POST_REFERENCE_INVALID",
  );
});

test("browser planner rejects formulas and keeps every relay chunk within the database limit", async () => {
  const workbook = await createWorkbook(validRows(), { formula: true });
  await assert.rejects(
    () => planZagulyakyTabularEventWorkbook(workbook),
    (error: unknown) => error instanceof ZagulyakyTabularWorkbookProblem && error.code === "WORKBOOK_FORMULAS_NOT_ALLOWED",
  );

  const normalized: ZagulyakyTabularNormalizedWorkbook = {
    sourcePosts: Array.from({ length: ZAGULYAKY_TABULAR_CHUNK_ROW_LIMIT + 1 }, (_, index) => ({ post_key: `POST-${index + 1}` })),
    events: [],
    participants: [],
    eventSources: [],
    cards: [],
    qc: [],
  };
  const chunks = buildZagulyakyTabularEventChunks(normalized);
  assert.deepEqual(chunks.map(chunkRowCount), [ZAGULYAKY_TABULAR_CHUNK_ROW_LIMIT, 1]);
});

test("canonical relay JSON is key-order independent and has a stable SHA-256", async () => {
  const first = { z: [true, null], a: { y: "test", x: 2 } };
  const second = { a: { x: 2, y: "test" }, z: [true, null] };
  assert.equal(canonicalZagulyakyTabularJson(first), "{\"a\":{\"x\":2,\"y\":\"test\"},\"z\":[true,null]}");
  assert.equal(
    await sha256ZagulyakyTabularCanonicalJson(first),
    await sha256ZagulyakyTabularCanonicalJson(second),
  );
});
