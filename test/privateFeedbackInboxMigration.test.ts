import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608130004_private_feedback_inbox.sql", import.meta.url),
  "utf8",
);

test("feedback tables enforce author-or-admin privacy with RLS", () => {
  assert.match(migration, /alter table public\.feedback_threads enable row level security/);
  assert.match(migration, /alter table public\.feedback_messages enable row level security/);
  assert.match(migration, /author_id = \(select auth\.uid\(\)\)/);
  assert.match(migration, /public\.is_app_admin\(\(select auth\.uid\(\)\)\)/);
  assert.match(migration, /thread\.author_id = current_user_id or public\.is_app_admin\(current_user_id\)/);
});

test("feedback rows cannot be written directly by authenticated clients", () => {
  assert.match(migration, /revoke all on public\.feedback_threads from public, anon, authenticated/);
  assert.match(migration, /revoke all on public\.feedback_messages from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.feedback_threads to authenticated/);
  assert.match(migration, /grant select on public\.feedback_messages to authenticated/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[^;]*to authenticated/i);
});

test("feedback RPC derives identity and role on the server", () => {
  assert.match(migration, /current_user_id uuid := auth\.uid\(\)/);
  assert.match(migration, /author_id, author_name, author_email/);
  assert.match(migration, /current_user_id, coalesce\(current_name/);
  assert.match(migration, /if target_thread\.author_id = current_user_id then\s+next_role := 'user'/s);
  assert.match(migration, /elsif public\.is_app_admin\(current_user_id\) then\s+next_role := 'admin'/s);
  assert.doesNotMatch(migration, /p_(?:author|sender|role)/);
});

test("feedback API exposes invoker facades and bounded posting", () => {
  for (const rpc of [
    "list_feedback_threads",
    "list_feedback_messages",
    "create_feedback_thread",
    "post_feedback_message",
    "mark_feedback_thread_read",
    "set_feedback_thread_status",
    "get_feedback_unread_count",
  ]) {
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${rpc}\\([\\s\\S]*?security invoker`),
    );
  }
  assert.match(migration, /FEEDBACK_THREAD_RATE_LIMIT/);
  assert.match(migration, /FEEDBACK_MESSAGE_RATE_LIMIT/);
  assert.match(migration, /char_length\(normalized_body\) not between 1 and 5000/);
});
