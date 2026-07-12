import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGedcomDisplayText } from "../src/utils/gedcomText.ts";

test("decodes double-encoded MyHeritage HTML into readable plain text", () => {
  assert.equal(
    normalizeGedcomDisplayText(
      "Відомості&amp;lt;br&amp;gt;&amp;lt;LinkName&amp;gt;Архів&amp;lt;/LinkName&amp;gt; &amp;lt;LinkURL&amp;gt;https://example.test/file&amp;lt;/LinkURL&amp;gt; &#039;запис&#039;",
    ),
    "Відомості\nАрхів https://example.test/file 'запис'",
  );
});

test("keeps GEDCOM escaped at-signs and ordinary archival text", () => {
  assert.equal(
    normalizeGedcomDisplayText("ЦДІАК Ф127 О.1012 справа 3191 сторінка 306; email a@@b.test"),
    "ЦДІАК Ф127 О.1012 справа 3191 сторінка 306; email a@b.test",
  );
});
