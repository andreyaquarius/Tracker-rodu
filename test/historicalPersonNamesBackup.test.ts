import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { PersonName } from "../src/types/index.ts";
import { normalizeBackupPersonNames } from "../src/utils/personNameBackup.ts";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

const database = source("../src/utils/database.ts");
const backups = source("../src/services/projectBackups.ts");
const backupPage = source("../src/pages/BackupPage.tsx");
const personNameService = source("../src/services/projectPersonNames.ts");
const projectPeople = source("../src/services/projectPeople.ts");
const app = source("../src/App.tsx");
const migration = source("../supabase/migrations/202608270005_historical_person_names.sql");
const pgTap = source("../supabase/tests/historical_person_names_test.sql");

const exactOriginal = "  Іωанъ  Каленскій\r\n";
const backupName: PersonName = {
  id: "10000000-0000-4000-8000-000000000001",
  projectId: "20000000-0000-4000-8000-000000000002",
  personId: "30000000-0000-4000-8000-000000000003",
  nameType: "document",
  languageCode: "uk",
  scriptCode: "Cyrl",
  surname: "Каленскій",
  maidenSurname: "",
  givenName: "Іωанъ",
  patronymic: "",
  prefix: "",
  suffix: "",
  nickname: "",
  fullName: "Каленскій Іωанъ",
  fullNormalized: "Каленський Іван",
  originalText: exactOriginal,
  orthography: "дореформена",
  validFrom: "1870",
  validTo: "1890",
  datePrecision: "range",
  isPrimary: true,
  isPreferred: true,
  isSearchable: true,
  evidenceStatus: "proven",
  confidence: 90,
  sourceDocumentId: null,
  sourceFindingId: null,
  sourceType: "document",
  sourceId: null,
  citationId: null,
  documentFragmentId: null,
  notes: "",
  metadata: { source: "persons_projection", custom: { untouched: true } },
  createdBy: null,
  lockVersion: 7,
  createdAt: "1870-01-01T00:00:00.000Z",
  updatedAt: "2026-08-27T10:00:00.000Z",
};

test("old version-5 backups remain readable and exact source spelling is untouched", () => {
  assert.deepEqual(normalizeBackupPersonNames(undefined), []);
  const [normalized] = normalizeBackupPersonNames([backupName]);
  assert.equal(normalized.originalText, exactOriginal);
  assert.equal(normalized.createdAt, backupName.createdAt);
  assert.equal(normalized.updatedAt, backupName.updatedAt);
  assert.equal(normalized.lockVersion, 7);
  assert.deepEqual(normalized.metadata, backupName.metadata);
  assert.throws(
    () => normalizeBackupPersonNames({}),
    /пошкоджений список історичних імен/,
  );
});

test("database normalization preserves optional-presence semantics for old backups", () => {
  assert.match(database, /personNames: candidate\.personNames === undefined[\s\S]*?\? undefined[\s\S]*?: normalizeBackupPersonNames/);
  assert.match(database, /const hasCompletePersonNames = Array\.isArray\(source\.personNames\)/);
  assert.match(database, /personNames: hasCompletePersonNames[\s\S]*?: undefined/);
});

