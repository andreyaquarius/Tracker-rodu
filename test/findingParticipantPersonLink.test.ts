import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  findingParticipantFromStorage,
  findingParticipantPersonIdForStorage,
  findingLinkedPersonIds,
  findingLinksPerson,
  findingStandalonePersonIds,
} from "../src/utils/findingParticipantLinks.ts";
import {
  cloneDatabaseForProjectImport,
  createEmptyDatabase,
  normalizeDatabase,
} from "../src/utils/database.ts";
import { parseFindingParticipantTableCell } from "../src/utils/findingParticipantTableCell.ts";

test("legacy text-only participants and canonical person links both hydrate safely", () => {
  assert.deepEqual(
    findingParticipantFromStorage({
      id: "participant-1",
      person_id: null,
      name: "Петро зі Сміли",
      role: "Свідок",
      notes: "Записано без зіставлення",
    }),
    {
      id: "participant-1",
      personId: undefined,
      name: "Петро зі Сміли",
      role: "Свідок",
      notes: "Записано без зіставлення",
    },
  );

  assert.equal(
    findingParticipantFromStorage({
      id: "participant-2",
      person_id: "person-2",
      name: "Петро Іванович",
      role: "Хрещений батько",
      notes: "",
    }).personId,
    "person-2",
  );
});

test("storage keeps only a person link from the current project snapshot", () => {
  const validPersonIds = new Set(["person-1"]);
  assert.equal(
    findingParticipantPersonIdForStorage({ personId: " person-1 " }, validPersonIds),
    "person-1",
  );
  assert.equal(
    findingParticipantPersonIdForStorage({ personId: "person-from-another-project" }, validPersonIds),
    null,
  );
  assert.equal(findingParticipantPersonIdForStorage({}, validPersonIds), null);
});

test("effective finding links merge legacy and structured sources without duplicates", () => {
  const finding = {
    personIds: ["person-legacy", "person-shared", "person-legacy"],
    participants: [
      { id: "participant-1", personId: "person-shared", role: "Свідок", name: "", notes: "" },
      { id: "participant-2", personId: "person-structured", role: "Хрещений", name: "", notes: "" },
      { id: "participant-3", role: "Сусід", name: "Текст без картки", notes: "" },
    ],
  };
  assert.deepEqual(
    findingLinkedPersonIds(finding),
    ["person-legacy", "person-shared", "person-structured"],
  );
  assert.equal(findingLinksPerson(finding, "person-structured"), true);
  assert.deepEqual(findingStandalonePersonIds(finding), ["person-legacy"]);
});

test("canonicalizing a duplicate legacy link prevents a stale link after participant unlink", () => {
  const before = {
    personIds: ["person-1"],
    participants: [{ id: "participant-1", personId: "person-1", role: "Свідок", name: "", notes: "" }],
  };
  const canonicalLegacyIds = findingStandalonePersonIds(before);
  assert.deepEqual(canonicalLegacyIds, []);
  const afterUnlink = {
    personIds: canonicalLegacyIds,
    participants: [{ ...before.participants[0], personId: undefined }],
  };
  assert.deepEqual(findingLinkedPersonIds(afterUnlink), []);
});

test("the finding editor exposes an optional existing-person selector per participant", () => {
  const crudPage = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");
  assert.match(crudPage, /<span>Картка особи<\/span>/);
  assert.match(crudPage, /value=\{participant\.personId \?\? ""\}/);
  assert.match(crudPage, /personId:\s*personId \|\| undefined/);
  assert.match(crudPage, /participant\.id === personSeed\.participantId[\s\S]*?personId: linkedPerson\.id/);
  assert.match(crudPage, /participant\.name\.trim\(\) && !participant\.personId/);
  assert.match(crudPage, /onPersonUnlink\(participant\.personId\)/);
});

