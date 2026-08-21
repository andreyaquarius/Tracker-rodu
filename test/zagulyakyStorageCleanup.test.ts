import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190002_zagulyaky_storage_cleanup.sql", import.meta.url),
  "utf8",
);
const worker = readFileSync(
  new URL("../supabase/functions/zagulyaky-storage-cleanup/index.ts", import.meta.url),
  "utf8",
);
const attachmentWorker = readFileSync(
  new URL("../supabase/functions/zagulyaka-attachment/index.ts", import.meta.url),
  "utf8",
);
const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const schedule = readFileSync(
  new URL("../.github/workflows/zagulyaky-storage-cleanup.yml", import.meta.url),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing section start: ${startMarker}`);
  assert.ok(end > start, `missing section end: ${endMarker}`);
  return migration.slice(start, end);
}

function generationScopedPath(recordId: string, attachmentId: string, generation: string): string {
  return `catalogue/${recordId}/${attachmentId}/${generation}/attachment.pdf`;
}

test("Zagulyaky cleanup outbox survives a cascade and keeps durable retry state", () => {
  assert.match(migration, /create table if not exists public\.zagulyaky_storage_cleanup_queue/i);
  assert.match(migration, /record_id uuid not null,/i);
  assert.match(migration, /source_attachment_id uuid,/i);
  assert.match(migration, /owner_id uuid not null,/i);
  assert.match(
    migration,
    /storage_bucket text not null check \(storage_bucket in \('zagulyaky-private', 'zagulyaky-public'\)\)/i,
  );
  assert.match(migration, /storage_bucket = 'zagulyaky-private'[\s\S]*?owner_id::text/i);
  assert.match(migration, /storage_bucket = 'zagulyaky-public'[\s\S]*?catalogue\//i);
  assert.match(migration, /status text not null default 'queued'\s+check \(status in \('queued', 'processing', 'retry', 'completed', 'failed'\)\)/i);
  assert.match(migration, /attempt_count integer not null default 0/i);
  assert.match(migration, /claim_token uuid,/i);
  assert.match(migration, /lease_expires_at timestamptz,/i);
  assert.match(migration, /last_result_claim_token uuid,/i);
  assert.match(migration, /failed_at timestamptz,/i);
  assert.match(migration, /unique \(storage_bucket, storage_path\)/i);
  assert.doesNotMatch(
    migration,
    /record_id uuid not null references public\.zagulyaky_records/i,
    "the outbox must not cascade away with the record it cleans up",
  );
});

test("private draft and individual attachment deletes enqueue before metadata is lost", () => {
  const draftV3 = section(
    "create or replace function public.delete_my_zagulyaka_draft_v3",
    "create or replace function public.delete_my_zagulyaka_attachment_v2",
  );
  const draftEnqueueAt = draftV3.indexOf("perform security_private.enqueue_zagulyaky_storage_cleanup_v1(");
  const draftDeleteAt = draftV3.indexOf("delete from public.zagulyaky_records where id = existing.id;");
  assert.ok(draftEnqueueAt >= 0 && draftDeleteAt > draftEnqueueAt, "draft queue write precedes cascade delete");
  assert.match(draftV3, /'action', 'process_mine',\s*'queuedTaskCount', queued_task_count/i);
  assert.doesNotMatch(draftV3, /privateObjects|storagePath|storageBucket/i);

  const attachmentV2 = section(
    "create or replace function public.delete_my_zagulyaka_attachment_v2",
    "create or replace function security_private.admin_prepare_zagulyaka_attachment_publication_v2",
  );
  const attachmentEnqueueAt = attachmentV2.indexOf("security_private.enqueue_zagulyaky_storage_cleanup_v1(");
  const attachmentDeleteAt = attachmentV2.indexOf("delete from public.zagulyaky_attachments where id = removed_attachment.id;");
  assert.ok(attachmentEnqueueAt >= 0 && attachmentDeleteAt > attachmentEnqueueAt, "attachment queue write precedes delete");
  assert.match(attachmentV2, /'action', 'process_mine',\s*'taskId', cleanup_task ->> 'taskId'/i);
  assert.doesNotMatch(attachmentV2, /storagePath|storageBucket/i);
  for (const legacyDeleteSignature of [
    "delete_my_zagulyaka_draft_v1\\(uuid,integer\\)",
    "delete_my_zagulyaka_draft_v2\\(uuid,integer\\)",
    "delete_my_zagulyaka_attachment_v1\\(uuid,uuid,integer\\)",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${legacyDeleteSignature}\\s+from public, anon, authenticated, service_role;`,
        "i",
      ),
      "legacy deletion must not bypass the durable outbox",
    );
  }
});

