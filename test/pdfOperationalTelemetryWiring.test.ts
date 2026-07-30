import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registry = readFileSync(
  new URL("../src/services/document-sources/registry.ts", import.meta.url),
  "utf8",
);
const viewer = readFileSync(
  new URL("../src/components/DocumentWorkspaceViewer.tsx", import.meta.url),
  "utf8",
);
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const gateway = readFileSync(
  new URL("../supabase/functions/pdf-gateway/index.ts", import.meta.url),
  "utf8",
);

test("external PDF operational events are wired at their canonical success and failure points", () => {
  for (const event of [
    "document_source_resolve_started",
    "document_source_resolve_succeeded",
    "document_source_resolve_failed",
  ]) assert.match(registry, new RegExp(`event: "${event}"`, "u"));

  for (const event of [
    "pdf_viewer_opened",
    "pdf_first_page_rendered",
    "pdf_page_export_succeeded",
    "pdf_page_export_failed",
  ]) assert.match(viewer, new RegExp(`event: "${event}"`, "u"));

  assert.match(
    app,
    /await createFindingDocumentReference[\s\S]*?documentReferenceDraft\.selection[\s\S]*?event: "finding_created_from_pdf_selection"/u,
  );
  assert.match(gateway, /createPdfProxyTelemetryRecord/u);
  assert.match(gateway, /onFinalize: \(\{ transferredBytes, outcome, errorCode \}\)/u);
});
