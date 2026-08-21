import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const ROOT = "D:/Development/Project/Родовий Навігатор";
const OUTPUT_DIR = path.join(ROOT, "outputs", "zagulyaky-event-import-template-20260820");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "Zagulyaky_event_import_template.xlsx");

const palette = {
  forest: "#123B3A",
  teal: "#146C62",
  mint: "#EAF5F1",
  cream: "#FFF9EE",
  gold: "#E9B75A",
  goldPale: "#FFF4D8",
  redPale: "#FCE8E6",
  ink: "#17312D",
  muted: "#5D706B",
  border: "#D7E2DE",
  white: "#FFFFFF",
};

const workbook = Workbook.create();
// Create this first so the workbook opens on the guide rather than a wide data sheet.
const readme = workbook.worksheets.add("00_README");

function colLetter(index) {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function applyBaseSheetStyle(sheet, lastColumn, title, subtitle) {
  const last = colLetter(lastColumn - 1);
  sheet.showGridLines = false;
  sheet.mergeCells(`A1:${last}1`);
  sheet.getRange("A1").values = [[title]];
  sheet.getRange(`A1:${last}1`).format = {
    fill: palette.forest,
    font: { bold: true, color: palette.white, size: 16 },
    horizontalAlignment: "left",
    verticalAlignment: "center",
  };
  sheet.getRange(`A1:${last}1`).format.rowHeight = 32;

  sheet.mergeCells(`A2:${last}2`);
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange(`A2:${last}2`).format = {
    fill: palette.mint,
    font: { color: palette.ink, italic: true },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    wrapText: true,
  };
  sheet.getRange(`A2:${last}2`).format.rowHeight = 34;
}

function styleTableHeader(sheet, range) {
  range.format = {
    fill: palette.teal,
    font: { bold: true, color: palette.white },
    horizontalAlignment: "left",
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: palette.border },
  };
  range.format.rowHeight = 38;
}

function makeDataSheet({ name, title, subtitle, headers, widths, tableName, validations = [] }) {
  const sheet = workbook.worksheets.add(name);
  applyBaseSheetStyle(sheet, headers.length, title, subtitle);
  const last = colLetter(headers.length - 1);
  sheet.getRange(`A4:${last}4`).merge();
  sheet.getRange("A4").values = [["Заповнюйте один рядок на сутність. Сірий фільтр у заголовках допомагає перевіряти партії та пов’язані ключі."]];
  sheet.getRange(`A4:${last}4`).format = {
    fill: palette.cream,
    font: { color: palette.muted, italic: true },
    wrapText: true,
    verticalAlignment: "center",
    borders: { preset: "outside", style: "thin", color: palette.border },
  };
  sheet.getRange(`A4:${last}4`).format.rowHeight = 28;
  sheet.getRange(`A6:${last}6`).values = [headers];
  styleTableHeader(sheet, sheet.getRange(`A6:${last}6`));
  sheet.getRange(`A7:${last}7`).values = [headers.map(() => "")];
  // Keep one intentionally blank data row. Excel tables expand when the user pastes
  // TSV/rows into it, without making the workbook look like a thousand-row empty grid.
  sheet.getRange(`A7:${last}7`).format = {
    verticalAlignment: "top",
    wrapText: true,
    borders: { preset: "all", style: "thin", color: palette.border },
  };
  sheet.tables.add(`A6:${last}7`, true, tableName);
  sheet.freezePanes.freezeRows(6);
  for (let i = 0; i < headers.length; i += 1) {
    sheet.getRange(`${colLetter(i)}1:${colLetter(i)}7`).format.columnWidth = widths[i] ?? 18;
  }
  for (const validation of validations) {
    sheet.getRange(`${validation.column}7:${validation.column}7`).dataValidation = {
      rule: { type: "list", values: validation.values },
    };
  }
  return sheet;
}

function addSection(sheet, row, title, text, lastColumn) {
  const last = colLetter(lastColumn - 1);
  sheet.mergeCells(`A${row}:${last}${row}`);
  sheet.getRange(`A${row}`).values = [[title]];
  sheet.getRange(`A${row}:${last}${row}`).format = {
    fill: palette.goldPale,
    font: { bold: true, color: palette.ink },
    verticalAlignment: "center",
  };
  sheet.getRange(`A${row}:${last}${row}`).format.rowHeight = 24;
  sheet.mergeCells(`A${row + 1}:${last}${row + 1}`);
  sheet.getRange(`A${row + 1}`).values = [[text]];
  sheet.getRange(`A${row + 1}:${last}${row + 1}`).format = {
    fill: palette.white,
    font: { color: palette.ink },
    verticalAlignment: "top",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: palette.border },
  };
  sheet.getRange(`A${row + 1}:${last}${row + 1}`).format.rowHeight = 48;
}

