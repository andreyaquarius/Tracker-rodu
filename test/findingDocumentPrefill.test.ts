import assert from "node:assert/strict";
import test from "node:test";
import type { DocumentRecord } from "../src/types/index.ts";
import { prefillFindingFromDocument } from "../src/utils/findingDocumentPrefill.ts";

function document(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "document-1",
    createdAt: "2026-09-05T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
    researchId: "research-1",
    title: "Метрична книга села Вербівка",
    documentType: "метрична книга",
    archive: "Державний архів Київської області",
    fund: "384",
    description: "Опис 12",
    file: "Справа 65",
    yearFrom: "1886",
    yearTo: "1886",
    place: "Вербівка",
    url: "https://example.test/document",
    pagesCount: "200",
    lastPage: "42",
    reviewStatus: "в роботі",
    notes: "",
    scans: [],
    customFields: {},
    ...overrides,
  };
}

test("fills empty finding source fields from the linked document", () => {
  const draft = {
    documentId: "document-1",
    researchId: "",
    eventDate: "1886-03-12",
    page: "65 зв.",
    place: "",
    archive: "",
    fund: "",
    description: "",
    file: "",
    sourceUrl: "",
  };

  const result = prefillFindingFromDocument(draft, document());

  assert.deepEqual(result, {
    ...draft,
    researchId: "research-1",
    place: "Вербівка",
    archive: "Державний архів Київської області",
    fund: "384",
    description: "Опис 12",
    file: "Справа 65",
    sourceUrl: "https://example.test/document",
  });
  assert.equal(result.eventDate, "1886-03-12");
  assert.equal(result.page, "65 зв.");
});

test("does not overwrite finding-specific corrections", () => {
  const draft = {
    researchId: "other-research",
    place: "Вербівка, Бердичівський повіт",
    archive: "Архівне уточнення",
    fund: "",
  };

  const result = prefillFindingFromDocument(draft, document());

  assert.equal(result.place, draft.place);
  assert.equal(result.researchId, draft.researchId);
  assert.equal(result.archive, draft.archive);
  assert.equal(result.fund, "384");
});

test("replaces only metadata inherited from the previously selected document", () => {
  const previousDocument = document();
  const nextDocument = document({
    id: "document-2",
    place: "Війтівка",
    archive: "ЦДІАК України",
    fund: "127",
    description: "",
    file: "4499",
    url: "https://example.test/other-document",
  });
  const draft = {
    documentId: "document-2",
    place: previousDocument.place,
    archive: "Уточнена користувачем назва архіву",
    fund: previousDocument.fund,
    description: previousDocument.description,
    file: previousDocument.file,
    sourceUrl: previousDocument.url,
    page: "12",
  };

  const result = prefillFindingFromDocument(draft, nextDocument, previousDocument);

  assert.equal(result.place, "Війтівка");
  assert.equal(result.archive, "Уточнена користувачем назва архіву");
  assert.equal(result.fund, "127");
  assert.equal(result.description, "");
  assert.equal(result.file, "4499");
  assert.equal(result.sourceUrl, "https://example.test/other-document");
  assert.equal(result.page, "12");
});

test("leaves the draft untouched when no linked document is selected", () => {
  const draft = { place: "Вербівка", archive: "ДАКО" };
  assert.equal(prefillFindingFromDocument(draft, null), draft);
});
