import test from "node:test";
import assert from "node:assert/strict";
import type { Person, PersonRelation } from "../src/types/index.ts";
import type { FamilyTreeGraphDto, FamilyTreePersonName } from "../src/types/familyTree.ts";
import { buildFamilyTreeProjection } from "../src/utils/familyTreeProjection.ts";
import {
  exportFamilyTreeGraphToGedcom,
  exportFamilyTreeProjectionToGedcom,
  formatGedcomDate,
  parseGedcom,
  summarizeGedcom,
} from "../src/utils/gedcom.ts";

const now = "2026-06-30T00:00:00.000Z";

function person(id: string, overrides: Partial<Person> = {}): Person {
  return {
    id,
    researchId: "",
    status: "доведена" as Person["status"],
    gender: "невідомо" as Person["gender"],
    surname: "",
    givenName: "",
    patronymic: "",
    fullName: "",
    nameVariants: "",
    surnameVariants: "",
    birthDate: "",
    birthYearFrom: "",
    birthYearTo: "",
    birthPlace: "",
    marriageDate: "",
    marriagePlace: "",
    deathDate: "",
    deathYearFrom: "",
    deathYearTo: "",
    deathPlace: "",
    residencePlaces: "",
    socialStatus: "",
    religion: "",
    occupation: "",
    isLiving: false,
    privacyStatus: "private",
    notes: "",
    birthScans: [],
    marriageScans: [],
    deathScans: [],
    mentionScans: [],
    events: [],
    customFields: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function relation(
  id: string,
  personId: string,
  relatedPersonId: string,
  relationType: PersonRelation["relationType"],
): PersonRelation {
  return {
    id,
    personId,
    relatedPersonId,
    relationType,
    status: "доведено" as PersonRelation["status"],
    evidenceText: "",
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

function graphName(
  personId: string,
  fullName: string,
  overrides: Partial<FamilyTreePersonName> = {},
): FamilyTreePersonName {
  return {
    id: `name-${personId}`,
    projectId: "project",
    personId,
    nameType: "primary",
    languageCode: "uk",
    scriptCode: "Cyrl",
    surname: fullName.split(" ")[0] ?? "",
    givenName: fullName.split(" ")[1] ?? "",
    patronymic: "",
    fullName,
    originalText: fullName,
    isPrimary: true,
    isPreferred: true,
    evidenceStatus: "proven",
    confidence: 100,
    sourceDocumentId: null,
    sourceFindingId: null,
    notes: "",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("exports projection to GEDCOM individuals and families", () => {
  const child = person("child", {
    surname: "Гурський",
    givenName: "Григорій",
    birthDate: "1896-06-06",
    birthPlace: "Трубіївка",
  });
  const father = person("father", {
    surname: "Гурський",
    givenName: "Іван",
    gender: "чоловік" as Person["gender"],
  });
  const mother = person("mother", {
    surname: "Гурська",
    givenName: "Євдокія",
    gender: "жінка" as Person["gender"],
  });
  const projection = buildFamilyTreeProjection({
    projectId: "project",
    persons: [child, father, mother],
    legacyRelations: [
      relation("father-link", "child", "father", "батько" as PersonRelation["relationType"]),
      relation("mother-link", "child", "mother", "мати" as PersonRelation["relationType"]),
      relation("spouse-link", "father", "mother", "дружина" as PersonRelation["relationType"]),
    ],
  });

  const result = exportFamilyTreeProjectionToGedcom(projection, {
    sourceName: "Трекер Роду",
    submitterName: "Тестовий дослідник",
    createdAt: "2026-06-30",
  });

  assert.match(result.text, /0 HEAD/);
  assert.match(result.text, /1 CHAR UTF-8/);
  assert.doesNotMatch(result.text, /1 RESN privacy/);
  assert.match(result.text, /1 DEAT Y/);
  assert.match(result.text, new RegExp(`0 ${escapeRegExp(result.individualXrefs.child)} INDI`));
  assert.match(result.text, /1 NAME .*\/Гурський\//);
  assert.match(result.text, /1 BIRT\r?\n2 DATE 6 JUN 1896\r?\n2 PLAC Трубіївка/);
  assert.match(result.text, new RegExp(`1 CHIL ${escapeRegExp(result.individualXrefs.child)}`));
  assert.match(result.text, new RegExp(`1 HUSB ${escapeRegExp(result.individualXrefs.father)}`));
  assert.match(result.text, new RegExp(`1 WIFE ${escapeRegExp(result.individualXrefs.mother)}`));
  assert.match(result.text, /0 TRLR/);
});

test("exports rendered family tree graph to GEDCOM", () => {
  const fatherName = graphName("father", "Каленський Іван");
  const motherName = graphName("mother", "Каленська Марія");
  const childName = graphName("child", "Каленський Петро");
  const graph: FamilyTreeGraphDto = {
    projectId: "project",
    treeId: "tree",
    mode: "family",
    rootPersonId: "child",
    tree: null,
    availablePersons: [],
    nodes: [
      {
        personId: "father",
        displayName: fatherName.fullName,
        primaryName: fatherName,
        names: [fatherName],
        events: [],
        gender: "чоловік",
        status: "доведено",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["father"],
      },
      {
        personId: "mother",
        displayName: motherName.fullName,
        primaryName: motherName,
        names: [motherName],
        events: [],
        gender: "жінка",
        status: "доведено",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["mother"],
      },
      {
        personId: "child",
        displayName: childName.fullName,
        primaryName: childName,
        names: [childName],
        events: [],
        gender: "чоловік",
        status: "доведено",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["child"],
      },
    ],
    occurrences: [
      {
        id: "child",
        personId: "child",
        mode: "family",
        path: ["child"],
        generation: 0,
        depth: 0,
        duplicateIndex: 0,
        isRepeated: false,
      },
      {
        id: "father",
        personId: "father",
        mode: "family",
        path: ["child", "father"],
        generation: -1,
        depth: 1,
        duplicateIndex: 0,
        isRepeated: false,
      },
      {
        id: "mother",
        personId: "mother",
        mode: "family",
        path: ["child", "mother"],
        generation: -1,
        depth: 1,
        duplicateIndex: 0,
        isRepeated: false,
      },
    ],
    edges: [
      {
        id: "partner",
        kind: "partner",
        relationshipId: "partner",
        fromPersonId: "father",
        toPersonId: "mother",
        relationshipType: "marriage",
        evidenceStatus: "proven",
        confidence: 100,
        style: { lineStyle: "solid", visibility: "visible" },
        metadata: {},
      },
      {
        id: "father-child",
        kind: "parent_child",
        relationshipId: "father-child",
        fromPersonId: "father",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "father",
        evidenceStatus: "proven",
        confidence: 100,
        isBloodline: true,
        parentSetId: "parents",
        style: { lineStyle: "solid", visibility: "visible" },
        metadata: {},
      },
      {
        id: "mother-child",
        kind: "parent_child",
        relationshipId: "mother-child",
        fromPersonId: "mother",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "mother",
        evidenceStatus: "proven",
        confidence: 100,
        isBloodline: true,
        parentSetId: "parents",
        style: { lineStyle: "solid", visibility: "visible" },
        metadata: {},
      },
    ],
    groups: [],
    issues: [],
    stats: {
      persons: 3,
      occurrences: 3,
      edges: 3,
      groups: 0,
      issues: 0,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };

  const result = exportFamilyTreeGraphToGedcom(graph, { sourceName: "Трекер Роду", createdAt: "2026-07-05" });
  const firstIndividualXref = result.text.match(/^0 (@I\d+@) INDI/m)?.[1] ?? "";

  assert.match(result.text, /0 HEAD/);
  assert.equal(firstIndividualXref, result.individualXrefs.child);
  assert.match(result.text, new RegExp(`1 _ROOT ${escapeRegExp(result.individualXrefs.child)}`));
  assert.match(result.text, new RegExp(`1 _TRK_ROOT ${escapeRegExp(result.individualXrefs.child)}`));
  assert.match(result.text, /0 @I\d+@ INDI/);
  assert.match(result.text, /0 @F1@ FAM/);
  assert.match(result.text, /1 HUSB @I\d+@/);
  assert.match(result.text, /1 WIFE @I\d+@/);
  assert.match(result.text, /1 CHIL @I\d+@/);
  assert.match(result.text, new RegExp(`0 ${escapeRegExp(result.individualXrefs.father)} INDI[\\s\\S]*?1 _RELTOROOT батько`));
  assert.match(result.text, /0 TRLR/);
});

test("exports biological and adoptive fathers as separate GEDCOM families", () => {
  const childName = graphName("child", "Child Person");
  const biologicalFatherName = graphName("bio-father", "Biological Father");
  const adoptiveFatherName = graphName("adoptive-father", "Adoptive Father");
  const graph: FamilyTreeGraphDto = {
    projectId: "project",
    treeId: "tree",
    mode: "family",
    rootPersonId: "child",
    tree: null,
    availablePersons: [],
    nodes: [
      {
        personId: "child",
        displayName: childName.fullName,
        primaryName: childName,
        names: [childName],
        events: [],
        gender: "male",
        status: "proven",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["child"],
      },
      {
        personId: "bio-father",
        displayName: biologicalFatherName.fullName,
        primaryName: biologicalFatherName,
        names: [biologicalFatherName],
        events: [],
        gender: "male",
        status: "proven",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["bio-father"],
      },
      {
        personId: "adoptive-father",
        displayName: adoptiveFatherName.fullName,
        primaryName: adoptiveFatherName,
        names: [adoptiveFatherName],
        events: [],
        gender: "male",
        status: "proven",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["adoptive-father"],
      },
    ],
    occurrences: [],
    edges: [
      {
        id: "bio-father-child",
        kind: "parent_child",
        relationshipId: "bio-father-child",
        fromPersonId: "bio-father",
        toPersonId: "child",
        relationshipType: "biological",
        parentRoleLabel: "father",
        evidenceStatus: "proven",
        confidence: 100,
        isBloodline: true,
        parentSetId: "biological-parents",
        style: { lineStyle: "solid", visibility: "visible" },
        metadata: {},
      },
      {
        id: "adoptive-father-child",
        kind: "parent_child",
        relationshipId: "adoptive-father-child",
        fromPersonId: "adoptive-father",
        toPersonId: "child",
        relationshipType: "adoptive",
        parentRoleLabel: "adoptive_father",
        evidenceStatus: "proven",
        confidence: 100,
        isBloodline: false,
        parentSetId: "adoptive-parents",
        style: { lineStyle: "dashed", visibility: "visible" },
        metadata: {},
      },
    ],
    groups: [],
    issues: [],
    stats: {
      persons: 3,
      occurrences: 3,
      edges: 2,
      groups: 0,
      issues: 0,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };

  const result = exportFamilyTreeGraphToGedcom(graph, { sourceName: "Treker Rodu", createdAt: "2026-07-05" });
  const familyBlocks = gedcomBlocks(result.text, "FAM");
  const childBlock = gedcomBlocks(result.text, "INDI")
    .find((block) => block.startsWith(`0 ${result.individualXrefs.child} INDI`)) ?? "";

  assert.equal(familyBlocks.length, 2);
  assert.equal(familyBlocks.some((block) =>
    block.includes(`1 HUSB ${result.individualXrefs["bio-father"]}`) &&
    block.includes(`1 WIFE ${result.individualXrefs["adoptive-father"]}`),
  ), false);
  assert.match(childBlock, /1 FAMC @F\d+@\n2 PEDI birth/);
  assert.match(childBlock, /1 FAMC @F\d+@\n2 PEDI adopted/);
});

test("exports maiden surname and explicit living/deceased markers", () => {
  const marriedName = graphName("wife", "Married Hanna");
  const maidenName = graphName("wife", "Maiden Hanna", {
    id: "name-wife-maiden",
    nameType: "birth",
    surname: "Maiden",
    givenName: "Hanna",
    fullName: "Maiden Hanna",
    originalText: "Maiden Hanna",
    isPrimary: false,
    isPreferred: false,
  });
  const livingName = graphName("living", "Living Person");
  const graph: FamilyTreeGraphDto = {
    projectId: "project",
    treeId: "tree",
    mode: "family",
    rootPersonId: "wife",
    tree: null,
    availablePersons: [],
    nodes: [
      {
        personId: "wife",
        displayName: marriedName.fullName,
        primaryName: marriedName,
        names: [marriedName, maidenName],
        events: [],
        gender: "female",
        status: "proven",
        isLiving: false,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["wife"],
      },
      {
        personId: "living",
        displayName: livingName.fullName,
        primaryName: livingName,
        names: [livingName],
        events: [],
        gender: "unknown",
        status: "proven",
        isLiving: true,
        privacyStatus: "private",
        redacted: false,
        occurrenceIds: ["living"],
      },
    ],
    occurrences: [],
    edges: [],
    groups: [],
    issues: [],
    stats: {
      persons: 2,
      occurrences: 2,
      edges: 0,
      groups: 0,
      issues: 0,
      repeatedPersons: 0,
      hiddenDisprovenEdges: 0,
    },
  };

  const result = exportFamilyTreeGraphToGedcom(graph, { sourceName: "Treker Rodu", createdAt: "2026-07-05" });
  const wifeBlock = gedcomBlocks(result.text, "INDI")
    .find((block) => block.startsWith(`0 ${result.individualXrefs.wife} INDI`)) ?? "";
  const livingBlock = gedcomBlocks(result.text, "INDI")
    .find((block) => block.startsWith(`0 ${result.individualXrefs.living} INDI`)) ?? "";

  assert.match(wifeBlock, /1 NAME Hanna \/Maiden\/\n2 GIVN Hanna\n2 SURN Maiden\n2 TYPE birth/);
  assert.match(wifeBlock, /1 _MARNM Hanna \/Married\/\n2 GIVN Hanna\n2 SURN Married/);
  assert.match(wifeBlock, /1 DEAT Y/);
  assert.doesNotMatch(wifeBlock, /1 RESN privacy/);
  assert.match(livingBlock, /1 RESN privacy/);
  assert.doesNotMatch(livingBlock, /1 DEAT/);
});

test("parses GEDCOM and summarizes record counts", () => {
  const gedcom = [
    "0 HEAD",
    "1 SOUR Test",
    "1 CHAR UTF-8",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Ivan /Hurskyi/",
    "0 @F1@ FAM",
    "1 CHIL @I1@",
    "0 @S1@ SOUR",
    "0 TRLR",
  ].join("\n");

  const parsed = parseGedcom(gedcom);
  const summary = summarizeGedcom(parsed);

  assert.equal(parsed.warnings.length, 0);
  assert.equal(summary.individuals, 1);
  assert.equal(summary.families, 1);
  assert.equal(summary.sources, 1);
  assert.equal(summary.characterEncoding, "UTF-8");
  assert.equal(summary.gedcomVersion, "5.5.1");
});

test("reports invalid GEDCOM lines without throwing", () => {
  const parsed = parseGedcom("0 HEAD\nthis is not gedcom\n0 TRLR");

  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.warnings.some((warning) => warning.code === "gedcom_invalid_line"), true);
});

test("formats common GEDCOM date values conservatively", () => {
  assert.equal(formatGedcomDate("1896-06-06"), "6 JUN 1896");
  assert.equal(formatGedcomDate("1896-06"), "JUN 1896");
  assert.equal(formatGedcomDate("1896"), "1896");
  assert.equal(formatGedcomDate("1896-1900"), "BET 1896 AND 1900");
  assert.equal(formatGedcomDate("1896-xx-06"), "1896-xx-06");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function gedcomBlocks(text: string, tag: string): string[] {
  const lines = text.trim().split(/\r?\n/);
  const blocks: string[] = [];
  let current: string[] = [];
  let currentMatches = false;
  for (const line of lines) {
    if (line.startsWith("0 ")) {
      if (currentMatches && current.length) blocks.push(current.join("\n"));
      current = [line];
      currentMatches = line.endsWith(` ${tag}`) || line === `0 ${tag}`;
    } else if (current.length) {
      current.push(line);
    }
  }
  if (currentMatches && current.length) blocks.push(current.join("\n"));
  return blocks;
}
