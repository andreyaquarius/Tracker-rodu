import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608310001_genehelp_inbound_notifications.sql",
    import.meta.url,
  ),
  "utf8",
);

test("GeneHelp integration events use a transport-neutral private hash-only ledger", () => {
  assert.match(migration, /create table if not exists security_private\.genehelp_integration_events/u);
  assert.match(migration, /provider_event_id text primary key/u);
  assert.match(migration, /payload_sha256 text not null/u);
  assert.doesNotMatch(migration, /\b(?:raw_payload|payload_body|request_body)\b/iu);
  assert.match(migration, /GENEHELP_EVENT_ID_COLLISION/u);
});

test("GeneHelp notifications remain server-only and are exposed through private user RPCs", () => {
  assert.match(migration, /create table if not exists public\.user_genehelp_notifications/u);
  assert.match(
    migration,
    /revoke all on table public\.user_genehelp_notifications\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(migration, /using \(false\)\s+with check \(false\)/u);
  assert.match(migration, /public\.list_my_genehelp_notifications\(\s*p_limit integer default 50/iu);
  assert.match(migration, /public\.mark_genehelp_notification_read\(\s*p_notification_id uuid/iu);
  assert.match(migration, /public\.mark_all_genehelp_notifications_read\(\)/iu);
  assert.match(migration, /caller_user_id uuid := \(select auth\.uid\(\)\)/u);
});

test("service receiver has the agreed named contract and cannot trust a Tracker user id or email", () => {
  assert.match(
    migration,
    /public\.service_receive_genehelp_notification_v1\(\s*p_provider_event_id text,\s*p_event_type text,\s*p_occurred_at timestamptz,\s*p_genehelp_request_id text,\s*p_genehelp_user_id text,\s*p_status jsonb,\s*p_reply jsonb,\s*p_payload_sha256 text\s*\)/u,
  );
  assert.match(migration, /SERVICE_ROLE_REQUIRED/u);
  assert.match(
    migration,
    /grant execute on function public\.service_receive_genehelp_notification_v1\([\s\S]*?\) to service_role/iu,
  );
  assert.doesNotMatch(migration, /\bp_(?:user_id|email)\b/iu);
  assert.match(migration, /request_row\.genehelp_request_id = normalized_request_id/u);
  assert.match(migration, /account_row\.genehelp_user_id = normalized_genehelp_user_id/u);
  assert.match(migration, /if match_count <> 1 then[\s\S]*?'ambiguous'/u);
  assert.match(
    migration,
    /create index if not exists user_genehelp_requests_provider_request_idx\s+on public\.user_genehelp_requests \(genehelp_request_id\)/iu,
    "provider event matching must not scan every user's GeneHelp request",
  );
});

test("receiver is atomic, idempotent by event and reply, and rejects stale status updates", () => {
  assert.match(migration, /on conflict \(provider_event_id\) do nothing/u);
  assert.match(
    migration,
    /create unique index if not exists user_genehelp_notifications_reply_unique_idx[\s\S]*?where reply_id is not null/iu,
  );
  assert.match(migration, /outcome = 'duplicate_reply'/u);
  assert.match(
    migration,
    /request_row\.provider_updated_at is null\s+or request_row\.provider_updated_at < effective_provider_updated_at/u,
  );
  assert.match(migration, /outcome = 'stale'/u);
  assert.match(migration, /alter table public\.user_genehelp_requests\s+add column if not exists provider_updated_at timestamptz/iu);
  assert.match(
    migration,
    /alter table public\.user_genehelp_accounts\s+add column if not exists notifications_last_synced_at timestamptz/iu,
  );
  assert.match(
    migration,
    /set status = coalesce\(request_row\.status, '\{\}'::jsonb\) \|\| p_status/iu,
    "a partial notification status must preserve richer fields saved by the request-status API",
  );
  assert.doesNotMatch(migration, /set status = p_status\b/iu);
});

test("integration input and stored notification content are explicitly bounded", () => {
  assert.match(migration, /char_length\(normalized_event_id\) not between 1 and 128/u);
  assert.match(migration, /normalized_payload_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(migration, /pg_column_size\(p_status\) > 16384/u);
  assert.match(migration, /pg_column_size\(p_reply\) > 16384/u);
  assert.match(migration, /char_length\(normalized_event_type\) not between 1 and 128/u);
  assert.doesNotMatch(migration, /event_type in \(\s*'genealogy_request\./u);
  assert.match(migration, /char_length\(body\) <= 1000/u);
  assert.match(migration, /set search_path = pg_catalog, public, security_private/u);
});
