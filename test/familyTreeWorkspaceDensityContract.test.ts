import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layout = readFileSync(
  new URL("../src/components/Layout.tsx", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/pages/ProductionFamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const viewport = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/FamilyTreeViewport.tsx",
    import.meta.url,
  ),
  "utf8",
);
const appCss = readFileSync(
  new URL("../src/styles.css", import.meta.url),
  "utf8",
);
const treeCss = readFileSync(
  new URL(
    "../src/features/family-tree-view/react/familyTree.css",
    import.meta.url,
  ),
  "utf8",
);

test("tree workspace uses the dynamic viewport instead of a laptop-hostile minimum height", () => {
  assert.match(layout, /main-shell-family-tree/);
  assert.match(
    appCss,
    /\.main-shell-family-tree\s*\{[^}]*--tree-topbar-height:\s*58px;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s,
  );
  assert.match(
    appCss,
    /\.family-tree-page\s*\{[^}]*flex:\s*1 1 0;[^}]*height:\s*auto;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
  );
  assert.doesNotMatch(appCss, /\.family-tree-page\s*\{[^}]*min-height:\s*720px;/s);
  assert.doesNotMatch(appCss, /\.family-tree-v2-shell\s*\{[^}]*min-height:\s*620px;/s);
  assert.match(appCss, /@media\s*\(max-height:\s*820px\)/);
  assert.match(appCss, /@media\s*\(max-height:\s*650px\)/);
});

test("secondary tree fields open in a dismissible overlay instead of adding toolbar rows", () => {
  assert.match(page, /useDismissibleDetails\(\)/);
  assert.match(
    page,
    /className="panel family-tree-v2-host-toolbar"\s+role="toolbar"/,
  );
  assert.match(page, /className="family-tree-v2-view-settings"/);
  assert.match(page, /aria-label="Знайти особу"/);
  assert.match(
    page,
    /aria-controls="family-tree-v2-view-settings-panel"/,
  );
  assert.match(page, /id="family-tree-v2-view-settings-panel"/);
  assert.match(
    appCss,
    /\.family-tree-v2-view-settings-panel\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*80;/s,
  );
  assert.doesNotMatch(
    appCss,
    /@media\s*\(max-width:\s*1380px\)[\s\S]*?\.family-tree-v2-history\s*\{[^}]*flex:\s*1 0 100%;/,
  );
  assert.match(
    appCss,
    /@media\s*\(max-width:\s*1380px\)[\s\S]*?\.family-tree-v2-search\s*>\s*span\s*\{[^}]*display:\s*none;/,
  );
  assert.doesNotMatch(appCss, /max-height:\s*210px;\s*\n\s*overflow-y:\s*auto;/);
  assert.match(
    appCss,
    /@media\s*\(max-height:\s*820px\)[\s\S]*?\.family-tree-v2-search\s*>\s*span\s*\{[^}]*display:\s*none;/,
  );
});

test("status chrome and canvas controls no longer reserve separate full-width rows", () => {
  assert.match(page, /className="family-tree-v2-status-strip"/);
  assert.match(
    appCss,
    /@media\s*\(max-height:\s*820px\)[\s\S]*?\.family-tree-v2-status-strip\s*\{[^}]*position:\s*absolute;/,
  );
  assert.match(
    viewport,
    /className="ft-toolbar"\s+role="toolbar"\s+aria-label="Керування полотном дерева"/,
  );
  assert.match(
    treeCss,
    /\.ft-root\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\);/s,
  );
  assert.match(
    treeCss,
    /\.ft-toolbar\s*\{[^}]*position:\s*absolute;[^}]*min-height:\s*38px;/s,
  );
  assert.match(
    treeCss,
    /\.ft-viewport\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;/s,
  );
});
