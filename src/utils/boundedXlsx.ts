// Limits apply before allocation and while reading actual decompressed chunks;
// attacker-controlled ZIP size declarations are not trusted as the only check.
export const TABLE_IMPORT_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  entryBytes: 32 * 1024 * 1024,
  entries: 512,
  rows: 100_000,
  columns: 512,
  cells: 1_000_000,
  milliseconds: 20_000,
});
export type ImportLimits = typeof TABLE_IMPORT_LIMITS;

export function checkImportFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > TABLE_IMPORT_LIMITS.compressedBytes) {
    throw new Error("Файл завеликий для табличного імпорту (максимум 32 МіБ). Розділіть його на частини.");
  }
}

export async function unzipBoundedXlsx(
  bytes: Uint8Array,
  signal?: AbortSignal,
  limits: ImportLimits = TABLE_IMPORT_LIMITS,
): Promise<Map<string, Uint8Array>> {
  const fail = (): never => { throw new Error("Excel-файл пошкоджений або перевищує безпечні межі імпорту. Розділіть таблицю на частини."); };
  const started = Date.now();
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() - started > limits.milliseconds) fail();
  };
  check();
  if (bytes.byteLength > limits.compressedBytes || bytes.byteLength < 22) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.byteLength) fail();
  };
  let end = -1;
  for (let p = bytes.byteLength - 22; p >= Math.max(0, bytes.byteLength - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50 && p + 22 + view.getUint16(p + 20, true) === bytes.byteLength) { end = p; break; }
  }
  if (end < 0) fail();
  const count = view.getUint16(end + 10, true);
  if (!count || count > limits.entries || view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count) fail();
  let offset = view.getUint32(end + 16, true);
  const directoryEnd = offset + view.getUint32(end + 12, true);
  if (directoryEnd !== end) fail(); // ZIP64 and multi-volume files are unsupported.
  const descriptors: Array<{ name: string; method: number; start: number; compressed: number; expanded: number }> = [];
  const names = new Set<string>();
  let declaredTotal = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let i = 0; i < count; i++) {
    check(); range(offset, 46);
    if (view.getUint32(offset, true) !== 0x02014b50) fail();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const expanded = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const recordLength = 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    range(offset, recordLength);
    if (offset + recordLength > directoryEnd || flags & 1 || ![0, 8].includes(method)) fail();
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..") || names.has(name)) fail();
    names.add(name);
    declaredTotal += expanded;
    if (expanded > limits.entryBytes || declaredTotal > limits.expandedBytes) fail();
    const local = view.getUint32(offset + 42, true);
    range(local, 30);
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) & 1) fail();
    const localNameLength = view.getUint16(local + 26, true);
    const start = local + 30 + localNameLength + view.getUint16(local + 28, true);
    range(local + 30, localNameLength); range(start, compressed);
    if (start + compressed > view.getUint32(end + 16, true) || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name) fail();
    descriptors.push({ name, method, start, compressed, expanded });
    offset += recordLength;
  }
  if (offset !== directoryEnd) fail();
  const files = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const entry of descriptors) {
    check();
    // No need to expand unrelated images, embedded workbooks or executables.
    if (!(entry.name.startsWith("xl/") && /\.(?:xml|rels)$/.test(entry.name))) continue;
    const input = bytes.subarray(entry.start, entry.start + entry.compressed);
    let result: Uint8Array;
    if (entry.method === 0) {
      if (input.byteLength !== entry.expanded) fail();
      result = input;
    } else {
      if (typeof DecompressionStream === "undefined") throw new Error("Браузер не підтримує XLSX. Збережіть таблицю як CSV.");
      const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let timedOut = false;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, limits.milliseconds - (Date.now() - started)));
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          check();
          const part = await reader.read();
          check();
          if (timedOut) fail();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > entry.expanded || size > limits.entryBytes || actualTotal + size > limits.expandedBytes) fail();
          chunks.push(part.value);
        }
        if (size !== entry.expanded) fail();
        result = new Uint8Array(size);
        let cursor = 0;
        for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.byteLength; }
      } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", cancel);
        cancel(); reader.releaseLock();
      }
    }
    actualTotal += result.byteLength;
    if (actualTotal > limits.expandedBytes) fail();
    files.set(entry.name, result);
  }
  check();
  return files;
}