const sourcePostsHeaders = [
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
];

const eventHeaders = [
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
];

const participantHeaders = [
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
];

const eventSourcesHeaders = [
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
];

const cardsHeaders = [
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
];

const qcHeaders = [
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
];

const sourceSheet = makeDataSheet({
  name: "01_SourcePosts",
  title: "01 · Первинні Facebook-дописи (приватно)",
  subtitle: "Рівно один рядок на повний вихідний допис. Не скорочуйте текст і не переносіть Facebook URL до публічних джерел.",
  headers: sourcePostsHeaders,
  widths: [18, 28, 20, 48, 40, 26, 20, 22, 22, 84, 20, 66, 28, 16, 20, 42],
  tableName: "SourcePostsTable",
  validations: [
    { column: "C", values: ["facebook_group_json"] },
    { column: "I", values: ["exact", "parsed_from_text", "relative_unresolved", "unknown"] },
    { column: "K", values: ["yes", "no", "unknown"] },
    { column: "O", values: ["ready", "no_zagulyaka", "needs_ocr", "needs_refetch", "needs_review", "quarantined"] },
  ],
});

makeDataSheet({
  name: "02_Events",
  title: "02 · Події в межах допису",
  subtitle: "Один рядок = один метричний або історичний запис. Один допис може містити багато подій; один шлюб не розбивайте на два рядки лише через двох наречених.",
  headers: eventHeaders,
  widths: [18, 30, 28, 16, 28, 20, 28, 24, 16, 16, 14, 14, 18, 16, 52, 40, 44, 18, 18, 28, 84, 52, 18, 20, 42],
  tableName: "EventsTable",
  validations: [
    { column: "F", values: ["birth", "baptism", "birth_and_baptism", "marriage", "death", "burial", "divorce", "military_service", "residence_record", "court_record", "property_record", "other", "unspecified"] },
    { column: "M", values: ["day", "month", "year", "range", "approximate", "before", "after", "unknown"] },
    { column: "N", values: ["old_style", "new_style", "unknown"] },
    { column: "W", values: ["high", "medium", "low"] },
    { column: "X", values: ["ready", "needs_review", "quarantined", "skip"] },
  ],
});

makeDataSheet({
  name: "03_Participants",
  title: "03 · Учасники подій і майбутні картки осіб",
  subtitle: "Один рядок = одна особа в одній події. Кожна явно названа особа має окремий person_card_key; одна людина у кількох подіях не зливається автоматично.",
  headers: participantHeaders,
  widths: [18, 34, 32, 30, 28, 16, 20, 20, 28, 40, 40, 24, 24, 26, 24, 14, 18, 14, 50, 50, 28, 32, 30, 34, 84, 58, 18, 22, 20, 32, 42, 64],
  tableName: "ParticipantsTable",
  validations: [
    { column: "G", values: ["subject", "spouse", "parent", "child", "witness", "godparent", "official", "relative", "mentioned", "other"] },
    { column: "H", values: ["subject", "newborn", "baptized", "groom", "bride", "groom_father", "groom_mother", "bride_father", "bride_mother", "deceased", "resident", "household_head", "household_member", "military_person", "migrant", "godparent", "godchild", "father", "mother", "parent", "child", "spouse", "witness", "pledger", "officiant", "registrar", "midwife", "informant", "owner", "commander", "official", "other"] },
    { column: "P", values: ["male", "female", "unknown"] },
    { column: "AA", values: ["high", "medium", "low"] },
    { column: "AB", values: ["yes", "no", "unknown"] },
    { column: "AC", values: ["ready", "needs_review", "skip", "quarantined"] },
  ],
});

makeDataSheet({
  name: "04_EventSources",
  title: "04 · Архівні та документні джерела подій",
  subtitle: "Facebook URL залишається лише у 01_SourcePosts. Тут вносіть лише окремі архівні, бібліотечні, FamilySearch або інші історичні джерела для майбутньої перевірки.",
  headers: eventSourcesHeaders,
  widths: [18, 30, 30, 14, 18, 52, 30, 16, 16, 18, 14, 14, 60, 52, 20, 26, 18, 22, 46],
  tableName: "EventSourcesTable",
  validations: [
    { column: "D", values: ["yes", "no"] },
    { column: "E", values: ["archive", "library", "website", "book", "database", "other"] },
    { column: "R", values: ["unknown", "link_only", "permission_granted", "public_domain", "restricted"] },
  ],
});

