import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130003_dashboard_concurrency_indexes.sql",
    import.meta.url,
  ),
  "utf8",
);

test("dashboard concurrency migration indexes every status counter", () => {
  assert.match(migration, /documents\s*\(project_id, review_status\)/);
  assert.match(migration, /tasks\s*\(project_id, status, updated_at desc\)/);
  assert.match(migration, /hypotheses\s*\(project_id, status\)/);
  assert.match(migration, /year_matrix\s*\(project_id, status\)/);
});
