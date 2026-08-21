import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const detailDialogSource = readFileSync(
  new URL("../src/components/zagulyaky/ZagulyakaDetailDialog.tsx", import.meta.url),
  "utf8",
);
const catalogStyles = readFileSync(
  new URL("../src/pages/ZagulyakyPage.css", import.meta.url),
  "utf8",
);

test("keeps Zagulyaky source-text cards compact and content-first", () => {
  assert.match(
    detailDialogSource,
    /<span className="eyebrow">Мова джерела<\/span>\s*<p>\{detail\.originalText \|\| "—"\}<\/p>/s,
  );
  assert.match(
    detailDialogSource,
    /<span className="eyebrow">Українська<\/span>\s*<p>\{detail\.normalizedTextUk \|\| "—"\}<\/p>/s,
  );
  assert.doesNotMatch(detailDialogSource, /<h3>Транскрипція<\/h3>/);
  assert.doesNotMatch(detailDialogSource, /<h3>Нормалізований опис<\/h3>/);
  assert.match(
    catalogStyles,
    /\.zagulyaky-transcription-grid \.eyebrow\s*\{[^}]*font-size:\s*9px/s,
  );
  assert.match(
    catalogStyles,
    /\.zagulyaky-transcription-grid p\s*\{[^}]*font-size:\s*13px/s,
  );
});