test("person cards merge legacy finding links with participant person_id links", () => {
  const workRecords = readFileSync(
    new URL("../src/services/projectWorkRecords.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    workRecords,
    /\.from\("finding_participants"\)[\s\S]*?\.select\("finding_id"\)[\s\S]*?\.eq\("person_id", personId\)/,
  );
  assert.match(workRecords, /participantFindingIds/);
  assert.match(workRecords, /new Map\([\s\S]*?findingsResult\.data[\s\S]*?participantFindingsResult\.data/);
  assert.match(
    workRecords,
    /\.from\("persons"\)[\s\S]*?\.eq\("project_id", projectId\)[\s\S]*?\.in\("id", requestedPersonIds\)/,
  );
});

test("participant-only links feed core UI, search, and both GEDCOM export paths", () => {
  const sources = [
    "../src/pages/MapPage.tsx",
    "../src/pages/PersonsPage.tsx",
    "../src/features/persons-v2/PersonsModuleV2.tsx",
    "../src/features/persons-v2/PersonProfileV2.tsx",
    "../src/features/persons-v2/PersonPreviewDrawerV2.tsx",
    "../src/utils/globalSearch.ts",
    "../src/utils/gedcom.ts",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  for (const source of sources) {
    assert.match(source, /findingLinkedPersonIds|findingLinksPerson|findingLinksAnyPerson/);
  }

  const edgeExport = readFileSync(
    new URL("../supabase/functions/_shared/gedcomExportProcessor.ts", import.meta.url),
    "utf8",
  );
  assert.match(edgeExport, /personId:\s*participant\.person_id \?\? undefined/);
});

test("spreadsheet round-trip keeps the optional participant person card id", () => {
  const excelExport = readFileSync(new URL("../src/utils/excelExport.ts", import.meta.url), "utf8");
  const tableImport = readFileSync(new URL("../src/utils/tableDataImport.ts", import.meta.url), "utf8");
  const participantCell = readFileSync(
    new URL("../src/utils/findingParticipantTableCell.ts", import.meta.url),
    "utf8",
  );
  assert.match(excelExport, /ID картки особи: \$\{participant\.personId\}/);
  assert.match(participantCell, /\^ID картки особи\\s\*:\\s\*\(\.\+\)\$/);
  assert.match(participantCell, /personId,\s*role:/);
  assert.match(tableImport, /parseFindingParticipantTableCell/);
});

test("spreadsheet participant import accepts only a card from the current project", () => {
  const cell = "Свідок\nПетро Іванович\nЗаписано в метриці\nID картки особи: person-1";
  const valid = parseFindingParticipantTableCell(cell, "participant-1", new Set(["person-1"]));
  assert.equal(valid.participant?.personId, "person-1");
  assert.equal(valid.rejectedPersonId, undefined);

  const stale = parseFindingParticipantTableCell(cell, "participant-2", new Set(["person-2"]));
  assert.equal(stale.participant?.personId, undefined);
  assert.equal(stale.participant?.name, "Петро Іванович");
  assert.equal(stale.participant?.role, "Свідок");
  assert.equal(stale.rejectedPersonId, "person-1");
});

test("person deletion and participant unlink clear both link representations", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const crudPage = readFileSync(new URL("../src/pages/CrudPage.tsx", import.meta.url), "utf8");
  assert.match(
    app,
    /function withoutFindingPersonLinks[\s\S]*?participants: finding\.participants\.map[\s\S]*?personId: undefined/,
  );
  assert.match(crudPage, /onParticipantPersonUnlink[\s\S]*?personIds:[\s\S]*?filter\(\(id\) => id !== personId\)/);
  assert.match(crudPage, /personIds: personSeed\.participantId[\s\S]*?selected\.filter/);
});

test("project backup import remaps participant person links to cloned person ids", () => {
  const source = createEmptyDatabase();
  source.persons = [{
    id: "person-source",
    fullName: "Петро Іванович",
  } as (typeof source.persons)[number]];
  source.findings = [{
    id: "finding-source",
    researchId: "",
    documentId: "",
    personIds: ["person-source"],
    participants: [{
      id: "participant-source",
      personId: "person-source",
      role: "Свідок",
      name: "Петро",
      notes: "",
    }],
    scans: [],
    customFields: {},
  } as (typeof source.findings)[number]];

  const cloned = cloneDatabaseForProjectImport(normalizeDatabase(source));
  assert.notEqual(cloned.persons[0].id, "person-source");
  assert.equal(cloned.findings[0].personIds[0], cloned.persons[0].id);
  assert.equal(cloned.findings[0].participants[0].personId, cloned.persons[0].id);
});

test("database normalization preserves an optional participant person link", () => {
  const source = createEmptyDatabase();
  source.findings = [{
    id: "finding-source",
    participants: [{
      id: "participant-source",
      personId: " person-source ",
      role: "Свідок",
      name: "Петро",
      notes: "",
    }],
  } as (typeof source.findings)[number]];

  const normalized = normalizeDatabase(source);
  assert.equal(normalized.findings[0].participants[0].personId, "person-source");
});
