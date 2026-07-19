import test from "node:test";
import assert from "node:assert/strict";
import { buildGedcomAppImport } from "../src/utils/gedcomAppImport.ts";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";

test("converts GEDCOM people and family links into app records", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Petro /Father/",
    "1 SEX M",
    "0 @I2@ INDI",
    "1 NAME Hanna /Birth/",
    "2 TYPE birth",
    "1 _MARNM Hanna /Married/",
    "2 GIVN Hanna",
    "2 SURN Married",
    "1 SEX F",
    "1 DEAT Y",
    "0 @I3@ INDI",
    "1 NAME Child /Father/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 6 JUN 1896",
    "2 PLAC Trubiivka",
    "1 FAMC @F1@",
    "2 PEDI birth",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "1 CHIL @I3@",
    "1 MARR",
    "2 DATE 1895",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    defaultResearchId: "research-1",
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  assert.equal(result.people.length, 3);
  assert.equal(result.relations.length, 3);
  assert.equal(result.people.every((person) => person.status === "доведена"), true);

  const mother = result.people.find((person) => person.givenName === "Hanna");
  assert.equal(mother?.surname, "Married");
  assert.equal(mother?.maidenSurname, "Birth");
  assert.equal(mother?.isLiving, false);
  assert.equal(mother?.researchId, "research-1");
  assert.equal(mother?.events.find((event) => event.type === "death")?.value, null);

  const child = result.people.find((person) => person.givenName === "Child");
  assert.equal(child?.birthDate, "1896-06-06");
  assert.equal(child?.birthPlace, "Trubiivka");

  const parentTypes = result.relations
    .filter((relation) => relation.personId === child?.id)
    .map((relation) => relation.relationType)
    .sort();
  assert.deepEqual(parentTypes, ["батько", "мати"]);
  assert.equal(result.relations.some((relation) => relation.relationType === "дружина"), true);
});

test("keeps adoptive parent imports separate from biological parent semantics", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Adoptive /Father/",
    "1 SEX M",
    "0 @I2@ INDI",
    "1 NAME Child /Family/",
    "1 FAMC @F1@",
    "2 PEDI adopted",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 CHIL @I2@",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relationType, "усиновлювач");
  assert.match(result.relations[0].evidenceText, /прийомний\/усиновлений/);
});
test("keeps MyHeritage private living people as living app persons", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Living /Private/",
    "1 RESN privacy",
    "0 @I2@ INDI",
    "1 NAME Deceased /Private/",
    "1 RESN privacy",
    "1 DEAT Y",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  const living = result.people.find((person) => person.givenName === "Living");
  const deceased = result.people.find((person) => person.givenName === "Deceased");

  assert.equal(living?.isLiving, true);
  assert.equal(living?.deathDate, "");
  assert.equal(deceased?.isLiving, false);
});

test("maps GEDCOM central person marker to imported app person id", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "1 _ROOT @I2@",
    "0 @I1@ INDI",
    "1 NAME First /Person/",
    "0 @I2@ INDI",
    "1 NAME Root /Person/",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  const root = result.people.find((person) => person.givenName === "Root");
  assert.equal(result.rootPersonId, root?.id);
});

test("infers maiden surname from primary birth name when MyHeritage married name is present", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Hanna /Birth/",
    "1 _MARNM Hanna /Married/",
    "2 SURN Married",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  assert.equal(result.people[0].surname, "Married");
  assert.equal(result.people[0].maidenSurname, "Birth");
});