test("public derivative revocation is durable and immutable generations defeat a stale lease-expired worker", () => {
  const prepareV2 = section(
    "create or replace function security_private.admin_prepare_zagulyaka_attachment_publication_v2",
    "create or replace function security_private.admin_complete_zagulyaka_attachment_publication_v2",
  );
  const completeV2 = section(
    "create or replace function security_private.admin_complete_zagulyaka_attachment_publication_v2",
    "create or replace function security_private.admin_revoke_zagulyaka_attachment_publication_v2",
  );
  const revokeV2 = section(
    "create or replace function security_private.admin_revoke_zagulyaka_attachment_publication_v2",
    "create or replace function public.admin_prepare_zagulyaka_attachment_publication_v2",
  );

  for (const protectedPublicationStep of [prepareV2, completeV2]) {
    assert.match(protectedPublicationStep, /storage_bucket = 'zagulyaky-public'/i);
    assert.match(protectedPublicationStep, /status in \('queued', 'retry', 'processing'\)/i);
    assert.match(protectedPublicationStep, /PUBLIC_ATTACHMENT_CLEANUP_PENDING/i);
  }
  const revokeEnqueueAt = revokeV2.indexOf("security_private.enqueue_zagulyaky_storage_cleanup_v1(");
  const revokeMetadataClearAt = revokeV2.indexOf("set public_bucket = null,");
  assert.ok(revokeEnqueueAt >= 0 && revokeMetadataClearAt > revokeEnqueueAt, "public task is durable before metadata clear");
  assert.match(revokeV2, /'alreadyRevoked', true/i);
  assert.match(revokeV2, /source_attachment_id = attachment\.id/i);
  assert.match(migration, /add column if not exists public_derivative_generation uuid/i);
  assert.match(migration, /create or replace function security_private\.zagulyaky_public_attachment_path_v2/i);
  assert.match(prepareV2, /set public_derivative_generation = gen_random_uuid\(\)/i);
  assert.match(prepareV2, /zagulyaky_public_attachment_path_v2\(/i);
  assert.match(completeV2, /PUBLIC_ATTACHMENT_PREPARATION_REQUIRED/i);
  assert.match(revokeV2, /public_derivative_generation = null/i);
  assert.doesNotMatch(
    migration,
    /select a, r into attachment, target_record/i,
    "PL/pgSQL composite variables must be populated with separate queries",
  );

  // A claims task A can outlive its lease. Worker B may finish A's old
  // cleanup, then an admin publishes again. A's eventual physical delete has
  // the old immutable path and therefore cannot delete generation B.
  const recordId = "11111111-1111-4111-8111-111111111111";
  const attachmentId = "22222222-2222-4222-8222-222222222222";
  const oldGeneration = "33333333-3333-4333-8333-333333333333";
  const newGeneration = "44444444-4444-4444-8444-444444444444";
  const staleWorkerARemove = generationScopedPath(recordId, attachmentId, oldGeneration);
  const republishedGenerationB = generationScopedPath(recordId, attachmentId, newGeneration);
  assert.notEqual(staleWorkerARemove, republishedGenerationB);
  for (const legacyRpc of [
    "admin_prepare_zagulyaka_attachment_publication_v1\\(uuid\\)",
    "admin_complete_zagulyaka_attachment_publication_v1\\(uuid,text\\)",
    "admin_revoke_zagulyaka_attachment_publication_v1\\(uuid\\)",
  ]) {
    assert.match(
      migration,
      new RegExp(`revoke all on function public\\.${legacyRpc}\\s+from public, anon, authenticated, service_role;`, "i"),
    );
  }
});

test("cleanup RPCs are isolated, leased, terminally cap retries, and keep the enqueue helper private", () => {
  assert.match(migration, /task\.owner_id = current_user_id/i);
  assert.match(migration, /task\.storage_bucket = 'zagulyaky-private'/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /lease_expires_at = now_at \+ interval '10 minutes'/i);
  assert.match(migration, /task\.status = 'processing' and task\.lease_expires_at <= now_at/i);
  assert.match(migration, /if coalesce\(auth\.role\(\), ''\) <> 'service_role' then/i);
  assert.match(migration, /ZAGULYAKY_STORAGE_CLEANUP_TASK_NOT_CLAIMED/i);
  assert.match(migration, /ZAGULYAKY_STORAGE_DELETE_FAILED/i);
  assert.match(migration, /when task\.attempt_count <= 1 then 30/i);
  assert.match(migration, /when task\.attempt_count = 6 then 960/i);
  assert.match(migration, /status = 'completed'/i);
  assert.match(migration, /status = 'retry'/i);
  assert.match(migration, /set status = 'failed'/i);
  assert.match(migration, /ZAGULYAKY_STORAGE_CLEANUP_ATTEMPTS_EXHAUSTED/i);
  assert.match(migration, /task\.attempt_count < 1000/i);
  assert.match(migration, /'exhaustedCount', exhausted_count/i);
  assert.match(migration, /idempotent', true/i);
  assert.match(
    migration,
    /revoke all on function security_private\.enqueue_zagulyaky_storage_cleanup_v1\(uuid,uuid,uuid,text,text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function security_private\.enqueue_zagulyaky_storage_cleanup_v1/i,
    "only trusted definer mutation functions may enqueue physical Storage work",
  );
  assert.match(migration, /grant execute on function public\.claim_my_zagulyaky_storage_cleanup_v1\(integer\)\s+to authenticated;/i);
  assert.match(migration, /grant execute on function public\.claim_zagulyaky_storage_cleanup_queue_v1\(integer\)\s+to service_role;/i);
  assert.match(migration, /grant execute on function public\.claim_zagulyaky_storage_cleanup_task_v1\(uuid\)\s+to service_role;/i);
  assert.match(migration, /grant execute on function public\.finalize_zagulyaky_storage_cleanup_v1\(uuid,uuid,boolean,text\)\s+to service_role;/i);
});

test("Edge worker uses v2 publication flow, recovers generation-scoped upload ambiguity, and never browser-deletes", () => {
  assert.match(worker, /"process_mine"\s*\|\s*"process_queue"\s*\|\s*"publish_derivative"\s*\|\s*"revoke_derivative"/);
  assert.match(worker, /userClient\.auth\.getUser\(accessToken\)/);
  assert.match(worker, /userClient\.rpc\("claim_my_zagulyaky_storage_cleanup_v1"/);
  assert.match(worker, /adminClient\.rpc\("claim_zagulyaky_storage_cleanup_queue_v1"/);
  assert.match(worker, /adminClient\.rpc\(\s*"claim_zagulyaky_storage_cleanup_task_v1"/);
  assert.match(worker, /adminClient\.storage\.from\(task\.storageBucket\)\.remove\(\[task\.storagePath\]\)/);
  assert.match(worker, /adminClient\.rpc\("finalize_zagulyaky_storage_cleanup_v1"/);
  assert.match(worker, /admin_prepare_zagulyaka_attachment_publication_v2/);
  assert.match(worker, /admin_complete_zagulyaka_attachment_publication_v2/);
  assert.match(worker, /admin_revoke_zagulyaka_attachment_publication_v2/);
  assert.doesNotMatch(worker, /admin_(?:prepare|complete|revoke)_zagulyaka_attachment_publication_v1/);
  assert.match(worker, /upsert: false/);
  assert.match(worker, /const rechecked = await preparePublication/);
  assert.match(worker, /const authoritative = await preparePublication/);
  assert.doesNotMatch(worker, /userClient\.storage\./);
  assert.doesNotMatch(worker, /remove\(\[prepared\.publicPath\]\)/);
  assert.match(worker, /ZAGULYAKY_STORAGE_CLEANUP_SECRET/);
  assert.match(worker, /TASK_REMINDER_CRON_SECRET/);
  assert.match(worker, /function workerSecrets\(\): string\[\]/);
  assert.match(worker, /for \(const allowedSecret of allowedSecrets\)/);
  assert.match(worker, /constantTimeEqual\(supplied, allowedSecret\)/);
  assert.match(worker, /hasWorkerAuthorization\(request, workerSecrets\(\)\)/);
  assert.match(worker, /function isExpectedCleanupPath/);
  assert.match(worker, /segments\[0\] === "catalogue"/);
  assert.match(worker, /function exhaustedCount/);
  assert.match(worker, /failed: outcome\.failed/);
});

test("the live attachment Edge route uses v2/outbox operations and a service-only delivery lookup", () => {
  assert.match(attachmentWorker, /adminClient\.rpc\("service_get_public_zagulyaka_attachment_delivery_v1"/);
  assert.doesNotMatch(attachmentWorker, /rpc\("get_public_zagulyaka_attachment_delivery_v1"/);
  for (const rpc of [
    "admin_prepare_zagulyaka_attachment_publication_v2",
    "admin_complete_zagulyaka_attachment_publication_v2",
    "admin_revoke_zagulyaka_attachment_publication_v2",
  ]) {
    assert.match(attachmentWorker, new RegExp(rpc));
  }
  assert.doesNotMatch(attachmentWorker, /admin_(?:prepare|complete|revoke)_zagulyaka_attachment_publication_v1/);
  assert.match(attachmentWorker, /claim_zagulyaky_storage_cleanup_task_v1/);
  assert.match(attachmentWorker, /finalize_zagulyaky_storage_cleanup_v1/);
  assert.match(attachmentWorker, /targetExists/);
  assert.match(attachmentWorker, /const rechecked = await preparePublication/);
  assert.match(attachmentWorker, /const authoritative = await preparePublication/);
  assert.doesNotMatch(attachmentWorker, /remove\(\[preparation\.publicPath\]\)/);
});

test("the cleanup function and scheduled worker have a real service-only wake path", () => {
  assert.match(
    config,
    /\[functions\.zagulyaky-storage-cleanup\][\s\S]*?verify_jwt = false/,
  );
  assert.match(schedule, /name: Process Zagulyaky storage cleanup/);
  assert.match(schedule, /cron: "\*\/5 \* \* \* \*"/);
  assert.match(schedule, /TASK_REMINDER_CRON_SECRET/);
  assert.match(schedule, /Authorization: Bearer \$CRON_SECRET/);
  assert.match(schedule, /--data '\{"action":"process_queue","limit":50\}'/);
  assert.match(schedule, /zagulyaky-storage-cleanup/);
});
