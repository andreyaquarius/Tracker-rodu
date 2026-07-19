import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveEditorSectionAtViewport } from "../src/utils/personEditorSectionNavigation.ts";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a clicked editor section wins while programmatic navigation is settling", () => {
  const resolved = resolveEditorSectionAtViewport(
    "marriage",
    [
      { key: "birth", top: 120, bottom: 420 },
      { key: "marriage", top: 430, bottom: 710 },
    ],
    900,
  );

  assert.equal(resolved, "marriage");
});

test("manual scrolling compares every section by viewport-band overlap", () => {
  const resolved = resolveEditorSectionAtViewport(
    null,
    [
      { key: "birth", top: -180, bottom: 155 },
      { key: "marriage", top: 155, bottom: 620 },
      { key: "death", top: 632, bottom: 980 },
    ],
    900,
  );

  assert.equal(resolved, "marriage");
});

test("editor navigation uses one-click auto scrolling and stable separate controls", () => {
  const editor = source("../src/features/persons-v2/PersonEditorV2.tsx");
  const styles = source("../src/styles.css");

  assert.match(editor, /requestedSectionRef\.current = key/);
  assert.match(editor, /behavior:\s*"auto"/);
  assert.doesNotMatch(editor, /behavior:\s*"smooth"/);
  assert.match(editor, /aria-controls=\{`\$\{editorPrefix\}-\$\{section\.key\}`\}/);
  assert.match(styles, /\.person-editor-v2-summary \{[^}]*background:\s*var\(--paper\)[^}]*border:\s*1px solid var\(--line\)/s);
  assert.match(styles, /\.person-editor-v2-section-nav \{[^}]*gap:\s*7px[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.person-editor-v2-section-nav button \{[^}]*min-height:\s*42px[^}]*border:\s*1px solid var\(--line\)/s);
  assert.match(styles, /\.person-editor-v2-section-nav button:focus-visible/);
});
