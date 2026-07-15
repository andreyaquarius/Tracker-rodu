import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607150001_security_advisor_definer_api_isolation.sql",
    import.meta.url,
  ),
  "utf8",
);

const warningFunctions = [
  "accept_project_invitation",
  "admin_list_family_tree_feature_access",
  "admin_set_family_tree_feature_access",
  "begin_ai_credit_usage",
  "begin_table_import",
  "can_edit_project",
  "can_read_exact_family_group",
  "can_read_exact_family_tree_person",
  "can_read_exact_parent_set",
  "can_use_family_tree_feature",
  "cancel_legacy_gedcom_cleanup",
  "cancel_my_subscription",
  "clear_project_records_for_restore",
  "complete_gedcom_import_operation",
  "get_dashboard_stats",
  "get_family_tree_descendants_frontier_v1",
  "get_family_tree_family_children_v1",
  "get_family_tree_neighborhood_v1",
  "get_family_tree_neighborhood_v2",
  "get_legacy_gedcom_cleanup_status",
  "get_my_subscription_context",
  "get_project_deletion_status",
  "is_app_admin",
  "is_project_member",
  "is_project_owner",
  "list_accessible_project_deletions",
  "process_project_deletion",
  "register_gedcom_import_archive",
  "register_gedcom_import_entities",
  "register_gedcom_import_tree",
  "rollback_gedcom_import_operation",
  "seal_gedcom_import_operation",
  "start_gedcom_import_operation",
  "start_legacy_gedcom_cleanup",
  "start_project_deletion",
  "touch_gedcom_import_operation",
] as const;

function extractedNames(pattern: RegExp): string[] {
  return [...migration.matchAll(pattern)].map((match) => match[1]).sort();
}

test("all 36 Advisor findings are moved behind invoker facades", () => {
  assert.equal(warningFunctions.length, 36);

  const moved = extractedNames(/^alter function public\.([a-z0-9_]+)\(/gim);
  const wrappers = extractedNames(/^create function public\.([a-z0-9_]+)\(/gim);
  const expectedMoved = [...warningFunctions].sort();

  assert.deepEqual(moved, expectedMoved);
  assert.deepEqual(wrappers, expectedMoved);
  assert.equal(moved.length, 36);
  assert.equal(wrappers.length, 36);
  assert.doesNotMatch(migration, /^security definer$/gim);

  const wrapperBlocks = migration.match(
    /create function public\.[\s\S]*?\$wrapper\$;/gim,
  ) ?? [];
  assert.equal(wrapperBlocks.length, 36);
  for (const block of wrapperBlocks) {
    assert.match(block, /security invoker/i);
    assert.match(block, /set search_path = pg_catalog/i);
  }
});

test("the trusted schema has explicit least-privilege ACLs", () => {
  assert.match(migration, /create schema if not exists security_private/i);
  assert.match(
    migration,
    /revoke all on schema security_private from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /grant usage on schema security_private to authenticated, service_role/i,
  );
  assert.match(
    migration,
    /revoke create on schema security_private from public, anon, authenticated, service_role/i,
  );
  assert.match(
    migration,
    /revoke create on schema public from public, anon, authenticated, service_role/i,
  );
  assert.match(migration, /SECURITY_PRIVATE_SCHEMA_MUST_NOT_BE_EXPOSED/i);
});

test("destructive deletion processing is service-role only", () => {
  assert.match(
    migration,
    /create function public\.process_project_deletion[\s\S]*?SERVICE_ROLE_REQUIRED[\s\S]*?security_private\.process_project_deletion/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.process_project_deletion\(uuid, integer\)\s+to service_role/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.process_project_deletion\(uuid, integer\)\s+to authenticated/i,
  );
});

test("the public facades bound AI inputs and preserve the admin-plan contract", () => {
  assert.match(migration, /AI_FEATURE_KEY_TOO_LONG/i);
  assert.match(migration, /AI_MODEL_NAME_TOO_LONG/i);
  assert.match(migration, /AI_METADATA_TOO_LARGE/i);
  assert.match(
    migration,
    /create function public\.is_app_admin[\s\S]*?select security_private\.is_app_admin\(\$1\)/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema'/i);
});
