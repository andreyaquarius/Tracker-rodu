import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/zagulyakyInitialBaseBulkService.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/admin/ZagulyakyInitialBaseBulkPanel.tsx", import.meta.url),
  "utf8",
);
const moderationPanel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);
const adminPage = readFileSync(
  new URL("../src/pages/AdminPanelPage.tsx", import.meta.url),
  "utf8",
);

test("initial-base batch client is count-only, submits historical records without author acknowledgements, and stays bound to protected RPCs", () => {
  assert.match(service, /ZAGULYAKY_INITIAL_BASE_BULK_CHUNK_LIMIT = 250/);
  assert.match(service, /list_my_zagulyaky_initial_base_bulk_batches_v1/);
  assert.match(service, /get_my_zagulyaky_initial_base_bulk_summary_v1/);
  assert.match(service, /admin_get_zagulyaky_initial_base_bulk_summary_v1/);
  assert.match(service, /submit_my_zagulyaky_tabular_initial_base_batch_v1/);
  assert.match(service, /admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1/);
  assert.match(service, /p_acknowledge_rights: false/);
  assert.match(service, /p_acknowledge_public_origin_link: false/);
  assert.match(service, /p_acknowledge_publication: true/);
  assert.match(service, /p_acknowledge_non_living_privacy: true/);
  assert.match(service, /availableForSubmission/);
  assert.match(service, /availableForPublication/);
  assert.match(service, /originApprovalNeedsModeratorCount/);
  assert.match(service, /livingNeedsDocumentedConsentCount/);
  assert.match(service, /unknownFoundLocationCount/);
  assert.match(service, /sourceUnavailableInCallCount/);
  assert.doesNotMatch(service, /facebook_post_url_private|postOriginalText|eventOriginalText|sourceFileName/i);
});

test("initial-base workflow has explicit selection, resumable chunks, and a moderator-only publish control", () => {
  assert.match(panel, /const MAX_BULK_REQUESTS = 100/);
  assert.match(panel, /remainingEligibleCount/);
  assert.match(panel, /function .*runInChunks|const runInChunks = async/);
  assert.match(panel, /Продовжити подання/);
  assert.match(panel, /Продовжити публікацію/);
  assert.match(panel, /Підтверджую модераторське рішення опублікувати всі вибрані записи/);
  assert.match(panel, /потрібна документована згода для можливо живої особи/);
  assert.match(panel, /можливо живі — лише з чинною документованою згодою/);
  assert.match(panel, /без такої згоди або з блокуванням приватності залишаються приватними/);
  assert.match(panel, /Це попередження, а не блокування подання/);
  assert.match(panel, /canModerateZagulyaky \? <section className="zagulyaky-initial-base-action-card publish">/);
  assert.match(panel, /window\.confirm/);
  assert.doesNotMatch(panel, /submitRightsAcknowledged|submitOriginAcknowledged/);
  assert.doesNotMatch(panel, /Підтверджую, що маю право подати ці матеріали/);
  assert.doesNotMatch(panel, /Підтверджую публікацію посилання на оригінальний Facebook-допис/);
  assert.doesNotMatch(panel, /facebookPostUrl|postOriginalText|eventOriginalText|sourceFileName/i);
});

test("moderation capability is passed separately from the import capability", () => {
  assert.match(adminPage, /hasZagulyakyModeratePermission = canSee\(ADMIN_PERMISSION_CODES\.zagulyakyModerate\)/);
  assert.match(adminPage, /canModerateZagulyaky=\{hasZagulyakyModeratePermission\}/);
  assert.match(moderationPanel, /canModerateZagulyaky = false/);
  assert.match(moderationPanel, /ZagulyakyInitialBaseBulkPanel canModerateZagulyaky=\{canModerateZagulyaky\}/);
});
