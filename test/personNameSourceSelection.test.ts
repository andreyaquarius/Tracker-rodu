import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPersonNameSourceChoice,
  personNameSourceChoice,
  type PersonNameSourceLinkFields,
} from "../src/utils/personNameSourceSelection.ts";

function source(overrides: Partial<PersonNameSourceLinkFields> = {}): PersonNameSourceLinkFields {
  return {
    sourceDocumentId: null,
    sourceFindingId: null,
    sourceType: "",
    sourceId: null,
    ...overrides,
  };
}

test("one catalogue choice synchronizes the explicit and generic source link", () => {
  const document = applyPersonNameSourceChoice(source(), "document:document-1");
  assert.deepEqual(document, source({
    sourceDocumentId: "document-1",
    sourceType: "document",
    sourceId: "document-1",
  }));
  assert.equal(personNameSourceChoice(document), "document:document-1");

  const finding = applyPersonNameSourceChoice(document, "finding:finding-1", {
    findingDocumentId: "document-2",
  });
  assert.deepEqual(finding, source({
    sourceDocumentId: "document-2",
    sourceFindingId: "finding-1",
    sourceType: "finding",
    sourceId: "finding-1",
  }));
  assert.equal(personNameSourceChoice(finding), "finding:finding-1");
});

test("clearing a user-facing choice clears only source-link fields", () => {
  const withForwardCompatibleFields = {
    ...source({ sourceFindingId: "finding-1", sourceType: "finding", sourceId: "finding-1" }),
    citationId: "citation-1",
    documentFragmentId: "fragment-1",
  };
  assert.deepEqual(applyPersonNameSourceChoice(withForwardCompatibleFields, ""), {
    ...source(),
    citationId: "citation-1",
    documentFragmentId: "fragment-1",
  });
});

test("unknown and conflicting legacy links are retained without exposing an editable UUID", () => {
  const legacy = source({ sourceType: "archive_case", sourceId: "legacy-1" });
  assert.equal(personNameSourceChoice(legacy), "__legacy");
  assert.equal(applyPersonNameSourceChoice(legacy, "__legacy"), legacy);
  assert.equal(personNameSourceChoice(source({ sourceType: "gedcom" })), "__legacy");
  assert.equal(personNameSourceChoice(source({ sourceType: "manual" })), "");
  assert.equal(personNameSourceChoice(source({
    sourceDocumentId: "document-1",
    sourceFindingId: "finding-1",
  })), "finding:finding-1");
  assert.equal(personNameSourceChoice(source({
    sourceDocumentId: "document-1",
    sourceFindingId: "finding-1",
    sourceType: "archive_case",
    sourceId: "legacy-1",
  })), "__legacy");
});
