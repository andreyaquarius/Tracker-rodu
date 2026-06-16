// Defence-in-depth against spreadsheet formula / DDE injection (CWE-1236).
//
// The XLSX writer emits user values as inline strings (t="inlineStr"), which
// Excel does not evaluate as formulas — but some consumers (older LibreOffice
// import paths, CSV re-export, Google Sheets) can. Prefix any value that begins
// with a formula trigger character with a single quote so it is always treated
// as literal text.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export function neutralizeSpreadsheetValue(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}
