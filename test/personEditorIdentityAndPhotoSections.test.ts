import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/persons-v2/PersonEditorV2.tsx", import.meta.url),
  "utf8",
);

function editorSection(key: string): string {
  const marker = `id={\`\${editorPrefix}-${key}\`}`;
  const markerIndex = editor.indexOf(marker);
  assert.notEqual(markerIndex, -1, `Expected editor section "${key}"`);

  const start = editor.lastIndexOf("<EditorSection", markerIndex);
  const closingTag = "</EditorSection>";
  const end = editor.indexOf(closingTag, markerIndex);

  assert.notEqual(start, -1, `Expected opening tag for editor section "${key}"`);
  assert.notEqual(end, -1, `Expected closing tag for editor section "${key}"`);
  return editor.slice(start, end + closingTag.length);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

test("person editor keeps identity and life status in the main section", () => {
  const main = editorSection("main");

  assert.match(main, /<span>Стать<\/span>[\s\S]*?value=\{form\.gender\}/u);
  assert.match(main, /<legend>Статус життя<\/legend>/u);
  assert.match(main, /checked=\{form\.isLiving\}[\s\S]*?updateLifeStatus\(true\)/u);
  assert.match(main, /checked=\{!form\.isLiving\}[\s\S]*?updateLifeStatus\(false\)/u);

  assert.equal(occurrences(editor, "value={form.gender}"), 1, "gender must not be duplicated");
  assert.equal(occurrences(editor, "checked={form.isLiving}"), 1, "living status must not be duplicated");
  assert.equal(occurrences(editor, "checked={!form.isLiving}"), 1, "deceased status must not be duplicated");
});

test("person photos have one dedicated editor section exposed in the sidebar", () => {
  assert.match(editor, /\{ key: "photos", label: "Фото" \}/u);

  const main = editorSection("main");
  const photo = editorSection("photos");

  assert.doesNotMatch(main, /Фотографії особи|Головне фото|PersonAvatarFramingEditorV2/u);
  assert.match(photo, /<ScanAttachmentsEditor[\s\S]*?title="Фотографії особи"/u);
  assert.match(photo, /<span>Головне фото<\/span>[\s\S]*?value=\{photoState\.primaryPhotoId\}/u);
  assert.match(photo, /<PersonAvatarFramingEditorV2/u);

  assert.equal(occurrences(editor, 'title="Фотографії особи"'), 1, "photo uploader must not be duplicated");
  assert.equal(occurrences(editor, "<PersonAvatarFramingEditorV2"), 1, "avatar framing must not be duplicated");
});
