import test from "node:test";
import assert from "node:assert/strict";
import { personStatusLabel } from "../src/utils/familyTreeLabels.ts";

test("person status labels hide mojibake values from the family tree side panel", () => {
  assert.equal(personStatusLabel("доведена"), "доведена");
  assert.equal(personStatusLabel("РґРѕРІРµРґРµРЅР°"), "доведена");
  assert.equal(personStatusLabel("hypothetical"), "гіпотетична");
  assert.equal(personStatusLabel(""), "не вказано");
});

test("person status labels preserve the three knowledge-source statuses", () => {
  assert.equal(personStatusLabel("відома особисто"), "відома особисто");
  assert.equal(personStatusLabel("відома з переказів"), "відома з переказів");
  assert.equal(personStatusLabel("відома документально"), "відома документально");
});
