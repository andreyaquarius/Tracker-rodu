import type { AppDatabase } from "../types";
import {
  hasProjectBackupMarker,
  readDatabaseFromProjectBackupRows,
} from "./excelBackupFormat";

const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const MAX_BACKUP_SIZE = 100 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export async function readProjectExcelBackup(file: File): Promise<AppDatabase> {
  if (!file.name.toLocaleLowerCase("uk").endsWith(".xlsx")) {
    throw new Error("Виберіть Excel-копію проєкту у форматі XLSX.");
  }
  if (file.size > MAX_BACKUP_SIZE) {
    throw new Error("Розмір Excel-копії не може перевищувати 100 МБ.");
  }

  const entries = await readXlsxTextEntries(await file.arrayBuffer());
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml") ?? "");

  for (const [name, xml] of entries) {
    if (!/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) continue;
    const rows = parseWorksheetRows(xml, sharedStrings);
    if (hasProjectBackupMarker(rows)) {
      return readDatabaseFromProjectBackupRows(rows);
    }
  }

  throw new Error(
    "Цей Excel-файл не містить даних для відновлення. Завантажте копію, створену через «Експорт у Excel» після оновлення застосунку.",
  );
}

async function readXlsxTextEntries(buffer: ArrayBuffer): Promise<Map<string, string>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const entries = readCentralDirectory(view, bytes);
  const decoder = new TextDecoder();
  const result = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.name.endsWith(".xml") && !entry.name.endsWith(".rels")) continue;
    const data = await readEntryData(view, bytes, entry);
    result.set(entry.name, decoder.decode(data));
  }

  return result;
}

function readCentralDirectory(view: DataView, bytes: Uint8Array): ZipEntry[] {
  const endOffset = findEndOfCentralDirectory(view);
  const totalEntries = view.getUint16(endOffset + 10, true);
  let offset = view.getUint32(endOffset + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let index = 0; index < totalEntries; index += 1) {
    ensureSignature(view, offset, ZIP_CENTRAL_DIRECTORY_FILE_HEADER, "центральний каталог XLSX");
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const fileNameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > bytes.length) throw new Error("Excel-файл пошкоджений.");
    const name = decoder.decode(bytes.slice(nameStart, nameEnd));

    if (!name.endsWith("/")) {
      entries.push({ name, method, compressedSize, localHeaderOffset });
    }
    offset = nameEnd + extraLength + commentLength;
  }

  return entries;
}

async function readEntryData(
  view: DataView,
  bytes: Uint8Array,
  entry: ZipEntry,
): Promise<Uint8Array> {
  ensureSignature(view, entry.localHeaderOffset, ZIP_LOCAL_FILE_HEADER, "файл XLSX");
  const fileNameLength = view.getUint16(entry.localHeaderOffset + 26, true);
  const extraLength = view.getUint16(entry.localHeaderOffset + 28, true);
  const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error("Excel-файл пошкоджений.");
  const compressed = bytes.slice(dataStart, dataEnd);

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return inflateRaw(compressed);

  throw new Error("Excel-файл має непідтримуваний спосіб стиснення.");
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const StreamConstructor = (
    globalThis as unknown as {
      DecompressionStream?: new (
        format: string,
      ) => TransformStream<Uint8Array, Uint8Array>;
    }
  ).DecompressionStream;
  if (!StreamConstructor) {
    throw new Error(
      "Браузер не може розпакувати цей XLSX-файл. Спробуйте завантажити оригінальну копію, створену застосунком.",
    );
  }

  const stream = new Blob([data]).stream().pipeThrough(new StreamConstructor("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 22 - 0xffff);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  throw new Error("Не вдалося прочитати XLSX-файл. Перевірте, чи він не пошкоджений.");
}

function ensureSignature(
  view: DataView,
  offset: number,
  expected: number,
  label: string,
): void {
  if (offset < 0 || offset + 4 > view.byteLength || view.getUint32(offset, true) !== expected) {
    throw new Error(`Excel-файл пошкоджений: не знайдено ${label}.`);
  }
}

function parseSharedStrings(xml: string): string[] {
  if (!xml) return [];
  const doc = parseXml(xml, "sharedStrings.xml");
  return elementsByName(doc, "si").map((item) =>
    elementsByName(item, "t").map((text) => text.textContent ?? "").join("")
  );
}

function parseWorksheetRows(xml: string, sharedStrings: string[]): string[][] {
  const doc = parseXml(xml, "аркуш XLSX");
  return elementsByName(doc, "row").map((row) => {
    const output: string[] = [];
    let fallbackColumn = 0;
    for (const cell of elementsByName(row, "c")) {
      const columnIndex = columnIndexFromReference(cell.getAttribute("r"), fallbackColumn);
      output[columnIndex] = cellText(cell, sharedStrings);
      fallbackColumn = columnIndex + 1;
    }
    return output.map((value) => value ?? "");
  });
}

function cellText(cell: Element, sharedStrings: string[]): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return elementsByName(cell, "t").map((item) => item.textContent ?? "").join("");
  }
  const raw = elementsByName(cell, "v")[0]?.textContent ?? "";
  if (type === "s") return sharedStrings[Number(raw)] ?? "";
  if (type === "b") return raw === "1" ? "TRUE" : "FALSE";
  return raw;
}

function parseXml(xml: string, label: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error(`Не вдалося прочитати ${label}.`);
  }
  return doc;
}

function elementsByName(parent: Document | Element, localName: string): Element[] {
  return Array.from(parent.getElementsByTagNameNS("*", localName));
}

function columnIndexFromReference(reference: string | null, fallback: number): number {
  const letters = reference?.match(/^[A-Z]+/i)?.[0];
  if (!letters) return fallback;
  return letters
    .toUpperCase()
    .split("")
    .reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}