makeDataSheet({
  name: "05_Cards",
  title: "05 · Картки, які створить майбутній імпортер",
  subtitle: "Один рядок = одна майбутня приватна draft-картка. Для шлюбу буде щонайменше дві персональні картки, але вони обидві посилатимуться на одну подію.",
  headers: cardsHeaders,
  widths: [18, 32, 30, 28, 16, 34, 46, 84, 64, 52, 52, 20, 22, 20, 20, 22, 26, 48],
  tableName: "CardsTable",
  validations: [
    { column: "E", values: ["person", "document"] },
    { column: "L", values: ["unverified", "plausible", "corroborated", "verified", "disputed"] },
    { column: "M", values: ["not_reviewed", "possible_living", "cleared_for_review", "blocked"] },
    { column: "N", values: ["draft"] },
    { column: "O", values: ["ready", "needs_review", "quarantined", "skip"] },
    { column: "P", values: ["yes", "no"] },
    { column: "Q", values: ["not_checked", "possible_duplicate", "not_duplicate"] },
  ],
});

makeDataSheet({
  name: "06_QC",
  title: "06 · Контроль якості та неоднозначності",
  subtitle: "Сюди записуються місця, де модель не повинна вгадувати. Рядок QC не забороняє імпорт, але не дозволяє бездумно публікувати чи зливати дані.",
  headers: qcHeaders,
  widths: [18, 28, 30, 34, 14, 32, 30, 68, 64, 22],
  tableName: "QcTable",
  validations: [
    { column: "E", values: ["info", "warning", "blocker"] },
    { column: "F", values: ["NO_EXTRACTABLE_EVENT", "NO_NAMED_PERSON", "AMBIGUOUS_EVENT_BOUNDARY", "AMBIGUOUS_NAME", "PARTIAL_NAME", "AMBIGUOUS_ROLE", "AMBIGUOUS_DATE", "AMBIGUOUS_PLACE", "AMBIGUOUS_DOCUMENT_LINK", "POSSIBLE_DUPLICATE", "UNREADABLE_TEXT", "MISSING_SOURCE_URL"] },
    { column: "J", values: ["open", "reviewed", "resolved", "ignored"] },
  ],
});

// README
applyBaseSheetStyle(readme, 8, "Шаблон імпорту Загуляк · події, люди та джерела", "Версія 1 · приватна підготовка до майбутнього bulk-імпорту. Це не публікація і не замінює модерацію.");
readme.getRange("A4:H4").merge();
readme.getRange("A4").values = [["Модель даних: один Facebook-допис → 0..N подій → 0..N учасників → окремі картки людей або документів."]];
readme.getRange("A4:H4").format = {
  fill: palette.goldPale,
  font: { bold: true, color: palette.ink },
  wrapText: true,
  verticalAlignment: "center",
  borders: { preset: "outside", style: "thin", color: palette.gold },
};
readme.getRange("A4:H4").format.rowHeight = 34;

readme.getRange("A6:B6").values = [["Аркуш", "Призначення"]];
styleTableHeader(readme, readme.getRange("A6:B6"));
readme.getRange("A7:B16").values = [
  ["01_SourcePosts", "Повні первинні Facebook-дописи. Один рядок на допис; URL і повний текст залишаються приватними."],
  ["02_Events", "Окремі метричні чи історичні події. Один допис може містити багато подій."],
  ["03_Participants", "Одна особа в одній події. Тут зберігаються ПІБ, роль, походження, проживання, стан та фрагмент джерела."],
  ["04_EventSources", "Архівні, бібліотечні й документні джерела події; не Facebook URL."],
  ["05_Cards", "Список майбутніх приватних draft-карток, які імпортер має створити."],
  ["06_QC", "Неоднозначності й питання, які не можна вирішувати припущенням."],
  ["07_Довідники", "Дозволені коди для подій, ролей, станів та перевірки."],
  ["08_Приклад", "Приклад одного допису з народженням і шлюбом, що створює кілька подій та карток."],
  ["09_GeminiPrompt", "Готові інструкції для Gemini; використовуйте з пакетами по 10–25 повних дописів."],
  ["Важливо", "Поточна база не має готового Excel/CSV bulk-importer. Шаблон готує правильні дані; окремий захищений імпортер буде потрібен перед завантаженням."],
];
readme.getRange("A7:B16").format = {
  verticalAlignment: "top",
  wrapText: true,
  borders: { preset: "all", style: "thin", color: palette.border },
};
readme.getRange("A7:A16").format.font = { bold: true, color: palette.teal };
readme.getRange("A1:A30").format.columnWidth = 26;
readme.getRange("B1:B30").format.columnWidth = 105;
readme.getRange("C1:H30").format.columnWidth = 16;
readme.getRange("A7:B16").format.rowHeight = 40;

