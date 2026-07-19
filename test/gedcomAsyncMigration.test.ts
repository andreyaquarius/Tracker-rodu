import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607190001_async_gedcom_exports.sql",
    import.meta.url,
  ),
  "utf8",
);

test("GEDCOM exports use a durable private queue and private Storage bucket", () => {
  assert.match(
    migration,
    /insert into storage\.buckets \(id, name, public, file_size_limit\)[\s\S]*?'gedcom-exports'[\s\S]*?false/i,
  );
  assert.match(
    migration,
    /create table if not exists private\.gedcom_export_jobs/i,
  );
  assert.match(
    migration,
    /check \(status in \('queued', 'processing', 'completed', 'failed', 'expired'\)\)/i,
  );
  assert.match(migration, /worker_kind text not null[\s\S]*?'edge'[\s\S]*?'github'/i);
  assert.match(migration, /checkpoint jsonb not null default '\{\}'::jsonb/i);
  assert.match(
    migration,
    /create unique index if not exists gedcom_export_jobs_active_request_uq/i,
  );
  for (const index of [
    "gedcom_export_persons_project_id_idx",
    "gedcom_export_person_names_project_id_idx",
    "gedcom_export_events_project_id_idx",
    "gedcom_export_documents_project_id_idx",
    "gedcom_export_partner_tree_id_idx",
    "gedcom_export_parent_child_tree_id_idx",
    "gedcom_export_association_tree_id_idx",
    "gedcom_export_parent_sets_tree_id_idx",
    "gedcom_export_xrefs_batch_created_id_idx",
  ]) {
    assert.match(migration, new RegExp(`create index if not exists ${index}`, "i"));
  }
  assert.match(
    migration,
    /revoke all on table private\.gedcom_export_jobs[\s\S]*?from public, anon, authenticated, service_role/i,
  );
});

