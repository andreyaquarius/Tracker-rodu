import test from "node:test";
import assert from "node:assert/strict";
import { decodeGedcomBytes } from "../src/utils/gedcomEncoding.ts";

const encoder = new TextEncoder();

test("joins CRLF CONC boundaries before decoding a split UTF-8 character", () => {
  const bytes = joinBytes(
    "0 HEAD\r\n1 CHAR UTF-8\r\n0 @I1@ INDI\r\n1 NOTE Ки",
    [0xd1],
    "\r\n2 CONC ",
    [0x97],
    "в\r\n0 TRLR\r\n",
  );

  assert.match(new TextDecoder("utf-8").decode(bytes), /�/);
  assert.equal(
    decodeGedcomBytes(bytes.buffer),
    "0 HEAD\r\n1 CHAR UTF-8\r\n0 @I1@ INDI\r\n1 NOTE Київ\r\n0 TRLR\r\n",
  );
});

test("joins repeated LF CONC boundaries for a four-byte UTF-8 character", () => {
  const bytes = joinBytes(
    "0 @I1@ INDI\n1 NOTE Архів ",
    [0xf0],
    "\n2 CONC ",
    [0x9f],
    "\n2 CONC ",
    [0x93, 0x9a],
    "\n0 TRLR",
  );

  assert.equal(decodeGedcomBytes(bytes), "0 @I1@ INDI\n1 NOTE Архів 📚\n0 TRLR");
});

test("keeps CONT as a logical line break while folding a following CONC", () => {
  const bytes = encoder.encode([
    "0 @I1@ INDI",
    "1 NOTE Перший рядок",
    "2 CONT Другий ",
    "3 CONC рядок",
    "0 TRLR",
    "",
  ].join("\r\n"));

  assert.equal(
    decodeGedcomBytes(bytes),
    [
      "0 @I1@ INDI",
      "1 NOTE Перший рядок",
      "2 CONT Другий рядок",
      "0 TRLR",
      "",
    ].join("\r\n"),
  );
});

test("strips a UTF-8 BOM and honours a byte view offset", () => {
  const framed = joinBytes(
    [0x00, 0x00],
    [0xef, 0xbb, 0xbf],
    "0 HEAD\n1 CHAR UTF-8\n0 TRLR\n",
    [0x00],
  );
  const gedcomView = framed.subarray(2, framed.byteLength - 1);

  const decoded = decodeGedcomBytes(gedcomView);

  assert.equal(decoded, "0 HEAD\n1 CHAR UTF-8\n0 TRLR\n");
  assert.equal(decoded.charCodeAt(0), "0".charCodeAt(0));
});

test("does not fold tags that merely start with CONC", () => {
  const source = "0 HEAD\n1 CONCAT value\n0 TRLR";
  assert.equal(decodeGedcomBytes(encoder.encode(source)), source);
});

function joinBytes(...parts: Array<string | number[] | Uint8Array>): Uint8Array {
  const chunks = parts.map((part) => {
    if (typeof part === "string") return encoder.encode(part);
    return part instanceof Uint8Array ? part : Uint8Array.from(part);
  });
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
