import test from "node:test";
import assert from "node:assert/strict";
import { normalizePersonStatus } from "../src/utils/personStatus.ts";

test("normalizes mojibake person statuses from tree-created people", () => {
  assert.equal(normalizePersonStatus("РґРѕРІРµРґРµРЅР°"), "доведена");
  assert.equal(normalizePersonStatus("РіС–РїРѕС‚РµС‚РёС‡РЅР°"), "гіпотетична");
  assert.equal(normalizePersonStatus("proven"), "доведена");
  assert.equal(normalizePersonStatus(""), "гіпотетична");
});