addSection(readme, 18, "Як заповнювати", "1) Внесіть кожен повний допис у 01_SourcePosts. 2) Витягніть окремі події в 02_Events. 3) Для кожної явно названої особи створіть рядок у 03_Participants. 4) Створіть окрему рядок-картку для кожної людини в 05_Cards. 5) Усі сумніви додайте до 06_QC.", 8);
addSection(readme, 21, "Ключі та зв’язки", "post_key унікальний. event_key посилається на post_key. participant_key і card_key посилаються на event_key. Не міняйте ключі після того, як Gemini створив пов’язаний пакет. Формат: POST-001, POST-001-E01, POST-001-E01-P01, POST-001-E01-C01.", 8);
addSection(readme, 24, "Приватність і публікація", "facebook_post_url_private та повний post_original_text ніколи не повинні автоматично ставати публічними URL/джерелом. Усі картки масового імпорту мають publication_status = draft, verification_status = unverified, privacy_review_state = not_reviewed або possible_living.", 8);
addSection(readme, 27, "Excel та Gemini", "Зберігайте файл саме як XLSX: CSV не здатен безпечно містити довгий багаторядковий текст і зв’язки між аркушами. Gemini краще давати 10–25 повних дописів за раз; відповідь просіть у TSV-блоках, а не в Markdown-таблиці.", 8);
readme.freezePanes.freezeRows(4);

// Reference codes
const refs = workbook.worksheets.add("07_Довідники");
applyBaseSheetStyle(refs, 8, "07 · Довідники кодів", "Використовуйте коди з цих списків. За потреби залишайте поле порожнім і додавайте QC-запис, а не вигадуйте новий код.");
const refColumns = [
  { title: "event_type", values: ["birth", "baptism", "birth_and_baptism", "marriage", "death", "burial", "divorce", "military_service", "residence_record", "court_record", "property_record", "other", "unspecified"] },
  { title: "event_role_code", values: ["subject", "newborn", "baptized", "groom", "bride", "groom_father", "groom_mother", "bride_father", "bride_mother", "deceased", "resident", "household_head", "household_member", "military_person", "migrant", "godparent", "godchild", "father", "mother", "parent", "child", "spouse", "witness", "pledger", "officiant", "registrar", "midwife", "informant", "owner", "commander", "official", "other"] },
  { title: "structural_role", values: ["subject", "spouse", "parent", "child", "witness", "godparent", "official", "relative", "mentioned", "other"] },
  { title: "source_status", values: ["ready", "no_zagulyaka", "needs_ocr", "needs_refetch", "needs_review", "quarantined"] },
  { title: "event_status/card_status", values: ["ready", "needs_review", "quarantined", "skip"] },
  { title: "privacy_review_state", values: ["not_reviewed", "possible_living", "cleared_for_review", "blocked"] },
  { title: "QC codes", values: ["NO_EXTRACTABLE_EVENT", "NO_NAMED_PERSON", "AMBIGUOUS_EVENT_BOUNDARY", "AMBIGUOUS_NAME", "PARTIAL_NAME", "AMBIGUOUS_ROLE", "AMBIGUOUS_DATE", "AMBIGUOUS_PLACE", "AMBIGUOUS_DOCUMENT_LINK", "POSSIBLE_DUPLICATE", "UNREADABLE_TEXT", "MISSING_SOURCE_URL"] },
  { title: "Пояснення", values: ["witness — один код для свідка незалежно від статі", "event_place_original ≠ origin_text ≠ residence_text", "social_estate_text — козак, селянин, міщанин тощо", "source_post URL — тільки приватне походження даних"] },
];
for (let i = 0; i < refColumns.length; i += 1) {
  const letter = colLetter(i);
  refs.getRange(`${letter}6`).values = [[refColumns[i].title]];
  styleTableHeader(refs, refs.getRange(`${letter}6`));
  refs.getRange(`${letter}7:${letter}${6 + refColumns[i].values.length}`).values = refColumns[i].values.map((value) => [value]);
  refs.getRange(`${letter}7:${letter}${6 + refColumns[i].values.length}`).format = {
    wrapText: true,
    verticalAlignment: "top",
    borders: { preset: "all", style: "thin", color: palette.border },
  };
  refs.getRange(`${letter}1:${letter}60`).format.columnWidth = i === 7 ? 54 : 28;
}
refs.freezePanes.freezeRows(6);

