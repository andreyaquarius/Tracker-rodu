import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202608290015_context_specific_social_roles.sql",
    import.meta.url,
  ),
  "utf8",
);

test("specific church roles are separate directed Person-to-Person types", () => {
  for (const [code, sourceRole, targetRole] of [
    ["godfather", "Хрещений батько", "Хрещеник або хрещениця"],
    ["godmother", "Хрещена мати", "Хрещеник або хрещениця"],
    ["witness_for_bride", "Свідок по нареченій", "Учасник шлюбу"],
    ["witness_for_groom", "Свідок по нареченому", "Учасник шлюбу"],
  ] as const) {
    const rowPattern = new RegExp(
      `\\(\\s*'${code}'[\\s\\S]*?'church'[\\s\\S]*?'directed'[\\s\\S]*?'${sourceRole}'[\\s\\S]*?'${targetRole}'`,
      "i",
    );
    assert.match(migration, rowPattern, `Missing directed endpoint semantics for ${code}`);
  }
  assert.match(migration, /'specificPersonRole', true/i);
  assert.match(migration, /'sourceEndpoint', 'godfather'/i);
  assert.match(migration, /'targetEndpoint', 'marriage_participant'/i);
  assert.match(migration, /'weddingSide', 'bride'/i);
  assert.match(migration, /'weddingSide', 'groom'/i);
});

test("generic roles stay active as backward-compatible fallbacks", () => {
  assert.match(
    migration,
    /from \(values[\s\S]*?'godparent'::text[\s\S]*?'witness'::text[\s\S]*?as desired\(code, metadata_patch\)[\s\S]*?relation_type\.code = desired\.code/i,
  );
  assert.match(migration, /'isGenericPersonRole', true/i);
  assert.match(migration, /'legacyAmbiguous', true/i);
  assert.match(migration, /'allowNewManualAssertions', false/i);
  assert.match(migration, /'specificReplacementCodes'[\s\S]*?'godfather'[\s\S]*?'godmother'/i);
  assert.match(migration, /'specificReplacementCodes'[\s\S]*?'witness_for_bride'[\s\S]*?'witness_for_groom'/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.context_relation_types/i);
});

test("legacy wording upgrades only when it identifies an exact role", () => {
  assert.match(migration, /when 'хрещений батько' then 'godfather'/i);
  assert.match(migration, /when 'хрещена мати' then 'godmother'/i);
  assert.match(migration, /when 'свідок по нареченій' then 'witness_for_bride'/i);
  assert.match(migration, /when 'свідок по нареченому' then 'witness_for_groom'/i);
  assert.match(migration, /when 'хрещеник' then 'godparent'/i);
  assert.match(migration, /when 'свідок' then 'witness'/i);
});

test("migration is transactional and idempotent", () => {
  assert.match(migration, /^begin;/i);
  assert.match(migration, /on conflict \(lower\(code\)\) where project_id is null do update/i);
  assert.match(
    migration,
    /existing_type\.metadata \|\| excluded\.metadata[\s\S]*?where row\([\s\S]*?\) is distinct from row\(/i,
  );
  assert.match(
    migration,
    /relation_type\.metadata is distinct from relation_type\.metadata \|\| desired\.metadata_patch/i,
  );
  assert.match(migration, /create or replace function security_private\.legacy_person_context_type_code_v1/i);
  assert.match(migration, /commit;\s*$/i);
});

test("backend blocks legacy-only types only for new manual assertions or type changes", () => {
  assert.match(
    migration,
    /create or replace function security_private\.enforce_context_relation_manual_type_v1\(\)[\s\S]*?returns trigger/i,
  );
  assert.match(
    migration,
    /old\.assertion_kind in \('legacy_import', 'generated'\)[\s\S]*?new\.assertion_kind is distinct from old\.assertion_kind[\s\S]*?CONTEXT_RELATION_ASSERTION_KIND_IMMUTABLE/i,
  );
  assert.match(
    migration,
    /new\.assertion_kind not in \('manual', 'research_hypothesis'\)[\s\S]*?return new/i,
  );
  assert.match(
    migration,
    /tg_op = 'UPDATE'[\s\S]*?new\.relation_type_id is not distinct from old\.relation_type_id[\s\S]*?return new/i,
  );
  assert.match(migration, /metadata ->> 'allowNewManualAssertions'/i);
  assert.match(migration, /CONTEXT_RELATION_TYPE_LEGACY_ONLY/i);
  assert.match(
    migration,
    /create trigger person_context_relations_15_manual_type_policy[\s\S]*?before insert or update on public\.person_context_relations/i,
  );
  assert.match(
    migration,
    /revoke all on function security_private\.enforce_context_relation_manual_type_v1\(\)[\s\S]*?from public, anon, authenticated, service_role/i,
  );
});

test("legacy exact roles project the role person as the directed source", () => {
  const syncBlock = sourceBlock(
    migration,
    "create or replace function security_private.sync_context_from_person_relation_v1",
    "analyze public.context_relation_types",
  );
  assert.match(syncBlock, /normalized_relation_type := lower\(btrim\(coalesce\(legacy_row\.relation_type, ''\)\)\)/i);
  for (const role of [
    "хрещений батько",
    "хрещена мати",
    "свідок по нареченій",
    "свідок по нареченому",
  ]) {
    assert.match(syncBlock, new RegExp(`'${role}'`, "i"));
  }
  assert.match(
    syncBlock,
    /source_id := legacy_row\.related_person_id;[\s\S]*?target_id := legacy_row\.person_id/i,
  );
  assert.doesNotMatch(migration, /perform\s+security_private\.sync_context_from_person_relation_v1/i);
});

function sourceBlock(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}
