import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/zagulyakyTabularEventImportService.ts", import.meta.url),
  "utf8",
);
const card = readFileSync(
  new URL("../src/components/admin/ZagulyakyTabularEventImportCard.tsx", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);
const adminPage = readFileSync(
  new URL("../src/pages/AdminPanelPage.tsx", import.meta.url),
  "utf8",
);
const adminCapabilities = readFileSync(
  new URL("../src/services/adminConsoleService.ts", import.meta.url),
  "utf8",
);
const adminService = readFileSync(
  new URL("../src/services/zagulyakyAdminService.ts", import.meta.url),
  "utf8",
);
const publicCatalogue = readFileSync(
  new URL("../src/pages/ZagulyakyPage.tsx", import.meta.url),
  "utf8",
);
const stagingReview = readFileSync(
  new URL("../src/components/admin/ZagulyakyStagingReviewPanel.tsx", import.meta.url),
  "utf8",
);

test("tabular XLSX browser service parses locally and sends only bounded authenticated JSON relay actions", () => {
  assert.match(service, /ZAGULYAKY_TABULAR_EVENT_IMPORT_MAX_FILE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(service, /export type ZagulyakyTabularEventImportMode = "dry_run" \| "commit"/);
  assert.match(service, /if \(!\/\\\.xlsx\$\/iu\.test\(fileName\)\)/);
  assert.match(service, /file\.arrayBuffer\(\)/);
  assert.match(service, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(service, /planZagulyakyTabularEventWorkbook/);
  assert.match(service, /type ZagulyakyTabularWorkbookChunk/);
  assert.match(service, /client\.auth\.getSession\(\)/);
  assert.match(service, /functions\.invoke<unknown>\("zagulyaky-tabular-event-import", \{/);
  assert.match(service, /body: action,/);
  assert.match(service, /"Content-Type": "application\/json"/);
  assert.match(service, /action: "begin"/);
  assert.match(service, /action: "chunk"/);
  assert.match(service, /action: "finalize"/);
  assert.match(service, /for \(const \[chunkIndex, chunk\] of plan\.chunks\.entries\(\)\)/);
  assert.match(service, /if \(current\.replayed && current\.status === "dry_run_complete"\) return current;/);
  assert.match(service, /Commit never re-uploads the workbook/);
  assert.match(service, /runZagulyakyTabularEventImportCommit\(\s*file: File,\s*verifiedRun: ZagulyakyTabularEventImportSummary,\s*prepared: ZagulyakyTabularEventPreparedFile,/);
  assert.match(service, /A missing value parses as zero, so it must not[\s\S]*suppress the first bounded finalize call/);
  assert.match(service, /if \(current\.status === "completed" \|\| current\.status === "completed_with_errors"\) \{/);
  assert.match(service, /actualCounts\.cards - actualCounts\.materializedCards/);
  assert.doesNotMatch(service, /body: file,/);
  assert.doesNotMatch(service, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.doesNotMatch(service, /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role/);
});

test("tabular XLSX UI permits commit only after an exact clean dry run and a fresh acknowledgement", () => {
  assert.match(card, /type="file"/);
  assert.match(card, /accept="\.xlsx,application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet"/);
  assert.match(card, /Локально обчислюємо SHA-256 XLSX-файла/);
  assert.match(card, /Запустити dry run/);
  assert.match(card, /runZagulyakyTabularEventImportDryRun\(file\)/);
  assert.match(card, /function canCommitTabularImport/);
  assert.match(card, /function canResumeTabularImport/);
  assert.match(card, /summary\.status === "commit_ready" \|\| summary\.status === "commit_materializing"/);
  assert.match(card, /const materializationAvailable = commitAvailable \|\| commitResumeAvailable;/);
  assert.match(card, /summary\.importMode === "dry_run"/);
  assert.match(card, /summary\.status === "dry_run_complete"/);
  assert.match(card, /countMatchesWorkbook\(summary\.expectedCounts, summary\)/);
  assert.match(card, /countMatchesWorkbook\(summary\.actualCounts, summary\)/);
  assert.match(card, /!summary\.lastErrorCode/);
  assert.match(card, /type="checkbox"/);
  assert.match(card, /Я підтверджую створення приватних чернеток із цього перевіреного XLSX/);
  assert.match(card, /runZagulyakyTabularEventImportCommit\(file, summary, prepared\)/);
  assert.match(card, /Підтвердити й продовжити створення чернеток/);
  assert.match(card, /Підтвердити й створити приватні чернетки/);
  assert.match(card, /disabled=\{!commitConfirmed \|\| running\}/);
  assert.match(card, /setCommitConfirmed\(false\);/);
  assert.match(card, /Автоматичного об’єднання,[\s\S]*публікації, відкритих URL джерел або вкладень не буде/);
  assert.match(card, /isComplete && onOpenDrafts/);
  assert.match(card, /Переглянути створені чернетки/);
  assert.match(card, /onClick=\{onOpenDrafts\}/);
  assert.doesNotMatch(card, /rawPayload|sourceAuthorLabel|facebookPostUrl/);
});

test("tabular importer is visible only through the dedicated Zagulyaky import capability", () => {
  assert.match(adminCapabilities, /zagulyakyImport: "zagulyaky\.import"/);
  assert.match(adminPage, /hasZagulyakyImportPermission = canSee\(ADMIN_PERMISSION_CODES\.zagulyakyImport\)/);
  assert.match(panel, /import \{ ZagulyakyTabularEventImportCard \} from "\.\/ZagulyakyTabularEventImportCard\.tsx"/);
  assert.match(panel, /\{canImportStage0 \? <ZagulyakyTabularEventImportCard onOpenDrafts=\{openImportedDrafts\} \/> : null\}/);
});

test("successful XLSX commits route operators to the draft queue rather than the default pending-review filter", () => {
  assert.match(panel, /const \[recordsRefreshKey, setRecordsRefreshKey\] = useState\(0\);/);
  assert.match(panel, /const openImportedDrafts = \(\) => \{/);
  assert.match(panel, /setView\("records"\);/);
  assert.match(panel, /setStatus\("draft"\);/);
  assert.match(panel, /setOffset\(0\);/);
  assert.match(panel, /setSelected\(null\);/);
  assert.match(panel, /setRecordsRefreshKey\(\(value\) => value \+ 1\);/);
  assert.match(panel, /\[recordsRefreshKey, refreshClaims, refreshDuplicates, refreshQueue, view\]/);
});

test("private tabular-import provenance is retained only in the protected admin record review bundle", () => {
  assert.match(adminService, /privateImportOrigins: AdminZagulyakaPrivateImportOrigin\[\];/);
  assert.match(adminService, /privateImportOrigins: records\(payload\.privateImportOrigins\)\.map\(privateImportOrigin\)/);
  assert.match(adminService, /facebookPostUrl: safePrivateText\(row\.facebookPostUrl, 4_000\)/);
  assert.match(adminService, /postOriginalText: safePrivateText\(row\.postOriginalText, 12_000\)/);
  assert.match(adminService, /eventOriginalText: safePrivateText\(row\.eventOriginalText, 12_000\)/);

  assert.match(panel, /function PrivateImportOrigins/);
  assert.match(panel, /detail\.privateImportOrigins\.length/);
  assert.match(panel, /safeExternalUrl\(origin\.facebookPostUrl\)/);
  assert.match(panel, /Відкрити оригінальний допис Facebook/);
  assert.match(panel, /target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"/);
  assert.match(panel, /Переглянути приватний вихідний текст/);
  assert.match(panel, /Приватне джерело імпорту/);

  assert.doesNotMatch(publicCatalogue, /privateImportOrigins|facebookPostUrl|postOriginalText/);
  // Stage 0 has its own protected Facebook item-detail view. The tabular
  // provenance projection itself must never be reused by that staging panel.
  assert.doesNotMatch(stagingReview, /privateImportOrigins/);
});

test("browser result contract is count-only and reduces server failures to safe codes", () => {
  assert.match(service, /export interface ZagulyakyTabularEventWorkbookSummary/);
  assert.match(service, /function workbookSummary/);
  assert.match(service, /function importCounts/);
  assert.match(service, /function safeErrorCode/);
  assert.match(service, /safeErrorCode\(payload\.error\) \?\? safeErrorCode\(payload\.code\)/);
  assert.match(service, /function edgeFunctionTransportCode\(error: unknown\): string \| null/);
  assert.match(service, /FunctionsFetchError/);
  assert.match(service, /FunctionsRelayError/);
  assert.match(service, /FunctionsHttpError/);
  assert.match(service, /edgeFunctionTransportCode\(error\) \?\? "TABULAR_EVENT_IMPORT_FAILED"/);
  assert.match(service, /function importSummary/);
  assert.match(service, /lastErrorCode: safeErrorCode\(batch\.lastErrorCode\)/);
  assert.match(service, /IMPORT_FINALIZE_VALIDATION_FAILED:/);
  assert.match(service, /IMPORT_MATERIALIZATION_INCOMPLETE:/);
  assert.doesNotMatch(service, /rawPayload|post_original_text|facebook_post_url_private/);
});

test("unknown safe workbook/import diagnostics remain actionable without exposing XLSX contents", () => {
  assert.match(service, /const SAFE_WORKBOOK_DIAGNOSTIC_CODE = \/\^WORKBOOK_\[A-Z0-9_\]\{1,80\}\$\/;/);
  assert.match(service, /const SAFE_IMPORT_DIAGNOSTIC_CODE = \/\^IMPORT_\[A-Z0-9_\]\{1,80\}\$\/;/);
  assert.match(service, /function safeServerDiagnosticCode\(value: unknown\): string \| null/);
  assert.match(service, /SAFE_WORKBOOK_DIAGNOSTIC_CODE\.test\(code\) \|\| SAFE_IMPORT_DIAGNOSTIC_CODE\.test\(code\)/);
  assert.match(service, /const code = safeErrorCode\(rawCode\) \?\? "TABULAR_EVENT_IMPORT_FAILED"/);
  assert.match(service, /Сервер відхилив XLSX під час \$\{operation\}\. Код перевірки: \$\{safeDiagnostic\}\. Вміст файла не показано/);
  assert.match(service, /if \(messages\[code\]\) return messages\[code\];/);
  assert.doesNotMatch(service, /error\.(?:message|details|hint|stack)/);
});

test("UI recognizes only the exact safe unexpected Edge-phase codes", () => {
  assert.match(service, /const SAFE_UNEXPECTED_IMPORT_PHASE_CODE = \/\^TABULAR_EVENT_IMPORT_UNEXPECTED_\(PREFLIGHT\|AUTH\|BODY\|READ\|HASH\|PARSE\|NORMALIZE\|BEGIN\|CHUNK\|FINALIZE\)\$\//);
  assert.match(service, /function safeUnexpectedImportPhaseCode\(value: unknown\): string \| null/);
  assert.match(service, /SAFE_UNEXPECTED_IMPORT_PHASE_CODE\.test\(code\)/);
  assert.match(service, /TABULAR_EVENT_IMPORT_UNEXPECTED_\"\.length/);
  assert.match(service, /Неочікувана серверна помилка на етапі \$\{label\}\. Дані не публікувалися\. Код перевірки: \$\{unexpectedPhaseCode\}\. Вміст XLSX не показано/);
  assert.doesNotMatch(service, /error\.(?:message|details|hint|stack)/);
});
