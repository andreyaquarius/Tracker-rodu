import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceSource = readFileSync(
  new URL("../src/services/projectPeople.ts", import.meta.url),
  "utf8",
);

type MissingColumnsDetector = (error: unknown) => boolean;

function loadMissingColumnsDetector(): MissingColumnsDetector {
  const startMarker = "export function isMissingPersonRelationProvenanceColumnsError";
  const endMarker = "\n}\n\nfunction personFromRow";
  const start = serviceSource.indexOf(startMarker);
  const end = serviceSource.indexOf(endMarker, start);

  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);

  const executableSource = serviceSource
    .slice(start, end + 2)
    .replace("export function", "function")
    .replace("(error: unknown): boolean", "(error)")
    .replace(" as Record<string, unknown>", "")
    .replace(".filter((value): value is string =>", ".filter((value) =>");

  return new Function(
    `${executableSource}\nreturn isMissingPersonRelationProvenanceColumnsError;`,
  )() as MissingColumnsDetector;
}

const isMissingColumnsError = loadMissingColumnsDetector();

test("recognizes PostgreSQL and PostgREST errors for missing relation provenance columns", () => {
  assert.equal(isMissingColumnsError({
    code: "42703",
    message: "column person_relations.import_source_key does not exist",
  }), true);
  assert.equal(isMissingColumnsError({
    code: "pgrst204",
    message: "Could not find the 'gedcom_metadata' column of 'person_relations' in the schema cache",
  }), true);
});

test("does not hide unrelated database or application errors", () => {
  assert.equal(isMissingColumnsError(null), false);
  assert.equal(isMissingColumnsError(new Error("Network request failed")), false);
  assert.equal(isMissingColumnsError({
    code: "42703",
    message: "column person_relations.notes does not exist",
  }), false);
  assert.equal(isMissingColumnsError({
    code: "23505",
    message: "duplicate key violates unique constraint for import_source_key",
  }), false);
  assert.equal(isMissingColumnsError({
    code: "PGRST204",
    message: "Could not find the 'notes' column in the schema cache",
  }), false);
});

test("relation reads and writes retain a legacy-schema fallback during rolling deployment", () => {
  assert.match(
    serviceSource,
    /const LEGACY_RELATION_SELECT\s*=\s*\n?\s*"(?![^"]*(?:import_source_key|gedcom_metadata))[^"]+"/,
  );
  assert.match(
    serviceSource,
    /async function listProjectRelationRows[\s\S]*?selectRows\(RELATION_SELECT\)[\s\S]*?selectRows\(LEGACY_RELATION_SELECT\)/,
  );
  assert.match(
    serviceSource,
    /export async function getProjectPersonRelation[\s\S]*?loadRelation\(RELATION_SELECT\)[\s\S]*?loadRelation\(LEGACY_RELATION_SELECT\)/,
  );
  assert.match(
    serviceSource,
    /export async function importProjectPeople[\s\S]*?isMissingPersonRelationProvenanceColumnsError\(error\)[\s\S]*?items\.map\(relationToLegacyRow\)/,
  );
  assert.match(
    serviceSource,
    /export async function saveProjectPersonRelation[\s\S]*?select\(RELATION_SELECT\)[\s\S]*?relationToLegacyRow\(row\)[\s\S]*?select\(LEGACY_RELATION_SELECT\)/,
  );
});
