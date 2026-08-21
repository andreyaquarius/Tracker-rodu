import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "D:\\Завантаження\\Zagulyaky_event_import_filled.xlsx";
const outputPath = "D:\\Development\\Project\\Родовий Навігатор\\tmp\\xlsx-validation-20260820\\audit.json";
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

const CRITICAL_SHEETS = [
  "01_SourcePosts",
  "02_Events",
  "03_Participants",
  "04_EventSources",
  "05_Cards",
  "06_QC",
];

const toText = (value) => (value === null || value === undefined ? "" : String(value).trim());
const present = (value) => toText(value).length > 0;
const hasFacebookUrl = (value) => /(?:facebook\.com|fb\.me|fb\.com|fb\.watch)/i.test(toText(value));
const hasShortenerUrl = (value) => /(?:surl\.li|bit\.ly|tinyurl\.com|t\.co|cutt\.ly|goo\.gl|ow\.ly|is\.gd)/i.test(toText(value));
const rowsWithHeaders = (sheetName) => {
  const sheet = workbook.worksheets.getItem(sheetName);
  const values = sheet.getUsedRange(true)?.values ?? [];
  const headerIndex = values.findIndex((row) => row.some((value) => toText(value) === "import_batch_id"));
  if (headerIndex < 0) throw new Error(`Header row not found in ${sheetName}`);
  const headers = values[headerIndex].map(toText);
  const headerMap = new Map(headers.map((header, index) => [header, index]));
  const records = values
    .slice(headerIndex + 1)
    .map((row, offset) => ({
      rowNumber: headerIndex + offset + 2,
      values: Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])),
    }))
    .filter((record) => Object.values(record.values).some(present));
  return { sheet, values, headerIndex, headers, headerMap, records };
};

const duplicateInfo = (records, field) => {
  const locations = new Map();
  const blanks = [];
  for (const record of records) {
    const key = toText(record.values[field]);
    if (!key) {
      blanks.push(record.rowNumber);
      continue;
    }
    const rows = locations.get(key) ?? [];
    rows.push(record.rowNumber);
    locations.set(key, rows);
  }
  const duplicateGroups = [...locations.values()].filter((rows) => rows.length > 1);
  return {
    blankCount: blanks.length,
    duplicateGroupCount: duplicateGroups.length,
    duplicateRowCount: duplicateGroups.reduce((sum, rows) => sum + rows.length, 0),
    firstDuplicateRows: duplicateGroups.slice(0, 10),
  };
};

const compositeDuplicateInfo = (records, fields) => {
  const locations = new Map();
  const blanks = [];
  for (const record of records) {
    const parts = fields.map((field) => toText(record.values[field]));
    if (parts.some((part) => !part)) {
      blanks.push(record.rowNumber);
      continue;
    }
    const key = JSON.stringify(parts);
    const rows = locations.get(key) ?? [];
    rows.push(record.rowNumber);
    locations.set(key, rows);
  }
  const duplicateGroups = [...locations.values()].filter((rows) => rows.length > 1);
  return {
    blankCount: blanks.length,
    duplicateGroupCount: duplicateGroups.length,
    duplicateRowCount: duplicateGroups.reduce((sum, rows) => sum + rows.length, 0),
    firstDuplicateRows: duplicateGroups.slice(0, 10),
  };
};

const refInfo = (records, field, knownKeys) => {
  const missing = [];
  for (const record of records) {
    const key = toText(record.values[field]);
    if (key && !knownKeys.has(key)) missing.push(record.rowNumber);
  }
  return { missingReferenceCount: missing.length, firstRows: missing.slice(0, 10) };
};

const uniqueTextValues = (records, field, max = 80) => {
  const values = [...new Set(records.map((record) => toText(record.values[field])).filter(Boolean))];
  return { count: values.length, values: values.slice(0, max), truncated: values.length > max };
};

