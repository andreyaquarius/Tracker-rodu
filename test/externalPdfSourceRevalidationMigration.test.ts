import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607300005_external_pdf_source_revalidation.sql",
    import.meta.url,
  ),
  "utf8",
);

const recordValidationFunction = functionBody("record_document_source_validation");
const confirmVersionFunction = functionBody("confirm_document_source_version");

test("revalidation migration stores only a bounded pending fingerprint", () => {
  assert.match(migration, /add column if not exists pending_fingerprint jsonb/u);
  assert.match(migration, /document_sources_pending_fingerprint_safe_check/u);
  assert.match(
    migration,
    /pending_fingerprint is null[\s\S]*?private\.external_pdf_fingerprint_is_persistence_safe\(pending_fingerprint\)/u,
  );
  assert.match(migration, /Unconfirmed non-secret provider version metadata/u);
});

test("record_document_source_validation is editor-bound and never overwrites confirmed provenance", () => {
  assert.match(recordValidationFunction, /auth\.uid\(\) is null/u);
  assert.match(recordValidationFunction, /public\.can_edit_project\(target_project_id\)/u);
  assert.match(
    recordValidationFunction,
    /target_status not in \('active', 'changed', 'needs_auth', 'unavailable', 'invalid'\)/u,
  );
  assert.match(
    recordValidationFunction,
    /private\.external_pdf_fingerprint_is_persistence_safe\(target_new_fingerprint\)/u,
  );
  assert.match(
    recordValidationFunction,
    /pending_fingerprint = case[\s\S]*?when target_status = 'changed' then target_new_fingerprint[\s\S]*?else null/u,
  );
  assert.match(
    recordValidationFunction,
    /validation_error_code = case[\s\S]*?when target_status = 'changed' then 'SOURCE_CHANGED'/u,
  );
  assert.doesNotMatch(recordValidationFunction, /\bfingerprint\s*=\s*target_new_fingerprint/u);
  assert.doesNotMatch(recordValidationFunction, /finding_document_references/u);
});

test("confirm_document_source_version atomically accepts the pending version only after review", () => {
  assert.match(confirmVersionFunction, /public\.can_edit_project\(target_project_id\)/u);
  assert.match(confirmVersionFunction, /fingerprint = source\.pending_fingerprint/u);
  assert.match(confirmVersionFunction, /pending_fingerprint = null/u);
  assert.match(confirmVersionFunction, /status = 'active'/u);
  assert.match(confirmVersionFunction, /validation_error_code = null/u);
  assert.match(confirmVersionFunction, /source\.status = 'changed'/u);
  assert.match(confirmVersionFunction, /source\.pending_fingerprint is not null/u);
  assert.doesNotMatch(confirmVersionFunction, /finding_document_references/u);
});

test("revalidation RPCs are unavailable to anonymous callers", () => {
  assert.match(
    migration,
    /revoke all on function public\.record_document_source_validation\([\s\S]*?\) from public, anon/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.record_document_source_validation\([\s\S]*?\) to authenticated, service_role/u,
  );
  assert.match(
    migration,
    /revoke all on function public\.confirm_document_source_version\(uuid, uuid\)[\s\S]*?from public, anon/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.confirm_document_source_version\(uuid, uuid\)[\s\S]*?to authenticated, service_role/u,
  );
});

function functionBody(name: string): string {
  const expression = new RegExp(
    `create or replace function public\\.${name}\\([\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`,
    "u",
  );
  const match = expression.exec(migration);
  assert.ok(match, `migration must define public.${name}`);
  return match[1] ?? "";
}
