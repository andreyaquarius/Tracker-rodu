import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const attachments = readFileSync(
  new URL("../src/components/ScanAttachments.tsx", import.meta.url),
  "utf8",
);
const crud = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("document URL input validates automatically with debounce and aborts stale probes", () => {
  assert.match(attachments, /new AbortController\(\)/u);
  assert.match(attachments, /setTimeout\(\(\) => \{[\s\S]*?resolveDocumentSourceForAdd/u);
  assert.match(attachments, /\}, 450\)/u);
  assert.match(attachments, /controller\.abort\("source input changed"\)/u);
});

test("multiple Wikisource PDFs require an explicit radio selection before attach", () => {
  assert.match(attachments, /resolution\?\.candidates\.length && resolution\.candidates\.length > 1/u);
  assert.match(attachments, /type="radio"[\s\S]*?checked=\{selectedCandidateId === candidate\.id\}/u);
  assert.match(attachments, /sourceAddEnabled \? !selectedSource : !preview/u);
});

test("new add flow is document-only, editor-only, and fully feature-flagged", () => {
  assert.match(crud, /config\.collection === "documents" && externalPdfSourceAdd\?\.enabled/u);
  assert.match(app, /externalPdfViewerV2Enabled && workspace && account && !readOnly/u);
  assert.match(attachments, /sourceAddContext\?\.enabled === true/u);
});
