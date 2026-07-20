import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const peopleService = readFileSync(
  new URL("../src/services/projectPeople.ts", import.meta.url),
  "utf8",
);
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);

  assert.notEqual(start, -1, `Missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `Missing end marker: ${endMarker}`);

  return source.slice(start, end);
}

test("existing persons are updated with the expected database version in one statement", () => {
  const saveFunction = sliceBetween(
    peopleService,
    "export async function saveProjectPerson",
    "export async function deleteProjectPerson",
  );
  assert.match(saveFunction, /expectedUpdatedAt\?: string/);
  assert.match(saveFunction, /\.update\(row\)/);
  assert.match(saveFunction, /\.eq\("project_id", projectId\)/);
  assert.match(saveFunction, /\.eq\("id", person\.id\)/);
  assert.match(saveFunction, /\.eq\("updated_at", expectedUpdatedAt\)/);
  assert.match(saveFunction, /\.maybeSingle\(\)/);
  assert.match(saveFunction, /if \(!data\) throw new ProjectRecordConflictError\(\)/);
});

test("new persons use insert and App passes the editor base version", () => {
  assert.match(peopleService, /: await client[\s\S]*?\.insert\(row\)/);
  const appSavePerson = sliceBetween(
    appSource,
    "const savePerson = (person: Person): Promise<Person | null> => {",
    "const deletePersons =",
  );
  assert.match(appSavePerson, /saveProjectPerson\([\s\S]*?baseUpdatedAt\(person\) \?\? previousEntity\?\.updatedAt/);
  assert.doesNotMatch(appSavePerson, /assertProjectRecordUnchanged/);
});
