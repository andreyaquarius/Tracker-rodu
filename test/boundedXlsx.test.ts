import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { checkImportFileSize, TABLE_IMPORT_LIMITS, unzipBoundedXlsx } from "../src/utils/boundedXlsx.ts";

async function zip(text: string, name = "xl/worksheets/sheet1.xml") {
  return new JSZip().file(name, text).generateAsync({ type: "uint8array", compression: "DEFLATE" });
}
test("bounded XLSX accepts legitimate UTF-8 content without changing it", async () => {
  const original = '  - Мар’яна ѣ Ї\r\n=джерело ';
  const files = await unzipBoundedXlsx(await zip(original));
  assert.equal(new TextDecoder().decode(files.get("xl/worksheets/sheet1.xml")), original);
});
test("rejects compressed file before reading its contents", () => {
  assert.throws(() => checkImportFileSize(TABLE_IMPORT_LIMITS.compressedBytes + 1), /32/);
  assert.doesNotThrow(() => checkImportFileSize(1024));
});
test("rejects expanded ZIP budget even when compressed file is tiny", async () => {
  const bytes = await zip("a".repeat(1024 * 1024));
  assert.ok(bytes.length < 2048);
  await assert.rejects(unzipBoundedXlsx(bytes, undefined, { ...TABLE_IMPORT_LIMITS, entryBytes: 1024 }), /безпечні межі/);
});
test("counts declared unused entries in the total budget", async () => {
  const bytes = await new JSZip().file("xl/workbook.xml", "x").file("padding.bin", "x".repeat(8192)).generateAsync({ type: "uint8array", compression: "DEFLATE" });
  await assert.rejects(unzipBoundedXlsx(bytes, undefined, { ...TABLE_IMPORT_LIMITS, expandedBytes: 4096 }), /безпечні межі/);
});
test("stream enforces actual size even if central directory understates it", async () => {
  const bytes = await zip("a".repeat(64 * 1024));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 46; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, 8, true);
  }
  await assert.rejects(unzipBoundedXlsx(bytes), /безпечні межі/);
});
test("rejects traversal, malformed structure, excessive entries and cancellation", async () => {
  await assert.rejects(unzipBoundedXlsx(await zip("x", "../xl/a.xml")), /безпечні межі/);
  await assert.rejects(unzipBoundedXlsx(new Uint8Array(40)), /безпечні межі/);
  await assert.rejects(unzipBoundedXlsx(await zip("x"), undefined, { ...TABLE_IMPORT_LIMITS, entries: 1 }), /безпечні межі/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(unzipBoundedXlsx(await zip("x"), controller.signal), { name: "AbortError" });
});
test("does not allocate unused archive attachments", async () => {
  const files = await unzipBoundedXlsx(await zip("x".repeat(1000), "embedded.bin"));
  assert.equal(files.size, 0);
});
