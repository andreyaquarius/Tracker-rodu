import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/zagulyakyStage0ImportService.ts", import.meta.url),
  "utf8",
);
const card = readFileSync(
  new URL("../src/components/admin/ZagulyakyStage0ImportCard.tsx", import.meta.url),
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

test("Stage 0 browser service sends only the original JSON file in an explicit allowed mode", () => {
  assert.match(service, /export const ZAGULYAKY_STAGE0_MAX_FILE_BYTES = 20 \* 1024 \* 1024/);
  assert.match(service, /export type ZagulyakyStage0ImportMode = "dry_run" \| "commit"/);
  assert.match(service, /if \(!\/\\\.json\$\/iu\.test\(fileName\)\)/);
  assert.match(service, /file\.arrayBuffer\(\)/);
  assert.match(service, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(service, /client\.auth\.getSession\(\)/);
  assert.match(service, /functions\.invoke<unknown>\("zagulyaky-stage0-import", \{/);
  assert.match(service, /body: file,/);
  assert.match(service, /"Content-Type": "application\/json"/);
  assert.match(service, /"x-zagulyaky-import-mode": importMode/);
  assert.match(service, /"x-zagulyaky-source-file-name": file\.name\.trim\(\)/);
  assert.match(service, /"x-zagulyaky-source-checksum": checksum/);
  assert.match(service, /return runZagulyakyStage0Import\(file, "dry_run"\)/);
  assert.match(service, /return runZagulyakyStage0Import\(file, "commit"\)/);
  assert.match(service, /function safeImportMode/);
  assert.match(service, /const replaysTerminalCommitForDryRun = expectedImportMode === "dry_run"/);
  assert.match(service, /importMode === "commit"/);
  assert.match(service, /status === "completed_with_errors"/);
  assert.match(service, /return runZagulyakyStage0Import\(file, "commit"\);/);
  assert.doesNotMatch(service, /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role/);
});

test("Stage 0 UI exposes commit only after a clean dry run and a fresh local acknowledgement", () => {
  assert.match(card, /type="file"/);
  assert.match(card, /accept="\.json,application\/json"/);
  assert.match(card, /Локально обчислюємо SHA-256 файла/);
  assert.match(card, /Запустити dry run/);
  assert.match(card, /runZagulyakyStage0DryRun\(file\)/);
  assert.match(card, /function canCommitPrivateStaging/);
  assert.match(card, /summary\.importMode === "dry_run"/);
  assert.match(card, /summary\.status === "dry_run_complete"/);
  assert.match(card, /summary\.processedItemCount === summary\.expectedItemCount/);
  assert.match(card, /summary\.stagedItemCount === 0/);
  assert.match(card, /summary\.failedItemCount === 0/);
  assert.match(card, /!summary\.lastErrorCode/);
  assert.match(card, /type="checkbox"/);
  assert.match(card, /Я підтверджую завантаження цього перевіреного файла до приватного staging/);
  assert.match(card, /runZagulyakyStage0Commit\(file\)/);
  assert.match(card, /Підтвердити й завантажити до приватного staging/);
  assert.match(card, /disabled=\{!commitConfirmed \|\| running\}/);
  assert.match(card, /setCommitConfirmed\(false\);/);
  assert.match(card, /Публічних карток не створено/);
  assert.doesNotMatch(card, /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role/);
});

test("Stage 0 exposes recovery only for a server-confirmed replay of an exact partial commit", () => {
  assert.match(service, /recoveryAvailable: replayed/);
  assert.match(service, /payload\.recoveryAvailable === true \|\| batch\.recoveryAvailable === true/);
  assert.match(service, /export async function runZagulyakyStage0Recovery/);
  assert.match(service, /Recovery deliberately uses the existing, server-supported `commit` mode/);
  assert.match(card, /function canRecoverPrivateStaging/);
  assert.match(card, /summary\.status === "completed_with_errors"/);
  assert.match(card, /summary\.replayed/);
  assert.match(card, /summary\.recoveryAvailable/);
  assert.match(card, /runZagulyakyStage0Recovery\(file\)/);
  assert.match(card, /type="checkbox"/);
  assert.match(card, /Я підтверджую повторну обробку незбереженої частини цього самого файла/);
  assert.match(card, /Підтвердити й відновити у приватному staging/);
  assert.match(card, /Commit збережено частково/);
  assert.match(card, /У приватному staging збережено/);
  assert.doesNotMatch(card, /rawText|sourceAuthorLabel|sourceUrl|rawPayload/);
});

test("only accounts with the exact Zagulyaky import capability see the importer", () => {
  assert.match(adminCapabilities, /zagulyakyImport: "zagulyaky\.import"/);
  assert.match(adminPage, /hasZagulyakyImportPermission = canSee\(ADMIN_PERMISSION_CODES\.zagulyakyImport\)/);
  assert.match(adminPage, /<ZagulyakyModerationPanel canImportStage0=\{hasZagulyakyImportPermission\} \/>/);
  assert.match(panel, /canImportStage0 = false/);
  assert.match(panel, /\{canImportStage0 \? <ZagulyakyStage0ImportCard \/> : null\}/);
});

test("the displayed server result is reduced to counters and safe technical codes", () => {
  assert.match(service, /function safeErrorCode/);
  assert.match(service, /function importSummary/);
  assert.match(service, /function safeImportMode/);
  assert.match(service, /completedAt: safeTimestamp\(batch\.completedAt\)/);
  assert.match(card, /failedItemCount/);
  assert.match(card, /lastErrorCode/);
  assert.doesNotMatch(card, /rawText|sourceAuthorLabel|sourceUrl|rawPayload/);
});

test("Stage 0 shows safe recovery messages for begin-import failures", () => {
  for (const code of [
    "IMPORT_BEGIN_RPC_UNAVAILABLE",
    "IMPORT_BEGIN_VALIDATION_FAILED",
    "IMPORT_BEGIN_REQUESTER_PROFILE_REQUIRED",
    "IMPORT_BEGIN_CONFLICT",
  ]) {
    assert.match(service, new RegExp(`${code}:`));
  }
  assert.match(service, /const BEGIN_DATABASE_ERROR_CODE = \/\^IMPORT_BEGIN_DATABASE_ERROR_/);
  assert.match(service, /function safeBeginDatabaseDiagnosticCode\(code: string\): string \| null/);
  assert.match(service, /\?:\[0-9A-Z\]\{5\}\|PGRST\[0-9\]\{3\}\|UNKNOWN/);
  assert.match(service, /const databaseDiagnosticCode = safeBeginDatabaseDiagnosticCode\(code\)/);
  assert.match(service, /Код перевірки: \$\{databaseDiagnosticCode\}/);
  assert.doesNotMatch(service, /Код перевірки: \$\{code\}/);
  // The former generic error stays mapped for clients which still reach an
  // older deployed Edge Function while the frontend has already refreshed.
  assert.match(service, /IMPORT_BATCH_REJECTED:/);
  assert.doesNotMatch(service, /beginError\.(?:message|details|hint|parameters)/);
});
