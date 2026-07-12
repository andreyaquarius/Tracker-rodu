import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allocateInteractiveMountBudget,
  MAX_RENDERED_FAMILY_TREE_NODES,
} from "../src/features/family-tree-view/react/renderLimits.ts";

test("one hard budget covers cards and family controls together", () => {
  const cards = Array.from({ length: 590 }, (_, index) => `card-${index}`);
  const controls = Array.from({ length: 40 }, (_, index) => `control-${index}`);
  const result = allocateInteractiveMountBudget(cards, controls);

  assert.equal(result.limit, MAX_RENDERED_FAMILY_TREE_NODES);
  assert.equal(result.primary.length, 590);
  assert.equal(result.secondary.length, 10);
  assert.equal(result.mountedCount, 600);
  assert.equal(result.omittedCount, 30);
  assert.equal(result.primary.length + result.secondary.length <= 600, true);
});

test("oversized primary collections can never leave extra control slots", () => {
  const cards = Array.from({ length: 750 }, (_, index) => index);
  const controls = Array.from({ length: 200 }, (_, index) => index);
  const result = allocateInteractiveMountBudget(cards, controls, 10_000);

  assert.equal(result.primary.length, 600);
  assert.equal(result.secondary.length, 0);
  assert.equal(result.mountedCount, 600);
  assert.equal(result.omittedCount, 350);
  assert.equal(cards.length, 750);
  assert.equal(controls.length, 200);
});

test("production viewport and semantic list share the aggregate allocator", () => {
  const viewport = readFileSync(
    new URL(
      "../src/features/family-tree-view/react/FamilyTreeViewport.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const semanticList = readFileSync(
    new URL(
      "../src/features/family-tree-view/react/FamilyTreeSemanticList.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    viewport,
    /allocateInteractiveMountBudget\(\s*visibleNodeCandidates,\s*visibleFamilyControlCandidates,\s*renderedNodeLimit,/,
  );
  assert.match(viewport, /const visibleNodes = mountedInteractive\.primary/);
  assert.match(
    viewport,
    /const visibleFamilyControls = mountedInteractive\.secondary/,
  );
  assert.match(
    semanticList,
    /allocateInteractiveMountBudget\(\s*candidates,\s*canonicalFamilyContinuations,\s*nodeLimit,/,
  );
  assert.match(
    semanticList,
    /const listedFamilyContinuations = mountedInteractive\.secondary/,
  );
});