test("local project clone remaps names and fails closed on missing person or source records", () => {
  const clone = database.slice(
    database.indexOf("export function cloneDatabaseForProjectImport"),
    database.indexOf("function uniqueEntityIds"),
  );
  assert.match(clone, /id: mapRequired\(personNames, item\.id\)/);
  assert.match(clone, /personId: mapRequired\(persons, item\.personId\)/);
  assert.match(clone, /sourceDocumentId: mapNullableRequired\(documents, item\.sourceDocumentId\)/);
  assert.match(clone, /sourceFindingId: mapNullableRequired\(findings, item\.sourceFindingId\)/);
  assert.match(clone, /item\.sourceType === "document"[\s\S]*?mapRequired\(documents, item\.sourceId\)/);
  assert.match(clone, /item\.sourceType === "finding"[\s\S]*?mapRequired\(findings, item\.sourceId\)/);
  assert.doesNotMatch(clone, /sourcePersonNames[\s\S]*?\.filter\(\(item\) => persons\.has/);
  assert.match(clone, /createdBy: null/);
});

test("cloud JSON and Excel exports all use a paged authoritative name snapshot", () => {
  assert.match(backups, /buildProjectBackupSnapshot[\s\S]*?listAllProjectPersonNames/);
  assert.match(backups, /const snapshot = await buildProjectBackupSnapshot[\s\S]*?pruneAutomaticProjectBackups/);
  assert.match(backups, /JSON\.stringify\(snapshot/);
  assert.match(backupPage, /buildProjectBackupSnapshot[\s\S]*?downloadDatabase\(snapshot\)/);
  assert.match(backupPage, /buildProjectBackupSnapshot[\s\S]*?exportProjectToExcel\(snapshot/);
  assert.match(personNameService, /PERSON_NAME_BACKUP_PAGE_SIZE = 500/);
  assert.match(personNameService, /\.range\(from, from \+ PERSON_NAME_BACKUP_PAGE_SIZE - 1\)/);
  const allNames = personNameService.slice(
    personNameService.indexOf("export async function listAllProjectPersonNames"),
    personNameService.indexOf("export function validateProjectPersonNamesForRestore"),
  );
  assert.match(allNames, /throw new PersonNamesSchemaUnavailableError/);
  assert.doesNotMatch(allNames, /isMissingPersonNamesSchemaError\([^)]*\)\) return \[\]/);
  assert.match(personNameService, /for \(const personId of input\.personIds\)[\s\S]*?primaryCounts\.get\(personId\) !== 1/);
  assert.match(personNameService, /fullName: row\.full_name \?\? ""/);
  assert.match(personNameService, /typeof row\.full_normalized === "string"[\s\S]*?\? row\.full_normalized/);
});

test("complete backup skips transient GEDCOM names and restores exact names after findings", () => {
  assert.match(projectPeople, /importStructuredPersonNames\?: boolean/);
  assert.match(projectPeople, /options\.importStructuredPersonNames === false[\s\S]*?\? \[\][\s\S]*?: buildGedcomPersonNameImportRows/);
  assert.match(app, /const hasCompletePersonNames = Array\.isArray\(next\.personNames\)/);
  assert.match(app, /if \(hasCompletePersonNames\) \{[\s\S]*?validateProjectPersonNamesForRestore/);
  assert.match(app, /importStructuredPersonNames: !hasCompletePersonNames/);
  assert.match(app, /if \(hasCompletePersonNames\) \{[\s\S]*?preflightProjectPersonNamesRestore/);
  assert.match(app, /if \(hasCompletePersonNames\) \{[\s\S]*?restoreProjectPersonNames/);

  const validation = app.indexOf("validateProjectPersonNamesForRestore");
  const preflight = app.indexOf("await preflightProjectPersonNamesRestore(projectId)", validation);
  const clear = app.indexOf("await clearProjectRecords(projectId)", preflight);
  const findings = app.indexOf("await importProjectWorkRecords(", clear);
  const restore = app.indexOf("await restoreProjectPersonNames(", findings);
  assert.ok(validation >= 0 && preflight > validation, "backup names must validate before capability preflight");
  assert.ok(clear > preflight, "restore RPC/schema must be confirmed before destructive clearing");
  assert.ok(findings > clear && restore > findings, "name sources must exist before exact name restore");
});

test("owner-only transactional RPC replaces the whole name collection without a spoofable GUC", () => {
  assert.match(migration, /create or replace function security_private\.restore_project_person_names_v1/);
  assert.match(migration, /security definer[\s\S]*?not public\.is_project_owner\(p_project_id\)/);
  assert.match(migration, /delete from public\.person_names[\s\S]*?insert into public\.person_names/);
  assert.match(migration, /PERSON_NAMES_BACKUP_PRIMARY_REQUIRED/);
  assert.match(migration, /id, project_id, person_id[\s\S]*?original_text[\s\S]*?metadata[\s\S]*?lock_version[\s\S]*?created_at, updated_at/);
  assert.match(migration, /create or replace function public\.restore_project_person_names_v1[\s\S]*?security invoker/);
  assert.match(migration, /lock table public\.person_names in share row exclusive mode/);
  assert.match(migration, /insert into security_private\.person_name_restore_context/);
  assert.match(migration, /set statement_timeout = '60s'[\s\S]*?set lock_timeout = '5s'/);
  assert.doesNotMatch(migration, /lock table public\.person_names in access exclusive mode/);
  assert.doesNotMatch(migration, /(?:disable|enable) trigger person_names_10_prepare_historical/);
  assert.match(migration, /restored\.source_type = 'document'[\s\S]*?document\.id is null/);
  assert.match(migration, /restored\.source_type = 'finding'[\s\S]*?finding\.id is null/);
  assert.match(migration, /restored\.updated_at,[\s\S]*?person_name_search_tokens_v1\(restored\.original_text\)/);
  assert.match(migration, /create or replace function public\.preflight_project_person_names_restore_v1[\s\S]*?security invoker/);
  assert.match(migration, /create or replace function security_private\.set_project_person_name_primary_v1[\s\S]*?security definer/);
  assert.match(migration, /create or replace function public\.set_project_person_name_primary_v1[\s\S]*?security invoker/);
  assert.doesNotMatch(migration, /tracker_rodu\.person_name_primary_switch/);
  assert.match(pgTap, /public\.preflight_project_person_names_restore_v1/);
  assert.match(pgTap, /public\.restore_project_person_names_v1/);
  assert.match(pgTap, /E'  Іоаннъ\\nІвановъ  '/);
  assert.match(pgTap, /metadata, timestamps, and lock version exactly/);
  assert.match(pgTap, /a non-owner cannot replace the project historical-name collection/);
});
