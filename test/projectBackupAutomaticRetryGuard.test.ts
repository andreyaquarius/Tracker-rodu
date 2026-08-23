import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("a failed automatic backup cannot retry on every render of the same project/day", () => {
  assert.match(app, /automaticProjectBackupAttemptRef/);
  assert.match(app, /const automaticBackupAttemptKey = `\$\{projectId\}:\$\{today\}`/);
  assert.match(
    app,
    /automaticProjectBackupAttemptRef\.current === automaticBackupAttemptKey/,
  );
  assert.match(
    app,
    /automaticProjectBackupAttemptRef\.current = automaticBackupAttemptKey/,
  );
  assert.doesNotMatch(app, /automaticProjectBackupAttemptRef\.current = null/);
});
