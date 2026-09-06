import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { clipboardImageFiles, consumeClipboardImagePaste, readClipboardImageFiles } from "../src/utils/clipboardImages.ts";

const now = new Date("2026-09-06T12:34:56.123Z");
const screenshot = () => new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
const transfer = (file: File) => ({
  items: [{ kind: "file", type: file.type, getAsFile: () => file }],
  files: [file],
});

test("paste creates one named screenshot, not duplicates from items and files", async () => {
  const image = screenshot();
  const files = clipboardImageFiles(transfer(image), now);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "screenshot-2026-09-06T12-34-56-123Z-1.png");
  assert.equal(files[0].type, "image/png");
  assert.equal(files[0].lastModified, now.getTime());
  assert.deepEqual(await files[0].arrayBuffer(), await image.arrayBuffer());
});

test("file-list fallback handles browsers without readable file items", () => {
  assert.equal(clipboardImageFiles({ items: [], files: [screenshot()] }).length, 1);
  assert.equal(clipboardImageFiles({ items: [{ kind: "file", type: "image/png", getAsFile: () => null }], files: [screenshot()] }).length, 1);
});

test("text, HTML, URLs, and non-image files remain ordinary paste", () => {
  const data = { items: [{ kind: "string", type: "text/html", getAsFile: () => null }], files: [new File(["hello"], "note.txt", { type: "text/plain" })] };
  assert.deepEqual(clipboardImageFiles(data), []);
  assert.deepEqual(clipboardImageFiles(null), []);
  let prevented = false;
  assert.equal(consumeClipboardImagePaste({ clipboardData: data, defaultPrevented: false, preventDefault: () => { prevented = true; } }, () => assert.fail("must not upload text")), false);
  assert.equal(prevented, false);
});

test("image paste suppresses default only when delivering image files", () => {
  let prevented = false;
  let delivered: File[] = [];
  assert.equal(consumeClipboardImagePaste({ clipboardData: transfer(screenshot()), defaultPrevented: false, preventDefault: () => { prevented = true; } }, (files) => { delivered = files; }), true);
  assert.equal(prevented, true);
  assert.equal(delivered.length, 1);
});

test("already handled paste is not processed twice", () => {
  assert.equal(consumeClipboardImagePaste({ clipboardData: transfer(screenshot()), defaultPrevented: true, preventDefault: () => assert.fail() }, () => assert.fail()), false);
});

test("multiple clipboard images keep individual names and original formats", () => {
  const files = clipboardImageFiles({ items: [], files: [screenshot(), new File(["jpeg"], "image.jpg", { type: "image/jpeg" })] }, now);
  assert.equal(files.length, 2);
  assert.match(files[1].name, /-2\.jpg$/);
  assert.equal(files[1].type, "image/jpeg");
});

test("explicit clipboard read selects one image representation per item, preferring PNG", async () => {
  const typesRead: string[] = [];
  const files = await readClipboardImageFiles(async () => [
    { types: ["text/html", "image/jpeg", "image/png"], getType: async (type) => { typesRead.push(type); return screenshot(); } },
    { types: ["text/plain"], getType: async () => { assert.fail("must not read text"); } },
  ], now);
  assert.deepEqual(typesRead, ["image/png"]);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "screenshot-2026-09-06T12-34-56-123Z-1.png");
});

test("empty clipboard is not an attachment; denied permission propagates for Ctrl+V fallback", async () => {
  assert.deepEqual(await readClipboardImageFiles(async () => []), []);
  const denied = new Error("NotAllowedError");
  await assert.rejects(readClipboardImageFiles(async () => { throw denied; }), (error) => error === denied);
});

const editor = readFileSync(new URL("../src/components/ScanAttachments.tsx", import.meta.url), "utf8");
const crud = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");

test("paste is opted into only for findings and scoped to the matching form and dialog", () => {
  assert.match(crud, /allowClipboardImages=\{config\.collection === "findings"\}/);
  assert.match(editor, /allowClipboardImages = false/);
  assert.match(editor, /const scope = editor\.closest\("form"\) \?\? editor/);
  assert.match(editor, /target\.closest\("form"\) !== editor\.closest\("form"\)/);
  assert.match(editor, /target\.closest\('\[role="dialog"\]'\) !== editor\.closest\('\[role="dialog"\]'\)/);
  assert.match(editor, /scope\.removeEventListener\("paste"/);
  assert.doesNotMatch(editor, /(?:document|window)\.addEventListener\("paste"/);
});

test("clipboard shares standard upload policy, folder, progress and attachment metadata", () => {
  assert.match(editor, /const pasteImages[\s\S]*?await addFiles\(files\)/);
  assert.match(editor, /const pasteFromClipboard[\s\S]*?await addFiles\(files\)/);
  assert.match(editor, /saveScan\(file, policy, \{\s*driveFolderPath,\s*onUploadProgress:/);
  assert.match(editor, /onChange\(\[\.\.\.scansRef\.current, \.\.\.added\]\)/);
  assert.match(editor, /if \(maxFiles && scans\.length \+ selected\.length > maxFiles\)/);
  assert.match(editor, /if \(uploadBlockedMessage\)/);
  assert.match(editor, /uploadPendingRef\.current = true/);
});

test("finding save and close cannot race the screenshot upload", () => {
  assert.match(crud, /const closeEditor[\s\S]*?if \(attachmentPendingRef\.current\)/);
  assert.match(crud, /const submit[\s\S]*?if \(attachmentPendingRef\.current\)/);
  assert.match(crud, /const persistExistingFindingDraft[\s\S]*?if \(attachmentPendingRef\.current\)/);
  assert.match(crud, /type="submit"[^>]*disabled=\{savePending \|\| attachmentPending\}/);
  assert.match(crud, /scanDisabled=\{savePending\}/);
});
