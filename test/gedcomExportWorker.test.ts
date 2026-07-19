import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edgeWorker = readFileSync(
  new URL("../supabase/functions/process-gedcom-exports/index.ts", import.meta.url),
  "utf8",
);
const processor = readFileSync(
  new URL("../supabase/functions/_shared/gedcomExportProcessor.ts", import.meta.url),
  "utf8",
);
const nodeRunner = readFileSync(
  new URL("../scripts/process-gedcom-export-jobs.ts", import.meta.url),
  "utf8",
);
const config = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
const workflow = readFileSync(
  new URL("../.github/workflows/gedcom-exports.yml", import.meta.url),
  "utf8",
);
const apiKeys = readFileSync(
  new URL("../supabase/functions/_shared/supabaseApiKeys.ts", import.meta.url),
  "utf8",
);

test("Edge GEDCOM worker authenticates targeted browser jobs before service-role work", () => {
  assert.match(edgeWorker, /auth\.getUser\(accessToken\)/);
  assert.match(edgeWorker, /get_gedcom_export_status/);
  assert.match(edgeWorker, /claim_gedcom_export/);
  assert.match(edgeWorker, /TASK_REMINDER_CRON_SECRET/);
  assert.match(edgeWorker, /SUPABASE_SECRET_KEYS/);
  assert.match(edgeWorker, /SUPABASE_PUBLISHABLE_KEYS/);
  assert.match(edgeWorker, /isTrustedServerRequest/);
  assert.match(edgeWorker, /request\.headers\.get\("apikey"\)/);
  assert.match(edgeWorker, /request\.headers\.get\("x-cron-secret"\)/);
  assert.match(edgeWorker, /safeEqual/);
  assert.match(edgeWorker, /EdgeRuntime\.waitUntil/);
  assert.match(edgeWorker, /202/);
  assert.match(config, /\[functions\.process-gedcom-exports\][\s\S]*?verify_jwt\s*=\s*false/);
  assert.match(config, /\[edge_runtime\][\s\S]*?policy\s*=\s*"per_worker"/);
});

test("Edge never claims a large or unknown queue job into the 256 MB isolate", () => {
  assert.match(edgeWorker, /EDGE_PERSON_LIMIT\s*=\s*5_000/);
  assert.match(edgeWorker, /if \(!jobId\)[\s\S]*?runCronMaintenance\(adminClient\)[\s\S]*?mode:\s*"maintenance"[\s\S]*?claimed:\s*false/);
  const sizeCheck = edgeWorker.indexOf("personCount > EDGE_PERSON_LIMIT");
  const claim = edgeWorker.lastIndexOf("claimTargetedJob(");
  assert.ok(sizeCheck >= 0 && claim > sizeCheck, "size routing must happen before claim");
  assert.match(edgeWorker, /personCount > EDGE_PERSON_LIMIT[\s\S]*?claimed:\s*false/);
});

test("trusted cron retries email delivery and finalizes expired Storage cleanup", () => {
  assert.match(edgeWorker, /claim_gedcom_export_emails/);
  assert.match(edgeWorker, /deliverPendingEmail/);
  assert.match(edgeWorker, /cleanup_expired_gedcom_exports/);
  assert.match(edgeWorker, /storage\.from\(job\.storageBucket\)\.remove\(\[job\.storagePath\]\)/);
  assert.match(edgeWorker, /finalize_gedcom_export_cleanup/);
  assert.match(edgeWorker, /target_removed:\s*removed/);
  assert.match(workflow, /Retry export emails and clean expired files/);
  assert.match(workflow, /--data '\{\}'/);
  assert.match(edgeWorker, /status\.status === "completed"[\s\S]*?deliverClaimedEmails\(adminClient\)/);
});