test("creates findings from GEDCOM event descriptions with date, place and person link", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Hanna /Birth/",
    "1 BIRT",
    "2 DATE 6 JUN 1896",
    "2 PLAC Trubiivka",
    "3 MAP",
    "4 LATI N49.1234",
    "4 LONG E28.5678",
    "2 NOTE DAViO f. 123 op. 1 spr. 45",
    "2 CONT scan 12",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    defaultResearchId: "research-1",
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.researchId, "research-1");
  assert.equal(finding.eventDate, "1896-06-06");
  assert.equal(finding.place, "Trubiivka");
  assert.equal(finding.archive, "DAViO");
  assert.equal(finding.fund, "123");
  assert.equal(finding.description, "1");
  assert.equal(finding.file, "45");
  assert.equal(finding.page, "");
  assert.match(finding.transcription, /DAViO f\. 123 op\. 1 spr\. 45/);
  assert.match(String(finding.customFields.__gedcomArchiveReference), /"inventory":"1"/);
  assert.deepEqual(finding.personIds, [result.people[0].id]);
  assert.equal(finding.geo?.displayName, "Trubiivka");
  assert.equal(finding.geo?.latitude, 49.1234);
  assert.equal(finding.geo?.longitude, 28.5678);
  assert.equal(result.people[0].events.find((event) => event.type === "birth")?.geo?.latitude, 49.1234);
});

test("maps a Ukrainian archive cipher and act record into structured Finding fields", () => {
  let id = 0;
  const originalDescription = "ЦДІАК Ф127 О1014 С64 акруш 14 зв акт 14";
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Петро /Тестовий/",
    "1 BIRT",
    "2 DATE 1890",
    `2 NOTE ${originalDescription}`,
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  const finding = result.findings[0];
  assert.equal(finding.archive, "ЦДІАК");
  assert.equal(finding.fund, "127");
  assert.equal(finding.description, "1014");
  assert.equal(finding.file, "64");
  assert.equal(finding.page, "14 зв · актовий запис №14");
  assert.equal(finding.transcription, originalDescription);
  assert.match(finding.notes, /Актовий запис: 14/);
  assert.equal(finding.customFields.__gedcomArchiveActRecord, "14");
  assert.equal(finding.customFields.__gedcomEventDescription, originalDescription);
});

test("maps an archival cipher from a GEDCOM source citation without losing its text", () => {
  let id = 0;
  const originalDescription = "ЦДІАК Ф127 О.1012 справа 3507 аркуш 1370 актовий запис № 2";
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @S1@ SOUR",
    "1 TITL Метрична книга",
    "0 @I1@ INDI",
    "1 NAME Іван /Тестовий/",
    "1 BIRT",
    "2 DATE 1890",
    "2 SOUR @S1@",
    "3 DATA",
    `4 TEXT ${originalDescription}`,
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(result.documents.length, 0);
  assert.equal(finding.documentId, "");
  assert.equal(finding.archive, "ЦДІАК");
  assert.equal(finding.fund, "127");
  assert.equal(finding.description, "1012");
  assert.equal(finding.file, "3507");
  assert.equal(finding.page, "1370 · актовий запис №2");
  assert.equal(finding.transcription, originalDescription);
  assert.match(finding.notes, /Актовий запис: 2/);
});

test("deduplicates repeated GEDCOM family relations during app import", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Petro /Father/",
    "1 SEX M",
    "0 @I2@ INDI",
    "1 NAME Hanna /Mother/",
    "1 SEX F",
    "0 @I3@ INDI",
    "1 NAME Child /Family/",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "1 CHIL @I3@",
    "0 @F2@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "1 CHIL @I3@",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-05T00:00:00.000Z",
  });

  assert.equal(result.relations.length, 3);
});

test("creates a military finding from the MyHeritage EVEN value without requiring NOTE", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I500030@ INDI",
    "1 NAME Василь /Каленський/",
    "1 EVEN інформація з запису про шлюб",
    "2 TYPE Military Service",
    "2 DATE FROM ABT 1881 TO 13 DEC 1886",
    "2 PLAC 127 піхотний Путівльский полк",
    "2 AGE 20-25",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].findingType, "військовий документ");
  assert.equal(result.findings[0].description, "інформація з запису про шлюб");
  assert.equal(result.findings[0].place, "127 піхотний Путівльский полк");
  assert.equal(result.findings[0].customFields.__gedcomEventRawType, "Military Service");
  assert.equal(result.findings[0].customFields.__gedcomEventTag, "EVEN");
  assert.equal(result.findings[0].customFields.__gedcomEventValue, "інформація з запису про шлюб");

  const event = result.people[0].events.find((item) => item.type === "military");
  assert.equal(event?.value, "інформація з запису про шлюб");
  assert.equal(event?.age, "20-25");
  assert.equal(event?.notes, null);
});

