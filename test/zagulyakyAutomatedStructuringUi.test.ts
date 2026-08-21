import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/zagulyakyStructuringService.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/admin/ZagulyakyStructuringPanel.tsx", import.meta.url),
  "utf8",
);
const reviewer = readFileSync(
  new URL("../src/components/admin/ZagulyakyStagingReviewPanel.tsx", import.meta.url),
  "utf8",
);

test("automated structuring is a consent-gated private Edge workflow, not a browser table write", () => {
  assert.match(service, /ZAGULYAKY_STRUCTURING_PILOT_LIMIT = 50/);
  assert.match(service, /ZAGULYAKY_STRUCTURING_PARSER_VERSION = "zagulyaky-initial-base-v2"/);
  assert.match(service, /functions\.invoke<unknown>\("zagulyaky-structure"/);
  assert.match(service, /action: "start"/);
  assert.match(service, /explicitConsent: true/);
  assert.match(service, /parserVersion: ZAGULYAKY_STRUCTURING_PARSER_VERSION/);
  assert.match(service, /consentVersion: ZAGULYAKY_STRUCTURING_CONSENT_VERSION/);
  assert.match(service, /action: "process_mine"/);
  assert.match(service, /admin_list_zagulyaky_structuring_runs_v1/);
  assert.match(service, /admin_list_zagulyaky_structuring_candidates_v1/);
  assert.match(service, /admin_retry_zagulyaky_structuring_failed_tasks_v1/);
  assert.doesNotMatch(service, /admin_materialize_zagulyaky_structuring_candidates_v1/);
  assert.doesNotMatch(service, /\.from\("zagulyaky_ingestion_/);
  assert.doesNotMatch(service, /SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|service_role/);
});

test("private UI enriches source-post cards without creating catalogue drafts", () => {
  assert.match(panel, /Stage 1 · приватна початкова база/u);
  assert.match(panel, /Один допис лишається однією приватною карткою початкової бази/u);
  assert.match(panel, /не створює карток каталогу/u);
  assert.match(panel, /Підтверджую передачу до Google Gemini лише текстів некарантинних дописів/u);
  assert.match(panel, /Запустити пілот на 50 дописах/u);
  assert.match(panel, /Опрацювати наступний допис/u);
  assert.match(panel, /Відновити помилкову задачу/u);
  assert.match(panel, /Повернути до \$\{formatCount\(Math\.min\(run\.failedCount, 25\)\)\} помилкових задач у чергу/u);
  assert.match(panel, /не публікує, не зливає людей і не завантажує зображення/u);
  assert.match(panel, /person: "Людина · витягнутий факт"/u);
  assert.match(panel, /document: "Документ · витягнутий факт"/u);
  assert.doesNotMatch(panel, /materializeZagulyakyStructuringCandidates|Створити до 100 приватних чернеток/u);
});

test("one staging batch receives the private structuring panel without exposing source payloads", () => {
  assert.match(reviewer, /ZagulyakyStructuringPanel/);
  assert.match(reviewer, /batchId=\{selectedBatch\.id\}/);
  assert.match(reviewer, /batchCompleted=\{selectedBatch\.status === "completed" \|\| selectedBatch\.status === "completed_with_errors"\}/);
  assert.doesNotMatch(panel, /rawPayload|raw_payload|sourceUrl|source_url|sourceAuthorLabel|<img\b|<a\b/);
});

test("worker-specific safe failures have useful local Ukrainian messages", () => {
  assert.match(service, /STRUCTURE_CONFIG_MISSING_KEY/);
  assert.match(service, /STRUCTURE_GEMINI_RATE_LIMITED/);
  assert.match(service, /STRUCTURE_GEMINI_AUTH_FAILED/);
  assert.match(service, /STRUCTURE_GEMINI_ACCOUNT_PRECONDITION/);
  assert.match(service, /STRUCTURE_GEMINI_REQUEST_INVALID/);
  assert.match(service, /STRUCTURE_GEMINI_MODEL_UNAVAILABLE/);
  assert.match(service, /STRUCTURE_MODEL_OUTPUT_INVALID/);
  assert.match(service, /lastErrorCode/);
  assert.match(service, /STRUCTURING_RETRY_CONFIRMATION_REQUIRED/);
  assert.match(panel, /storedTaskError/);
  assert.match(panel, /Є невдалі приватні задачі/u);
  assert.match(panel, /run\.failedCount === 0/);
});
