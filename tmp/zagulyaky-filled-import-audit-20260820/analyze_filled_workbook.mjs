import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const workbookPath = "D:/Завантаження/Zagulyaky_event_import_filled.xlsx";
const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const asText = (value) => (value === null || value === undefined ? "" : String(value).trim());
const nonEmpty = (row) => row.some((cell) => asText(cell) !== "");
const headerIndex = (rows, expectedHeader) => rows.findIndex((row) => row.map(asText).includes(expectedHeader));
const lower = (value) => asText(value).toLowerCase();

const sheets = {};
for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange();
  const values = used ? used.values : [];
  sheets[sheet.name] = values ?? [];
}

const reports = [];
for (const [sheetName, rows] of Object.entries(sheets)) {
  const knownHeaders = ["post_key", "event_key", "participant_key", "event_source_key", "card_key", "qc_code"];
  const headerRow = knownHeaders.map((header) => headerIndex(rows, header)).find((index) => index >= 0) ?? -1;
  const headers = headerRow >= 0 ? rows[headerRow].map(asText) : [];
  const data = headerRow >= 0 ? rows.slice(headerRow + 1).filter(nonEmpty) : [];
  reports.push({ sheetName, headerRow: headerRow >= 0 ? headerRow + 1 : null, headerCount: headers.length, dataRows: data.length, headers });
}

function getRows(sheetName) {
  const rows = sheets[sheetName] ?? [];
  const headerRow = ["post_key", "event_key", "participant_key", "event_source_key", "card_key", "qc_code"]
    .map((header) => headerIndex(rows, header))
    .find((index) => index >= 0) ?? -1;
  if (headerRow < 0) return { header: [], records: [] };
  const header = rows[headerRow].map(asText);
  const records = rows.slice(headerRow + 1).filter(nonEmpty).map((row) => Object.fromEntries(header.map((name, index) => [name, asText(row[index])])));
  return { header, records };
}

const source = getRows("01_SourcePosts");
const events = getRows("02_Events");
const participants = getRows("03_Participants");
const sources = getRows("04_EventSources");
const cards = getRows("05_Cards");
const qc = getRows("06_QC");

const duplicateCount = (items) => {
  const values = items.filter(Boolean);
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates.size;
};

const sourceKeys = new Set(source.records.map((row) => row.post_key).filter(Boolean));
const eventKeys = new Set(events.records.map((row) => row.event_key).filter(Boolean));
const participantKeys = new Set(participants.records.map((row) => row.participant_key).filter(Boolean));

const missingForeignKeys = (records, field, valid) => records.filter((row) => row[field] && !valid.has(row[field])).length;
const invalid = (records, field, allowed) => records.filter((row) => row[field] && !allowed.has(lower(row[field]))).length;
const tooLong = (records, field, maximum) => records.filter((row) => Array.from(row[field] ?? "").length > maximum).length;

const allowed = {
  eventType: new Set(["birth", "baptism", "birth_and_baptism", "marriage", "death", "burial", "divorce", "military_service", "residence_record", "court_record", "property_record", "other", "unspecified"]),
  role: new Set(["subject", "newborn", "baptized", "groom", "bride", "groom_father", "groom_mother", "bride_father", "bride_mother", "deceased", "resident", "household_head", "household_member", "military_person", "migrant", "godparent", "godchild", "father", "mother", "parent", "child", "spouse", "witness", "pledger", "officiant", "registrar", "midwife", "informant", "owner", "commander", "official", "other"]),
  structural: new Set(["subject", "spouse", "parent", "child", "witness", "godparent", "official", "relative", "mentioned", "other"]),
  yesNoUnknown: new Set(["yes", "no", "unknown"]),
  draft: new Set(["draft"]),
};

