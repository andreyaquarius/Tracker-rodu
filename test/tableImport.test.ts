import test from "node:test";
import assert from "node:assert/strict";
import {
  isSupportedTableFileName,
  parseTableText,
  splitDelimitedLine,
  unsupportedTableFormatMessage,
} from "../src/utils/tableImport.ts";

test("parses CSV with Ukrainian headers and preserves source row numbers", () => {
  const parsed = parseTableText("Особа,Місце,Дата\nІван Петренко,Київ,1890-01-02\n,,\nМарія,Львів,", "знахідки.csv");
  assert.deepEqual(parsed.headers, ["Особа", "Місце", "Дата"]);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].sourceRowNumber, 2);
  assert.equal(parsed.rows[1].sourceRowNumber, 4);
  assert.equal(parsed.rows[0].values["Особа"], "Іван Петренко");
});

test("parses semicolon CSV and quoted delimiters", () => {
  const cells = splitDelimitedLine('Name;"Archive; fond";Year', ";");
  assert.deepEqual(cells, ["Name", "Archive; fond", "Year"]);
  const parsed = parseTableText('Name;Note\n"John Doe";"born; parish"', "people.csv");
  assert.equal(parsed.rows[0].values.Note, "born; parish");
});

test("keeps cells aligned when a header cell is blank", () => {
  const parsed = parseTableText(
    ",Birth date,Name,Father\n1,1852-02-08,Feodor,Andrii Khmaruk",
    "births.csv",
  );
  assert.deepEqual(parsed.headers, ["Колонка 1", "Birth date", "Name", "Father"]);
  assert.equal(parsed.rows[0].values["Колонка 1"], "1");
  assert.equal(parsed.rows[0].values["Birth date"], "1852-02-08");
  assert.equal(parsed.rows[0].values.Name, "Feodor");
});

test("parses JSON array tables", () => {
  const parsed = parseTableText(JSON.stringify([{ name: "Anna", year: 1901 }, { name: "Petro" }]), "rows.json");
  assert.deepEqual(parsed.headers, ["name", "year"]);
  assert.equal(parsed.rows[0].values.year, "1901");
  assert.equal(parsed.rows[1].values.year, "");
});

test("reports unsupported Excel files without pretending to parse them", () => {
  assert.equal(isSupportedTableFileName("records.xlsx"), false);
  assert.match(unsupportedTableFormatMessage("records.xlsx"), /Excel XLS\/XLSX/);
});
