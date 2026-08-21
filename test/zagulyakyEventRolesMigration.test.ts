import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/202608190005_zagulyaky_event_roles.sql", import.meta.url),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = migration.indexOf(startMarker);
  const end = migration.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing section start: ${startMarker}`);
  assert.ok(end > start, `missing section end: ${endMarker}`);
  return migration.slice(start, end);
}

test("event roles are nullable for legacy records but bounded for new writes", () => {
  assert.match(migration, /add column if not exists event_role_code text/i);
  assert.match(migration, /add column if not exists event_role_custom text/i);
  assert.match(migration, /event_role_code is null/i);
  for (const code of [
    "subject", "groom", "bride", "groom_father", "groom_mother",
    "bride_father", "bride_mother", "witness", "pledger", "other",
  ]) {
    assert.match(migration, new RegExp(`'${code}'`, "i"));
  }
  assert.doesNotMatch(migration, /'свідкиня'|'witness_female'/i);
  assert.match(migration, /event_role_code = 'other'[\s\S]*event_role_custom is not null/i);
  assert.match(migration, /event_role_code is distinct from 'other'[\s\S]*event_role_custom is null/i);
  assert.match(migration, /char_length\(event_role_custom\) between 2 and 160/i);
});

test("the existing details RPC preserves structural participant roles and validates event-role input", () => {
  const replaceDetails = section(
    "create or replace function public.replace_my_zagulyaka_details_v1(",
    "-- 190003 moved the broad detail builder",
  );

  assert.match(replaceDetails, /p_participants jsonb default '\[\]'::jsonb/i);
  assert.match(replaceDetails, /event_role_code := nullif\(btrim\(item->>'eventRoleCode'\), ''\)/i);
  assert.match(replaceDetails, /event_role_custom := nullif\(btrim\(item->>'eventRoleCustom'\), ''\)/i);
  assert.match(replaceDetails, /structural_role := coalesce\(nullif\(btrim\(item->>'role'\), ''\), 'subject'\)/i);
  assert.match(replaceDetails, /INVALID_EVENT_ROLE_CODE/i);
  assert.match(replaceDetails, /EVENT_ROLE_CUSTOM_REQUIRED/i);
  assert.match(replaceDetails, /EVENT_ROLE_CUSTOM_ONLY_FOR_OTHER/i);
  assert.match(replaceDetails, /char_length\(event_role_custom\) < 2/i);
  assert.match(replaceDetails, /existing\.id, structural_role, event_role_code, event_role_custom/i);
  assert.doesNotMatch(replaceDetails, /PARTICIPANT_ROLE_MUST_BE_SUBJECT/i);
});

test("public detail and living-person consent fingerprints include the safe role fields", () => {
  const fingerprint = section(
    "create or replace function security_private.zagulyaky_living_person_content_fingerprint_v1(",
    "-- Adding canonical keys changes the digest",
  );
  const privateDetail = section(
    "create or replace function security_private.get_public_zagulyaka_v1(p_slug text)",
    "create or replace function public.get_public_zagulyaka_v1(p_slug text)",
  );
  const publicDetail = section(
    "create or replace function public.get_public_zagulyaka_v1(p_slug text)",
    "-- Reassert the existing explicit API grants",
  );

  assert.match(fingerprint, /'eventRoleCode', participant\.event_role_code/i);
  assert.match(fingerprint, /'eventRoleCustom', participant\.event_role_custom/i);
  assert.match(
    migration,
    /update public\.zagulyaky_privacy_clearances clearance[\s\S]*?where clearance\.review_status = 'approved';/i,
  );
  assert.match(privateDetail, /'eventRoleCode', p\.event_role_code/i);
  assert.match(privateDetail, /'eventRoleCustom', p\.event_role_custom/i);
  assert.match(publicDetail, /zagulyaky_has_living_person_clearance_v1/i);
  assert.doesNotMatch(publicDetail, /'bucket'|'path'|public_bucket|public_path/i);
});

test("role migration retains explicit RPC ACLs and refreshes the PostgREST schema", () => {
  assert.match(
    migration,
    /revoke all on function public\.replace_my_zagulyaka_details_v1\(uuid,integer,jsonb,jsonb,jsonb\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.replace_my_zagulyaka_details_v1\(uuid,integer,jsonb,jsonb,jsonb\)\s+to authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_public_zagulyaka_v1\(text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.get_public_zagulyaka_v1\(text\)\s+to anon, authenticated, service_role;/i,
  );
  assert.match(migration, /notify pgrst, 'reload schema';/i);
});
