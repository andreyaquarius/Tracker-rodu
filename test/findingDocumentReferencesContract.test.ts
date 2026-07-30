import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const service = readFileSync(
  new URL("../src/services/findingDocumentReferences.ts", import.meta.url),
  "utf8",
);

test("Supabase provenance CRUD is project-scoped on every read, update and delete path", () => {
  const storeStart = service.indexOf("function createSupabaseStore");
  assert.ok(storeStart >= 0, "Supabase store must be present");
  const store = service.slice(storeStart);

  assert.match(store, /from\("finding_document_references"\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.order\("created_at"/u);
  assert.match(store, /async get\(projectId, id\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("id", id\)/u);
  assert.match(store, /async update\(projectId, id, patch\)[\s\S]*?\.update\(patch\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("id", id\)/u);
  assert.match(store, /async remove\(projectId, id\)[\s\S]*?\.delete\(\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.eq\("id", id\)/u);
  assert.match(
    store,
    /async insert\(row\)[\s\S]*?\.upsert\(row,\s*\{[\s\S]*?onConflict:\s*"project_id,finding_id,document_source_id,page_index"/u,
  );
});

test("the service never exposes fingerprint mutation on its update contract", () => {
  const updateContract = service.slice(
    service.indexOf("export interface UpdateFindingDocumentReferenceInput"),
    service.indexOf("export type SaveFindingDocumentReferenceInput"),
  );
  assert.doesNotMatch(updateContract, /sourceFingerprint/u);
  assert.match(service, /Immutable version information captured at finding creation time/u);
});

test("the default service loads Supabase lazily and does not embed access credentials", () => {
  assert.match(service, /await import\("\.\/supabaseAuth\.ts"\)/u);
  assert.doesNotMatch(service, /access[_-]?token|oauth[_-]?token|Authorization\s*:/iu);
  assert.match(service, /removedSensitiveParameters\.length/u);
});
