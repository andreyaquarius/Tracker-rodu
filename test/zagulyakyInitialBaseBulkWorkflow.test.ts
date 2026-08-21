import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608200010_zagulyaky_initial_base_bulk_workflow.sql",
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

test("initial-base bulk functions are narrow, bounded private implementations with invoker facades", () => {
  const privateFunctions = [
    "get_my_zagulyaky_initial_base_bulk_summary_v1",
    "admin_get_zagulyaky_initial_base_bulk_summary_v1",
    "list_my_zagulyaky_initial_base_bulk_batches_v1",
    "submit_my_zagulyaky_tabular_initial_base_batch_v1",
    "admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1",
  ];

  for (const functionName of privateFunctions) {
    assert.match(
      functionBody("security_private", functionName),
      /security definer[\s\S]*set search_path = pg_catalog, public, security_private, pg_temp/i,
      `${functionName} must use a pinned definer implementation`,
    );
    assert.match(
      functionBody("public", functionName),
      /security invoker[\s\S]*set search_path = pg_catalog/i,
      `${functionName} must use an invoker facade`,
    );
  }

  assert.match(
    migration,
    /revoke all on function public\.submit_my_zagulyaky_tabular_initial_base_batch_v1\(uuid,integer,boolean,boolean\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1\(uuid,integer,boolean,boolean\)\s+to authenticated, service_role;/i,
  );
});

test("owner bulk submission is completed-batch scoped, resumable, and requires two explicit acknowledgements", () => {
  const submit = functionBody("security_private", "submit_my_zagulyaky_tabular_initial_base_batch_v1");

  assert.match(submit, /p_limit is null or p_limit not between 1 and 250/i);
  assert.match(submit, /INITIAL_BASE_RIGHTS_ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(submit, /INITIAL_BASE_PUBLIC_ORIGIN_ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(submit, /v_can_moderate boolean := false/i);
  assert.match(submit, /v_can_moderate := security_private\.has_admin_permission_v1\('zagulyaky\.moderate'\)/i);
  assert.match(submit, /v_batch\.requested_by is distinct from v_current_user_id/i);
  assert.match(submit, /v_batch\.status <> 'completed'/i);
  assert.match(submit, /record_row\.status in \('draft', 'needs_changes'\)/i);
  assert.match(submit, /record_row\.privacy_status <> 'blocked'/i);
  assert.match(submit, /limit v_limit/i);
  assert.match(submit, /for update of record_row skip locked/i);
  assert.match(submit, /origin_row\.public_link_status = 'approved'/i);
  assert.match(submit, /if v_can_moderate and cardinality\(v_selected_record_ids\) > 0 then/i);
  assert.match(submit, /public\.admin_set_zagulyaka_tabular_facebook_origin_visibility_v1\(/i);
  assert.match(submit, /v_origin\.public_link_status <> 'approved'/i);
  assert.match(submit, /v_origin\.source_id is null/i);
  assert.match(submit, /rights_confirmed_at = now\(\)/i);
  assert.match(submit, /when v_record\.possible_living_person then 'requires_consent'/i);
  assert.match(submit, /'bulkInitialBase', true/);
  assert.match(submit, /'rightsAcknowledged', true/);
  assert.match(submit, /'publicOriginLinkAcknowledged', true/);
  assert.match(submit, /'foundLocationMissing'/);
  assert.doesNotMatch(submit, /and nullif\(btrim\(record_row\.found_location_text\), ''\) is not null/i);
  assert.match(submit, /'zagulyaky\.initial_base\.bulk_submit'/i);
});

test("bulk publishing preserves verification and cannot bypass privacy or source approval", () => {
  const publish = functionBody("security_private", "admin_bulk_publish_zagulyaky_tabular_initial_base_batch_v1");

  assert.match(publish, /has_admin_permission_v1\('zagulyaky\.moderate'\)/i);
  assert.match(publish, /p_limit is null or p_limit not between 1 and 250/i);
  assert.match(publish, /INITIAL_BASE_PUBLICATION_ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(publish, /INITIAL_BASE_NON_LIVING_PRIVACY_ACKNOWLEDGEMENT_REQUIRED/);
  assert.match(publish, /record_row\.status = 'pending_review'/i);
  assert.match(publish, /record_row\.privacy_status <> 'blocked'/i);
  assert.match(publish, /origin_row\.public_link_status = 'approved'/i);
  assert.match(publish, /origin_row\.source_id is not null/i);
  assert.match(publish, /zagulyaky_has_living_person_clearance_v1\(record_row\.id\)/i);
  assert.match(publish, /for update of record_row skip locked/i);
  assert.match(publish, /for update;/i);
  assert.match(publish, /privacy_status = 'cleared'/i);
  assert.match(publish, /status = 'published'/i);
  assert.match(publish, /'publicOriginLinkApproved', true/);
  assert.match(publish, /'zagulyaky\.initial_base\.bulk_publish'/i);
  assert.doesNotMatch(publish, /verification_status\s*=/i);
});

test("bulk summary and batch discovery expose counts only, never raw Facebook provenance", () => {
  const summary = functionBody("security_private", "zagulyaky_initial_base_bulk_summary_v1");
  const list = functionBody("security_private", "list_my_zagulyaky_initial_base_bulk_batches_v1");

  assert.match(summary, /'availableAfterAcknowledgement'/);
  assert.match(summary, /'unknownFoundLocationCount'/);
  assert.match(summary, /'privacyBlockedCount'/);
  assert.match(
    summary,
    /'availableAfterAcknowledgement', count\(\*\) filter \(\s*where status in \('draft', 'needs_changes'\)\s*and privacy_status <> 'blocked'/i,
  );
  assert.match(summary, /'livingNeedsDocumentedConsentCount'/);
  assert.match(summary, /'originNotApprovedCount'/);
  assert.doesNotMatch(summary, /facebookPostUrl|postOriginalText|sourceUrl|sourceFileName|sourceChecksum/i);
  assert.match(list, /batch_row\.requested_by = auth\.uid\(\)/i);
  assert.match(list, /batch_row\.status = 'completed'/i);
  assert.match(list, /'batchId'/);
  assert.match(list, /'recordCount'/);
  assert.doesNotMatch(list, /source_file_name|source_checksum|facebook_post_url_private/i);
});
