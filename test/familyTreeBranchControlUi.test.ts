import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const personCard = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/PersonCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const familyControl = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/FamilyBranchControl.tsx",
    import.meta.url,
  ),
  "utf8",
);
const icon = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/BranchControlIcon.tsx",
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

test("tree branch controls expose direction, state, count, and an accessible explanation", () => {
  assert.match(personCard, /data-direction=\{direction\}/);
  assert.match(personCard, /data-tooltip=\{presentation\.ariaLabel\}/);
  assert.doesNotMatch(personCard, /title=\{presentation\.title\}/);
  assert.match(personCard, /aria-expanded=\{presentation\.expanded\}/);
  assert.match(
    personCard,
    /className="ft-branch-control-count" aria-hidden="true"/,
  );

  assert.match(familyControl, /data-direction="family-children"/);
  assert.match(familyControl, /data-tooltip=\{label\}/);
  assert.doesNotMatch(familyControl, /title=\{`\$\{action\} цієї пари`\}/);
  assert.match(familyControl, /aria-label=\{label\}/);
  assert.match(familyControl, /aria-expanded=\{expanded\}/);
});

test("branch actions use distinct SVG silhouettes instead of font-dependent arrows", () => {
  assert.match(personCard, /<BranchControlIcon/);
  assert.match(familyControl, /<BranchControlIcon/);
  assert.match(icon, /direction === "parents"/);
  assert.match(icon, /direction === "partners"/);
  assert.match(icon, /direction === "siblings"/);
  assert.match(icon, /<svg viewBox="0 0 24 24"/);
});

test("branch controls have an opaque separated surface and keep counts inside the button", () => {
  assert.match(
    css,
    /\.ft-continuation,\s*\n\.ft-family-continuation \{[\s\S]*?border:\s*1\.5px solid/,
  );
  assert.match(
    css,
    /\.ft-continuation,\s*\n\.ft-family-continuation \{[\s\S]*?0 0 0 3px/,
  );
  assert.match(css, /touch-action:\s*none/);
  assert.match(
    css,
    /\.ft-branch-control-count \{[\s\S]*?top:\s*1px;[\s\S]*?right:\s*1px/,
  );
  assert.doesNotMatch(css, /\.ft-(?:family-)?continuation small\s*\{/);
  assert.match(css, /content:\s*attr\(data-tooltip\)/);
  assert.match(
    css,
    /\.ft-continuation:hover::after,[\s\S]*?transition-delay:\s*700ms/,
  );
  assert.match(
    css,
    /\.ft-continuation:focus-visible::after,[\s\S]*?visibility:\s*visible/,
  );
});

test("each branch meaning has a deliberately distinct high-contrast colour", () => {
  assert.match(
    css,
    /data-direction="parents"[\s\S]*?--ft-branch-control-accent:\s*#1769aa/,
  );
  assert.match(
    css,
    /data-direction="children"[\s\S]*?--ft-branch-control-accent:\s*#198754/,
  );
  assert.match(
    css,
    /data-direction="partners"[\s\S]*?--ft-branch-control-accent:\s*#7b3fa1/,
  );
  assert.match(
    css,
    /data-direction="siblings"[\s\S]*?--ft-branch-control-accent:\s*#c4570a/,
  );
  assert.match(
    css,
    /\.ft-family-continuation \{[\s\S]*?--ft-branch-control-accent:\s*#b23a48/,
  );
});