test("classifies MH household books, Fact 1 revisions, confession lists, census and voter lists", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Марія /Тестова/",
    "1 EVEN стор.14зв.-15.",
    "2 TYPE Погосподарська книга №23",
    "2 DATE BET 1944 AND 1946",
    "1 EVEN Ревізійна казка ДАКО фонд 280 опис 2 справа 416 сторінка 65 запис №598",
    "2 TYPE Fact 1",
    "2 DATE 1832",
    "1 EVEN ЦДІАК Ф127 О.1015 справа 615 сторінка 515 двір 2",
    "2 TYPE Сповідний розпис",
    "2 DATE 1841",
    "1 CENS ЦДАВО Ф1390 о1 справа 68 сторінка 27",
    "2 DATE 1917",
    "1 EVEN ДАВіО Р.836 оп.2 спр.2 стор.61 №228",
    "2 TYPE Список виборців",
    "2 DATE 1923",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });

  assert.deepEqual(
    result.people[0].events.map((event) => event.type),
    ["household_register", "revision_list", "confession_list", "census", "census"],
  );
  assert.deepEqual(
    result.findings.map((finding) => finding.findingType),
    ["погосподарська книга", "ревізія", "сповідний розпис", "перепис", "перепис"],
  );
  const revision = result.findings.find((finding) => finding.findingType === "ревізія");
  assert.equal(revision?.fund, "280");
  assert.equal(revision?.description, "2");
  assert.equal(revision?.file, "416");
  assert.equal(revision?.page, "65 · актовий запис №598");
  assert.equal(revision?.customFields.__gedcomEventRawType, "Fact 1");
});

test("keeps standard event meaning when its note merely names another source type", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Іван /Тестовий/",
    "1 BIRT",
    "2 DATE 1890",
    "2 NOTE Рік народження вирахувано з перепису 1917 року",
    "0 TRLR",
  ].join("\n"));
  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });
  assert.equal(result.findings[0].findingType, "народження");
});

test("puts an act record into Finding.page even when the archival cipher has no page", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Іван /Тестовий/",
    "1 EVEN ЦДІАК Ф127 О.1012 справа 3191 актовий запис 14",
    "2 TYPE Fact 1",
    "0 TRLR",
  ].join("\n"));
  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });
  assert.equal(result.findings[0].page, "актовий запис №14");
});

test("deduplicates exact repeated GEDCOM events and citations without merging different origins", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @S1@ SOUR",
    "1 TITL Метрична книга",
    "0 @I1@ INDI",
    "1 NAME Петро /Тестовий/",
    "1 EVEN ДАКО фонд 280 опис 2 справа 416 сторінка 65",
    "2 TYPE Fact 1",
    "2 DATE 1832",
    "1 EVEN ДАКО фонд 280 опис 2 справа 416 сторінка 65",
    "2 TYPE Fact 1",
    "2 DATE 1832",
    "1 BIRT",
    "2 SOUR @S1@",
    "3 PAGE арк. 12",
    "2 SOUR @S1@",
    "3 PAGE арк. 12",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });

  assert.equal(result.findings.filter((finding) => finding.customFields.__gedcomEventRawType === "Fact 1").length, 1);
  assert.equal(result.findings.filter((finding) => finding.customFields.__gedcomCitation).length, 1);
  assert.equal(result.findings.length, 2);
});

