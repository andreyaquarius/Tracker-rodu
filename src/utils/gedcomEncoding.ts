export type GedcomByteSource = ArrayBuffer | ArrayBufferView;

const BYTE_CR = 0x0d;
const BYTE_LF = 0x0a;
const BYTE_SPACE = 0x20;
const BYTE_TAB = 0x09;
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * Decodes a UTF-8 GEDCOM file without corrupting characters split by a
 * physical `CONC` continuation line.
 *
 * Some exporters apply the GEDCOM line-length limit to raw UTF-8 bytes. They
 * can therefore put the first bytes of a character at the end of one line and
 * the remaining bytes after `<level> CONC ` on the next line. Decoding the
 * original file first turns both fragments into replacement characters. We
 * remove the structural CONC boundary while the data is still bytes and only
 * then run UTF-8 decoding.
 *
 * `CONT` lines are deliberately not folded: they represent an intentional
 * line break in the GEDCOM value and remain available to the GEDCOM parser.
 */
export function decodeGedcomBytes(source: GedcomByteSource): string {
  const bytes = toUint8Array(source);
  const startOffset = hasUtf8Bom(bytes) ? UTF8_BOM.length : 0;
  const chunks: Uint8Array[] = [];
  let pendingLineBreak: Uint8Array | null = null;
  let outputLength = 0;
  let hasLogicalLine = false;

  const append = (chunk: Uint8Array) => {
    if (!chunk.byteLength) return;
    chunks.push(chunk);
    outputLength += chunk.byteLength;
  };

  forEachPhysicalLine(bytes, startOffset, (line, lineBreak) => {
    const concPayloadOffset = hasLogicalLine ? findConcPayloadOffset(line) : null;

    if (concPayloadOffset !== null) {
      // The previous physical line break and the ASCII GEDCOM continuation
      // prefix are structural, not part of the text being decoded.
      append(line.subarray(concPayloadOffset));
    } else {
      if (pendingLineBreak) append(pendingLineBreak);
      append(line);
      hasLogicalLine = true;
    }

    pendingLineBreak = lineBreak;
  });

  if (pendingLineBreak) append(pendingLineBreak);

  const joined = new Uint8Array(outputLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // TextDecoder normally consumes a UTF-8 BOM. The explicit replacement also
  // covers runtimes with different BOM behaviour and zero-copy byte views.
  return new TextDecoder("utf-8").decode(joined).replace(/^\uFEFF/, "");
}

function toUint8Array(source: GedcomByteSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= UTF8_BOM.length
    && bytes[0] === UTF8_BOM[0]
    && bytes[1] === UTF8_BOM[1]
    && bytes[2] === UTF8_BOM[2];
}

function forEachPhysicalLine(
  bytes: Uint8Array,
  startOffset: number,
  visit: (line: Uint8Array, lineBreak: Uint8Array | null) => void,
): void {
  let lineStart = startOffset;
  let cursor = startOffset;

  while (cursor < bytes.byteLength) {
    if (bytes[cursor] !== BYTE_CR && bytes[cursor] !== BYTE_LF) {
      cursor += 1;
      continue;
    }

    const lineEnd = cursor;
    if (bytes[cursor] === BYTE_CR && bytes[cursor + 1] === BYTE_LF) cursor += 2;
    else cursor += 1;

    visit(bytes.subarray(lineStart, lineEnd), bytes.subarray(lineEnd, cursor));
    lineStart = cursor;
  }

  if (lineStart < bytes.byteLength) {
    visit(bytes.subarray(lineStart), null);
  } else if (lineStart === startOffset && startOffset === bytes.byteLength) {
    // Preserve the fact that an empty file has one empty logical line without
    // introducing any output bytes.
    visit(bytes.subarray(lineStart, lineStart), null);
  }
}

function findConcPayloadOffset(line: Uint8Array): number | null {
  let cursor = 0;
  const firstDigit = cursor;
  while (cursor < line.byteLength && isAsciiDigit(line[cursor])) cursor += 1;
  if (cursor === firstDigit || !isHorizontalSpace(line[cursor])) return null;

  while (isHorizontalSpace(line[cursor])) cursor += 1;
  if (
    line[cursor] !== 0x43 // C
    || line[cursor + 1] !== 0x4f // O
    || line[cursor + 2] !== 0x4e // N
    || line[cursor + 3] !== 0x43 // C
  ) {
    return null;
  }
  cursor += 4;

  if (cursor === line.byteLength) return cursor;
  if (!isHorizontalSpace(line[cursor])) return null;

  // One byte is the GEDCOM tag/value delimiter. Further spaces belong to the
  // continuation value and must not be silently trimmed.
  return cursor + 1;
}

function isAsciiDigit(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39;
}

function isHorizontalSpace(byte: number | undefined): boolean {
  return byte === BYTE_SPACE || byte === BYTE_TAB;
}
