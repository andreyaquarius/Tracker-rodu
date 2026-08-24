import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608240004_zagulyaky_my_records_pagination.sql", import.meta.url),
  "utf8",
);
const service = readFileSync(
  new URL("../src/services/zagulyakyService.ts", import.meta.url),
  "utf8",
);

test("private Zagulyaky pagination returns owner-only exact totals and status counters", () => {
  assert.match(migration, /create or replace function public\.get_my_zagulyaky_page_v1\(\s*p_status text default null,\s*p_limit integer default 50,\s*p_offset integer default 0/s);
  assert.match(migration, /current_user_id uuid := auth\.uid\(\)/);
  assert.match(migration, /if current_user_id is null then\s*raise exception 'AUTH_REQUIRED'/s);
  assert.match(migration, /where r\.created_by = current_user_id/);
  assert.match(migration, /if safe_limit not in \(10, 20, 50\) then/);
  assert.match(migration, /'total', \(select count\(\*\) from filtered_records\)/);
  assert.match(migration, /'overallTotal', \(select count\(\*\) from owner_records\)/);
  assert.match(migration, /'statusCounts', coalesce\(/);
  assert.match(migration, /order by r\.updated_at desc, r\.id desc/);
  assert.match(migration, /offset safe_offset/);
});

test("private Zagulyaky pagination has an explicit authenticated-only ACL", () => {
  assert.match(
    migration,
    /revoke all on function public\.get_my_zagulyaky_page_v1\(text,integer,integer\)\s+from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_my_zagulyaky_page_v1\(text,integer,integer\)\s+to authenticated, service_role;/,
  );
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.get_my_zagulyaky_page_v1\(text,integer,integer\)\s+to anon/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema';/);
});

test("client asks the paged RPC for only 10, 20, or 50 records and preserves totals", () => {
  assert.match(service, /export const ZAGULYAKY_MY_RECORDS_PAGE_SIZES = \[10, 20, 50\] as const;/);
  assert.match(service, /export async function loadMyZagulyaky\(/);
  assert.match(service, /\.rpc\("get_my_zagulyaky_page_v1", \{/);
  assert.match(service, /p_offset: \(page - 1\) \* pageSize/);
  assert.match(service, /const payload = firstRecord\(data\)/);
  assert.match(service, /overallTotal: Math\.max\(total, naturalNumber\(value\(payload, "overallTotal", "overall_total"\), total\)\)/);
  assert.match(service, /statusCounts: workflowStatusCounts\(value\(payload, "statusCounts", "status_counts"\)\)/);
});
