import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607300007_external_pdf_pending_resolved_metadata.sql",
    import.meta.url,
  ),
  "utf8",
);
const revalidationService = readFileSync(
  new URL("../src/services/documentSourceRevalidation.ts", import.meta.url),
  "utf8",
);
const sourceStore = readFileSync(
  new URL("../src/services/documentSources.ts", import.meta.url),
  "utf8",
);
const viewer = readFileSync(
  new URL("../src/components/DocumentWorkspaceViewer.tsx", import.meta.url),
  "utf8",
);

const metadataSafetyFunction = functionBody(
  "private",
  "external_pdf_resolved_metadata_is_persistence_safe",
);
const recordValidationFunction = functionBody(
  "public",
  "record_document_source_validation",
);
const confirmVersionFunction = functionBody(
  "public",
  "confirm_document_source_version",
);

test("pending resolved metadata has an exact bounded non-secret schema", () => {
  assert.match(migration, /add column if not exists pending_resolved_metadata jsonb/u);
  assert.match(metadataSafetyFunction, /pg_catalog\.pg_column_size\(payload\) > 12288/u);
  for (const field of [
    "canonical_url",
    "provider_host",
    "file_size_bytes",
    "page_count",
    "access_mode",
  ]) {
    assert.match(metadataSafetyFunction, new RegExp(`'${field}'`, "u"));
  }
  assert.match(
    metadataSafetyFunction,
    /private\.external_pdf_url_is_persistence_safe\(canonical_value\)/u,
  );
  assert.match(
    metadataSafetyFunction,
    /provider_host_value is distinct from private\.external_pdf_url_host\(canonical_value\)/u,
  );
  assert.match(metadataSafetyFunction, /provider_host_value\) > 253/u);
  assert.match(metadataSafetyFunction, /9007199254740991/u);
  assert.match(metadataSafetyFunction, /2147483647/u);
  assert.match(metadataSafetyFunction, /'direct_cors', 'secure_proxy', 'google_drive_api'/u);
  assert.match(migration, /document_sources_pending_version_complete_check/u);
  assert.match(
    migration,
    /\(pending_fingerprint is null\) = \(pending_resolved_metadata is null\)/u,
  );
});

test("validation records fingerprint and resolved fields as one pending version", () => {
  assert.match(recordValidationFunction, /public\.can_edit_project\(target_project_id\)/u);
  assert.match(
    recordValidationFunction,
    /private\.external_pdf_resolved_metadata_is_persistence_safe\([\s\S]*?target_resolved_metadata/u,
  );
  assert.match(
    recordValidationFunction,
    /pending_fingerprint = case[\s\S]*?target_new_fingerprint/u,
  );
  assert.match(
    recordValidationFunction,
    /pending_resolved_metadata = case[\s\S]*?target_resolved_metadata/u,
  );
  assert.match(recordValidationFunction, /source\.status = target_expected_status/u);
  assert.match(
    recordValidationFunction,
    /source\.fingerprint = target_expected_fingerprint/u,
  );
  assert.match(
    recordValidationFunction,
    /source\.last_validated_at is not distinct from target_expected_last_validated_at/u,
  );
  assert.match(recordValidationFunction, /source\.pending_fingerprint is null/u);
  assert.doesNotMatch(recordValidationFunction, /\bcanonical_url\s*=\s*target_/u);
  assert.doesNotMatch(recordValidationFunction, /finding_document_references/u);
});

test("confirmation atomically promotes canonical URL and all version-coupled fields", () => {
  assert.match(confirmVersionFunction, /fingerprint = source\.pending_fingerprint/u);
  assert.match(
    confirmVersionFunction,
    /canonical_url = source\.pending_resolved_metadata ->> 'canonical_url'/u,
  );
  assert.match(
    confirmVersionFunction,
    /provider_host = source\.pending_resolved_metadata ->> 'provider_host'/u,
  );
  assert.match(confirmVersionFunction, /file_size_bytes = case/u);
  assert.match(confirmVersionFunction, /page_count = case/u);
  assert.match(
    confirmVersionFunction,
    /access_mode = source\.pending_resolved_metadata ->> 'access_mode'/u,
  );
  assert.match(confirmVersionFunction, /pending_fingerprint = null/u);
  assert.match(confirmVersionFunction, /pending_resolved_metadata = null/u);
  assert.match(
    confirmVersionFunction,
    /source\.pending_fingerprint = target_expected_pending_fingerprint/u,
  );
  assert.match(
    confirmVersionFunction,
    /source\.pending_resolved_metadata = target_expected_pending_resolved_metadata/u,
  );
  assert.doesNotMatch(confirmVersionFunction, /finding_document_references/u);
});

test("legacy fingerprint-only observations are discarded and revalidated as complete versions", () => {
  assert.match(
    migration,
    /set[\s\S]*?pending_fingerprint = null[\s\S]*?pending_resolved_metadata = null[\s\S]*?last_validated_at = null[\s\S]*?where source\.pending_fingerprint is not null/u,
  );
  assert.doesNotMatch(
    migration,
    /set pending_resolved_metadata = pg_catalog\.jsonb_build_object/u,
  );
});

test("new validation RPC is not executable by anonymous callers", () => {
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
    /revoke all on function public\.confirm_document_source_version\(uuid, uuid, jsonb, jsonb\)[\s\S]*?from public, anon/u,
  );
  assert.match(
    migration,
    /grant execute on function public\.confirm_document_source_version\(uuid, uuid, jsonb, jsonb\)[\s\S]*?to authenticated, service_role/u,
  );
  assert.match(
    migration,
    /revoke execute on function private\.external_pdf_resolved_metadata_is_persistence_safe\(jsonb\)[\s\S]*?from public, anon, authenticated/u,
  );
});

test("client confirmation carries the exact pending version shown to the editor", () => {
  assert.match(sourceStore, /"pending_fingerprint"/u);
  assert.match(sourceStore, /"pending_resolved_metadata"/u);
  assert.match(
    revalidationService,
    /target_expected_pending_fingerprint: expectedPendingFingerprint/u,
  );
  assert.match(
    revalidationService,
    /target_expected_pending_resolved_metadata: resolvedMetadataToRpc/u,
  );
  assert.match(viewer, /!source\.pendingFingerprint/u);
  assert.match(viewer, /!source\.pendingResolvedMetadata/u);
  assert.match(
    viewer,
    /confirmDocumentSourceVersion\([\s\S]*?source\.pendingFingerprint,[\s\S]*?source\.pendingResolvedMetadata/u,
  );
});

function functionBody(schema: string, name: string): string {
  const expression = new RegExp(
    `create(?: or replace)? function ${schema}\\.${name}\\([\\s\\S]*?\\nas \\$\\$([\\s\\S]*?)\\$\\$;`,
    "u",
  );
  const match = expression.exec(migration);
  assert.ok(match, `migration must define ${schema}.${name}`);
  return match[1] ?? "";
}
