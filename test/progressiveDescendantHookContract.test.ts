import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/useProgressiveDescendantGraph.ts",
    import.meta.url,
  ),
  "utf8",
);
const loader = readFileSync(
  new URL(
    "../src/features/family-tree-view/data/progressiveDescendantLoader.ts",
    import.meta.url,
  ),
  "utf8",
);

test("a changed root never reuses the previous root graph", () => {
  assert.match(hook, /scopeChanged \|\| !currentHasRoot/);
  assert.match(
    hook,
    /freshDescendantSeed\(sourceInitialGraph, rootPersonId, true\)/,
  );
  assert.match(
    hook,
    /providedRootSeed && !providedRootSeed\.persons\.length[\s\S]*?commit\(stateForGraph\(providedRootSeed, true\)\)[\s\S]*?return undefined/,
  );
  assert.doesNotMatch(
    hook,
    /scopeChanged\s*\?\s*initialGraph\s*:\s*stateRef\.current\.graph/,
  );
});

test("the hook forwards a backward-compatible optional hard limit", () => {
  assert.match(hook, /maxPersons\?: number/);
  assert.match(hook, /maxPersons \?\? ""/);
  assert.match(
    hook,
    /maxPersons === undefined \? \{\} : \{ maxPersons \}/,
  );
  assert.match(loader, /maxPersons\?: number/);
  assert.match(loader, /truncated: boolean/);
  assert.match(loader, /loading: !truncated/);
});

