import test from "node:test";
import assert from "node:assert/strict";
import { personStatusLabel } from "../src/utils/familyTreeLabels.ts";

test("person status labels hide mojibake values from the family tree side panel", () => {
  assert.equal(personStatusLabel("доведена"), "доведена");
  assert.equal(personStatusLabel("РґРѕРІРµРґРµРЅР°"), "доведена");
  assert.equal(personStatusLabel("hypothetical"), "гіпотетична");
  assert.equal(personStatusLabel(""), "не вказано");
});
