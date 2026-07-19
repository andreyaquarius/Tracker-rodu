import assert from "node:assert/strict";
import test from "node:test";
import type { Person } from "../src/types/index.ts";
import { savePersonAndClose } from "../src/features/persons-v2/contracts.ts";

const person = { id: "person-1" } as Person;

test("closes only after a successful person save", async () => {
  let closeCount = 0;
  await savePersonAndClose(async () => person, person, () => closeCount += 1);
  assert.equal(closeCount, 1);

  await savePersonAndClose(async () => null, person, () => closeCount += 1);
  assert.equal(closeCount, 1);
});

test("does not close when saving rejects", async () => {
  let closed = false;
  await assert.rejects(
    savePersonAndClose(
      async () => {
        throw new Error("save failed");
      },
      person,
      () => {
        closed = true;
      },
    ),
    /save failed/,
  );
  assert.equal(closed, false);
});
