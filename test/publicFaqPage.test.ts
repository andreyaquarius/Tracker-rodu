import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseAppRoute } from "../src/utils/appRoutes.ts";
import { publicFaqSections } from "../src/utils/publicFaqContent.ts";

test("FAQ has a public route available without a project", () => {
  assert.deepEqual(parseAppRoute("/faq"), { kind: "public", page: "faq" });
  assert.deepEqual(parseAppRoute("/faq/"), { kind: "public", page: "faq" });
});

test("FAQ content covers the main application workflows", () => {
  assert.ok(publicFaqSections.length >= 5);
  assert.ok(publicFaqSections.reduce((total, section) => total + section.items.length, 0) >= 20);

  const ids = publicFaqSections.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length);

  const combinedText = publicFaqSections
    .flatMap((section) => section.items)
    .map((item) => `${item.question} ${item.answer}`)
    .join(" ");

  for (const requiredTopic of [
    "родове дерево",
    "GEDCOM",
    "Google Drive",
    "резервні копії",
    "аналітику",
  ]) {
    assert.match(combinedText, new RegExp(requiredTopic, "i"), requiredTopic);
  }
});

test("standalone FAQ page keeps the same public entry points", () => {
  const html = readFileSync(
    new URL("../public/faq/index.html", import.meta.url),
    "utf8",
  );

  assert.match(html, /<h1>Часті запитання про Трекер Роду<\/h1>/);
  assert.match(html, /href="\/faq" aria-current="page"/);
  assert.match(html, /Чому фотографії з GEDCOM можуть не завантажитися\?/);
  assert.match(html, /Як працюють автоматичні резервні копії\?/);
  assert.match(html, /data-analytics-mode="auto-public"/);
});
