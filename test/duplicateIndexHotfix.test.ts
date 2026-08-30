import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608300004_duplicate_index_hotfix.sql",
    import.meta.url,
  ),
  "utf8",
);

const dashboardIndexes = readFileSync(
  new URL(
    "../supabase/migrations/202607130003_dashboard_concurrency_indexes.sql",
    import.meta.url,
  ),
  "utf8",
);

const notificationIndexes = readFileSync(
  new URL(
    "../supabase/migrations/202607130007_task_reminder_delivery.sql",
    import.meta.url,
  ),
  "utf8",
);

test("duplicate-index hotfix retains the canonical indexes from migration history", () => {
  assert.match(
    dashboardIndexes,
    /create index if not exists documents_project_review_status_idx\s+on public\.documents \(project_id, review_status\);/u,
  );
  assert.match(
    notificationIndexes,
    /create index if not exists task_notifications_project_idx\s+on public\.task_notifications \(project_id\);/u,
  );

  assert.match(
    migration,
    /drop index if exists public\.documents_project_status_idx;/u,
  );
  assert.match(
    migration,
    /drop index if exists public\.task_notifications_project_id_fk_idx;/u,
  );
  assert.doesNotMatch(
    migration,
    /drop index if exists public\.documents_project_review_status_idx;/u,
  );
  assert.doesNotMatch(
    migration,
    /drop index if exists public\.task_notifications_project_idx;/u,
  );
});

test("duplicate-index hotfix aborts if a production index is not an exact duplicate", () => {
  assert.match(migration, /duplicate_index\.indrelid = retained_index\.indrelid/u);
  assert.match(migration, /duplicate_class\.relam = retained_class\.relam/u);
  assert.match(migration, /duplicate_index\.indkey = retained_index\.indkey/u);
  assert.match(migration, /duplicate_index\.indclass = retained_index\.indclass/u);
  assert.match(migration, /duplicate_index\.indoption = retained_index\.indoption/u);
  assert.match(migration, /retained_index\.indisvalid/u);
  assert.match(migration, /raise exception\s+'Refusing to drop %/u);
});

test("duplicate-index hotfix contains no table, data or policy changes", () => {
  assert.equal((migration.match(/\bdrop index if exists\b/gu) ?? []).length, 2);
  assert.doesNotMatch(migration, /\b(?:create|alter|drop)\s+table\b/iu);
  assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate)\b/iu);
  assert.doesNotMatch(migration, /\b(?:create|alter|drop)\s+policy\b/iu);
  assert.doesNotMatch(migration, /\bcreate\s+(?:unique\s+)?index\b/iu);
});
