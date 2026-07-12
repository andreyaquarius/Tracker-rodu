import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const hook = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/useFamilyTreeNeighborhood.ts",
    import.meta.url,
  ),
  "utf8",
);
const styles = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);

test("stage three keeps the all-descendants command on each person card", () => {
  assert.match(
    page,
    /<FamilyTreeViewport[\s\S]*?onShowAllDescendants=\{\(personId\) => enterAllDescendants\(personId\)\}/,
  );
  assert.doesNotMatch(page, /Усі нащадки вибраної особи/);
});

test("special perspective bars expose progress, cancel and pedigree return", () => {
  assert.match(page, /function SpecialPerspectiveProgress/);
  assert.match(page, /<progress aria-label="Завантаження спеціального режиму дерева"/);
  assert.match(page, /specialNeighborhood\.canceled/);
  assert.match(page, /onClick=\{specialNeighborhood\.cancel\}/);
  assert.match(page, />\s*Зупинити\s*</);
  assert.match(page, /Повернутися до родового дерева/);
  assert.match(page, /Продовжити завантаження/);
  assert.match(hook, /canceled: boolean/);
  assert.match(hook, /cancel: \(\) => void/);
  assert.match(styles, /\.family-tree-v2-perspective-progress/);
});

test("family corridor renders and mutates an ordered breadcrumb trail", () => {
  assert.match(page, /trail: \[openedTrailItem\]/);
  assert.match(page, /appendFamilyCorridorTrailItem/);
  assert.match(page, /keepFamilyCorridorTrailThrough/);
  assert.match(page, /aria-label="Відкриті покоління сімейного коридору"/);
  assert.match(page, /Покоління \{index \+ 1\}: \{label\}/);
  assert.match(page, /specialNeighborhood\.collapseFamilyScope\(item\.scope\.id\)/);
  assert.match(styles, /\.family-tree-v2-corridor-breadcrumbs/);
});
