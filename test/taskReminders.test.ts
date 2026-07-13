import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  normalizeTaskReminderFields,
  normalizeTaskReminderTimestamp,
  taskReminderDateTimeLocalValue,
  taskReminderValidationError,
} from "../src/utils/taskReminders.ts";

const migration = readFileSync(
  new URL("../supabase/migrations/202607130006_task_reminders.sql", import.meta.url),
  "utf8",
);
const workRecordService = readFileSync(
  new URL("../src/services/projectWorkRecords.ts", import.meta.url),
  "utf8",
);
const entityConfig = readFileSync(
  new URL("../src/pages/entityConfigs.ts", import.meta.url),
  "utf8",
);
const tableImporter = readFileSync(
  new URL("../src/utils/tableDataImport.ts", import.meta.url),
  "utf8",
);
const databaseNormalizer = readFileSync(
  new URL("../src/utils/database.ts", import.meta.url),
  "utf8",
);

test("task reminder timestamps are stored as UTC and rendered for datetime-local inputs", () => {
  const source = "2026-07-20T15:30:00.000Z";
  assert.equal(normalizeTaskReminderTimestamp(source), source);
  assert.equal(normalizeTaskReminderTimestamp("not-a-date"), "");
  assert.equal(normalizeTaskReminderTimestamp(undefined), "");

  const local = taskReminderDateTimeLocalValue(source);
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(
    new Date(normalizeTaskReminderTimestamp(local)).getTime(),
    new Date(source).getTime(),
  );
});

test("old tasks receive safe disabled reminder defaults", () => {
  assert.deepEqual(normalizeTaskReminderFields({}), {
    reminderAt: "",
    reminderInApp: false,
    reminderEmail: false,
    reminderSentAt: "",
  });
  assert.deepEqual(normalizeTaskReminderFields({
    reminderAt: "invalid",
    reminderInApp: true,
    reminderEmail: true,
    reminderSentAt: "2026-07-20T15:31:00Z",
  }), {
    reminderAt: "",
    reminderInApp: false,
    reminderEmail: false,
    reminderSentAt: "",
  });
});

test("task reminder form requires a time and at least one delivery channel", () => {
  assert.equal(taskReminderValidationError({}), "");
  assert.match(taskReminderValidationError({ reminderInApp: true }), /дату і час/);
  assert.match(taskReminderValidationError({ reminderAt: "2026-07-20T15:30" }), /спосіб/);
  assert.match(taskReminderValidationError({ reminderAt: "invalid", reminderEmail: true }), /коректні/);
  assert.equal(taskReminderValidationError({
    reminderAt: "2026-07-20T15:30",
    reminderInApp: true,
  }), "");
});

test("task table import maps and validates reminder fields", () => {
  assert.match(tableImporter, /field\.type === "datetime-local"\) return normalizeTaskReminderTimestamp\(value\)/);
  assert.match(tableImporter, /collection === "tasks"/);
  assert.match(tableImporter, /taskReminderValidationError\(record\)/);
  assert.match(tableImporter, /Object\.assign\(record, normalizeTaskReminderFields\(record\)\)/);
  assert.match(tableImporter, /key: "reminderSentAt"/);
  assert.match(tableImporter, /label: standardLabels\.tasks\.reminderSentAt/);
  assert.match(databaseNormalizer, /\.\.\.normalizeTaskReminderFields\(item\)/);
});

test("task reminder migration is additive, indexed and uses task creator as recipient", () => {
  assert.match(migration, /add column if not exists reminder_at timestamptz/);
  assert.match(migration, /add column if not exists reminder_in_app boolean not null default false/);
  assert.match(migration, /add column if not exists reminder_email boolean not null default false/);
  assert.match(migration, /add column if not exists reminder_sent_at timestamptz/);
  assert.match(migration, /add column if not exists reminder_claimed_at timestamptz/);
  assert.match(migration, /tasks_reminder_configuration_check/);
  assert.match(migration, /tasks_due_reminders_idx/);
  assert.match(migration, /reset_task_reminder_delivery_state/);
  assert.match(migration, /recipient is tasks\.created_by/i);
});

test("task persistence selects and upserts reminder state without exposing claims", () => {
  for (const column of [
    "reminder_at",
    "reminder_in_app",
    "reminder_email",
    "reminder_sent_at",
  ]) {
    assert.match(workRecordService, new RegExp(column));
  }
  assert.doesNotMatch(workRecordService, /reminder_claimed_at/);
  assert.match(workRecordService, /includeDeliveryState = false/);
  assert.match(workRecordService, /taskToRow\(projectId, task, researchIds, documentIds, true\)/);
  assert.match(workRecordService, /includeDeliveryState\s*\? \{ \.\.\.row, reminder_sent_at:/);
  assert.match(entityConfig, /key: "reminderAt"[^\n]+type: "datetime-local"/);
  assert.match(entityConfig, /key: "reminderInApp"[^\n]+type: "checkbox"/);
  assert.match(entityConfig, /key: "reminderEmail"[^\n]+type: "checkbox"/);
  assert.doesNotMatch(entityConfig, /key: "reminderSentAt"/);
});
