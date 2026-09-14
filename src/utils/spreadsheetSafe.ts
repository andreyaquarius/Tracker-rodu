// Defence-in-depth against spreadsheet formula / DDE injection (CWE-1236).
//
// Apply ONLY to CSV copies. XLSX inlineStr must retain the original source text.
// CSV importers may discard leading whitespace/control characters before
// interpreting a formula; quoting the CSV field alone does not prevent this.
const FORMULA_TRIGGER = /^(?:[\t\r\n]|[\s\u0000-\u001f]*[=+\-@])/;

export function neutralizeSpreadsheetValue(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

export function spreadsheetCsvCell(value: unknown): string {
  return `"${neutralizeSpreadsheetValue(String(value ?? "")).replaceAll('"', '""')}"`;
}
