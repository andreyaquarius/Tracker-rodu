import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mainSource = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const editorSource = readFileSync(
  new URL("../src/features/persons-v2/PersonEditorV2.tsx", import.meta.url),
  "utf8",
);
const moduleSource = readFileSync(
  new URL("../src/features/persons-v2/PersonsModuleV2.tsx", import.meta.url),
  "utf8",
);

test("person editor blocks SPA transitions as well as browser unload", () => {
  assert.match(mainSource, /createBrowserRouter/);
  assert.match(mainSource, /<RouterProvider router=\{router\}/);
  assert.doesNotMatch(mainSource, /<BrowserRouter>/);
  assert.match(editorSource, /unstable_usePrompt\(\{/);
  assert.match(editorSource, /dirty\s*&&\s*!saving/);
  assert.match(editorSource, /beforeunload/);
});

test("the first successful create replaces the new route with its edit route", () => {
  assert.match(editorSource, /wasNewPerson && onPersisted/);
  assert.match(moduleSource, /onPersisted=\{\(person\) => onNavigate\(/);
  assert.match(moduleSource, /\{ mode: "edit", personId: person\.id \}/);
  assert.match(moduleSource, /\{ replace: true \}/);
});

test("direct mutation routes do not mount the editor without permission", () => {
  assert.match(moduleSource, /if \(readOnly \|\| \(target\.mode === "new" && !canCreate\)\)/);
  assert.match(moduleSource, /<UnavailablePersonEditorV2/);
});
