import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608200001_zagulyaky_structuring_recovery.sql", import.meta.url),
  "utf8",
);
const attemptGuard = readFileSync(
  new URL("../supabase/migrations/202608200002_zagulyaky_structuring_recovery_attempt_guard.sql", import.meta.url),
  "utf8",
);
const accountRecovery = readFileSync(
  new URL("../supabase/migrations/202608200003_zagulyaky_structuring_account_recovery.sql", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/zagulyakyStructuringService.ts", import.meta.url),
  "utf8",
);
const panel = readFileSync(
  new URL("../src/components/admin/ZagulyakyStructuringPanel.tsx", import.meta.url),
  "utf8",
);

test("structuring recovery is explicit, bounded, audited, and preserves attempts", () => {
  assert.match(migration, /p_explicit_confirmation boolean default false/);
  assert.match(migration, /STRUCTURING_RETRY_CONFIRMATION_REQUIRED/);
  assert.match(migration, /p_limit not between 1 and 100/);
  assert.match(migration, /task\.status = 'failed'/);
  assert.match(migration, /last_error_code in \(/);
  assert.match(migration, /set status = 'retry'/);
  assert.match(migration, /'attemptCountsPreserved', true/);
  assert.doesNotMatch(migration, /attempt_count\s*=\s*0/);
  assert.match(migration, /zagulyaky\.structuring\.retry_failed_tasks/);
  assert.match(migration, /from public, anon/);
  assert.match(migration, /to authenticated, service_role/);
  assert.match(attemptGuard, /task\.attempt_count < task\.max_attempts/);
  assert.match(attemptGuard, /'exhaustedTasksExcluded', true/);
  assert.doesNotMatch(attemptGuard, /attempt_count\s*=\s*0/);
  assert.match(accountRecovery, /STRUCTURE_GEMINI_ACCOUNT_PRECONDITION/);
  assert.match(accountRecovery, /task\.attempt_count < task\.max_attempts/);
  assert.match(accountRecovery, /'attemptCountsPreserved', true/);
  assert.doesNotMatch(accountRecovery, /attempt_count\s*=\s*0/);
});

test("the browser requires explicit recovery and pauses new text transfers when tasks fail", () => {
  assert.match(service, /retryFailedZagulyakyStructuringTasks/);
  assert.match(service, /p_explicit_confirmation: true/);
  assert.match(panel, /run\.failedCount === 0/);
  assert.match(panel, /retryConfirmed/);
  assert.match(panel, /не надсилає допис до Google/u);
});
