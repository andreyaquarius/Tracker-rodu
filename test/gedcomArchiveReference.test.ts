import test from "node:test";
import assert from "node:assert/strict";
import { parseGedcomArchiveReference } from "../src/utils/gedcomArchiveReference.ts";

test("parses a compact Ukrainian archive reference", () => {
  assert.deepEqual(
    parseGedcomArchiveReference("ЦДІАК Ф127 О.1012 справа 3507 аркуш 1370"),
    {
      archive: "ЦДІАК",
      fund: "127",
      inventory: "1012",
      file: "3507",
      page: "1370",
      actRecord: "",
      originalText: "ЦДІАК Ф127 О.1012 справа 3507 аркуш 1370",
    },
  );
});

test("parses MyHeritage text without spaces between cipher components", () => {
  const parsed = parseGedcomArchiveReference("справа ЦДАВО Ф1390.оп1.справа68 сторінка 25");
  assert.equal(parsed?.archive, "ЦДАВО");
  assert.equal(parsed?.fund, "1390");
  assert.equal(parsed?.inventory, "1");
  assert.equal(parsed?.file, "68");
  assert.equal(parsed?.page, "25");
});

test("understands abbreviated Ukrainian markers and reverse-side page ranges", () => {
  const parsed = parseGedcomArchiveReference("ДАВіО Ф.904 оп.13 спр.85 стор.27зв.-28.");
  assert.equal(parsed?.archive, "ДАВіО");
  assert.equal(parsed?.fund, "904");
  assert.equal(parsed?.inventory, "13");
  assert.equal(parsed?.file, "85");
  assert.equal(parsed?.page, "27зв.-28");
});

test("supports short O and S markers plus the common аркуш typo", () => {
  const parsed = parseGedcomArchiveReference("ЦДІАК Ф127 О1014 С64 акруш 14 зв акт 14");
  assert.equal(parsed?.archive, "ЦДІАК");
  assert.equal(parsed?.fund, "127");
  assert.equal(parsed?.inventory, "1014");
  assert.equal(parsed?.file, "64");
  assert.equal(parsed?.page, "14 зв");
  assert.equal(parsed?.actRecord, "14");
});

test("keeps a full Ukrainian archive name", () => {
  const parsed = parseGedcomArchiveReference(
    "Державний архів Житомирської області, фонд 1, опис 77, справа 1848, сторінка 134, актовий запис № 27",
  );
  assert.equal(parsed?.archive, "Державний архів Житомирської області");
  assert.equal(parsed?.fund, "1");
  assert.equal(parsed?.inventory, "77");
  assert.equal(parsed?.file, "1848");
  assert.equal(parsed?.page, "134");
  assert.equal(parsed?.actRecord, "27");
});

test("parses Russian archival terminology", () => {
  const parsed = parseGedcomArchiveReference(
    "ЦГИАК ф. 19, оп. 127, д. 42, л. 8 об., актовая запись № 5",
  );
  assert.equal(parsed?.archive, "ЦГИАК");
  assert.equal(parsed?.fund, "19");
  assert.equal(parsed?.inventory, "127");
  assert.equal(parsed?.file, "42");
  assert.equal(parsed?.page, "8 об.");
  assert.equal(parsed?.actRecord, "5");
});

test("keeps a multi-token Russian archive abbreviation and prefixed fund", () => {
  const parsed = parseGedcomArchiveReference("ГА РФ, ф. Р-123, оп. 4, дело 56, стр. 10-11");
  assert.equal(parsed?.archive, "ГА РФ");
  assert.equal(parsed?.fund, "Р-123");
  assert.equal(parsed?.inventory, "4");
  assert.equal(parsed?.file, "56");
  assert.equal(parsed?.page, "10-11");
});

test("parses colon and number-sign separators", () => {
  const parsed = parseGedcomArchiveReference("Архів: ЦДІАК; фонд: № 127; опис: 1012; справа: 2043; арк.: 1248; запис: 10");
  assert.equal(parsed?.archive, "ЦДІАК");
  assert.equal(parsed?.fund, "127");
  assert.equal(parsed?.inventory, "1012");
  assert.equal(parsed?.file, "2043");
  assert.equal(parsed?.page, "1248");
  assert.equal(parsed?.actRecord, "10");
});

test("extracts the archive acronym after narrative text", () => {
  const source = "рік смерті зазначено в ревізії 1834 року ДАКО ф280 о2 справа 666 аркуш 385";
  const parsed = parseGedcomArchiveReference(source);
  assert.equal(parsed?.archive, "ДАКО");
  assert.equal(parsed?.fund, "280");
  assert.equal(parsed?.inventory, "2");
  assert.equal(parsed?.file, "666");
  assert.equal(parsed?.page, "385");
  assert.equal(parsed?.originalText, source);
});

test("supports a partial reference and an alphanumeric act record", () => {
  const parsed = parseGedcomArchiveReference("ЦДІАК справа 64 арк. 89 акт 3ж");
  assert.equal(parsed?.archive, "ЦДІАК");
  assert.equal(parsed?.fund, "");
  assert.equal(parsed?.inventory, "");
  assert.equal(parsed?.file, "64");
  assert.equal(parsed?.page, "89");
  assert.equal(parsed?.actRecord, "3ж");
});

test("returns null for prose without an archival cipher", () => {
  assert.equal(parseGedcomArchiveReference("Рік народження вирахувано приблизно зі слів родичів."), null);
  assert.equal(parseGedcomArchiveReference(""), null);
});
