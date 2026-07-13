import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync(
  new URL("../supabase/functions/process-project-deletions/index.ts", import.meta.url),
  "utf8",
);
const config = readFileSync(
  new URL("../supabase/config.toml", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/project-deletions.yml", import.meta.url),
  "utf8",
);

test("project deletion worker authenticates browser jobs before service-role work", () => {
  assert.match(worker, /auth\.getUser\(accessToken\)/);
  assert.match(worker, /rpc\("get_project_deletion_status",\s*\{\s*target_job_id: targetJobId/);
  assert.match(worker, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(worker, /createClient\(supabaseUrl, serviceRoleKey/);
  assert.match(worker, /Project deletion access denied/);
});

test("project deletion worker uses constant-time cron auth and returns accepted work", () => {
  assert.match(worker, /TASK_REMINDER_CRON_SECRET/);
  assert.match(worker, /function safeEqual/);
  assert.match(worker, /EdgeRuntime\.waitUntil/);
  assert.match(worker, /runDeletionWorker\(supabaseUrl, serviceRoleKey, targetJobId\)/);
  assert.match(worker, /202/);
  assert.match(config, /\[functions\.process-project-deletions\][\s\S]*?verify_jwt\s*=\s*false/);
});

test("project deletion worker processes durable jobs with adaptive bounded batches", () => {
  assert.match(worker, /process_next_project_deletion/);
  assert.match(worker, /process_project_deletion/);
  assert.match(worker, /INITIAL_DATABASE_BATCH_SIZE\s*=\s*250/);
  assert.match(worker, /MIN_DATABASE_BATCH_SIZE\s*=\s*10/);
  assert.match(worker, /isTransientDatabaseError/);
  assert.match(worker, /Math\.floor\(databaseBatchSize\s*\/\s*2\)/);
  assert.match(worker, /retryDelay\(transientAttempt\)/);
  assert.match(worker, /WORKER_BUDGET_MS\s*=\s*85_000/);
});

test("project deletion worker removes only project-prefixed Supabase Storage objects", () => {
  assert.match(worker, /"project-backups",\s*"project-attachments"/);
  assert.match(worker, /\.list\(directory,\s*\{/);
  assert.match(worker, /offset,\s*sortBy/);
  assert.match(worker, /\.remove\(files\.slice/);
  assert.match(worker, /mark_project_deletion_storage_cleaned/);
  assert.match(worker, /Google Drive[\s\S]*never touched/i);
});

test("project deletion cron runs every five minutes with one worker and the existing secret", () => {
  assert.match(workflow, /cron:\s*"\*\/5 \* \* \* \*"/);
  assert.match(workflow, /group:\s*project-deletion-worker/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /secrets\.TASK_REMINDER_CRON_SECRET/);
  assert.match(workflow, /functions\/v1\/process-project-deletions/);
});