// Worked example
const example = workbook.worksheets.add("08_Приклад");
applyBaseSheetStyle(example, 10, "08 · Приклад: один допис, дві події, п’ять персональних карток", "Приклад умовний: у реальному заповненні залишайте історичний текст як у джерелі та не вигадуйте невідомих значень.");
example.getRange("A4:J4").merge();
example.getRange("A4").values = [["POST-EXAMPLE-001 містить окремий запис про народження та окремий запис про шлюб. Це не одна картка «Трипілля 1902»."]];
example.getRange("A4:J4").format = { fill: palette.goldPale, font: { bold: true, color: palette.ink }, wrapText: true, borders: { preset: "outside", style: "thin", color: palette.gold } };
example.getRange("A4:J4").format.rowHeight = 30;

example.getRange("A6:J6").values = [["1. Source post", "post_key", "facebook_post_url_private", "post_original_text", "source_status", "", "", "", "", ""]];
styleTableHeader(example, example.getRange("A6:J6"));
example.getRange("A7:J7").values = [["", "POST-EXAMPLE-001", "https://www.facebook.com/groups/example/posts/example", "Записи за народження/одруження/смерть. Трипілля. 1902 ...", "ready", "", "", "", "", ""]];
example.getRange("A7:J7").format = { wrapText: true, verticalAlignment: "top", borders: { preset: "all", style: "thin", color: palette.border } };
example.getRange("A7:J7").format.rowHeight = 54;

example.getRange("A10:J10").values = [["2. Events", "event_key", "event_type", "event_date_text", "event_place_original", "record_number", "archive_reference", "page", "event_original_text", "status"]];
styleTableHeader(example, example.getRange("A10:J10"));
example.getRange("A11:J12").values = [
  ["", "POST-EXAMPLE-001-E01", "birth", "1902 р. квітень", "м. Трипілля, Трипільська вол., Київський пов., Київська губ.", "22", "ЦДІАК: 127-1078-2236", "14", "Народження дочки Єлизавети у селянки ... Олексія Павловича ... та законної його дружини Марини Іванівни.", "ready"],
  ["", "POST-EXAMPLE-001-E02", "marriage", "1902 р. лютий", "м. Трипілля, Трипільська вол., Київський пов., Київська губ.", "6", "ЦДІАК: 127-1078-2236", "44", "Одруження селянина Київського повіту ... Григорія Андрійовича Заброди з селянкою ... Катериною Григорівною Римарчуковою.", "ready"],
];
example.getRange("A11:J12").format = { wrapText: true, verticalAlignment: "top", borders: { preset: "all", style: "thin", color: palette.border } };
example.getRange("A11:J12").format.rowHeight = 72;

example.getRange("A15:J15").values = [["3. Participants", "participant_key", "person_card_key", "event_key", "original_full_name", "event_role_code", "origin_text", "social_estate_text", "participant_original_text", "status"]];
styleTableHeader(example, example.getRange("A15:J15"));
example.getRange("A16:J20").values = [
  ["", "POST-EXAMPLE-001-E01-P01", "POST-EXAMPLE-001-E01-C01", "POST-EXAMPLE-001-E01", "Єлизавета", "newborn", "", "", "Народження дочки Єлизавети ...", "ready"],
  ["", "POST-EXAMPLE-001-E01-P02", "POST-EXAMPLE-001-E01-C02", "POST-EXAMPLE-001-E01", "Олексій Павлович", "father", "", "", "... Олексія Павловича ...", "ready"],
  ["", "POST-EXAMPLE-001-E01-P03", "POST-EXAMPLE-001-E01-C03", "POST-EXAMPLE-001-E01", "Марина Іванівна", "mother", "", "селянка", "... законної його дружини Марини Іванівни.", "ready"],
  ["", "POST-EXAMPLE-001-E02-P01", "POST-EXAMPLE-001-E02-C01", "POST-EXAMPLE-001-E02", "Григорій Андрійович Заброда", "groom", "Київський повіт, Трипільська волость, містечко Трипілля", "селянин", "Одруження селянина ... Григорія Андрійовича Заброди ...", "ready"],
  ["", "POST-EXAMPLE-001-E02-P02", "POST-EXAMPLE-001-E02-C02", "POST-EXAMPLE-001-E02", "Катерина Григорівна Римарчукова", "bride", "Київська губернія, Радомисльський повіт, містечко Трипілля", "селянка", "... з селянкою-жителькою ... Катериною Григорівною Римарчуковою.", "ready"],
];
example.getRange("A16:J20").format = { wrapText: true, verticalAlignment: "top", borders: { preset: "all", style: "thin", color: palette.border } };
example.getRange("A16:J20").format.rowHeight = 60;

