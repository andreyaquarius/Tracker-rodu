import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const card = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/PersonCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const icons = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/PersonCardActionIcon.tsx",
    import.meta.url,
  ),
  "utf8",
);
const css = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/familyTree.css",
    import.meta.url,
  ),
  "utf8",
);

test("person-card actions use semantic SVG shapes instead of ambiguous glyphs", () => {
  assert.match(card, /<PersonCardActionIcon kind="focus" \/>/);
  assert.match(card, /<PersonCardActionIcon kind="descendants" \/>/);
  assert.match(
    card,
    /kind=\{branchesCollapsed \? "expand-branches" : "collapse-branches"\}/,
  );
  assert.doesNotMatch(card, /[◎⇊▸▾]/);
  assert.match(icons, /kind === "focus"/);
  assert.match(icons, /kind === "descendants"/);
  assert.match(
    icons,
    /<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">/,
  );
});

test("card actions preserve names, state, callbacks, and compact-mode hiding", () => {
  assert.match(card, /aria-pressed=\{node\.lineageRole === "focus"\}/);
  assert.match(card, /aria-expanded=\{!branchesCollapsed\}/);
  assert.match(card, /onFocus\?\.\(personId\)/);
  assert.match(card, /onShowAllDescendants\(personId, node\.occurrenceId\)/);
  assert.match(card, /onToggleBranches\(personId, node\.occurrenceId\)/);
  assert.match(card, /onAddRelative\?\.\(personId\)/);
  assert.match(
    card,
    /\{!compact \? \(\s*<span className="ft-card-actions">/,
  );
});

test("focus, descendants, and branch toggles remain visually distinguishable", () => {
  assert.match(css, /data-action="focus"[\s\S]*?#1769aa/);
  assert.match(css, /data-action="descendants"[\s\S]*?#198754/);
  assert.match(css, /data-action="toggle-branches"[\s\S]*?#9b641d/);
  assert.match(
    css,
    /\.ft-card-action > svg \{[\s\S]*?width:\s*21px;[\s\S]*?height:\s*21px/,
  );
});

test("person-card actions share the delayed custom tooltip used by branch controls", () => {
  assert.match(card, /data-tooltip=\{`Показати дерево від \$\{name\}`\}/);
  assert.match(
    card,
    /data-tooltip=\{`Показати всіх нащадків особи \$\{name\}`\}/,
  );
  assert.match(card, /data-tooltip="Додати родича"/);
  assert.doesNotMatch(card, /title="Показати дерево від цієї особи"/);
  assert.match(
    css,
    /\.ft-continuation::after,[\s\S]*?\.ft-card-action::after \{[\s\S]*?content:\s*attr\(data-tooltip\)/,
  );
  assert.match(
    css,
    /\.ft-card-action:hover::after \{[\s\S]*?transition-delay:\s*700ms/,
  );
  assert.match(
    css,
    /\.ft-card-action:focus-visible::after \{[\s\S]*?transition-delay:\s*0ms/,
  );
});
