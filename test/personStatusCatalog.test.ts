import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("person editors render research-status options from the shared catalogue", () => {
  const editors = [
    source("../src/components/PersonFormModal.tsx"),
    source("../src/features/persons-v2/PersonEditorV2.tsx"),
  ];

  for (const editor of editors) {
    assert.match(editor, /import\s+\{[^}]*\bPERSON_STATUSES\b[^}]*\}\s+from/u);
    assert.match(editor, /PERSON_STATUSES\.map\s*\(\s*\(status\)\s*=>/u);
  }
});

test("person catalogue and table import reuse the shared status catalogue", () => {
  const personsPage = source("../src/pages/PersonsPage.tsx");
  const tableImport = source("../src/utils/tableDataImport.ts");

  assert.match(personsPage, /PERSON_STATUSES\.map\s*\(\s*\(status\)\s*=>/u);
  assert.match(tableImport, /key\s*===\s*"status"\)\s*return\s*\[\.\.\.PERSON_STATUSES\]/u);
});
