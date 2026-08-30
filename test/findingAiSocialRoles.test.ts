import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const edgeFunction = readFileSync(
  new URL("../supabase/functions/index-finding-fragment/index.ts", import.meta.url),
  "utf8",
);

test("finding AI can return exact wedding-side witness roles", () => {
  assert.match(edgeFunction, /witness_for_bride:\s*"Свідок по нареченій"/u);
  assert.match(edgeFunction, /witness_for_groom:\s*"Свідок по нареченому"/u);
  assert.match(edgeFunction, /лише тоді,[\s\S]*?прямо видно, чию сторону представляє свідок/u);
});

test("finding AI fails closed when a wedding witness side is not visible", () => {
  assert.match(edgeFunction, /Не визначай сторону[\s\S]*?власним припущенням/u);
  assert.match(edgeFunction, /legacy-роль witness/u);
  assert.match(edgeFunction, /warning про потребу ручного[\s\S]*?needsHumanReview=true/u);
});

test("finding AI returns exact sponsor sides only when the document states them", () => {
  assert.match(edgeFunction, /sponsor_for_bride:\s*"Поручитель по нареченій"/u);
  assert.match(edgeFunction, /sponsor_for_groom:\s*"Поручитель по нареченому"/u);
  assert.match(edgeFunction, /лише коли сторона[\s\S]*?прямо вказана в документі/u);
  assert.match(edgeFunction, /Не визначай сторону поручителя[\s\S]*?legacy-роль surety/u);
  assert.match(edgeFunction, /warning про ручне уточнення[\s\S]*?needsHumanReview=true/u);
});
