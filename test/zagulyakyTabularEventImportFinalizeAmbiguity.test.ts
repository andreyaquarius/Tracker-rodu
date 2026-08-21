import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const originalMigration = readFileSync(
  new URL("../supabase/migrations/202608200006_zagulyaky_tabular_event_import.sql", import.meta.url),
  "utf8",
);
const fixMigration = readFileSync(
  new URL(
    "../supabase/migrations/202608200008_zagulyaky_tabular_event_import_finalize_ambiguity_fix.sql",
    import.meta.url,
  ),
  "utf8",
);

const functionMarker =
  "create or replace function security_private.service_finalize_zagulyaky_tabular_event_import_v1";

function functionDefinition(source: string): string {
  const start = source.indexOf(functionMarker);
  const end = source.indexOf("$function$;", start);
  assert.ok(start >= 0, "finalize function must be present");
  assert.ok(end > start, "finalize function must have a complete replacement body");
  return source.slice(start, end + "$function$;".length).replaceAll("\r\n", "\n");
}

test("finalize ambiguity migration changes only the conflicting local counter", () => {
  const original = functionDefinition(originalMigration);
  const replacement = functionDefinition(fixMigration);
  const expected = original
    .replace("  failed_card_count integer;", "  computed_failed_card_count integer;")
    .replace("into failed_card_count", "into computed_failed_card_count")
    .replace(
      "failed_card_count = failed_card_count",
      "failed_card_count = computed_failed_card_count",
    )
    .replace(
      "remaining_card_count = 0 and failed_card_count = 0",
      "remaining_card_count = 0 and computed_failed_card_count = 0",
    );

  assert.equal(replacement, expected);
  assert.match(replacement, /security definer/i);
  assert.match(replacement, /set search_path = pg_catalog, public, security_private, pg_temp/i);
  assert.doesNotMatch(replacement, /^\s*failed_card_count integer;/mu);
  assert.doesNotMatch(replacement, /into failed_card_count\b/u);
  assert.doesNotMatch(replacement, /failed_card_count\s*=\s*failed_card_count\b/u);
  assert.match(replacement, /failed_card_count\s*=\s*computed_failed_card_count\b/u);
});

test("ambiguity migration has no table, policy, privilege, or data changes outside the replacement function", () => {
  const outsideFunction = fixMigration.replace(functionDefinition(fixMigration), "");

  assert.equal((fixMigration.match(new RegExp(functionMarker, "g")) ?? []).length, 1);
  assert.doesNotMatch(
    outsideFunction,
    /^\s*(?:create|alter|drop)\s+(?:table|index|policy|type|schema)|^\s*(?:grant|revoke)\b/imu,
  );
});