const valueCounts = (records, field, max = 80) => {
  const counts = new Map();
  for (const record of records) {
    const value = toText(record.values[field]) || "(blank)";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  return { entries: entries.slice(0, max), truncated: entries.length > max };
};

const countWhere = (records, predicate) => records.reduce((count, record) => count + (predicate(record) ? 1 : 0), 0);
const countBlank = (records, field) => countWhere(records, (record) => !present(record.values[field]));
const maxTextLength = (records, field) => records.reduce((max, record) => Math.max(max, toText(record.values[field]).length), 0);
const rowNumbersWhere = (records, predicate, max = 10) => records.filter(predicate).slice(0, max).map((record) => record.rowNumber);

const sheets = {};
for (const sheetName of CRITICAL_SHEETS) sheets[sheetName] = rowsWithHeaders(sheetName);
const sourcePosts = sheets["01_SourcePosts"].records;
const events = sheets["02_Events"].records;
const participants = sheets["03_Participants"].records;
const eventSources = sheets["04_EventSources"].records;
const cards = sheets["05_Cards"].records;
const qc = sheets["06_QC"].records;

const sourcePostKeys = new Set(sourcePosts.map((record) => toText(record.values.post_key)).filter(Boolean));
const eventKeys = new Set(events.map((record) => toText(record.values.event_key)).filter(Boolean));
const participantKeys = new Set(participants.map((record) => toText(record.values.participant_key)).filter(Boolean));
const cardKeys = new Set(cards.map((record) => toText(record.values.card_key)).filter(Boolean));
const eventByKey = new Map(events.map((record) => [toText(record.values.event_key), record]));
const participantByKey = new Map(participants.map((record) => [toText(record.values.participant_key), record]));

const crossPostMismatches = (records, eventField = "event_key", postField = "post_key") => {
  const mismatches = [];
  for (const record of records) {
    const event = eventByKey.get(toText(record.values[eventField]));
    const post = toText(record.values[postField]);
    if (event && post && post !== toText(event.values.post_key)) mismatches.push(record.rowNumber);
  }
  return { count: mismatches.length, firstRows: mismatches.slice(0, 10) };
};

const eventParticipantCounts = new Map();
for (const participant of participants) {
  const key = toText(participant.values.event_key);
  if (key) eventParticipantCounts.set(key, (eventParticipantCounts.get(key) ?? 0) + 1);
}
const eventCardCounts = new Map();
for (const card of cards) {
  const key = toText(card.values.event_key);
  if (key) eventCardCounts.set(key, (eventCardCounts.get(key) ?? 0) + 1);
}

const eventSourceCounts = new Map();
for (const eventSource of eventSources) {
  const key = toText(eventSource.values.event_key);
  if (key) eventSourceCounts.set(key, (eventSourceCounts.get(key) ?? 0) + 1);
}
const postEventCounts = new Map();
for (const event of events) {
  const key = toText(event.values.post_key);
  if (key) postEventCounts.set(key, (postEventCounts.get(key) ?? 0) + 1);
}

const repeatedPersonCardKeys = (() => {
  const map = new Map();
  for (const participant of participants) {
    const key = toText(participant.values.person_card_key);
    if (!key) continue;
    const rows = map.get(key) ?? [];
    rows.push(participant.rowNumber);
    map.set(key, rows);
  }
  const groups = [...map.values()].filter((rows) => rows.length > 1);
  return { groups: groups.length, rows: groups.reduce((sum, group) => sum + group.length, 0), firstRows: groups.slice(0, 10) };
})();
const cardParticipantKeyMismatchRows = rowNumbersWhere(cards, (record) => {
  const participant = participantByKey.get(toText(record.values.primary_participant_key));
  return /^person$/i.test(toText(record.values.kind)) && participant && toText(participant.values.person_card_key) !== toText(record.values.card_key);
});

const sourceHashDuplicates = duplicateInfo(sourcePosts, "source_content_sha256");
const sourceFacebookUrlDuplicates = duplicateInfo(sourcePosts, "facebook_post_url_private");

const documentSourceFacebookLeaks = rowNumbersWhere(eventSources, (record) => hasFacebookUrl(record.values.source_url_public_candidate));
const documentSourceShortenerCandidates = rowNumbersWhere(eventSources, (record) => hasShortenerUrl(record.values.source_url_public_candidate), 25);
const cardFacebookLeaks = rowNumbersWhere(cards, (record) => ["title", "summary", "normalized_text"].some((field) => hasFacebookUrl(record.values[field])));
const knownPublicLike = /^(?:public|published|publish|ready_to_publish|approved_public)$/i;
const publicLikeCards = rowNumbersWhere(cards, (record) => knownPublicLike.test(toText(record.values.publication_status)), 25);
const possibleLivingKeys = new Set(
  participants
    .filter((record) => /^(?:true|yes|так|1)$/i.test(toText(record.values.possible_living_person)))
    .map((record) => toText(record.values.participant_key)),
);
const possibleLivingPublicCards = rowNumbersWhere(
  cards,
  (record) => possibleLivingKeys.has(toText(record.values.primary_participant_key)) && knownPublicLike.test(toText(record.values.publication_status)),
  25,
);

const enumFields = [
  [sourcePosts, "source_platform"], [sourcePosts, "source_status"],
  [events, "event_type"], [events, "date_precision"], [events, "calendar_style"], [events, "event_status"],
  [participants, "structural_role"], [participants, "event_role_code"], [participants, "sex"], [participants, "possible_living_person"], [participants, "participant_status"],
  [eventSources, "is_primary"], [eventSources, "source_type"], [eventSources, "source_platform"], [eventSources, "permission_status"],
  [cards, "kind"], [cards, "verification_status"], [cards, "privacy_review_state"], [cards, "publication_status"], [cards, "card_status"], [cards, "copy_event_participants"], [cards, "duplicate_review_status"],
  [qc, "severity"], [qc, "qc_code"], [qc, "review_status"],
];
const enumValues = Object.fromEntries(enumFields.map(([records, field]) => [field, uniqueTextValues(records, field)]));

const dictionarySheet = workbook.worksheets.getItem("07_Довідники");
const dictionaryValues = dictionarySheet.getUsedRange(true)?.values ?? [];
const dictionaryStrings = [...new Set(dictionaryValues.flat().map(toText).filter(Boolean))]
  .filter((value) => value.length <= 120)
  .slice(0, 300);
const dictionaryCodeSet = new Set(dictionaryStrings.map((value) => value.toLowerCase()));
const dictionaryValidatedFields = [
  [events, "event_type"],
  [participants, "event_role_code"],
  [participants, "structural_role"],
  [sourcePosts, "source_status"],
  [events, "event_status"],
  [participants, "participant_status"],
  [cards, "card_status"],
  [cards, "privacy_review_state"],
  [qc, "qc_code"],
];
const enumViolationsAgainstDictionary = Object.fromEntries(dictionaryValidatedFields.map(([records, field]) => {
  const invalid = [...new Set(records.map((record) => toText(record.values[field])).filter(Boolean).filter((value) => !dictionaryCodeSet.has(value.toLowerCase())))];
  return [field, { count: invalid.length, values: invalid }];
}));

const allRecords = [...sourcePosts, ...events, ...participants, ...eventSources, ...cards, ...qc];
const formulaErrors = [];
for (const [sheetName, source] of Object.entries(sheets)) {
  const values = source.values;
  for (let rowIndex = 0; rowIndex < values.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < values[rowIndex].length; columnIndex += 1) {
      const value = toText(values[rowIndex][columnIndex]);
      if (/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/.test(value)) {
        formulaErrors.push({ sheetName, rowNumber: rowIndex + 1, columnIndex: columnIndex + 1 });
      }
    }
  }
}

