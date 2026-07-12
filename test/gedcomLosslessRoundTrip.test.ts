import test from "node:test";
import assert from "node:assert/strict";
import { buildGedcomAppImport } from "../src/utils/gedcomAppImport.ts";
import { buildGedcomImportDraft } from "../src/utils/gedcomImport.ts";
import { buildFamilyTreeProjection } from "../src/utils/familyTreeProjection.ts";
import { exportFamilyTreeProjectionToGedcom, parseGedcom, summarizeGedcom } from "../src/utils/gedcom.ts";
import { normalizePersonEvents, syncPersonEventsFromFields } from "../src/utils/geo.ts";

const richMyHeritageGedcom = [
  "0 HEAD",
  "1 SOUR MYHERITAGE",
  "2 VERS 5.5.1",
  "2 NAME MyHeritage Family Tree Builder",
  "1 LANG Ukrainian",
  "1 _PROJECT_GUID project-guid",
  "1 GEDC",
  "2 VERS 5.5.1",
  "2 FORM LINEAGE-LINKED",
  "1 CHAR UTF-8",
  "0 @S1@ SOUR",
  "1 TITL Метрична книга",
  "1 AUTH Державний архів",
  "1 TEXT Повний опис джерела",
  "1 _TYPE Church record",
  "1 RIN 7001",
  "0 @I100@ INDI",
  "1 NAME Олена /Каленська/",
  "2 GIVN Олена",
  "2 SURN Каленська",
  "2 _MARNM Завальна",
  "1 SEX F",
  "1 BIRT",
  "2 DATE BET 1900 і 1902",
  "2 PLAC Війтівка",
  "2 NOTE Метричний запис",
  "1 RESI",
  "2 DATE 1925",
  "2 ADDR",
  "3 ADR1 вул. Центральна, 1",
  "3 CITY Київ",
  "3 EMAIL olena@@example.com",
  "1 OCCU Вчителька",
  "2 DATE FROM 1920 TO 1940",
  "1 EDUC Педагогічний інститут",
  "2 DATE 1919",
  "1 NATI українка",
  "1 RELI православна",
  "1 NOTE Особиста нотатка",
  "1 SOUR @S1@",
  "2 PAGE https://example.test/source",
  "2 EVEN Record",
  "3 ROLE subject-42",
  "2 DATA",
  "3 DATE 8 JUL 2026",
  "3 TEXT Повна транскрипція",
  "2 QUAY 4",
  "1 OBJE",
  "2 FILE https://example.test/photo.jpg",
  "2 FORM jpg",
  "2 _FILESIZE 12345",
  "2 _PERSONALPHOTO Y",
  "2 _PRIM_CUTOUT Y",
  "2 _PHOTO_RIN 9001",
  "1 RIN 100",
  "1 _UID person-uid",
  "1 _VENDOR_FACT Значення постачальника",
  "1 FAMS @F10@",
  "0 @I200@ INDI",
  "1 NAME Петро /Завальний/",
  "1 SEX M",
  "1 DEAT Y",
  "2 AGE 70-71",
  "2 CAUS старість",
  "1 FAMS @F10@",
  "0 @I300@ INDI",
  "1 NAME Марія /Завальна/",
  "1 SEX F",
  "1 FAMC @F10@",
  "0 @F10@ FAM",
  "1 HUSB @I200@",
  "1 WIFE @I100@",
  "1 MARR",
  "2 DATE 1920",
  "2 PLAC Війтівка",
  "2 NOTE Церковний шлюб",
  "1 CHIL @I300@",
  "1 RIN 10",
  "1 _UID family-uid",
  "0 TRLR",
].join("\n");

test("imports rich MyHeritage facts into Tracker records", () => {
  const draft = buildGedcomImportDraft(richMyHeritageGedcom);
  let id = 0;
  const built = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });
  const person = built.people.find((item) => item.customFields.__gedcomXref === "@I100@")!;

  assert.equal(draft.sources?.[0]?.title, "Метрична книга");
  assert.equal(built.documents.length, 1);
  assert.equal(built.documents[0].title, "Метрична книга");
  assert.equal(draft.people[0].citations?.[0]?.text, "Повна транскрипція");
  assert.equal(draft.people[0].media?.[0]?.photoRin, "9001");
  assert.match(person.residencePlaces, /Київ/);
  assert.match(person.residencePlaces, /olena@example\.com/);
  assert.equal(person.occupation, "Вчителька");
  assert.equal(person.religion, "православна");
  assert.match(person.notes, /Національність: українка/);
  assert.equal(person.mentionScans.length, 0);
  assert.equal(person.photos?.length, 1);
  assert.equal(person.photos?.[0].storagePath, "https://example.test/photo.jpg");
  assert.equal(person.primaryPhotoId, person.photos?.[0].id);
  assert.ok(built.findings.some((finding) =>
    finding.transcription === "Повна транскрипція" && finding.documentId === built.documents[0].id));
  assert.equal(built.personIdByXref["@I100@"], person.id);
});

