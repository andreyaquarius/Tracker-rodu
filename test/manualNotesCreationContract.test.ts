import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const migrationSource = readFileSync(
  resolve(process.cwd(), "supabase/migrations/202608250003_manual_notes_creation.sql"),
  "utf8",
);
const serviceSource = readFileSync(
  resolve(process.cwd(), "src/services/telegramInboxService.ts"),
  "utf8",
);
const typesSource = readFileSync(
  resolve(process.cwd(), "src/types/telegramInbox.ts"),
  "utf8",
);

test("manual notes use the same private note fields as Telegram notes", () => {
  assert.match(migrationSource, /create or replace function security_private\.create_my_telegram_note_v1\(/);
  assert.match(migrationSource, /current_user_id uuid := auth\.uid\(\)/);
  assert.match(migrationSource, /insert into public\.telegram_saved_notes \(/);
  assert.match(migrationSource, /owner_id,\s*intake_id,\s*title,\s*body_text,\s*source_url,\s*source_platform,\s*source_label,\s*source_metadata,\s*status,\s*source_status,\s*priority/s);
  assert.match(migrationSource, /values \(\s*current_user_id,\s*null,/s, "A manual note must not require a Telegram intake");
  assert.match(migrationSource, /source_label,\s*source_metadata[\s\S]*?null,\s*'\{\}'::jsonb/s, "A manual note must not forge Telegram provenance");
  assert.match(migrationSource, /create or replace function public\.create_my_telegram_note_v1\(/);
  assert.match(migrationSource, /grant execute on function public\.create_my_telegram_note_v1\([^)]*\)\s+to authenticated, service_role/i);
});

test("manual note client API validates source URLs and returns the shared note shape", () => {
  assert.match(typesSource, /export interface CreateTelegramNoteInput/);
  assert.match(serviceSource, /export async function createTelegramNote\(/);
  assert.match(serviceSource, /client\.rpc\("create_my_telegram_note_v1"/);
  assert.match(serviceSource, /p_source_url: sourceUrl/);
  assert.match(serviceSource, /safeHttpSourceUrl\(input\.sourceUrl\)/);
  assert.match(serviceSource, /return mapTelegramNote\(firstRecord\(data\)\)/);
});