example.getRange("A23:J23").merge();
example.getRange("A23").values = [["Результат: 2 події, 5 окремих карток людей. У майбутній БД кожна картка лишається draft; повний Facebook URL і вихідний допис не стають публічними автоматично."]];
example.getRange("A23:J23").format = { fill: palette.mint, font: { bold: true, color: palette.ink }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: palette.border } };
example.getRange("A23:J23").format.rowHeight = 38;
for (let i = 0; i < 10; i += 1) example.getRange(`${colLetter(i)}1:${colLetter(i)}30`).format.columnWidth = [20, 34, 48, 30, 44, 24, 48, 26, 74, 18][i];
example.freezePanes.freezeRows(6);

// Gemini Prompt
const promptSheet = workbook.worksheets.add("09_GeminiPrompt");
applyBaseSheetStyle(promptSheet, 1, "09 · Готовий промпт для Gemini", "Скопіюйте текст нижче в Gemini, а потім додайте 10–25 повних дописів у форматі [POST]…[/POST]. Попросіть відповідь у TSV, не Markdown.");
promptSheet.getRange("A4").values = [["Промпт"]];
styleTableHeader(promptSheet, promptSheet.getRange("A4"));
const promptParagraphs = [
  "Ти працюєш як суворий екстрактор історико-генеалогічних даних для приватної бази «Загуляки». Перетворюй надані Facebook-дописи на взаємопов’язані рядки для аркушів SourcePosts, Events, Participants, EventSources, Cards і QC.",
  "ГОЛОВНА МОДЕЛЬ: один Facebook-допис може містити 0..N окремих подій; кожна подія може містити 0..N людей; кожна явно названа людина отримує окрему майбутню картку. Не роби одну картку на весь допис. Не створюй дві події для одного шлюбу лише через нареченого і наречену.",
  "ПРАЦЮЙ ЛИШЕ З НАДАНИМ ТЕКСТОМ. Не відкривай Facebook, FamilySearch, архівні URL або будь-які інші посилання. Не використовуй пошук, зовнішні довідники, припущення чи сучасні виправлення. Якщо факт не написаний прямо, залиш поле порожнім і додай QC.",
  "ЗБЕРІГАЙ ОРИГІНАЛ. У SourcePosts пост_original_text містить повний допис. У Events event_original_text містить точний суцільний фрагмент саме цієї події. У Participants participant_original_text містить точний фрагмент, що стосується особи; якщо його неможливо виділити, повтори event_original_text. Не переказуй, не перекладай, не виправляй дореформену орфографію.",
  "СТАБІЛЬНІ ID: post_key залишай без змін. event_key = {post_key}-E01, {post_key}-E02. participant_key = {event_key}-P01. person_card_key = {event_key}-C01. Зберігай порядок появи в тексті. Не об’єднуй людей зі схожими ПІБ між різними подіями або дописами; постав POSSIBLE_DUPLICATE у QC.",
  "РОЛІ: event_role_code дозволено: newborn, baptized, groom, bride, groom_father, groom_mother, bride_father, bride_mother, deceased, father, mother, parent, child, spouse, witness, godparent, pledger, officiant, registrar, midwife, informant, owner, commander, official, resident, household_head, household_member, military_person, migrant, other. Для свідка будь-якої статі завжди використовуй witness; коду «свідкиня» не існує.",
  "ГЕОГРАФІЯ: event_place_original — місце події або місце запису; church_or_parish_original — церква/парафія. origin_text — лише походження, приписка або місце, прямо сказане про людину. residence_text — лише проживання людини. Не переносити церкву, парафію чи архів до origin_text/residence_text автоматично. Якщо межа невизначена — QC AMBIGUOUS_PLACE.",
  "СТАН І ПРОФЕСІЯ: social_estate_text зберігає козак, селянка, міщанин, дворянин тощо в точному написанні. occupation_or_rank_text — посада/професія/чин. marital_status_text — першим шлюбом, вдова, вдівець тощо. Не змішуй ці поля та не осучаснюй історичні слова.",
  "ДАТИ Й ДОКУМЕНТИ: event_date_text — точний текст дати. Рік/місяць/день заповнюй лише коли вони прямо прочитуються. Не перераховуй старий/новий стиль. Номер запису, шифр архіву, сторінку та URL документа прив’язуй лише до тієї події, яку вони явно описують. Facebook URL не можна ставити в EventSources чи публічне джерело.",
  "КАРТКИ: на кожен рядок Participants з названою людиною зроби рядок Cards kind=person, primary_participant_key = відповідний participant_key, publication_status=draft, verification_status=unverified, privacy_review_state=not_reviewed або possible_living, copy_event_participants=yes. Не створюй жодної published картки. Документну картку зроби лише якщо є цінний документ без надійно названої людини.",
  "QC: якщо немає події — SourcePosts все одно зберігається, а в QC додається NO_EXTRACTABLE_EVENT. Інші коди: NO_NAMED_PERSON, AMBIGUOUS_EVENT_BOUNDARY, AMBIGUOUS_NAME, PARTIAL_NAME, AMBIGUOUS_ROLE, AMBIGUOUS_DATE, AMBIGUOUS_PLACE, AMBIGUOUS_DOCUMENT_LINK, POSSIBLE_DUPLICATE, UNREADABLE_TEXT, MISSING_SOURCE_URL.",
  "ФОРМАТ ВХОДУ: [POST] пост_key: ... facebook_post_url_private: ... post_original_text: ... [/POST]. ФОРМАТ ВІДПОВІДІ: поверни лише шість TSV-блоків у порядку SourcePosts, Events, Participants, EventSources, Cards, QC. Використовуй справжні табуляції. Не додавай Markdown, пояснення або текст до/після TSV. Нові рядки всередині текстової клітинки передавай як два символи \\n.",
];
for (let i = 0; i < promptParagraphs.length; i += 1) {
  const row = 5 + i;
  promptSheet.getRange(`A${row}`).values = [[promptParagraphs[i]]];
  promptSheet.getRange(`A${row}`).format = {
    wrapText: true,
    verticalAlignment: "top",
    borders: { preset: "all", style: "thin", color: palette.border },
    fill: i % 2 === 0 ? palette.white : "#F7FBF9",
  };
  promptSheet.getRange(`A${row}`).format.rowHeight = 72;
}
promptSheet.getRange("A1:A40").format.columnWidth = 135;
promptSheet.freezePanes.freezeRows(4);

