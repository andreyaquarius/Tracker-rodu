import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190003_zagulyaky_privacy_integrity_and_public_redaction.sql", import.meta.url),
  "utf8",
);
const attachmentEdge = readFileSync(
  new URL("../supabase/functions/zagulyaka-attachment/index.ts", import.meta.url),
  "utf8",
);
const moderationPanel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing section start: ${startMarker}`);
  assert.ok(end > start, `missing section end: ${endMarker}`);
  return migration.slice(start, end);
}

test("documented living-person consent is bound to deterministic reviewed content", () => {
  const fingerprint = section(
    "create or replace function security_private.zagulyaky_living_person_content_fingerprint_v1",
    "create or replace function security_private.stamp_zagulyaky_privacy_clearance_fingerprint_v1",
  );
  const clearanceGuard = section(
    "create or replace function security_private.zagulyaky_has_living_person_clearance_v1",
    "-- A privacy block must always be possible",
  );

  assert.match(migration, /reviewed_content_fingerprint text/i);
  assert.match(migration, /\^\[0-9a-f\]\{64\}\$/i);
  assert.match(fingerprint, /'participants'/);
  assert.match(fingerprint, /'sources'/);
  assert.match(fingerprint, /'documentDiscoveries'/);
  assert.match(fingerprint, /participant\.id\)/);
  assert.match(fingerprint, /extensions\.digest/);
  assert.match(fingerprint, /public\.digest/);
  assert.match(clearanceGuard, /reviewed_content_fingerprint =\s*security_private\.zagulyaky_living_person_content_fingerprint_v1\(p_record_id\)/s);
  assert.match(migration, /review_status = 'revoked'/);
  assert.match(migration, /new\.privacy_status is distinct from 'blocked'/);
  assert.match(migration, /new\.privacy_status = 'blocked'/);
});

test("public projections and delivery fail closed for stale living-person consent and redact Storage coordinates", () => {
  const publicDetail = section(
    "create or replace function public.get_public_zagulyaka_v1(p_slug text)",
    "-- Search wrappers retain cursor semantics",
  );
  const serviceDelivery = section(
    "create or replace function public.service_get_public_zagulyaka_attachment_delivery_v1",
    "-- The first attachment-delivery facade",
  );

  assert.match(migration, /alter function public\.get_public_zagulyaka_v1\(text\) set schema security_private;/);
  assert.match(publicDetail, /security_private\.zagulyaky_has_living_person_clearance_v1/);
  assert.match(publicDetail, /'id', attachment\.value -> 'id'/);
  assert.doesNotMatch(publicDetail, /'bucket'|'path'|public_bucket|public_path/i);
  assert.match(migration, /create or replace function public\.search_zagulyaky_people_v1/);
  assert.match(migration, /create or replace function public\.search_zagulyaky_documents_v1/);
  const boundedSearch = section(
    "create or replace function security_private.search_zagulyaky_v1(\n  p_kind text,",
    "create or replace function public.search_zagulyaky_people_v1",
  );
  assert.match(boundedSearch, /and \(\s*not r\.possible_living_person\s*or security_private\.zagulyaky_has_living_person_clearance_v1\(r\.id\)\s*\)/s);
  assert.ok(
    boundedSearch.indexOf("security_private.zagulyaky_has_living_person_clearance_v1(r.id)")
      < boundedSearch.indexOf("limit safe_limit + 1"),
    "the visibility gate must execute before pagination builds nextCursor",
  );
  assert.match(migration, /create or replace function public\.get_zagulyaky_public_stats_v1/);
  assert.match(serviceDelivery, /security_private\.get_public_zagulyaka_attachment_delivery_v1/);
  assert.match(serviceDelivery, /zagulyaky_has_living_person_clearance_v1/);
  assert.match(migration, /revoke all on function public\.get_public_zagulyaka_attachment_delivery_v1\(uuid\)\s+from public, anon, authenticated, service_role;/i);
  assert.match(migration, /revoke all on function security_private\.get_public_zagulyaka_attachment_delivery_v1\(uuid\)\s+from public, anon, authenticated, service_role;/i);
  assert.match(migration, /grant execute on function public\.service_get_public_zagulyaka_attachment_delivery_v1\(uuid\)\s+to service_role;/i);
  assert.match(attachmentEdge, /adminClient\.rpc\("service_get_public_zagulyaka_attachment_delivery_v1"/);
  assert.match(moderationPanel, /PUBLIC_ATTACHMENT_CLEANUP_PENDING/);
  assert.match(moderationPanel, /ATTACHMENT_PUBLICATION_PENDING_RETRY/);
});

test("authors cannot delete a linked private original directly from Storage", () => {
  assert.match(migration, /create or replace function security_private\.zagulyaky_private_storage_path_is_unattached_v1/);
  assert.match(migration, /drop policy if exists zagulyaky_private_file_delete_own on storage\.objects;/);
  assert.match(migration, /security_private\.zagulyaky_private_storage_path_is_unattached_v1\(name\)/);
  assert.match(migration, /grant execute on function security_private\.zagulyaky_private_storage_path_is_unattached_v1\(text\)\s+to authenticated, service_role;/i);
});
