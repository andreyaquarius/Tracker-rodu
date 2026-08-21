import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608180004_zagulyaky_moderation_workflows.sql", import.meta.url),
  "utf8",
);
const claimResolverDeprecationMigration = readFileSync(
  new URL("../supabase/migrations/202608180006_zagulyaky_claim_resolver_deprecation.sql", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/zagulyakyAdminService.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/admin/ZagulyakyModerationPanel.tsx", import.meta.url),
  "utf8",
);

const moderatorRpcNames = [
  "admin_get_zagulyaka_review_bundle_v1",
  "admin_list_zagulyaky_duplicate_candidates_v1",
  "admin_create_zagulyaka_duplicate_candidate_v1",
  "admin_resolve_zagulyaka_duplicate_candidate_v1",
  "admin_merge_zagulyaka_duplicate_v1",
  "admin_resolve_zagulyaka_claim_v2",
];

test("Zagulyaky moderator RPCs use private definer implementations and invoker facades", () => {
  for (const rpcName of moderatorRpcNames) {
    assert.match(
      migration,
      new RegExp(`create or replace function security_private\\.${rpcName}\\([\\s\\S]*?security definer[\\s\\S]*?set search_path = pg_catalog, public, security_private, pg_temp`, "i"),
      `${rpcName} has a trusted implementation`,
    );
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${rpcName}\\([\\s\\S]*?security invoker[\\s\\S]*?set search_path = pg_catalog`, "i"),
      `${rpcName} has a public invoker facade`,
    );
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${rpcName}\\([\\s\\S]*?from public, anon, authenticated, service_role;`, "i"),
      `${rpcName} removes default public execution`,
    );
  }
});

test("the review bundle gives moderators bounded version and audit projections", () => {
  assert.match(migration, /safe_version_limit integer := least\(greatest\(coalesce\(p_version_limit, 40\), 1\), 100\)/);
  assert.match(migration, /safe_action_limit integer := least\(greatest\(coalesce\(p_action_limit, 80\), 1\), 200\)/);
  assert.match(migration, /'versions', coalesce\(/);
  assert.match(migration, /'moderationActions', coalesce\(/);
  assert.match(migration, /'adminAudit', coalesce\(/);
  assert.match(migration, /where audit\.target_type = 'zagulyaky_record'/);
  assert.match(migration, /has_admin_permission_v1\('zagulyaky\.moderate'\)/);
});

test("duplicate workflow requires a confirmed pair, optimistic locks, and an audit trail", () => {
  assert.match(migration, /p_status not in \('confirmed', 'dismissed'\)/);
  assert.match(migration, /DUPLICATE_RESOLUTION_NOTE_REQUIRED/);
  assert.match(migration, /candidate\.status <> 'confirmed'/);
  assert.match(migration, /DUPLICATE_CONFIRMATION_REQUIRED/);
  assert.match(migration, /OPEN_ZAGULYAKA_CLAIM_BLOCKS_MERGE/);
  assert.match(migration, /p_survivor_expected_lock_version/);
  assert.match(migration, /p_merged_expected_lock_version/);
  assert.match(migration, /ZAGULYAKA_VERSION_CONFLICT/);
  assert.match(migration, /status = 'merged'/);
  assert.match(migration, /merged_into_id = survivor\.id/);
  assert.match(migration, /zagulyaky\.duplicate\.merge/);
  assert.match(migration, /duplicate_candidate_confirm/);
  assert.match(migration, /duplicate_candidate_dismiss/);
});

test("claim resolution can atomically apply only conservative record protections", () => {
  assert.match(migration, /p_record_action not in \('none', 'privacy_block', 'archive'\)/);
  assert.match(migration, /CLAIM_ARCHIVE_REQUIRES_FINAL_RESOLUTION/);
  assert.match(migration, /REJECTED_CLAIM_CANNOT_CHANGE_RECORD/);
  assert.match(migration, /set privacy_status = 'blocked'/);
  assert.match(migration, /set status = 'archived'/);
  assert.match(migration, /zagulyaky\.claim\.' \|\| p_status/);
});

test("the legacy claim resolver is no longer executable by API roles", () => {
  assert.match(
    claimResolverDeprecationMigration,
    /revoke all on function public\.admin_resolve_zagulyaka_claim_v1\(uuid,text,text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(claimResolverDeprecationMigration, /DEPRECATED: execution is disabled/i);
  assert.match(claimResolverDeprecationMigration, /admin_resolve_zagulyaka_claim_v2\(uuid,text,text,text\)/i);
});

test("admin client and panel expose history, claims protections, and duplicate review", () => {
  assert.match(service, /\.rpc\("admin_get_zagulyaka_review_bundle_v1"/);
  assert.match(service, /\.rpc\("admin_list_zagulyaky_duplicate_candidates_v1"/);
  assert.match(service, /\.rpc\("admin_create_zagulyaka_duplicate_candidate_v1"/);
  assert.match(service, /\.rpc\("admin_resolve_zagulyaka_duplicate_candidate_v1"/);
  assert.match(service, /\.rpc\("admin_merge_zagulyaka_duplicate_v1"/);
  assert.match(service, /\.rpc\("admin_resolve_zagulyaka_claim_v2"/);
  assert.match(panel, /<ReviewHistory detail=\{detail\} \/>/);
  assert.match(panel, /Дублікати/);
  assert.match(panel, /Залишити канонічним/);
  assert.match(panel, /CLAIM_RECORD_ACTION_LABELS/);
  assert.match(panel, /Блокування приховує запис з каталогу одразу/);
});
