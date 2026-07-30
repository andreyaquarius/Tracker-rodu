import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { settleEntitySave } from "../src/services/entitySaveWorkflow.ts";

test("entity save workflow keeps legacy synchronous void handlers successful", async () => {
  let calls = 0;
  const outcome = await settleEntitySave(() => {
    calls += 1;
  });

  assert.equal(calls, 1);
  assert.deepEqual(outcome, { status: "saved", value: undefined });
});

test("entity save workflow awaits asynchronous handlers and preserves their result", async () => {
  const entity = { id: "finding-1" };
  const outcome = await settleEntitySave(async () => entity);

  assert.deepEqual(outcome, { status: "saved", value: entity });
});

test("entity save workflow treats null as a rejected save", async () => {
  const outcome = await settleEntitySave(async () => null);

  assert.equal(outcome.status, "failed");
  assert.match(outcome.message, /Зміни не збережено/u);
});

test("entity save workflow converts thrown failures into a localized form error", async () => {
  const outcome = await settleEntitySave(async () => {
    throw new Error("Сервер тимчасово недоступний.");
  });

  assert.deepEqual(outcome, {
    status: "failed",
    message: "Не вдалося зберегти запис. Сервер тимчасово недоступний.",
  });
});

test("CRUD modal awaits save, keeps failure visible and blocks duplicate submit", () => {
  const source = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");

  assert.match(source, /if \(savePendingRef\.current\) return;/u);
  assert.match(source, /await settleEntitySave\(\(\) => onSave\(/u);
  assert.match(source, /if \(outcome\.status === "failed"\)[\s\S]*setSaveError\(outcome\.message\)[\s\S]*return;/u);
  assert.match(source, /if \(outcome\.status === "failed"\)[\s\S]*return;[\s\S]*onClose\(\);/u);
  assert.match(source, /type="submit"[\s\S]*disabled=\{savePending\}/u);
  assert.match(source, /role="alert"/u);
});
