import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const fixMigration = readFileSync(
  new URL("../supabase/migrations/202608200007_zagulyaky_tabular_event_import_nul_fix.sql", import.meta.url),
  "utf8",
);

function privateFunctionBody(functionName: string): string {
  const marker = `create or replace function security_private.${functionName}`;
  const start = fixMigration.indexOf(marker);
  const end = fixMigration.indexOf("$function$;", start);
  assert.ok(start >= 0, `200007 must redefine private ${functionName}`);
  assert.ok(end > start, `${functionName} must have a complete replacement body`);
  return fixMigration.slice(start, end);
}

test("the NUL regression fix replaces every affected tabular-import parser without widening access", () => {
  for (const functionName of [
    "zagulyaky_tabular_import_text_v1",
    "zagulyaky_tabular_import_raw_text_v1",
  ]) {
    const body = privateFunctionBody(functionName);
    assert.match(body, /security definer/i);
    assert.match(body, /set search_path = pg_catalog, security_private, pg_temp/i);
    assert.doesNotMatch(
      body,
      /chr\s*\(\s*0\s*\)/i,
      `${functionName} must not construct a PostgreSQL NUL code point while parsing ordinary text`,
    );
    assert.match(body, /char_length\([^)]*\) > p_max_length/i);
    assert.match(
      fixMigration,
      new RegExp(
        `revoke all on function security_private\\.${functionName}\\(jsonb,text,integer,boolean\\)\\s+from public, anon, authenticated, service_role;`,
        "i",
      ),
    );
  }
});

test("the same fix replaces admin begin so an ordinary workbook filename reaches the protected dry-run path", () => {
  const begin = privateFunctionBody("admin_begin_zagulyaky_tabular_event_import_v1");

  assert.match(begin, /has_admin_permission_v1\('zagulyaky\.import'\)/i);
  assert.match(begin, /normalized_file_name !~\* '\[\.\]xlsx\$'/i);
  assert.match(begin, /normalized_file_name ~ '\[\\\\\/\]'/i);
  assert.doesNotMatch(begin, /chr\s*\(\s*0\s*\)/i);
  assert.match(begin, /on conflict \(source_checksum\) do nothing/i);
  assert.match(
    fixMigration,
    /revoke all on function security_private\.admin_begin_zagulyaky_tabular_event_import_v1\(text,text,jsonb,text\)\s+from public, anon, authenticated, service_role;/i,
  );
  assert.match(
    fixMigration,
    /grant execute on function security_private\.admin_begin_zagulyaky_tabular_event_import_v1\(text,text,jsonb,text\)\s+to authenticated, service_role;/i,
  );
});
