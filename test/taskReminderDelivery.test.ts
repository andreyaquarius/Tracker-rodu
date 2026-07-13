import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130007_task_reminder_delivery.sql",
    import.meta.url,
  ),
  "utf8",
);
const edgeFunction = readFileSync(
  new URL("../supabase/functions/send-task-reminders/index.ts", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/task-reminders.yml", import.meta.url),
  "utf8",
);
const deployWorkflow = readFileSync(
  new URL("../.github/workflows/deploy-supabase-functions.yml", import.meta.url),
  "utf8",
);
const bell = readFileSync(
  new URL("../src/components/AnnouncementBell.tsx", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/taskNotificationService.ts", import.meta.url),
  "utf8",
);

test("task notifications are private per-user records", () => {
  assert.match(migration, /alter table public\.task_notifications enable row level security/i);
  assert.match(migration, /user_id = \(select auth\.uid\(\)\)/i);
  assert.match(migration, /public\.is_project_member\(project_id\)/i);
  assert.match(migration, /membership\.user_id = task\.created_by/i);
  assert.match(migration, /grant update \(read_at\).*to authenticated/is);
  assert.doesNotMatch(migration, /grant\s+(?:all|insert|delete).*to authenticated/i);
});

test("due reminders are claimed once and email retries are token-protected", () => {
  assert.match(migration, /unique \(task_id, user_id, scheduled_for\)/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /reminder_sent_at is null/i);
  assert.match(migration, /email_attempts < 3/i);
  assert.match(migration, /email_claim_token = gen_random_uuid\(\)/i);
  assert.match(migration, /notification\.email_claim_token = target_claim_token/i);
  assert.match(migration, /when excluded\.email_enabled and not existing_notification\.email_enabled/i);
  assert.match(migration, /revoke execute.*from public, anon, authenticated/is);
  assert.match(migration, /grant execute.*to service_role/is);
});

test("task reminder Edge Function requires a cron secret and completes every claim", () => {
  assert.match(edgeFunction, /TASK_REMINDER_CRON_SECRET/);
  assert.match(edgeFunction, /safeEqual\(cronSecret, providedSecret\)/);
  assert.match(edgeFunction, /claim_due_task_reminders/);
  assert.match(edgeFunction, /complete_task_reminder_delivery/);
  assert.match(edgeFunction, /RESEND_API_KEY/);
  assert.match(edgeFunction, /Idempotency-Key/);
  assert.match(edgeFunction, /slice\(offset, offset \+ 5\)/);
  assert.match(edgeFunction, /formattedCalendarDate\(reminder\.task_deadline\)/);
  assert.match(edgeFunction, /day:\s*"2-digit"[\s\S]*month:\s*"2-digit"[\s\S]*year:\s*"numeric"/);
});

test("scheduled workflow invokes reminders every five minutes", () => {
  assert.match(workflow, /cron:\s*"\*\/5 \* \* \* \*"/);
  assert.match(workflow, /TASK_REMINDER_CRON_SECRET/);
  assert.match(workflow, /send-task-reminders/);
  assert.match(workflow, /--fail-with-body/);
  assert.match(deployWorkflow, /TASK_REMINDER_CRON_SECRET/);
  assert.match(deployWorkflow, /supabase secrets set/);
});

test("notification bell combines announcements and task reminders", () => {
  assert.match(bell, /loadMyTaskNotifications/);
  assert.match(bell, /markTaskNotificationRead/);
  assert.match(bell, /taskNotifications\.filter\(\(item\) => !item\.isRead\)/);
  assert.match(bell, /Нагадування про завдання/);
  assert.match(service, /\.from\("task_notifications"\)/);
  assert.match(service, /Math\.min\(100, Math\.max\(1/);
});