const distribution = (records, field) => {
  const counts = new Map();
  for (const row of records) {
    const key = row[field] || "<blank>";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
};

const postsWithEvents = new Set(events.records.map((row) => row.post_key).filter(Boolean));
const postsWithParticipants = new Set(participants.records.map((row) => row.post_key).filter(Boolean));
const postsWithCards = new Set(cards.records.map((row) => row.post_key).filter(Boolean));

const stats = {
  sourcePosts: source.records.length,
  events: events.records.length,
  participants: participants.records.length,
  eventSources: sources.records.length,
  cards: cards.records.length,
  qc: qc.records.length,
  duplicates: {
    postKey: duplicateCount(source.records.map((row) => row.post_key)),
    eventKey: duplicateCount(events.records.map((row) => row.event_key)),
    participantKey: duplicateCount(participants.records.map((row) => row.participant_key)),
    cardKey: duplicateCount(cards.records.map((row) => row.card_key)),
  },
  foreignKeyGaps: {
    eventPostKey: missingForeignKeys(events.records, "post_key", sourceKeys),
    participantEventKey: missingForeignKeys(participants.records, "event_key", eventKeys),
    participantPostKey: missingForeignKeys(participants.records, "post_key", sourceKeys),
    sourceEventKey: missingForeignKeys(sources.records, "event_key", eventKeys),
    cardEventKey: missingForeignKeys(cards.records, "event_key", eventKeys),
    cardParticipantKey: missingForeignKeys(cards.records.filter((row) => lower(row.kind) === "person"), "primary_participant_key", participantKeys),
  },
  enumIssues: {
    eventType: invalid(events.records, "event_type", allowed.eventType),
    structuralRole: invalid(participants.records, "structural_role", allowed.structural),
    eventRole: invalid(participants.records, "event_role_code", allowed.role),
    living: invalid(participants.records, "possible_living_person", allowed.yesNoUnknown),
    cardPublication: invalid(cards.records, "publication_status", allowed.draft),
  },
  missingRequired: {
    sourcePostKey: source.records.filter((row) => !row.post_key).length,
    sourceRawText: source.records.filter((row) => !row.post_original_text).length,
    eventKey: events.records.filter((row) => !row.event_key).length,
    eventText: events.records.filter((row) => !row.event_original_text).length,
    participantKey: participants.records.filter((row) => !row.participant_key).length,
    participantName: participants.records.filter((row) => !row.original_full_name).length,
    participantText: participants.records.filter((row) => !row.participant_original_text).length,
    cardKey: cards.records.filter((row) => !row.card_key).length,
    cardOriginalText: cards.records.filter((row) => !row.card_original_text).length,
  },
  lengthLimits: {
    excelPostOriginalTextOver32767: tooLong(source.records, "post_original_text", 32767),
    eventOriginalTextOver200000: tooLong(events.records, "event_original_text", 200000),
    participantOriginalTextOver200000: tooLong(participants.records, "participant_original_text", 200000),
    cardTitleOver300: tooLong(cards.records, "title", 300),
    cardSummaryOver4000: tooLong(cards.records, "summary", 4000),
  },
  privacySignals: {
    nonDraftCards: cards.records.filter((row) => lower(row.publication_status) && lower(row.publication_status) !== "draft").length,
    filledPublicSourceCandidate: sources.records.filter((row) => row.source_url_public_candidate).length,
    facebookUrlInEventSources: sources.records.filter((row) => /facebook\.com|fb\.com/i.test(row.source_url_public_candidate)).length,
    facebookUrlInCardText: cards.records.filter((row) => /facebook\.com|fb\.com/i.test(`${row.card_original_text} ${row.normalized_text} ${row.summary}`)).length,
  },
  coverage: {
    sourcePostsWithEvents: postsWithEvents.size,
    sourcePostsWithParticipants: postsWithParticipants.size,
    sourcePostsWithCards: postsWithCards.size,
    sourcePostsWithNoEvents: source.records.filter((row) => row.post_key && !postsWithEvents.has(row.post_key)).length,
    sourcePostsWithEventsButNoRawText: source.records.filter((row) => row.post_key && postsWithEvents.has(row.post_key) && !row.post_original_text).length,
    participantsWithoutCardRow: participants.records.filter((row) => row.person_card_key && !cards.records.some((card) => card.card_key === row.person_card_key)).length,
  },
  distributions: {
    sourceStatus: distribution(source.records, "source_status"),
    eventStatus: distribution(events.records, "event_status"),
    participantStatus: distribution(participants.records, "participant_status"),
    cardStatus: distribution(cards.records, "card_status"),
    eventType: distribution(events.records, "event_type"),
    qcCode: distribution(qc.records, "qc_code"),
    qcSeverity: distribution(qc.records, "severity"),
    permissionStatus: distribution(sources.records, "permission_status"),
  },
};

console.log(JSON.stringify({ reports, stats }, null, 2));
