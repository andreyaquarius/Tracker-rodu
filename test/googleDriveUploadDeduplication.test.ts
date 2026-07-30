import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("deduplicated multipart creates are not replayed automatically", () => {
  const source = readFileSync(new URL("../src/services/googleDriveStorage.ts", import.meta.url), "utf8");

  assert.match(source, /deduplicationKey \? 1 : 4/u);
  assert.match(source, /findFileByDeduplicationKey\([\s\S]*?target,[\s\S]*?deduplicationKey,[\s\S]*?options\.signal/u);
  assert.match(source, /signal: options\.signal/u);
  assert.match(source, /retryGoogleDriveRequest\([\s\S]*?init\.signal/u);
  assert.match(source, /xhr\.abort\(\)/u);
});
