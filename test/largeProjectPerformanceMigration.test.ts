import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130001_large_project_dashboard_performance.sql",
    import.meta.url,
  ),
  "utf8",
);
const workRecords = readFileSync(
  new URL("../src/services/projectWorkRecords.ts", import.meta.url),
  "utf8",
);

test("large findings use cursor pagination and matching project indexes", () => {
  assert.match(workRecords, /selectRowsByCursor<FindingRow>/);
  assert.match(workRecords, /selectRowsByCursor<FindingParticipantRow>/);
  assert.doesNotMatch(
    workRecords,
    /selectRowsInParallel<FindingRow>/,
  );
  assert.match(migration, /findings_project_updated_id_idx/);
  assert.match(migration, /findings_project_id_cursor_idx/);
  assert.match(migration, /finding_participants_project_id_cursor_idx/);
});

test("Realtime keeps the compact activity stream and drops bulk source tables", () => {
  assert.match(migration, /alter publication supabase_realtime drop table/);
  assert.match(migration, /'findings'/);
  assert.match(migration, /'persons'/);
  assert.doesNotMatch(migration, /'activity_log'\s*,/);
  assert.match(migration, /replica identity default/);
});
