import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608200011_zagulyaky_historical_submission_without_acknowledgements.sql",
    import.meta.url,
  ),
  "utf8",
);

function functionBody(schema: "security_private" | "public", functionName: string): string {
  const marker = `create or replace function ${schema}.${functionName}`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `${schema}.${functionName} must exist`);
  const end = migration.indexOf("$function$;", start);
  assert.ok(end > start, `${schema}.${functionName} must have a complete body`);
  return migration.slice(start, end + "$function$;".length);
}

test("historical manual submissions no longer require a rights acknowledgement", () => {
  const submit = functionBody("public", "submit_zagulyaka_v1");

  assert.match(submit, /security definer[\s\S]*set search_path = pg_catalog, public, security_private, pg_temp/i);
  assert.match(submit, /existing\.created_by is distinct from current_user_id/i);
  assert.match(submit, /ZAGULYAKA_SOURCE_REQUIRED/i);
  assert.doesNotMatch(submit, /ZAGULYAKA_RIGHTS_CONFIRMATION_REQUIRED/i);
  assert.doesNotMatch(submit, /submission_terms_version is null|rights_confirmed_at is null/i);
  assert.match(submit, /status = 'pending_review'/i);
  assert.match(submit, /when possible_living_person then 'requires_consent'/i);
  assert.doesNotMatch(submit, /status = 'published'/i);
});

test("owned initial-base submission ignores legacy acknowledgement arguments and keeps Facebook private", () => {
  const submit = functionBody("security_private", "submit_my_zagulyaky_tabular_initial_base_batch_v1");

  assert.match(submit, /p_acknowledge_rights boolean default false/i);
  assert.match(submit, /p_acknowledge_public_origin_link boolean default false/i);
  assert.doesNotMatch(submit, /INITIAL_BASE_RIGHTS_ACKNOWLEDGEMENT_REQUIRED|INITIAL_BASE_PUBLIC_ORIGIN_ACKNOWLEDGEMENT_REQUIRED/i);
  assert.match(submit, /v_batch\.requested_by is distinct from v_current_user_id/i);
  assert.match(submit, /v_batch\.status <> 'completed'/i);
  assert.match(submit, /record_row\.created_by = v_current_user_id/i);
  assert.match(submit, /record_row\.status in \('draft', 'needs_changes'\)/i);
  assert.match(submit, /for update of record_row skip locked/i);
  assert.match(submit, /facebookOriginKeptPrivate/i);
  assert.doesNotMatch(submit, /admin_set_zagulyaka_tabular_facebook_origin_visibility_v1/i);
  assert.doesNotMatch(submit, /public_link_status\s*=\s*'approved'/i);
  assert.doesNotMatch(submit, /rights_confirmed_at\s*=|submission_terms_version\s*=/i);
  assert.match(submit, /when v_record\.possible_living_person then 'requires_consent'/i);
  assert.doesNotMatch(submit, /status = 'published'/i);
});

test("bulk publication is still moderator-only and materializes an origin only in that action", () => {
  const publish = functionBody("security_private", "admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1");

  assert.match(publish, /has_admin_permission_v1\('zagulyaky\.moderate'\)/i);
  assert.match(publish, /INITIAL_BASE_PUBLICATION_ACKNOWLEDGEMENT_REQUIRED/i);
  assert.match(publish, /INITIAL_BASE_NON_LIVING_PRIVACY_ACKNOWLEDGEMENT_REQUIRED/i);
  assert.doesNotMatch(publish, /submission_terms_version is not null|rights_confirmed_at is not null/i);
  assert.match(publish, /public\.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1\([\s\S]*v_selected_record_ids,[\s\S]*true/i);
  assert.match(publish, /record_row\.status = 'pending_review'/i);
  assert.match(publish, /record_row\.privacy_status <> 'blocked'/i);
  assert.match(publish, /zagulyaky_has_living_person_clearance_v1\(record_row\.id\)/i);
  assert.match(publish, /status = 'published'/i);
  assert.match(publish, /privacy_status = 'cleared'/i);
  assert.doesNotMatch(publish, /verification_status\s*=/i);
});

test("bulk summary exposes compatibility aliases without retaining acknowledgement or rights gates", () => {
  const summary = functionBody("security_private", "zagulyaky_initial_base_bulk_summary_v1");

  assert.match(summary, /'availableForSubmission'/);
  assert.match(summary, /'availableForPublication'/);
  assert.match(summary, /'availableAfterAcknowledgement'/);
  assert.match(summary, /'remainingEligibleCount'/);
  assert.match(summary, /'originApprovalPendingCount', 0/);
  assert.match(summary, /'rightsNotRecordedCount', 0/);
  assert.doesNotMatch(summary, /public_link_status\s*=\s*'approved'/i);
  assert.doesNotMatch(summary, /has_approved_origin_source|submission_terms_version|rights_confirmed_at/i);
  assert.doesNotMatch(summary, /facebookPostUrl|postOriginalText|sourceUrl|sourceFileName|sourceChecksum/i);
});

test("RPC privileges stay limited to authenticated callers", () => {
  assert.match(
    migration,
    /revoke all on function public\.submit_zagulyaka_v1\(uuid,integer\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.submit_my_zagulyaky_tabular_initial_base_batch_v1\(uuid,integer,boolean,boolean\)\s+to authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1\(uuid,integer,boolean,boolean\)\s+to authenticated, service_role;/i,
  );
});
