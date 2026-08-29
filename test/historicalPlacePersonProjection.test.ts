import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608280002_historical_place_person_event_link_safety.sql",
    import.meta.url,
  ),
  "utf8",
);

test("historical place links extend person events without replacing legacy place text", () => {
  assert.match(
    migration,
    /alter table public\.person_timeline_events[\s\S]*?add column if not exists place_id uuid[\s\S]*?add column if not exists place_original_text text/iu,
  );
  assert.match(migration, /references public\.places\(id\) on delete restrict/iu);
  assert.doesNotMatch(migration, /drop column[\s\S]*?place_name/iu);
  assert.doesNotMatch(migration, /update public\.person_timeline_events[\s\S]*?set[\s\S]*?place_name\s*=/iu);
});

test("projection rebuild restores identity and exact source wording only when display wording is unchanged", () => {
  assert.match(
    migration,
    /capture_person_event_place_before_projection_delete_v1[\s\S]*?old\.place_name/iu,
  );
  assert.match(
    migration,
    /saved_link\.place_name_snapshot is distinct from coalesce\(new\.place_name, ''\)[\s\S]*?return new/iu,
  );
  assert.match(
    migration,
    /set\s+place_id = saved_link\.place_id,[\s\S]*?place_original_text = saved_link\.place_original_text/iu,
  );
  assert.match(
    migration,
    /old\.place_id is null[\s\S]*?and coalesce\(old\.place_original_text, ''\) = ''/iu,
  );
  assert.doesNotMatch(
    migration,
    /if\s+old\.place_id is null\s+or/iu,
  );
  assert.doesNotMatch(
    migration,
    /saved_link\.is_ambiguous\s+or\s+saved_link\.place_id is null/iu,
  );
  assert.match(
    migration,
    /create constraint trigger person_timeline_events_95_cleanup_place_restore_context[\s\S]*?deferrable initially deferred/iu,
  );
});

test("event links preserve source wording and reject cross-project private places", () => {
  assert.match(
    migration,
    /validate_person_event_place_link_v1[\s\S]*?new\.place_original_text := new\.place_name/iu,
  );
  assert.match(
    migration,
    /linked_place_project_id is not null[\s\S]*?linked_place_project_id is distinct from new\.project_id[\s\S]*?PERSON_EVENT_PLACE_SCOPE_MISMATCH/iu,
  );
  assert.match(
    migration,
    /before insert or update of[\s\S]*?place_id,[\s\S]*?project_id,[\s\S]*?place_name,[\s\S]*?place_original_text/iu,
  );
  assert.doesNotMatch(
    migration,
    /new\.place_name\s*:=\s*(?:place_row\.)?canonical_name/iu,
  );
  assert.match(
    migration,
    /linked_place_project_id is null[\s\S]*?auth\.role\(\)[\s\S]*?linked_place_status = 'active'[\s\S]*?linked_place_verification_status = 'verified'[\s\S]*?PERSON_EVENT_PLACE_ACCESS_REQUIRED/iu,
  );
  assert.match(
    migration,
    /projection_restore_allowed[\s\S]*?context\.place_id = new\.place_id[\s\S]*?and not projection_restore_allowed/iu,
  );
});

test("projection bridge is private and duplicate projection rows fail closed", () => {
  assert.match(
    migration,
    /revoke all on table security_private\.person_event_place_restore_context\s+from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    migration,
    /on conflict \(transaction_id, backend_pid, project_id, person_id, event_type\)[\s\S]*?place_id = null,[\s\S]*?is_ambiguous = true/iu,
  );
  assert.match(
    migration,
    /revoke all on function[\s\S]*?capture_person_event_place_before_projection_delete_v1\(\)[\s\S]*?from public, anon, authenticated, service_role/iu,
  );
});