test("keeps MyHeritage numeric citation ROLE as metadata instead of a human participant role", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @S1@ SOUR",
    "1 TITL Джерело",
    "0 @I1@ INDI",
    "1 NAME Петро /Тестовий/",
    "1 SOUR @S1@",
    "2 EVEN BIRT",
    "3 ROLE 40001:2036248047:",
    "2 DATA",
    "3 TEXT Архівний запис",
    "0 TRLR",
  ].join("\n"));
  const finding = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  }).findings[0];

  assert.equal(finding.participants[0].role, "Основна особа");
  assert.match(finding.participants[0].notes, /Зовнішній ідентифікатор ролі: 40001:2036248047:/);
  assert.doesNotMatch(finding.notes, /Роль: 40001/);
});

test("imports GEDCOM source URLs once into the dedicated finding field", () => {
  let id = 0;
  const sourceUrl = "https://example.test/records/42?person=ivan";
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @S1@ SOUR",
    `1 TITL Parish register · ${sourceUrl}`,
    `1 PUBL Online collection: ${sourceUrl}`,
    `1 TEXT Catalog entry ${sourceUrl}`,
    `1 _URL ${sourceUrl}`,
    "0 @I1@ INDI",
    "1 NAME Ivan /Test/",
    "1 BIRT",
    "2 DATE 1900",
    "2 SOUR @S1@",
    `3 PAGE p. 12 · ${sourceUrl}`,
    "3 DATA",
    `4 TEXT Birth entry ${sourceUrl}`,
    `3 NOTE Verified at ${sourceUrl}`,
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-19T00:00:00.000Z",
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.sourceUrl, sourceUrl);
  assert.equal(finding.documentId, "");
  assert.equal(finding.page, "p. 12");
  assert.equal(finding.transcription, "Birth entry");
  for (const visibleValue of [
    finding.archive,
    finding.fund,
    finding.description,
    finding.file,
    finding.page,
    finding.summary,
    finding.transcription,
    finding.notes,
  ]) {
    assert.doesNotMatch(visibleValue, /https?:\/\//u);
  }
  assert.match(String(finding.customFields.__gedcomCitation), /https:\/\/example\.test\/records\/42/);
});

test("keeps an uncited top-level GEDCOM source as a standalone finding", () => {
  let id = 0;
  const sourceUrl = "https://archive.example.test/catalog/uncited";
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @S9@ SOUR",
    "1 TITL Uncited catalog source",
    "1 AUTH State archive",
    `1 _URL ${sourceUrl}`,
    "0 @I1@ INDI",
    "1 NAME Ivan /Test/",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-19T00:00:00.000Z",
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].sourceUrl, sourceUrl);
  assert.equal(result.findings[0].summary, "Uncited catalog source");
  assert.deepEqual(result.findings[0].personIds, []);
  assert.equal(result.findings[0].customFields.__gedcomStandaloneSource, true);
});

test("creates findings for family-level and family-event GEDCOM citations", () => {
  let id = 0;
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @S1@ SOUR",
    "1 TITL Marriage register",
    "1 _URL https://example.test/marriages",
    "0 @S2@ SOUR",
    "1 TITL Family dossier",
    "1 _URL https://example.test/families",
    "0 @I1@ INDI",
    "1 NAME Petro /Test/",
    "0 @I2@ INDI",
    "1 NAME Hanna /Test/",
    "0 @F1@ FAM",
    "1 HUSB @I1@",
    "1 WIFE @I2@",
    "1 MARR",
    "2 DATE 1920",
    "2 SOUR @S1@",
    "3 PAGE p. 4",
    "1 SOUR @S2@",
    "2 PAGE folder 8",
    "0 TRLR",
  ].join("\n"));

  const result = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-19T00:00:00.000Z",
  });

  assert.equal(result.documents.length, 0);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((finding) => finding.sourceUrl).sort(),
    ["https://example.test/families", "https://example.test/marriages"],
  );
  assert.equal(result.findings.every((finding) => finding.personIds.length === 2), true);
  assert.ok(result.findings.some((finding) => finding.eventDate === "1920"));
});
