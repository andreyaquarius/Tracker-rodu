import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130012_project_deletion_stale_recovery.sql",
    import.meta.url,
  ),
  "utf8",
);

test("project deletion recovery claims queued jobs without a stale delay", () => {
  assert.match(
    migration,
    /where job\.status = 'queued'\s+or \(/i,
  );
  assert.match(
    migration,
    /case when job\.status = 'queued' then 0 else 1 end/i,
    "new queued deletions should be preferred over stale recovery work",
  );
});

test("project deletion recovery reclaims only stale running or failed jobs", () => {
  assert.match(
    migration,
    /job\.status in \('running', 'failed'\)[\s\S]*?job\.updated_at <= pg_catalog\.clock_timestamp\(\) - interval '2 minutes'/i,
  );
  assert.doesNotMatch(
    migration,
    /where job\.status in \('queued', 'running', 'failed'\)\s+order by/i,
    "live running jobs must not be claimed by the scheduled queue worker",
  );
});

test("stale recovery preserves service-only locking and bounded processing", () => {
  assert.match(
    migration,
    /SERVICE_ROLE_REQUIRED[\s\S]*?for update skip locked[\s\S]*?return public\.process_project_deletion\(next_job_id, batch_size\)/i,
  );
  assert.match(
    migration,
    /revoke execute on function public\.process_next_project_deletion\(integer\)\s+from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.process_next_project_deletion\(integer\)\s+to service_role/i,
  );
});
