export interface ParsedTableRow {
  sourceRowNumber: number;
  values: Record<string, string>;
}

export interface ParsedTable {
  headers: string[];
  rows: ParsedTableRow[];
  warnings: string[];
}

const supportedExtensions = new Set(["csv", "tsv", "txt", "json"]);

export function supportedTableExtensions(): string[] {
  return Array.from(supportedExtensions);
}

export function isSupportedTableFileName(fileName: string): boolean {
  const extension = fileName.split(".").pop()?.toLocaleLowerCase("uk") ?? "";
  return supportedExtensions.has(extension);
}

export function unsupportedTableFormatMessage(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLocaleLowerCase("uk") || "невідомий";
  if (extension === "xlsx" || extension === "xls") {
    return "Excel XLS/XLSX ще не підтримується в цій збірці без бібліотеки читання Excel. Збережіть файл як CSV UTF-8 і імпортуйте CSV.";
  }
  return `Формат .${extension} не підтримується. Завантажте CSV, TSV, TXT або JSON.`;
}

export function parseTableText(input: string, fileName = "table.csv"): ParsedTable {
  const text = input.trim();
  if (!text) return { headers: [], rows: [], warnings: ["Таблиця порожня."] };
  if (fileName.toLocaleLowerCase("uk").endsWith(".json") || looksLikeJson(text)) {
    return parseJsonTable(text);
  }
  return parseDelimitedTable(text, preferredDelimiter(text, fileName));
}

function parseJsonTable(text: string): ParsedTable {
  try {
    const parsed = JSON.parse(text) as unknown;
    const items = Array.isArray(parsed) ? parsed : asRecord(parsed).rows;
    if (!Array.isArray(items)) {
      return { headers: [], rows: [], warnings: ["JSON має бути масивом об’єктів або містити поле rows."] };
    }
    const records = items.filter(isRecord);
    const headers = Array.from(new Set(records.flatMap((record) => Object.keys(record))));
    const rows = records
      .map((record, index) => ({
        sourceRowNumber: index + 1,
        values: Object.fromEntries(headers.map((header) => [header, stringifyCell(record[header])])),
      }))
      .filter((row) => !isEmptyRow(row.values));
    return { headers, rows, warnings: rows.length ? [] : ["JSON не містить заповнених рядків."] };
  } catch {
    return { headers: [], rows: [], warnings: ["JSON має неправильний формат."] };
  }
}

function parseDelimitedTable(text: string, delimiter: string): ParsedTable {
  const rawLines = text.split(/\r?\n/);
  const nonEmptyLines = rawLines
    .map((line, index) => ({ line, sourceRowNumber: index + 1 }))
    .filter(({ line }) => line.trim());
  if (nonEmptyLines.length < 2) {
    return { headers: [], rows: [], warnings: ["Потрібен рядок заголовків і хоча б один рядок даних."] };
  }
  const headerLineIndex = findHeaderLineIndex(nonEmptyLines.map(({ line }) => line), delimiter);
  const headerSourceRow = nonEmptyLines[headerLineIndex];
  const headers = splitDelimitedLine(headerSourceRow.line, delimiter)
    .map((header) => header.trim())
    .filter(Boolean);
  if (!headers.length) return { headers: [], rows: [], warnings: ["Не знайдено заголовки колонок."] };

  const rows = nonEmptyLines.slice(headerLineIndex + 1)
    .map(({ line, sourceRowNumber }) => {
      const cells = splitDelimitedLine(line, delimiter);
      return {
        sourceRowNumber,
        values: Object.fromEntries(headers.map((header, index) => [header, cells[index]?.trim() ?? ""])),
      };
    })
    .filter((row) => !isEmptyRow(row.values));

  return {
    headers,
    rows,
    warnings: rows.length ? [] : ["Після заголовків немає заповнених рядків."],
  };
}

function findHeaderLineIndex(lines: string[], delimiter: string): number {
  let bestIndex = 0;
  let bestScore = -1;
  lines.slice(0, 10).forEach((line, index) => {
    const cells = splitDelimitedLine(line, delimiter).map((cell) => cell.trim()).filter(Boolean);
    const score = cells.length + cells.filter((cell) => /[A-Za-zА-Яа-яІіЇїЄєҐґ]/.test(cell)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function preferredDelimiter(text: string, fileName: string): string {
  const lowerName = fileName.toLocaleLowerCase("uk");
  if (lowerName.endsWith(".tsv")) return "\t";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const candidates = ["\t", ";", ","];
  return candidates
    .map((delimiter) => ({ delimiter, count: splitDelimitedLine(firstLine, delimiter).length }))
    .sort((left, right) => right.count - left.count)[0]?.delimiter ?? ",";
}

export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  result.push(current);
  return result;
}

function looksLikeJson(text: string): boolean {
  return text.startsWith("[") || text.startsWith("{");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringifyCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isEmptyRow(values: Record<string, string>): boolean {
  return Object.values(values).every((value) => !value.trim());
}