// Add a table title note to the source sheet to make its privacy boundary more apparent.
sourceSheet.getRange("A5:P5").merge();
sourceSheet.getRange("A5").values = [["Увага: facebook_post_url_private і post_original_text — приватні поля provenance. Вони не є кандидатами для публічного source_url."]];
sourceSheet.getRange("A5:P5").format = { fill: palette.redPale, font: { bold: true, color: "#9C3025" }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: "#E6AAA4" } };
sourceSheet.getRange("A5:P5").format.rowHeight = 28;

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const inspection = await workbook.inspect({
  kind: "workbook,sheet,table",
  maxChars: 9000,
  tableMaxRows: 3,
  tableMaxCols: 8,
  tableMaxCellChars: 60,
});
console.log("WORKBOOK_INSPECTION");
console.log(inspection.ndjson);

for (const sheetName of ["00_README", "01_SourcePosts", "02_Events", "03_Participants", "04_EventSources", "05_Cards", "06_QC", "07_Довідники", "08_Приклад", "09_GeminiPrompt"]) {
  const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 1, format: "png" });
  const previewBytes = new Uint8Array(await preview.arrayBuffer());
  await fs.writeFile(path.join(OUTPUT_DIR, `${sheetName}.png`), previewBytes);
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(OUTPUT_FILE);
console.log(`OUTPUT_FILE=${OUTPUT_FILE}`);
