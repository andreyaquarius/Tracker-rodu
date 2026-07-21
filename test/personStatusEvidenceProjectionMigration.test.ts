import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607210002_person_status_evidence_projection.sql",
    import.meta.url,
  ),
  "utf8",
);
const pgTap = readFileSync(
  new URL(
    "../supabase/tests/person_status_evidence_projection_test.sql",
    import.meta.url,
  ),
  "utf8",
);

test("knowledge-source statuses retain explicit graph evidence semantics", () => {
  assert.match(migration, /when 'відома особисто' then 'proven'/i);
  assert.match(migration, /when 'відома документально' then 'proven'/i);
  assert.match(migration, /when 'відома з переказів' then 'likely'/i);
  assert.match(
    migration,
    /update public\.person_names[\s\S]*?update public\.person_timeline_events/i,
  );
});

test("status projection trigger runs after the canonical persons projection", () => {
  assert.match(
    migration,
    /create trigger persons_status_evidence_projection_sync\s+after insert or update of[\s\S]*?status,[\s\S]*?surname,[\s\S]*?birth_date,[\s\S]*?death_place,[\s\S]*?residence_places\s+on public\.persons[\s\S]*?when \(new\.status in \([\s\S]*?'відома особисто'[\s\S]*?'відома з переказів'[\s\S]*?'відома документально'[\s\S]*?\)\)/i,
  );
  assert.match(
    migration,
    /execute function security_private\.family_tree_refresh_person_status_evidence_projection\(\)/i,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.family_tree_refresh_person_status_evidence_projection\(\)\s+from public, anon, authenticated, service_role/i,
  );
});

test("new status evidence is restored after any canonical person projection update", () => {
  assert.doesNotMatch(
    migration,
    /after insert or update of\s+status\s+on public\.persons/i,
  );
  assert.match(
    migration,
    /if tg_op = 'UPDATE' and row\([\s\S]*?old\.status,[\s\S]*?old\.residence_places[\s\S]*?\) is not distinct from row\([\s\S]*?new\.status,[\s\S]*?new\.residence_places[\s\S]*?\) then\s+return new;/i,
  );
});

test("person-status pgTAP fixture covers persistence and no-op updates", () => {
  const plan = Number(pgTap.match(/select\s+plan\((\d+)\)/i)?.[1]);
  const assertions = pgTap.match(/^select\s+(?:is|ok|throws_ok)\s*\(/gim) ?? [];

  assert.equal(plan, 10);
  assert.equal(assertions.length, plan);
  assert.match(pgTap, /a later name edit preserves documented evidence/i);
  assert.match(pgTap, /oral-tradition knowledge projects generated events as likely/i);
  assert.match(pgTap, /a no-op UPSERT neither rebuilds nor rewrites corrected timeline projections/i);
  assert.match(pgTap, /^begin;/i);
  assert.match(pgTap, /select \* from finish\(\);\s*rollback;\s*$/i);
});