test("round-trips raw sources, citations, media, extensions and original xrefs", () => {
  const firstDraft = buildGedcomImportDraft(richMyHeritageGedcom);
  let id = 0;
  const built = buildGedcomAppImport(firstDraft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    treeId: "tree",
    persons: built.people,
    legacyRelations: built.relations,
    includeIsolatedPersons: true,
  });
  const exported = exportFamilyTreeProjectionToGedcom(projection, {
    sourceName: "Трекер Роду",
    createdAt: "2026-07-12",
    preservedRecords: firstDraft.preservedRecords,
  });
  const secondDraft = buildGedcomImportDraft(exported.text);
  const summary = summarizeGedcom(parseGedcom(exported.text));

  assert.equal(summary.individuals, 3);
  assert.equal(summary.families, 1);
  assert.equal(summary.sources, 1);
  assert.ok(exported.text.includes("0 @I100@ INDI\r\n"));
  assert.ok(exported.text.includes("0 @F10@ FAM\r\n"));
  assert.ok(exported.text.includes("1 _VENDOR_FACT Значення постачальника\r\n"));
  assert.ok(exported.text.includes("3 EMAIL olena@@example.com\r\n"));
  const roundTrippedPerson = secondDraft.people.find((person) => person.xref === "@I100@")!;
  assert.equal(roundTrippedPerson.citations?.[0]?.text, "Повна транскрипція");
  assert.equal(roundTrippedPerson.media?.[0]?.file, "https://example.test/photo.jpg");
  assert.equal(secondDraft.families[0].events.find((event) => event.eventType === "marriage")?.placeName, "Війтівка");
  assert.equal(secondDraft.people.find((person) => person.xref === "@I300@")?.vitalStatus, "unknown");
});

test("recovers an adopted FAMC link when a MyHeritage family omits reciprocal CHIL", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Дитина /Тестова/",
    "1 FAMC @F1@",
    "2 PEDI Adopted",
    "0 @I2@ INDI",
    "1 NAME Батько /Тестовий/",
    "0 @F1@ FAM",
    "1 HUSB @I2@",
    "0 TRLR",
  ].join("\n"));

  assert.equal(draft.parentChildRelationships.length, 1);
  assert.equal(draft.parentChildRelationships[0].relationshipType, "adoptive");
  assert.ok(draft.warnings.some((warning) => warning.code === "gedcom_famc_missing_reciprocal_child"));
});

test("exports Tracker documents and findings as GEDCOM sources and citations", () => {
  const draft = buildGedcomImportDraft(richMyHeritageGedcom);
  let id = 0;
  const built = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  });
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    treeId: "tree",
    persons: built.people,
    legacyRelations: built.relations,
  });
  const person = built.people.find((item) => item.customFields.__gedcomXref === "@I100@")!;
  const document = {
    ...built.documents[0],
    id: "tracker-document",
    title: "Нове джерело Трекера",
    customFields: {},
  };
  const finding = {
    ...built.findings[0],
    id: "tracker-finding",
    documentId: document.id,
    personIds: [person.id],
    people: person.fullName,
    personsText: person.fullName,
    findingType: "метричний запис",
    transcription: "Нова транскрипція Трекера",
    customFields: {},
  };
  const exported = exportFamilyTreeProjectionToGedcom(projection, {
    preservedRecords: draft.preservedRecords,
    documents: [document],
    findings: [finding],
  });

  assert.match(exported.text, /0 @S_TRK1@ SOUR\r\n1 TITL Нове джерело Трекера/);
  assert.match(exported.text, /1 SOUR @S_TRK1@\r\n2 EVEN метричний запис/);
  assert.match(exported.text, /3 TEXT Нова транскрипція Трекера/);
});

test("keeps multiple dated residence events through person persistence metadata", () => {
  const draft = buildGedcomImportDraft([
    "0 HEAD",
    "0 @I1@ INDI",
    "1 NAME Особа /Тестова/",
    "1 RESI",
    "2 DATE 1900",
    "2 ADDR Перша адреса",
    "1 RESI",
    "2 DATE 1910",
    "2 ADDR Друга адреса",
    "0 TRLR",
  ].join("\n"));
  let id = 0;
  const person = buildGedcomAppImport(draft, {
    idFactory: () => `id-${++id}`,
    nowFactory: () => "2026-07-12T00:00:00.000Z",
  }).people[0];

  const stored = syncPersonEventsFromFields(person);
  const loaded = normalizePersonEvents(stored, person);
  const residences = loaded.filter((event) => event.type === "residence");
  assert.equal(residences.length, 2);
  assert.deepEqual(residences.map((event) => event.date), ["1900", "1910"]);
  assert.deepEqual(residences.map((event) => event.placeName), ["Перша адреса", "Друга адреса"]);
});