const tables = [];
for (const worksheet of workbook.worksheets.items) {
  for (const table of worksheet.tables.items ?? []) {
    let headers = [];
    try { headers = (table.getHeaderRowRange().values?.[0] ?? []).map(toText); } catch {}
    tables.push({ worksheet: worksheet.name, name: table.name, headerCount: headers.length });
  }
}

const result = {
  workbook: {
    sheetNames: workbook.worksheets.items.map((sheet) => sheet.name),
    tables,
    totalPopulatedRecords: allRecords.length,
    formulaErrorCount: formulaErrors.length,
    formulaErrorLocations: formulaErrors.slice(0, 20),
  },
  recordCounts: Object.fromEntries(Object.entries(sheets).map(([name, source]) => [name, source.records.length])),
  batchIntegrity: {
    distinctBatchIdCountBySheet: Object.fromEntries(Object.entries(sheets).map(([name, source]) => [name, uniqueTextValues(source.records, "import_batch_id").count])),
    sourcePosts_missing_batch_id: countBlank(sourcePosts, "import_batch_id"),
    events_missing_batch_id: countBlank(events, "import_batch_id"),
    participants_missing_batch_id: countBlank(participants, "import_batch_id"),
    eventSources_missing_batch_id: countBlank(eventSources, "import_batch_id"),
    cards_missing_batch_id: countBlank(cards, "import_batch_id"),
    qc_missing_batch_id: countBlank(qc, "import_batch_id"),
    allSheetsShareOneSameBatchId: (() => {
      const sets = Object.values(sheets).map((source) => new Set(source.records.map((record) => toText(record.values.import_batch_id)).filter(Boolean)));
      const baseline = [...sets[0] ?? []].sort();
      return sets.every((set) => JSON.stringify([...set].sort()) === JSON.stringify(baseline));
    })(),
  },
  headers: Object.fromEntries(Object.entries(sheets).map(([name, source]) => [name, source.headers])),
  identifiers: {
    sourcePosts_post_key: duplicateInfo(sourcePosts, "post_key"),
    events_event_key: duplicateInfo(events, "event_key"),
    participants_participant_key: duplicateInfo(participants, "participant_key"),
    cards_card_key: duplicateInfo(cards, "card_key"),
    eventSources_event_source_key: duplicateInfo(eventSources, "event_source_key"),
    events_post_key_event_no_in_post: compositeDuplicateInfo(events, ["post_key", "event_no_in_post"]),
    participants_event_key_participant_sort_order: compositeDuplicateInfo(participants, ["event_key", "participant_sort_order"]),
    source_content_sha256: sourceHashDuplicates,
    facebook_post_url_private: sourceFacebookUrlDuplicates,
  },
  referenceIntegrity: {
    events_post_key: refInfo(events, "post_key", sourcePostKeys),
    participants_event_key: refInfo(participants, "event_key", eventKeys),
    participants_post_key: refInfo(participants, "post_key", sourcePostKeys),
    cards_event_key: refInfo(cards, "event_key", eventKeys),
    cards_post_key: refInfo(cards, "post_key", sourcePostKeys),
    cards_primary_participant_key: refInfo(cards, "primary_participant_key", participantKeys),
    eventSources_event_key: refInfo(eventSources, "event_key", eventKeys),
    qc_post_key: refInfo(qc, "post_key", sourcePostKeys),
    qc_event_key: refInfo(qc, "event_key", eventKeys),
    qc_participant_key: refInfo(qc, "participant_key", participantKeys),
    participant_event_post_match: crossPostMismatches(participants),
    card_event_post_match: crossPostMismatches(cards),
    events_without_participant_count: countWhere(events, (record) => !(eventParticipantCounts.get(toText(record.values.event_key)) ?? 0)),
    events_without_card_count: countWhere(events, (record) => !(eventCardCounts.get(toText(record.values.event_key)) ?? 0)),
    events_without_event_source_count: countWhere(events, (record) => !(eventSourceCounts.get(toText(record.values.event_key)) ?? 0)),
    sourcePosts_without_event_count: countWhere(sourcePosts, (record) => !(postEventCounts.get(toText(record.values.post_key)) ?? 0)),
    sourcePosts_with_event_but_missing_original_text: countWhere(sourcePosts, (record) => (postEventCounts.get(toText(record.values.post_key)) ?? 0) > 0 && !present(record.values.post_original_text)),
    participants_without_card_count: countWhere(participants, (record) => !cardKeys.has(toText(record.values.person_card_key))),
    person_card_key_and_card_key_mismatch_count: cardParticipantKeyMismatchRows.length,
    person_card_key_and_card_key_mismatch_first_rows: cardParticipantKeyMismatchRows,
    person_card_key_reused_across_participant_rows: repeatedPersonCardKeys,
  },
  requiredDataQuality: {
    sourcePosts_missing_private_facebook_url: countBlank(sourcePosts, "facebook_post_url_private"),
    sourcePosts_missing_original_text: countBlank(sourcePosts, "post_original_text"),
    sourcePosts_incomplete_text_flag_values: uniqueTextValues(sourcePosts, "post_text_complete"),
    sourcePosts_post_text_complete_counts: valueCounts(sourcePosts, "post_text_complete"),
    sourcePosts_status_counts: valueCounts(sourcePosts, "source_status"),
    sourcePosts_invalid_sha256_format_count: countWhere(sourcePosts, (record) => {
      const value = toText(record.values.source_content_sha256);
      return value && !/^[a-f0-9]{64}$/i.test(value);
    }),
    events_missing_type: countBlank(events, "event_type"),
    events_missing_original_text: countBlank(events, "event_original_text"),
    events_missing_place: countBlank(events, "event_place_original"),
    events_status_counts: valueCounts(events, "event_status"),
    events_without_participants_status_counts: valueCounts(events.filter((record) => !(eventParticipantCounts.get(toText(record.values.event_key)) ?? 0)), "event_status"),
    events_year_outside_1400_2100: countWhere(events, (record) => {
      const value = Number(toText(record.values.event_year_from));
      return Number.isFinite(value) && value > 0 && (value < 1400 || value > 2100);
    }),
    events_month_outside_1_12: countWhere(events, (record) => {
      const value = Number(toText(record.values.event_month));
      return Number.isFinite(value) && value > 0 && (value < 1 || value > 12);
    }),
    events_day_outside_1_31: countWhere(events, (record) => {
      const value = Number(toText(record.values.event_day));
      return Number.isFinite(value) && value > 0 && (value < 1 || value > 31);
    }),
    participants_missing_name: countWhere(participants, (record) => !present(record.values.original_full_name) && !present(record.values.surname)),
    participants_missing_role: countBlank(participants, "event_role_code"),
    participants_missing_original_text: countBlank(participants, "participant_original_text"),
    cards_missing_title: countBlank(cards, "title"),
    cards_missing_original_text: countBlank(cards, "card_original_text"),
    person_cards_missing_primary_participant: countWhere(cards, (record) => /^person$/i.test(toText(record.values.kind)) && !present(record.values.primary_participant_key)),
    document_cards_with_primary_participant: countWhere(cards, (record) => /^document$/i.test(toText(record.values.kind)) && present(record.values.primary_participant_key)),
    longTextCells: {
      source_post_max_characters: maxTextLength(sourcePosts, "post_original_text"),
      event_original_max_characters: maxTextLength(events, "event_original_text"),
      participant_original_max_characters: maxTextLength(participants, "participant_original_text"),
      card_original_max_characters: maxTextLength(cards, "card_original_text"),
      cells_over_excel_32767_character_limit: countWhere(allRecords, (record) => Object.values(record.values).some((value) => toText(value).length > 32767)),
    },
  },
  privacyAndPublicationSafety: {
    eventSources_with_facebook_in_public_candidate_url: { count: documentSourceFacebookLeaks.length, firstRows: documentSourceFacebookLeaks },
    eventSources_with_shortener_in_public_candidate_url: { count: documentSourceShortenerCandidates.length, firstRows: documentSourceShortenerCandidates },
    eventSources_missing_public_candidate_url: countBlank(eventSources, "source_url_public_candidate"),
    eventSources_permission_status_counts: valueCounts(eventSources, "permission_status"),
    cards_with_facebook_url_in_public_text_fields: { count: cardFacebookLeaks.length, firstRows: cardFacebookLeaks },
    public_or_published_cards: { count: publicLikeCards.length, firstRows: publicLikeCards },
    possible_living_participant_count: possibleLivingKeys.size,
    possible_living_card_count: countWhere(cards, (record) => /^possible_living$/i.test(toText(record.values.privacy_review_state))),
    possible_living_person_cards_marked_public: { count: possibleLivingPublicCards.length, firstRows: possibleLivingPublicCards },
  },
  categoricalValues: enumValues,
  enumViolationsAgainstProvidedDictionary: enumViolationsAgainstDictionary,
  duplicateReviewSignals: {
    participant_potential_duplicate_key_nonblank: countWhere(participants, (record) => present(record.values.potential_duplicate_key)),
    cards_duplicate_review_status_counts: valueCounts(cards, "duplicate_review_status"),
  },
  categoricalCounts: {
    event_type: valueCounts(events, "event_type"),
    event_role_code: valueCounts(participants, "event_role_code"),
    source_status: valueCounts(sourcePosts, "source_status"),
    event_status: valueCounts(events, "event_status"),
    participant_status: valueCounts(participants, "participant_status"),
    card_status: valueCounts(cards, "card_status"),
    qc_code: valueCounts(qc, "qc_code"),
  },
  dictionaryValues: dictionaryStrings,
};

await fs.writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
console.log(JSON.stringify(result, null, 2));
