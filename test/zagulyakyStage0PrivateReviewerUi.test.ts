import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/zagulyakyAdminService.ts", import.meta.url),
  "utf8",
);
const reviewer = readFileSync(
  new URL("../src/components/admin/ZagulyakyStagingReviewPanel.tsx", import.meta.url),
  "utf8",
);
const moderation = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);

test("private Stage 0 reviewer calls only the admin batch, item and detail RPC projections", () => {
  assert.match(service, /admin_list_zagulyaky_ingestion_batches_v1/);
  assert.match(service, /p_status: safeStatus/);
  assert.match(service, /p_limit: Math\.min\(Math\.max\(Math\.trunc\(limit\), 1\), 100\)/);
  assert.match(service, /admin_list_zagulyaky_ingestion_items_v1/);
  assert.match(service, /p_batch_id: batchId/);
  assert.match(service, /p_query: query \|\| null/);
  assert.match(service, /p_stage_status: stageStatus/);
  assert.match(service, /p_quarantined: typeof input\.quarantined === "boolean" \? input\.quarantined : null/);
  assert.match(service, /p_flag: flag/);
  assert.match(service, /admin_get_zagulyaky_ingestion_item_v1/);
  assert.match(service, /p_item_id: itemId/);
  assert.match(service, /input\.query\.trim\(\)\.slice\(0, 160\)/);
  assert.doesNotMatch(service, /\.from\("zagulyaky_ingestion_/);
});

test("private reviewer honors the server's nested safe detail projection and bounds the displayed text", () => {
  assert.match(service, /const flags = record\(valueFor\(row, "flags"\)\)/);
  assert.match(service, /const source = record\(valueFor\(effectiveItemRow, "source"\)\)/);
  assert.match(service, /const content = record\(valueFor\(effectiveItemRow, "content"\)\)/);
  assert.match(service, /rawTextTruncatedForReview/);
  assert.match(service, /safePrivateText\(rawTextValue, 16_000\)/);
  assert.match(service, /valueFor\(source, "sourceAuthorLabel"/);
  assert.match(service, /valueFor\(source, "sourceUrl"/);
  assert.match(service, /valueFor\(source, "candidateYears"/);
  assert.match(service, /textPreview: safePrivateText\(valueFor\(row, "textPreview", "text_preview"\), 360\)/);
  assert.match(service, /pageRows\(payload, "structuredCandidates", "structured_candidates", "candidates"\)/);
  assert.match(service, /facebookPostUrl", "facebook_post_url"/);
  assert.match(service, /candidateData", "candidate_data", "data"/);
  assert.match(service, /originText", "origin_text"/);
  assert.match(service, /residenceText", "residence_text"/);
  assert.match(service, /socialEstateText", "social_estate_text"/);
  assert.match(service, /structuredCandidates: itemStructuredCandidateRows/);
  assert.match(reviewer, /maxLength=\{160\}/);
  assert.match(reviewer, /перші 16 000 символів/u);
});

test("reviewer defaults to a completed batch and offers the required private filters and pagination", () => {
  assert.match(reviewer, /function newestCompletedBatch/);
  assert.match(reviewer, /batch\.status === "completed" \|\| batch\.status === "completed_with_errors"/);
  assert.match(reviewer, /Пошук у приватному тексті та ID/);
  assert.match(reviewer, /Лише quarantine/);
  assert.match(reviewer, /Є вкладення/);
  assert.match(reviewer, /Потрібен OCR/);
  assert.match(reviewer, /Потрібно повторно перевірити джерело/);
  assert.match(reviewer, /Фрагмент джерела/);
  assert.match(reviewer, /item\.textPreview/);
  assert.match(reviewer, /function Pagination/);
  assert.match(reviewer, /Допис №/);
});

test("reviewer is an import-permission-only admin tab with a safe, explicit source-post link", () => {
  assert.match(moderation, /ZagulyakyStagingReviewPanel/);
  assert.match(moderation, /\{canImportStage0 \? <button[^\n]+Приватний staging/u);
  assert.match(moderation, /canImportStage0 \? <ZagulyakyStagingReviewPanel \/> : null/);
  assert.match(reviewer, /Початкова база · приватна/u);
  assert.match(reviewer, /не є публічною карткою «Загуляки»/u);
  assert.match(reviewer, /Оригінальний текст допису/u);
  assert.match(reviewer, /Витягнуті дані з цього допису/u);
  assert.match(reviewer, /const safeFacebookPostUrl = sanitizeWebUrl\(detail\.facebookPostUrl\)/);
  assert.match(reviewer, /href=\{safeFacebookPostUrl\} target="_blank" rel="noopener noreferrer"/);
  assert.match(reviewer, /Оригінальний допис Facebook \(приватно\)/u);
  assert.match(reviewer, /Внутрішнє приватне посилання/u);
  assert.match(reviewer, /не копіюється до каталогу автоматично/u);
  assert.match(reviewer, /Зображення не підвантажуються й не відображаються/u);
  assert.match(reviewer, /не відкривається автоматично/u);
  assert.doesNotMatch(reviewer, /rawPayload|raw_payload/);
  assert.doesNotMatch(reviewer, /<img\b|dangerouslySetInnerHTML/);
});
