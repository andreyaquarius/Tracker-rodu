import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dataGroupsForPage } from "../src/utils/projectDataGroups.ts";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const personsPage = readFileSync(
  new URL("../src/pages/PersonsPage.tsx", import.meta.url),
  "utf8",
);
const familyTreePage = readFileSync(
  new URL("../src/pages/FamilyTreePage.tsx", import.meta.url),
  "utf8",
);
const familyTreeWindows = readFileSync(
  new URL("../src/hooks/useFamilyTreeRecordWindows.tsx", import.meta.url),
  "utf8",
);
const workRecords = readFileSync(
  new URL("../src/services/projectWorkRecords.ts", import.meta.url),
  "utf8",
);
const analysisRecords = readFileSync(
  new URL("../src/services/projectAnalysisRecords.ts", import.meta.url),
  "utf8",
);
const linkedRecords = readFileSync(
  new URL("../src/services/projectPersonLinkedRecords.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/202607130004_person_linked_records_performance.sql",
    import.meta.url,
  ),
  "utf8",
);

test("persons page no longer hydrates full work and analysis collections", () => {
  assert.deepEqual([...dataGroupsForPage("persons")].sort(), ["people", "researches"]);
  assert.match(
    app,
    /const requestedDataGroups = useMemo\(\(\) => dataGroupsForPage\(page\), \[page\]\)/,
  );
  assert.doesNotMatch(app, /page === "persons"[\s\S]{0,200}groups\.add\("work"\)/);
});

test("person work records are filtered by linking tables and JSONB containment", () => {
  assert.match(workRecords, /export async function listPersonWorkRecords/);
  assert.match(workRecords, /\.from\("task_persons"\)[\s\S]*?\.eq\("person_id", personId\)/);
  assert.match(workRecords, /\.from\("findings"\)[\s\S]*?\.contains\("custom_fields"/);
  assert.match(workRecords, /\[FINDING_META_KEY\]: \{ personIds: \[personId\] \}/);
  assert.match(workRecords, /\.from\("finding_participants"\)/);
});

test("person analysis records use the person link tables", () => {
  assert.match(analysisRecords, /export async function listPersonAnalysisRecords/);
  assert.match(analysisRecords, /\.from\("hypothesis_links"\)[\s\S]*?\.eq\("target_id", personId\)/);
  assert.match(analysisRecords, /\.from\("archive_request_persons"\)[\s\S]*?\.eq\("person_id", personId\)/);
  assert.match(linkedRecords, /Promise\.all\(\[/);
  assert.match(linkedRecords, /listPersonWorkRecords\(projectId, personId\)/);
  assert.match(linkedRecords, /listPersonAnalysisRecords\(projectId, personId\)/);
});

test("person card loads linked records on demand and exposes progress and retry", () => {
  assert.match(personsPage, /projectId\?: string/);
  assert.match(personsPage, /listPersonLinkedRecords\(projectId, person\.id\)/);
  assert.match(personsPage, /Завантажуємо пов’язані записи особи/);
  assert.match(personsPage, /Спробувати ще раз/);
  assert.match(familyTreePage, /<PersonCardModal[\s\S]*?projectId=\{projectId\}/);
  assert.match(familyTreeWindows, /<PersonCardModal[\s\S]*?projectId=\{projectId\}/);
  assert.match(familyTreePage, /const entity = loadedEntity \?\?/);
  assert.match(familyTreeWindows, /const entity = loadedEntity \?\?/);
});

test("linked-record lookup has supporting indexes", () => {
  assert.match(migration, /^begin;/m);
  assert.match(migration, /^commit;/m);
  assert.match(migration, /using gin \(custom_fields jsonb_path_ops\)/);
  assert.match(migration, /task_persons \(project_id, person_id, task_id\)/);
  assert.match(migration, /hypothesis_links \(project_id, target_id, hypothesis_id\)/);
  assert.match(migration, /where target_type = 'person'/);
  assert.match(migration, /archive_request_persons \(project_id, person_id, archive_request_id\)/);
});