test("start RPC enforces authentication, entitlement, ACL, and deletion fence", () => {
  const start = block("security_private.start_gedcom_export", "security_private.get_gedcom_export_status");
  assert.match(start, /security definer/i);
  assert.match(start, /auth\.uid\(\)/i);
  assert.match(start, /perform public\.assert_family_tree_feature_access\(\)/i);
  assert.match(start, /project\.deletion_pending/i);
  assert.match(start, /public\.can_edit_project\(target_project_id\)/i);
  assert.match(start, /tree\.id = target_tree_id[\s\S]*?tree\.project_id = target_project_id/i);
  assert.match(start, /from public\.profiles profile[\s\S]*?profile\.user_id = current_user_id/i);
  assert.match(
    start,
    /from public\.persons person[\s\S]*?person\.project_id = target_project_id/i,
  );
  assert.match(start, /case when coalesce\(current_person_count, 0\) <= 5000 then 'edge' else 'github' end/i);
  assert.match(
    start,
    /target_project_id::text \|\| '\/' \|\| current_user_id::text \|\| '\/' \|\| new_job_id::text \|\| '\/attempt-1\/family-tree\.ged'/i,
  );
  assert.match(
    migration,
    /create or replace function public\.start_gedcom_export\([\s\S]*?target_project_id uuid,[\s\S]*?target_tree_id uuid[\s\S]*?security invoker[\s\S]*?security_private\.start_gedcom_export\(\$1, \$2\)/i,
  );
});

test("status payload exposes progress, result counts, download, email, errors, and timestamps", () => {
  const payload = block(
    "security_private.gedcom_export_status_payload",
    "security_private.gedcom_export_claim_payload",
  );
  for (const key of [
    "jobId",
    "projectId",
    "treeId",
    "requestedBy",
    "requesterEmail",
    "status",
    "phase",
    "progressPercent",
    "retryable",
    "nextAttemptAt",
    "estimatedPersonCount",
    "personCount",
    "familyCount",
    "warningCount",
    "fileName",
    "fileSize",
    "storagePath",
    "downloadUrl",
    "expiresAt",
    "emailStatus",
    "emailAttempts",
    "emailNextAttemptAt",
    "emailError",
    "error",
    "createdAt",
    "updatedAt",
    "startedAt",
    "completedAt",
  ]) {
    assert.match(payload, new RegExp(`'${key}'`, "i"));
  }
  assert.match(
    payload,
    /when job\.status = 'completed'[\s\S]*?job\.expires_at > clock_timestamp\(\)[\s\S]*?then job\.download_url/i,
  );

  const status = block(
    "security_private.get_gedcom_export_status",
    "security_private.claim_gedcom_export",
  );
  assert.match(status, /current_job\.requested_by <> auth\.uid\(\)/i);
  assert.match(status, /public\.is_app_admin\(auth\.uid\(\)\)/i);
  assert.match(status, /security_private\.gedcom_export_request_authorized/i);
});

test("service worker claims one job safely and heartbeats bounded progress", () => {
  const claim = block(
    "security_private.claim_gedcom_export",
    "security_private.touch_gedcom_export",
  );
  assert.match(claim, /SERVICE_ROLE_REQUIRED/i);
  assert.match(claim, /for update skip locked/i);
  assert.doesNotMatch(claim, /target_job_id is not null or job\.worker_kind = 'edge'/i);
  assert.match(claim, /case when job\.worker_kind = 'github' then 0 else 1 end/i);
  assert.match(claim, /job\.attempts < job\.max_attempts/i);
  assert.match(claim, /interval '20 minutes'/i);
  assert.match(claim, /status = 'processing'/i);
  assert.match(claim, /attempts = job\.attempts \+ 1/i);
  assert.match(claim, /'\/attempt-' \|\| \(job\.attempts \+ 1\)::text \|\| '\/family-tree\.ged'/i);
  assert.match(claim, /security_private\.gedcom_export_request_authorized/i);

  const claimPayload = block(
    "security_private.gedcom_export_claim_payload",
    "security_private.start_gedcom_export",
  );
  for (const key of [
    "jobId",
    "projectId",
    "treeId",
    "treeTitle",
    "requestedBy",
    "requesterEmail",
    "status",
    "attempts",
  ]) {
    assert.match(claimPayload, new RegExp(`'${key}'`, "i"));
  }

  const touch = block(
    "security_private.touch_gedcom_export",
    "security_private.complete_gedcom_export",
  );
  assert.match(touch, /SERVICE_ROLE_REQUIRED/i);
  assert.match(touch, /target_progress_percent > 99/i);
  assert.match(touch, /heartbeat_at = clock_timestamp\(\)/i);
  assert.match(touch, /job\.status = 'processing'/i);
  assert.match(touch, /job\.attempts = target_attempt/i);
  assert.match(touch, /GEDCOM_EXPORT_LEASE_LOST/i);
});

test("completion retains the private file for no more than seven days and queues email", () => {
  const complete = block(
    "security_private.complete_gedcom_export",
    "security_private.fail_gedcom_export",
  );
  assert.match(complete, /SERVICE_ROLE_REQUIRED/i);
  assert.match(complete, /security_private\.gedcom_export_request_authorized/i);
  assert.match(complete, /target_storage_path is distinct from current_job\.storage_path/i);
  assert.match(complete, /current_job\.attempts <> target_attempt/i);
  assert.match(complete, /GEDCOM_EXPORT_LEASE_LOST/i);
  assert.match(complete, /target_file_size > 536870912/i);
  assert.match(
    complete,
    /safe_expires_at := least\(target_expires_at, now_at \+ interval '7 days'\)/i,
  );
  assert.match(complete, /status = 'completed'/i);
  assert.match(complete, /progress_percent = 100/i);
  assert.match(complete, /email_status = 'pending'/i);
  assert.match(complete, /download_url = target_download_url/i);

  const emailClaim = block(
    "security_private.claim_gedcom_export_emails",
    "security_private.record_gedcom_export_email",
  );
  assert.match(emailClaim, /SERVICE_ROLE_REQUIRED/i);
  assert.match(emailClaim, /job\.status = 'completed'/i);
  assert.match(emailClaim, /job\.expires_at > now_at/i);
  assert.match(emailClaim, /job\.email_status in \('pending', 'failed'\)/i);
  assert.match(emailClaim, /job\.email_attempts < 5/i);
  assert.match(emailClaim, /security_private\.gedcom_export_request_authorized/i);
  assert.match(emailClaim, /for update skip locked/i);
  assert.match(emailClaim, /email_claimed_at = now_at/i);
  assert.match(emailClaim, /email_next_attempt_at = now_at \+ interval '20 minutes'/i);
  assert.doesNotMatch(emailClaim, /email_attempts = job\.email_attempts \+ 1/i);

  const email = block(
    "security_private.record_gedcom_export_email",
    "security_private.cleanup_expired_gedcom_exports",
  );
  assert.match(email, /SERVICE_ROLE_REQUIRED/i);
  assert.match(email, /email_status = case when target_sent then 'sent' else 'failed' end/i);
  assert.match(email, /email_attempts = job\.email_attempts \+ 1/i);
  assert.match(email, /job\.status = 'completed'/i);
  assert.match(email, /job\.email_status <> 'sent'/i);
  assert.match(email, /must never downgrade a successful send/i);
});

test("expired object cleanup is a two-phase Storage API contract", () => {
  const cleanup = block(
    "security_private.cleanup_expired_gedcom_exports",
    "security_private.finalize_gedcom_export_cleanup",
  );
  assert.match(cleanup, /SERVICE_ROLE_REQUIRED/i);
  assert.match(cleanup, /job\.expires_at <= now_at/i);
  assert.match(cleanup, /security_private\.gedcom_export_request_authorized/i);
  assert.match(cleanup, /for update skip locked/i);
  assert.match(cleanup, /'storageBucket', claimed\.storage_bucket/i);
  assert.match(cleanup, /'storagePath', claimed\.storage_path/i);
  assert.match(cleanup, /cleanup_status = 'claimed'/i);
  assert.match(cleanup, /download_url = null/i);
  assert.doesNotMatch(cleanup, /delete\s+from\s+storage\.objects/i);

  const finalize = block(
    "security_private.finalize_gedcom_export_cleanup",
    "-- Elevated implementations",
  );
  assert.match(finalize, /target_removed/i);
  assert.match(finalize, /cleanup_status = case when target_removed then 'completed' else 'pending' end/i);
  assert.match(finalize, /storage_path = case when target_removed then null/i);
  assert.match(finalize, /cleanup_next_attempt_at/i);
});

test("all exposed APIs are invoker facades and worker mutations remain service-only", () => {
  for (const name of [
    "start_gedcom_export",
    "get_gedcom_export_status",
    "claim_gedcom_export",
    "touch_gedcom_export",
    "complete_gedcom_export",
    "fail_gedcom_export",
    "claim_gedcom_export_emails",
    "record_gedcom_export_email",
    "cleanup_expired_gedcom_exports",
    "finalize_gedcom_export_cleanup",
  ]) {
    const publicStart = migration.indexOf(`create or replace function public.${name}`);
    assert.ok(publicStart >= 0, `missing public ${name} facade`);
    const publicEnd = migration.indexOf("$wrapper$;", publicStart);
    const facade = migration.slice(publicStart, publicEnd);
    assert.match(facade, /security invoker/i);
    assert.doesNotMatch(facade, /security definer/i);
    assert.match(facade, new RegExp(`security_private\\.${name}\\(`, "i"));
  }

  assert.match(
    migration,
    /grant execute on function[\s\S]*?public\.start_gedcom_export\(uuid, uuid\),[\s\S]*?public\.get_gedcom_export_status\(uuid\)[\s\S]*?to authenticated/i,
  );
  const authenticatedGrantBodies = [
    ...migration.matchAll(/grant execute on function([^;]*?)to authenticated;/gi),
  ]
    .map((match) => match[1])
    .join("\n");
  assert.doesNotMatch(authenticatedGrantBodies, /public\.claim_gedcom_export\(uuid\)/i);
  assert.match(
    migration,
    /public\.claim_gedcom_export\(uuid\),[\s\S]*?public\.complete_gedcom_export[\s\S]*?public\.claim_gedcom_export_emails[\s\S]*?public\.record_gedcom_export_email[\s\S]*?to service_role/i,
  );
});

function block(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker ${endMarker}`);
  return migration.slice(start, end);
}
