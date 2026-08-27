import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { GedcomImportNameDraft } from "../src/types/familyTree.ts";
import { stableGedcomPersonNameImportId } from "../src/utils/gedcomAppImport.ts";

const serviceSource = readFileSync(
  new URL("../src/services/projectPeople.ts", import.meta.url),
  "utf8",
);

const documentName: GedcomImportNameDraft = {
  nameType: "document",
  surname: "Каленскій",
  givenName: "Иванъ",
  patronymic: "",
  fullName: "Иванъ Каленскій",
  originalText: "Иванъ /Каленскій/",
  scriptCode: "Cyrl",
  orthography: "pre-1918",
};

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadNameTypeMapper(): (value: string) => string {
  const source = sliceBetween(
    serviceSource,
    "function personNameTypeFromGedcom",
    "function legacyPersonNameStorageType",
  )
    .replace(
      /function personNameTypeFromGedcom\(value: GedcomImportNameDraft\["nameType"\]\): PersonNameType/,
      "function personNameTypeFromGedcom(value)",
    );
  return new Function(`${source}\nreturn personNameTypeFromGedcom;`)() as (value: string) => string;
}

function loadMissingColumnsDetector(): (error: unknown) => boolean {
  const source = sliceBetween(
    serviceSource,
    "export function isMissingHistoricalPersonNameColumnsError",
    "function relationFromRow",
  )
    .replace("export function", "function")
    .replace("(error: unknown): boolean", "(error)")
    .replace(" as Record<string, unknown>", "")
    .replace(".filter((value): value is string =>", ".filter((value) =>");
  return new Function(`${source}\nreturn isMissingHistoricalPersonNameColumnsError;`)() as (
    error: unknown,
  ) => boolean;
}

test("maps GEDCOM name semantics without creating a second primary name", () => {
  const nameType = loadNameTypeMapper();
  assert.equal(nameType("primary"), "document");
  assert.equal(nameType("document"), "document");
  assert.equal(nameType("nickname"), "nickname");
  assert.equal(nameType("church"), "church");
  assert.equal(nameType("other_language"), "other_language");
  assert.equal(nameType("incorrect"), "incorrect");
  assert.equal(nameType("variant"), "variant");
  assert.equal(nameType("unknown"), "unknown");

  const builder = sliceBetween(
    serviceSource,
    "export function buildGedcomPersonNameImportRows",
    "function personNameTypeFromGedcom",
  );
  assert.match(builder, /original_text: name\.originalText/);
  assert.match(builder, /is_primary: false/);
  assert.doesNotMatch(builder, /is_primary: true/);
  assert.match(builder, /originalNameType: name\.nameType/);
  assert.match(builder, /source: "gedcom_import"/);
  assert.match(builder, /nickname/);
  assert.match(builder, /fullNormalized: fullName/);
  assert.match(builder, /orthography/);
});

test("uses a stable UUID identity for repeat imports but distinguishes source spellings", () => {
  const identity = {
    projectId: "10000000-0000-4000-8000-000000000001",
    personId: "20000000-0000-4000-8000-000000000002",
    importSourceKey: "gedcom-content:fixture",
    gedcomXref: "@I1@",
    nameIndex: 1,
    name: documentName,
  };
  const first = stableGedcomPersonNameImportId(identity);
  const repeated = stableGedcomPersonNameImportId({ ...identity, name: { ...documentName } });
  const differentText = stableGedcomPersonNameImportId({
    ...identity,
    name: { ...documentName, originalText: "Іван /Каленський/" },
  });
  const differentIndex = stableGedcomPersonNameImportId({ ...identity, nameIndex: 2 });

  assert.equal(first, repeated);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, differentText);
  assert.notEqual(first, differentIndex);
  const builder = sliceBetween(
    serviceSource,
    "export function buildGedcomPersonNameImportRows",
    "function personNameTypeFromGedcom",
  );
  assert.match(builder, /idFactory\?\.\(\) \?\? stableGedcomPersonNameImportId/);
});

test("persists GEDCOM names after persons and before relations with a legacy fallback", () => {
  const importFunction = sliceBetween(
    serviceSource,
    "export async function importProjectPeople",
    "export async function saveProjectPerson",
  );
  const personUpsert = importFunction.indexOf('.from("persons")');
  const nameUpsert = importFunction.indexOf('.from("person_names")');
  const relationUpsert = importFunction.indexOf('.from("person_relations")');
  assert.ok(personUpsert >= 0);
  assert.ok(nameUpsert > personUpsert);
  assert.ok(relationUpsert > nameUpsert);
  assert.match(importFunction, /buildGedcomPersonNameImportRows\(projectId, persons\)/);
  assert.match(importFunction, /legacyGedcomPersonNameRow/);
  assert.match(importFunction, /isMissingHistoricalPersonNameColumnsError/);
  assert.match(importFunction, /\.upsert\([\s\S]*?\{ onConflict: "id", ignoreDuplicates: true \}/);
  assert.equal((importFunction.match(/ignoreDuplicates: true/g) ?? []).length, 2);
  assert.match(serviceSource, /delete persistedCustomFields\[GEDCOM_STRUCTURED_NAMES_CUSTOM_FIELD\]/);
});

test("legacy fallback is limited to missing historical person-name columns", () => {
  const isMissingColumns = loadMissingColumnsDetector();
  assert.equal(isMissingColumns({
    code: "42703",
    message: "column person_names.full_normalized does not exist",
  }), true);
  assert.equal(isMissingColumns({
    code: "PGRST204",
    message: "Could not find the 'nickname' column in the schema cache",
  }), true);
  assert.equal(isMissingColumns({
    code: "23505",
    message: "duplicate key violates unique constraint person_names_one_primary_per_person_uq",
  }), false);
  assert.equal(isMissingColumns({
    code: "42703",
    message: "column person_names.original_text does not exist",
  }), false);
});
