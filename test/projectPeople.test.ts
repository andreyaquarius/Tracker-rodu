import test from "node:test";
import assert from "node:assert/strict";
import { PERSON_STATUSES, normalizePersonStatus } from "../src/utils/personStatus.ts";

test("normalizes mojibake person statuses from tree-created people", () => {
  assert.equal(normalizePersonStatus("РґРѕРІРµРґРµРЅР°"), "доведена");
  assert.equal(normalizePersonStatus("РіС–РїРѕС‚РµС‚РёС‡РЅР°"), "гіпотетична");
  assert.equal(normalizePersonStatus("proven"), "доведена");
  assert.equal(normalizePersonStatus(""), "гіпотетична");
});

test("preserves every knowledge-source person status without collapsing it to a hypothesis", () => {
  const knowledgeSourceStatuses = [
    "відома особисто",
    "відома з переказів",
    "відома документально",
  ] as const;

  assert.deepEqual(
    knowledgeSourceStatuses.map((status) => normalizePersonStatus(status)),
    knowledgeSourceStatuses,
  );
  for (const status of knowledgeSourceStatuses) {
    assert.equal(PERSON_STATUSES.filter((candidate) => candidate === status).length, 1);
  }
});
