import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190001_zagulyaky_privacy_and_attachment_delivery.sql", import.meta.url),
  "utf8",
);
const attachmentEdge = readFileSync(
  new URL("../supabase/functions/zagulyaka-attachment/index.ts", import.meta.url),
  "utf8",
);
const stage0Edge = readFileSync(
  new URL("../supabase/functions/zagulyaky-stage0-import/index.ts", import.meta.url),
  "utf8",
);
const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const publicService = readFileSync(new URL("../src/services/zagulyakyService.ts", import.meta.url), "utf8");
const publicDetail = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDetailDialog.tsx", import.meta.url),
  "utf8",
);
const adminService = readFileSync(new URL("../src/services/zagulyakyAdminService.ts", import.meta.url), "utf8");
const moderationPanel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);

test("a possible living person cannot be cleared or published without recorded consent", () => {
  assert.match(migration, /create table if not exists public\.zagulyaky_privacy_clearances/);
  assert.match(migration, /review_status = 'approved'/);
  assert.match(migration, /consent_obtained_at is not null/);
  assert.match(migration, /char_length\(btrim\(clearance\.evidence_reference\)\) >= 3/);
  assert.match(migration, /create trigger zagulyaky_records_living_person_privacy/);
  assert.match(migration, /LIVING_PERSON_DOCUMENTED_CONSENT_REQUIRED/);
  assert.match(migration, /admin_record_zagulyaka_living_consent_v1/);
  assert.match(moderationPanel, /Можливо жива особа/);
  assert.match(moderationPanel, /runRecordLivingConsent/);
});

test("initial private drafts only show living-person clearance controls during review", () => {
  assert.match(
    moderationPanel,
    /const requiresLivingPrivacyReview = Boolean\(\s*selected && \(selected\.status === "pending_review" \|\| selected\.status === "published"\),\s*\);/s,
  );
  assert.match(moderationPanel, /\{requiresLivingPrivacyReview && selected\.possibleLivingPerson \?/);
  assert.doesNotMatch(moderationPanel, /rightsConfirmedAt \?/);
});

test("private evidence is reviewed and published only through controlled server actions", () => {
  assert.match(migration, /update storage\.buckets\s+set public = false\s+where id = 'zagulyaky-public'/s);
  for (const rpc of [
    "admin_get_zagulyaka_attachment_review_v1",
    "admin_prepare_zagulyaka_attachment_publication_v1",
    "admin_complete_zagulyaka_attachment_publication_v1",
    "admin_revoke_zagulyaka_attachment_publication_v1",
    "get_public_zagulyaka_attachment_delivery_v1",
  ]) {
    assert.match(migration, new RegExp(`create or replace function security_private\\.${rpc}\\(`));
  }
  assert.match(migration, /PUBLIC_ATTACHMENT_OBJECT_NOT_FOUND/);
  assert.match(migration, /grant execute on function security_private\.admin_get_zagulyaka_attachment_review_v1\(uuid\) to authenticated, service_role/);
  assert.match(migration, /create or replace function public\.get_public_zagulyaka_attachment_delivery_v1\([\s\S]*?security definer[\s\S]*?set search_path = pg_catalog, public, security_private, pg_temp/s);
  assert.match(attachmentEdge, /type AttachmentAction = "delivery" \| "preview" \| "publish" \| "revoke"/);
  assert.match(attachmentEdge, /callerClient\.auth\.getUser\(\)/);
  assert.match(attachmentEdge, /function privateObjectPresence/);
  assert.match(attachmentEdge, /ATTACHMENT_PRIVATE_OBJECT_NOT_FOUND/);
  assert.match(attachmentEdge, /ATTACHMENT_PRIVATE_STORAGE_CHECK_FAILED/);
  assert.match(attachmentEdge, /ATTACHMENT_PRIVATE_SIGNING_FAILED/);
  assert.match(attachmentEdge, /adminClient\.storage\s*\.from\(preparation\.privateBucket\)\s*\.download\(preparation\.privatePath\)/);
  assert.match(attachmentEdge, /createSignedUrl\(path, SIGNED_URL_SECONDS\)/);
  assert.match(config, /\[functions\.zagulyaka-attachment\][\s\S]*?verify_jwt = false/);
  assert.match(publicService, /functions\.invoke\("zagulyaka-attachment"/);
  assert.match(publicService, /deliveryUnavailable: true/);
  assert.match(publicDetail, /Файл тимчасово недоступний/);
  assert.match(adminService, /invokeAttachmentWorkflow\("preview", attachmentId\)/);
  assert.match(moderationPanel, /Переглянути приватно/);
  assert.match(moderationPanel, /Створити публічну копію/);
  assert.match(moderationPanel, /Опублікувати цей запис і створити публічні копії/);
  assert.match(moderationPanel, /for \(const attachmentId of pendingAttachmentIds\)/);
  assert.doesNotMatch(
    migration,
    /select a, r into attachment, target_record/i,
    "PL/pgSQL composite variables must be populated with separate queries",
  );
});

test("attachment changes are visible to moderated history without exposing storage locations", () => {
  assert.match(migration, /'attachmentManifest'/);
  assert.match(migration, /'isPublicDerivative', attachment\.is_public_derivative/);
  assert.doesNotMatch(
    migration.slice(migration.indexOf("'attachmentManifest'"), migration.indexOf("create or replace function security_private.audit_zagulyaky_attachment_change_v1")),
    /storage_path|public_path|sha256/i,
  );
  assert.match(migration, /'attachment_add'/);
  assert.match(migration, /'attachment_remove'/);
  assert.match(moderationPanel, /snapshotAttachmentSummary/);
  assert.match(moderationPanel, /attachment_publish/);
  assert.match(moderationPanel, /attachment_revoke/);
});

test("the browser-facing Stage 0 importer authenticates before it reads the export body", () => {
  const authAt = stage0Edge.indexOf("callerClient.auth.getUser(accessToken)");
  const bytesAt = stage0Edge.indexOf("await request.arrayBuffer()");
  assert.ok(authAt >= 0, "expected code-side JWT validation");
  assert.ok(bytesAt >= 0, "expected request body handling");
  assert.ok(authAt < bytesAt, "JWT must be checked before processing up to 20 MiB of export data");
});