test("shared processor pages tree data and records a durable completed or failed result", () => {
  assert.match(processor, /GEDCOM_EXPORT_PAGE_SIZE\s*=\s*1_000/);
  assert.match(processor, /query\.range\(from, from \+ GEDCOM_EXPORT_PAGE_SIZE - 1\)/);
  assert.match(processor, /gedcom_xref_maps[\s\S]*?\.order\("created_at"[\s\S]*?\.order\("id"/);
  assert.match(processor, /client\.from\("persons"\)[\s\S]*?\.eq\("project_id", job\.projectId\)/);
  assert.match(processor, /person_timeline_events/);
  assert.match(processor, /finding_participants/);
  assert.match(processor, /client\.from\("documents"\)[\s\S]*?\.eq\("project_id", projectId\)/);
  assert.match(processor, /FINDING_SELECT[^;]*source_url/);
  assert.match(processor, /sourceUrl:\s*row\.source_url/);
  assert.match(processor, /gedcom_xref_maps/);
  assert.match(processor, /complete_gedcom_export/);
  assert.match(processor, /fail_gedcom_export/);
  assert.match(processor, /target_attempt:\s*job\.attempts/);
  assert.match(processor, /GEDCOM_EXPORT_LEASE_LOST/);
  assert.match(processor, /target_person_count:\s*projection\.nodes\.length/);
});

test("export completion closes the project-deletion race and removes orphaned uploads", () => {
  const firstGuard = processor.indexOf("await assertExportStillWritable(client, job)");
  const upload = processor.indexOf("await uploader({", firstGuard);
  const secondGuard = processor.indexOf("await assertExportStillWritable(client, job)", upload);
  const complete = processor.indexOf('client.rpc("complete_gedcom_export"', secondGuard);
  assert.ok(firstGuard >= 0 && upload > firstGuard && secondGuard > upload && complete > secondGuard);
  assert.match(processor, /select\("id, deletion_pending"\)/);
  assert.match(processor, /GEDCOM_EXPORT_PROJECT_DELETION_PENDING/);
  assert.match(processor, /if \(uploaded && !\(await exportIsCompleted/);
  assert.match(processor, /\.remove\(\[storagePath\]\)/);
});

test("private GEDCOM objects receive seven-day signed links and idempotent email", () => {
  assert.match(processor, /GEDCOM_EXPORT_BUCKET\s*=\s*"gedcom-exports"/);
  assert.match(processor, /job\.storagePath[\s\S]*?attempt-\$\{job\.attempts\}[\s\S]*?GEDCOM_EXPORT_FILE_NAME/);
  assert.match(processor, /7 \* 24 \* 60 \* 60/);
  assert.match(processor, /createSignedUrl/);
  assert.match(edgeWorker, /https:\/\/api\.resend\.com\/emails/);
  assert.match(edgeWorker, /GEDCOM_EXPORT_EMAIL_FROM[\s\S]*?INVITATION_EMAIL_FROM[\s\S]*?RESEND_FROM_EMAIL/);
  assert.match(edgeWorker, /Idempotency-Key/);
  assert.match(edgeWorker, /gedcom-export:\$\{job\.jobId\}/);
  assert.match(edgeWorker, /record_gedcom_export_email/);
  assert.match(edgeWorker, /target_sent:\s*delivered/);
  assert.match(edgeWorker, /sanitizeEmailTitle/);
  assert.match(edgeWorker, /\\u0000-\\u001f\\u007f-\\u009f/);
  assert.match(edgeWorker, /slice\(0, 160\)/);
});

test("large runner uses a 4 GB Node process and 6 MB TUS chunks", () => {
  assert.match(nodeRunner, /TUS_CHUNK_BYTES\s*=\s*6 \* 1024 \* 1024/);
  assert.match(nodeRunner, /storage\/v1\/upload\/resumable/);
  assert.match(nodeRunner, /\.storage\.supabase\.co/);
  assert.match(nodeRunner, /resolveStorageUrl/);
  assert.match(nodeRunner, /Tus-Resumable/);
  assert.match(nodeRunner, /Upload-Offset/);
  assert.match(nodeRunner, /method:\s*"HEAD"/);
  assert.match(nodeRunner, /readTusOffset/);
  assert.match(nodeRunner, /supabaseServerKeyHeaders/);
  assert.match(apiKeys, /startsWith\("sb_secret_"\)/);
  assert.match(apiKeys, /return \{ apikey: normalized \}/);
  assert.match(nodeRunner, /x-upsert/);
  assert.match(nodeRunner, /claim_gedcom_export/);
  assert.match(nodeRunner, /processClaimedGedcomExport/);
  assert.match(nodeRunner, /process-gedcom-exports/);
  assert.match(workflow, /cron:\s*"\*\/5 \* \* \* \*"/);
  assert.match(workflow, /NODE_OPTIONS:\s*--max-old-space-size=4096/);
  assert.match(workflow, /SUPABASE_SECRET_KEY:\s*\$\{\{ secrets\.SUPABASE_SECRET_KEY \}\}/);
  assert.match(workflow, /\[ -z "\$SUPABASE_SECRET_KEY" \] && \[ -z "\$SUPABASE_SERVICE_ROLE_KEY" \]/);
  assert.doesNotMatch(workflow, /VITE_SUPABASE_SECRET_KEY/);
  assert.match(nodeRunner, /SUPABASE_SECRET_KEY:[\s\S]*?SUPABASE_SERVICE_ROLE_KEY:/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /node scripts\/process-gedcom-export-jobs\.ts/);
  assert.match(workflow, /group:\s*gedcom-export-worker/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});
